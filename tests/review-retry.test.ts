import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller, cleanReview } from "../src/controller.js";
import { canonical, digest, specDigest, TaskSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { validateProviderReceipt } from "../src/providers.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import { RoutingPolicySchema } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

const now = new Date().toISOString();
const capability = (
  provider: "claude" | "codex",
  model: string,
  effort: string,
) => ({
  provider,
  model,
  effort,
  verifiedAt: now,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  evidenceRef: "test:attested",
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "retry-test",
  routes: [
    {
      id: "claude-routine",
      level: "ROUTINE",
      provider: "claude",
      model: "claude-w",
      effort: "low",
      roles: ["worker"],
      simulation: false,
      enabled: true,
      capability: capability("claude", "claude-w", "low"),
    },
    {
      // Two write scopes (output and the Drive record) are not a bounded chore.
      id: "claude-standard",
      level: "STANDARD",
      provider: "claude",
      model: "claude-w",
      effort: "low",
      roles: ["worker"],
      simulation: false,
      enabled: true,
      capability: capability("claude", "claude-w", "low"),
    },
    {
      // Tasks that change Drive documents are COMPLEX work (stakes rule).
      id: "claude-complex",
      level: "COMPLEX",
      provider: "claude",
      model: "claude-w",
      effort: "low",
      roles: ["worker"],
      simulation: false,
      enabled: true,
      capability: capability("claude", "claude-w", "low"),
    },
    {
      id: "codex-standard",
      level: "STANDARD",
      provider: "codex",
      model: "codex-r",
      effort: "medium",
      roles: ["reviewer"],
      simulation: false,
      enabled: true,
      capability: capability("codex", "codex-r", "medium"),
    },
    {
      // Their reviewer is held to the same stakes tier.
      id: "codex-complex",
      level: "COMPLEX",
      provider: "codex",
      model: "codex-r",
      effort: "medium",
      roles: ["reviewer"],
      simulation: false,
      enabled: true,
      capability: capability("codex", "codex-r", "medium"),
    },
  ],
});

/** Live-shaped receipts without a model: scripted reviewer outcomes per call. */
type Outcome =
  | "FAIL"
  | "THROW"
  | "PASS"
  | "LIMITED"
  | "NULL_COST"
  | "NULL_TOKENS"
  | "NULL_USAGE"
  | "REFUSED";
function adapter(
  reviewerOutcomes: Outcome[],
  workerTokens = 10,
): ProviderAdapter & { reviews: number } {
  const self = {
    reviews: 0,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      const receipt = (
        status: ProviderReceipt["status"],
        output: string,
      ): ProviderReceipt => ({
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: status === "SUCCEEDED" ? 0 : 1,
        status,
        startedAt: now,
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: request.role === "worker" ? workerTokens : 10,
        identityVerified: status === "SUCCEEDED",
        simulation: false,
      });
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt("SUCCEEDED", "wrote output/A/hello.txt");
      }
      const outcome = reviewerOutcomes[self.reviews++] ?? "PASS";
      if (outcome === "THROW") throw new Error("SIMULATED_RUNNER_CRASH");
      if (outcome === "FAIL")
        return receipt("FAILED", "MALFORMED_PROVIDER_OUTPUT");
      if (outcome === "REFUSED")
        return {
          ...receipt("FAILED", "CODEX_CREDENTIAL_RECOVERY_PENDING: /kept"),
          costUsd: 0,
          tokens: 0,
          notLaunched: true,
        };
      if (outcome.startsWith("NULL_"))
        return {
          ...receipt("FAILED", "PROCESS_DIED"),
          costUsd: outcome === "NULL_TOKENS" ? 0.01 : null,
          tokens: outcome === "NULL_COST" ? 10 : null,
        } as unknown as ProviderReceipt;
      const p = (request.outputSchema as { properties: Record<string, any> })
        .properties;
      const ev: string[] = p.availableEvidence.items.enum;
      return receipt(
        "SUCCEEDED",
        canonical({
          taskId: p.taskId.enum[0],
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: p.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings: [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation: [],
          residualHolds: [],
          verdict: outcome === "LIMITED" ? "PASS_WITH_LIMITATIONS" : "PASS",
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
        }),
      );
    },
  };
  return self;
}

