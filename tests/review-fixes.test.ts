import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { preflightNeeds } from "../src/cli.js";
import { Controller } from "../src/controller.js";
import { canonical, TaskSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import { RoutingPolicySchema } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

// Regression tests for independent review findings 1–6.

const now = new Date().toISOString();
const route = (
  id: string,
  level: string,
  provider: "claude" | "codex",
  model: string,
  effort: string,
  roles: string[],
) => ({
  id,
  level,
  provider,
  model,
  effort,
  roles,
  simulation: false,
  enabled: true,
  capability: {
    provider,
    model,
    effort,
    verifiedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "test:attested",
  },
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "review-fixes-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-w", "low", ["worker"]),
    route("codex-routine", "ROUTINE", "codex", "codex-w", "low", ["worker"]),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", [
      "reviewer",
    ]),
    route("claude-standard", "STANDARD", "claude", "claude-r", "medium", [
      "reviewer",
    ]),
    route("advisor-1", "EXPERT", "claude", "claude-top", "max", ["advisor"]),
  ],
});

const ASKING = [
  "wrote output/A/hello.txt with a placeholder greeting",
  "",
  "QUESTIONS FOR THE OWNER:",
  "1. Should the greeting be formal or casual?",
  "   - Casual (Recommended): it matches the rest of the app.",
  "   - Formal: it reads more polished but stands out.",
].join("\n");

/** Scripted live-shaped adapter; worker summaries are used in order, the last repeating. */
function adapter(
  workerOutputs: string[],
  options: {
    hugeAdvice?: boolean;
    adviceSteps?: string[];
    reviews?: Record<string, unknown>[];
  },
) {
  const requests: ProviderRequest[] = [];
  let workerRuns = 0,
    reviewerRuns = 0;
  const self: ProviderAdapter & { requests: ProviderRequest[] } = {
    requests,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      requests.push(request);
      const receipt = (output: string): ProviderReceipt => ({
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: now,
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: true,
        simulation: false,
      });
      const p = (request.outputSchema as { properties: Record<string, any> })
        ?.properties;
      if (request.role === "advisor")
        return receipt(
          canonical({
            taskId: p!.taskId.enum[0],
            specDigest: p!.specDigest.enum[0],
            approach: "Write one friendly line.",
            // 34 steps of 4,000 characters pass the per-field limits but not the total cap.
            steps: options.hugeAdvice
              ? Array.from({ length: 34 }, (_, i) => String(i % 10).repeat(4_000))
              : (options.adviceSteps ?? ["Create output/A/hello.txt"]),
            risks: [],
            checks: [],
            questionsForOwner: [],
          }),
        );
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt(
          workerOutputs[Math.min(workerRuns++, workerOutputs.length - 1)]!,
        );
      }
      const ev: string[] = p!.availableEvidence.items.enum;
      return receipt(
        canonical({
          taskId: p!.taskId.enum[0],
          artifactRevision: p!.artifactRevision.enum[0],
          specDigest: p!.specDigest.enum[0],
          provider: p!.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings: [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation: [],
          residualHolds: [],
          verdict: "PASS",
          scope: "test",
          nextAuthorizedStep: "bind",
          auditAssessments: [
            "ACCURACY",
            "LOCAL_ANTI_DRIFT",
            "MACRO_ANTI_DRIFT",
          ].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "ok",
            limitations: [],
          })),
          // Scripted changes to each reviewer report in order, the last repeating.
          ...(options.reviews?.length
            ? options.reviews[
                Math.min(reviewerRuns++, options.reviews.length - 1)
              ]
            : {}),
        }),
      );
    },
  };
  return self;
}

