import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Controller } from "../src/controller.js";
import { demoTask } from "../src/domain.js";
import { runPilot } from "../src/pilot.js";
import {
  createAdviser,
  deterministicAdvice,
  preparePacket,
  sdkAdvice,
} from "../src/reasoning.js";
import { SqliteStore } from "../src/store.js";
import { sandboxed } from "./sandbox-support.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxHook = fileURLToPath(import.meta.resolve("tsx"));
const compiledBin = fileURLToPath(
  new URL("../bin/longform-orchestrator", import.meta.url),
);
const snapshot = JSON.parse(
  readFileSync(
    new URL("../fixtures/programme-snapshot.json", import.meta.url),
    "utf8",
  ),
);
const uid = process.getuid!();
const temporary = () => mkdtempSync(join(tmpdir(), "longform-workflow-"));
test("six independent processes can initialize a new WAL database concurrently", async () => {
  const base = temporary();
  const runtime = pathToFileURL(join(root, "src/runtime.ts")).href;
  try {
    for (let batch = 0; batch < 2; batch++) {
      const file = join(base, "new-" + batch, "state.sqlite");
      const code = `const {openRuntime}=await import(${JSON.stringify(runtime)});const {db}=openRuntime(process.argv[1]);console.log(JSON.stringify({migrations:db.all('SELECT version FROM schema_migrations').length,owners:db.all('SELECT value FROM settings WHERE key=?','owner_uid').length,chain:db.verifyEvents()}));db.close();`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          run(
            process.execPath,
            ["--import", tsxHook, "--input-type=module", "-e", code, file],
            {
              cwd: base,
              env: childEnvironment(),
              timeout: 20_000,
              maxBuffer: 64_000,
            },
          ),
        ),
      );
      for (const result of results)
        assert.deepEqual(JSON.parse(result.stdout), {
          migrations: 7,
          owners: 1,
          chain: true,
        });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
const childEnvironment = () => {
  const env = { ...process.env };
  // Child-only changes: deterministic tests must never spend credentials or infer
  // connector access from authentication in this interactive session.
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LONGFORM_DRIVE_READ_TOKEN",
    "LONGFORM_GITHUB_READ_TOKEN",
  ])
    delete env[key];
  return env;
};
async function cli(args: string[], cwd: string, compiled = false) {
  const executableArgs = compiled
    ? [compiledBin, ...args]
    : ["--import", tsxHook, sourceCli, ...args];
  const result = await run(process.execPath, executableArgs, {
    cwd,
    env: childEnvironment(),
    timeout: 20_000,
    maxBuffer: 2_097_152,
  });
  return JSON.parse(result.stdout);
}

