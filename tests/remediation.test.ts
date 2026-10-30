import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller } from "../src/controller.js";
import {
  demoTask,
  digest,
  reviewPayload,
  specDigest,
  TaskSchema,
  type Review,
  type Task,
} from "../src/domain.js";
import { type EvidenceEnvelope } from "../src/evidence.js";
import { MockProvider, type ProviderAdapter } from "../src/providers.js";
import { SqliteStore, migrations } from "../src/store.js";

const run = promisify(execFile);
const compiledCli = fileURLToPath(
  new URL("../bin/longform-orchestrator", import.meta.url),
);
const uid = process.getuid!();
function fixture(tasks: Task[] = [demoTask("A")]) {
  const root = mkdtempSync(join(tmpdir(), "longform-remediation-"));
  const database = join(root, "state.sqlite"),
    db = new SqliteStore(database);
  const c = new Controller(db, {
    workspaceRoot: join(root, "workspaces"),
    ownerUid: uid,
  });
  const actor = c.localActor();
  c.importTasks(tasks, actor);
  for (const t of tasks)
    c.grant(
      t.id,
      {
        id: "grant-" + t.id,
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Disposable local remediation regression only",
        sourceRef: "test:local-commission",
      },
      actor,
    );
  return {
    root,
    database,
    db,
    c,
    actor,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
const selection = (role: "worker" | "reviewer" = "worker") => ({
  provider: (role === "worker" ? "codex" : "claude") as "codex" | "claude",
  model: role === "worker" ? "synthetic-codex" : "synthetic-claude",
  effort: "test",
  requestKey: randomUUID(),
  role,
});
function note(
  f: Fixture,
  id: string,
  taskId = "A",
  metadata: Record<string, unknown> = {},
  changes: Partial<EvidenceEnvelope> = {},
) {
  const envelope: EvidenceEnvelope = {
    id,
    taskId,
    kind: "LOCAL",
    uri: "test:" + id,
    revision: f.c.task(taskId).artifactRevision,
    digest: digest(id),
    retrievedAt: new Date().toISOString(),
    authorityTier: "IMPLEMENTATION",
    authentication: "LOCAL_IMPORT",
    currentness: "CURRENT_AT_RETRIEVAL",
    claims: ["Synthetic test evidence"],
    metadata,
    ...changes,
  };
  f.c.addEvidence(envelope, f.actor);
  return envelope;
}
async function worker(
  f: Fixture,
  id = "A",
  adapter: ProviderAdapter = new MockProvider(),
) {
  const attempt = f.c.reserve(id, selection(), f.actor);
  const receipt = await f.c.execute(attempt, adapter, f.actor);
  return { attempt, receipt };
}
const writingWorker: ProviderAdapter = {
  async execute(request) {
    mkdirSync(join(request.cwd, "output", request.taskId), { recursive: true });
    writeFileSync(
      join(request.cwd, "output", request.taskId, "artifact.txt"),
      "original-worker-bytes",
    );
    return new MockProvider({
      output: "Worker produced the original artifact",
    }).execute(request);
  },
};
async function review(f: Fixture, id = "A", extraEvidence: string[] = []) {
  const attempt = f.c.reserve(id, selection("reviewer"), f.actor);
  const task = f.c.task(id);
  const report: Review = {
    id: randomUUID(),
    taskId: id,
    runId: attempt.id,
    artifactRevision: task.artifactRevision,
    specDigest: specDigest(task),
    reviewerSession: "pending",
    provider: "claude",
    authorshipDisclosure: "Independent synthetic context; no model invoked",
    availableEvidence: [
      ...f.c.evidenceFor(id).map((e) => e.id),
      ...extraEvidence,
    ],
    findings: [],
    testsExecuted: [],
    testsNotExecuted: ["No native tests required by this synthetic task"],
    conflictingEvidence: [],
    remediation: [],
    residualHolds: [],
    verdict: "PASS",
    scope: "Local synthetic artifact only",
    nextAuthorizedStep: "Controller audits and owner acceptance",
    auditAssessments: [],
  };
  const receipt = await f.c.execute(
    attempt,
    new MockProvider({ output: JSON.stringify(reviewPayload(report)) }),
    f.actor,
  );
  report.reviewerSession = receipt.sessionId;
  f.c.review(report, f.actor);
}
async function accept(f: Fixture, id = "A") {
  const { attempt } = await worker(f, id);
  f.c.bindAcceptance(
    id,
    "receipt",
    f.c.evidenceFor(id).find((e) => e.metadata.runId === attempt.id)!.id,
    f.actor,
  );
  await review(f, id);
  f.c.audit(id, f.actor);
  f.c.verify(id, f.actor);
  f.c.decide(
    id,
    {
      id: "accept-" + id,
      text: "Accept disposable synthetic fixture",
      sourceRef: "test:owner",
      alternatives: [],
      limits: ["simulation"],
      operations: ["ACCEPT"],
      artifactRevision: f.c.task(id).artifactRevision,
    },
    f.actor,
  );
  f.c.accept(id, f.actor);
}

test("F-01 controller rejects success and arbitrary reconciliation outcomes without changing UNKNOWN custody", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(
      f,
      "A",
      new MockProvider({ outcome: "crash" }),
    );
    const evidence = note(f, "reconciliation", "A", {
      runId: attempt.id,
      reconciliation: {
        processStopped: true,
        externalEffects: "NONE",
        assessment: "Synthetic process stopped with no external effects",
      },
    });
    for (const outcome of ["SUCCEEDED", "BOGUS_STATE", "", null]) {
      assert.throws(
        () =>
          f.c.reconcile(attempt.id, outcome as "FAILED", evidence.id, f.actor),
        /OUTCOME|RECONCILIATION/,
      );
      assert.equal(
        f.c.inspect("A").attempts.find((a) => a.id === attempt.id)!.state,
        "UNKNOWN",
      );
    }
    assert.throws(
      () => f.c.reserve("A", selection(), f.actor),
      /ACTIVE_OR_UNKNOWN/,
    );
  } finally {
    f.close();
  }
});