function fixture(
  workerOutputs: string[],
  options: {
    advice?: boolean;
    hugeAdvice?: boolean;
    adviceSteps?: string[];
    scope?: string;
    reviews?: Record<string, unknown>[];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-review-fixes-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: () => true,
  });
  const live = adapter(workerOutputs, options);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const submit = (key: string) =>
    o.submit({
      requestKey: key,
      prompt: "Write a greeting",
      context: { cwd: root },
      sourceRef: "test:review-fixes",
    }).request.id;
  const id = submit(randomUUID());
  const source = o.ownerSource(id);
  c.importTasks(
    [
      TaskSchema.parse({
        id: "A",
        programme: "TEST",
        lane: "LOCAL",
        title: "t",
        scope: options.scope ?? "greeting",
        deliverable: "output/A/hello.txt",
        specVersion: 1,
        status: "DISCOVERED",
        artifactRevision: "r1",
        createdAt: now,
        dimensions: {
          authorization: "LOCAL_ONLY",
          sourceEffectuation: "CANDIDATE",
          implementation: "NOT_STARTED",
          review: "NONE",
          release: "NOT_AUTHORIZED",
        },
        sources: [{ ...source, evidenceId: source.evidenceId + "-A" }],
        specificationAuthenticated: true,
        providers: ["claude", "codex"],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        writePaths: ["output/A"],
        risk: "LOW",
        ...(options.advice
          ? {
              advice: {
                rationale: "Owner marked this task for advice",
                sourceRef: "test:review-fixes",
              },
            }
          : {}),
        reviewPolicy: {
          required: true,
          crossProvider: true,
          independentAudits: false,
        },
        acceptance: [
          { id: "greeting", description: "greeting", evidenceKind: "LOCAL" },
        ],
        simulation: false,
        budget: {
          deadlineMs: 60_000,
          maxAttempts: 3,
          maxCostUsd: 5,
          maxTokens: 10_000,
        },
      }),
    ],
    c.localActor(),
  );
  c.grant(
    "A",
    {
      id: randomUUID(),
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      paths: ["output/A"],
      decisionText: "test",
      sourceRef: "test:review-fixes",
    },
    c.localActor(),
  );
  o.attach(id, ["A"]);
  return {
    c,
    o,
    live,
    id,
    submit,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const roles = (f: ReturnType<typeof fixture>) =>
  f.live.requests.map((r) => `${r.role}:${r.provider}:${r.model}`);
/** Revise task A; a revised specification needs a fresh grant before it can run. */
const revise = (
  f: ReturnType<typeof fixture>,
  change: (t: ReturnType<Controller["task"]>) => object,
  regrant = true,
) => {
  const t = f.c.task("A");
  f.c.revise(
    "A",
    { ...change(t), specVersion: t.specVersion + 1 },
    f.c.localActor(),
  );
  if (regrant)
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "owner answer folded into the revision",
        sourceRef: "test:owner",
      },
      f.c.localActor(),
    );
};

