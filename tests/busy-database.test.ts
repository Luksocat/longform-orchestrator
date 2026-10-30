import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Controller,
  limitEnded,
  PROVIDER_RETRIES_PER_STEP,
} from "../src/controller.js";
import { databaseBusy, SqliteStore } from "../src/store.js";
import { BusyStore } from "./busy-store.js";
import type { RoutingPolicy } from "../src/routing.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";

// Another session's writes can hold the shared database longer than its busy
// timeout. A run waits that out instead of being stopped, and a run the
// controller still had to stop is interrupted work that can be tried again
// .

const now = () => new Date().toISOString();

function task(id: string) {
  return {
    id,
    programme: "DEMO",
    lane: "L01",
    title: id,
    scope: "s",
    deliverable: "d",
    specVersion: 1,
    status: "DISCOVERED",
    dimensions: {
      authorization: "LOCAL_ONLY",
      sourceEffectuation: "CANDIDATE",
      implementation: "NOT_STARTED",
      review: "NONE",
      release: "NOT_AUTHORIZED",
    },
    dependencies: [],
    blockers: [],
    sources: [
      { evidenceId: "src-" + id, revision: "r1", digest: "a".repeat(64) },
    ],
    specificationAuthenticated: true,
    providers: ["claude"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/" + id],
    resources: [],
    risk: "LOW",
    reviewPolicy: {
      required: false,
      crossProvider: false,
      independentAudits: false,
    },
    acceptance: [{ id: "a", description: "d", evidenceKind: "LOCAL" }],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    estimatedCostUsd: 0,
    budget: {
      deadlineMs: 30_000,
      maxAttempts: 5,
      maxCostUsd: 10,
      maxTokens: 100_000,
    },
    artifactRevision: "rev1",
    simulation: false,
    createdAt: now(),
  };
}
const route = {
  id: "claude-routine",
  level: "ROUTINE",
  provider: "claude",
  model: "claude-model",
  effort: "low",
  roles: ["worker", "reviewer", "assessor", "advisor", "moderator"],
  simulation: false,
  enabled: true,
  capability: {
    provider: "claude",
    model: "claude-model",
    effort: "low",
    verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "file:test",
  },
};
const policy = () =>
  ({ version: 1, id: "p", routes: [route] }) as unknown as RoutingPolicy;

/**
 * Claude tasks C1.. on a store that can be made busy; `leaseMs` sets the
 * heartbeat (a third of it). `other()` is another process's controller on
 * the same database, which the busy store does not hold up.
 */
function setup(leaseMs: number, count = 1) {
  const root = mkdtempSync(join(tmpdir(), "longform-busy-"));
  const inner = new SqliteStore(join(root, "state.sqlite"));
  const db = new BusyStore(inner);
  const config = {
    workspaceRoot: join(root, "ws"),
    ownerUid: process.getuid!(),
    allowRealLocalTasks: true,
    routingPolicyLoader: policy,
    verifyRoutingCapability: () => true,
    leaseMs,
  };
  const c = new Controller(db, config);
  const actor = c.localActor();
  const ids = Array.from({ length: count }, (_, i) => "C" + (i + 1));
  c.importTasks(ids.map(task) as never, actor);
  for (const id of ids) {
    c.addEvidence(
      {
        id: "src-" + id,
        taskId: id,
        kind: "LOCAL",
        uri: "x",
        revision: "r1",
        digest: "a".repeat(64),
        retrievedAt: now(),
        authorityTier: "PLANNING",
        authentication: "LOCAL_OWNER_REQUEST",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: [],
        metadata: {},
      },
      actor,
    );
    c.grant(
      id,
      {
        id: "g-" + id,
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/" + id],
        decisionText: "go",
        sourceRef: "test",
      },
      actor,
    );
  }
  return {
    db,
    c,
    actor,
    other: () => new Controller(inner, config),
    lease: (id: string) =>
      JSON.parse(
        inner.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", id)!
          .body,
      ).leaseUntil as number,
    attempt: (id: string, taskId = "C1") =>
      c.inspect(taskId).attempts.find((a: any) => a.id === id),
    events: (kind: string) =>
      inner
        .all<{
          body: string;
        }>("SELECT body FROM events WHERE kind=? ORDER BY seq", kind)
        .map((r) => JSON.parse(r.body)),
    close: () => {
      inner.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const receipt = (
  r: ProviderRequest,
  fields: Partial<ProviderReceipt>,
): ProviderReceipt => ({
  runId: r.runId,
  taskId: r.taskId,
  provider: r.provider,
  model: r.model,
  effort: r.effort,
  sessionId: randomUUID(),
  exitCode: 0,
  status: "SUCCEEDED",
  startedAt: now(),
  endedAt: now(),
  output: "done",
  tests: [],
  costUsd: 0.01,
  tokens: 10,
  identityVerified: true,
  simulation: false,
  ...fields,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (condition: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await sleep(10);
  }
};
const write = (cwd: string, name: string, taskId = "C1") => {
  mkdirSync(join(cwd, "output", taskId), { recursive: true });
  writeFileSync(join(cwd, "output", taskId, name), name + "\n");
};
const aborted = (r: ProviderRequest) =>
  new Promise<void>((resolve) =>
    r.signal?.aborted
      ? resolve()
      : r.signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
const cancelled = (r: ProviderRequest, fields: Partial<ProviderReceipt> = {}) =>
  receipt(r, {
    status: "CANCELLED",
    exitCode: null,
    identityVerified: false,
    output: "CANCELLED",
    ...fields,
  });
/** A run that writes half its work, then waits until the controller stops it. */
const stoppedByController = (
  db: BusyStore,
  usage: { costUsd: number | null; tokens: number | null },
): ProviderAdapter => ({
  async execute(r) {
    write(r.cwd, "half.txt");
    db.held = true;
    await aborted(r);
    db.held = false;
    return cancelled(r, usage);
  },
});
const succeeding = (seen?: ProviderRequest[]): ProviderAdapter => ({
  async execute(r) {
    seen?.push(r);
    write(r.cwd, "done.txt");
    return receipt(r, {});
  },
});

test("busy and locked SQLite errors are recognised, extended codes included; others are not", () => {
  const root = mkdtempSync(join(tmpdir(), "longform-busy-"));
  try {
    const path = join(root, "x.sqlite");
    const holder = new DatabaseSync(path);
    holder.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x)");
    holder.exec("BEGIN IMMEDIATE");
    const other = new DatabaseSync(path);
    other.exec("PRAGMA busy_timeout=0");
    let real: unknown;
    try {
      other.exec("BEGIN IMMEDIATE");
    } catch (error) {
      real = error;
    }
    holder.exec("ROLLBACK");
    holder.close();
    other.close();
    assert.ok(real, "a second writer was refused");
    assert.equal(databaseBusy(real), true);
    for (const errcode of [5, 6, 261, 517, 773, 262])
      assert.equal(
        databaseBusy({ errcode, message: "x" }),
        true,
        String(errcode),
      );
    for (const errcode of [1, 11, 19])
      assert.equal(
        databaseBusy({ errcode, message: "database is locked" }),
        false,
      );
    assert.equal(databaseBusy(new Error("database is locked")), true);
    assert.equal(databaseBusy(new Error("LEASE_NOT_OWNED")), false);
    assert.equal(databaseBusy(undefined), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose heartbeat finds the database busy goes on while its lease has room, and finishes as usual", async () => {
  const f = setup(9_000);
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    const adapter: ProviderAdapter = {
      async execute(r) {
        // The next heartbeat is refused, as another session's long write would.
        f.db.refuse = 1;
        await until(() => f.db.refused === 1 && f.db.throughAfterRefusal >= 1);
        write(r.cwd, "done.txt");
        return receipt(r, {});
      },
    };
    const r = await f.c.execute(a, adapter, f.actor);
    assert.equal(r.status, "SUCCEEDED");
    const run = f.attempt(a.id);
    assert.equal(run.state, "SUCCEEDED");
    assert.equal(run.interruption, undefined);
    assert.equal(f.events("RUN_STOPPED_BY_CONTROLLER").length, 0);
    assert.equal(f.c.task("C1").status, "WAITING_REVIEW");
  } finally {
    f.close();
  }
});

test("a finished run's result waits out a busy database instead of being lost", async () => {
  const f = setup(3_000);
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    const adapter: ProviderAdapter = {
      async execute(r) {
        write(r.cwd, "done.txt");
        // Busy just as the result is to be recorded; free again shortly.
        f.db.held = true;
        setTimeout(() => (f.db.held = false), 400);
        return receipt(r, {});
      },
    };
    const r = await f.c.execute(a, adapter, f.actor);
    assert.equal(r.status, "SUCCEEDED");
    assert.ok(f.db.refused >= 1, "the first recording attempt was refused");
    assert.equal(f.attempt(a.id).state, "SUCCEEDED");
    assert.equal(f.c.task("C1").status, "WAITING_REVIEW");
  } finally {
    f.close();
  }
});

test("a run the database keeps busy until its lease is at risk is stopped as interrupted work, and the step resumes its files", async () => {
  const f = setup(3_000);
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    const r = await f.c.execute(
      a,
      stoppedByController(f.db, { costUsd: 0.1, tokens: 20 }),
      f.actor,
    );
    assert.equal(r.status, "CANCELLED");
    const run = f.attempt(a.id);
    assert.equal(run.state, "CANCELLED");
    assert.equal(run.interruption.cause, "DATABASE_BUSY");
    assert.match(run.interruption.reason, /database is locked/);
    assert.equal(run.interruption.snapshot.resumable, true);
    // Not failed work: the task waits as a run that never started leaves it.
    assert.equal(f.c.task("C1").status, "BLOCKED");
    // It still counts against the step's retry allowance.
    assert.equal(f.c.stepRetriesLeft(run.step), PROVIDER_RETRIES_PER_STEP - 1);
    // The step is tried again from the files it left.
    const seen: ProviderRequest[] = [];
    const next = f.c.reserve("C1", { requestKey: "k2" }, f.actor) as any;
    assert.equal(next.resumes, a.id);
    assert.equal(
      readFileSync(join(next.workspace, "output", "C1", "half.txt"), "utf8"),
      "half.txt\n",
    );
    assert.equal(
      (await f.c.execute(next, succeeding(seen), f.actor)).status,
      "SUCCEEDED",
    );
    assert.match(
      seen[0]!.brief,
      /stopped by the orchestrator because its shared database stayed busy/,
    );
    assert.doesNotMatch(seen[0]!.brief, /usage limit/);
  } finally {
    f.close();
  }
});

test("a stopped run whose usage is unknown keeps its custody; reconciled, its step runs again, three times before the owner's word", async () => {
  const f = setup(3_000);
  try {
    let step = "";
    for (let i = 0; i < PROVIDER_RETRIES_PER_STEP; i++) {
      const a = f.c.reserve("C1", { requestKey: "k" + i }, f.actor);
      await f.c
        .execute(
          a,
          stoppedByController(f.db, { costUsd: null, tokens: null }),
          f.actor,
        )
        .catch(() => undefined);
      const run = f.attempt(a.id);
      step = run.step;
      assert.equal(run.state, "UNKNOWN");
      assert.equal(run.interruption.cause, "DATABASE_BUSY");
      // Its custody holds the task until it is reconciled.
      assert.throws(() =>
        f.c.reserve("C1", { requestKey: "held" + i }, f.actor),
      );
      f.c.addEvidence(
        {
          id: "reconcile-" + a.id,
          taskId: "C1",
          kind: "LOCAL",
          uri: "local-assessment:x",
          revision: "rev1",
          digest: "b".repeat(64),
          retrievedAt: now(),
          authorityTier: "UNVERIFIED",
          authentication: "LOCAL_IMPORT",
          currentness: "CURRENT_AT_RETRIEVAL",
          claims: ["operator assessment"],
          metadata: {
            runId: a.id,
            reconciliation: {
              processStopped: true,
              externalEffects: "NONE",
              assessment: "stopped by a busy database; process gone",
              usage: { costUsd: 0, tokens: 0 },
            },
          },
        },
        f.actor,
      );
      f.c.reconcile(a.id, "CANCELLED", "reconcile-" + a.id, f.actor);
      assert.equal(f.attempt(a.id).interruption.snapshot.resumable, true);
    }
    // Three interruptions use up the step's allowance: the owner decides.
    assert.equal(f.c.stepRetriesLeft(step), 0);
    assert.throws(
      () => f.c.reserve("C1", { requestKey: "k-last" }, f.actor),
      /PROVIDER_RETRIES_EXHAUSTED/,
    );
  } finally {
    f.close();
  }
});

test("a cancellation stays a cancellation, also one recorded elsewhere while the database is busy", async () => {
  const f = setup(3_000, 2);
  try {
    // Cancelled in this process: the run stops at once, not interrupted.
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    await f.c
      .execute(
        a,
        {
          async execute(r) {
            f.c.cancel(a.id, f.actor);
            await aborted(r);
            return cancelled(r);
          },
        },
        f.actor,
      )
      .catch(() => undefined);
    assert.equal(f.attempt(a.id).interruption, undefined);
    assert.equal(limitEnded(f.attempt(a.id)), false);
    // Cancelled by another controller, then the database stays busy, so this
    // process never reads the request and stops the run for the busy
    // database: still a cancelled run, never retried on its own.
    const b = f.c.reserve("C2", { requestKey: "k2" }, f.actor);
    await f.c
      .execute(
        b,
        {
          async execute(r) {
            const other = f.other();
            other.cancel(b.id, other.localActor());
            f.db.held = true;
            await aborted(r);
            f.db.held = false;
            return cancelled(r);
          },
        },
        f.actor,
      )
      .catch(() => undefined);
    const run = f.attempt(b.id, "C2");
    assert.equal(run.cancelRequested, true);
    assert.equal(limitEnded(run), false);
  } finally {
    f.close();
  }
});

test("with three runs held up at once, each still stops before its lease runs out (review R1-1)", async () => {
  const f = setup(3_000, 3);
  try {
    // A refusal blocks the process for a tenth of the lock wait in force, as
    // SQLite's busy timeout does (5 s by default, at a tenth of real time,
    // like the lease).
    f.db.blockPerWaitMs = 0.1;
    const stops: Array<{ at: number; leaseUntil: number }> = [];
    const runs = ["C1", "C2", "C3"].map((id, i) =>
      f.c.reserve(id, { requestKey: "k" + i }, f.actor),
    );
    let started = 0;
    const adapter: ProviderAdapter = {
      async execute(r) {
        write(r.cwd, "half.txt", r.taskId);
        started++;
        await until(() => started === 3);
        f.db.held = true;
        await aborted(r);
        stops.push({ at: Date.now(), leaseUntil: f.lease(r.runId) });
        await until(() => stops.length === 3);
        f.db.held = false;
        return cancelled(r);
      },
    };
    await Promise.all(runs.map((a) => f.c.execute(a, adapter, f.actor)));
    assert.equal(stops.length, 3);
    for (const stop of stops)
      assert.ok(
        stop.at < stop.leaseUntil,
        `stopped at ${stop.at}, lease to ${stop.leaseUntil}`,
      );
    runs.forEach((a, i) => {
      const run = f.attempt(a.id, "C" + (i + 1));
      assert.equal(run.state, "CANCELLED");
      assert.equal(run.interruption.cause, "DATABASE_BUSY");
    });
  } finally {
    f.close();
  }
});

test("other work in the process that meets the busy database near a lease's end cannot hold the runs past it (review R2-1)", async () => {
  const f = setup(3_000, 3);
  try {
    // A refusal blocks for about a third of the lock wait in force.
    f.db.blockPerWaitMs = 0.32;
    const stops: Array<{ at: number; leaseUntil: number }> = [];
    const runs = ["C1", "C2"].map((id, i) =>
      f.c.reserve(id, { requestKey: "k" + i }, f.actor),
    );
    let started = 0;
    let refusedElsewhere: unknown;
    const adapter: ProviderAdapter = {
      async execute(r) {
        started++;
        await until(() => started === 2);
        f.db.held = true;
        if (r.taskId === "C1") {
          // After the runs' first busy beats, another advance in this
          // process reserves work and meets the busy database.
          const t0 = Date.now();
          await until(() => f.db.refused >= 2);
          await sleep(Math.max(0, t0 + 1_500 - Date.now()));
          try {
            f.c.reserve("C3", { requestKey: "k3" }, f.actor);
          } catch (error) {
            refusedElsewhere = error;
          }
        }
        await aborted(r);
        stops.push({ at: Date.now(), leaseUntil: f.lease(r.runId) });
        await until(() => stops.length === 2);
        f.db.held = false;
        return cancelled(r);
      },
    };
    await Promise.all(runs.map((a) => f.c.execute(a, adapter, f.actor)));
    assert.equal(databaseBusy(refusedElsewhere), true);
    for (const stop of stops)
      assert.ok(
        stop.at < stop.leaseUntil,
        `stopped at ${stop.at}, lease to ${stop.leaseUntil}`,
      );
    runs.forEach((a, i) => {
      const run = f.attempt(a.id, "C" + (i + 1));
      assert.equal(run.state, "CANCELLED");
      assert.equal(run.interruption.cause, "DATABASE_BUSY");
    });
  } finally {
    f.close();
  }
});

test("a stopped run that another controller recovered first is still interrupted work (review R1-2)", async () => {
  const f = setup(3_000);
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    await f.c
      .execute(
        a,
        {
          async execute(r) {
            write(r.cwd, "half.txt");
            f.db.held = true;
            await aborted(r);
            // The database stays busy past the lease; another controller
            // then recovers the lapsed lease before this one can record.
            const other = f.other();
            other.recover(other.localActor(), Date.now() + 10 * 3_000);
            f.db.held = false;
            throw new Error("ADAPTER_FAILED_AFTER_STOP");
          },
        },
        f.actor,
      )
      .catch(() => undefined);
    const run = f.attempt(a.id);
    assert.equal(run.state, "UNKNOWN");
    assert.equal(run.interruption.cause, "DATABASE_BUSY");
    f.c.addEvidence(
      {
        id: "reconcile-" + a.id,
        taskId: "C1",
        kind: "LOCAL",
        uri: "local-assessment:x",
        revision: "rev1",
        digest: "b".repeat(64),
        retrievedAt: now(),
        authorityTier: "UNVERIFIED",
        authentication: "LOCAL_IMPORT",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: ["operator assessment"],
        metadata: {
          runId: a.id,
          reconciliation: {
            processStopped: true,
            externalEffects: "NONE",
            assessment: "stopped by a busy database; process gone",
            usage: { costUsd: 0, tokens: 0 },
          },
        },
      },
      f.actor,
    );
    f.c.reconcile(a.id, "CANCELLED", "reconcile-" + a.id, f.actor);
    assert.equal(limitEnded(f.attempt(a.id)), true);
    const next = f.c.reserve("C1", { requestKey: "k2" }, f.actor) as any;
    assert.equal(next.resumes, a.id);
  } finally {
    f.close();
  }
});