test("source CLI imports held fixtures and reports readiness, evidence, decisions and dry-run operations without clearing holds", async () => {
  const base = temporary();
  const dbPath = join(base, "state.sqlite");
  try {
    // Run outside the project root to exercise fixture and migration resolution.
    const dry = await cli(["init", "--db", dbPath], base);
    assert.equal(dry.dryRun, true);
    const imported = await cli(["init", "--db", dbPath, "--execute"], base);
    assert.deepEqual(imported, { tasks: 21, evidence: 28, grants: 0 });
    const before = await cli(["status", "--db", dbPath], base);
    assert.equal(before.registered, 21);
    assert.equal(before.accepted, 0);
    assert.equal(before.externalMutations, "SCOPED_DRIVE_ONLY");
    assert.equal(
      before.completionEstimate.confidence,
      "LOW_INCOMPLETE_ACCEPTANCE_EVIDENCE",
    );
    for (const command of ["next", "plan"]) {
      const planned = await cli([command, "--db", dbPath], base);
      assert.deepEqual(planned.allocation, []);
      assert.equal(planned.maxWorkers, 3);
      assert.ok(
        planned.blocked.some(
          (t: { taskId: string; reasons: string[] }) =>
            t.taskId === "DRAFT" &&
            t.reasons.some((reason) => reason.includes("INPUT_CHECKS_PENDING")),
        ),
      );
    }
    const inspected = await cli(["inspect", "DECISION", "--db", dbPath], base);
    assert.equal(inspected.task.dimensions.authorization, "HELD");
    assert.equal(inspected.task.dimensions.sourceEffectuation, "CANDIDATE");
    assert.ok(
      inspected.blockers.some((reason: string) => reason.includes("REVIEW_CRITERIA_PENDING")),
    );
    assert.ok(
      inspected.evidence.some(
        (e: { authentication: string; revision: string }) =>
          e.authentication === "LOCAL_IMPORT" && e.revision === "example-1",
      ),
    );
    assert.deepEqual(await cli(["reviews", "--db", dbPath], base), []);
    const decisions = await cli(["decisions", "--db", dbPath], base);
    assert.ok(
      decisions.some(
        (decision: { taskId: string }) => decision.taskId === "CHOOSE-HOST",
      ),
    );
    assert.equal((await cli(["resume", "--db", dbPath], base)).dryRun, true);
    assert.equal((await cli(["audit", "--db", dbPath], base)).dryRun, true);
    const dispatchedDry = await cli(["dispatch", "DECISION", "--db", dbPath], base);
    assert.equal(dispatchedDry.dryRun, true);
    const advice = await cli(["advice", "--db", dbPath], base);
    assert.equal(advice.advisory, true);
    assert.equal(advice.network, false);
    assert.equal(
      advice.suggestions.find((t: { taskId: string }) => t.taskId === "CHOOSE-HOST")
        ?.classification,
      "OWNER_DECISION",
    );
    await assert.rejects(
      cli(
        [
          "dispatch",
          "DECISION",
          "--db",
          dbPath,
          "--execute",
          "--mock",
          "--provider",
          "codex",
          "--model",
          "synthetic-codex",
          "--effort",
          "test",
          "--request-key",
          "must-not-run",
        ],
        base,
      ),
      /LIVE_DISPATCH_HELD_USE_APPROVED_ISOLATED_RUNNER/,
    );
    const after = await cli(["report", "--db", dbPath], base);
    const { externalMutations: _externalMutations, ...programmeBefore } =
      before;
    assert.deepEqual(after.programme, programmeBefore);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("compiled bin resolves fixture sources outside the repository and preserves read-only programme status", async () => {
  assert.ok(
    existsSync(join(root, "dist/src/cli.js")),
    "npm run build must precede compiled CLI verification",
  );
  const base = temporary();
  const dbPath = join(base, "compiled.sqlite");
  try {
    assert.equal(
      (await cli(["init", "--db", dbPath, "--execute"], base, true)).tasks,
      21,
    );
    const report = await cli(["report", "--db", dbPath], base, true);
    assert.equal(report.programme.accepted, 0);
    assert.equal(report.programme.registered, 21);
    assert.equal(report.releaseAuthorized, false);
    assert.deepEqual(report.next.allocation, []);
    const source = await cli(["status", "--db", dbPath], base);
    assert.deepEqual(source.tasks, report.programme.tasks);
    assert.ok(
      report.programme.tasks.every(
        (task: {
          status: string;
          dimensions: { authorization: string; release: string };
        }) =>
          ["BLOCKED", "WAITING_OWNER"].includes(task.status) &&
          task.dimensions.authorization === "HELD" &&
          task.dimensions.release === "NOT_AUTHORIZED",
      ),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("complete disposable pilot executes real sandbox assertions, synthetic cross-provider review, owner resume and durable recovery", sandboxed, async () => {
  const base = temporary();
  try {
    const result = await runPilot(base);
    assert.equal(result.liveModelInvocation, false);
    assert.equal(result.eventChainValid, true);
    assert.ok(result.eventCount > 80);
    assert.equal(result.imported.tasks, 21);
    assert.equal(result.summary.programme.accepted, 0);
    assert.equal(result.summary.programme.registered, 21);
    assert.equal(result.summary.releaseAuthorized, false);
    assert.match(result.readiness, /LIVE_EXECUTION_HELD/);
    const checks = result.checks as Record<string, any>;
    assert.equal(checks.eligibleBoundedTask.taskId, "DEMO-A");
    assert.ok(
      checks.sourceDecisionBlocker.some((reason: string) =>
        reason.includes("REVIEW_CRITERIA_PENDING"),
      ),
    );
    assert.ok(
      checks.incompleteImplementationBlocker.some((reason: string) =>
        reason.includes("INPUT_CHECKS_PENDING"),
      ),
    );
    assert.equal(checks.concurrentMockWorkers.overlapVerified, true);
    assert.equal(checks.concurrentMockWorkers.separateWorkingDirectories, true);
    assert.equal(checks.concurrentMockWorkers.providerInvocation, "SIMULATED");
    for (const receipt of checks.concurrentMockWorkers.receipts) {
      assert.equal(receipt.simulation, true);
      assert.equal(receipt.exitCode, 0);
      assert.deepEqual(receipt.tests, []);
    }
    assert.equal(checks.executedArtifactTests.length, 2);
    for (const receipt of checks.executedArtifactTests) {
      assert.equal(receipt.passed, true);
      assert.equal(receipt.exitCode, 0);
      assert.equal(
        receipt.osIsolation,
        "BUBBLEWRAP_READ_ONLY_NETWORK_DISABLED",
      );
      assert.equal(receipt.executor, "TRUSTED_CONTROLLER_COMMAND_RUNNER");
      assert.equal(receipt.independentModelExecuted, false);
      assert.equal(receipt.workspaceDigest, receipt.afterWorkspaceDigest);
      assert.match(receipt.outputDigest, /^[a-f0-9]{64}$/);
    }
    assert.equal(checks.crossProviderReview.authoredProvider, "codex");
    assert.equal(checks.crossProviderReview.reviewerProvider, "claude");
    assert.equal(checks.crossProviderReview.separateSession, true);
    assert.equal(checks.crossProviderReview.simulation, true);
    assert.equal(checks.outdatedCommitReviewRejected, true);
    assert.equal(checks.mockAcceptance, "ACCEPTED");
    assert.deepEqual(checks.ownerPauseResume, {
      recorded: true,
      replayRejected: true,
      status: "READY",
    });
    assert.equal(checks.crashRecovery.reopenedDatabase, true);
    assert.equal(checks.crashRecovery.blindReplayRejected, true);
    assert.equal(checks.allProgrammeHoldsPreserved, true);
    assert.deepEqual(
      new Set(checks.audits.map((audit: { kind: string }) => audit.kind)),
      new Set(["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"]),
    );
    assert.ok(
      checks.audits.every(
        (audit: {
          result: string;
          independent: boolean;
          simulation: boolean;
          independentModelExecuted: boolean;
        }) =>
          audit.result === "PASS" &&
          audit.independent &&
          audit.simulation &&
          !audit.independentModelExecuted,
      ),
    );
    const db = new SqliteStore(result.database);
    try {
      assert.ok(db.verifyEvents());
      assert.equal(db.all("SELECT id FROM receipts").length, 4);
      assert.equal(db.all("SELECT id FROM command_receipts").length, 2);
      const controller = new Controller(db, {
        workspaceRoot: join(base, "workspaces"),
        ownerUid: uid,
      });
      const actual = controller.tasks().filter((task) => !task.simulation);
      assert.deepEqual(
        actual.map((task) => ({
          id: task.id,
          status: task.status,
          blockers: task.blockers,
          dimensions: task.dimensions,
        })),
        [...snapshot.tasks]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((task) => ({
            id: task.id,
            status: task.status,
            blockers: task.blockers,
            dimensions: task.dimensions,
          })),
      );
      assert.equal(
        controller.inspect("DEMO-A").reviews[0]?.testsExecuted.length,
        0,
      );
      assert.ok(
        controller
          .inspect("DEMO-A")
          .reviews[0]?.testsNotExecuted.some((reason: string) =>
            reason.includes("no tests"),
          ),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SDK is advisory, exports sanitized synthetic metadata only and refuses disabled or real-programme network use", async () => {
  const secret = "restricted source text and credential must stay local";
  const synthetic = demoTask("SDK-SYNTHETIC", {
    blockers: [secret],
    scope: secret,
    deliverable: secret,
  });
  const ownerDecision = demoTask("SDK-OWNER", { decisionRequired: true });
  const real = { ...synthetic, id: "DECISION", simulation: false };
  const packet = preparePacket(synthetic);
  const serialized = JSON.stringify(packet);
  assert.ok(!serialized.includes(secret));
  assert.ok(!("scope" in packet));
  assert.ok(!("writePaths" in packet));
  assert.equal(packet.hasHolds, true);
  assert.equal(
    deterministicAdvice([synthetic, ownerDecision]).suggestions[0]
      ?.classification,
    "BLOCKED",
  );
  assert.equal(
    deterministicAdvice([synthetic, ownerDecision]).suggestions[1]
      ?.classification,
    "OWNER_DECISION",
  );
  const adviser = createAdviser("explicit-offline-test-model");
  assert.equal(adviser.model, "explicit-offline-test-model");
  assert.deepEqual(adviser.tools, []);
  assert.deepEqual(adviser.handoffs, []);
  assert.throws(() => createAdviser("  "), /EXPLICIT_MODEL_REQUIRED/);
  await assert.rejects(
    sdkAdvice([synthetic], {
      model: "explicit-offline-test-model",
      enable: false,
      exportTaskIds: [synthetic.id],
      deadlineMs: 100,
    }),
    /SDK_NETWORK_DISABLED/,
  );
  // Validation precedes credential lookup or any Runner invocation.
  await assert.rejects(
    sdkAdvice([real], {
      model: "explicit-offline-test-model",
      enable: true,
      exportTaskIds: ["DECISION"],
      deadlineMs: 100,
    }),
    /RESTRICTED_SOURCE_EXPORT_DISABLED/,
  );
  await assert.rejects(
    sdkAdvice([synthetic], {
      model: "explicit-offline-test-model",
      enable: true,
      exportTaskIds: [],
      deadlineMs: 100,
    }),
    /RESTRICTED_SOURCE_EXPORT_DISABLED/,
  );
});

test("SIGKILL during a started worker survives a real process restart as unknown and prevents replay", async () => {
  const base = temporary();
  const database = join(base, "killed.sqlite");
  const controllerModule = pathToFileURL(join(root, "src/controller.ts")).href;
  const storeModule = pathToFileURL(join(root, "src/store.ts")).href;
  const domainModule = pathToFileURL(join(root, "src/domain.ts")).href;
  const script = `
    import { Controller } from ${JSON.stringify(controllerModule)};
    import { SqliteStore } from ${JSON.stringify(storeModule)};
    import { demoTask } from ${JSON.stringify(domainModule)};
    const db = new SqliteStore(${JSON.stringify(database)});
    const c = new Controller(db, { workspaceRoot: ${JSON.stringify(join(base, "workspaces"))}, ownerUid: process.getuid(), leaseMs: 60 });
    const actor = c.localActor();
    c.importTasks([demoTask('KILL-FIXTURE', { budget: { deadlineMs: 30000, maxAttempts: 2, maxCostUsd: 0, maxTokens: 1000 } })], actor);
    c.grant('KILL-FIXTURE', { id: 'kill-grant', operations: ['READ_LOCAL','WRITE_LOCAL'], paths: ['output/KILL-FIXTURE'], decisionText: 'Synthetic local kill test', sourceRef: 'test:commissioned-local-verification' }, actor);
    const attempt = c.reserve('KILL-FIXTURE', { provider: 'codex', model: 'synthetic-codex', effort: 'test', requestKey: 'killed-start' }, actor);
    await c.execute(attempt, { async execute() { process.stdout.write(JSON.stringify({ state: 'STARTED', runId: attempt.id }) + '\\n'); await new Promise(() => {}); } }, actor);
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: root, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (data: string) => {
    errors += data;
  });
  try {
    const started = await new Promise<{ state: string; runId: string }>(
      (resolve, reject) => {
        let output = "";
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Child did not persist STARTED before deadline: " + errors,
              ),
            ),
          10_000,
        );
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (data: string) => {
          output += data;
          if (!output.includes("\n")) return;
          clearTimeout(timeout);
          try {
            resolve(JSON.parse(output.trim().split("\n")[0]!));
          } catch (error) {
            reject(error);
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `Child exited before fixture observation ${code}/${signal}: ${errors}`,
            ),
          );
        });
      },
    );
    assert.equal(started.state, "STARTED");
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    const db = new SqliteStore(database);
    try {
      const c = new Controller(db, {
        workspaceRoot: join(base, "workspaces"),
        ownerUid: uid,
        leaseMs: 60,
      });
      const actor = c.localActor();
      assert.equal(
        db.get("SELECT state FROM attempts WHERE id=?", started.runId)?.state,
        "STARTED",
      );
      assert.equal(db.all("SELECT id FROM receipts").length, 0);
      const recovered = c.recover(actor, Date.now() + 1000);
      assert.equal(
        recovered.find((record) => record.runId === started.runId)?.outcome,
        "UNKNOWN_REQUIRES_RECONCILIATION",
      );
      assert.equal(c.task("KILL-FIXTURE").status, "BLOCKED");
      assert.throws(
        () =>
          c.reserve(
            "KILL-FIXTURE",
            {
              provider: "codex",
              model: "synthetic-codex",
              effort: "test",
              requestKey: "replay-must-not-run",
            },
            actor,
          ),
        /ACTIVE_OR_UNKNOWN/,
      );
      assert.equal(db.all("SELECT id FROM attempts").length, 1);
      assert.ok(db.verifyEvents());
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    rmSync(base, { recursive: true, force: true });
  }
});