function fixture(reviewerOutcomes: Outcome[], workerTokens = 10) {
  const root = mkdtempSync(join(tmpdir(), "longform-retry-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: () => true,
  });
  const live = adapter(reviewerOutcomes, workerTokens);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:retry",
  });
  const source = o.ownerSource(request.request.id);
  c.importTasks(
    [
      TaskSchema.parse({
        id: "A",
        programme: "TEST",
        lane: "LOCAL",
        title: "t",
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
          maxAttempts: 2,
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
      sourceRef: "test:retry",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    root,
    c,
    o,
    live,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const reviewers = (c: Controller) =>
  c
    .inspect("A")
    .attempts.filter((a: { role: string }) => a.role === "reviewer");

test("a cleanly failed reviewer run is retried against the same artifact, at most twice", async () => {
  const f = fixture(["FAIL", "PASS"]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(view.tasks[0]!.status, "WAITING_REVIEW");
    assert.deepEqual(
      reviewers(f.c).map((a: { state: string }) => a.state),
      ["FAILED", "SUCCEEDED"],
    );
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
    assert.equal(
      f.c
        .inspect("A")
        .attempts.filter((a: { role: string }) => a.role === "worker").length,
      1,
    );
  } finally {
    f.close();
  }
  const g = fixture(["FAIL", "FAIL", "FAIL", "PASS"]);
  try {
    await g.o.drive(g.id, { live: true });
    await g.o.drive(g.id, { live: true });
    assert.equal(reviewers(g.c).length, 3);
    assert.equal(g.c.inspect("A").reviews.length, 0);
  } finally {
    g.close();
  }
});

test("an unknown reviewer run keeps the task in review, holds retries until reconciled", async () => {
  const f = fixture(["THROW", "PASS"]);
  try {
    const first = await f.o.drive(f.id, { live: true });
    assert.equal(first.tasks[0]!.status, "WAITING_REVIEW");
    const [unknown] = reviewers(f.c);
    assert.equal(unknown.state, "UNKNOWN");
    await f.o.drive(f.id, { live: true });
    assert.equal(
      reviewers(f.c).length,
      1,
      "no retry while the outcome is unknown",
    );
    const assessment =
      "reviewer process stopped; read-only copy; no external effects";
    f.c.addEvidence(
      {
        id: "reconcile-" + unknown.id,
        taskId: "A",
        kind: "LOCAL",
        uri: "local-assessment:test",
        revision: f.c.task("A").artifactRevision,
        digest: "0".repeat(64),
        retrievedAt: new Date().toISOString(),
        authorityTier: "UNVERIFIED",
        authentication: "LOCAL_IMPORT",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: ["test"],
        metadata: {
          runId: unknown.id,
          reconciliation: {
            processStopped: true,
            externalEffects: "NONE",
            assessment,
            usage: { costUsd: 0.01, tokens: 10 },
          },
        },
      },
      f.c.localActor(),
    );
    f.c.reconcile(
      unknown.id,
      "FAILED",
      "reconcile-" + unknown.id,
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      reviewers(f.c).map((a: { state: string }) => a.state),
      ["FAILED", "SUCCEEDED"],
    );
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("a clean PASS_WITH_LIMITATIONS review counts as passed; one with anything to fix does not", async () => {
  const base = { verdict: "PASS_WITH_LIMITATIONS", remediation: [], residualHolds: [], findings: [{ materiality: "INFO" }, { materiality: "MINOR" }] };
  assert.ok(cleanReview(base));
  assert.ok(cleanReview({ ...base, verdict: "PASS" }));
  assert.ok(!cleanReview({ ...base, verdict: "FAIL" }));
  assert.ok(!cleanReview({ ...base, remediation: ["fix it"] }));
  assert.ok(!cleanReview({ ...base, residualHolds: ["held"] }));
  assert.ok(cleanReview({ ...base, residualHolds: ["held"] }, new Set(["held"])));
  assert.ok(!cleanReview({ ...base, residualHolds: ["held", "other"] }, new Set(["held"])));
  assert.ok(!cleanReview({ ...base, findings: [{ materiality: "MAJOR" }] }));
  assert.ok(!cleanReview({ ...base, findings: [{ materiality: "CRITICAL" }] }));
  // End to end: the clean limited review and its audits clear verification,
  // leaving only the owner's evidence binding.
  const f = fixture(["LIMITED"]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    const task = view.tasks.find((t: { taskId: string }) => t.taskId === "A")!;
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS_WITH_LIMITATIONS");
    assert.ok(!task.holds.some((h: string) => /INDEPENDENT_REVIEW_REQUIRED|AUDIT_NOT_PASS/.test(h)), JSON.stringify(task.holds));
    assert.ok(task.holds.some((h: string) => h.includes("MISSING_ACCEPTANCE_EVIDENCE")), JSON.stringify(task.holds));
  } finally {
    f.close();
  }
});

test("unrelated task changes do not invalidate a scoped audit or require a drift acknowledgement", async () => {
  const f = fixture(["PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    const worker = f.c.inspect("A").attempts.find((a: { role: string }) => a.role === "worker")!;
    const reviewer = reviewers(f.c)[0]!;
    const sibling = (id: string) =>
      TaskSchema.parse({
        ...f.c.inspect("A").task,
        id,
        status: "DISCOVERED",
        sources: [],
        specificationAuthenticated: false,
      });
    const macro = () =>
      f.c.audit("A", f.c.localActor(), reviewer.id).find((x: { kind: string }) => x.kind === "MACRO_ANTI_DRIFT")!;
    const initial = macro();
    assert.equal(initial.result, "PASS", JSON.stringify(initial));
    f.c.importTasks([sibling("B")], f.c.localActor());
    assert.equal(macro().result, "PASS", "separate task B changed no causal input");
    f.c.importTasks([sibling("C")], f.c.localActor());
    assert.equal(macro().result, "PASS", "third independent task does not force another audit");
    assert.throws(
      () => f.c.acknowledgeDrift("A", { runId: worker.id, reason: "Unrelated", sourceRef: "test" }, f.c.localActor()),
      /NO_DRIFT_TO_ACKNOWLEDGE/,
    );
  } finally {
    f.close();
  }
});

test("explicit shared resources still hold the audit until that exact change is acknowledged", async () => {
  const f = fixture(["PASS"]);
  try {
    const old = f.c.task("A");
    f.c.revise("A", { ...old, resources: ["shared-custody"], specVersion: 2 }, f.c.localActor());
    f.c.grant("A", {
      id: randomUUID(), operations: [...old.operations],
      paths: old.writePaths, decisionText: "Approved v2 shared resource",
      sourceRef: "test:owner",
    }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    await f.o.drive(f.id, { live: true });
    const worker = f.c.inspect("A").attempts.find((a: { role: string; state: string }) => a.role === "worker" && a.state === "SUCCEEDED")!;
    const reviewer = reviewers(f.c).at(-1)!;
    const sibling = (id: string) =>
      TaskSchema.parse({
        ...f.c.task("A"), id, status: "DISCOVERED",
        sources: [], specificationAuthenticated: false,
      });
    const macro = () =>
      f.c.audit("A", f.c.localActor(), reviewer.id).find((x: { kind: string }) => x.kind === "MACRO_ANTI_DRIFT")!;
    assert.equal(macro().result, "PASS");
    f.c.importTasks([sibling("B")], f.c.localActor());
    const failed = macro();
    assert.equal(failed.result, "FAIL");
    assert.ok(failed.checks.includes("RELATED_TASK_SPEC_OR_AUTHORITY_CHANGED_RECONCILE"), JSON.stringify(failed));
    assert.equal(failed.macroDrift?.changes[0]?.taskId, "B");
    assert.ok(failed.macroDrift?.changes[0]?.after?.why.includes("SHARED_RESOURCE"));
    assert.throws(
      () => f.c.acknowledgeDrift("A", { runId: worker.id, reason: " ", sourceRef: "test" }, f.c.localActor()),
      /MISSING_OWNER_EVIDENCE/,
    );
    assert.throws(
      () => f.c.acknowledgeDrift("A", { runId: reviewer.id, reason: "x", sourceRef: "test" }, f.c.localActor()),
      /DRIFT_ACK_RUN_INVALID/,
    );
    const record = f.c.acknowledgeDrift(
      "A", { runId: worker.id, reason: "Independent owner checks found B did not alter A's reviewed output", sourceRef: "test:operator-evidence" },
      f.c.localActor(),
    );
    assert.equal(record.changes?.[0]?.taskId, "B");
    assert.equal(macro().result, "PASS");
    f.c.importTasks([sibling("C")], f.c.localActor());
    assert.equal(macro().result, "FAIL", "a subsequent overlapping task is not covered by the first acknowledgement");
  } finally {
    f.close();
  }
});

test("a Drive worker's gateway record becomes bindable DRIVE evidence without disturbing its review", async () => {
  const f = fixture(["PASS"]);
  try {
    // Turn A into a Drive task before any run.
    const base = f.c.inspect("A").task;
    const driveTask = TaskSchema.parse({
      ...base,
      specVersion: 2,
      dimensions: { ...base.dimensions, authorization: "EXPLICIT" },
      complexity: { level: "ROUTINE", rationale: "test fixture", sourceRef: "test" },
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: { read: "ANY", update: ["docAAAAAAAAAAAAA"], createIn: [] },
      acceptance: [{ id: "drive", description: "Drive change", evidenceKind: "DRIVE" }],
    });
    f.c.revise("A", driveTask, f.c.localActor());
    f.c.grant("A", { id: randomUUID(), operations: driveTask.operations, paths: ["output/A", "drive-changes"], decisionText: "test", sourceRef: "test" }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    // The scripted worker leaves a gateway record; the runner's run evidence points at it.
    const audit = join(f.root, "audit");
    const log = '{"op":"update","ok":true,"fileId":"docAAAAAAAAAAAAA"}\n';
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role !== "worker") return receipt;
      mkdirSync(join(audit, request.runId), { recursive: true });
      writeFileSync(join(audit, request.runId, "log.jsonl"), log);
      mkdirSync(join(request.cwd, "drive-changes", request.runId), { recursive: true });
      writeFileSync(join(request.cwd, "drive-changes", request.runId, "log.jsonl"), log);
      const run = JSON.stringify({ runId: request.runId, drive: { auditDir: join(audit, request.runId), writes: [{ op: "update" }] } });
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
    const view = await f.o.drive(f.id, { live: true });
    const holds = view.tasks.find((t: { taskId: string }) => t.taskId === "A")!.holds;
    assert.ok(!holds.some((h: string) => /INDEPENDENT_REVIEW_REQUIRED|AUDIT_NOT_PASS/.test(h)), JSON.stringify(holds));
    const e = f.c.recordDriveEvidence("A", f.c.localActor());
    assert.equal(e.kind, "DRIVE");
    assert.throws(() => f.c.recordDriveEvidence("A", f.c.localActor()), /ALREADY_RECORDED/);
    f.c.bindAcceptance("A", "drive", e.id, f.c.localActor());
    // Review and audits still count after the evidence was added.
    f.c.verify("A", f.c.localActor());
    assert.equal(f.c.inspect("A").task.status, "VERIFIED");
  } finally {
    f.close();
  }
});

test("Drive evidence is refused when the host record and the sealed workspace copy differ", async () => {
  const f = fixture(["PASS"]);
  try {
    const base = f.c.inspect("A").task;
    const driveTask = TaskSchema.parse({
      ...base,
      specVersion: 2,
      dimensions: { ...base.dimensions, authorization: "EXPLICIT" },
      complexity: { level: "ROUTINE", rationale: "test fixture", sourceRef: "test" },
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: { read: "ANY", update: [], createIn: [] },
    });
    f.c.revise("A", driveTask, f.c.localActor());
    f.c.grant("A", { id: randomUUID(), operations: driveTask.operations, paths: ["output/A", "drive-changes"], decisionText: "test", sourceRef: "test" }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    const audit = join(f.root, "audit");
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role !== "worker") return receipt;
      mkdirSync(join(audit, request.runId), { recursive: true });
      writeFileSync(join(audit, request.runId, "log.jsonl"), "host\n");
      mkdirSync(join(request.cwd, "drive-changes", request.runId), { recursive: true });
      writeFileSync(join(request.cwd, "drive-changes", request.runId, "log.jsonl"), "forged\n");
      const run = JSON.stringify({ runId: request.runId, drive: { auditDir: join(audit, request.runId) } });
      const runFile = join(audit, "run-" + request.runId + ".json");
      writeFileSync(runFile, run);
      return { ...receipt, provenance: { cliVersion: "1", executableDigest: "a".repeat(64), isolationEvidenceRef: "t", capabilityEvidenceRef: "t", identityEvidenceRef: "file:" + runFile + "#sha256=" + digest(run), rawStdoutDigest: "b".repeat(64), rawStdoutBytes: 1 } };
    };
    await f.o.drive(f.id, { live: true });
    assert.throws(() => f.c.recordDriveEvidence("A", f.c.localActor()), /DIFFERS_FROM_SEALED/);
  } finally {
    f.close();
  }
});

test("a verified residual hold, once recorded, lets a limited review count", async () => {
  const f = fixture(["PASS"]);
  try {
    // Script one review that leaves a residual hold.
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role !== "reviewer") return receipt;
      const report = JSON.parse(receipt.output);
      report.verdict = "PASS_WITH_LIMITATIONS";
      report.residualHolds = ["Confirm the file's folder"];
      return { ...receipt, output: canonical(report) };
    };
    let view = await f.o.drive(f.id, { live: true });
    const holds = () => view.tasks.find((t: { taskId: string }) => t.taskId === "A")!.holds;
    assert.ok(holds().some((h: string) => h.includes("INDEPENDENT_REVIEW_REQUIRED")), JSON.stringify(holds()));
    const reviewer = reviewers(f.c)[0]!;
    const scope = { reviewRunId: reviewer.id, hold: "Confirm the file's folder", resolution: "Checked: in the folder", evidence: "metadata read", sourceRef: "test" };
    assert.throws(() => f.c.resolveReviewHold("A", { ...scope, hold: "other" }, f.c.localActor()), /HOLD_NOT_IN_REVIEW/);
    assert.throws(() => f.c.resolveReviewHold("A", { ...scope, evidence: " " }, f.c.localActor()), /MISSING_OWNER_EVIDENCE/);
    f.c.resolveReviewHold("A", scope, f.c.localActor());
    f.c.audit("A", f.c.localActor(), reviewer.id);
    view = await f.o.drive(f.id, { live: true });
    assert.ok(!holds().some((h: string) => /INDEPENDENT_REVIEW_REQUIRED|AUDIT_NOT_PASS/.test(h)), JSON.stringify(holds()));
  } finally {
    f.close();
  }
});

test("a run over the cap keeps its finished work, and a budget extension then lets it get its review without a new specification", async () => {
  // The worker goes past the 10,000-token cap .
  const f = fixture(["PASS"], 10_050);
  try {
    let view = await f.o.drive(f.id, { live: true });
    const spec = f.c.inspect("A").specDigest;
    const [worker] = f.c.inspect("A").attempts;
    assert.equal(worker.state, "SUCCEEDED");
    assert.equal(
      JSON.parse(f.c.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", worker.id)!.body).tokens,
      10_050,
    );
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(f.c.db.all("SELECT seq FROM events WHERE kind='BUDGET_OVERRUN'").length, 1);
    // No review starts until the budget is raised, and the request says why.
    assert.equal(reviewers(f.c).length, 0);
    const taskView = () => view.tasks.find((t: { taskId: string }) => t.taskId === "A")!;
    assert.ok(taskView().holds.includes("EXECUTION_BUDGET_EXHAUSTED"));
    assert.equal(view.status, "HELD");
    assert.ok(view.nextSteps.some((s: string) => /used up its budget/.test(s)));
    const extend = (scope: Record<string, unknown>) =>
      f.c.extendBudget("A", { reason: "sized too low", sourceRef: "test", ...scope } as never, f.c.localActor());
    assert.throws(() => extend({ maxTokens: 5_000 }), /CANNOT_LOWER/);
    assert.throws(() => extend({}), /CHANGES_NOTHING/);
    assert.throws(() => extend({ maxTokens: 50_000, reason: " " }), /MISSING_OWNER_EVIDENCE/);
    extend({ maxTokens: 50_000 });
    assert.equal(f.c.budgetHold("A"), null);
    view = await f.o.drive(f.id, { live: true });
    const holds = taskView().holds;
    assert.equal(f.c.inspect("A").specDigest, spec, "the specification is unchanged");
    assert.equal(f.c.inspect("A").attempts.filter((a: { role: string }) => a.role === "worker").length, 1, "the finished work is kept");
    assert.ok(reviewers(f.c).some((a: { state: string }) => a.state === "SUCCEEDED"), JSON.stringify(holds));
    // A later revision starts again from the specification's own caps.
    const t = f.c.inspect("A").task;
    f.c.revise("A", { ...t, specVersion: t.specVersion + 1, status: "DISCOVERED" }, f.c.localActor());
    // The old extension no longer applies, so raising to the same cap is a real change again.
    assert.ok(extend({ maxTokens: 50_000 }));
  } finally {
    f.close();
  }
});

// Regressions for independent review findings.

test("F3: a second request cannot obtain another review of the same artifact", async () => {
  const f = fixture(["LIMITED", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS_WITH_LIMITATIONS");
    const second = f.o.submit({
      requestKey: randomUUID(),
      prompt: "again",
      context: { cwd: f.root },
      sourceRef: "test:shop",
      taskIds: ["A"],
    });
    await f.o.drive(second.request.id, { live: true });
    assert.equal(
      reviewers(f.c).length,
      1,
      "no second reviewer for a reviewed artifact",
    );
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "reviewer", requestKey: randomUUID() },
          f.c.localActor(),
        ),
      /REVIEW_ALREADY_RECORDED_FOR_ARTIFACT/,
    );
    // The other host cannot attach the task at all.
    const codex = new Orchestrator(f.c, {}, "codex");
    assert.throws(
      () =>
        codex.submit({
          requestKey: randomUUID(),
          prompt: "x",
          context: { cwd: f.root },
          sourceRef: "t",
          taskIds: ["A"],
        }),
      /TASK_BOUND_TO_OTHER_HOST_REQUEST:claude/,
    );
  } finally {
    f.close();
  }
});

// An over-cap return was once rejected and left UNKNOWN; now its
// receipt is kept, which is what keeps its usage charged.
test("F4: an over-cap run's usage stays charged: its receipt is kept and no further run of any role starts", async () => {
  const f = fixture([], 20_000); // the task budget is 10,000 tokens
  try {
    await f.o.drive(f.id, { live: true });
    const [worker] = f.c.inspect("A").attempts;
    assert.equal(worker.state, "SUCCEEDED");
    assert.equal(
      JSON.parse(f.c.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", worker.id)!.body).tokens,
      20_000,
    );
    assert.equal(f.c.budgetHold("A"), "EXECUTION_BUDGET_EXHAUSTED");
    for (const role of ["worker", "reviewer"] as const)
      assert.throws(
        () => f.c.reserve("A", { role, requestKey: randomUUID() }, f.c.localActor()),
        /EXECUTION_BUDGET_EXHAUSTED/,
      );
  } finally {
    f.close();
  }
});

test("F4: an unknown run with unobserved usage blocks the budget until reconciliation states it", async () => {
  const f = fixture(["THROW"]);
  try {
    await f.o.drive(f.id, { live: true });
    const unknown = reviewers(f.c)[0];
    assert.equal(unknown.state, "UNKNOWN");
    assert.equal(unknown.observedUsage, undefined);
    const reconcile = (
      id: string,
      usage?: { costUsd: number; tokens: number },
    ) => {
      f.c.addEvidence(
        {
          id,
          taskId: "A",
          kind: "LOCAL",
          uri: "local-assessment:" + id,
          revision: "r1",
          digest: "0".repeat(64),
          retrievedAt: new Date().toISOString(),
          authorityTier: "UNVERIFIED",
          authentication: "LOCAL_IMPORT",
          currentness: "CURRENT_AT_RETRIEVAL",
          claims: ["test"],
          metadata: {
            runId: unknown.id,
            reconciliation: {
              processStopped: true,
              externalEffects: "NONE",
              assessment: "crash",
              ...(usage ? { usage } : {}),
            },
          },
        },
        f.c.localActor(),
      );
      f.c.reconcile(unknown.id, "FAILED", id, f.c.localActor());
    };
    // N1: without stated usage the run stays UNKNOWN (so it can still be
    // reconciled) and the budget stays held.
    assert.throws(() => reconcile("r-1"), /RECONCILIATION_USAGE_REQUIRED/);
    assert.equal(reviewers(f.c)[0].state, "UNKNOWN");
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "reviewer", requestKey: randomUUID() },
          f.c.localActor(),
        ),
      /UNKNOWN_USAGE_REQUIRES_RECONCILIATION|REVIEW_IN_PROGRESS/,
    );
    reconcile("r-1b", { costUsd: 0.02, tokens: 50 });
    assert.equal(reviewers(f.c)[0].state, "FAILED");
    assert.deepEqual(reviewers(f.c)[0].reconciledUsage, {
      costUsd: 0.02,
      tokens: 50,
    });
  } finally {
    f.close();
  }
  const g = fixture(["THROW", "PASS"]);
  try {
    await g.o.drive(g.id, { live: true });
    const unknown = reviewers(g.c)[0];
    g.c.addEvidence(
      {
        id: "r-2",
        taskId: "A",
        kind: "LOCAL",
        uri: "local-assessment:r-2",
        revision: "r1",
        digest: "0".repeat(64),
        retrievedAt: new Date().toISOString(),
        authorityTier: "UNVERIFIED",
        authentication: "LOCAL_IMPORT",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: ["test"],
        metadata: {
          runId: unknown.id,
          reconciliation: {
            processStopped: true,
            externalEffects: "NONE",
            assessment: "crash",
            usage: { costUsd: 0.05, tokens: 500 },
          },
        },
      },
      g.c.localActor(),
    );
    g.c.reconcile(unknown.id, "FAILED", "r-2", g.c.localActor());
    await g.o.drive(g.id, { live: true });
    assert.equal(g.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    g.close();
  }
});

test("N2: a revised specification with identical output bytes gets a fresh review", async () => {
  const f = fixture(["LIMITED", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews.length, 1);
    const next = {
      ...f.c.task("A"),
      specVersion: 2,
      artifactRevision: "r2",
      scope: "greeting v2",
    };
    f.c.revise("A", next, f.c.localActor());
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "v2",
        sourceRef: "test:v2",
      },
      f.c.localActor(),
    );
    const request = f.o.submit({
      requestKey: randomUUID(),
      prompt: "v2",
      context: { cwd: f.root },
      sourceRef: "test:v2",
      taskIds: ["A"],
    });
    await f.o.drive(request.request.id, { live: true });
    const reviews = f.c.inspect("A").reviews;
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].artifactRevision, "r2");
    assert.equal(reviews[1].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("N3: a reviewer reservation that never started does not block review", async () => {
  const f = fixture(["PASS"]);
  try {
    // Run only the worker, then reserve a reviewer that is never executed.
    const worker = f.c.reserve(
      "A",
      { requestKey: randomUUID() },
      f.c.localActor(),
    );
    await f.c.execute(worker, f.live, f.c.localActor());
    const stray = f.c.reserve(
      "A",
      { role: "reviewer", requestKey: randomUUID() },
      f.c.localActor(),
    );
    f.c.recover(f.c.localActor(), Date.now() + 10 * 60_000);
    assert.equal(
      f.c.inspect("A").attempts.find((a: { id: string }) => a.id === stray.id)
        .state,
      "NOT_STARTED",
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("N6: an operator attachment does not hide a later agent owner", () => {
  const f = fixture([]);
  try {
    f.c.importTasks([{ ...f.c.task("A"), id: "B" }], f.c.localActor());
    const submit = (o: Orchestrator) =>
      o.submit({
        requestKey: randomUUID(),
        prompt: "b",
        context: { cwd: f.root },
        sourceRef: "t",
        taskIds: ["B"],
      });
    submit(new Orchestrator(f.c, {}, "operator"));
    submit(new Orchestrator(f.c, {}, "claude"));
    assert.throws(
      () => submit(new Orchestrator(f.c, {}, "codex")),
      /TASK_BOUND_TO_OTHER_HOST_REQUEST:claude/,
    );
    assert.equal(new Orchestrator(f.c, {}, "codex").taskHost("B"), "claude");
  } finally {
    f.close();
  }
});

test("R3-1: a partially observed usage still requires stated usage to reconcile", async () => {
  for (const outcome of ["NULL_USAGE", "NULL_COST", "NULL_TOKENS"] as const) {
    const f = fixture([outcome]);
    try {
      await f.o.drive(f.id, { live: true });
      const run = reviewers(f.c)[0];
      assert.equal(run.state, "UNKNOWN", outcome);
      assert.ok(run.observedUsage, outcome);
      const reconcile = (
        id: string,
        usage?: { costUsd: number; tokens: number },
      ) => {
        f.c.addEvidence(
          {
            id,
            taskId: "A",
            kind: "LOCAL",
            uri: "local-assessment:" + id,
            revision: "r1",
            digest: "0".repeat(64),
            retrievedAt: new Date().toISOString(),
            authorityTier: "UNVERIFIED",
            authentication: "LOCAL_IMPORT",
            currentness: "CURRENT_AT_RETRIEVAL",
            claims: ["test"],
            metadata: {
              runId: run.id,
              reconciliation: {
                processStopped: true,
                externalEffects: "NONE",
                assessment: "crash",
                ...(usage ? { usage } : {}),
              },
            },
          },
          f.c.localActor(),
        );
        f.c.reconcile(run.id, "FAILED", id, f.c.localActor());
      };
      assert.throws(() => reconcile("p-1"), /RECONCILIATION_USAGE_REQUIRED/);
      assert.equal(reviewers(f.c)[0].state, "UNKNOWN");
      reconcile("p-2", { costUsd: 0.01, tokens: 10 });
      assert.equal(reviewers(f.c)[0].state, "FAILED");
    } finally {
      f.close();
    }
  }
});

test("R3-2: the same request resumes review after a recovered reviewer reservation", async () => {
  const f = fixture(["PASS"]);
  try {
    const worker = f.c.reserve(
      "A",
      { requestKey: randomUUID() },
      f.c.localActor(),
    );
    await f.c.execute(worker, f.live, f.c.localActor());
    // Reserve with the exact key the orchestrator derives, then crash before launch.
    const key =
      "workflow:" +
      digest({
        requestId: f.id,
        taskId: "A",
        spec: specDigest(f.c.task("A")),
        worker: worker.id,
        role: "reviewer",
      });
    f.c.reserve("A", { role: "reviewer", requestKey: key }, f.c.localActor());
    f.c.recover(f.c.localActor(), Date.now() + 10 * 60_000);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews[0]?.verdict, "PASS");
  } finally {
    f.close();
  }
});

test("R5-1: reviewer runs refused before launch take no review slot and stop the retry loop", async () => {
  const f = fixture(["REFUSED", "REFUSED", "REFUSED", "PASS"]);
  try {
    // Each advance makes one refused attempt, then stops instead of retrying.
    for (let i = 1; i <= 3; i++) {
      await f.o.drive(f.id, { live: true });
      const states = reviewers(f.c).map((a: { state: string }) => a.state);
      assert.deepEqual(states, Array(i).fill("NOT_STARTED"));
      assert.equal(f.c.inspect("A").reviews.length, 0);
    }
    // Once the barrier is gone, the same request still gets its review.
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews[0]?.verdict, "PASS");
  } finally {
    f.close();
  }
});

// Changed for source packs review r2 R5: a run cancelled or
// timed out before launch is a known non-launch too.
test("R5-1: a not-launched receipt must be a zero-usage failure, cancellation or timeout", () => {
  const base = {
    runId: "r",
    taskId: "A",
    provider: "codex",
    model: "m",
    effort: "low",
    sessionId: "s",
    exitCode: null,
    status: "FAILED",
    startedAt: now,
    endedAt: now,
    output: "x",
    tests: [],
    costUsd: 0,
    tokens: 0,
    identityVerified: false,
    simulation: false,
    notLaunched: true,
  };
  assert.equal(validateProviderReceipt(base).notLaunched, true);
  assert.throws(() => validateProviderReceipt({ ...base, tokens: 10 }));
  for (const status of ["CANCELLED", "TIMED_OUT"])
    assert.equal(validateProviderReceipt({ ...base, status }).notLaunched, true);
  for (const status of ["SUCCEEDED", "UNKNOWN"])
    assert.throws(() => validateProviderReceipt({ ...base, status }));
  assert.throws(() =>
    validateProviderReceipt({ ...base, status: "CANCELLED", costUsd: 0.01 }),
  );
});


test("pre-upgrade worker attempts retain their original whole-project macro contract", async () => {
  const f = fixture(["PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    const current = f.c.inspect("A");
    const worker = current.attempts.find((a: { role: string; state: string }) =>
      a.role === "worker" && a.state === "SUCCEEDED")!;
    const reviewer = reviewers(f.c).at(-1)!;
    // Model a saved v1 attempt, which has no macroScopeVersion field and whose
    // exact baseline used all other task specifications and holds. No history
    // is rewritten by the implementation; only this disposable test DB is.
    const saved = f.c.db.get<{ body: string }>(
      "SELECT body FROM attempts WHERE id=?", worker.id,
    )!;
    const old = JSON.parse(saved.body);
    delete old.macroScopeVersion;
    delete old.macroBaselineRelated;
    old.macroBaseline = (f.c as any).legacyMacro(current.task);
    f.c.db.run("UPDATE attempts SET body=? WHERE id=?", JSON.stringify(old), worker.id);
    const sibling = TaskSchema.parse({
      ...current.task,
      id: "B",
      status: "DISCOVERED",
      sources: [],
      specificationAuthenticated: false,
    });
    f.c.importTasks([sibling], f.c.localActor());
    const record = f.c.audit("A", f.c.localActor(), reviewer.id)
      .find((x: { kind: string }) => x.kind === "MACRO_ANTI_DRIFT")!;
    assert.equal(record.result, "FAIL");
    assert.deepEqual(record.checks, ["OTHER_TASK_SPEC_OR_HOLD_CHANGED_RECONCILE"]);
    assert.equal(record.macroScopeVersion, undefined, "legacy audit is not silently upgraded");
  } finally {
    f.close();
  }
});


test("separate code worktrees still share eventual repository target paths", () => {
  const f = fixture(["PASS"]);
  try {
    const original = f.c.task("A");
    const repo = { name: "orchestrator", commit: "a".repeat(40) };
    const reader = { ...original, repo };
    const before = (f.c as any).macro(reader, { macroScopeVersion: 2 });
    // Exercise pure peer classification without registering a code task:
    // the fixture deliberately has no trusted repository configuration, and
    // importing such a task would rightfully fail UNKNOWN_REPO.
    const writer = TaskSchema.parse({
      ...original,
      id: "CODE_WRITER",
      status: "DISCOVERED",
      sources: [],
      specificationAuthenticated: false,
      repo: { name: "orchestrator", commit: "b".repeat(40) },
      writePaths: ["output/A/part"],
    });
    const originalTasks = f.c.tasks.bind(f.c);
    try {
      (f.c as any).tasks = () => [reader, writer];
      assert.notEqual(before, (f.c as any).macro(reader, { macroScopeVersion: 2 }));
      assert.ok((f.c as any).macroPeers(reader)[0]?.why.includes("SHARED_REPO_TARGET_PATH"));
      const otherRepo = { ...reader, repo: { name: "other", commit: "a".repeat(40) } };
      assert.equal((f.c as any).macroPeers(otherRepo).length, 0);
      // Both stage Drive files locally; that folder is not a repository path.
      (f.c as any).tasks = () => [
        { ...reader, writePaths: ["drive-changes"] },
        { ...writer, writePaths: ["drive-changes"] },
      ];
      assert.equal((f.c as any).macroPeers({ ...reader, writePaths: ["drive-changes"] }).length, 0);
    } finally {
      (f.c as any).tasks = originalTasks;
    }
  } finally {
    f.close();
  }
});


/** A Drive record as the live runner's gateway writes it, by run ID. */
function driveLog(root: string, runId: string, entries: object[]) {
  mkdirSync(join(root, runId), { recursive: true });
  writeFileSync(
    join(root, runId, "log.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}
/** A worker run of a task, saved as the controller saves one, with its Drive record. */
function driveRun(
  c: Controller,
  root: string,
  task: { id: string; artifactRevision: string },
  entries: object[] | undefined,
  state = "SUCCEEDED",
  extra: Record<string, unknown> = {},
) {
  const id = randomUUID(),
    at = new Date().toISOString();
  c.db.run(
    "INSERT INTO attempts VALUES(?,?,?,?,?,?,?)",
    id,
    task.id,
    "worker",
    state,
    "test",
    0,
    JSON.stringify({
      id,
      taskId: task.id,
      role: "worker",
      state,
      startedAt: at,
      ...(state === "SUCCEEDED" ? { finishedAt: at } : {}),
      specDigest: specDigest(task as never),
      artifactRevision: task.artifactRevision,
      ...extra,
    }),
  );
  if (entries) driveLog(root, id, entries);
  return id;
}
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
/** A read the gateway logged: the version it got. */
const read = (fileId: string, ms: number, version: number, op = "read") => ({
  at: later(ms),
  op,
  ok: true,
  fileId,
  meta: { version: String(version) },
});
/** A write the gateway logged: the version it made. */
const write = (
  fileId: string,
  ms: number,
  version?: number,
  op = "update",
  parents?: string[],
) => ({
  at: later(ms),
  op,
  ok: true,
  ...(op === "update" ? { written: true } : {}),
  fileId,
  ...(version !== undefined ? { versionAfter: String(version) } : {}),
  ...(parents ? { meta: { parents } } : {}),
});
/** Another task that may write Drive, as a Drive task must be registered. */
const driveWriter = (
  base: Record<string, unknown>,
  id: string,
  drive: { update: string[]; createIn: string[] },
) =>
  TaskSchema.parse({
    ...base,
    id,
    status: "DISCOVERED",
    sources: [],
    specificationAuthenticated: false,
    operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
    writePaths: ["output/A", "drive-changes"],
    drive: { read: "ANY", ...drive },
  });
const workerRuns = (c: Controller, taskId: string) =>
  c.db
    .all<{ body: string }>("SELECT body FROM attempts WHERE task_id=? AND role='worker' ORDER BY rowid", taskId)
    .map((r) => JSON.parse(r.body));

test("S02 records then pointers: only another task's actual write to a file the audited run used holds the macro audit", async () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    // The records task is a Drive task (as in the existing Drive-worker test).
    const plain = f.c.inspect("A").task;
    const records = TaskSchema.parse({
      ...plain,
      specVersion: 2,
      dimensions: { ...plain.dimensions, authorization: "EXPLICIT" },
      complexity: { level: "ROUTINE", rationale: "test fixture", sourceRef: "test" },
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: { read: "ANY", update: ["1WORKREGISTERFILE0"], createIn: [] },
    });
    f.c.revise("A", records, f.c.localActor());
    f.c.grant("A", { id: randomUUID(), operations: records.operations, paths: ["output/A", "drive-changes"], decisionText: "test", sourceRef: "test" }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    await f.o.drive(f.id, { live: true });
    const worker = f.c
      .inspect("A")
      .attempts.find((a: { role: string; state: string }) => a.role === "worker" && a.state === "SUCCEEDED")!;
    const reviewer = reviewers(f.c).at(-1)!;
    const REGISTER = "1WORKREGISTERFILE0",
      OTHER = "1UNRELATEDDRIVEFILE";
    // The records run read the work register at version 3 and wrote version 4.
    driveLog(audit, worker.id, [read(REGISTER, 0, 3), write(REGISTER, 1, 4)]);
    const macro = () =>
      f.c.audit("A", f.c.localActor(), reviewer.id).find((x: { kind: string }) => x.kind === "MACRO_ANTI_DRIFT")!;
    assert.equal(macro().result, "PASS", JSON.stringify(macro()));
    const clean = f.c.macroState("A") as { digest: string };
    // The pointer task is registered and granted: no Drive file changed.
    f.c.importTasks([driveWriter(f.c.task("A"), "P", { update: [REGISTER, OTHER], createIn: [] })], f.c.localActor());
    f.c.grant("P", {
      id: randomUUID(), operations: ["READ_DRIVE", "WRITE_DRIVE"], paths: ["drive-changes"],
      decisionText: "pointer edits", sourceRef: "test:owner",
    }, f.c.localActor());
    assert.equal(macro().result, "PASS", "a grant or status change writes nothing");
    driveRun(f.c, audit, f.c.task("P"), [write(OTHER, 1_000, 9)]);
    assert.equal(macro().result, "PASS", "a file the records run never used");
    assert.equal((f.c.macroState("A") as { digest: string }).digest, clean.digest, "nothing moved the state either");
    driveRun(f.c, audit, f.c.task("P"), [write(REGISTER, 2_000, 5)]);
    const failed = macro();
    assert.equal(failed.result, "FAIL");
    assert.deepEqual(failed.checks, ["OTHER_TASK_WROTE_SHARED_DRIVE_FILE_RECONCILE"]);
    // The orchestrator's audit step key follows this state, so it audits again.
    const drifted = f.c.macroState("A") as { digest: string; acknowledged: boolean };
    assert.equal(drifted.acknowledged, false);
    assert.deepEqual(
      failed.macroDrift!.driveWrites.map((w: any) => [w.taskId, w.op, w.fileId]),
      [["P", "update", REGISTER]],
    );
    // The operator reconciles that exact write; the audit says it passed on that record.
    const ack = f.c.acknowledgeDrift("A", {
      runId: worker.id, reason: "Checked: the pointer edit left the records section unchanged", sourceRef: "test:operator",
    }, f.c.localActor());
    assert.equal(ack.driveWrites?.length, 1);
    const passed = macro();
    assert.equal(passed.result, "PASS");
    assert.equal(passed.macroDrift!.acknowledged, true);
    assert.deepEqual(
      { ...(f.c.macroState("A") as object), after: undefined },
      { digest: drifted.digest, acknowledged: true, after: undefined },
    );
    // A later write is not covered by that record.
    driveRun(f.c, audit, f.c.task("P"), [write(REGISTER, 3_000, 6)]);
    assert.equal(macro().result, "FAIL");
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("a write between the first run and its rework still counts against the reworked work (rereview R1)", () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    const base = f.c.task("A");
    const F = "1SHAREDSOURCEFILE0";
    f.c.importTasks([
      TaskSchema.parse({
        ...base, id: "R", status: "DISCOVERED", sources: [], specificationAuthenticated: false,
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"], writePaths: ["output/A", "drive-changes"],
        drive: { read: "ANY", update: [], createIn: [] },
      }),
      driveWriter(base, "W", { update: [F], createIn: [] }),
    ], f.c.localActor());
    const t0 = later(-60_000), t1 = later(-30_000), t2 = later(-10_000);
    // The first run read F at version 2; W then changed F; the rework,
    // reserved after that, carries the first run's work and never reads F.
    driveRun(f.c, audit, f.c.task("R"), [{ ...read(F, 0, 2), at: t0 }], "SUCCEEDED", { macroBaselineAt: t0 });
    driveRun(f.c, audit, f.c.task("W"), [{ ...write(F, 0, 3), at: t1 }], "SUCCEEDED", { startedAt: t1, finishedAt: t1 });
    const rework = driveRun(f.c, audit, f.c.task("R"), [], "SUCCEEDED", { macroBaselineAt: t2, rework: true });
    const writes = (f.c as any).driveWrites(f.c.task("R"), { id: rework, macroBaselineAt: t2 });
    assert.deepEqual(writes.map((w: any) => [w.taskId, w.op, w.fileId]), [["W", "update", F]]);
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("Drive writes count by what the work used: versions, folders, searches, sources, filings, and missing or open records", async () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    const base = f.c.task("A");
    const FOLDER = "1LISTEDFOLDER00000",
      ELSEWHERE = "1OTHERFOLDER000000",
      FILE = "1READFILE000000000",
      SOURCE = "1BOUNDSOURCEFILE00";
    const driveBase = {
      ...base,
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: { read: "ANY", update: [], createIn: [] },
    };
    f.c.importTasks([
      driveWriter(base, "W", { update: [FILE, SOURCE], createIn: [FOLDER, ELSEWHERE] }),
      driveWriter(base, "QUIET", { update: ["1NEVERUSED00000000"], createIn: [] }),
    ], f.c.localActor());
    const since = new Date().toISOString();
    const writes = (t: object) =>
      (f.c as any).driveWrites(t, { macroBaselineAt: since }).map((w: any) => [w.taskId, w.op, w.fileId]);
    // Readers are registered Drive tasks, as every run's task is.
    const readerTask = (id: string) => {
      f.c.importTasks([TaskSchema.parse({
        ...driveBase, id, status: "DISCOVERED", sources: [], specificationAuthenticated: false,
      })], f.c.localActor());
      return f.c.task(id);
    };
    // A reader that listed a folder and read FILE at version 3.
    const reader = readerTask("R1");
    driveRun(f.c, audit, reader, [read(FOLDER, 0, 1, "list"), read(FILE, 0, 3)]);
    driveRun(f.c, audit, f.c.task("W"), [
      write("1NEWINLISTED000000", 1_000, 1, "create", [FOLDER]),
      write("1NEWELSEWHERE00000", 1_000, 1, "create", [ELSEWHERE]),
      write(FILE, 1_000, 4),
    ]);
    assert.deepEqual(writes(reader).sort(), [
      ["W", "create", "1NEWINLISTED000000"],
      ["W", "update", FILE],
    ]);
    // A full-text search can change with any write: creates anywhere and
    // updates to files it never read (Codex P1 on ae063c7).
    const searcher = readerTask("R2");
    driveRun(f.c, audit, searcher, [{ at: later(0), op: "search", ok: true }]);
    assert.deepEqual(writes(searcher).map((w: string[]) => w[2]).sort(), ["1NEWELSEWHERE00000", "1NEWINLISTED000000", FILE]);
    // Versions decide, not start times: a read of version 4 saw the write;
    // a read logged after the write began that still got version 3 did not (R7).
    const late = readerTask("R3");
    driveRun(f.c, audit, late, [read(FILE, 5_000, 4)]);
    assert.deepEqual(writes(late), []);
    const racing = readerTask("R3B");
    driveRun(f.c, audit, racing, [read(FILE, 1_500, 3)]);
    assert.deepEqual(writes(racing), [["W", "update", FILE]]);
    // A later run outside the audited chain does not count as a sight (R3).
    const chained = readerTask("R3C");
    const sealed = driveRun(f.c, audit, chained, [read(FILE, 0, 3)]);
    driveRun(f.c, audit, chained, [read(FILE, 5_000, 4)]);
    assert.deepEqual(
      (f.c as any).driveWrites(chained, { id: sealed, macroBaselineAt: since }).map((w: any) => w.fileId),
      [FILE],
    );
    // A run of the reader with no readable record: every write counts,
    // even one a later run of the work read past (Codex P1 on 6258ef2).
    const blind = readerTask("R4");
    const lost = driveRun(f.c, audit, blind, [read(FILE, 0, 3)]);
    writeFileSync(join(audit, lost, "log.jsonl"), "{not json\n");
    driveRun(f.c, audit, blind, [read(FILE, 5_000, 4)]);
    assert.equal(writes(blind).length, 3);
    // An authenticated bound source counts by its file, also with no Drive policy.
    const evidence = (id: string, authentication: string) => {
      f.c.addEvidence({
        id, taskId: "A", kind: "DRIVE", uri: "drive-record:" + SOURCE, revision: "v1",
        digest: "a".repeat(64), retrievedAt: new Date().toISOString(), authorityTier: "PLANNING",
        authentication, currentness: "CURRENT_AT_RETRIEVAL", claims: ["read file"],
        metadata: { fileId: SOURCE },
      }, f.c.localActor());
      return { evidenceId: id, revision: "v1", digest: "a".repeat(64) };
    };
    const sourced = { ...base, id: "R5", drive: undefined, sources: [evidence("auth-src", "AUTHENTICATED_CONNECTOR")] };
    assert.deepEqual(writes(sourced), []);
    driveRun(f.c, audit, f.c.task("W"), [write(SOURCE, 2_000, 7)]);
    assert.deepEqual(writes(sourced), [["W", "update", SOURCE]]);
    // An unauthenticated identity cannot rule any write out.
    const unsure = { ...base, id: "R6", drive: undefined, sources: [evidence("local-src", "LOCAL_IMPORT")] };
    assert.equal(writes(unsure).length, 4);
    // The task's own filing, even one refused because the file changed,
    // never counts as a sight of the write (R2).
    f.c.db.event("DRIVE_FILED", "R1", {
      id: "own-filing", results: [{ op: "update", fileId: FILE, error: "CHANGED_SINCE_WORKER_READ: version 3" }],
    });
    assert.ok(writes(reader).some((w: string[]) => w[2] === FILE));
    // A run reconciled from unknown, started before the baseline, wrote after it (R4).
    driveRun(f.c, audit, f.c.task("W"), [write(FILE, 6_000, 8)], "FAILED", {
      startedAt: new Date(Date.parse(since) - 60_000).toISOString(),
      unknownAt: since,
    });
    assert.ok(writes(late).some((w: string[]) => w[0] === "W" && w[2] === FILE), "W's version 8 is newer than 4");
    // A write whose outcome the record leaves open is uncertain (R5).
    const ambiguous = readerTask("R8");
    driveRun(f.c, audit, ambiguous, [read(SOURCE, 0, 7)]);
    driveRun(f.c, audit, f.c.task("W"), [
      { at: later(7_000), op: "update", ok: false, fileId: SOURCE, error: "DRIVE_WRITE_AMBIGUOUS: socket hang up" },
      { at: later(7_000), op: "update", ok: false, fileId: SOURCE, error: "CHANGED_SINCE_READ: version 7 was read" },
    ]);
    assert.deepEqual(writes(ambiguous), [["W", "UNCERTAIN", SOURCE]]);
    // A filing recorded, read from its own record.
    driveLog(audit, "filing-done", [write(FILE, 8_000, 9)]);
    f.c.db.event("DRIVE_FILED", "W", { id: "done", auditDir: join(audit, "filing-done"), results: [{ op: "update", fileId: FILE }] });
    assert.ok(writes(late).some((w: string[]) => w[0] === "W" && w[2] === FILE && w[1] === "update"));
    // A filing never recorded (still going, or stopped mid-way), found by its claims (R6).
    const fresh = readerTask("R9");
    driveRun(f.c, audit, fresh, [read(FOLDER, 9_000, 1, "list")]);
    driveLog(audit, "filing-midway", [write("1MIDWAYNEWFILE0000", 10_000, 1, "create", [FOLDER])]);
    f.c.db.run(
      "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      randomUUID(), "CLAIM", "drive:folder:" + FOLDER, "filing", "midway", "W", "x", "HELD", null, new Date().toISOString(), "{}",
    );
    assert.deepEqual(writes(fresh).filter((w: string[]) => w[1] !== "create" || w[2] === "1MIDWAYNEWFILE0000").filter((w: string[]) => w[2] !== "1NEWINLISTED000000"), [
      ["W", "UNCERTAIN", null],
      ["W", "create", "1MIDWAYNEWFILE0000"],
    ]);
    // A started run of a Drive task whose record folder is missing lost its
    // record; it did not make no calls.
    const lostReader = readerTask("R10");
    driveRun(f.c, audit, lostReader, undefined, "SUCCEEDED", { started: true });
    assert.ok(writes(lostReader).length >= 5, "every write counts");
    const lostWriter = driveRun(f.c, audit, f.c.task("W"), undefined, "SUCCEEDED", { started: true });
    assert.ok(
      (f.c as any).driveWrites(reader, { macroBaselineAt: since }).some((w: any) => w.by === "run:" + lostWriter && w.op === "UNCERTAIN"),
    );
    // Without versions, a write that began shortly before the baseline can
    // have landed after it; one long before cannot.
    const G = "1NOVERSIONFILE0000";
    const unversioned = readerTask("R11");
    driveRun(f.c, audit, unversioned, [{ at: later(0), op: "read", ok: true, fileId: G }]);
    f.c.importTasks([driveWriter(base, "W2", { update: [G], createIn: [] })], f.c.localActor());
    driveRun(f.c, audit, f.c.task("W2"), [
      { ...write(G, 0), at: new Date(Date.parse(since) - 5 * 60_000).toISOString() },
      { ...write(G, 0), at: new Date(Date.parse(since) - 30 * 60_000).toISOString() },
    ]);
    assert.equal(writes(unversioned).filter((w: string[]) => w[0] === "W2").length, 1);
    // A writer still running is uncertain when its scope meets the reader's files.
    driveRun(f.c, audit, f.c.task("W"), undefined, "STARTED");
    driveRun(f.c, audit, f.c.task("QUIET"), undefined, "STARTED");
    assert.deepEqual(
      (f.c as any)
        .driveWrites(reader, { macroBaselineAt: since })
        .filter((w: any) => w.op === "UNCERTAIN" && w.by.startsWith("run:"))
        .map((w: any) => w.taskId)
        .filter((id: string, i: number, all: string[]) => all.indexOf(id) === i),
      ["W"],
      "W's open run meets the reader's files; QUIET's does not",
    );
    // A task with no Drive files is untouched by any of it.
    assert.deepEqual(writes({ ...base, id: "R7", drive: undefined }), []);
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("round 4: a write's own version, lost writes in intents, sources from retrieval, and old dead writers", async () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    const base = f.c.task("A");
    const F = "1ROUNDFOURFILE0000",
      SRC = "1ROUNDFOURSOURCE00";
    const since = new Date().toISOString();
    const reader = (id: string) => {
      f.c.importTasks([TaskSchema.parse({
        ...base, id, status: "DISCOVERED", sources: [], specificationAuthenticated: false,
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"], writePaths: ["output/A", "drive-changes"],
        drive: { read: "ANY", update: [], createIn: [] },
      })], f.c.localActor());
      return f.c.task(id);
    };
    f.c.importTasks([driveWriter(base, "W", { update: [F, SRC], createIn: [] })], f.c.localActor());
    const writes = (t: object) =>
      (f.c as any).driveWrites(t, { macroBaselineAt: since }).map((w: any) => [w.taskId, w.op, w.fileId]);
    // N1: an applied update whose follow-up metadata call failed has only
    // the version before it; that is not the version it made.
    const r1 = reader("N1");
    driveRun(f.c, audit, r1, [read(F, 0, 10)]);
    const w1 = driveRun(f.c, audit, f.c.task("W"), [
      { at: later(1_000), op: "update", ok: false, written: true, fileId: F, versionBefore: "10", error: "aborted" },
    ]);
    assert.deepEqual(writes(r1), [["W", "update", F]]);
    rmSync(join(audit, w1), { recursive: true, force: true });
    f.c.db.run("DELETE FROM attempts WHERE id=?", w1);
    // N2: a writer killed mid-write, then reconciled, left only its intent.
    const r2 = reader("N2");
    driveRun(f.c, audit, r2, [read(F, 0, 10)]);
    const killed = driveRun(f.c, audit, f.c.task("W"), [read(F, 500, 10)], "FAILED", { unknownAt: later(2_000) });
    const intent = (holder: string, state: string, body: object) =>
      f.c.db.run(
        "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        randomUUID(), "INTENT", "drive:file:" + F, "run", holder, "W", "x", state, null, later(1_000),
        JSON.stringify({ write: { kind: "update", fileId: F }, sentAt: later(1_000), ...body }),
      );
    intent(killed, "OPEN", {});
    assert.deepEqual(writes(r2), [["W", "UNCERTAIN", F]]);
    f.c.db.run("DELETE FROM resource_claims WHERE holder_id=?", killed);
    intent(killed, "RESOLVED", { outcome: "APPLIED", endedAt: later(1_100) });
    assert.deepEqual(writes(r2), [["W", "update", F]], "applied, but missing from its log");
    f.c.db.run("DELETE FROM resource_claims WHERE holder_id=?", killed);
    intent(killed, "RESOLVED", { outcome: "NOT_APPLIED", endedAt: later(1_100) });
    assert.deepEqual(writes(r2), []);
    f.c.db.run("DELETE FROM resource_claims WHERE holder_id=?", killed);
    // N3: a bound source counts writes from its retrieval, before the run.
    const retrieved = new Date(Date.parse(since) - 100 * 60_000).toISOString();
    f.c.addEvidence({
      id: "n3-src", taskId: "A", kind: "DRIVE", uri: "drive-record:" + SRC, revision: "rev-abc",
      digest: "b".repeat(64), retrievedAt: retrieved, authorityTier: "PLANNING",
      authentication: "AUTHENTICATED_CONNECTOR", currentness: "CURRENT_AT_RETRIEVAL",
      claims: ["read file"], metadata: { fileId: SRC },
    }, f.c.localActor());
    const halfway = new Date(Date.parse(since) - 50 * 60_000).toISOString();
    driveRun(f.c, audit, f.c.task("W"), [{ ...write(SRC, 0, 5), at: halfway }], "SUCCEEDED", {
      startedAt: halfway, finishedAt: halfway,
    });
    const sourced = { ...base, id: "N3", drive: undefined, sources: [{ evidenceId: "n3-src", revision: "rev-abc", digest: "b".repeat(64) }] };
    assert.deepEqual(writes(sourced), [["W", "update", SRC]]);
    // N4: a filing that died and was released long ago, and an old run
    // reconciled from unknown whose record is now unreadable, are passed over.
    const r4 = reader("N4");
    driveRun(f.c, audit, r4, [read(F, 0, 10)]);
    const old = new Date(Date.parse(since) - 30 * 86_400_000).toISOString();
    f.c.db.run(
      "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      randomUUID(), "CLAIM", "drive:file:" + F, "filing", "deadfiling", "W", specDigest(f.c.task("W")), "RELEASED",
      Date.parse(old) + 60_000, old, "{}",
    );
    const stale = driveRun(f.c, audit, f.c.task("W"), [read(F, 0, 9)], "FAILED", {
      startedAt: old, unknownAt: old, finishedAt: old,
    });
    writeFileSync(join(audit, stale, "log.jsonl"), "{not json\n");
    assert.deepEqual(writes(r4), []);
    // The same run settled only now may have written until now.
    f.c.db.event("UNKNOWN_RECONCILED", "W", { runId: stale });
    assert.deepEqual(writes(r4), [["W", "UNCERTAIN", null]]);
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("round 5: a revised writer's lost record, applied intents by count, launches and half-written lines", async () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    const base = f.c.task("A");
    const F = "1ROUNDFIVEFILE0000";
    const since = new Date().toISOString();
    f.c.importTasks([
      TaskSchema.parse({
        ...base, id: "R", status: "DISCOVERED", sources: [], specificationAuthenticated: false,
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"], writePaths: ["output/A", "drive-changes"],
        drive: { read: "ANY", update: [], createIn: [] },
      }),
      driveWriter(base, "W", { update: [F], createIn: [] }),
    ], f.c.localActor());
    driveRun(f.c, audit, f.c.task("R"), [read(F, 0, 10)]);
    const writes = () =>
      (f.c as any).driveWrites(f.c.task("R"), { macroBaselineAt: since }).map((w: any) => [w.taskId, w.op, w.fileId]);
    const claim = (runId: string) =>
      f.c.db.run(
        "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        randomUUID(), "CLAIM", "drive:file:" + F, "run", runId, "W", specDigest(f.c.task("W")), "RUN", null, later(0), "{}",
      );
    // M1: a started run whose record folder is gone stays lost after its
    // task is revised; it held Drive claims.
    const lost = driveRun(f.c, audit, f.c.task("W"), undefined, "SUCCEEDED", { started: true });
    claim(lost);
    assert.deepEqual(writes(), [["W", "UNCERTAIN", null]]);
    const w = f.c.task("W");
    f.c.revise("W", { ...w, specVersion: w.specVersion + 1, scope: "reworded" }, f.c.localActor());
    assert.deepEqual(writes(), [["W", "UNCERTAIN", null]], "still lost after the revision");
    f.c.db.run("DELETE FROM resource_claims WHERE holder_id=?", lost);
    f.c.db.run("DELETE FROM attempts WHERE id=?", lost);
    // A revised task's earlier run with no record and no Drive claims never
    // had Drive: nothing.
    const plain = driveRun(f.c, audit, w, undefined, "SUCCEEDED", { started: true });
    assert.deepEqual(writes(), []);
    f.c.db.run("DELETE FROM attempts WHERE id=?", plain);
    // Applied intents match logged writes one for one: two applied updates,
    // one logged (and seen by the reader's later read), the other lost.
    const two = driveRun(f.c, audit, f.c.task("W"), [write(F, 1_000, 11)]);
    for (const ms of [1_000, 2_000])
      f.c.db.run(
        "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        randomUUID(), "INTENT", "drive:file:" + F, "run", two, "W", "x", "RESOLVED", null, later(ms),
        JSON.stringify({ write: { kind: "update", fileId: F }, sentAt: later(ms), outcome: "APPLIED" }),
      );
    assert.deepEqual(writes(), [["W", "update", F], ["W", "update", F]]);
    f.c.db.run("DELETE FROM resource_claims WHERE holder_id=?", two);
    f.c.db.run("DELETE FROM attempts WHERE id=?", two);
    // A reservation not yet launched has written nothing.
    const reserved = driveRun(f.c, audit, f.c.task("W"), undefined, "RESERVED");
    assert.deepEqual(writes(), []);
    f.c.db.run("DELETE FROM attempts WHERE id=?", reserved);
    // A running writer that created a file the reader then read can still
    // update it (a writer may update its creations): uncertain while it runs
    // (Codex P1 on 9702bf0).
    f.c.importTasks([driveWriter(base, "CREATOR", { update: [], createIn: ["1CREATORFOLDER0000"] })], f.c.localActor());
    const NEWF = "1CREATEDBYRUNNING0";
    const creating = driveRun(f.c, audit, f.c.task("CREATOR"), [write(NEWF, 500, 1, "create", ["1CREATORFOLDER0000"])], "STARTED", { started: true });
    const r5 = { ...f.c.task("R"), id: "R" };
    driveRun(f.c, audit, f.c.task("R"), [read(NEWF, 900, 1)]);
    assert.deepEqual(
      (f.c as any).driveWrites(r5, { macroBaselineAt: since }).filter((w: any) => w.taskId === "CREATOR").map((w: any) => [w.op, w.by]),
      [["UNCERTAIN", "run:" + creating]],
    );
    f.c.db.run("DELETE FROM attempts WHERE id=?", creating);
    // A running writer's half-written last line does not hide its earlier writes.
    const running = driveRun(f.c, audit, f.c.task("W"), [write(F, 3_000, 12)], "STARTED", { started: true });
    writeFileSync(join(audit, running, "log.jsonl"), JSON.stringify(write(F, 3_000, 12)) + "\n{\"at\":\"2026");
    assert.deepEqual(writes(), [["W", "UNCERTAIN", null], ["W", "update", F]]);
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("the orchestrator audits a scoped run again when its drift changes or returns, and only then", async () => {
  const f = fixture(["PASS"]);
  const audit = mkdtempSync(join(tmpdir(), "longform-drive-audit-"));
  try {
    (f.c.config as { driveAuditRoot?: string }).driveAuditRoot = audit;
    const F = "1REAUDITFILE000000";
    // A Drive task whose acceptance needs Drive evidence, so it stays
    // waiting for review across several advances.
    const base = f.c.inspect("A").task;
    const driveTask = TaskSchema.parse({
      ...base,
      specVersion: 2,
      dimensions: { ...base.dimensions, authorization: "EXPLICIT" },
      complexity: { level: "ROUTINE", rationale: "test fixture", sourceRef: "test" },
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: { read: "ANY", update: [F], createIn: [] },
      acceptance: [{ id: "drive", description: "Drive change", evidenceKind: "DRIVE" }],
    });
    f.c.revise("A", driveTask, f.c.localActor());
    f.c.grant("A", { id: randomUUID(), operations: driveTask.operations, paths: ["output/A", "drive-changes"], decisionText: "test", sourceRef: "test" }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role === "worker") driveLog(audit, request.runId, [read(F, 0, 1)]);
      return receipt;
    };
    f.c.importTasks([driveWriter(f.c.task("A"), "W", { update: [F], createIn: [] })], f.c.localActor());
    const audits = () => f.c.db.all("SELECT 1 FROM audits WHERE task_id='A'").length;
    const macroResult = () =>
      JSON.parse(f.c.db.get<{ body: string }>("SELECT body FROM audits WHERE task_id='A' AND kind='MACRO_ANTI_DRIFT' ORDER BY rowid DESC LIMIT 1")!.body).result;
    await f.o.drive(f.id, { live: true });
    assert.equal(audits(), 3);
    assert.equal(macroResult(), "PASS");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    await f.o.drive(f.id, { live: true });
    assert.equal(audits(), 3, "nothing changed: no new audit");
    // W begins a write to F: held.
    const runW = driveRun(f.c, audit, f.c.task("W"), [], "SUCCEEDED");
    const intentId = randomUUID();
    f.c.db.run(
      "INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      intentId, "INTENT", "drive:file:" + F, "run", runW, "W", "x", "OPEN", null, later(0),
      JSON.stringify({ write: { kind: "update", fileId: F }, sentAt: later(0) }),
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(audits(), 6);
    assert.equal(macroResult(), "FAIL");
    // The write was not applied: back to the clean state, audited again once.
    f.c.db.run(
      "UPDATE resource_claims SET state='RESOLVED', body=? WHERE id=?",
      JSON.stringify({ write: { kind: "update", fileId: F }, sentAt: later(0), outcome: "NOT_APPLIED" }),
      intentId,
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(audits(), 9);
    assert.equal(macroResult(), "PASS");
    await f.o.drive(f.id, { live: true });
    assert.equal(audits(), 9, "and then no more");
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("a dependency's changed authority holds the scoped macro; an unrelated task's does not", () => {
  const f = fixture(["PASS"]);
  try {
    const base = f.c.task("A");
    const sibling = (id: string) =>
      TaskSchema.parse({ ...base, id, status: "DISCOVERED", sources: [], specificationAuthenticated: false });
    f.c.importTasks([sibling("D"), sibling("U")], f.c.localActor());
    const reader = { ...base, dependencies: ["D"] };
    const macro = () => (f.c as any).macro(reader, { macroScopeVersion: 2 });
    const before = macro();
    const grant = (id: string) => {
      const g = { id: randomUUID(), operations: ["READ_LOCAL" as const], paths: ["output/A"], decisionText: "test", sourceRef: "test:owner" };
      f.c.grant(id, g, f.c.localActor());
      return g.id;
    };
    grant("U");
    assert.equal(macro(), before, "an unrelated task's grant");
    grant("D");
    assert.notEqual(macro(), before, "the dependency's grant");
  } finally {
    f.close();
  }
});
