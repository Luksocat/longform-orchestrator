import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller } from "../src/controller.js";
import {
  demoTask,
  digest,
  isReservedLane,
  reviewPayload,
  specDigest,
  type Review,
  type Task,
} from "../src/domain.js";
import {
  importLocalEvidence,
  sha256,
  type EvidenceEnvelope,
} from "../src/evidence.js";
import { MockProvider, type ProviderAdapter } from "../src/providers.js";
import { SqliteStore } from "../src/store.js";

const run = promisify(execFile);
const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const compiledCli = fileURLToPath(
  new URL("../bin/longform-orchestrator", import.meta.url),
);
const tsxHook = fileURLToPath(import.meta.resolve("tsx"));
const uid = process.getuid!();

function fixture(tasks: Task[] = [demoTask("A")]) {
  const root = mkdtempSync(join(tmpdir(), "longform-operator-remediation-"));
  const database = join(root, "state.sqlite");
  let db = new SqliteStore(database);
  let c = new Controller(db, {
    ownerUid: uid,
    workspaceRoot: join(root, "workspaces"),
  });
  let actor = c.localActor();
  c.importTasks(tasks, actor);
  for (const t of tasks)
    c.grant(
      t.id,
      {
        id: "grant-" + t.id,
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Disposable local operator regression only",
        sourceRef: "test:local-orchestrator-commission",
      },
      actor,
    );
  return {
    root,
    database,
    get db() {
      return db;
    },
    get c() {
      return c;
    },
    get actor() {
      return actor;
    },
    reopen() {
      db.close();
      db = new SqliteStore(database);
      c = new Controller(db, {
        ownerUid: uid,
        workspaceRoot: join(root, "workspaces"),
      });
      actor = c.localActor();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
const selection = () => ({
  provider: "codex" as const,
  model: "synthetic-codex",
  effort: "test",
  requestKey: randomUUID(),
});
function childEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LONGFORM_DRIVE_READ_TOKEN",
    "LONGFORM_GITHUB_READ_TOKEN",
  ])
    delete env[key];
  return env;
}
async function cli(f: Fixture, args: string[], compiled = false) {
  const argv = compiled
    ? [compiledCli, ...args]
    : ["--import", tsxHook, sourceCli, ...args];
  const result = await run(process.execPath, [...argv, "--db", f.database], {
    cwd: f.root,
    env: childEnvironment(),
    timeout: 15_000,
    maxBuffer: 2_097_152,
  });
  return JSON.parse(result.stdout);
}
function evidence(f: Fixture, overrides: Partial<EvidenceEnvelope> = {}) {
  return {
    id: randomUUID(),
    taskId: "A",
    kind: "LOCAL" as const,
    uri: "test:operator-note",
    revision: f.c.task("A").artifactRevision,
    digest: digest("synthetic-local-assessment"),
    retrievedAt: new Date().toISOString(),
    authorityTier: "UNVERIFIED" as const,
    authentication: "LOCAL_IMPORT" as const,
    currentness: "CURRENT_AT_RETRIEVAL" as const,
    claims: ["Operator assessment, not authority established by hash"],
    metadata: {},
    ...overrides,
  } satisfies EvidenceEnvelope;
}
function readOnly(id: string, overrides: Partial<Task> = {}) {
  const t = demoTask(id);
  return demoTask(id, {
    dimensions: { ...t.dimensions, authorization: "READ_ONLY" },
    operations: ["READ_LOCAL"],
    writePaths: [],
    ...overrides,
  });
}
const writingReadOnly: ProviderAdapter = {
  async execute(r) {
    writeFileSync(join(r.cwd, "forbidden.txt"), "unauthorized synthetic bytes");
    return new MockProvider().execute(r);
  },
};

