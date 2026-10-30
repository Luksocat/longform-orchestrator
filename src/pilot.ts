import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Controller } from "./controller.js";
import { SqliteStore } from "./store.js";
import { defaultSnapshot, seedSnapshot } from "./runtime.js";
import {
  demoTask,
  specDigest,
  reviewPayload,
  digest,
  type Review,
} from "./domain.js";
import { MockProvider, type ProviderAdapter } from "./providers.js";

/** Actual deterministic end-to-end demonstration. Never invokes a model or real project task. */
export async function runPilot(
  base = resolve(".longform", "pilot-" + randomUUID()),
) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dbPath = join(base, "state.sqlite"),
    commands = Object.fromEntries(
      ["DEMO-A", "DEMO-B"].map((id) => [
        "check-" + id,
        {
          executable: process.execPath,
          args: [
            "-e",
            `const a=require('node:assert/strict'),f=require('node:fs');a.equal(f.readFileSync('output/${id}/artifact.txt','utf8'),'synthetic:${id}');console.log('artifact verified')`,
          ],
        },
      ]),
    );
  let db = new SqliteStore(dbPath);
  let c = new Controller(db, {
    workspaceRoot: join(base, "workspaces"),
    ownerUid: process.getuid!(),
    commands,
  });
  let owner = c.localActor();
  const imported = seedSnapshot(c, defaultSnapshot, owner),
    checks: Record<string, unknown> = {};
  const initialHolds = c
    .tasks()
    .filter((t) => !t.simulation)
    .map((t) => ({
      id: t.id,
      status: t.status,
      blockers: t.blockers,
      dimensions: t.dimensions,
    }));
  c.importTasks(
    [
      demoTask("DEMO-A", {
        requiredTests: ["check-DEMO-A"],
        risk: "HIGH",
        reviewPolicy: {
          required: true,
          crossProvider: true,
          independentAudits: true,
        },
      }),
      demoTask("DEMO-B", { requiredTests: ["check-DEMO-B"] }),
      demoTask("DEMO-OWNER", { decisionRequired: true }),
      demoTask("DEMO-CRASH"),
    ],
    owner,
  );
  for (const id of ["DEMO-A", "DEMO-B", "DEMO-OWNER", "DEMO-CRASH"]) {
    const task = c.task(id);
    c.grant(
      id,
      {
        id: "pilot-grant-" + id,
        operations: [...task.operations, "ACCEPT"],
        paths: task.writePaths,
        decisionText: "Run isolated synthetic orchestration fixture only",
        sourceRef: "commissioning-conversation:local-orchestrator-test",
      },
      owner,
    );
  }
  checks.eligibleBoundedTask = c
    .plan()
    .allocation.find((x) => x.taskId === "DEMO-A");
  assert.ok(checks.eligibleBoundedTask);
  checks.sourceDecisionBlocker = c.inspect("DECISION").blockers;
  assert.ok((checks.sourceDecisionBlocker as string[]).length);
  checks.incompleteImplementationBlocker = c.inspect("DRAFT").blockers;
  assert.ok((checks.incompleteImplementationBlocker as string[]).length);
  assert.throws(() =>
    c.reserve(
      "DECISION",
      {
        provider: "codex",
        model: "never-invoked",
        effort: "none",
        requestKey: "prohibited-real-task",
      },
      owner,
    ),
  );
  const select = (id: string, role: "worker" | "reviewer" = "worker") => ({
    requestKey: "pilot-" + id + "-" + randomUUID(),
    role,
  });
  const a = c.reserve("DEMO-A", select("DEMO-A"), owner),
    b = c.reserve("DEMO-B", select("DEMO-B"), owner);
  assert.equal(a.routing?.mode, "AUTOMATIC");
  assert.equal(b.routing?.mode, "AUTOMATIC");
  assert.equal(a.routing.assessment.level, "EXPERT");
  assert.equal(b.routing.assessment.level, "ROUTINE");
  assert.notEqual(a.model, b.model);
  checks.automaticModelRouting = {
    simulationOnly: true,
    tasks: [a, b].map((attempt) => ({
      taskId: attempt.taskId,
      provider: attempt.provider,
      model: attempt.model,
      effort: attempt.effort,
      routing: attempt.routing,
    })),
    modelsDifferByComplexity: true,
  };
  const worker: ProviderAdapter = {
    async execute(request) {
      mkdirSync(join(request.cwd, "output", request.taskId), {
        recursive: true,
      });
      writeFileSync(
        join(request.cwd, "output", request.taskId, "artifact.txt"),
        "synthetic:" + request.taskId,
      );
      return new MockProvider({
        delayMs: 60,
        output: "Synthetic artifact " + request.taskId,
      }).execute(request);
    },
  };
  const [ra, rb] = await Promise.all([
    c.execute(a, worker, owner),
    c.execute(b, worker, owner),
  ]);
  assert.ok(
    Date.parse(ra.startedAt) < Date.parse(rb.endedAt) &&
      Date.parse(rb.startedAt) < Date.parse(ra.endedAt),
  );
  checks.concurrentMockWorkers = {
    overlapVerified: true,
    providerInvocation: "SIMULATED",
    separateWorkingDirectories: a.workspace !== b.workspace,
    receipts: [ra, rb],
  };
  const controllerTests = [];
  for (const id of ["DEMO-A", "DEMO-B"]) {
    controllerTests.push(await c.command(id, "check-" + id, owner));
    c.bindAcceptance(
      id,
      "receipt",
      c.evidenceFor(id).find((e) => e.kind === "LOCAL")!.id,
      owner,
    );
  }
  checks.executedArtifactTests = controllerTests;
  const reviewer = c.reserve("DEMO-A", select("DEMO-A", "reviewer"), owner);
  const evidenceIds = c.evidenceFor("DEMO-A").map((e) => e.id),
    t = c.task("DEMO-A");
  const report: Review = {
    id: randomUUID(),
    taskId: t.id,
    runId: reviewer.id,
    artifactRevision: t.artifactRevision,
    specDigest: specDigest(t),
    reviewerSession: "harness-pending",
    provider: "claude",
    authorshipDisclosure:
      "Separate synthetic reviewer context; no Claude model invoked",
    availableEvidence: evidenceIds,
    findings: [],
    testsExecuted: [],
    testsNotExecuted: [
      "Reviewer model executed no tests; controller executed artifact assertions separately",
    ],
    conflictingEvidence: [],
    remediation: [],
    residualHolds: [],
    verdict: "PASS",
    scope: "DEMO-A synthetic artifact only",
    nextAuthorizedStep:
      "Run controller audits; owner alone may accept simulation",
    auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map(
      (kind) => ({
        kind: kind as any,
        result: "PASS",
        evidenceIds,
        assessment: "Mock independent audit judgment for isolated fixture only",
        limitations: [],
      }),
    ),
  };
  const rr = await c.execute(
    reviewer,
    new MockProvider({ output: JSON.stringify(reviewPayload(report)) }),
    owner,
  );
  report.reviewerSession = rr.sessionId;
  assert.throws(
    () =>
      c.review(
        { ...report, id: randomUUID(), artifactRevision: "outdated-commit" },
        owner,
      ),
    /REVISION_MISMATCH/,
  );
  checks.outdatedCommitReviewRejected = true;
  c.review(report, owner);
  checks.crossProviderReview = {
    authoredProvider: ra.provider,
    reviewerProvider: rr.provider,
    separateSession: ra.sessionId !== rr.sessionId,
    simulation: true,
    reportId: report.id,
  };
  checks.audits = c.audit("DEMO-A", owner, reviewer.id);
  assert.ok(
    (checks.audits as any[]).every((a) => a.result === "PASS" && a.simulation),
  );
  c.verify("DEMO-A", owner);
  assert.throws(() => c.accept("DEMO-A", owner), /DECISION_REQUIRED/);
  c.decide(
    "DEMO-A",
    {
      id: "pilot-acceptance",
      text: "Accept DEMO-A synthetic local fixture only; no real project completion",
      sourceRef: "commissioning-conversation:authorized-local-tests",
      alternatives: ["synthetic acceptance"],
      limits: ["mock only", "no external effects"],
      operations: ["ACCEPT"],
      artifactRevision: t.artifactRevision,
    },
    owner,
  );
  c.accept("DEMO-A", owner);
  checks.mockAcceptance = c.task("DEMO-A").status;
  c.transition("DEMO-OWNER", "WAITING_OWNER", owner);
  assert.throws(
    () => c.reserve("DEMO-OWNER", select("DEMO-OWNER"), owner),
    /OWNER_DECISION_REQUIRED/,
  );
  const decision = {
    id: "pilot-owner-resume",
    text: "Run synthetic paused fixture",
    sourceRef: "commissioning-conversation:authorized-local-tests",
    alternatives: ["mock run"],
    limits: ["local only"],
    operations: c.task("DEMO-OWNER").operations,
    artifactRevision: c.task("DEMO-OWNER").artifactRevision,
  };
  c.decide("DEMO-OWNER", decision, owner);
  assert.throws(() => c.decide("DEMO-OWNER", decision, owner));
  c.transition("DEMO-OWNER", "READY", owner);
  checks.ownerPauseResume = {
    recorded: true,
    replayRejected: true,
    status: c.task("DEMO-OWNER").status,
  };
  const crash = c.reserve("DEMO-CRASH", select("DEMO-CRASH"), owner);
  const cr = await c.execute(
    crash,
    new MockProvider({ outcome: "crash" }),
    owner,
  );
  assert.equal(cr.status, "UNKNOWN");
  db.close();
  db = new SqliteStore(dbPath);
  c = new Controller(db, {
    workspaceRoot: join(base, "workspaces"),
    ownerUid: process.getuid!(),
    commands,
  });
  owner = c.localActor();
  const recovery = c.recover(owner);
  assert.equal(
    recovery.find((x) => x.runId === crash.id)?.outcome,
    "UNKNOWN_REQUIRES_RECONCILIATION",
  );
  assert.throws(
    () => c.reserve("DEMO-CRASH", select("retry"), owner),
    /ACTIVE_OR_UNKNOWN/,
  );
  checks.crashRecovery = {
    reopenedDatabase: true,
    recovery,
    blindReplayRejected: true,
  };
  const after = c
    .tasks()
    .filter((t) => !t.simulation)
    .map((t) => ({
      id: t.id,
      status: t.status,
      blockers: t.blockers,
      dimensions: t.dimensions,
    }));
  assert.deepEqual(after, initialHolds);
  checks.allProgrammeHoldsPreserved = true;
  const summary = c.report();
  assert.equal(summary.programme.accepted, 0);
  assert.equal(summary.releaseAuthorized, false);
  assert.equal(summary.programme.registered, 21);
  assert.ok(db.verifyEvents());
  const result = {
    application: "LONGFORM_ORCHESTRATOR_v0.1",
    mode: "DETERMINISTIC_MOCK_AND_READ_ONLY_FIXTURES",
    at: new Date().toISOString(),
    database: dbPath,
    imported,
    checks,
    eventChainValid: db.verifyEvents(),
    eventCount: db.all("SELECT seq FROM events").length,
    summary,
    liveModelInvocation: false,
    readiness: "CONTROLLED_MOCK_AND_EVIDENCE_PILOT_ONLY; LIVE_EXECUTION_HELD",
  };
  db.close();
  return result;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  runPilot()
    .then((result) => {
      mkdirSync("evidence", { recursive: true });
      writeFileSync(
        "evidence/pilot-output.json",
        JSON.stringify(result, null, 2) + "\n",
      );
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    })
    .catch((error) => {
      process.stderr.write(String(error) + "\n");
      process.exitCode = 1;
    });
