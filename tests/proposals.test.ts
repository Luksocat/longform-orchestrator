import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller, proposalQuestionKey } from "../src/controller.js";
import {
  canonical,
  demoTask,
  digest,
  specDigest,
  TaskSchema,
  type Proposal,
  type Task,
} from "../src/domain.js";
import { preflightNeeds } from "../src/cli.js";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import {
  resolveRoute,
  RoutingPolicySchema,
  type RoutingCapability,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { BusyStore } from "./busy-store.js";

// Collaborative reviews: the first review of a
// specification may propose better ways to do the work; the worker answers
// each proposal in one more run; a moderator sorts what is still open; the
// owner decides the rest. Proposals never block a pass.

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
  id: "proposals-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-w", "low", ["worker"]),
    route("codex-routine", "ROUTINE", "codex", "codex-w", "low", ["worker"]),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", [
      "reviewer",
    ]),
    route("claude-standard", "STANDARD", "claude", "claude-r", "medium", [
      "reviewer",
    ]),
    // The owner's preference order: the top model first, then the fallback.
    route("top", "EXPERT", "claude", "claude-top", "max", [
      "advisor",
      "moderator",
    ]),
    route("next", "EXPERT", "claude", "claude-next", "max", [
      "advisor",
      "moderator",
    ]),
  ],
});

const proposal = (
  what: string,
  weight: "STRONG" | "IDEA",
  touchesDecision = false,
): Proposal => ({
  what,
  why: "The opening line sets the tone (output/A/hello.txt).",
  userImpact: "The first thing the user reads feels welcoming.",
  weight,
  touchesDecision,
});
type Reply = { id: string; reply: "ADOPT" | "ADAPT" | "DECLINE"; reason: string };
type Moderation = {
  id: string;
  decision: "CLOSE_AS_TASTE" | "ASK_OWNER";
  reason: string;
  question: string;
  options: { answer: string; effect: string }[];
  recommended: string;
}[];
type Script = {
  /** Per reviewer run: fields merged over a clean PASS. */
  reviews?: Record<string, unknown>[];
  /** The worker's reply to the proposal ids it is given. */
  reply?: (ids: string[]) => Reply[];
  /** Whether the reply run changes the work. */
  replyChanges?: boolean;
  /** The moderator's answer for the open ids it is given. */
  moderation?: (ids: string[]) => Moderation;
};
const ask = (id: string): Moderation[number] => ({
  id,
  decision: "ASK_OWNER",
  reason: "The player meets this line first, so it sets the game's tone.",
  question: "How should the game greet the user?",
  options: [
    { answer: "Keep it short", effect: "the greeting stays one line." },
    { answer: "Make it warmer", effect: "the greeting gets a second line." },
  ],
  recommended: "Make it warmer",
});

/** Scripted live-shaped adapter: records every request it receives. */
function adapter(script: Script) {
  const requests: ProviderRequest[] = [];
  let reviews = 0;
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
      if (request.role === "worker" && !p) {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt("wrote output/A/hello.txt");
      }
      if (request.role === "worker") {
        const ids: string[] = p!.replies.items.properties.id.enum;
        if (script.replyChanges !== false)
          writeFileSync(
            join(request.cwd, "output", "A", "hello.txt"),
            "hello, and welcome\n",
          );
        return receipt(
          canonical({
            taskId: p!.taskId.enum[0],
            summary: "Made the greeting warmer.",
            replies:
              script.reply?.(ids) ??
              ids.map((id) => ({ id, reply: "ADOPT", reason: "Agreed." })),
          }),
        );
      }
      if (request.role === "moderator") {
        const ids: string[] = p!.items.items.properties.id.enum;
        return receipt(
          canonical({
            taskId: p!.taskId.enum[0],
            specDigest: p!.specDigest.enum[0],
            items: script.moderation?.(ids) ?? ids.map(ask),
          }),
        );
      }
      const ev: string[] = p!.availableEvidence.items.enum;
      const override = script.reviews?.[reviews++] ?? {};
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
          // Only a first review is offered proposals.
          ...(p!.proposals ? { proposals: [] } : {}),
          ...override,
        }),
      );
    },
  };
  return self;
}

function fixture(
  script: Script = {},
  options: {
    maxAttempts?: number;
    maxCostUsd?: number;
    reviewRequired?: boolean;
    reviewAcceptance?: boolean;
    /** Models whose attestation is current; others are unavailable. */
    attested?: (model: string) => boolean;
    policy?: typeof policy;
    /** Run leases (the heartbeat is a third of one). */
    leaseMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-proposals-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  // The controller's view of the store, which a test can make busy.
  const busy = new BusyStore(db);
  const c = new Controller(busy, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: options.policy ?? policy,
    verifyRoutingCapability: (cap: RoutingCapability) =>
      options.attested?.(cap.model) ?? true,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
  });
  const live = adapter(script);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:proposals",
  });
  const source = o.ownerSource(request.request.id);
  c.importTasks(
    [
      TaskSchema.parse({
        id: "A",
        programme: "TEST",
        lane: "LOCAL",
        title: "Greeting",
        scope: "greeting",
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
        reviewPolicy: {
          required: options.reviewRequired ?? true,
          crossProvider: true,
          independentAudits: false,
        },
        acceptance: options.reviewAcceptance
          ? [{ id: "greeting-review", description: "Current independent review", evidenceKind: "REVIEW" }]
          : [{ id: "greeting", description: "greeting", evidenceKind: "LOCAL" }],
        simulation: false,
        budget: {
          deadlineMs: 60_000,
          maxAttempts: options.maxAttempts ?? 3,
          maxCostUsd: options.maxCostUsd ?? 5,
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
      sourceRef: "test:proposals",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    busy,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
type Fixture = ReturnType<typeof fixture>;
/** Each request as role:provider, with the worker's reply run marked. */
const roles = (f: Fixture) =>
  f.live.requests.map(
    (r) =>
      `${r.role}${r.role === "worker" && r.outputSchema ? "-reply" : ""}:${r.provider}`,
  );
const round = (f: Fixture) => f.c.proposalRound("A")!;
const steps = (f: Fixture) =>
  f.o
    .inspect(f.id)
    .tasks[0]!.steps.map((s) => `${s.stage}:${s.outcome}`);
const events = (f: Fixture, kind: string) =>
  f.c.db
    .all<{
      body: string;
    }>("SELECT body FROM events WHERE kind=? ORDER BY seq", kind)
    .map((row) => JSON.parse(row.body));
/** Answer an open question as the owner would, in words. */
const answer = (f: Fixture, questionId: string, text: string) =>
  f.o.reply(f.id, {
    questionId,
    replyKey: randomUUID(),
    text,
    sourceRef: "test:owner",
  });
const PROPOSALS = {
  proposals: [
    proposal("Add a warmer second line to the greeting.", "STRONG"),
    proposal("Use the game's name in the greeting.", "IDEA"),
  ],
};

test("a moderator is the first usable moderator route in policy order; workers and reviewers are unaffected", () => {
  const task = demoTask("A", {
    providers: ["claude", "codex"],
    simulation: false,
  });
  const pick = (available: string[]) =>
    resolveRoute(task, "moderator", policy, {
      verifyLiveCapability: (cap) => available.includes(cap.model),
    });
  const top = pick(["claude-top", "claude-next"]);
  assert.ok(top.ok && top.model === "claude-top" && top.effort === "max");
  const next = pick(["claude-next"]);
  assert.ok(next.ok && next.model === "claude-next");
  const none = pick([]);
  assert.equal(none.ok, false);
  const worker = resolveRoute(task, "worker", policy, {
    verifyLiveCapability: () => true,
  });
  assert.ok(worker.ok && worker.routeId === "claude-routine");
});

test("a review without proposals runs as before: no reply, no moderator", async () => {
  const f = fixture();
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude", "reviewer:codex"]);
    assert.equal(f.c.proposalRound("A"), undefined);
    // The first review was offered proposals and gave none.
    const reviewer = f.live.requests[1]!;
    assert.ok(
      (reviewer.outputSchema as any).properties.proposals,
      "a first review may propose",
    );
    assert.match(reviewer.brief, /userImpact/);
    assert.match(reviewer.brief, /review as a collaborator, not only a checker/);
    assert.deepEqual(f.c.inspect("A").reviews[0].proposals, []);
  } finally {
    f.close();
  }
});

test("the worker adopts every proposal: its reply starts from its work, and the reply gets its own review", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "reviewer:codex",
    ]);
    const [, , reply, followUp] = f.live.requests;
    // The reply run starts from the sealed work and may change it.
    assert.deepEqual(reply!.filesystemPolicy?.writablePaths, ["output/A"]);
    assert.match(reply!.brief, /Answer every proposal: ADOPT/);
    assert.match(reply!.brief, /Add a warmer second line/);
    assert.deepEqual(
      (reply!.outputSchema as any).properties.replies.items.properties.id.enum,
      ["P1", "P2"],
    );
    const replyRun = f.c
      .inspect("A")
      .attempts.find((a: any) => a.proposalRound)!;
    assert.equal(
      readFileSync(join(replyRun.workspace, "output", "A", "hello.txt"), "utf8"),
      "hello, and welcome\n",
    );
    // The follow-up review checks the reply and cannot propose.
    assert.match(followUp!.brief, /FOLLOW-UP REVIEW/);
    assert.doesNotMatch(followUp!.brief, /review as a collaborator/);
    assert.match(followUp!.brief, /"settlement":"ADOPTED"/);
    assert.equal((followUp!.outputSchema as any).properties.proposals, undefined);
    assert.match(followUp!.brief, /Put optional suggestions in findings as MINOR or INFO/);
    const r = round(f);
    assert.equal(r.stage, "SETTLED");
    assert.deepEqual(
      r.items.map((i) => i.settlement),
      ["ADOPTED", "ADOPTED"],
    );
    assert.equal(r.reply?.reviewed, true);
    // Audits ran on the reply's review; verification waits only on the owner's binding.
    assert.ok(f.c.inspect("A").audits.length > 0);
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        h.includes("MISSING_ACCEPTANCE_EVIDENCE:greeting"),
      ),
      view.tasks[0]!.holds.join(),
    );
    assert.equal(f.c.inspect("A").reviews.length, 2);
  } finally {
    f.close();
  }
});

