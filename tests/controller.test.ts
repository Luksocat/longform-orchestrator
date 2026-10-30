import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { SqliteStore } from "../src/store.js";
import {
  demoTask,
  digest,
  specDigest,
  validateGraph,
  TaskSchema,
  reviewPayload,
  type Review,
  type Task,
} from "../src/domain.js";
import {
  MockProvider,
  type ProviderAdapter,
  type ProviderReceipt,
} from "../src/providers.js";
import { sandboxed } from "./sandbox-support.js";
const uid = process.getuid!();
function fixture(
  tasks: Task[] = [demoTask("A", { providers: ["codex", "claude"] })],
  options: Record<string, unknown> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-controller-")),
    db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
      workspaceRoot: join(root, "work"),
      ownerUid: uid,
      ...options,
    }),
    actor = c.localActor();
  c.importTasks(tasks, actor);
  for (const t of tasks)
    if (t.dimensions.authorization !== "HELD")
      c.grant(
        t.id,
        {
          id: "grant-" + t.id,
          operations: [...t.operations, "ACCEPT"],
          paths: t.writePaths,
          decisionText: "Synthetic local test only",
          sourceRef: "test:owner-authorization",
        },
        actor,
      );
  return {
    root,
    db,
    c,
    actor,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const select = (
  provider: "codex" | "claude" = "codex",
  role: "worker" | "reviewer" = "worker",
) => ({
  provider,
  model: "synthetic-" + provider,
  effort: "test",
  requestKey: crypto.randomUUID(),
  role,
});
async function worked(f: ReturnType<typeof fixture>, id = "A") {
  const a = f.c.reserve(id, select(), f.actor);
  await f.c.execute(a, new MockProvider(), f.actor);
  return a;
}
async function reviewed(f: ReturnType<typeof fixture>, id = "A") {
  const worker = await worked(f, id);
  const evidence = f.c
    .evidenceFor(id)
    .find((e) => e.metadata.runId === worker.id)!;
  if (f.c.task(id).acceptance.some((c) => c.id === "receipt"))
    f.c.bindAcceptance(id, "receipt", evidence.id, f.actor);
  const reviewer = f.c.reserve(id, select("claude", "reviewer"), f.actor);
  const report: Review = {
    id: crypto.randomUUID(),
    taskId: id,
    runId: reviewer.id,
    artifactRevision: f.c.task(id).artifactRevision,
    specDigest: specDigest(f.c.task(id)),
    reviewerSession: "pending-harness-session",
    provider: "claude",
    authorshipDisclosure: "Fresh synthetic reviewer; mock only",
    availableEvidence: f.c.evidenceFor(id).map((e) => e.id),
    findings: [],
    testsExecuted: [],
    testsNotExecuted: ["No model executed tests; synthetic fixture"],
    conflictingEvidence: [],
    remediation: [],
    residualHolds: [],
    verdict: "PASS",
    scope: "synthetic scope",
    nextAuthorizedStep: "Run controller audits",
    auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map(
      (kind) => ({
        kind: kind as any,
        result: "PASS",
        evidenceIds: f.c.evidenceFor(id).map((e) => e.id),
        assessment:
          "Synthetic independent assessment; no real provider invoked",
        limitations: [],
      }),
    ),
  };
  const receipt = await f.c.execute(
    reviewer,
    new MockProvider({ output: JSON.stringify(reviewPayload(report)) }),
    f.actor,
  );
  report.reviewerSession = receipt.sessionId;
  f.c.review(report, f.actor);
  return { worker, reviewer, receipt, report };
}
test("validated graph rejects cycles, missing nodes, duplicate IDs, unsafe paths", () => {
  assert.throws(
    () =>
      validateGraph([
        demoTask("A", { dependencies: ["B"] }),
        demoTask("B", { dependencies: ["A"] }),
      ]),
    /CYCLE/,
  );
  assert.throws(
    () => validateGraph([demoTask("A", { dependencies: ["missing"] })]),
    /MISSING_DEPENDENCY/,
  );
  assert.throws(
    () => validateGraph([demoTask("A"), demoTask("A")]),
    /DUPLICATE/,
  );
  assert.throws(() =>
    TaskSchema.parse({ ...demoTask("A"), writePaths: ["../secret"] }),
  );
  assert.throws(() =>
    TaskSchema.parse({
      ...demoTask("A"),
      risk: "HIGH",
      reviewPolicy: {
        required: false,
        crossProvider: false,
        independentAudits: false,
      },
    }),
  );
});
test("blocked task, unauthorized operations, external mutations and forged owner rejected", () => {
  const f = fixture([demoTask("A", { blockers: ["SOURCE_OWNER_DECISION"] })]);
  try {
    assert.throws(() => f.c.reserve("A", select(), f.actor), /TASK_BLOCKED/);
    assert.throws(
      () =>
        f.c.grant(
          "A",
          {
            id: "evil",
            operations: ["MERGE"],
            paths: [],
            decisionText: "go",
            sourceRef: "x",
          },
          f.actor,
        ),
      /EXTERNAL_MUTATION_DISABLED/,
    );
    assert.throws(
      () =>
        f.c.transition("A", "READY", {
          id: "owner",
          uid,
          role: "OWNER",
        } as any),
      /UNAUTHENTICATED/,
    );
    assert.throws(() =>
      f.c.addEvidence({ id: "e", taskId: "missing" }, f.actor),
    );
  } finally {
    f.close();
  }
});
test("READ_ONLY cannot be upgraded by local write grant", () => {
  const t = demoTask("A");
  t.dimensions.authorization = "READ_ONLY";
  assert.equal(TaskSchema.safeParse(t).success, false);
  const f = fixture([{ ...t, operations: ["READ_LOCAL"], writePaths: [] }]);
  try {
    assert.throws(
      () =>
        f.c.grant(
          "A",
          {
            id: "upgrade",
            operations: ["WRITE_LOCAL"],
            paths: ["output/A"],
            decisionText: "attempted upgrade",
            sourceRef: "test:owner",
          },
          f.actor,
        ),
      /SCOPE/,
    );
  } finally {
    f.close();
  }
});
test("invalid and guarded state transitions cannot award progress; idempotence emits no duplicate", () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.c.transition("A", "ACCEPTED", f.actor),
      /INVALID_TRANSITION/,
    );
    f.c.transition("A", "READY", f.actor);
    const count = f.db.all("SELECT * FROM events").length;
    f.c.transition("A", "READY", f.actor);
    assert.equal(f.db.all("SELECT * FROM events").length, count);
    assert.throws(() => f.c.transition("A", "RUNNING", f.actor), /GUARDED/);
  } finally {
    f.close();
  }
});
test("maximum three workers and disjoint workspaces enforced transactionally", () => {
  const f = fixture(
    ["A", "B", "C", "D"].map((id) =>
      demoTask(id, { providers: ["codex", "claude"] }),
    ),
  );
  try {
    const runs = ["A", "B", "C"].map((id) =>
      f.c.reserve(id, select(), f.actor),
    );
    assert.equal(new Set(runs.map((a) => a.workspace)).size, 3);
    assert.throws(() => f.c.reserve("D", select(), f.actor), /MAX_CONCURRENCY/);
    assert.equal(f.c.plan().allocation.length, 0);
  } finally {
    f.close();
  }
});
test("overlapping writes and duplicate dispatch are rejected across database clients", () => {
  // Since the claim registry (2026-10-26) a shared write target is an
  // explicit resource or a Drive file; overlapping relative paths in two
  // runs' own workspaces no longer conflict.
  const f = fixture([
    demoTask("A", {
      providers: ["codex", "claude"],
      writePaths: ["shared"],
      resources: ["shared-target"],
    }),
    demoTask("B", {
      providers: ["codex", "claude"],
      writePaths: ["shared/file"],
      resources: ["shared-target"],
    }),
  ]);
  const db2 = new SqliteStore(join(f.root, "state.sqlite"));
  try {
    const a = f.c.reserve("A", select(), f.actor);
    const c2 = new Controller(db2, {
        workspaceRoot: join(f.root, "work"),
        ownerUid: uid,
      }),
      actor2 = c2.localActor();
    assert.throws(
      () => c2.reserve("B", select(), actor2),
      /CLAIM_CONFLICT:resource:shared-target/,
    );
    assert.throws(
      () => c2.reserve("A", select(), actor2),
      /TASK_NOT_DISPATCHABLE|ACTIVE/,
    );
    assert.throws(
      () => c2.reserve("B", { ...select(), requestKey: a.requestKey }, actor2),
      /DUPLICATE_DISPATCH_KEY/,
    );
  } finally {
    db2.close();
    f.close();
  }
});
test("two independent mock jobs genuinely overlap and queue independent cross-provider review", async () => {
  const f = fixture(
    ["A", "B"].map((id) => demoTask(id, { providers: ["codex", "claude"] })),
  );
  try {
    const a = f.c.reserve("A", select(), f.actor),
      b = f.c.reserve("B", select(), f.actor);
    const receipts = await Promise.all([
      f.c.execute(a, new MockProvider({ delayMs: 50 }), f.actor),
      f.c.execute(b, new MockProvider({ delayMs: 50 }), f.actor),
    ]);
    assert.ok(
      Date.parse(receipts[0]!.startedAt) < Date.parse(receipts[1]!.endedAt),
    );
    assert.ok(
      Date.parse(receipts[1]!.startedAt) < Date.parse(receipts[0]!.endedAt),
    );
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.throws(
      () => f.c.reserve("A", select("codex", "reviewer"), f.actor),
      /AUTHORED/,
    );
    assert.ok(f.c.reserve("A", select("claude", "reviewer"), f.actor));
  } finally {
    f.close();
  }
});
test("owner pause/resume uses durable exact-version decision; replay and revocation rejected", () => {
  const f = fixture([
    demoTask("A", { providers: ["codex", "claude"], decisionRequired: true }),
  ]);
  try {
    f.c.transition("A", "WAITING_OWNER", f.actor);
    assert.throws(
      () => f.c.reserve("A", select(), f.actor),
      /OWNER_DECISION_REQUIRED/,
    );
    const d = {
      id: "d",
      text: "Run local synthetic fixture",
      sourceRef: "test:conversation",
      alternatives: ["mock"],
      limits: ["local only"],
      operations: f.c.task("A").operations,
      artifactRevision: f.c.task("A").artifactRevision,
    };
    f.c.decide("A", d, f.actor);
    assert.throws(() => f.c.decide("A", d, f.actor), /UNIQUE/);
    f.c.transition("A", "READY", f.actor);
    f.c.revoke("d", "withdrawn", f.actor);
    assert.ok(f.c.reasons("A").includes("OWNER_DECISION_REQUIRED"));
  } finally {
    f.close();
  }
});
test("revoked required owner decision halts promotion even after completed reviews and audits", async () => {
  const f = fixture([demoTask("A", { decisionRequired: true })]);
  try {
    f.c.decide(
      "A",
      {
        id: "work",
        text: "Run synthetic local task",
        sourceRef: "test:owner",
        alternatives: ["mock"],
        limits: ["simulation"],
        operations: f.c.task("A").operations,
        artifactRevision: f.c.task("A").artifactRevision,
      },
      f.actor,
    );
    await reviewed(f);
    f.c.audit("A", f.actor);
    f.c.revoke("work", "execution decision withdrawn", f.actor);
    assert.throws(
      () => f.c.verify("A", f.actor),
      /CURRENT_OWNER_DECISION_REQUIRED/,
    );
  } finally {
    f.close();
  }
});
test("crash recovery distinguishes reserved, started unknown, active and never blindly retries", async () => {
  const f = fixture(
    ["A", "B", "C"].map((id) =>
      demoTask(id, { providers: ["codex", "claude"] }),
    ),
  );
  try {
    const a = f.c.reserve("A", select(), f.actor),
      b = f.c.reserve("B", select(), f.actor),
      c = f.c.reserve("C", select(), f.actor);
    const crashed = await f.c.execute(
      b,
      new MockProvider({ outcome: "crash" }),
      f.actor,
    );
    assert.equal(crashed.status, "UNKNOWN");
    // Exercise both sides of lease expiry explicitly, independent of how long
    // the native execution and filesystem checks took on a loaded machine.
    let result = f.c.recover(f.actor, Math.min(a.leaseUntil, c.leaseUntil) - 1);
    assert.equal(
      result.find((r) => r.runId === b.id)?.outcome,
      "UNKNOWN_REQUIRES_RECONCILIATION",
    );
    assert.equal(result.find((r) => r.runId === c.id)?.outcome, "STILL_ACTIVE");
    result = f.c.recover(f.actor, Math.max(a.leaseUntil, c.leaseUntil) + 1);
    assert.equal(
      result.find((r) => r.runId === a.id)?.outcome,
      "DEFINITELY_NOT_STARTED",
    );
    assert.throws(
      () => f.c.reserve("B", select(), f.actor),
      /ACTIVE_OR_UNKNOWN/,
    );
    assert.ok(f.db.verifyEvents());
  } finally {
    f.close();
  }
});
test("timeouts/cancellation preserve receipts; failed attempts need changed evidence before retry", async () => {
  const f = fixture([
    demoTask("A", {
      providers: ["codex", "claude"],
      budget: {
        deadlineMs: 20,
        maxAttempts: 2,
        maxCostUsd: 0,
        maxTokens: 1000,
      },
    }),
  ]);
  try {
    const a = f.c.reserve("A", select(), f.actor);
    const receipt = await f.c.execute(
      a,
      new MockProvider({ delayMs: 100 }),
      f.actor,
    );
    assert.ok(["TIMED_OUT", "CANCELLED"].includes(receipt.status));
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.ok(
      f.c
        .reasons("A")
        .includes("UNCHANGED_FAILED_ATTEMPT_REQUIRES_RECONCILIATION"),
    );
  } finally {
    f.close();
  }
});
test("malformed/mismatched provider receipt and prose test claims halt promotion", async () => {
  for (const change of [
    { model: "wrong" },
    { tests: [{ name: "tests", passed: true }] },
    { endedAt: "1990-01-01T00:00:00.000Z" },
  ]) {
    const f = fixture();
    try {
      const a = f.c.reserve("A", select(), f.actor),
        adapter: ProviderAdapter = {
          async execute(r) {
            return {
              ...(await new MockProvider().execute(r)),
              ...change,
            } as ProviderReceipt;
          },
        };
      await assert.rejects(f.c.execute(a, adapter, f.actor));
      assert.equal(f.c.task("A").status, "BLOCKED");
      assert.equal(
        f.db.get("SELECT state FROM attempts WHERE id=?", a.id).state,
        "UNKNOWN",
      );
    } finally {
      f.close();
    }
  }
});
test("stale source supersession invalidates current task without overwriting history", () => {
  const f = fixture();
  try {
    const task = f.c.task("A");
    const e = {
      id: "s1",
      taskId: "A",
      kind: "LOCAL",
      uri: "source:A",
      revision: "1",
      digest: digest("one"),
      retrievedAt: new Date().toISOString(),
      authorityTier: "PLANNING",
      authentication: "LOCAL_IMPORT",
      currentness: "CURRENT_AT_RETRIEVAL",
      claims: [],
      metadata: {},
    };
    f.c.addEvidence(e, f.actor);
    f.c.revise(
      "A",
      {
        ...task,
        specVersion: 2,
        sources: [{ evidenceId: "s1", revision: "1", digest: e.digest }],
      },
      f.actor,
    );
    f.c.addEvidence(
      {
        ...e,
        id: "s2",
        revision: "2",
        digest: digest("two"),
        supersedes: "s1",
      },
      f.actor,
    );
    assert.ok(f.c.reasons("A").some((r) => r.includes("SUPERSEDED_SOURCE")));
    assert.equal(f.c.evidenceFor("A").length, 2);
    assert.throws(
      () => f.db.run("UPDATE evidence SET body=? WHERE id=?", "{}", "s1"),
      /APPEND_ONLY/,
    );
  } finally {
    f.close();
  }
});
test("review rejects stale commit, false independent tests, self session, and current bytes change", async () => {
  const f = fixture();
  try {
    const { worker, report } = await reviewed(f);
    assert.throws(
      () =>
        f.c.review(
          { ...report, id: "stale", artifactRevision: "old-commit" },
          f.actor,
        ),
      /REVISION_MISMATCH/,
    );
    assert.throws(
      () =>
        f.c.review(
          { ...report, id: "false", testsExecuted: ["made-up"] },
          f.actor,
        ),
      /FALSE_INDEPENDENT_TEST_CLAIM/,
    );
    assert.throws(
      () =>
        f.c.review(
          {
            ...report,
            id: "edited",
            scope: "operator changed reviewer assessment",
          },
          f.actor,
        ),
      /DIFFERS_FROM_REVIEWER_OUTPUT/,
    );
    mkdirSync(join(worker.workspace, "output", "A"), { recursive: true });
    writeFileSync(
      join(worker.workspace, "output", "A", "late.txt"),
      "changed after review",
    );
    f.c.audit("A", f.actor);
    assert.throws(
      () => f.c.verify("A", f.actor),
      /INDEPENDENT_REVIEW_REQUIRED/,
    );
  } finally {
    f.close();
  }
});
test("accuracy/local/macro stored separately, all pass required; independent audits enforced for high risk", async () => {
  const f = fixture([
    demoTask("A", {
      providers: ["codex", "claude"],
      risk: "HIGH",
      reviewPolicy: {
        required: true,
        crossProvider: true,
        independentAudits: true,
      },
    }),
  ]);
  try {
    const { reviewer } = await reviewed(f);
    const own = f.c.audit("A", f.actor);
    assert.equal(own.length, 3);
    assert.ok(own.every((a) => a.result === "PASS_WITH_LIMITATIONS"));
    assert.throws(() => f.c.verify("A", f.actor), /AUDIT_NOT_CURRENT_PASS/);
    const independent = f.c.audit("A", f.actor, reviewer.id);
    assert.ok(independent.every((a) => a.result === "PASS" && a.independent));
    f.c.verify("A", f.actor);
    assert.equal(f.c.task("A").status, "VERIFIED");
    assert.throws(
      () => f.c.accept("A", f.actor),
      /ACCEPTANCE_DECISION_REQUIRED/,
    );
    f.c.decide(
      "A",
      {
        id: "accept",
        text: "Accept synthetic fixture only",
        sourceRef: "test:owner",
        alternatives: [],
        limits: ["simulation"],
        operations: ["ACCEPT"],
        artifactRevision: f.c.task("A").artifactRevision,
      },
      f.actor,
    );
    f.c.accept("A", f.actor);
    assert.equal(f.c.task("A").status, "ACCEPTED");
  } finally {
    f.close();
  }
});
test("post-audit changes to a shared-resource peer cannot be promoted with stale macro record", async () => {
  const f = fixture([
    demoTask("A", { providers: ["codex", "claude"], resources: ["shared-input"] }),
    demoTask("B", { providers: ["codex", "claude"], resources: ["shared-input"] }),
  ]);
  try {
    await reviewed(f);
    f.c.audit("A", f.actor);
    f.c.revise(
      "B",
      { ...f.c.task("B"), specVersion: 2, blockers: ["new source hold"] },
      f.actor,
    );
    assert.throws(() => f.c.verify("A", f.actor), /AUDIT_NOT_CURRENT_PASS/);
  } finally {
    f.close();
  }
});
test("out-of-scope workspace writes fail local audit", async () => {
  const f = fixture();
  try {
    const a = await worked(f);
    writeFileSync(join(a.workspace, "unexpected.txt"), "oops");
    const audits = f.c.audit("A", f.actor);
    assert.equal(
      audits.find((a) => a.kind === "LOCAL_ANTI_DRIFT")?.result,
      "FAIL",
    );
  } finally {
    f.close();
  }
});
test("real test process receipts required; no arbitrary commands; runner disclosure explicit", sandboxed, async () => {
  const f = fixture(
    [
      demoTask("A", {
        providers: ["codex", "claude"],
        requiredTests: ["smoke"],
      }),
    ],
    {
      commands: {
        smoke: {
          executable: process.execPath,
          args: ["-e", 'require("node:assert/strict").equal(2+2,4)'],
        },
      },
    },
  );
  try {
    await worked(f);
    assert.equal(
      f.c.audit("A", f.actor).find((a) => a.kind === "ACCURACY")?.result,
      "FAIL",
    );
    await assert.rejects(
      f.c.command("A", "untrusted", f.actor),
      /NOT_ALLOWLISTED/,
    );
    const r = await f.c.command("A", "smoke", f.actor);
    assert.equal(r.passed, true);
    assert.equal(r.independentModelExecuted, false);
    assert.equal(
      f.c.audit("A", f.actor).find((a) => a.kind === "ACCURACY")?.result,
      "PASS",
    );
    const workspace = f.c.inspect("A").attempts[0].workspace;
    mkdirSync(join(workspace, "output", "A"), { recursive: true });
    writeFileSync(join(workspace, "output", "A", "changed.txt"), "new bytes");
    assert.equal(
      f.c.audit("A", f.actor).find((a) => a.kind === "ACCURACY")?.result,
      "FAIL",
    );
  } finally {
    f.close();
  }
});
test("report keeps holds, excludes mock tasks and reserved workstreams, never claims release", () => {
  const t = demoTask("RESEARCH", {
    programme: "EXAMPLE_PROGRAMME",
    simulation: false,
    status: "BLOCKED",
    blockers: ["RESEARCH IN_REVIEW_NOT_ACCEPTED"],
  });
  t.dimensions.authorization = "HELD";
  const f = fixture([
    t,
    demoTask("RESERVED", { programme: "EXAMPLE_PROGRAMME", lane: "HOLD" }),
    demoTask("MOCK"),
  ]);
  try {
    const report = f.c.report();
    assert.equal(report.programme.registered, 1);
    assert.equal(report.programme.accepted, 0);
    assert.equal(report.releaseAuthorized, false);
    assert.ok(
      report.programme.tasks[0]?.holds.includes("RESEARCH IN_REVIEW_NOT_ACCEPTED"),
    );
    assert.ok(
      report.programme.completionEstimate.method.includes(
        "not an estimate of total project effort",
      ),
    );
  } finally {
    f.close();
  }
});
test("durable database reopen retains decisions, task states and append-only audit chain", () => {
  const f = fixture();
  try {
    f.c.transition("A", "WAITING_OWNER", f.actor);
    const other = new SqliteStore(join(f.root, "state.sqlite"));
    assert.equal(
      new Controller(other, {
        workspaceRoot: join(f.root, "work"),
        ownerUid: uid,
      }).task("A").status,
      "WAITING_OWNER",
    );
    assert.ok(other.verifyEvents());
    other.close();
    // Migration 6 adds the claim registry (2026-10-26).
    assert.equal(f.db.all("SELECT version FROM schema_migrations").length, 7);
  } finally {
    f.close();
  }
});
test("hung adapters cannot extend deadlines and leave unknown outcomes held", async () => {
  const f = fixture([
    demoTask("A", {
      budget: {
        deadlineMs: 15,
        maxAttempts: 2,
        maxCostUsd: 0,
        maxTokens: 1000,
      },
    }),
  ]);
  try {
    const a = f.c.reserve("A", select(), f.actor);
    await assert.rejects(
      f.c.execute(a, { execute: () => new Promise(() => {}) }, f.actor),
      /DID_NOT_CONFIRM_STOP/,
    );
    assert.equal(f.c.task("A").status, "BLOCKED");
    assert.throws(
      () => f.c.reserve("A", select(), f.actor),
      /ACTIVE_OR_UNKNOWN/,
    );
  } finally {
    f.close();
  }
});
test("cross-process cancellation request is durable and observed by heartbeat", async () => {
  const f = fixture(
    [
      demoTask("A", {
        budget: {
          deadlineMs: 1000,
          maxAttempts: 2,
          maxCostUsd: 0,
          maxTokens: 1000,
        },
      }),
    ],
    { leaseMs: 60 },
  );
  const other = new SqliteStore(join(f.root, "state.sqlite"));
  try {
    const a = f.c.reserve("A", select(), f.actor),
      running = f.c.execute(a, new MockProvider({ delayMs: 500 }), f.actor),
      c2 = new Controller(other, {
        workspaceRoot: join(f.root, "work"),
        ownerUid: uid,
      }),
      actor2 = c2.localActor();
    c2.cancel(a.id, actor2);
    const result = await running;
    assert.equal(result.status, "CANCELLED");
    assert.equal(
      f.db.get("SELECT state FROM attempts WHERE id=?", a.id).state,
      "CANCELLED",
    );
  } finally {
    other.close();
    f.close();
  }
});
test("cancellation before fast success cannot race heartbeat to promote work", async () => {
  const f = fixture(undefined, { leaseMs: 900 });
  const other = new SqliteStore(join(f.root, "state.sqlite"));
  try {
    const a = f.c.reserve("A", select(), f.actor),
      running = f.c.execute(a, new MockProvider({ delayMs: 5 }), f.actor),
      c2 = new Controller(other, {
        workspaceRoot: join(f.root, "work"),
        ownerUid: uid,
      });
    c2.cancel(a.id, c2.localActor());
    await assert.rejects(running, /CANCELLED_RUN_SUCCESS/);
    assert.equal(f.c.task("A").status, "BLOCKED");
    assert.equal(
      f.db.get("SELECT state FROM attempts WHERE id=?", a.id).state,
      "UNKNOWN",
    );
  } finally {
    other.close();
    f.close();
  }
});
test("concurrency config must be a finite integer and synthetic names cannot affect programme counts", () => {
  const f = fixture([demoTask("LONGFORM-MOCK", { programme: "LONGFORM" })]);
  try {
    for (const maxWorkers of [NaN, 1.5, 4, 0])
      assert.throws(
        () =>
          new Controller(f.db, {
            workspaceRoot: join(f.root, "bad"),
            ownerUid: uid,
            maxWorkers,
          }),
        /CONCURRENCY/,
      );
    assert.equal(f.c.report().programme.registered, 0);
  } finally {
    f.close();
  }
});
test("superseded acceptance envelopes cannot be rebound and forged local evidence has no receipt custody", async () => {
  const f = fixture();
  try {
    await worked(f);
    const original = f.c.evidenceFor("A")[0]!;
    f.c.addEvidence(
      {
        ...original,
        id: "new",
        supersedes: original.id,
        digest: digest("new bytes"),
      },
      f.actor,
    );
    assert.throws(
      () => f.c.bindAcceptance("A", "receipt", original.id, f.actor),
      /SUPERSEDED_ACCEPTANCE/,
    );
    assert.throws(
      () => f.c.bindAcceptance("A", "receipt", "new", f.actor),
      /REQUIRES_EXECUTION_RECEIPT/,
    );
  } finally {
    f.close();
  }
});