test("finding 1: a revised task is rebound to the same request and the worker reruns with the answer", async () => {
  const f = fixture([ASKING, "wrote output/A/hello.txt with a casual greeting"]);
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.equal(view.status, "WAITING_INPUT");
    assert.throws(() => f.o.rebind(f.id, ["A"]), /REBIND_NOT_NEEDED/);
    f.o.reply(f.id, {
      questionId: view.questions[0]!.id,
      replyKey: "owner-reply-1",
      text: "Casual",
      sourceRef: "test:owner",
    });
    revise(f, (t) => ({
      ...t,
      scope: t.scope + ". The owner chose a casual tone.",
    }));
    // Re-attaching still refuses a changed specification; rebinding is explicit.
    assert.throws(() => f.o.attach(f.id, ["A"]), /REQUEST_TASK_SPEC_CHANGED/);
    assert.equal(f.o.inspect(f.id).status, "HELD_SPEC_CHANGED");
    view = f.o.rebind(f.id, ["A"]);
    assert.equal(
      view.tasks[0]!.boundSpecDigest,
      view.tasks[0]!.currentSpecDigest,
    );
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude:claude-w",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    assert.match(f.live.requests[1]!.brief, /The owner chose a casual tone/);
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("finding 1: rebinding refuses while the request still has an open question on the task", async () => {
  const f = fixture([ASKING]);
  try {
    await f.o.drive(f.id, { live: true });
    revise(f, (t) => ({ ...t, scope: t.scope + ", revised" }));
    assert.throws(() => f.o.rebind(f.id, ["A"]), /REBIND_HAS_OPEN_QUESTIONS/);
  } finally {
    f.close();
  }
});

test("finding 2: advice over the size cap is discarded and the worker still launches", async () => {
  const f = fixture(["wrote output/A/hello.txt"], {
    advice: true,
    hugeAdvice: true,
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    const advice = (view.tasks[0] as any).advice;
    assert.equal(advice.status, "NOT_OBTAINED");
    assert.match(advice.reason, /ADVICE_UNUSABLE/);
    const worker = f.live.requests[1]!;
    assert.doesNotMatch(worker.brief, /ADVISOR NOTES/);
    assert.ok(worker.brief.length < 128_000);
    assert.match(f.live.requests[0]!.brief, /under 32000 characters/);
  } finally {
    f.close();
  }
});

test("finding 2 (re-review): advice that would overflow the whole worker brief is left out and the worker still launches", async () => {
  // Valid advice (about 24,700 characters) beside a 110,000-character task.
  const f = fixture(["wrote output/A/hello.txt"], {
    advice: true,
    adviceSteps: Array.from({ length: 7 }, () => "s".repeat(3_500)),
    scope: "g".repeat(110_000),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f).slice(0, 2), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
    ]);
    assert.equal((view.tasks[0] as any).advice.status, "OBTAINED");
    const worker = f.live.requests[1]!;
    assert.ok(worker.brief.length <= 128_000);
    assert.doesNotMatch(worker.brief, /ADVISOR NOTES/);
    assert.equal(
      f.c.inspect("A").attempts.find((a: any) => a.role === "worker").state,
      "SUCCEEDED",
    );
  } finally {
    f.close();
  }
});

test("re-review: a worker question is recorded once when two requests recover the same run", async () => {
  const f = fixture([ASKING]);
  const o = f.o as any;
  try {
    o.recordWorkerQuestions = () => {};
    await f.o.drive(f.id, { live: true });
    delete o.recordWorkerQuestions;
    const other = f.submit(randomUUID());
    f.o.attach(other, ["A"]);
    const pending = o.pendingWorkerQuestion("A");
    // Both requests recover the same run, as two overlapping advances would.
    o.recordWorkerQuestions(f.id, "A", pending.runId, pending.output);
    o.recordWorkerQuestions(other, "A", pending.runId, pending.output);
    const recorded = [f.o.inspect(f.id), f.o.inspect(other)].flatMap(
      (v) => v.questions,
    );
    assert.equal(recorded.length, 1);
    // One answer releases the task everywhere.
    f.o.reply(f.id, {
      questionId: recorded[0]!.id,
      replyKey: "owner-reply-1",
      text: "Casual",
      sourceRef: "test:owner",
    });
    assert.ok(
      !f.o
        .inspect(other)
        .tasks[0]!.holds.some((h) => h.startsWith("WORKER_QUESTION")),
    );
  } finally {
    f.close();
  }
});

test("smoke C1 follow-up: the reviewer sees the owner's answer to the worker's question", async () => {
  const f = fixture([ASKING]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    f.o.reply(f.id, {
      questionId: view.questions[0]!.id,
      replyKey: "owner-reply-1",
      text: "Keep it casual",
      sourceRef: "test:owner",
    });
    await f.o.drive(f.id, { live: true });
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    assert.match(reviewer.brief, /OWNER ANSWERS/);
    assert.match(reviewer.brief, /Keep it casual/);
    assert.match(reviewer.brief, /formal or casual/);
  } finally {
    f.close();
  }
});

test("smoke C1 follow-up: unreadable journal rows are skipped when gathering owner answers", async () => {
  const f = fixture([ASKING]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    f.o.reply(f.id, {
      questionId: view.questions[0]!.id,
      replyKey: "owner-reply-1",
      text: "Keep it casual",
      sourceRef: "test:owner",
    });
    // Damaged question and reply rows elsewhere in the shared journal, including
    // ones that match the real question but carry non-text values. (The
    // orchestrator's own journal reader is not under test here.)
    const questionId = view.questions[0]!.id,
      spec = f.c.inspect("A").specDigest,
      trap = { toString: null };
    for (const [kind, body] of [
      ["WORKFLOW_QUESTION", "{"],
      ["WORKFLOW_REPLY", "null"],
      ["WORKFLOW_QUESTION", '{"question":"not an object"}'],
      [
        "WORKFLOW_REPLY",
        JSON.stringify({ reply: { questionId, text: trap } }),
      ],
      ["WORKFLOW_REPLY", JSON.stringify({ reply: { questionId, text: "" } })],
      [
        "WORKFLOW_REPLY",
        JSON.stringify({ reply: { questionId, text: "   \n " } }),
      ],
      // Questions the writers would reject, each with an otherwise valid reply.
      ...[
        { id: "not-a-uuid", key: "worker-question:a", text: "q" },
        { id: randomUUID(), key: "worker-question:bad key", text: "q" },
      ].flatMap((q) => [
        [
          "WORKFLOW_QUESTION",
          JSON.stringify({ question: { ...q, taskId: "A", specDigest: spec } }),
        ],
        [
          "WORKFLOW_REPLY",
          JSON.stringify({
            reply: { questionId: q.id, text: "should be skipped" },
          }),
        ],
      ]),
      [
        "WORKFLOW_QUESTION",
        JSON.stringify({
          question: { id: "q2", taskId: "A", specDigest: spec, key: trap, text: "q" },
        }),
      ],
      [
        "WORKFLOW_QUESTION",
        JSON.stringify({
          question: {
            id: "q3",
            taskId: "A",
            specDigest: spec,
            key: "worker-question:x",
            text: trap,
          },
        }),
      ],
    ])
      f.c.db.run(
        "INSERT INTO events(at,kind,task_id,body,previous_hash,hash) VALUES(?,?,?,?,?,?)",
        now,
        kind,
        null,
        body,
        "x",
        "y",
      );
    const answers = (f.c as any).journalAnswers(f.c.task("A")).owner;
    assert.deepEqual(
      answers.map((a: { answer: string }) => a.answer),
      ["Keep it casual"],
    );
  } finally {
    f.close();
  }
});

test("smoke C1 follow-up: an answer lengthened by redaction still reaches the reviewer", async () => {
  const f = fixture([ASKING]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    // 65,536 characters is valid input; redaction then makes the stored text longer.
    const after = f.o.reply(f.id, {
      questionId: view.questions[0]!.id,
      replyKey: "owner-reply-1",
      text: "x".repeat(65_527) + " secret=a",
      sourceRef: "test:owner",
    });
    assert.ok(after.questions[0]!.replies[0]!.text.length > 65_536);
    const answers = (f.c as any).journalAnswers(f.c.task("A")).owner;
    assert.equal(answers.length, 1);
    assert.equal(answers[0].answer, "x".repeat(4_000));
  } finally {
    f.close();
  }
});

test("smoke C1 follow-up: without worker questions the reviewer brief has no owner answers", async () => {
  const f = fixture(["wrote output/A/hello.txt"]);
  try {
    await f.o.drive(f.id, { live: true });
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    assert.doesNotMatch(reviewer.brief, /OWNER ANSWERS/);
  } finally {
    f.close();
  }
});

test("finding 3: a question an interruption never recorded is recovered before review", async () => {
  const f = fixture([ASKING]);
  const o = f.o as any;
  try {
    // The host stops after the worker receipt but before the question is recorded.
    o.recordWorkerQuestions = () => {};
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    assert.equal(view.questions.length, 0);
    assert.ok(view.tasks[0]!.holds.includes("WORKER_QUESTION_NOT_RECORDED"));
    delete o.recordWorkerQuestions;
    view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    assert.equal(view.status, "WAITING_INPUT");
    assert.equal(view.questions.length, 1);
    assert.match(view.questions[0]!.text, /formal or casual/);
  } finally {
    f.close();
  }
});

test("finding 3: a failed question record holds review instead of letting it run", async () => {
  const f = fixture([ASKING]);
  const o = f.o as any;
  try {
    // Worker questions are recorded through the internal askScoped (their
    // keys are reserved to the controller since 2026-10-26).
    o.askScoped = () => {
      throw new Error("RECORD_FAILED");
    };
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    const task = view.tasks[0]!;
    assert.ok(task.holds.includes("WORKER_QUESTION_NOT_RECORDED"));
    assert.ok(
      task.steps.some(
        (s) => s.stage === "WORKER_QUESTION" && s.outcome === "HELD",
      ),
    );
    delete o.askScoped;
    view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    assert.equal(view.status, "WAITING_INPUT");
  } finally {
    f.close();
  }
});

test("finding 4: another request cannot review a task whose worker question is still open", async () => {
  const f = fixture([ASKING]);
  try {
    const first = await f.o.drive(f.id, { live: true });
    const other = f.submit(randomUUID());
    f.o.attach(other, ["A"]);
    let view = await f.o.drive(other, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    assert.ok(
      view.tasks[0]!.holds.includes("WORKER_QUESTION_OPEN_IN_OTHER_REQUEST"),
    );
    f.o.reply(f.id, {
      questionId: first.questions[0]!.id,
      replyKey: "owner-reply-1",
      text: "Casual",
      sourceRef: "test:owner",
    });
    view = await f.o.drive(other, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
  } finally {
    f.close();
  }
});

test("finding 5: an advisor on an earlier revision doesn't count as an author after the owner changes providers", async () => {
  const f = fixture(["wrote output/A/hello.txt"], { advice: true });
  try {
    // Advice is obtained for version 1, then the owner revises before any worker runs.
    await (f.o as any).advise(f.id, "A", true);
    revise(f, (t) => {
      const { advice: _advice, ...rest } = t;
      return { ...rest, providers: ["codex", "claude"] };
    });
    f.o.rebind(f.id, ["A"]);
    assert.ok(f.c.route("A").ok);
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:codex:codex-w",
      "reviewer:claude:claude-r",
    ]);
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("finding 6: live preflight judges what a task needs on its current specification", () => {
  const advice = { rationale: "r", sourceRef: "s" };
  // A revised task whose earlier revision was worked and reviewed needs everything again.
  assert.deepEqual(
    preflightNeeds(
      { status: "BLOCKED", advice, simulation: false },
      {
        specDigest: "v2",
        attempts: [{ role: "worker", state: "SUCCEEDED", specDigest: "v1" }],
        reviews: [{ specDigest: "v1" }],
      },
    ),
    {
      needsWorker: true,
      needsReviewer: true,
      needsAdvice: true,
      needsModerator: true,
      // A real task's revised specification is assessed again.
      needsAssessment: true,
    },
  );
  assert.deepEqual(
    preflightNeeds(
      { status: "WAITING_REVIEW", advice, simulation: false },
      {
        specDigest: "v1",
        attempts: [{ role: "worker", state: "SUCCEEDED", specDigest: "v1" }],
        reviews: [{ specDigest: "v1" }],
      },
    ),
    {
      needsWorker: false,
      needsReviewer: false,
      needsAdvice: false,
      needsModerator: false,
      needsAssessment: false,
    },
  );
  assert.deepEqual(
    preflightNeeds(
      { status: "READY", advice, simulation: false },
      {
        specDigest: "v1",
        attempts: [
          { role: "advisor", state: "SUCCEEDED", specDigest: "v1" },
          { role: "assessor", state: "SUCCEEDED", specDigest: "v1" },
        ],
        reviews: [],
      },
    ),
    {
      needsWorker: true,
      needsReviewer: true,
      needsAdvice: false,
      needsModerator: true,
      needsAssessment: false,
    },
  );
  // A simulation is never assessed by a model.
  assert.equal(
    preflightNeeds(
      { status: "READY", simulation: true },
      { specDigest: "v1", attempts: [], reviews: [] },
    ).needsAssessment,
    false,
  );
});

// Smoke C2: a reviewer's PASS listed an optional
// suggestion as remediation, the controller threw the report out, and nothing
// could review that work again.
const SUGGESTION = {
  remediation: ["Optional: keep a record of the owner's choice."],
};
const reviewRuns = (f: ReturnType<typeof fixture>) =>
  f.live.requests.filter((r) => r.role === "reviewer").length;
const rejections = (f: ReturnType<typeof fixture>) =>
  f.c.db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='REVIEW_REJECTED' ORDER BY seq",
    )
    .map((row) => JSON.parse(row.body));
const reviewerIds = (f: ReturnType<typeof fixture>) =>
  f.c
    .inspect("A")
    .attempts.filter((a: { role: string }) => a.role === "reviewer")
    .map((a: { id: string }) => a.id);

test("smoke C2 follow-up: reviewers are told that optional suggestions belong in proposals, not remediation", async () => {
  const f = fixture(["wrote output/A/hello.txt"]);
  try {
    await f.o.drive(f.id, { live: true });
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    // A first review puts optional ideas in proposals; a later
    // review puts them in findings as MINOR or INFO (see proposals.test.ts).
    assert.match(
      reviewer.brief,
      /Put optional ideas in proposals, never in remediation/,
    );
  } finally {
    f.close();
  }
});

test("smoke C2 follow-up: a thrown-out clean pass gets one more review, which is recorded", async () => {
  const f = fixture(["wrote output/A/hello.txt"], {
    reviews: [SUGGESTION, {}],
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 2);
    const [first, second] = reviewerIds(f);
    assert.deepEqual(rejections(f), [
      { runId: first, reason: "CONTRADICTORY_REVIEW_VERDICT", cleanPass: true },
    ]);
    const reviews = f.c.inspect("A").reviews;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].runId, second);
    assert.equal(reviews[0].verdict, "PASS");
    assert.ok(
      !view.tasks[0]!.holds.some((h) =>
        h.startsWith("WORKFLOW_RECORD_REVIEW_HELD"),
      ),
    );
  } finally {
    f.close();
  }
});

test("smoke C2 follow-up: a thrown-out clean pass is retried only once", async () => {
  const f = fixture(["wrote output/A/hello.txt"], { reviews: [SUGGESTION] });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 2);
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 2);
    assert.equal(f.c.inspect("A").reviews.length, 0);
    assert.deepEqual(
      rejections(f).map((r) => r.cleanPass),
      [true, true],
    );
    assert.ok(
      view.tasks[0]!.holds.includes(
        "WORKFLOW_RECORD_REVIEW_HELD:Error: CONTRADICTORY_REVIEW_VERDICT",
      ),
    );
  } finally {
    f.close();
  }
});

