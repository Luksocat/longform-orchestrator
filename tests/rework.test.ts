import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller, fitReview } from "../src/controller.js";
import { canonical, TaskSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  MAX_BRIEF_CHARS,
  type ProviderAdapter,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";
import { RoutingPolicySchema } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

// Rework in place after a failed review : the worker
// gets the review and its own sealed work back, instead of a redo from an
// empty folder under a revised specification.

const now = new Date().toISOString();
const route = (
  id: string,
  level: string,
  provider: "claude" | "codex",
  model: string,
  effort: string,
  role: "worker" | "reviewer",
) => ({
  id,
  level,
  provider,
  model,
  effort,
  roles: [role],
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
  id: "rework-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-low", "low", "worker"),
    route("claude-standard", "STANDARD", "claude", "claude-mid", "medium", "worker"),
    route("claude-complex", "COMPLEX", "claude", "claude-high", "high", "worker"),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", "reviewer"),
    // For work done by Codex: its own worker tiers and a Claude reviewer.
    route("codex-routine", "ROUTINE", "codex", "codex-low", "low", "worker"),
    route("codex-standard-worker", "STANDARD", "codex", "codex-mid", "medium", "worker"),
    route("claude-reviewer", "STANDARD", "claude", "claude-r", "medium", "reviewer"),
  ],
});

type AdapterOptions = {
  /** The worker reproduces the same bytes every run. */
  sameBytes?: boolean;
  /** A failed review carries 30 must-fix items and findings of 2,000 characters each. */
  hugeReview?: boolean;
  /** A failed review carries this many short must-fix items. */
  remediationCount?: number;
  /** A failed review carries exactly these must-fix items. */
  remediationText?: string[];
  /** The worker's summary is longer than the brief keeps of it. */
  hugeSummary?: boolean;
};
/** Scripted live-shaped adapter: a worker that writes, reviewers with scripted verdicts. */
function adapter(verdicts: ("FAIL" | "PASS")[], options: AdapterOptions = {}) {
  const { sameBytes = false, hugeReview = false, hugeSummary = false } = options;
  const remediationCount = options.remediationCount ?? (hugeReview ? 30 : 1);
  const self = {
    requests: [] as ProviderRequest[],
    /** Whether each worker run found the earlier work in its directory. */
    foundEarlierWork: [] as boolean[],
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      self.requests.push(request);
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
      if (request.role === "worker") {
        const file = join(request.cwd, "output", "A", "hello.txt");
        self.foundEarlierWork.push(existsSync(file));
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(
          file,
          sameBytes ? "hello\n" : "hello " + self.foundEarlierWork.length + "\n",
        );
        return receipt(
          "wrote output/A/hello.txt" + (hugeSummary ? " " + "s".repeat(40_000) : ""),
        );
      }
      const verdict =
        verdicts[
          self.requests.filter((r) => r.role === "reviewer").length - 1
        ] ?? "PASS";
      const p = (request.outputSchema as { properties: Record<string, any> })
        .properties;
      const ev: string[] = p.availableEvidence.items.enum;
      return receipt(
        canonical({
          taskId: p.taskId.enum[0],
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: p.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings:
            verdict === "FAIL"
              ? Array.from({ length: hugeReview ? 30 : 1 }, (_, i) => ({
                  materiality: "MAJOR",
                  evidenceIds: [],
                  description:
                    "wrong greeting" + (hugeReview ? " " + i + " " + "f".repeat(1_980) : ""),
                }))
              : [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation:
            verdict === "FAIL"
              ? options.remediationText ??
                Array.from({ length: remediationCount }, (_, i) =>
                  "fix the greeting" +
                  (remediationCount > 1 ? " " + i : "") +
                  (hugeReview ? " " + "r".repeat(1_980) : ""),
                )
              : [],
          residualHolds: [],
          verdict,
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
          ...(p.proposals ? { proposals: [] } : {}),
        }),
      );
    },
  };
  return self as ProviderAdapter & typeof self;
}