test("controller-derived REVIEW evidence binds the current review without staling review or audits", async () => {
  const f = fixture([
    demoTask("A", {
      acceptance: [{
        id: "review-proof",
        description: "Independent reviewer must inspect the current artifact",
        evidenceKind: "REVIEW",
      }],
    }),
  ]);
  try {
    const { worker, reviewer, report } = await reviewed(f);
    const proofs = f.c.evidenceFor("A").filter((e) => e.kind === "REVIEW");
    assert.equal(proofs.length, 1);
    const proof = proofs[0]!;
    assert.equal(proof.id, "review-" + report.id);
    assert.equal(proof.uri, "controller-review:" + report.id);
    assert.equal(proof.digest, digest(report));
    assert.equal(proof.metadata.reviewId, report.id);
    assert.equal(proof.metadata.reviewRunId, reviewer.id);
    assert.equal(proof.metadata.workerRunId, worker.id);
    assert.equal(proof.metadata.simulation, true);
    assert.equal(proof.metadata.independence, "SIMULATED_SEPARATE_SESSION");
    assert.equal(f.db.all("SELECT * FROM acceptance_bindings").length, 0);
    const audits = f.c.audit("A", f.actor, reviewer.id);
    assert.equal(audits.length, 3);
    assert.ok(audits.every((a) => a.result === "PASS"));
    assert.throws(
      () => f.c.verify("A", f.actor),
      /MISSING_ACCEPTANCE_EVIDENCE:review-proof/,
    );
    f.c.bindAcceptance("A", "review-proof", proof.id, f.actor);
    f.c.verify("A", f.actor);
    assert.equal(f.c.task("A").status, "VERIFIED");
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.equal(f.c.inspect("A").audits.length, 3);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.c.report().releaseAuthorized, false);
    assert.equal(f.db.verifyEvents(), true);
    // A second review cannot manufacture extra evidence for the same artifact.
    assert.throws(() => f.c.review(report, f.actor));
    assert.equal(f.c.evidenceFor("A").filter((e) => e.kind === "REVIEW").length, 1);
  } finally {
    f.close();
  }
});