test("before the round settles, the work cannot be verified", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    // Stop after the first review: the reply has not run yet.
    await (f.o as any).worker(f.id, "A", true);
    await (f.o as any).reviewPhase(
      f.id,
      [{ taskId: "A", currentSpecDigest: "", holds: [] }],
      true,
    );
    assert.equal(round(f).stage, "AWAITING_REPLY");
    assert.equal(f.c.inspect("A").audits.length, 0, "no audit before the reply");
    assert.equal(f.o.inspect(f.id).status, "READY_FOR_PROPOSAL_ROUND");
    const worker = f.c
      .inspect("A")
      .attempts.find((a: any) => a.role === "worker")!;
    f.c.bindAcceptance("A", "greeting", "output-" + worker.id, f.c.localActor());
    assert.throws(
      () => f.c.verify("A", f.c.localActor()),
      /PROPOSAL_ROUND_OPEN:AWAITING_REPLY/,
    );
  } finally {
    f.close();
  }
});

test("a declined idea settles; a declined strong proposal goes to the moderator, who may close a matter of taste", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [
      { id: "P1", reply: "DECLINE", reason: "A second line slows the opening." },
      { id: "P2", reply: "DECLINE", reason: "The name is on the title screen." },
    ],
    moderation: (ids) =>
      ids.map((id) => ({
        id,
        decision: "CLOSE_AS_TASTE",
        reason: "Either greeting reads fine; the user won't notice.",
        question: "",
        options: [],
        recommended: "",
      })),
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "moderator:claude",
      "reviewer:codex",
    ]);
    const moderator = f.live.requests[3]!;
    assert.equal(moderator.model, "claude-top");
    assert.equal(moderator.effort, "max");
    assert.deepEqual(moderator.filesystemPolicy?.writablePaths, []);
    assert.match(moderator.brief, /You are the moderator/);
    assert.match(moderator.brief, /A second line slows the opening/);
    // Only the open item is put to the moderator.
    assert.deepEqual(
      (moderator.outputSchema as any).properties.items.items.properties.id.enum,
      ["P1"],
    );
    const r = round(f);
    assert.equal(r.stage, "SETTLED");
    assert.deepEqual(
      r.items.map((i) => i.settlement),
      ["CLOSED_BY_MODERATOR", "DECLINED"],
    );
    assert.equal(f.o.inspect(f.id).questions.length, 0);
  } finally {
    f.close();
  }
});

test("what matters to the user comes to the owner, recommended answer first; the reply is reviewed after the answer", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [
      { id: "P1", reply: "ADAPT", reason: "Warmer, but still one line." },
      { id: "P2", reply: "ADOPT", reason: "Agreed." },
    ],
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "moderator:claude",
    ]);
    assert.equal(view.status, "WAITING_INPUT");
    assert.equal(view.questions.length, 1);
    const q = view.questions[0]!;
    assert.equal(q.kind, "OWNER_DECISION");
    assert.equal(q.taskId, "A");
    assert.equal(q.key, proposalQuestionKey(round(f).reviewRunId, "P1"));
    assert.match(q.text, /The reviewer proposed: Add a warmer second line/);
    assert.match(q.text, /The worker agreed with the aim but would do it differently: Warmer, but still one line\./);
    assert.match(q.text, /How should the game greet the user\?/);
    assert.match(q.text, /1\) Make it warmer \(Recommended\): /);
    assert.match(q.text, /2\) Keep it short: /);
    assert.equal(round(f).stage, "AWAITING_OWNER");
    assert.deepEqual(
      view.tasks[0]!.proposals!.items.map((i) => i.settlement),
      ["OWNER_QUESTION", "ADOPTED"],
    );
    // Advancing again asks nothing twice and runs nothing more.
    await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 4);
    assert.equal(f.o.inspect(f.id).questions.length, 1);
    answer(f, q.id, "Keep it short");
    view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f).slice(4), ["reviewer:codex"]);
    const followUp = f.live.requests[4]!;
    assert.match(followUp.brief, /OWNER ANSWERS/);
    assert.match(followUp.brief, /Keep it short/);
    const r = round(f);
    assert.equal(r.stage, "SETTLED");
    assert.deepEqual(r.items[0]!.question!.answers, ["Keep it short"]);
    assert.equal(r.items[0]!.settlement, "OWNER_DECIDED");
  } finally {
    f.close();
  }
});

test("only the owner's answer settles an owner question on a proposal: the operator cannot answer it, and an operator reply in the journal settles nothing", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [
      { id: "P1", reply: "ADAPT", reason: "Warmer, but still one line." },
      { id: "P2", reply: "ADOPT", reason: "Agreed." },
    ],
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const q = view.questions[0]!;
    assert.equal(round(f).stage, "AWAITING_OWNER");
    assert.throws(
      () =>
        f.o.reply(f.id, {
          questionId: q.id,
          replyKey: randomUUID(),
          text: "Keep it short",
          sourceRef: "operator:records",
          answeredAs: "OPERATOR",
          evidence: ["run R"],
        }),
      /OPERATOR_CANNOT_ANSWER_OWNER_QUESTION/,
    );
    // A reply recorded as the operator's (here written straight to the
    // journal) is never read as the owner's.
    (f.o as any).append(f.id, "WORKFLOW_REPLY", {
      reply: {
        questionId: q.id,
        replyKey: "forged-operator-reply",
        text: "Keep it short",
        sourceRef: "operator:records",
        answeredAs: "OPERATOR",
        evidence: ["run R"],
        inputDigest: "x",
        actor: "operator",
        createdAt: new Date().toISOString(),
        grantsAuthority: false,
      },
    });
    assert.equal(round(f).stage, "AWAITING_OWNER");
    assert.equal(round(f).items[0]!.settlement, "OWNER_QUESTION");
    answer(f, q.id, "Keep it short");
    assert.equal(round(f).items[0]!.settlement, "OWNER_DECIDED");
    assert.deepEqual(round(f).items[0]!.question!.answers, ["Keep it short"]);
  } finally {
    f.close();
  }
});

test("a proposal that touches a decision always reaches the owner, even if the worker agrees and the moderator would close it", async () => {
  const f = fixture({
    reviews: [
      {
        proposals: [
          proposal("Let the user skip the greeting.", "IDEA", true),
        ],
      },
    ],
    reply: () => [{ id: "P1", reply: "ADOPT", reason: "Players like skipping." }],
    moderation: (ids) =>
      ids.map((id) => ({
        id,
        decision: "CLOSE_AS_TASTE",
        reason: "Minor.",
        question: "",
        options: [],
        recommended: "",
      })),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.ok(f.live.requests[2]!.brief.includes("Do not make that change"));
    const r = round(f);
    assert.equal(r.items[0]!.settlement, "OWNER_QUESTION");
    assert.equal(view.questions.length, 1);
    assert.match(view.questions[0]!.text, /only you can decide it/);
    assert.match(view.questions[0]!.text, /left the work unchanged because this is your decision/);
  } finally {
    f.close();
  }
});

test("without a usable moderator the open items go to the owner without a recommendation", async () => {
  const f = fixture(
    {
      reviews: [PROPOSALS],
      reply: () => [
        { id: "P1", reply: "DECLINE", reason: "Too long." },
        { id: "P2", reply: "ADOPT", reason: "Agreed." },
      ],
    },
    { attested: (model) => !["claude-top", "claude-next"].includes(model) },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.ok(!roles(f).some((r) => r.startsWith("moderator")));
    assert.match(
      events(f, "MODERATOR_NOT_OBTAINED")[0].reason,
      /MODERATOR_UNAVAILABLE/,
    );
    assert.equal(view.questions.length, 1);
    const text = view.questions[0]!.text;
    assert.match(text, /No moderator recommendation is available\./);
    assert.match(text, /1\) Keep the work as it is: /);
    assert.doesNotMatch(text, /Recommended/);
  } finally {
    f.close();
  }
});