test("smoke C2 follow-up: a thrown-out report that flagged a real problem is not retried", async () => {
  for (const change of [
    // A pass that lists a serious finding.
    {
      findings: [
        {
          materiality: "MAJOR",
          evidenceIds: [],
          description: "The greeting is missing.",
        },
      ],
    },
    // A failing report rejected for citing evidence outside the task.
    {
      verdict: "FAIL",
      remediation: ["Write the greeting."],
      availableEvidence: ["no-such-evidence"],
    },
  ]) {
    const f = fixture(["wrote output/A/hello.txt"], { reviews: [change] });
    try {
      await f.o.drive(f.id, { live: true });
      await f.o.drive(f.id, { live: true });
      assert.equal(reviewRuns(f), 1);
      assert.equal(f.c.inspect("A").reviews.length, 0);
      assert.deepEqual(
        rejections(f).map((r) => r.cleanPass),
        [false],
      );
    } finally {
      f.close();
    }
  }
});

test("smoke C2 follow-up: a report thrown out before it was marked is retried on the next advance", async () => {
  const f = fixture(["wrote output/A/hello.txt"], {
    reviews: [SUGGESTION, {}],
  });
  try {
    // Marking fails once, as if the host stopped right after the rejection.
    const reject = f.c.rejectReview.bind(f.c);
    f.c.rejectReview = () => {
      throw new Error("SIMULATED_INTERRUPTION");
    };
    await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 1);
    assert.deepEqual(rejections(f), []);
    f.c.rejectReview = reject;
    await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 2);
    assert.equal(f.c.inspect("A").reviews.length, 1);
  } finally {
    f.close();
  }
});