test("forged REVIEW evidence cannot be bound; it also cannot masquerade as derived non-input evidence", async () => {
  const f = fixture([
    demoTask("A", {
      acceptance: [{
        id: "review-proof",
        description: "Current independent review",
        evidenceKind: "REVIEW",
      }],
    }),
  ]);
  try {
    await reviewed(f);
    const genuine = f.c.evidenceFor("A").find((e) => e.kind === "REVIEW")!;
    f.c.addEvidence({
      ...genuine,
      id: "forged-review-proof",
      metadata: { ...genuine.metadata, workerRunId: "unrelated-worker" },
    }, f.actor);
    assert.throws(
      () => f.c.bindAcceptance("A", "review-proof", "forged-review-proof", f.actor),
      /REVIEW_ACCEPTANCE_REQUIRES_CURRENT_AUTHENTICATED_REVIEW/,
    );
    // An untrusted lookalike is not excluded from the review-input digest:
    // adding it after review makes the current review stale, fail closed.
    assert.throws(
      () => f.c.bindAcceptance("A", "review-proof", genuine.id, f.actor),
      /REVIEW_ACCEPTANCE_REQUIRES_CURRENT_AUTHENTICATED_REVIEW/,
    );
    assert.throws(
      () => f.c.verify("A", f.actor),
      /INDEPENDENT_REVIEW_REQUIRED/,
    );
    assert.equal(f.db.all("SELECT * FROM acceptance_bindings").length, 0);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("REVIEW evidence for another task or superseded specification never binds", async () => {
  const reviewCriterion = {
    id: "review-proof",
    description: "Current independent review",
    evidenceKind: "REVIEW" as const,
  };
  const f = fixture([
    demoTask("A", { acceptance: [reviewCriterion] }),
    demoTask("B", { acceptance: [reviewCriterion] }),
  ]);
  try {
    await reviewed(f, "A");
    const genuine = f.c.evidenceFor("A").find((e) => e.kind === "REVIEW")!;
    assert.throws(
      () => f.c.bindAcceptance("B", "review-proof", genuine.id, f.actor),
      /ACCEPTANCE_BINDING_MISMATCH/,
    );
    const old = f.c.task("A");
    f.c.revise("A", {
      ...old,
      specVersion: old.specVersion + 1,
      artifactRevision: digest("review-evidence-revised"),
    }, f.actor);
    assert.throws(
      () => f.c.bindAcceptance("A", "review-proof", genuine.id, f.actor),
      /ACCEPTANCE_BINDING_MISMATCH/,
    );
    assert.equal(f.db.all("SELECT * FROM acceptance_bindings").length, 0);
  } finally {
    f.close();
  }
});

test("tasks without REVIEW acceptance do not create redundant REVIEW evidence", async () => {
  const f = fixture();
  try {
    await reviewed(f);
    assert.equal(f.c.evidenceFor("A").filter((e) => e.kind === "REVIEW").length, 0);
  } finally {
    f.close();
  }
});