function fixture(
  verdicts: ("FAIL" | "PASS")[],
  options: AdapterOptions & {
    maxAttempts?: number;
    maxCostUsd?: number;
    reviewRequired?: boolean;
    /** The task's scope text (the brief carries it whole). */
    scope?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-rework-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: () => true,
  });
  const live = adapter(verdicts, options);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:rework",
  });
  const source = o.ownerSource(request.request.id);
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
        reviewPolicy: {
          required: options.reviewRequired ?? true,
          crossProvider: true,
          independentAudits: false,
        },
        acceptance: [
          { id: "greeting", description: "greeting", evidenceKind: "LOCAL" },
        ],
        simulation: false,
        budget: {
          deadlineMs: 60_000,
          maxAttempts: options.maxAttempts ?? 5,
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
      sourceRef: "test:rework",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
type Fixture = ReturnType<typeof fixture>;
const workers = (f: Fixture) =>
  f.c.inspect("A").attempts.filter((a: any) => a.role === "worker");
const reviewers = (f: Fixture) =>
  f.c.inspect("A").attempts.filter((a: any) => a.role === "reviewer");
const verdicts = (f: Fixture) =>
  f.c.inspect("A").reviews.map((r: { verdict: string }) => r.verdict);

test("after a failed review the worker fixes its work in place, with the review in hand, and the rework gets its own review", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    // Before any run, a real task on a live setup is advanced live, not in mock mode.
    const ready = f.o.inspect(f.id);
    assert.equal(ready.status, "READY_TO_ADVANCE");
    assert.deepEqual(ready.nextSteps, [
      `Advance the real tasks on the isolated live runner: orchestrate --request-id ${f.id} --advance --live --execute.`,
    ]);
    let view = await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    const firstReview = reviewers(f)[0];
    const pending = f.c.reworkPending("A")!;
    assert.equal(pending.reviewRunId, firstReview.id);
    assert.deepEqual(pending.mustFix, ["fix the greeting"]);
    assert.equal(pending.verdict, "FAIL");
    // The request shows the rework as more to advance, not as a hold.
    assert.equal(view.status, "READY_TO_ADVANCE");
    assert.deepEqual(view.tasks[0]!.rework, {
      reviewId: pending.reviewId,
      reviewRunId: firstReview.id,
      verdict: "FAIL",
      mustFix: ["fix the greeting"],
    });
    assert.match(view.nextSteps.join(" "), /fixes them in place/);

    view = await f.o.drive(f.id, { live: true });
    const [first, rework] = workers(f);
    assert.equal(workers(f).length, 2);
    assert.equal(rework.rework, firstReview.id);
    assert.equal(first.rework, undefined);
    // The rework starts from the sealed work, not an empty folder, and the
    // review is in its brief; no specification revision was needed.
    assert.deepEqual(f.live.foundEarlierWork, [false, true]);
    const briefs = f.live.requests.filter((r) => r.role === "worker");
    assert.match(briefs[1]!.brief, /Fix your work in place/);
    assert.match(briefs[1]!.brief, /"mustFix":\["fix the greeting"\]/);
    assert.match(briefs[1]!.brief, /wrong greeting/);
    assert.equal(briefs[1]!.outputSchema, undefined);
    assert.equal(f.c.task("A").specVersion, 1);
    // Its review is told what to check, and is not offered proposals.
    const reviews = f.live.requests.filter((r) => r.role === "reviewer");
    assert.equal(reviews.length, 2);
    assert.match(reviews[1]!.brief, /REWORK REVIEW/);
    assert.match(reviews[1]!.brief, /fix the greeting/);
    assert.doesNotMatch(reviews[1]!.brief, /review as a collaborator/);
    assert.equal(
      (reviews[1]!.outputSchema as any).properties.proposals,
      undefined,
    );
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
    assert.equal(f.c.reworkPending("A"), undefined);
    assert.notEqual(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(view.tasks[0]!.rework, undefined);
    // The record names the rework.
    const reserved = f.c.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='ATTEMPT_RESERVED' ORDER BY seq",
      )
      .map((row) => JSON.parse(row.body));
    assert.equal(reserved.find((e) => e.id === rework.id).rework, firstReview.id);
  } finally {
    f.close();
  }
});

test("two failed reviews at one tier move the rework up a tier; the reviewer tier follows the stakes, not the worker", async () => {
  const f = fixture(["FAIL", "FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    const next = f.c.route("A");
    assert.equal(next.assessment.level, "STANDARD");
    assert.ok(
      next.assessment.reasons.some((r) =>
        r.startsWith("ESCALATED ROUTINE -> STANDARD"),
      ),
    );
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      f.live.requests.filter((r) => r.role === "worker").map((r) => r.model),
      ["claude-low", "claude-low", "claude-mid"],
    );
    assert.deepEqual(verdicts(f), ["FAIL", "FAIL", "PASS"]);
    assert.ok(
      f.live.requests
        .filter((r) => r.role === "reviewer")
        .every((r) => r.model === "codex-r"),
    );
    // Each rework answers the review before it.
    const [, second, third] = workers(f);
    const [r1, r2] = reviewers(f);
    assert.equal(second.rework, r1.id);
    assert.equal(third.rework, r2.id);
    assert.deepEqual(f.live.foundEarlierWork, [false, true, true]);
  } finally {
    f.close();
  }
});