test("a moderator answer that doesn't fit the schema counts as no recommendation", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [{ id: "P1", reply: "DECLINE", reason: "No." }],
    moderation: () => [{ id: "P1" } as any],
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const r = round(f);
    assert.equal(r.moderator?.usable, false);
    // The unanswered idea stays open too.
    assert.deepEqual(
      r.items.map((i) => i.settlement),
      ["OWNER_QUESTION", "OWNER_QUESTION"],
    );
    assert.equal(view.questions.length, 2);
  } finally {
    f.close();
  }
});

test("when the attempt budget is used up the round goes on without a reply, and the first review verifies", async () => {
  const f = fixture({ reviews: [PROPOSALS] }, { maxAttempts: 1 });
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "moderator:claude",
    ]);
    assert.equal(events(f, "PROPOSAL_REPLY_SKIPPED")[0].reason, "ATTEMPT_BUDGET_EXHAUSTED");
    assert.match(
      f.live.requests[2]!.brief,
      /The worker did not answer this proposal\./,
    );
    assert.equal(view.questions.length, 2);
    for (const q of view.questions) answer(f, q.id, "Keep it short");
    view = await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 3, "no reviewer reruns on the same work");
    assert.equal(round(f).stage, "SETTLED");
    assert.ok(f.c.inspect("A").audits.length > 0);
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        h.includes("MISSING_ACCEPTANCE_EVIDENCE:greeting"),
      ),
      view.tasks[0]!.holds.join(),
    );
  } finally {
    f.close();
  }
});

test("a reply that claims a change but changes nothing still gets a review of its own", async () => {
  const f = fixture({ reviews: [PROPOSALS], replyChanges: false });
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "reviewer:codex",
    ]);
    const reviews = f.c.inspect("A").reviews;
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].workspaceDigest, reviews[1].workspaceDigest);
    assert.equal(round(f).reply?.reviewed, true);
    assert.ok(f.c.inspect("A").audits.length > 0);
  } finally {
    f.close();
  }
});

const declineAll = (ids: string[]): Reply[] =>
  ids.map((id) => ({ id, reply: "DECLINE", reason: "Kept as it is." }));

test("a reply that only declines and changes nothing keeps the review that opened the round", async () => {
  const f = fixture({
    reviews: [{ proposals: [proposal("Idea 1", "IDEA"), proposal("Idea 2", "IDEA")] }],
    reply: declineAll,
    replyChanges: false,
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
    ]);
    const r = round(f);
    assert.equal(r.stage, "SETTLED");
    assert.equal(r.reply?.reviewed, true);
    assert.equal(r.reply?.standsOnReview, r.reviewRunId);
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.ok(f.c.inspect("A").audits.length > 0);
    // Only the owner's acceptance binding is left, as on any reviewed reply.
    assert.deepEqual(view.tasks[0]!.holds, [
      "WORKFLOW_VERIFY_HELD:Error: MISSING_ACCEPTANCE_EVIDENCE:greeting",
    ]);
    // The reply is the current work, so its output is what acceptance binds.
    f.c.bindAcceptance("A", "greeting", "output-" + r.reply!.runId, f.c.localActor());
    f.c.verify("A", f.c.localActor());
    assert.equal(f.c.task("A").status, "VERIFIED");
    // Nothing is left to schedule: no further reviewer may run on this work.
    await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 3);
  } finally {
    f.close();
  }
});

test("REVIEW acceptance binds a controller-retained opening review after unchanged proposal reply", async () => {
  const f = fixture(
    {
      reviews: [{ proposals: [proposal("Idea 1", "IDEA"), proposal("Idea 2", "IDEA")] }],
      reply: declineAll,
      replyChanges: false,
    },
    { reviewAcceptance: true },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    const r = round(f);
    assert.equal(r.stage, "SETTLED");
    assert.equal(r.reply?.standsOnReview, r.reviewRunId);
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.equal(f.live.requests.length, 3);
    const proof = f.c.evidenceFor("A").find((e) => e.kind === "REVIEW")!;
    assert.equal(proof.metadata.reviewRunId, r.reviewRunId);
    assert.notEqual(proof.metadata.workerRunId, r.reply!.runId);
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        h.includes("MISSING_ACCEPTANCE_EVIDENCE:greeting-review"),
      ),
    );
    const actor = f.c.localActor();
    f.c.bindAcceptance("A", "greeting-review", proof.id, actor);
    f.c.verify("A", actor);
    assert.equal(f.c.task("A").status, "VERIFIED");
    await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 3, "no extra reviewer runs on an unchanged reply");
    assert.equal(f.c.inspect("A").reviews.length, 1);
  } finally {
    f.close();
  }
});

test("a strong proposal the moderator closes as taste also keeps the opening review when nothing changed", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: declineAll,
    replyChanges: false,
    moderation: (ids) =>
      ids.map((id) => ({
        id,
        decision: "CLOSE_AS_TASTE",
        reason: "Either greeting reads fine; the user won't notice.",
        question: "",
        options: [],
        recommended: "",
      })),
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "moderator:claude",
    ]);
    assert.equal(round(f).reply?.standsOnReview, round(f).reviewRunId);
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.ok(f.c.inspect("A").audits.length > 0);
  } finally {
    f.close();
  }
});

test("an unchanged reply is still reviewed after the owner answered, after a failed review, or when other evidence arrived", async () => {
  // The owner was asked: the review must check the work against the answer.
  const asked = fixture({ reviews: [PROPOSALS], reply: declineAll, replyChanges: false });
  try {
    let view = await asked.o.drive(asked.id, { live: true });
    assert.equal(view.status, "WAITING_INPUT");
    answer(asked, view.questions[0]!.id, "Keep it short");
    view = await asked.o.drive(asked.id, { live: true });
    assert.equal(roles(asked).at(-1), "reviewer:codex");
    assert.equal(round(asked).reply?.standsOnReview, undefined);
    assert.equal(asked.c.inspect("A").reviews.length, 2);
  } finally {
    asked.close();
  }
  // A claimed adaptation of a strong proposal stays a claim, even once the
  // moderator closes the item as taste.
  const adapted = fixture({
    reviews: [PROPOSALS],
    reply: (ids) => ids.map((id) => ({ id, reply: id === "P1" ? "ADAPT" : "DECLINE", reason: "Warmer." })),
    replyChanges: false,
    moderation: (ids) =>
      ids.map((id) => ({
        id,
        decision: "CLOSE_AS_TASTE",
        reason: "Either greeting reads fine.",
        question: "",
        options: [],
        recommended: "",
      })),
  });
  try {
    await adapted.o.drive(adapted.id, { live: true });
    assert.equal(round(adapted).items[0]!.settlement, "CLOSED_BY_MODERATOR");
    assert.equal(roles(adapted).at(-1), "reviewer:codex");
    assert.equal(round(adapted).reply?.standsOnReview, undefined);
  } finally {
    adapted.close();
  }
  // The opening review failed: the reply is the rework and is reviewed.
  const failed = fixture({
    reviews: [
      {
        proposals: [proposal("Idea 1", "IDEA")],
        verdict: "FAIL",
        remediation: ["The greeting must end with a newline."],
        findings: [{ materiality: "MAJOR", evidenceIds: [], description: "Missing newline." }],
      },
    ],
    reply: declineAll,
    replyChanges: false,
  });
  try {
    await failed.o.drive(failed.id, { live: true });
    assert.equal(roles(failed).at(-1), "reviewer:codex");
    assert.equal(round(failed).reply?.standsOnReview, undefined);
  } finally {
    failed.close();
  }
  // Evidence recorded since the opening review: that review no longer stands.
  const more = fixture({
    reviews: [{ proposals: [proposal("Idea 1", "IDEA")] }],
    reply: declineAll,
    replyChanges: false,
  });
  try {
    await more.o.drive(more.id, { live: true });
    assert.equal(round(more).reply?.standsOnReview, round(more).reviewRunId);
    more.c.addEvidence(
      {
        id: "late",
        taskId: "A",
        kind: "LOCAL",
        uri: "note:late",
        revision: "1",
        digest: digest("late"),
        retrievedAt: new Date().toISOString(),
        authorityTier: "PLANNING",
        authentication: "LOCAL_IMPORT",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: [],
        metadata: {},
      },
      more.c.localActor(),
    );
    assert.equal(round(more).reply?.standsOnReview, undefined);
    assert.equal(round(more).reply?.reviewed, false);
    assert.equal(more.c.artifactReviews(more.c.task("A")).reviewed, false);
  } finally {
    more.close();
  }
});