test("smoke C2 follow-up: the controller marks only reports it really rejects, and never records a marked one", async () => {
  const f = fixture(["wrote output/A/hello.txt"]);
  try {
    // Recording fails for a reason that has nothing to do with the report.
    const review = f.c.review.bind(f.c);
    f.c.review = () => {
      throw new Error("SIMULATED_STORAGE_FAILURE");
    };
    await f.o.drive(f.id, { live: true });
    f.c.review = review;
    const run = reviewerIds(f)[0]!;
    assert.throws(
      () => f.c.rejectReview(run, f.c.localActor()),
      /REVIEW_REPORT_VALID/,
    );
    assert.deepEqual(rejections(f), []);
    assert.equal(reviewRuns(f), 1);
    // A run the controller has marked can never have its report recorded.
    f.c.db.event("REVIEW_REJECTED", "A", {
      runId: run,
      reason: "TEST",
      cleanPass: false,
    });
    const receipt = JSON.parse(
      f.c.db.get<{ body: string }>(
        "SELECT body FROM receipts WHERE attempt_id=?",
        run,
      )!.body,
    );
    assert.throws(
      () =>
        f.c.review(
          {
            ...JSON.parse(receipt.output),
            id: "manual-review",
            runId: run,
            reviewerSession: receipt.sessionId,
          },
          f.c.localActor(),
        ),
      /REVIEW_REPORT_REJECTED/,
    );
    // A recorded review can't be marked as thrown out.
    const g = fixture(["wrote output/A/hello.txt"]);
    try {
      await g.o.drive(g.id, { live: true });
      assert.throws(
        () => g.c.rejectReview(reviewerIds(g)[0]!, g.c.localActor()),
        /REVIEW_ALREADY_RECORDED/,
      );
    } finally {
      g.close();
    }
  } finally {
    f.close();
  }
});