test("F-01 compiled CLI cannot award success or persist an arbitrary reconciliation state", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(
      f,
      "A",
      new MockProvider({ outcome: "crash" }),
    );
    const e = note(f, "cli-reconciliation", "A", {
      runId: attempt.id,
      reconciliation: {
        processStopped: true,
        externalEffects: "NONE",
        assessment: "Stopped synthetic process",
      },
    });
    for (const outcome of ["SUCCEEDED", "BOGUS_STATE"]) {
      const filename = join(f.root, "reconcile.json");
      writeFileSync(filename, JSON.stringify({ outcome, evidenceId: e.id }));
      await assert.rejects(
        run(
          process.execPath,
          [
            compiledCli,
            "reconcile",
            "--db",
            f.database,
            "--run-id",
            attempt.id,
            "--file",
            filename,
            "--execute",
          ],
          { cwd: f.root, timeout: 10_000 },
        ),
        /OUTCOME|RECONCILIATION/,
      );
      assert.equal(
        f.c.inspect("A").attempts.find((a) => a.id === attempt.id)!.state,
        "UNKNOWN",
      );
    }
  } finally {
    f.close();
  }
});

test("F-01 reconciliation rejects pre-run or unrelated evidence and keeps unknown effects held", async () => {
  const f = fixture();
  try {
    const old = note(
      f,
      "old-note",
      "A",
      {},
      { retrievedAt: "2020-01-01T00:00:00.000Z" },
    );
    const { attempt } = await worker(
      f,
      "A",
      new MockProvider({ outcome: "crash" }),
    );
    const unrelated = note(f, "unrelated-note");
    const predates = note(
      f,
      "predates-run",
      "A",
      {
        runId: attempt.id,
        reconciliation: {
          processStopped: true,
          externalEffects: "NONE",
          assessment: "Valid shape but stale timestamp",
        },
      },
      { retrievedAt: "2020-01-01T00:00:00.000Z" },
    );
    const otherRevision = note(
      f,
      "other-revision",
      "A",
      {
        runId: attempt.id,
        reconciliation: {
          processStopped: true,
          externalEffects: "NONE",
          assessment: "Unrelated artifact revision",
        },
      },
      { revision: "old-artifact" },
    );
    const noStop = note(f, "not-stopped", "A", {
      runId: attempt.id,
      reconciliation: {
        processStopped: false,
        externalEffects: "NONE",
        assessment: "Still active",
      },
    });
    for (const e of [old, unrelated, predates, otherRevision, noStop])
      assert.throws(
        () => f.c.reconcile(attempt.id, "FAILED", e.id, f.actor),
        /RECONCILIATION/,
      );
    assert.equal(f.c.inspect("A").attempts[0]!.state, "UNKNOWN");
  } finally {
    f.close();
  }
});