test("after a failed first review, the reply fixes the must-fix items and answers the proposals", async () => {
  const f = fixture({
    reviews: [
      {
        ...PROPOSALS,
        verdict: "FAIL",
        remediation: ["The greeting must end with a newline."],
        findings: [
          {
            materiality: "MAJOR",
            evidenceIds: [],
            description: "Missing trailing newline.",
          },
        ],
      },
    ],
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "reviewer:codex",
    ]);
    const reply = f.live.requests[2]!;
    assert.match(reply.brief, /Fix every item in mustFix/);
    assert.match(reply.brief, /The greeting must end with a newline\./);
    assert.match(f.live.requests[3]!.brief, /"mustFix":\["The greeting must end with a newline\."\]/);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(f.c.inspect("A").reviews.at(-1).verdict, "PASS");
  } finally {
    f.close();
  }
});

test("only the first review of a specification opens a round, with its first five non-blank proposals", async () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    proposal(i === 0 ? "  " : "Idea " + i, "IDEA"),
  );
  const f = fixture({
    reviews: [{ proposals: many }, { proposals: [proposal("Late", "STRONG")] }],
  });
  try {
    await f.o.drive(f.id, { live: true });
    const r = round(f);
    assert.deepEqual(
      r.items.map((i) => `${i.id}:${i.what}`),
      ["P1:Idea 1", "P2:Idea 2", "P3:Idea 3", "P4:Idea 4", "P5:Idea 5"],
    );
    // The follow-up's own proposals (outside its schema) open nothing.
    assert.equal(f.c.proposalRound("A")!.reviewRunId, r.reviewRunId);
    assert.equal(r.stage, "SETTLED");
  } finally {
    f.close();
  }
});

test("a reply runs once per round, and the moderator only when something is open", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    await f.o.drive(f.id, { live: true });
    const r = round(f);
    const actor = f.c.localActor();
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "again", proposalRound: r.reviewRunId },
          actor,
        ),
      /TASK_NOT_DISPATCHABLE|PROPOSAL_REPLY_NOT_PENDING/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "moderator", requestKey: "m", proposalRound: r.reviewRunId },
          actor,
        ),
      /MODERATOR_NOT_NEEDED/,
    );
    assert.throws(
      () => f.c.reserve("A", { role: "moderator", requestKey: "m2" }, actor),
      /MODERATOR_REQUIRES_PROPOSAL_ROUND/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "reviewer", requestKey: "r", proposalRound: r.reviewRunId },
          actor,
        ),
      /PROPOSAL_ROUND_ONLY_FOR_REPLY_OR_MODERATOR/,
    );
    assert.throws(() => f.c.skipProposalReply("A", actor), /PROPOSAL_REPLY_NOT_PENDING/);
  } finally {
    f.close();
  }
});

test("a reply can't be skipped while it can still run", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    await (f.o as any).worker(f.id, "A", true);
    await (f.o as any).reviewPhase(
      f.id,
      [{ taskId: "A", currentSpecDigest: "", holds: [] }],
      true,
    );
    assert.throws(
      () => f.c.skipProposalReply("A", f.c.localActor()),
      /PROPOSAL_REPLY_STILL_POSSIBLE/,
    );
  } finally {
    f.close();
  }
});

test("a moderator run with an unknown outcome keeps the task in review", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [{ id: "P1", reply: "DECLINE", reason: "No." }],
  });
  try {
    const throwing = f.live.execute.bind(f.live);
    f.live.execute = async (request) => {
      if (request.role === "moderator") throw new Error("PROCESS_LOST");
      return throwing(request);
    };
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(round(f).stage, "MODERATOR_UNRESOLVED");
    assert.equal(f.o.inspect(f.id).status, "HELD_RECONCILIATION");
  } finally {
    f.close();
  }
});

test("live preflight attests what a proposal round still needs", () => {
  const base = {
    specDigest: "v1",
    attempts: [{ role: "worker", state: "SUCCEEDED", specDigest: "v1" }],
    reviews: [{ specDigest: "v1" }],
  };
  assert.deepEqual(
    preflightNeeds(
      { status: "WAITING_REVIEW" },
      { ...base, proposalRound: { stage: "AWAITING_REPLY" } },
    ),
    // The reply and its review can both run in this advance.
    {
      needsWorker: true,
      needsReviewer: true,
      needsAdvice: false,
      needsModerator: true,
      needsAssessment: false,
    },
  );
  // A first review may open a round whose reply runs in the same advance.
  assert.deepEqual(
    preflightNeeds({ status: "WAITING_REVIEW" }, { ...base, reviews: [] }),
    {
      needsWorker: true,
      needsReviewer: true,
      needsAdvice: false,
      needsModerator: true,
      needsAssessment: false,
    },
  );
  assert.deepEqual(
    preflightNeeds(
      { status: "WAITING_REVIEW" },
      {
        ...base,
        proposalRound: {
          stage: "SETTLED",
          reply: { state: "SUCCEEDED", reviewed: false },
        },
      },
    ),
    {
      needsWorker: false,
      needsReviewer: true,
      needsAdvice: false,
      needsModerator: false,
      needsAssessment: false,
    },
  );
  assert.deepEqual(
    preflightNeeds(
      { status: "WAITING_REVIEW" },
      {
        ...base,
        proposalRound: {
          stage: "SETTLED",
          reply: { state: "SUCCEEDED", reviewed: true },
        },
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
  // A failed review's rework and the rework's review run in one advance.
  assert.deepEqual(
    preflightNeeds(
      { status: "REMEDIATION_REQUIRED" },
      { ...base, rework: { reviewRunId: "r1" } },
    ),
    {
      needsWorker: true,
      needsReviewer: true,
      needsAdvice: false,
      needsModerator: false,
      needsAssessment: false,
    },
  );
  // Finished work that no review has judged yet (a rework awaiting its own
  // review) still needs the reviewer route; reviewed work does not.
  assert.equal(
    preflightNeeds(
      { status: "WAITING_REVIEW" },
      { ...base, artifactReviewed: false },
    ).needsReviewer,
    true,
  );
  assert.equal(
    preflightNeeds(
      { status: "WAITING_REVIEW" },
      { ...base, artifactReviewed: true },
    ).needsReviewer,
    false,
  );
});

test("a spec revised after the owner chose a change starts a fresh round", async () => {
  const f = fixture(
    {
      reviews: [PROPOSALS, { proposals: [proposal("Fresh idea", "IDEA")] }],
      reply: (ids) =>
        ids.map((id) =>
          id === "P1"
            ? { id, reply: "DECLINE" as const, reason: "No." }
            : { id, reply: "ADOPT" as const, reason: "Agreed." },
        ),
    },
    { maxAttempts: 5 },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    const old = round(f);
    answer(f, view.questions[0]!.id, "Make it warmer");
    // The host folds the owner's choice into a revised task and rebinds it.
    const t = f.c.task("A");
    const { status: _status, ...rest } = t;
    f.c.revise(
      "A",
      { ...rest, specVersion: 2, scope: "greeting, warmer" },
      f.c.localActor(),
    );
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "test",
        sourceRef: "test:proposals",
      },
      f.c.localActor(),
    );
    f.o.rebind(f.id, ["A"]);
    assert.equal(f.c.proposalRound("A"), undefined);
    await f.o.drive(f.id, { live: true });
    const fresh = round(f);
    assert.notEqual(fresh.reviewRunId, old.reviewRunId);
    assert.deepEqual(fresh.items.map((i) => i.what), ["Fresh idea"]);
    assert.equal(specDigest(f.c.task("A")), f.c.inspect("A").specDigest);
  } finally {
    f.close();
  }
});

test("while the owner's proposal question is open in one request, another request neither reviews the reply nor asks again", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [
      { id: "P1", reply: "DECLINE", reason: "Too long." },
      { id: "P2", reply: "ADOPT", reason: "Agreed." },
    ],
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(round(f).stage, "AWAITING_OWNER");
    const other = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Write a greeting",
      context: { cwd: tmpdir() },
      sourceRef: "test:proposals",
      taskIds: ["A"],
    }).request.id;
    const view = await f.o.drive(other, { live: true });
    assert.ok(
      view.tasks[0]!.holds.includes("PROPOSAL_QUESTION_OPEN_IN_OTHER_REQUEST"),
    );
    assert.equal(view.questions.length, 0);
    // Even reached directly, review waits for the owner's answer.
    await (f.o as any).reviewAndVerify(other, "A", true);
    assert.deepEqual(roles(f), [
      "worker:claude",
      "reviewer:codex",
      "worker-reply:claude",
      "moderator:claude",
    ]);
  } finally {
    f.close();
  }
});