test("a rework is reserved once per failed review, by the worker's provider, and never for a review that isn't the latest", async () => {
  const f = fixture(["FAIL", "FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    const r1 = reviewers(f)[0];
    const actor = f.c.localActor();
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: randomUUID(), role: "reviewer", rework: r1.id },
          actor,
        ),
      /REWORK_ONLY_FOR_WORKER/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: randomUUID(), rework: "no-such-review" },
          actor,
        ),
      /REWORK_NOT_PENDING/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          {
            requestKey: randomUUID(),
            provider: "codex",
            model: "codex-w",
            effort: "low",
            rework: r1.id,
          },
          actor,
        ),
      /REWORK_PROVIDER_MISMATCH/,
    );
    // Advancing twice before the rework is reviewed reserves no second rework.
    await f.o.drive(f.id, { live: true });
    const r2 = reviewers(f)[1];
    assert.equal(f.c.reworkPending("A")!.reviewRunId, r2.id);
    assert.throws(
      () =>
        f.c.reserve("A", { requestKey: randomUUID(), rework: r1.id }, actor),
      /REWORK_NOT_PENDING/,
    );
    assert.equal(workers(f).length, 2);
  } finally {
    f.close();
  }
});

test("a revised specification ends the pending rework: the old path of revise, regrant and rebind still works", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    assert.ok(f.c.reworkPending("A"));
    const actor = f.c.localActor();
    const t = f.c.task("A");
    f.c.revise(
      "A",
      { ...t, scope: t.scope + ". Fix it.", specVersion: 2 },
      actor,
    );
    assert.equal(f.c.reworkPending("A"), undefined);
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "test",
        sourceRef: "test:rework",
      },
      actor,
    );
    f.o.rebind(f.id, ["A"]);
    await f.o.drive(f.id, { live: true });
    // The new run is ordinary work from an empty folder, reviewed afresh.
    assert.deepEqual(f.live.foundEarlierWork, [false, false]);
    assert.equal(workers(f)[1].rework, undefined);
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("an ordinary worker reservation after a failed review is the rework: it starts from the sealed work", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    const r1 = reviewers(f)[0];
    // No `rework` named: the controller derives it, so nothing can start over
    // from an empty folder without the review .
    const a = f.c.reserve("A", { requestKey: randomUUID() }, f.c.localActor());
    assert.equal(a.rework, r1.id);
    assert.ok(existsSync(join(a.workspace, "output", "A", "hello.txt")));
    assert.equal(f.c.reworkPending("A"), undefined, "the rework is active");
  } finally {
    f.close();
  }
});

test("a status change alone never turns the pending rework into fresh work", async () => {
  // Identical bytes, so only the record of the rework itself can say the
  // review was answered.
  const f = fixture(["FAIL", "PASS"], { sameBytes: true });
  try {
    await f.o.drive(f.id, { live: true });
    const r1 = reviewers(f)[0];
    const actor = f.c.localActor();
    // An operator moves the task on without revising it .
    f.c.transition("A", "READY", actor);
    assert.equal(f.c.task("A").status, "READY");
    assert.equal(f.c.reworkPending("A")!.reviewRunId, r1.id);
    const a = f.c.reserve("A", { requestKey: randomUUID() }, actor);
    assert.equal(a.rework, r1.id);
    assert.ok(existsSync(join(a.workspace, "output", "A", "hello.txt")));
    // Once the rework has run, that review is answered, whatever the bytes.
    await f.c.execute(a, f.live, actor);
    f.c.transition("A", "BLOCKED", actor);
    assert.equal(f.c.reworkPending("A"), undefined);
  } finally {
    f.close();
  }
});