test("N-01 API local-file import survives storage round trip and database restart without authority upgrades", async () => {
  const f = fixture();
  try {
    const file = join(f.root, "note.txt");
    const bytes =
      "Local evidence only; not acceptance or source authorization.\n";
    writeFileSync(file, bytes);
    const imported = await importLocalEvidence({
      taskId: "A",
      path: file,
      allowedRoot: f.root,
    });
    if (!imported.ok) throw new Error(imported.reason);
    f.c.addEvidence(imported.envelope, f.actor);
    const raw = f.db.get<{ body: string }>(
      "SELECT body FROM evidence WHERE id=?",
      imported.envelope.id,
    )!.body;
    assert.equal(
      Object.hasOwn(JSON.parse(raw), "supersedes"),
      false,
      "new imports must omit the absent optional reference",
    );
    f.reopen();
    const stored = f.c.evidenceFor("A")[0]!;
    assert.equal(stored.digest, sha256(bytes));
    assert.equal(stored.currentness, "UNKNOWN");
    assert.equal(stored.authorityTier, "UNVERIFIED");
    assert.equal(stored.authentication, "LOCAL_IMPORT");
    assert.equal(stored.supersedes, undefined);
    assert.equal(f.c.inspect("A").evidence.length, 1);
    assert.equal(f.c.report().releaseAuthorized, false);
    assert.ok(f.c.plan().allocation.some((a) => a.taskId === "A"));
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

for (const compiled of [false, true])
  test(`N-01 ${compiled ? "compiled" : "source"} CLI raw evidence import reads back through inspect/status/report/plan`, async () => {
    const f = fixture();
    try {
      const path = join(f.root, "evidence.txt");
      writeFileSync(path, "CLI local note\n");
      const imported = await cli(
        f,
        ["evidence", "A", "--file", path, "--execute"],
        compiled,
      );
      assert.equal(imported.currentness, "UNKNOWN");
      const inspected = await cli(f, ["inspect", "A"], compiled);
      assert.equal(inspected.evidence[0].id, imported.id);
      assert.equal(inspected.evidence[0].authorityTier, "UNVERIFIED");
      for (const command of ["status", "report", "plan"])
        await cli(f, [command], compiled);
      assert.equal(f.c.task("A").status, "DISCOVERED");
      assert.equal(f.db.verifyEvents(), true);
    } finally {
      f.close();
    }
  });

test("N-01 legacy supersedes:null evidence recovers by read projection without mutating append-only bytes", () => {
  const f = fixture();
  try {
    // This is the exact shape emitted by the archived canonical serializer when
    // importLocalEvidence constructed supersedes:undefined. Preserve the raw
    // legacy row rather than bypassing its immutable UPDATE/DELETE triggers.
    const e = evidence(f, { currentness: "UNKNOWN" });
    const body = JSON.stringify({ ...e, supersedes: null });
    f.db.run("INSERT INTO evidence VALUES(?,?,?)", e.id, "A", body);
    f.db.event("EVIDENCE_APPENDED", "A", {
      id: e.id,
      digest: e.digest,
      authentication: e.authentication,
    });
    const events = f.db.all("SELECT * FROM events ORDER BY seq");
    for (let restart = 0; restart < 2; restart++) {
      f.reopen();
      const projected = f.c.evidenceFor("A")[0]!;
      assert.equal(projected.supersedes, undefined);
      assert.equal(projected.currentness, "UNKNOWN");
      assert.equal(projected.authorityTier, "UNVERIFIED");
      assert.equal(f.c.inspect("A").evidence.length, 1);
      assert.equal(f.c.report().releaseAuthorized, false);
      assert.ok(f.c.plan().allocation.some((a) => a.taskId === "A"));
      assert.equal(
        f.db.get<{ body: string }>(
          "SELECT body FROM evidence WHERE id=?",
          e.id,
        )!.body,
        body,
      );
      assert.deepEqual(f.db.all("SELECT * FROM events ORDER BY seq"), events);
      assert.equal(f.db.verifyEvents(), true);
    }
    assert.throws(
      () => f.db.run("UPDATE evidence SET body=? WHERE id=?", "{}", e.id),
      /APPEND_ONLY/,
    );
    assert.throws(
      () => f.db.run("DELETE FROM evidence WHERE id=?", e.id),
      /APPEND_ONLY/,
    );
    assert.throws(
      () =>
        f.c.addEvidence({ ...e, id: "new-null", supersedes: null }, f.actor),
      /supersedes|invalid_type/,
      "compatibility projection must not admit new malformed envelopes",
    );
    f.c.addEvidence(
      { ...e, id: "typed-successor", supersedes: e.id, revision: "later-note" },
      f.actor,
    );
    assert.equal(f.c.evidenceFor("A").length, 2);
    assert.equal(
      f.db.get<{ body: string }>("SELECT body FROM evidence WHERE id=?", e.id)!
        .body,
      body,
    );
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-01 stored compatibility does not coerce invalid required evidence fields", () => {
  const f = fixture();
  try {
    const e = evidence(f);
    const raw = JSON.stringify({ ...e, supersedes: null, revision: null });
    f.db.run("INSERT INTO evidence VALUES(?,?,?)", e.id, "A", raw);
    assert.throws(() => f.c.evidenceFor("A"), /revision|invalid_type/);
    assert.equal(
      f.db.get<{ body: string }>("SELECT body FROM evidence WHERE id=?", e.id)!
        .body,
      raw,
    );
  } finally {
    f.close();
  }
});

for (const compiled of [false, true])
  test(`N-01 ${compiled ? "compiled" : "source"} CLI imports run-bound operator envelope and reconciles crash without awarding success`, async () => {
    const f = fixture();
    try {
      const attempt = f.c.reserve("A", selection(), f.actor);
      const crashed = await f.c.execute(
        attempt,
        new MockProvider({ outcome: "crash" }),
        f.actor,
      );
      assert.equal(crashed.status, "UNKNOWN");
      const envelope = evidence(f, {
        metadata: {
          runId: attempt.id,
          reconciliation: {
            processStopped: true,
            externalEffects: "NONE",
            assessment: "Operator inspected this stopped disposable mock only",
          },
        },
      });
      const path = join(f.root, "operator-envelope.json");
      writeFileSync(path, JSON.stringify(envelope));
      const imported = await cli(
        f,
        ["evidence", "A", "--envelope", "--file", path, "--execute"],
        compiled,
      );
      assert.equal(imported.id, envelope.id);
      assert.equal(imported.authorityTier, "UNVERIFIED");
      const reconciliation = join(f.root, "reconciliation.json");
      writeFileSync(
        reconciliation,
        JSON.stringify({ outcome: "FAILED", evidenceId: envelope.id }),
      );
      await cli(
        f,
        [
          "reconcile",
          "--run-id",
          attempt.id,
          "--file",
          reconciliation,
          "--execute",
        ],
        compiled,
      );
      assert.equal(f.c.inspect("A").attempts[0]!.state, "FAILED");
      assert.equal(f.c.task("A").status, "BLOCKED");
      assert.equal(f.c.inspect("A").acceptanceCurrent, false);
      assert.equal(f.db.all("SELECT id FROM attempts").length, 1);
      for (const command of ["status", "report", "plan"])
        await cli(f, [command], compiled);
      assert.equal(f.db.verifyEvents(), true);
    } finally {
      f.close();
    }
  });

test("N-01 CLI envelope import rejects task spoofing and elevated authentication or authority without storing rows", async () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    const invalid = [
      evidence(f, { taskId: "B" }),
      evidence(f, { authentication: "AUTHENTICATED_API" }),
      evidence(f, { authorityTier: "OWNER_DECISION" }),
      evidence(f, { authorityTier: "GOVERNING" }),
      evidence(f, { kind: "DRIVE" }),
      { ...evidence(f), supersedes: null },
    ];
    for (const e of invalid) {
      const path = join(f.root, "invalid-envelope.json");
      writeFileSync(path, JSON.stringify(e));
      await assert.rejects(
        cli(f, ["evidence", "A", "--envelope", "--file", path, "--execute"]),
      );
      assert.equal(f.db.all("SELECT id FROM evidence").length, 0);
    }
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-02 controller-rejected completed invocations release physical capacity while preserving unknown task and resource holds", async () => {
  const rejected = ["BAD-A", "BAD-B", "BAD-C"].map((id) =>
    readOnly(id, { resources: ["resource-" + id] }),
  );
  const f = fixture([
    ...rejected,
    demoTask("UNRELATED"),
    demoTask("CONFLICT", { resources: ["resource-BAD-A"] }),
  ]);
  try {
    const attempts = [];
    for (const task of rejected) {
      const attempt = f.c.reserve(task.id, selection(), f.actor);
      attempts.push(attempt);
      await assert.rejects(
        f.c.execute(attempt, writingReadOnly, f.actor),
        /WORKSPACE_WRITE|WRITE_NOT_AUTHORIZED/,
      );
    }
    assert.ok(
      attempts.every(
        (a) => f.c.inspect(a.taskId).attempts[0]!.state === "UNKNOWN",
      ),
    );
    assert.equal(f.c.plan().active, 0);
    f.reopen();
    assert.equal(
      f.c.plan().active,
      0,
      "capacity release must survive reopening",
    );
    assert.ok(f.c.plan().allocation.some((a) => a.taskId === "UNRELATED"));
    assert.ok(!f.c.plan().allocation.some((a) => a.taskId === "CONFLICT"));
    for (const task of rejected) {
      assert.ok(f.c.reasons(task.id).includes("ACTIVE_OR_UNKNOWN_ATTEMPT"));
      assert.throws(
        () => f.c.reserve(task.id, selection(), f.actor),
        /ACTIVE_OR_UNKNOWN|TASK_BLOCKED/,
      );
      assert.equal(f.c.evidenceFor(task.id).length, 0);
    }
    assert.throws(
      () => f.c.reserve("CONFLICT", selection(), f.actor),
      /OVERLAPPING_WRITE_SCOPE|RESOURCE|CLAIM_CONFLICT/,
    );
    const unrelated = f.c.reserve("UNRELATED", selection(), f.actor);
    await f.c.execute(unrelated, new MockProvider(), f.actor);
    assert.equal(f.c.inspect("UNRELATED").attempts[0]!.state, "SUCCEEDED");
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-02 released unknown execution retains overlapping write-path reservation", async () => {
  // Since the claim registry (2026-10-26) write paths are qualified by each
  // run's own workspace, so the reservation an unknown run keeps is shown
  // with the task's explicit resource; overlapping relative paths alone no
  // longer conflict (tests/claims.test.ts).
  const f = fixture([
    demoTask("BAD", { writePaths: ["output/shared"], resources: ["shared"] }),
    demoTask("CONFLICT", { writePaths: ["output/shared/nested"], resources: ["shared"] }),
    demoTask("UNRELATED"),
  ]);
  try {
    const a = f.c.reserve("BAD", selection(), f.actor);
    await assert.rejects(
      f.c.execute(a, writingReadOnly, f.actor),
      /OUT_OF_SCOPE/,
    );
    assert.equal(f.c.plan().active, 0);
    assert.equal(f.c.inspect("BAD").attempts[0]!.state, "UNKNOWN");
    assert.throws(
      () =>
        f.c.revise(
          "BAD",
          {
            ...f.c.task("BAD"),
            specVersion: f.c.task("BAD").specVersion + 1,
            writePaths: ["elsewhere"],
          },
          f.actor,
        ),
      /REVISION_NOT_ALLOWED/,
      "an unresolved attempt must retain its original resource reservation",
    );
    assert.throws(
      () => f.c.reserve("CONFLICT", selection(), f.actor),
      /CLAIM_CONFLICT:resource:shared/,
    );
    assert.ok(f.c.plan().allocation.some((t) => t.taskId === "UNRELATED"));
  } finally {
    f.close();
  }
});

test("N-02 eight processes race for exactly three released slots while UNKNOWN task and resource holds persist", async () => {
  const rejected = ["BAD-A", "BAD-B", "BAD-C"].map((id) =>
    readOnly(id, { resources: ["resource-" + id] }),
  );
  const racerIds = Array.from({ length: 8 }, (_, i) => "RACER-" + i);
  const f = fixture([
    ...rejected,
    ...racerIds.map((id) => demoTask(id, { resources: ["resource-" + id] })),
    demoTask("CONFLICT", { resources: ["resource-BAD-A"] }),
  ]);
  const controllerUrl = new URL("../src/controller.ts", import.meta.url).href;
  const storeUrl = new URL("../src/store.ts", import.meta.url).href;
  // All executable code is fixed by this test. Database, workspace and bounded
  // synthetic task identifiers are argv data. The SQLite readiness barrier
  // ensures all eight processes reach reservation together, rather than merely
  // launching eight sequentially completed operations.
  const code = `
    import { Controller } from ${JSON.stringify(controllerUrl)};
    import { SqliteStore } from ${JSON.stringify(storeUrl)};
    import { setTimeout as delay } from 'node:timers/promises';
    const [database, workspaceRoot, taskId] = process.argv.slice(1);
    const db = new SqliteStore(database);
    try {
      const c = new Controller(db, { ownerUid: process.getuid(), workspaceRoot });
      const actor = c.localActor();
      db.run('INSERT INTO settings VALUES(?,?)', 'race-ready:' + taskId, '1');
      const deadline = Date.now() + 10000;
      while (!db.get('SELECT value FROM settings WHERE key=?', 'race-go')) {
        if (Date.now() > deadline) throw new Error('RACE_BARRIER_TIMEOUT');
        await delay(5);
      }
      try {
        const a = c.reserve(taskId, {
          provider: 'codex', model: 'synthetic-codex', effort: 'test',
          requestKey: 'reservation-race:' + taskId
        }, actor);
        console.log(JSON.stringify({ taskId, won: true, runId: a.id }));
      } catch (error) {
        console.log(JSON.stringify({ taskId, won: false, error: error.message }));
      }
    } finally { db.close(); }
  `;
  let children: PromiseSettledResult<{ stdout: string; stderr: string }>[] = [];
  let settled:
    | Promise<PromiseSettledResult<{ stdout: string; stderr: string }>[]>
    | undefined;
  try {
    for (const task of rejected) {
      const a = f.c.reserve(task.id, selection(), f.actor);
      await assert.rejects(
        f.c.execute(a, writingReadOnly, f.actor),
        /WORKSPACE_WRITE|WRITE_NOT_AUTHORIZED/,
      );
    }
    assert.equal(f.c.plan().active, 0);
    assert.throws(
      () => f.c.reserve("CONFLICT", selection(), f.actor),
      /OVERLAPPING_WRITE_SCOPE|RESOURCE|CLAIM_CONFLICT/,
    );
    settled = Promise.allSettled(
      racerIds.map((taskId) =>
        run(
          process.execPath,
          [
            "--import",
            tsxHook,
            "--input-type=module",
            "-e",
            code,
            f.database,
            join(f.root, "workspaces"),
            taskId,
          ],
          {
            cwd: f.root,
            env: childEnvironment(),
            timeout: 20_000,
            maxBuffer: 64_000,
          },
        ),
      ),
    );
    const deadline = Date.now() + 10_000;
    while (
      f.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'race-ready:%'",
      )!.n < 8
    ) {
      assert.ok(
        Date.now() < deadline,
        "all eight reservation processes must reach the barrier",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    f.db.run("INSERT INTO settings VALUES(?,?)", "race-go", "1");
    children = await settled;
    const results = children.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return JSON.parse(result.value.stdout) as {
        taskId: string;
        won: boolean;
        runId?: string;
        error?: string;
      };
    });
    assert.equal(results.filter((r) => r.won).length, 3);
    assert.equal(results.filter((r) => !r.won).length, 5);
    assert.ok(
      // The refusal names the slot holders since S5; it is still capacity.
      results
        .filter((r) => !r.won)
        .every((r) => /^MAX_CONCURRENCY: slots held by run /.test(r.error ?? "")),
    );
    assert.equal(
      f.db.all("SELECT id FROM attempts WHERE state='RESERVED'").length,
      3,
    );
    assert.equal(
      f.db.all("SELECT id FROM attempts WHERE state='UNKNOWN'").length,
      3,
    );
    f.reopen();
    assert.equal(f.c.plan().active, 3);
    assert.equal(f.c.plan().unreconciled, 3);
    for (const task of rejected) {
      assert.equal(f.c.inspect(task.id).attempts[0]!.state, "UNKNOWN");
      assert.ok(f.c.reasons(task.id).includes("ACTIVE_OR_UNKNOWN_ATTEMPT"));
    }
    assert.equal(f.c.inspect("CONFLICT").attempts.length, 0);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    // Release a waiting barrier even if an assertion fails, then wait for every
    // bounded child before deleting its disposable database.
    if (settled && children.length === 0) {
      f.db.run("INSERT OR IGNORE INTO settings VALUES(?,?)", "race-go", "1");
      await settled;
    }
    f.close();
  }
});

test("N-02 truly uncertain provider exceptions still reserve physical slots across restarts", async () => {
  const f = fixture(["A", "B", "C", "D"].map((id) => demoTask(id)));
  try {
    const a = f.c.reserve("A", selection(), f.actor);
    await assert.rejects(
      f.c.execute(
        a,
        {
          async execute() {
            throw new Error("Provider threw without confirming process state");
          },
        },
        f.actor,
      ),
      /Provider threw/,
    );
    assert.equal(f.c.plan().active, 1);
    f.reopen();
    assert.equal(f.c.plan().active, 1);
    f.c.reserve("B", selection(), f.actor);
    f.c.reserve("C", selection(), f.actor);
    assert.throws(
      () => f.c.reserve("D", selection(), f.actor),
      /MAX_CONCURRENCY/,
    );
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-02 a returned UNKNOWN receipt is not proof of process completion", async () => {
  const f = fixture();
  try {
    const a = f.c.reserve("A", selection(), f.actor);
    await f.c.execute(
      a,
      {
        async execute(r) {
          return {
            ...(await new MockProvider().execute(r)),
            status: "UNKNOWN",
          };
        },
      },
      f.actor,
    );
    assert.equal(f.c.inspect("A").attempts[0]!.state, "UNKNOWN");
    assert.equal(f.c.plan().active, 1);
    f.reopen();
    assert.equal(f.c.plan().active, 1);
  } finally {
    f.close();
  }
});

test("N-02 malformed or mismatched terminal claims cannot release physical capacity", async () => {
  const f = fixture(["A", "B", "C", "D"].map((id) => demoTask(id)));
  try {
    for (const [index, taskId] of ["A", "B", "C"].entries()) {
      const a = f.c.reserve(taskId, selection(), f.actor);
      await assert.rejects(
        f.c.execute(
          a,
          {
            async execute(r) {
              const receipt = await new MockProvider().execute(r);
              return index === 0
                ? { ...receipt, provider: "claude" }
                : index === 1
                  ? { ...receipt, runId: "unrelated-run" }
                  : { ...receipt, exitCode: 42 };
            },
          },
          f.actor,
        ),
        /IDENTITY_MISMATCH|UNVERIFIED_PROVIDER_SUCCESS|Success requires exit 0/,
      );
      assert.equal(f.c.inspect(taskId).attempts[0]!.state, "UNKNOWN");
      assert.equal(f.c.plan().active, index + 1);
    }
    assert.throws(
      () => f.c.reserve("D", selection(), f.actor),
      /MAX_CONCURRENCY/,
    );
    f.reopen();
    assert.equal(f.c.plan().active, 3);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-02 an adapter that misses its deadline still occupies a physical slot", async () => {
  const t = demoTask("A");
  const f = fixture([
    demoTask("A", { budget: { ...t.budget, deadlineMs: 20 } }),
  ]);
  try {
    const a = f.c.reserve("A", selection(), f.actor);
    await assert.rejects(
      f.c.execute(
        a,
        {
          async execute() {
            return new Promise(() => {});
          },
        },
        f.actor,
      ),
      /ADAPTER_DID_NOT_CONFIRM_STOP/,
    );
    assert.equal(f.c.inspect("A").attempts[0]!.state, "UNKNOWN");
    assert.equal(f.c.plan().active, 1);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("N-03 reserved HOLD workstreams are excluded without matching unrelated identifiers", () => {
  const excluded = [
    "HOLD", "Research / HOLD", "hold", "HOLD plus reviewers",
    "Engineering (HOLD)", "review_hold; owners",
  ];
  const permitted = [
    "Research / Engineering", "shareholder", "HOLDING", "THRESHOLD", "holdings-research",
  ];
  for (const lane of excluded) {
    assert.equal(isReservedLane(lane), true, lane);
    const f = fixture([
      demoTask("A", { programme: "LONGFORM", simulation: false, lane }),
    ]);
    try {
      assert.ok(
        f.c.reasons("A").includes("RESERVED_LANE_EXCLUDED_FROM_EXECUTION"),
        lane,
      );
      assert.equal(f.c.report().programme.registered, 0, lane);
      assert.equal(f.c.report().programme.accepted, 0);
    } finally {
      f.close();
    }
  }
  for (const lane of permitted) assert.equal(isReservedLane(lane), false, lane);
});

test("N-04 a fresh grant cannot silently revive acceptance; a new exact ACCEPT decision and explicit acceptance are required", async () => {
  const f = fixture([demoTask("A"), demoTask("B", { dependencies: ["A"] })]);
  try {
    const worker = f.c.reserve("A", selection(), f.actor);
    await f.c.execute(worker, new MockProvider(), f.actor);
    f.c.bindAcceptance("A", "receipt", "output-" + worker.id, f.actor);
    const reviewer = f.c.reserve(
      "A",
      {
        ...selection(),
        role: "reviewer",
        provider: "claude",
        model: "synthetic-claude",
      },
      f.actor,
    );
    const t = f.c.task("A");
    const review: Review = {
      id: randomUUID(),
      taskId: "A",
      runId: reviewer.id,
      artifactRevision: t.artifactRevision,
      specDigest: specDigest(t),
      reviewerSession: "pending",
      provider: "claude",
      authorshipDisclosure: "Separate synthetic context; no real model invoked",
      availableEvidence: f.c.evidenceFor("A").map((e) => e.id),
      findings: [],
      testsExecuted: [],
      testsNotExecuted: ["Synthetic receipt-only fixture has no native test"],
      conflictingEvidence: [],
      remediation: [],
      residualHolds: [],
      verdict: "PASS",
      scope: "Disposable local acceptance authority regression",
      nextAuthorizedStep: "Controller audits and owner acceptance",
      auditAssessments: [],
    };
    const receipt = await f.c.execute(
      reviewer,
      new MockProvider({ output: JSON.stringify(reviewPayload(review)) }),
      f.actor,
    );
    f.c.review({ ...review, reviewerSession: receipt.sessionId }, f.actor);
    f.c.audit("A", f.actor);
    f.c.verify("A", f.actor);
    const decision = (id: string) => ({
      id,
      text: "Accept unchanged disposable synthetic artifact",
      sourceRef: "test:authenticated-local-owner",
      alternatives: [],
      limits: ["simulation only"],
      operations: ["ACCEPT" as const],
      artifactRevision: t.artifactRevision,
    });
    f.c.decide("A", decision("initial-accept"), f.actor);
    f.c.accept("A", f.actor);
    assert.equal(f.c.inspect("A").acceptanceCurrent, true);
    assert.deepEqual(f.c.reasons("B"), []);
    f.c.revokeGrant(
      "grant-A",
      "Withdraw previously accepted task authority",
      f.actor,
    );
    f.c.grant(
      "A",
      {
        id: "fresh-grant-A",
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Reauthorize execution scope, not automatic acceptance",
        sourceRef: "test:authenticated-local-owner",
      },
      f.actor,
    );
    f.reopen();
    assert.equal(f.c.task("A").status, "ACCEPTED", "history remains intact");
    assert.equal(f.c.inspect("A").acceptanceCurrent, false);
    assert.ok(f.c.reasons("B").includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:A"));
    assert.throws(
      () => f.c.accept("A", f.actor),
      /DECISION|WITHDRAW|REVOK|REVOC/,
    );
    const oldEvents = f.db.all(
      "SELECT * FROM events WHERE kind='AUTHORIZED_ACCEPTANCE'",
    );
    assert.equal(oldEvents.length, 1);
    f.c.decide("A", decision("post-withdrawal-accept"), f.actor);
    assert.equal(
      f.c.inspect("A").acceptanceCurrent,
      false,
      "a decision alone does not apply acceptance",
    );
    f.c.accept("A", f.actor);
    assert.equal(f.c.inspect("A").acceptanceCurrent, true);
    assert.deepEqual(f.c.reasons("B"), []);
    assert.equal(
      f.db.all("SELECT * FROM events WHERE kind='AUTHORIZED_ACCEPTANCE'")
        .length,
      2,
    );
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});