test("F-01 valid failed reconciliation records stopped outcome without awarding successful execution", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(
      f,
      "A",
      new MockProvider({ outcome: "crash" }),
    );
    const e = note(f, "reconciliation", "A", {
      runId: attempt.id,
      reconciliation: {
        processStopped: true,
        externalEffects: "NONE",
        assessment: "Disposable mock terminated without side effects",
      },
    });
    f.c.reconcile(attempt.id, "FAILED", e.id, f.actor);
    assert.equal(f.c.inspect("A").attempts[0]!.state, "FAILED");
    assert.notEqual(f.c.task("A").status, "ACCEPTED");
    assert.equal(
      JSON.parse(
        f.db.get<{ body: string }>(
          "SELECT body FROM receipts WHERE attempt_id=?",
          attempt.id,
        )!.body,
      ).status,
      "UNKNOWN",
    );
  } finally {
    f.close();
  }
});

test("F-02 worker bytes substituted between execution receipt and reviewer reservation are rejected", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(f, "A", writingWorker);
    const file = join(attempt.workspace, "output", "A", "artifact.txt");
    assert.equal(readFileSync(file, "utf8"), "original-worker-bytes");
    writeFileSync(file, "substituted-after-receipt");
    assert.throws(
      () => f.c.reserve("A", selection("reviewer"), f.actor),
      /ARTIFACT|WORKSPACE|REVISION/,
    );
    assert.equal(
      f.c.inspect("A").attempts.filter((a) => a.role === "reviewer").length,
      0,
    );
    assert.notEqual(f.c.task("A").status, "ACCEPTED");
  } finally {
    f.close();
  }
});

test("F-02 post-receipt bytes cannot be blessed by fresh audit records", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(f, "A", writingWorker);
    f.c.bindAcceptance("A", "receipt", "output-" + attempt.id, f.actor);
    await review(f);
    writeFileSync(
      join(attempt.workspace, "output", "A", "artifact.txt"),
      "late-substitute",
    );
    const audits = f.c.audit("A", f.actor);
    assert.ok(audits.some((a) => a.result === "FAIL"));
    assert.throws(() => f.c.verify("A", f.actor));
  } finally {
    f.close();
  }
});

test("F-03 schema rejects READ_ONLY writable scopes and undeclared WRITE_LOCAL scopes", () => {
  const t = demoTask("A");
  assert.equal(
    TaskSchema.safeParse({
      ...t,
      dimensions: { ...t.dimensions, authorization: "READ_ONLY" },
      operations: ["READ_LOCAL"],
    }).success,
    false,
  );
  assert.equal(
    TaskSchema.safeParse({ ...t, operations: ["READ_LOCAL"] }).success,
    false,
  );
});

test("F-03 a valid READ_ONLY worker's undeclared actual write cannot become successful output", async () => {
  const t = demoTask("A");
  const f = fixture([
    demoTask("A", {
      dimensions: { ...t.dimensions, authorization: "READ_ONLY" },
      operations: ["READ_LOCAL"],
      writePaths: [],
    }),
  ]);
  try {
    const attempt = f.c.reserve("A", selection(), f.actor);
    await assert.rejects(
      f.c.execute(attempt, writingWorker, f.actor),
      /WRITE|SCOPE|AUTHORIZ/,
    );
    assert.notEqual(f.c.inspect("A").attempts[0]!.state, "SUCCEEDED");
    assert.equal(
      f.c.evidenceFor("A").filter((e) => e.metadata.runId === attempt.id)
        .length,
      0,
    );
  } finally {
    f.close();
  }
});

test("F-03 authorized declared local writes retain a complete review and acceptance path", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(f, "A", writingWorker);
    f.c.bindAcceptance("A", "receipt", "output-" + attempt.id, f.actor);
    await review(f);
    assert.ok(f.c.audit("A", f.actor).every((a) => a.result === "PASS"));
    f.c.verify("A", f.actor);
    assert.equal(f.c.task("A").status, "VERIFIED");
  } finally {
    f.close();
  }
});