test("a rework that never started is recovered as still pending, and the next advance reserves it again", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    const r1 = reviewers(f)[0];
    const actor = f.c.localActor();
    const a = f.c.reserve("A", { requestKey: randomUUID(), rework: r1.id }, actor);
    // The lease expires before the run starts .
    const recovered = f.c.recover(actor, Date.now() + 10 * 60_000);
    assert.deepEqual(recovered, [{ runId: a.id, outcome: "DEFINITELY_NOT_STARTED" }]);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(f.c.reworkPending("A")!.reviewRunId, r1.id);
    await f.o.drive(f.id, { live: true });
    const started = workers(f).filter((w: any) => w.state === "SUCCEEDED");
    assert.equal(started.length, 2);
    assert.equal(started[1].rework, r1.id);
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("an older failing report is not accepted as the review of a rework that changed no bytes", async () => {
  const f = fixture(["FAIL", "PASS"], { sameBytes: true });
  try {
    await f.o.drive(f.id, { live: true });
    const actor = f.c.localActor();
    const r1 = reviewers(f)[0];
    const stored = f.c.inspect("A").reviews[0];
    // The rework reproduces the bytes exactly, so the old report still matches them.
    const rework = f.c.reserve("A", { requestKey: randomUUID() }, actor);
    await f.c.execute(rework, f.live, actor);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(rework.rework, r1.id);
    const { independence, simulation, at, workspaceDigest, evidenceDigest, ...report } = stored;
    assert.throws(
      () => f.c.review({ ...report, id: "again-" + randomUUID() }, actor),
      /REVIEW_RUN_NOT_OF_CURRENT_ARTIFACT/,
    );
    // The genuine review of the rework still happens on the next advance.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("a rework is reviewed before sign-off even when the task does not require review", async () => {
  const f = fixture(["FAIL", "PASS"], { reviewRequired: false });
  try {
    await f.o.drive(f.id, { live: true });
    const actor = f.c.localActor();
    const rework = f.c.reserve("A", { requestKey: randomUUID() }, actor);
    await f.c.execute(rework, f.live, actor);
    f.c.bindAcceptance("A", "greeting", "output-" + rework.id, actor);
    assert.throws(() => f.c.verify("A", actor), /REWORK_REVIEW_REQUIRED/);
  } finally {
    f.close();
  }
});

test("a rework stays with a hand-picked provider through its execution checks", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    const actor = f.c.localActor();
    // The first worker was chosen by hand: Codex, the task's second provider.
    const first = f.c.reserve(
      "A",
      { requestKey: randomUUID(), provider: "codex", model: "codex-low", effort: "low", overrideReason: "test" },
      actor,
    );
    await f.c.execute(first, f.live, actor);
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(verdicts(f), ["FAIL"]);
    assert.equal(reviewers(f)[0].provider, "claude");
    await f.o.drive(f.id, { live: true });
    const rework = workers(f)[1];
    assert.equal(rework.provider, "codex");
    assert.equal(rework.model, "codex-low");
    assert.equal(rework.state, "SUCCEEDED", JSON.stringify(f.o.inspect(f.id).tasks[0]!.steps));
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("a spending budget used up exactly leaves no room for a rework", async () => {
  const f = fixture(["FAIL", "PASS"], { maxCostUsd: 0.02 });
  try {
    await f.o.drive(f.id, { live: true });
    assert.ok(f.c.reworkPending("A"));
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(workers(f).length, 1);
    assert.ok(
      view.tasks[0]!.steps.some(
        (s) =>
          s.stage === "WORKER_RESERVATION" &&
          s.outcome === "HELD" &&
          /EXECUTION_BUDGET_EXHAUSTED/.test(s.detail),
      ),
      JSON.stringify(view.tasks[0]!.steps),
    );
  } finally {
    f.close();
  }
});

test("a rework review always carries the review it answers, however long that review and the worker's summary are", async () => {
  const f = fixture(["FAIL", "PASS"], { hugeReview: true, hugeSummary: true });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const reviews = f.live.requests.filter((r) => r.role === "reviewer");
    assert.equal(reviews.length, 2);
    for (const r of reviews) assert.ok(r.brief.length <= MAX_BRIEF_CHARS, String(r.brief.length));
    const second = reviews[1]!.brief;
    assert.match(second, /REWORK REVIEW/);
    assert.match(second, /EARLIER REVIEW \(JSON/);
    // The earlier review is shortened, never dropped, and every must-fix item is still named.
    assert.match(second, /fix the greeting 0 /);
    assert.match(second, /fix the greeting 29 /);
    assert.match(second, /WORKER SUMMARY \(untrusted\):\nwrote output\/A\/hello.txt/);
    assert.deepEqual(verdicts(f), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("every must-fix item reaches the rework and its review, however many there are", async () => {
  const f = fixture(["FAIL", "PASS"], { remediationCount: 31 });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const rework = f.live.requests.filter((r) => r.role === "worker")[1]!.brief;
    const review = f.live.requests.filter((r) => r.role === "reviewer")[1]!.brief;
    for (const brief of [rework, review]) {
      assert.match(brief, /fix the greeting 0"/);
      assert.match(brief, /fix the greeting 30"/);
      assert.doesNotMatch(brief, /mustFixOmitted/);
    }
  } finally {
    f.close();
  }
});

test("briefs stay within the provider's limit even when the task record is huge, and one that cannot fit fails before the run starts", async () => {
  // A task record that leaves little room: the review is shortened, then its
  // items are dropped with a note, then the summary gives way.
  const big = fixture(["FAIL", "PASS"], {
    scope: "g".repeat(100_000),
    hugeReview: true,
    hugeSummary: true,
  });
  try {
    await big.o.drive(big.id, { live: true });
    await big.o.drive(big.id, { live: true });
    const requests = big.live.requests;
    assert.equal(requests.filter((r) => r.role === "reviewer").length, 2);
    for (const r of requests) assert.ok(r.brief.length <= MAX_BRIEF_CHARS, `${r.role} ${r.brief.length}`);
    const rework = requests.filter((r) => r.role === "worker")[1]!.brief;
    const review = requests.filter((r) => r.role === "reviewer")[1]!.brief;
    assert.match(rework, /Fix your work in place/);
    assert.match(rework, /fix the greeting 0 /);
    assert.match(review, /REWORK REVIEW/);
    assert.match(review, /fix the greeting 0 /);
    assert.deepEqual(verdicts(big), ["FAIL", "PASS"]);
  } finally {
    big.close();
  }
  // A record the brief cannot carry at all: the run is refused before it is
  // reserved, so nothing is spent, no attempt is used and no reservation is
  // left waiting on a run that could never start.
  const over = fixture(["PASS"], { scope: "g".repeat(MAX_BRIEF_CHARS) });
  try {
    const view = await over.o.drive(over.id, { live: true });
    assert.deepEqual(over.live.requests, []);
    assert.deepEqual(over.c.inspect("A").attempts, []);
    assert.deepEqual(view.tasks[0]!.unresolvedRuns, []);
    assert.notEqual(view.status, "RUNNING_OR_RECOVERY_REQUIRED");
    assert.ok(
      view.tasks[0]!.steps.some(
        (s) => s.stage === "WORKER_RESERVATION" && /BRIEF_EXCEEDS_PROVIDER_LIMIT/.test(s.detail),
      ),
      JSON.stringify(view.tasks[0]!.steps),
    );
  } finally {
    over.close();
  }
});

test("a rework review never loses the review it answers: whole, shortened, reduced to a note, or the run is refused before it starts", async () => {
  // Measure the reviewer brief's fixed overhead with a tiny task.
  const probe = fixture(["PASS"]);
  let overhead: number;
  try {
    await probe.o.drive(probe.id, { live: true });
    const r = probe.live.requests.find((x) => x.role === "reviewer")!;
    overhead = r.brief.length - "greeting".length - "wrote output/A/hello.txt".length;
  } finally {
    probe.close();
  }
  // About 5,000 characters left after the task record: the 30-item review is
  // reduced to what fits plus a note of what is left out; a summary follows.
  const tight = fixture(["FAIL", "PASS"], {
    scope: "g".repeat(MAX_BRIEF_CHARS - overhead - 24 - 5_000),
    hugeReview: true,
    hugeSummary: true,
  });
  try {
    await tight.o.drive(tight.id, { live: true });
    await tight.o.drive(tight.id, { live: true });
    const reviews = tight.live.requests.filter((r) => r.role === "reviewer");
    assert.equal(reviews.length, 2, JSON.stringify(tight.o.inspect(tight.id).tasks[0]!.steps));
    const second = reviews[1]!.brief;
    assert.ok(second.length <= MAX_BRIEF_CHARS, String(second.length));
    assert.match(second, /REWORK REVIEW/);
    assert.match(second, /"mustFixOmitted":\d+/);
    assert.match(second, /holds it all/);
    assert.match(second, /WORKER SUMMARY \(untrusted\):\n/);
    assert.deepEqual(verdicts(tight), ["FAIL", "PASS"]);
  } finally {
    tight.close();
  }
  // The first review barely fits : the rework
  // review still carries the review it answers, at least as the note, the
  // summary gives way, and no run is left started or unknown.
  const tightest = fixture(["FAIL", "PASS"], {
    scope: "g".repeat(MAX_BRIEF_CHARS - overhead - 24 - 100),
    hugeSummary: true,
  });
  try {
    await tightest.o.drive(tightest.id, { live: true });
    await tightest.o.drive(tightest.id, { live: true });
    const requests = tightest.live.requests;
    assert.ok(requests.every((r) => r.brief.length <= MAX_BRIEF_CHARS));
    const reviews = requests.filter((r) => r.role === "reviewer");
    assert.equal(reviews.length, 2, JSON.stringify(tightest.o.inspect(tightest.id).tasks[0]!.steps));
    assert.match(reviews[1]!.brief, /REWORK REVIEW/);
    assert.match(reviews[1]!.brief, /"mustFix":\["fix the greeting"\]|"mustFixOmitted":1/);
    for (const a of tightest.c.inspect("A").attempts)
      assert.ok(!["STARTED", "UNKNOWN"].includes(a.state), a.state);
    assert.deepEqual(verdicts(tightest), ["FAIL", "PASS"]);
  } finally {
    tightest.close();
  }
});

test("the earlier review is carried whole when it fits, and every shortening is disclosed", async () => {
  // A must-fix item longer than any cut, with its requirement at the end.
  const entry = "Rewrite the greeting. " + "x".repeat(2_000) + " It must end with a newline.";
  const f = fixture(["FAIL", "PASS"], { remediationText: [entry] });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const rework = f.live.requests.filter((r) => r.role === "worker")[1]!.brief;
    const review = f.live.requests.filter((r) => r.role === "reviewer")[1]!.brief;
    for (const brief of [rework, review]) {
      assert.match(brief, /It must end with a newline\./);
      assert.doesNotMatch(brief, /does not carry the whole review/);
    }
  } finally {
    f.close();
  }
  // The fitting itself: whole first; then cuts, each disclosed; a FAIL with
  // findings only still says what it leaves out; nothing fits, nothing is faked.
  const base = {
    id: "review-1",
    taskId: "A",
    runId: "run-1",
    artifactRevision: "r1",
    specDigest: "s",
    reviewerSession: "x",
    provider: "codex" as const,
    authorshipDisclosure: "separate",
    availableEvidence: [],
    testsExecuted: [],
    testsNotExecuted: [],
    conflictingEvidence: [],
    residualHolds: [],
    verdict: "FAIL" as const,
    scope: "t",
    nextAuthorizedStep: "rework",
    auditAssessments: [],
  };
  const long = { ...base, remediation: [entry], findings: [] } as any;
  assert.equal(JSON.parse(fitReview(long, 120_000)!).mustFix[0], entry);
  const shortened = JSON.parse(fitReview(long, 1_400)!);
  assert.equal(shortened.mustFix[0].length, 1_000);
  assert.match(shortened.note, /1 must-fix items shortened/);
  assert.match(shortened.note, /recorded review review-1 holds it all/);
  const findingsOnly = {
    ...base,
    remediation: [],
    findings: [{ materiality: "MAJOR", evidenceIds: [], description: "d".repeat(3_000) }],
  } as any;
  const tiny = JSON.parse(fitReview(findingsOnly, 280)!);
  assert.deepEqual(tiny.mustFix, []);
  assert.match(tiny.note, /1 findings left out/);
  assert.match(tiny.note, /review-1/);
  assert.equal(fitReview(findingsOnly, 50), undefined);
  // A FAIL explained only by what the reviewer could not verify keeps that
  // explanation, or discloses its loss .
  const holdsOnly = {
    ...base,
    remediation: [],
    findings: [],
    residualHolds: ["Confirm the file's folder"],
  } as any;
  const kept = JSON.parse(fitReview(holdsOnly, 120_000)!);
  assert.deepEqual(kept.residualHolds, ["Confirm the file's folder"]);
  assert.equal(kept.note, undefined);
  const lostHold = JSON.parse(fitReview({ ...holdsOnly, residualHolds: ["h".repeat(3_000)] }, 320)!);
  assert.deepEqual(lostHold.residualHolds, []);
  assert.match(lostHold.note, /1 residual holds left out/);
  assert.equal(fitReview(holdsOnly, 50), undefined);
  // A FAIL explained only by a failed audit keeps that audit's explanation,
  // or discloses its loss .
  const auditOnly = {
    ...base,
    remediation: [],
    findings: [],
    residualHolds: [],
    auditAssessments: [
      { kind: "ACCURACY", result: "FAIL", evidenceIds: [], assessment: "The register names the wrong folder.", limitations: [] },
      { kind: "LOCAL_ANTI_DRIFT", result: "PASS", evidenceIds: [], assessment: "ok", limitations: [] },
    ],
  } as any;
  const keptAudit = JSON.parse(fitReview(auditOnly, 120_000)!);
  assert.deepEqual(keptAudit.failedAudits, [{ kind: "ACCURACY", assessment: "The register names the wrong folder." }]);
  assert.equal(keptAudit.note, undefined);
  const lostAudit = JSON.parse(
    fitReview({ ...auditOnly, auditAssessments: [{ ...auditOnly.auditAssessments[0], assessment: "a".repeat(3_000) }] }, 340)!,
  );
  assert.deepEqual(lostAudit.failedAudits, []);
  assert.match(lostAudit.note, /1 failed audits left out/);
  assert.equal(fitReview(auditOnly, 50), undefined);
});

test("when the attempt budget is used up, the rework waits for the owner instead of running", async () => {
  const f = fixture(["FAIL", "FAIL"], { maxAttempts: 1 });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.ok(f.c.reworkPending("A"));
    const after = await f.o.drive(f.id, { live: true });
    assert.equal(workers(f).length, 1);
    assert.ok(
      after.tasks[0]!.steps.some(
        (s) =>
          s.stage === "WORKER_RESERVATION" &&
          s.outcome === "HELD" &&
          /EXECUTION_BUDGET_EXHAUSTED|ATTEMPT/.test(s.detail),
      ),
      JSON.stringify(after.tasks[0]!.steps),
    );
    assert.notEqual(view.status, "HELD_SPEC_CHANGED");
  } finally {
    f.close();
  }
});

test("a rework the provider's limit cuts off leaves the sealed work current and the rework pending; the next one resumes its files", async () => {
  const f = fixture(["FAIL", "PASS"], { maxAttempts: 4 });
  try {
    await f.o.drive(f.id, { live: true });
    const [first] = workers(f);
    const review = reviewers(f)[0]!;
    const actor = f.c.localActor();
    const rework = f.c.reserve("A", { requestKey: "rework-1" }, actor) as any;
    assert.equal(rework.rework, review.id);
    await f.c.execute(
      rework,
      {
        async execute(r) {
          writeFileSync(join(r.cwd, "output", "A", "hello.txt"), "half fixed\n");
          return {
            runId: r.runId,
            taskId: r.taskId,
            provider: r.provider,
            model: r.model,
            effort: r.effort,
            sessionId: randomUUID(),
            exitCode: 1,
            status: "FAILED",
            startedAt: now,
            endedAt: new Date().toISOString(),
            output: "limit",
            tests: [],
            costUsd: 0.2,
            tokens: 50,
            identityVerified: false,
            simulation: false,
            providerLimit: {
              kind: "USAGE_LIMIT",
              evidence: 'claude result envelope: api_error "usage_limit_reached"',
              resetsAt: new Date(Date.now() + 600_000).toISOString(),
              resetBasis: "STATED_WITH_ZONE",
              message: "You've hit your session limit",
            },
          };
        },
      },
      actor,
    );
    // The sealed work before it is still the current work, and the rework
    // of the same review is still pending.
    assert.equal((f.c as any).assertWorkerArtifact(f.c.task("A")).id, first!.id);
    assert.equal(f.c.reworkPending("A")?.reviewRunId, review.id);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    f.c.clearProviderPause("claude", { reason: "reset", evidence: ["usage page"], sourceRef: "test:operator" }, actor);
    const again = f.c.reserve("A", { requestKey: "rework-2" }, actor) as any;
    assert.equal(again.rework, review.id);
    assert.equal(again.resumes, rework.id);
    assert.equal(readFileSync(join(again.workspace, "output", "A", "hello.txt"), "utf8"), "half fixed\n");
  } finally {
    f.close();
  }
});