const reviewReport = (f: ReturnType<typeof fixture>, run: string, id: string) => {
  const receipt = JSON.parse(
    f.c.db.get<{ body: string }>(
      "SELECT body FROM receipts WHERE attempt_id=?",
      run,
    )!.body,
  );
  return {
    ...JSON.parse(receipt.output),
    id,
    runId: run,
    reviewerSession: receipt.sessionId,
  };
};

test("smoke C2 re-review: a valid report imported twice under different IDs is recorded once", async () => {
  const f = fixture(["wrote output/A/hello.txt"]);
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(f.c.inspect("A").reviews.length, 1);
    const run = reviewerIds(f)[0]!;
    assert.throws(
      () =>
        f.c.review(reviewReport(f, run, "second-import"), f.c.localActor()),
      /REVIEW_ALREADY_RECORDED_FOR_ARTIFACT/,
    );
    assert.equal(f.c.inspect("A").reviews.length, 1);
  } finally {
    f.close();
  }
});

test("smoke C2 re-review: a review recorded by hand after a failed record still goes on to audit", async () => {
  const f = fixture(["wrote output/A/hello.txt"]);
  try {
    const review = f.c.review.bind(f.c);
    f.c.review = () => {
      throw new Error("SIMULATED_STORAGE_FAILURE");
    };
    await f.o.drive(f.id, { live: true });
    f.c.review = review;
    const run = reviewerIds(f)[0]!;
    f.c.review(reviewReport(f, run, "operator-import"), f.c.localActor());
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(reviewRuns(f), 1);
    assert.deepEqual(rejections(f), []);
    assert.ok(
      view.tasks[0]!.steps.some(
        (s) => s.stage === "AUDIT" && s.outcome === "RECORDED",
      ),
    );
  } finally {
    f.close();
  }
});