test("F-04 LOCAL evidence from a failed worker cannot satisfy an acceptance criterion", async () => {
  const f = fixture();
  try {
    const failed = await worker(
      f,
      "A",
      new MockProvider({ outcome: "failure", output: "failed-work-output" }),
    );
    const e = note(
      f,
      "failed-output",
      "A",
      { runId: failed.attempt.id },
      { digest: digest(failed.receipt.output) },
    );
    await worker(f);
    assert.throws(
      () => f.c.bindAcceptance("A", "receipt", e.id, f.actor),
      /CURRENT|SUCCESS|RECEIPT|ACCEPTANCE/,
    );
  } finally {
    f.close();
  }
});

test("F-04 an earlier successful attempt cannot be rebound after a replacement worker succeeds", async () => {
  const f = fixture();
  try {
    const first = await worker(f);
    f.c.transition("A", "REMEDIATION_REQUIRED", f.actor);
    await worker(f);
    assert.throws(
      () =>
        f.c.bindAcceptance(
          "A",
          "receipt",
          "output-" + first.attempt.id,
          f.actor,
        ),
      /CURRENT|SUCCESS|RECEIPT|ACCEPTANCE/,
    );
  } finally {
    f.close();
  }
});

test("F-04 a previously valid binding is revalidated when a replacement attempt is promoted", async () => {
  const f = fixture();
  try {
    const first = await worker(f);
    f.c.bindAcceptance("A", "receipt", "output-" + first.attempt.id, f.actor);
    f.c.transition("A", "REMEDIATION_REQUIRED", f.actor);
    await worker(f);
    await review(f);
    f.c.audit("A", f.actor);
    assert.throws(() => f.c.verify("A", f.actor), /ACCEPTANCE|CURRENT|RECEIPT/);
  } finally {
    f.close();
  }
});

test("F-05 grant revocation is authenticated, append-only and blocks later dispatch", () => {
  const f = fixture();
  try {
    const revoke = (
      f.c as Controller & {
        revokeGrant?: (id: string, reason: string, actor: unknown) => void;
      }
    ).revokeGrant;
    assert.equal(
      typeof revoke,
      "function",
      "Grant authority must have a durable revocation operation",
    );
    assert.throws(
      () =>
        revoke!.call(f.c, "grant-A", "forged actor", {
          id: f.actor.id,
          uid,
          role: "OWNER",
        }),
      /UNAUTHENTICATED/,
    );
    revoke!.call(
      f.c,
      "grant-A",
      "Withdraw synthetic execution authority",
      f.actor,
    );
    assert.ok(
      f.c.reasons("A").some((r) => r.includes("OPERATION_NOT_AUTHORIZED")),
    );
    assert.throws(
      () => f.c.reserve("A", selection(), f.actor),
      /AUTHORIZ|TASK_BLOCKED/,
    );
    assert.equal(
      f.db.all("SELECT id FROM grants WHERE id=?", "grant-A").length,
      1,
    );
    assert.ok(f.db.verifyEvents());
  } finally {
    f.close();
  }
});