test("a reply that can't be scheduled shows as a hold, not as more to advance", async () => {
  let workerRouteUp = true;
  const f = fixture(
    { reviews: [PROPOSALS] },
    { attested: (model) => workerRouteUp || model !== "claude-w" },
  );
  try {
    await (f.o as any).worker(f.id, "A", true);
    await (f.o as any).reviewPhase(
      f.id,
      [{ taskId: "A", currentSpecDigest: "", holds: [] }],
      true,
    );
    assert.equal(f.o.inspect(f.id).status, "READY_FOR_PROPOSAL_ROUND");
    workerRouteUp = false;
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(round(f).stage, "AWAITING_REPLY");
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        /^WORKFLOW_PROPOSAL_REPLY_RESERVATION_HELD:.*ROUTING_HELD/.test(h),
      ),
      view.tasks[0]!.holds.join(),
    );
    assert.equal(view.status, "HELD");
    // Once the route is back, the next advance runs the reply.
    workerRouteUp = true;
    await f.o.drive(f.id, { live: true });
    assert.ok(roles(f).includes("worker-reply:claude"));
    assert.equal(round(f).stage, "SETTLED");
  } finally {
    f.close();
  }
});

test("a reply is reviewed before sign-off even when the task doesn't require review", async () => {
  const f = fixture({ reviews: [PROPOSALS] }, { reviewRequired: false });
  try {
    await (f.o as any).worker(f.id, "A", true);
    await (f.o as any).reviewPhase(
      f.id,
      [{ taskId: "A", currentSpecDigest: "", holds: [] }],
      true,
    );
    await (f.o as any).answerProposals(f.id, "A", true);
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(round(f).reply?.reviewed, false);
    const actor = f.c.localActor();
    const reply = f.c
      .inspect("A")
      .attempts.find((a: any) => a.proposalRound)!;
    f.c.bindAcceptance("A", "greeting", "output-" + reply.id, actor);
    f.c.audit("A", actor);
    assert.throws(
      () => f.c.verify("A", actor),
      /PROPOSAL_REPLY_REVIEW_REQUIRED/,
    );
  } finally {
    f.close();
  }
});

test("a reply stays with the provider that did the work, even one chosen by hand", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    const actor = f.c.localActor();
    // The operator ran the work on Codex explicitly, against the task's
    // provider order.
    const worker = f.c.reserve(
      "A",
      {
        provider: "codex",
        model: "codex-w",
        effort: "low",
        overrideReason: "test: explicit provider",
        requestKey: "manual-worker",
      },
      actor,
    );
    await f.c.execute(worker, f.live, actor);
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:codex",
      "reviewer:claude",
      "worker-reply:codex",
      "reviewer:claude",
    ]);
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(round(f).reply?.reviewed, true);
  } finally {
    f.close();
  }
});

test("a spending budget used up exactly lets the round go on without a reply or a moderator", async () => {
  // The worker and the first review cost 0.01 each.
  const f = fixture(
    {
      reviews: [PROPOSALS],
      reply: () => [{ id: "P1", reply: "DECLINE", reason: "No." }],
    },
    { maxCostUsd: 0.02 },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude", "reviewer:codex"]);
    assert.equal(
      events(f, "PROPOSAL_REPLY_SKIPPED")[0].reason,
      "EXECUTION_BUDGET_EXHAUSTED",
    );
    assert.match(
      events(f, "MODERATOR_NOT_OBTAINED")[0].reason,
      /EXECUTION_BUDGET_EXHAUSTED/,
    );
    assert.equal(view.questions.length, 2);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
  } finally {
    f.close();
  }
});

// Edge cases found by an independent review that apply here too.

/** Runs the worker and the first review only, so the round has not started. */
const firstReviewOnly = async (f: Fixture) => {
  await (f.o as any).worker(f.id, "A", true);
  await (f.o as any).reviewPhase(
    f.id,
    [{ taskId: "A", currentSpecDigest: "", holds: [] }],
    true,
  );
};
/** Evidence that the given run stopped without effects, for reconciliation. */
const stopped = (f: Fixture, runId: string, id: string) =>
  f.c.addEvidence(
    {
      id,
      taskId: "A",
      kind: "LOCAL",
      uri: "test:" + id,
      revision: f.c.task("A").artifactRevision,
      digest: digest(id),
      retrievedAt: new Date().toISOString(),
      authorityTier: "IMPLEMENTATION",
      authentication: "LOCAL_IMPORT",
      currentness: "CURRENT_AT_RETRIEVAL",
      claims: ["The run stopped before the model started"],
      metadata: {
        runId,
        reconciliation: {
          processStopped: true,
          externalEffects: "NONE",
          assessment: "Runner verification failed before the model started",
          // The operator states the usage this controller never observed.
          usage: { costUsd: 0, tokens: 0 },
        },
      },
    },
    f.c.localActor(),
  );
/** A moderator whose provider fails its own checks and reports no usage. */
const failingModerator = (f: Fixture) => {
  const execute = f.live.execute.bind(f.live);
  f.live.execute = async (request) => {
    const receipt = await execute(request);
    if (request.role !== "moderator") return receipt;
    return {
      ...receipt,
      status: "FAILED",
      exitCode: null,
      identityVerified: false,
      costUsd: null,
      tokens: null,
      output: "ISOLATED_RUNNER_POLICY_UNVERIFIED",
    };
  };
};

test("a reply interrupted before it started is reserved again from the same sealed work", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    await firstReviewOnly(f);
    const actor = f.c.localActor();
    const sealed = f.c
      .inspect("A")
      .attempts.find((a: any) => a.role === "worker")!.workspaceDigest;
    // The host stopped after reserving the reply; its lease then expires.
    const lost = f.c.reserve(
      "A",
      { requestKey: "lost-reply", proposalRound: round(f).reviewRunId },
      actor,
    );
    const recovered = f.c.recover(actor, Date.now() + 3_600_000);
    assert.deepEqual(
      recovered.map((x: any) => `${x.runId}:${x.outcome}`),
      [`${lost.id}:DEFINITELY_NOT_STARTED`],
    );
    assert.equal(round(f).stage, "AWAITING_REPLY");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    await f.o.drive(f.id, { live: true });
    const reply = f.c
      .inspect("A")
      .attempts.filter((a: any) => a.proposalRound && a.state === "SUCCEEDED");
    assert.equal(reply.length, 1);
    assert.equal(digest(reply[0].baseline), sealed);
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(round(f).reply?.reviewed, true);
  } finally {
    f.close();
  }
});

// A busy database can interrupt a reply: the round stays
// REPLY_FAILED until reconciliation makes another attempt safe.
test("a reply the controller stopped because the database stayed busy is asked again after reconciliation, and the round settles", async () => {
  const f = fixture({ reviews: [PROPOSALS] }, { leaseMs: 3_000 });
  try {
    await firstReviewOnly(f);
    const actor = f.c.localActor();
    // The first reply is held up by another session's writes until the
    // controller stops it; its receipt reports no usage, as the real one did.
    const execute = f.live.execute.bind(f.live);
    let first = true;
    f.live.execute = async (request) => {
      if (!(first && request.role === "worker" && request.outputSchema))
        return execute(request);
      first = false;
      f.live.requests.push(request);
      f.busy.held = true;
      await new Promise<void>((resolve) =>
        request.signal?.aborted
          ? resolve()
          : request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
      );
      f.busy.held = false;
      return {
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: null,
        status: "CANCELLED",
        startedAt: now,
        endedAt: new Date().toISOString(),
        output: "CANCELLED",
        tests: [],
        costUsd: null,
        tokens: null,
        identityVerified: false,
        simulation: false,
      };
    };
    await f.o.drive(f.id, { live: true });
    const lost = f.c
      .inspect("A")
      .attempts.find((a: any) => a.proposalRound)!;
    assert.equal(lost.state, "UNKNOWN");
    assert.equal(lost.interruption.cause, "DATABASE_BUSY");
    assert.equal(round(f).stage, "REPLY_UNRESOLVED");
    stopped(f, lost.id, "stopped-" + lost.id);
    f.c.reconcile(lost.id, "CANCELLED", "stopped-" + lost.id, actor);
    // Interrupted, not failed: the reply is still to come.
    assert.equal(round(f).stage, "AWAITING_REPLY");
    await f.o.drive(f.id, { live: true });
    const replies = f.c
      .inspect("A")
      .attempts.filter((a: any) => a.proposalRound);
    assert.deepEqual(
      replies.map((a: any) => a.state),
      ["CANCELLED", "SUCCEEDED"],
    );
    const again = f.live.requests.filter(
      (r) => r.role === "worker" && r.outputSchema,
    )[1]!;
    assert.match(again.brief, /stopped by the orchestrator because its shared database stayed busy/);
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(round(f).reply?.reviewed, true);
  } finally {
    f.close();
  }
});

// In the legacy behavior the unstarted reply used up the last attempt, so the round
// went on without a reply. Now it uses none , and the reply runs.
test("a reply recovered unstarted on the last attempt uses up no attempt: the work returns to review and the reply still runs", async () => {
  const f = fixture({ reviews: [PROPOSALS] }, { maxAttempts: 2 });
  try {
    await firstReviewOnly(f);
    const actor = f.c.localActor();
    f.c.reserve(
      "A",
      { requestKey: "lost-reply", proposalRound: round(f).reviewRunId },
      actor,
    );
    f.c.recover(actor, Date.now() + 3_600_000);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.deepEqual(f.c.reasons("A"), []);
    await f.o.drive(f.id, { live: true });
    assert.equal(events(f, "PROPOSAL_REPLY_SKIPPED").length, 0);
    assert.ok(roles(f).includes("worker-reply:claude"));
    assert.equal(
      f.c
        .inspect("A")
        .attempts.filter(
          (a: any) => a.role === "worker" && a.state === "SUCCEEDED",
        ).length,
      2,
    );
  } finally {
    f.close();
  }
});

test("after a failed review, a reply recovered unstarted leaves the task needing rework, and the reply still runs", async () => {
  const f = fixture({
    reviews: [
      {
        ...PROPOSALS,
        verdict: "FAIL",
        remediation: ["The greeting must end with a newline."],
      },
    ],
  });
  try {
    await firstReviewOnly(f);
    const actor = f.c.localActor();
    f.c.reserve(
      "A",
      { requestKey: "lost-reply", proposalRound: round(f).reviewRunId },
      actor,
    );
    f.c.recover(actor, Date.now() + 3_600_000);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    await f.o.drive(f.id, { live: true });
    assert.ok(roles(f).includes("worker-reply:claude"));
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
  } finally {
    f.close();
  }
});

test("while a reply is pending, no request runs ordinary work ahead of it", async () => {
  let workerRouteUp = true;
  const f = fixture(
    {
      reviews: [
        {
          ...PROPOSALS,
          verdict: "FAIL",
          remediation: ["The greeting must end with a newline."],
        },
      ],
    },
    {
      maxAttempts: 2,
      attested: (model) => workerRouteUp || model !== "claude-w",
    },
  );
  try {
    await firstReviewOnly(f);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(round(f).stage, "AWAITING_REPLY");
    assert.throws(
      () => f.c.reserve("A", { requestKey: "ordinary" }, f.c.localActor()),
      /PROPOSAL_REPLY_PENDING/,
    );
    // Another request advances the same task while the reply can't run yet.
    workerRouteUp = false;
    const other = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Write a greeting",
      context: { cwd: tmpdir() },
      sourceRef: "test:proposals",
      taskIds: ["A"],
    }).request.id;
    await f.o.drive(other, { live: true });
    assert.deepEqual(roles(f), ["worker:claude", "reviewer:codex"]);
    // It doesn't even try: the reply is the next worker run.
    assert.ok(
      !f.o
        .inspect(other)
        .tasks[0]!.steps.some((s) => s.stage === "WORKER_RESERVATION"),
    );
    // Once it can, the reply uses the remaining attempt.
    workerRouteUp = true;
    await f.o.drive(other, { live: true });
    assert.deepEqual(roles(f).slice(2), [
      "worker-reply:claude",
      "reviewer:codex",
    ]);
    assert.equal(round(f).stage, "SETTLED");
  } finally {
    f.close();
  }
});

test("a moderator run that fails once started waits for reconciliation, then the owner is asked without a recommendation", async () => {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [{ id: "P1", reply: "DECLINE", reason: "No." }],
  });
  try {
    failingModerator(f);
    let view = await f.o.drive(f.id, { live: true });
    assert.equal(round(f).stage, "MODERATOR_UNRESOLVED");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(view.status, "HELD_RECONCILIATION");
    const run = round(f).moderator!.runId!;
    stopped(f, run, "moderator-reconciliation");
    f.c.reconcile(run, "FAILED", "moderator-reconciliation", f.c.localActor());
    view = await f.o.drive(f.id, { live: true });
    assert.equal(round(f).moderator?.usable, false);
    assert.equal(view.questions.length, 2);
    assert.ok(
      view.questions.every((q) =>
        /No moderator recommendation is available\./.test(q.text),
      ),
    );
  } finally {
    f.close();
  }
});

test("reconciling a moderator run doesn't make the only review stale", async () => {
  const f = fixture({ reviews: [PROPOSALS] }, { maxAttempts: 1 });
  try {
    failingModerator(f);
    await f.o.drive(f.id, { live: true });
    assert.equal(round(f).stage, "MODERATOR_UNRESOLVED");
    const actor = f.c.localActor();
    const run = round(f).moderator!.runId!;
    stopped(f, run, "moderator-reconciliation");
    f.c.reconcile(run, "FAILED", "moderator-reconciliation", actor);
    let view = await f.o.drive(f.id, { live: true });
    for (const q of view.questions) answer(f, q.id, "Keep the work as it is");
    const worker = f.c
      .inspect("A")
      .attempts.find((a: any) => a.role === "worker")!;
    f.c.bindAcceptance("A", "greeting", "output-" + worker.id, actor);
    view = await f.o.drive(f.id, { live: true });
    assert.equal(round(f).stage, "SETTLED");
    assert.equal(f.c.task("A").status, "VERIFIED");
    // That evidence can't stand in for acceptance evidence.
    assert.throws(
      () =>
        f.c.bindAcceptance("A", "greeting", "moderator-reconciliation", actor),
      /MODERATOR_RECONCILIATION_IS_NOT_ACCEPTANCE_EVIDENCE/,
    );
  } finally {
    f.close();
  }
});

/**
 * A reply whose moderator run was reconciled, followed by the reply's review
 * and audits, with those records rewritten as the version before the
 * fix wrote them: their evidence digest still counted the reconciliation note.
 */
async function legacyReconciledRound() {
  const f = fixture({
    reviews: [PROPOSALS],
    reply: () => [{ id: "P1", reply: "DECLINE", reason: "No." }],
  });
  failingModerator(f);
  let view = await f.o.drive(f.id, { live: true });
  const run = round(f).moderator!.runId!;
  stopped(f, run, "moderator-reconciliation");
  const actor = f.c.localActor();
  f.c.reconcile(run, "FAILED", "moderator-reconciliation", actor);
  view = await f.o.drive(f.id, { live: true });
  for (const q of view.questions) answer(f, q.id, "Keep the work as it is");
  await f.o.drive(f.id, { live: true });
  assert.equal(round(f).reply?.reviewed, true);
  assert.equal(f.c.inspect("A").audits.length, 3);
  const legacy = digest(
    f.c.evidenceFor("A").map((e) => ({ id: e.id, digest: e.digest })),
  );
  // Plant the old records in this throwaway database only, lifting its
  // append-only rule for the rewrite and restoring it after.
  for (const table of ["reviews", "audits"]) {
    f.c.db.run(`DROP TRIGGER immutable_${table}_update`);
    for (const row of f.c.db.all<{ id: string; body: string }>(
      `SELECT id, body FROM ${table} WHERE task_id='A'`,
    ))
      f.c.db.run(
        `UPDATE ${table} SET body=? WHERE id=?`,
        canonical({ ...JSON.parse(row.body), evidenceDigest: legacy }),
        row.id,
      );
    f.c.db.run(
      `CREATE TRIGGER immutable_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END`,
    );
  }
  const reply = f.c
    .inspect("A")
    .attempts.find((a: any) => a.proposalRound && a.state === "SUCCEEDED")!;
  f.c.bindAcceptance("A", "greeting", "output-" + reply.id, actor);
  return { f, actor };
}