test("F-05 revoking accepted authority blocks downstream work through an accepted dependency chain", async () => {
  const f = fixture([
    demoTask("A"),
    demoTask("B", { dependencies: ["A"] }),
    demoTask("C", { dependencies: ["B"] }),
  ]);
  try {
    await accept(f, "A");
    await accept(f, "B");
    assert.deepEqual(f.c.reasons("C"), []);
    f.c.revoke("accept-A", "Owner withdraws the original acceptance", f.actor);
    assert.ok(
      f.c
        .reasons("B")
        .some((r) => r.includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:A")),
    );
    assert.ok(
      f.c
        .reasons("C")
        .some((r) => r.includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:B")),
    );
    assert.throws(
      () => f.c.reserve("C", selection(), f.actor),
      /DEPENDENCY|TASK_BLOCKED/,
    );
    assert.ok(f.db.verifyEvents());
  } finally {
    f.close();
  }
});

test("F-05 withdrawing a reserved grant prevents invoking its provider", async () => {
  const f = fixture();
  try {
    const revoke = (
      f.c as Controller & {
        revokeGrant?: (id: string, reason: string, actor: unknown) => void;
      }
    ).revokeGrant;
    assert.equal(typeof revoke, "function");
    const attempt = f.c.reserve("A", selection(), f.actor);
    revoke!.call(f.c, "grant-A", "Withdraw before process start", f.actor);
    let invoked = false;
    await assert.rejects(
      f.c.execute(
        attempt,
        {
          async execute(request) {
            invoked = true;
            return new MockProvider().execute(request);
          },
        },
        f.actor,
      ),
      /AUTHORIZ|REVOK|LEASE|CANCEL/,
    );
    assert.equal(invoked, false);
  } finally {
    f.close();
  }
});

test("F-05 grant revocation after review blocks promotion despite otherwise current evidence", async () => {
  const f = fixture();
  try {
    const revoke = (
      f.c as Controller & {
        revokeGrant?: (id: string, reason: string, actor: unknown) => void;
      }
    ).revokeGrant;
    assert.equal(typeof revoke, "function");
    const { attempt } = await worker(f);
    f.c.bindAcceptance("A", "receipt", "output-" + attempt.id, f.actor);
    await review(f);
    f.c.audit("A", f.actor);
    revoke!.call(f.c, "grant-A", "Withdraw before verification", f.actor);
    assert.throws(() => f.c.verify("A", f.actor), /AUTHORIZ|REVOK/);
    assert.notEqual(f.c.task("A").status, "VERIFIED");
  } finally {
    f.close();
  }
});

test("F-05 grant revocation after acceptance blocks dependents while preserving historical records", async () => {
  const f = fixture([demoTask("A"), demoTask("B", { dependencies: ["A"] })]);
  try {
    const revoke = (
      f.c as Controller & {
        revokeGrant?: (id: string, reason: string, actor: unknown) => void;
      }
    ).revokeGrant;
    assert.equal(typeof revoke, "function");
    await accept(f, "A");
    assert.deepEqual(f.c.reasons("B"), []);
    revoke!.call(f.c, "grant-A", "Withdraw accepted fixture's grant", f.actor);
    assert.ok(
      f.c
        .reasons("B")
        .some((r) => r.includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:A")),
    );
    assert.throws(
      () => f.c.reserve("B", selection(), f.actor),
      /DEPENDENCY|TASK_BLOCKED/,
    );
    assert.equal(
      f.db.all("SELECT id FROM decisions WHERE id=?", "accept-A").length,
      1,
    );
    assert.equal(
      f.db.all("SELECT id FROM grants WHERE id=?", "grant-A").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("READ_ONLY rejects empty-directory and special permission changes at completion", async () => {
  for (const mutate of [
    (cwd: string) => mkdirSync(join(cwd, "empty")),
    (cwd: string) => chmodSync(cwd, 0o1700),
  ]) {
    const t = demoTask("A");
    const f = fixture([
      demoTask("A", {
        dimensions: { ...t.dimensions, authorization: "READ_ONLY" },
        operations: ["READ_LOCAL"],
        writePaths: [],
      }),
    ]);
    try {
      const attempt = f.c.reserve("A", selection(), f.actor);
      await assert.rejects(
        f.c.execute(
          attempt,
          {
            async execute(r) {
              mutate(r.cwd);
              return new MockProvider().execute(r);
            },
          },
          f.actor,
        ),
        /WRITE|SCOPE/,
      );
      assert.equal(f.c.task("A").status, "BLOCKED");
    } finally {
      f.close();
    }
  }
});

test("revoked accepted evidence cannot keep a dependent ready", async () => {
  const f = fixture([demoTask("A"), demoTask("B", { dependencies: ["A"] })]);
  try {
    await accept(f);
    const original = f.c
      .evidenceFor("A")
      .find((e) => e.id.startsWith("output-"))!;
    f.c.addEvidence(
      { ...original, id: "replacement", supersedes: original.id },
      f.actor,
    );
    assert.equal(f.c.inspect("A").acceptanceCurrent, false);
    assert.ok(f.c.reasons("B").some((r) => r.startsWith("DEPENDENCY_")));
  } finally {
    f.close();
  }
});

test("canonical evidence hashes are independent of shell locale", async () => {
  const moduleUrl = new URL("../src/domain.ts", import.meta.url).href;
  const code = `const{digest}=await import(${JSON.stringify(moduleUrl)});console.log(digest({'hello.txt':'x','chapter.txt':'y','index.md':'z'}));`;
  const results = await Promise.all(
    ["C.UTF-8", "en_US.UTF-8", "cs_CZ.UTF-8"].map((locale) =>
      run(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        { env: { ...process.env, LC_ALL: locale } },
      ),
    ),
  );
  assert.equal(new Set(results.map((r) => r.stdout.trim())).size, 1);
});

test("reserved HOLD aliases are excluded and simulation acceptance cannot satisfy a real dependency", async () => {
  for (const lane of ["HOLD", "hold", "HOLD/Engineering", "Research / HOLD"]) {
    const f = fixture([demoTask("A", { programme: "LONGFORM", lane })]);
    try {
      assert.ok(
        f.c.reasons("A").includes("RESERVED_LANE_EXCLUDED_FROM_EXECUTION"),
      );
      assert.equal(f.c.report().programme.registered, 0);
    } finally {
      f.close();
    }
  }
  const f = fixture([
    demoTask("A"),
    demoTask("B", {
      programme: "LONGFORM",
      simulation: false,
      dependencies: ["A"],
    }),
  ]);
  try {
    await accept(f);
    assert.ok(f.c.reasons("B").includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:A"));
  } finally {
    f.close();
  }
});

test("review evidence must belong to the task or its explicitly pinned source scope", async () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    const foreign = note(f, "foreign", "B");
    const { attempt } = await worker(f);
    f.c.bindAcceptance("A", "receipt", "output-" + attempt.id, f.actor);
    await assert.rejects(
      review(f, "A", [foreign.id]),
      /EVIDENCE_OUTSIDE_DECLARED_SCOPE/,
    );
  } finally {
    f.close();
  }
});

test("v4 to v5 migration preserves historical grants and adds immutable revocations", () => {
  const root = mkdtempSync(join(tmpdir(), "longform-v4-upgrade-"));
  const path = join(root, "state.sqlite");
  let previous: DatabaseSync | undefined;
  try {
    previous = new DatabaseSync(path);
    previous.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    for (const m of migrations.filter((m) => m.version <= 4)) {
      previous.exec(m.sql);
      previous
        .prepare("INSERT INTO schema_migrations VALUES(?,?)")
        .run(m.version, new Date().toISOString());
    }
    const t = demoTask("LEGACY");
    previous
      .prepare("INSERT INTO tasks(id,body) VALUES(?,?)")
      .run(t.id, JSON.stringify(t));
    const grant = JSON.stringify({
      id: "legacy",
      operations: t.operations,
      paths: t.writePaths,
    });
    previous
      .prepare("INSERT INTO grants VALUES(?,?,?,?)")
      .run("legacy", t.id, "old-v4-digest", grant);
    previous.close();
    previous = undefined;
    const current = new SqliteStore(path);
    try {
      assert.equal(
        current.all("SELECT version FROM schema_migrations").length,
        7,
      );
      assert.equal(
        current.get<{ body: string }>(
          "SELECT body FROM grants WHERE id=?",
          "legacy",
        )!.body,
        grant,
      );
      const c = new Controller(current, {
        workspaceRoot: join(root, "work"),
        ownerUid: uid,
      });
      assert.ok(
        c.reasons(t.id).includes("OPERATION_NOT_AUTHORIZED:WRITE_LOCAL"),
      );
      c.revokeGrant("legacy", "withdraw historical grant", c.localActor());
      assert.throws(
        () => current.run("DELETE FROM grant_revocations"),
        /APPEND_ONLY/,
      );
      assert.ok(current.verifyEvents());
    } finally {
      current.close();
    }
  } finally {
    previous?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy successful attempts without a completion seal cannot adopt current bytes", async () => {
  const f = fixture();
  try {
    const { attempt } = await worker(f);
    const row = f.db.get<{ body: string }>(
      "SELECT body FROM attempts WHERE id=?",
      attempt.id,
    )!;
    const legacy = JSON.parse(row.body);
    delete legacy.workspaceDigest;
    f.db.run(
      "UPDATE attempts SET body=? WHERE id=?",
      JSON.stringify(legacy),
      attempt.id,
    );
    assert.throws(
      () => f.c.reserve("A", selection("reviewer"), f.actor),
      /UNSEALED|ARTIFACT/,
    );
  } finally {
    f.close();
  }
});