test("reviews and audits recorded before the moderator-evidence fix stay current after it", async () => {
  const { f, actor } = await legacyReconciledRound();
  try {
    f.c.verify("A", actor);
    assert.equal(f.c.task("A").status, "VERIFIED");
  } finally {
    f.close();
  }
});

test("other new evidence still makes those older records stale", async () => {
  const { f, actor } = await legacyReconciledRound();
  try {
    f.c.addEvidence(
      {
        id: "late-note",
        taskId: "A",
        kind: "LOCAL",
        uri: "test:late-note",
        revision: f.c.task("A").artifactRevision,
        digest: digest("late-note"),
        retrievedAt: new Date().toISOString(),
        authorityTier: "IMPLEMENTATION",
        authentication: "LOCAL_IMPORT",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: ["Evidence added after the review"],
        metadata: {},
      },
      actor,
    );
    assert.throws(() => f.c.verify("A", actor), /INDEPENDENT_REVIEW_REQUIRED/);
  } finally {
    f.close();
  }
});

/**
 * Each worker run leaves a host-side Drive gateway record and its sealed copy,
 * as the live runner does; `skip` runs make no Drive calls and leave no log.
 */
function driveRecords(f: Fixture, audit: string, skip = (_runId: string) => false) {
  const inner = f.live.execute.bind(f.live);
  f.live.execute = async (request: ProviderRequest) => {
    const receipt = await inner(request);
    if (request.role !== "worker") return receipt;
    if (!skip(request.runId)) {
      const log =
        JSON.stringify({ op: "update", ok: true, fileId: "docAAAAAAAAAAAAA", run: request.runId }) + "\n";
      mkdirSync(join(audit, request.runId), { recursive: true });
      writeFileSync(join(audit, request.runId, "log.jsonl"), log);
      mkdirSync(join(request.cwd, "drive-changes", request.runId), { recursive: true });
      writeFileSync(join(request.cwd, "drive-changes", request.runId, "log.jsonl"), log);
    }
    const run = JSON.stringify({
      runId: request.runId,
      drive: { auditDir: join(audit, request.runId), writes: [{ op: "update" }] },
    });
    mkdirSync(audit, { recursive: true });
    const runFile = join(audit, "run-" + request.runId + ".json");
    writeFileSync(runFile, run);
    return {
      ...receipt,
      provenance: {
        cliVersion: "1",
        executableDigest: "a".repeat(64),
        isolationEvidenceRef: "test",
        capabilityEvidenceRef: "test",
        identityEvidenceRef: "file:" + runFile + "#sha256=" + digest(run),
        rawStdoutDigest: "b".repeat(64),
        rawStdoutBytes: 1,
      },
    };
  };
}

// Design choice: a proposal reply starts from the first run's sealed
// work, so the first run's Drive edits stay bindable as acceptance evidence
// Require explicit checks for the original request.
/** Task A as a Drive task, its worker runs leaving gateway records. */
function driveFixture(
  skip?: (runId: string) => boolean,
  drive: NonNullable<Task["drive"]> = { read: "ANY", update: ["docAAAAAAAAAAAAA"], createIn: [] },
) {
  const drivePolicy = RoutingPolicySchema.parse({
    ...policy,
    routes: [
      ...policy.routes,
      // Changing Drive documents is COMPLEX work, for the worker and its reviewer.
      route("claude-complex-worker", "COMPLEX", "claude", "claude-w2", "medium", ["worker"]),
      route("codex-complex-reviewer", "COMPLEX", "codex", "codex-r", "medium", ["reviewer"]),
    ],
  });
  const f = fixture({ reviews: [PROPOSALS] }, { policy: drivePolicy });
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  const actor = f.c.localActor();
  const base = f.c.inspect("A").task;
  const driveTask = TaskSchema.parse({
    ...base,
    specVersion: 2,
    dimensions: { ...base.dimensions, authorization: "EXPLICIT" },
    operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
    writePaths: ["output/A", "drive-changes"],
    drive,
    acceptance: [
      ...base.acceptance,
      { id: "drive", description: "Drive change", evidenceKind: "DRIVE" },
    ],
  });
  f.c.revise("A", driveTask, actor);
  f.c.grant(
    "A",
    {
      id: randomUUID(),
      operations: driveTask.operations,
      paths: ["output/A", "drive-changes"],
      decisionText: "test",
      sourceRef: "test",
    },
    actor,
  );
  f.o.rebind(f.id, ["A"]);
  driveRecords(f, audit, skip);
  return {
    f,
    actor,
    audit,
    close: () => (f.close(), rmSync(audit, { recursive: true, force: true })),
  };
}

// Source packs: the host reads the listed files before the
// worker starts; the worker and its reviewer are told where they are.
test("a Drive task's source pack reaches the worker's request, and both briefs name its folder", async () => {
  const pack = ["packAAAAAAAAAAAA", "docAAAAAAAAAAAAA"];
  const { f, close } = driveFixture(undefined, {
    read: "ANY",
    update: ["docAAAAAAAAAAAAA"],
    createIn: [],
    pack,
  });
  try {
    await firstReviewOnly(f);
    const worker = f.live.requests.find((r) => r.role === "worker")!;
    assert.deepEqual(worker.drivePolicy?.pack, pack);
    assert.ok(
      worker.brief.includes("SOURCE PACK: before you started, the host read the 2 files"),
    );
    assert.ok(worker.brief.includes("drive-changes/" + worker.runId + "/pack/"));
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    assert.ok(reviewer.brief.includes("drive-changes/" + worker.runId + "/pack/"));
    assert.ok(reviewer.brief.includes('records each as op "pack"'));
    // This reviewer is Codex, which gets no Drive;
    // a Claude reviewer or advisor may read it (see the advisor tests).
    assert.equal(reviewer.provider, "codex");
    assert.equal(reviewer.drivePolicy, undefined);
    assert.ok(!reviewer.brief.includes("You can also read Google Drive"));
    for (const r of f.live.requests)
      if (!["worker", "reviewer", "advisor"].includes(r.role))
        assert.equal(r.drivePolicy, undefined, r.role);
  } finally {
    close();
  }
});

test("a Drive task without a pack keeps its briefs and request", async () => {
  const { f, close } = driveFixture();
  try {
    assert.equal("pack" in f.c.task("A").drive!, false);
    await firstReviewOnly(f);
    for (const r of f.live.requests) assert.ok(!r.brief.includes("/pack/"));
    // Its Codex reviewer gets no Drive.
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    assert.equal(reviewer.drivePolicy, undefined);
    assert.equal(f.live.requests.find((r) => r.role === "worker")!.drivePolicy!.pack, undefined);
  } finally {
    close();
  }
});

test("after a proposal reply, the first run's Drive record still counts as acceptance evidence", async () => {
  const { f, actor, close } = driveFixture();
  try {
    await firstReviewOnly(f);
    const first = f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!;
    // Recorded while the first run is the current work.
    const e = f.c.recordDriveEvidence("A", actor);
    assert.equal(e.metadata.runId, first.id);
    // The worker replies to the proposals in one more run, from the sealed work.
    await f.o.drive(f.id, { live: true });
    assert.ok(roles(f).includes("worker-reply:claude"));
    const reply = f.c
      .inspect("A")
      .attempts.filter((a: any) => a.role === "worker" && a.state === "SUCCEEDED")
      .at(-1)!;
    assert.notEqual(reply.id, first.id);
    // The first run's record still binds: the reply's sealed work carries it unchanged.
    f.c.bindAcceptance("A", "drive", e.id, actor);
    // The reply's own record can be recorded too.
    assert.equal(f.c.recordDriveEvidence("A", actor).metadata.runId, reply.id);
    assert.throws(() => f.c.recordDriveEvidence("A", actor, first.id), /ALREADY_RECORDED/);
    assert.throws(
      () => f.c.recordDriveEvidence("A", actor, "no-such-run"),
      /NOT_A_SUCCESSFUL_WORKER_OF_CURRENT_SPEC/,
    );
  } finally {
    close();
  }
});

test("an earlier run's Drive record counts only when the current work carries it", async () => {
  // The first run makes no Drive calls, so its sealed work has no record.
  let workers = 0;
  const { f, actor, close } = driveFixture(() => workers++ === 0);
  try {
    await firstReviewOnly(f);
    const first = f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!;
    await f.o.drive(f.id, { live: true });
    assert.ok(roles(f).includes("worker-reply:claude"));
    assert.throws(
      () => f.c.recordDriveEvidence("A", actor, first.id),
      /DRIVE_RECORD_NOT_IN_CURRENT_WORK/,
    );
  } finally {
    close();
  }
});

test("a worker run that never started is made again under a fresh key, and doesn't leave the request stuck", async () => {
  const f = fixture({ reviews: [{}] });
  try {
    const actor = f.c.localActor();
    const baseKey =
      "workflow:" +
      digest({ requestId: f.id, taskId: "A", spec: specDigest(f.c.task("A")), role: "worker" });
    f.c.reserve("A", { requestKey: baseKey }, actor);
    f.c.recover(actor, Date.now() + 3_600_000);
    assert.equal(f.c.inspect("A").attempts[0].state, "NOT_STARTED");
    await f.o.drive(f.id, { live: true });
    const workers = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker");
    assert.equal(workers.length, 2);
    assert.equal(workers[1].requestKey, baseKey + ":retry:1");
    assert.equal(workers[1].state, "SUCCEEDED");
  } finally {
    f.close();
  }
});

// Review r1 finding R3 (source packs): a worker refused before
// launch did nothing, so it uses no attempt and the earlier work stays current.
test("a worker refused before launch uses no attempt, shows why, and runs on the next advance", async () => {
  const f = fixture({}, { maxAttempts: 1 });
  try {
    let refusals = 1;
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      if (request.role === "worker" && refusals-- > 0)
        return {
          runId: request.runId,
          taskId: request.taskId,
          provider: request.provider,
          model: request.model,
          effort: request.effort,
          sessionId: randomUUID(),
          exitCode: null,
          status: "FAILED",
          startedAt: now,
          endedAt: new Date().toISOString(),
          output: "DRIVE_PACK_FAILED: Error: DRIVE_HTTP_503: try later",
          tests: [],
          costUsd: 0,
          tokens: 0,
          identityVerified: false,
          simulation: false,
          notLaunched: true,
        };
      return inner(request);
    };
    const held = await f.o.drive(f.id, { live: true });
    const refused = f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!;
    assert.equal(refused.state, "NOT_STARTED");
    assert.equal(f.c.task("A").status, "BLOCKED");
    assert.ok(!f.c.reasons("A").includes("ATTEMPT_BUDGET_EXHAUSTED"));
    assert.ok(
      held.tasks[0]!.holds.some((h) => h.startsWith("WORKER_NOT_LAUNCHED:DRIVE_PACK_FAILED")),
      held.tasks[0]!.holds.join(),
    );
    // With its only attempt unused, the next advance runs the worker and its review.
    const next = await f.o.drive(f.id, { live: true });
    assert.ok(!next.tasks[0]!.holds.some((h) => h.startsWith("WORKER_NOT_LAUNCHED")));
    assert.deepEqual(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").map((a: any) => a.state),
      ["NOT_STARTED", "SUCCEEDED"],
    );
    assert.ok(roles(f).includes("reviewer:codex"));
  } finally {
    f.close();
  }
});

test("a rework refused before launch leaves the faulted work current and its review pending", async () => {
  const f = fixture({ reviews: [{ verdict: "FAIL", remediation: ["End with a newline."] }] }, { maxAttempts: 3 });
  try {
    await firstReviewOnly(f);
    const sealed = f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!;
    const review = f.c.reworkPending("A")!;
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) =>
      request.role === "worker"
        ? {
            runId: request.runId,
            taskId: request.taskId,
            provider: request.provider,
            model: request.model,
            effort: request.effort,
            sessionId: randomUUID(),
            exitCode: null,
            status: "FAILED",
            startedAt: now,
            endedAt: new Date().toISOString(),
            output: "DRIVE_PACK_FAILED: Error: OUTSIDE_TASK_DRIVE_SCOPE",
            tests: [],
            costUsd: 0,
            tokens: 0,
            identityVerified: false,
            simulation: false,
            notLaunched: true,
          }
        : inner(request);
    await (f.o as any).worker(f.id, "A", true);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(f.c.reworkPending("A")!.reviewRunId, review.reviewRunId);
    assert.equal(f.c.reworkPending("A")!.workerRunId, sealed.id);
  } finally {
    f.close();
  }
});

test("a proposal reply refused before launch shows why, keeps the round awaiting it, and runs next time", async () => {
  const f = fixture({ reviews: [PROPOSALS] });
  try {
    let refusals = 1;
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) =>
      request.role === "worker" && request.outputSchema && refusals-- > 0
        ? {
            runId: request.runId,
            taskId: request.taskId,
            provider: request.provider,
            model: request.model,
            effort: request.effort,
            sessionId: randomUUID(),
            exitCode: null,
            status: "FAILED",
            startedAt: now,
            endedAt: new Date().toISOString(),
            output: "DRIVE_PACK_FAILED: Error: DRIVE_HTTP_503",
            tests: [],
            costUsd: 0,
            tokens: 0,
            identityVerified: false,
            simulation: false,
            notLaunched: true,
          }
        : inner(request);
    const held = await f.o.drive(f.id, { live: true });
    const reply = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.equal(reply.state, "NOT_STARTED");
    assert.equal(round(f).stage, "AWAITING_REPLY");
    assert.ok(
      held.tasks[0]!.holds.some((h) => h.startsWith("WORKER_NOT_LAUNCHED:DRIVE_PACK_FAILED")),
      held.tasks[0]!.holds.join(),
    );
    await f.o.drive(f.id, { live: true });
    assert.notEqual(round(f).stage, "AWAITING_REPLY");
    // The refused run never reached the provider; the second one ran.
    assert.equal(roles(f).filter((r) => r === "worker-reply:claude").length, 1);
    assert.deepEqual(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").map((a: any) => a.state),
      ["SUCCEEDED", "NOT_STARTED", "SUCCEEDED"],
    );
  } finally {
    f.close();
  }
});

test("a worker cancelled or timed out before launch uses no attempt; one the operator cancelled stays cancelled (review r2 R5)", async () => {
  for (const status of ["CANCELLED", "TIMED_OUT"] as const) {
    const f = fixture({}, { maxAttempts: 1 });
    try {
      let first = true;
      const inner = f.live.execute.bind(f.live);
      f.live.execute = async (request: ProviderRequest) => {
        if (request.role === "worker" && first) {
          first = false;
          return {
            runId: request.runId,
            taskId: request.taskId,
            provider: request.provider,
            model: request.model,
            effort: request.effort,
            sessionId: randomUUID(),
            exitCode: null,
            status,
            startedAt: now,
            endedAt: new Date().toISOString(),
            output: "CANCELLED_BEFORE_LAUNCH",
            tests: [],
            costUsd: 0,
            tokens: 0,
            identityVerified: false,
            simulation: false,
            notLaunched: true,
          };
        }
        return inner(request);
      };
      await f.o.drive(f.id, { live: true });
      assert.equal(f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!.state, "NOT_STARTED", status);
      assert.ok(!f.c.reasons("A").includes("ATTEMPT_BUDGET_EXHAUSTED"));
      await f.o.drive(f.id, { live: true });
      assert.ok(roles(f).includes("reviewer:codex"), status);
    } finally {
      f.close();
    }
  }
  for (const status of ["CANCELLED", "FAILED"] as const) {
  const f = fixture({}, { maxAttempts: 1 });
  try {
    const actor = f.c.localActor();
    f.live.execute = async (request: ProviderRequest) => {
      // The operator cancels the run while it is being prepared; it then ends
      // cancelled, or fails its pre-launch check (review r3 R8).
      f.c.cancel(request.runId, actor);
      return {
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: null,
        status,
        startedAt: now,
        endedAt: new Date().toISOString(),
        output: "CANCELLED_BEFORE_LAUNCH",
        tests: [],
        costUsd: 0,
        tokens: 0,
        identityVerified: false,
        simulation: false,
        notLaunched: true,
      };
    };
    await f.o.drive(f.id, { live: true });
    // The run keeps its outcome; nothing starts it again on its own.
    assert.equal(f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!.state, status);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").length, 1);
  } finally {
    f.close();
  }
  }
});

test("Drive evidence binds only while the sealed work carries the run's whole host record (review r2 R6)", async () => {
  const { f, actor, audit, close } = driveFixture();
  try {
    await firstReviewOnly(f);
    const first = f.c.inspect("A").attempts.find((a: any) => a.role === "worker")!;
    // The host record also holds a pack file that the sealed copy lacks.
    mkdirSync(join(audit, first.id, "pack"), { recursive: true });
    writeFileSync(join(audit, first.id, "pack", "docAAAAAAAAAAAAA.md"), "the host's source\n");
    assert.throws(
      () => f.c.recordDriveEvidence("A", actor),
      /DRIVE_RECORD_DIFFERS_FROM_SEALED_WORKSPACE_COPY: changed pack\/docAAAAAAAAAAAAA\.md/,
    );
  } finally {
    close();
  }
});
