import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller, PROVIDER_RETRIES_PER_STEP } from "../src/controller.js";
import { Orchestrator } from "../src/orchestrator.js";
import { scanProviderLimitsAt } from "../src/limit-scan.js";
import { SqliteStore } from "../src/store.js";
import type { RoutingPolicy } from "../src/routing.js";
import {
  claudeLimit,
  codexLimit,
  codexSessionSignal,
  ProviderLimitSchema,
  validReset,
  type ProviderLimit,
} from "../src/limits.js";
import {
  derivePause,
  pauseUntil,
  MAX_UNTIMED_LIMITS,
  type PauseEvent,
} from "../src/pause.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";

// Provider usage limits as a pause, with recovery .

const now = () => new Date().toISOString();

function task(id: string, provider: "claude" | "codex") {
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
    providers: [provider],
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
      deadlineMs: 10_000,
      maxAttempts: 5,
      maxCostUsd: 10,
      maxTokens: 100_000,
    },
    artifactRevision: "rev1",
    simulation: false,
    createdAt: now(),
  };
}
const route = (provider: "claude" | "codex", level = "ROUTINE") => ({
  id: provider + "-" + level.toLowerCase(),
  level,
  provider,
  model: provider + "-model",
  effort: "low",
  roles: ["worker", "reviewer", "assessor", "advisor", "moderator"],
  simulation: false,
  enabled: true,
  capability: {
    provider,
    model: provider + "-model",
    effort: "low",
    verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "file:test",
  },
});
const policy = () =>
  ({
    version: 1,
    id: "p",
    routes: [
      route("claude"),
      route("codex"),
      { ...route("claude", "STANDARD"), roles: ["reviewer"] },
      { ...route("codex", "STANDARD"), roles: ["reviewer"] },
    ],
  }) as RoutingPolicy;

/** Two Claude tasks and one Codex task; `again()` opens a second controller on the same database. */
function setup(
  options: { policy?: () => RoutingPolicy; extra?: ReturnType<typeof task>[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-limits-"));
  const path = join(root, "state.sqlite");
  const stores: SqliteStore[] = [];
  const open = () => {
    const db = new SqliteStore(path);
    stores.push(db);
    return {
      db,
      c: new Controller(db, {
        workspaceRoot: join(root, "ws"),
        ownerUid: process.getuid!(),
        allowRealLocalTasks: true,
        routingPolicyLoader: options.policy ?? policy,
        verifyRoutingCapability: () => true,
      }),
    };
  };
  const { db, c } = open();
  const actor = c.localActor();
  const tasks = [
    task("C1", "claude"),
    task("C2", "claude"),
    task("X1", "codex"),
    ...(options.extra ?? []),
  ];
  c.importTasks(tasks as never, actor);
  for (const t of tasks) {
    c.addEvidence(
      {
        id: "src-" + t.id,
        taskId: t.id,
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
      t.id,
      {
        id: "g-" + t.id,
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: [t.writePaths[0]!],
        decisionText: "go",
        sourceRef: "test",
      },
      actor,
    );
  }
  return {
    root,
    db,
    c,
    actor,
    again: () => open().c,
    events: (kind: string) =>
      db
        .all<{
          body: string;
        }>("SELECT body FROM events WHERE kind=? ORDER BY seq", kind)
        .map((r) => JSON.parse(r.body)),
    attempt: (id: string) =>
      c
        .inspect(
          c
            .tasks()
            .find((t) =>
              c.inspect(t.id).attempts.some((a: any) => a.id === id),
            )!.id,
        )
        .attempts.find((a: any) => a.id === id),
    close: () => {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const usageLimit = (resetInMs: number | null = 10 * 60_000): ProviderLimit => ({
  kind: "USAGE_LIMIT",
  evidence: 'claude result envelope: api_error "usage_limit_reached"',
  resetsAt:
    resetInMs === null ? null : new Date(Date.now() + resetInMs).toISOString(),
  resetBasis: resetInMs === null ? "NONE" : "STATED_WITH_ZONE",
  message: "You've hit your session limit",
});
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
  exitCode: 1,
  status: "FAILED",
  startedAt: now(),
  endedAt: now(),
  output: "limit",
  tests: [],
  costUsd: 0,
  tokens: 0,
  identityVerified: false,
  simulation: false,
  ...fields,
});
/** A run that does some work (`write`), then hits the provider's limit. */
const limited = (
  options: {
    write?: (cwd: string) => void;
    limit?: ProviderLimit;
    usage?: { costUsd: number | null; tokens: number | null };
  } = {},
): ProviderAdapter => ({
  async execute(r) {
    options.write?.(r.cwd);
    return receipt(r, {
      providerLimit: options.limit ?? usageLimit(),
      costUsd: options.usage ? options.usage.costUsd : 1.25,
      tokens: options.usage ? options.usage.tokens : 900,
    });
  },
});
const succeeding = (seen?: ProviderRequest[]): ProviderAdapter => ({
  async execute(r) {
    seen?.push(r);
    mkdirSync(join(r.cwd, "output", r.taskId), { recursive: true });
    writeFileSync(join(r.cwd, "output", r.taskId, "done.txt"), "done\n");
    return receipt(r, {
      status: "SUCCEEDED",
      exitCode: 0,
      identityVerified: true,
      output: "done",
      costUsd: 0.01,
      tokens: 10,
    });
  },
});
const clear = (
  f: ReturnType<typeof setup>,
  provider: "claude" | "codex" = "claude",
) =>
  f.c.clearProviderPause(
    provider,
    {
      reason: "usage page shows the limit reset",
      evidence: ["usage page 03:00"],
      sourceRef: "test:operator",
    },
    f.actor,
  );
/**
 * A pause that has already run out, as a limit observed a while ago leaves
 * it (the journal is append-only, so time is simulated by the record).
 */
const ranOut = (
  f: ReturnType<typeof setup>,
  provider: "claude" | "codex" = "claude",
) =>
  f.db.event("PROVIDER_LIMIT_OBSERVED", null, {
    provider,
    kind: "USAGE_LIMIT",
    until: new Date(Date.now() - 1_000).toISOString(),
    validResetAt: new Date(Date.now() - 61_000).toISOString(),
    observedAt: new Date(Date.now() - 600_000).toISOString(),
  });
/** Reconcile an unknown run as stopped with no effects, stating its usage. */
const reconcile = (
  f: ReturnType<typeof setup>,
  runId: string,
  taskId: string,
) => {
  f.c.addEvidence(
    {
      id: "reconcile-" + runId,
      taskId,
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
        runId,
        reconciliation: {
          processStopped: true,
          externalEffects: "NONE",
          assessment: "process gone; no effects",
          usage: { costUsd: 0.5, tokens: 300 },
        },
      },
    },
    f.actor,
  );
  f.c.reconcile(runId, "FAILED", "reconcile-" + runId, f.actor);
};

test("limits are recognised from harness records only, with resets read in the stated or host zone", () => {
  const at = Date.parse("2026-10-23T02:22:00Z");
  const claude = claudeLimit(
    JSON.stringify({
      type: "result",
      is_error: true,
      api_error_status: 429,
      api_error: "usage_limit_reached",
      result: "You've hit your session limit · resets 10pm (America/Denver)",
    }),
    at,
  )!;
  assert.deepEqual(
    [claude.kind, claude.resetsAt, claude.resetBasis],
    ["USAGE_LIMIT", "2026-10-23T04:00:00.000Z", "STATED_WITH_ZONE"],
  );
  assert.equal(
    claudeLimit(
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "slow down",
      }),
      at,
    )!.kind,
    "RATE_LIMIT",
  );
  assert.equal(
    claudeLimit(
      JSON.stringify({
        type: "result",
        is_error: true,
        result:
          "You've hit your session limit · resets 10pm (America/Denver)",
      }),
      at,
    ),
    undefined,
    "model text alone is not a limit",
  );
  assert.equal(
    claudeLimit(
      JSON.stringify({
        type: "result",
        is_error: false,
        api_error: "usage_limit_reached",
      }),
      at,
    ),
    undefined,
  );
  assert.equal(
    claudeLimit(
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error: "usage_limit_reached",
        result: "resets 10pm (Not/AZone)",
      }),
      at,
    )!.resetsAt,
    null,
  );
  const log = [
    '{"type":"session_meta","payload":{"id":"t1"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1}},"rate_limits":{"primary":{"used_percent":100.0,"resets_at":1792392603},"secondary":{"used_percent":20,"resets_at":1792900000}}}}',
    '{"type":"event_msg","payload":{"type":"task_complete","error":{"message":"try again at Oct 19th, 2026 12:50 AM.","codex_error_info":"usage_limit_exceeded"}}}',
  ].join("\n");
  assert.equal(codexSessionSignal(log, "other-thread"), undefined);
  const fromLog = codexLimit(
    "",
    codexSessionSignal(log, "t1"),
    Date.parse("2026-10-19T03:00:00Z"),
    "America/Denver",
  )!;
  assert.deepEqual(
    [fromLog.kind, fromLog.resetsAt, fromLog.resetBasis],
    ["USAGE_LIMIT", "2026-10-19T06:50:03.000Z", "STRUCTURED"],
  );
  const stream = codexLimit(
    '{"type":"error","message":"You’ve hit your usage limit. try again at 1:58 PM."}',
    undefined,
    Date.parse("2026-10-19T20:00:00Z"),
    "America/Denver",
  )!;
  assert.deepEqual(
    [stream.resetsAt, stream.resetBasis],
    ["2026-10-20T19:58:00.000Z", "STATED_HOST_ZONE"],
  );
  assert.equal(
    codexLimit(
      '{"type":"error","message":"stream disconnected"}',
      undefined,
      at,
      "UTC",
    ),
    undefined,
  );
  // Only a reset after the observation and at most 8 days away is trusted.
  assert.equal(validReset(new Date(at - 1).toISOString(), at), undefined);
  assert.equal(
    validReset(new Date(at + 9 * 86_400_000).toISOString(), at),
    undefined,
  );
  assert.equal(
    validReset(new Date(at + 3_600_000).toISOString(), at),
    at + 3_600_000,
  );
});

test("a pause lasts to a valid reset plus a minute, else a doubling recheck interval; six limits without a reset hold it", () => {
  const at = Date.now();
  const events: PauseEvent[] = [];
  const observe = (limit: ProviderLimit) => {
    const u = pauseUntil(limit, at, events, "claude");
    events.push({
      seq: events.length + 1,
      kind: "PROVIDER_LIMIT_OBSERVED",
      body: {
        provider: "claude",
        kind: limit.kind,
        until: new Date(u.until).toISOString(),
        validResetAt: u.validResetAt
          ? new Date(u.validResetAt).toISOString()
          : null,
        observedAt: new Date(at).toISOString(),
      },
    });
    return u.until - at;
  };
  const timed = usageLimit(3_600_000);
  assert.equal(observe(timed), Date.parse(timed.resetsAt!) + 60_000 - at);
  const intervals = [];
  for (let i = 0; i < MAX_UNTIMED_LIMITS; i++)
    intervals.push(observe(usageLimit(null)) / 60_000);
  assert.deepEqual(intervals, [15, 30, 60, 120, 240, 240]);
  assert.equal(derivePause(events, "claude", at).state, "HELD");
  assert.equal(derivePause(events, "codex", at).state, "CLEAR");
  events.push({
    seq: 99,
    kind: "PROVIDER_PAUSE_CLEARED",
    body: { provider: "claude" },
  });
  assert.equal(derivePause(events, "claude", at).state, "CLEAR");
  const rate = pauseUntil(
    { ...usageLimit(null), kind: "RATE_LIMIT" },
    at,
    [],
    "claude",
  );
  assert.equal(rate.until - at, 2 * 60_000);
});

test("a run cut off by the provider's limit after partial work keeps its attempt and usage, pauses the provider and is not failed work", async () => {
  const f = setup();
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    const r = await f.c.execute(
      a,
      limited({
        write: (cwd) => (
          mkdirSync(join(cwd, "output", "C1"), { recursive: true }),
          writeFileSync(join(cwd, "output", "C1", "half.txt"), "half\n")
        ),
      }),
      f.actor,
    );
    assert.equal(r.status, "FAILED");
    const run = f.attempt(a.id);
    assert.equal(run.state, "FAILED");
    assert.equal(run.interruption.cause, "PROVIDER_LIMIT");
    assert.equal(run.interruption.snapshot.resumable, true);
    // Its usage stays recorded and it counts as an attempt.
    const usage = (f.c as any).usageLedger(f.c.task("C1"));
    assert.ok(usage.some((u: any) => u.tokens === 900 && u.costUsd === 1.25));
    // Not failed work: the task waits as a run that never started would leave it.
    assert.equal(f.c.task("C1").status, "BLOCKED");
    assert.ok(
      !f.c
        .reasons("C1")
        .includes("UNCHANGED_FAILED_ATTEMPT_REQUIRES_RECONCILIATION"),
    );
    // Claude is paused for every role; Codex goes on.
    const pause = f.c.providerPause("claude");
    assert.equal(pause.state, "PAUSED");
    assert.throws(
      () => f.c.reserve("C2", { requestKey: "k2" }, f.actor),
      /PROVIDER_PAUSED:claude:until=/,
    );
    assert.throws(
      () => f.c.reserve("C2", { requestKey: "k3", role: "assessor" }, f.actor),
      /PROVIDER_PAUSED:claude/,
    );
    const x = f.c.reserve("X1", { requestKey: "kx" }, f.actor);
    assert.equal(
      (await f.c.execute(x, succeeding(), f.actor)).status,
      "SUCCEEDED",
    );
    // Nothing was reserved for the refused runs.
    assert.equal(f.c.plan().active, 0);
    // A second controller (another process) and a restarted one see the pause.
    const second = f.again();
    assert.equal(second.providerPause("claude").state, "PAUSED");
    assert.throws(
      () => second.reserve("C2", { requestKey: "k4" }, second.localActor()),
      /PROVIDER_PAUSED/,
    );
    assert.equal(f.events("PROVIDER_LIMIT_OBSERVED").length, 1);
  } finally {
    f.close();
  }
});

test("a run that waited while the provider was paused is released before launch, by the controller or the runner's gate", async () => {
  const f = setup();
  try {
    const first = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    const second = f.c.reserve("C2", { requestKey: "k2" }, f.actor);
    await f.c.execute(first, limited(), f.actor);
    await assert.rejects(
      f.c.execute(second, succeeding(), f.actor),
      /PROVIDER_PAUSED:claude/,
    );
    assert.equal(f.attempt(second.id).state, "NOT_STARTED");
    assert.equal(f.c.plan().active, 0);
    // The runner asks the gate just before it spawns the provider.
    clear(f);
    const third = f.c.reserve("C2", { requestKey: "k3" }, f.actor);
    const gated: ProviderAdapter = {
      async execute(r) {
        f.db.event("PROVIDER_LIMIT_OBSERVED", null, {
          provider: "claude",
          kind: "USAGE_LIMIT",
          until: new Date(Date.now() + 600_000).toISOString(),
          validResetAt: new Date(Date.now() + 540_000).toISOString(),
          observedAt: now(),
        });
        const refusal = r.launchGate?.();
        assert.match(String(refusal), /PROVIDER_PAUSED:claude/);
        return receipt(r, {
          notLaunched: true,
          output: String(refusal),
          costUsd: 0,
          tokens: 0,
        });
      },
    };
    await f.c.execute(third, gated, f.actor);
    assert.equal(f.attempt(third.id).state, "NOT_STARTED");
  } finally {
    f.close();
  }
});

test("a limited run whose usage is unknown keeps its custody and still pauses; reconciled, its retry resumes its files", async () => {
  const f = setup();
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    await f.c
      .execute(
        a,
        limited({
          usage: { costUsd: null, tokens: null },
          write: (cwd) => (
            mkdirSync(join(cwd, "output", "C1"), { recursive: true }),
            writeFileSync(join(cwd, "output", "C1", "half.txt"), "half\n")
          ),
        }),
        f.actor,
      )
      .catch(() => undefined);
    const run = f.attempt(a.id);
    assert.equal(run.state, "UNKNOWN");
    assert.equal(run.interruption.cause, "PROVIDER_LIMIT");
    assert.equal(f.c.providerPause("claude").state, "PAUSED");
    clear(f);
    // Its custody holds the task until it is reconciled.
    assert.throws(() => f.c.reserve("C1", { requestKey: "k2" }, f.actor));
    reconcile(f, a.id, "C1");
    const seen: ProviderRequest[] = [];
    const next = f.c.reserve("C1", { requestKey: "k3" }, f.actor) as any;
    assert.equal(next.resumes, a.id);
    assert.equal(
      readFileSync(join(next.workspace, "output", "C1", "half.txt"), "utf8"),
      "half\n",
    );
    assert.equal(
      (await f.c.execute(next, succeeding(seen), f.actor)).status,
      "SUCCEEDED",
    );
    assert.match(seen[0]!.brief, /cut off by the provider's usage limit/);
  } finally {
    f.close();
  }
});

test("while a provider is rechecked, one run or probe at a time tests it, across controllers; an unsettled half-open run keeps the token", async () => {
  const f = setup();
  try {
    ranOut(f);
    assert.equal(f.c.providerPause("claude").state, "RECHECK");
    const other = f.again(),
      otherActor = other.localActor();
    const tester = f.c.reserve("C1", { requestKey: "k2" }, f.actor) as any;
    assert.equal(tester.recheckOf, f.c.providerPause("claude").episode);
    assert.throws(
      () => other.reserve("C2", { requestKey: "k3" }, otherActor),
      /PROVIDER_RECHECK_IN_PROGRESS/,
    );
    assert.ok("refused" in other.beginRecheckProbe("claude", otherActor));
    // The tester's outcome is unknown: it keeps the token until reconciled.
    await f.c
      .execute(
        tester,
        {
          execute: async (r) =>
            receipt(r, { status: "UNKNOWN", costUsd: null, tokens: null }),
        },
        f.actor,
      )
      .catch(() => undefined);
    assert.equal(f.attempt(tester.id).state, "UNKNOWN");
    assert.throws(
      () => other.reserve("C2", { requestKey: "k4" }, otherActor),
      /PROVIDER_RECHECK_IN_PROGRESS/,
    );
    assert.match(
      String(f.c.recheckHolder(f.c.providerPause("claude"))),
      /run /,
    );
    // A probe's token lasts while its process lives; a dead one frees it.
    f.db.event("PROVIDER_RECHECK_STARTED", null, {
      provider: "codex",
      episode: 1,
      probeId: "dead",
      pid: 999_999_999,
      processStart: "1",
    });
    assert.equal(
      f.c.recheckHolder({ provider: "codex", state: "RECHECK", episode: 1 }),
      undefined,
    );
  } finally {
    f.close();
  }
});

test("a successful recheck run or probe clears the pause; a probe's token is held while it runs", async () => {
  const f = setup();
  try {
    ranOut(f);
    const probe = f.c.beginRecheckProbe("claude", f.actor);
    assert.ok("probeId" in probe);
    assert.throws(
      () => f.c.reserve("C2", { requestKey: "k2" }, f.actor),
      /PROVIDER_RECHECK_IN_PROGRESS/,
    );
    f.c.endRecheckProbe("claude", (probe as any).probeId, "FAILED", f.actor);
    assert.equal(
      f.c.providerPause("claude").state,
      "RECHECK",
      "a failure without a limit frees the token only",
    );
    const run = f.c.reserve("C2", { requestKey: "k3" }, f.actor);
    await f.c.execute(run, succeeding(), f.actor);
    assert.equal(f.c.providerPause("claude").state, "CLEAR");
    assert.equal(f.events("PROVIDER_PAUSE_CLEARED").at(-1).by.runId, run.id);
  } finally {
    f.close();
  }
});

test("after six limits without a trusted reset the provider is held until the operator clears it with evidence", async () => {
  const f = setup();
  try {
    for (let i = 0; i < MAX_UNTIMED_LIMITS; i++)
      f.db.event("PROVIDER_LIMIT_OBSERVED", null, {
        provider: "claude",
        kind: "USAGE_LIMIT",
        until: new Date(Date.now() - 1_000).toISOString(),
        validResetAt: null,
        observedAt: now(),
      });
    assert.equal(f.c.providerPause("claude").state, "HELD");
    assert.throws(
      () => f.c.reserve("C1", { requestKey: "k1" }, f.actor),
      /PROVIDER_PAUSED:claude:held/,
    );
    assert.ok(
      "refused" in f.c.beginRecheckProbe("claude", f.actor),
      "no automatic probe",
    );
    assert.throws(() =>
      f.c.clearProviderPause(
        "claude",
        { reason: "x", evidence: [], sourceRef: "s" },
        f.actor,
      ),
    );
    clear(f);
    assert.equal(f.c.providerPause("claude").state, "CLEAR");
    f.c.reserve("C1", { requestKey: "k2" }, f.actor);
  } finally {
    f.close();
  }
});

test("a step the provider's limit keeps cutting off stops after three runs until the owner extends it; attempts still count", async () => {
  const f = setup();
  try {
    const ids: string[] = [];
    for (let i = 0; i < PROVIDER_RETRIES_PER_STEP; i++) {
      const a = f.c.reserve("C1", { requestKey: "k" + i }, f.actor);
      ids.push(a.id);
      await f.c.execute(a, limited(), f.actor);
      clear(f);
    }
    const step = f.attempt(ids[0]!).step;
    assert.throws(
      () => f.c.reserve("C1", { requestKey: "k9" }, f.actor),
      new RegExp(
        "PROVIDER_RETRIES_EXHAUSTED:" +
          step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    assert.equal(f.c.stepRetriesLeft(step), 0);
    f.c.extendRetryAllowance(
      "C1",
      { step, reason: "owner: try again", sourceRef: "test:owner" },
      f.actor,
    );
    assert.equal(f.c.stepRetriesLeft(step), PROVIDER_RETRIES_PER_STEP);
    f.c.reserve("C1", { requestKey: "k10" }, f.actor);
    assert.equal((f.c as any).budget(f.c.task("C1")).maxAttempts, 5);
    assert.equal(
      f.c.inspect("C1").attempts.filter((a: any) => a.state !== "NOT_STARTED")
        .length,
      4,
      "every run counts as an attempt",
    );
  } finally {
    f.close();
  }
});

test("an interrupted run's workspace is resumed only as it was left and within scope; a symlink still pauses the provider", async () => {
  for (const variant of ["out-of-scope", "changed", "symlink"] as const) {
    const f = setup();
    try {
      const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
      await f.c
        .execute(
          a,
          limited({
            write: (cwd) => {
              mkdirSync(join(cwd, "output", "C1"), { recursive: true });
              writeFileSync(join(cwd, "output", "C1", "half.txt"), "half\n");
              if (variant === "out-of-scope")
                writeFileSync(join(cwd, "outside.txt"), "no\n");
              if (variant === "symlink")
                symlinkSync("/etc/hostname", join(cwd, "output", "C1", "link"));
            },
          }),
          f.actor,
        )
        .catch(() => undefined);
      assert.equal(f.c.providerPause("claude").state, "PAUSED", variant);
      const run = f.attempt(a.id);
      clear(f);
      if (variant === "out-of-scope") {
        // A write outside the scope makes the receipt unacceptable: the run
        // is unknown until reconciled, and then its workspace is not resumed.
        assert.equal(run.state, "UNKNOWN");
        assert.equal(run.interruption.snapshot.resumable, false);
        reconcile(f, a.id, "C1");
        assert.throws(
          () => f.c.reserve("C1", { requestKey: "k2" }, f.actor),
          /INTERRUPTED_WORKSPACE_OUT_OF_SCOPE/,
        );
      } else if (variant === "changed") {
        writeFileSync(
          join(run.workspace, "output", "C1", "half.txt"),
          "edited\n",
        );
        assert.throws(
          () => f.c.reserve("C1", { requestKey: "k2" }, f.actor),
          /INTERRUPTED_WORKSPACE_CHANGED/,
        );
      } else {
        // A symlink makes the workspace unreadable for its receipt too: the
        // run is unknown until reconciled, and is then not resumed.
        assert.equal(run.state, "UNKNOWN");
        assert.equal(run.interruption.snapshot.resumable, false);
        assert.match(run.interruption.snapshot.reason, /SNAPSHOT_FAILED/);
        reconcile(f, a.id, "C1");
        const next = f.c.reserve("C1", { requestKey: "k2" }, f.actor) as any;
        assert.equal(next.resumes, undefined, "not resumed: starts as usual");
        assert.equal(
          existsSync(join(next.workspace, "output", "C1", "half.txt")),
          false,
        );
      }
    } finally {
      f.close();
    }
  }
});

test("after a pause the next run goes through ordinary admission: exhausted attempts and changed sources still hold it", async () => {
  const once = { ...task("C3", "claude"), budget: { deadlineMs: 10_000, maxAttempts: 1, maxCostUsd: 10, maxTokens: 100_000 } };
  const f = setup({ extra: [once] });
  try {
    await f.c.execute(f.c.reserve("C3", { requestKey: "k1" }, f.actor), limited(), f.actor);
    clear(f);
    assert.throws(() => f.c.reserve("C3", { requestKey: "k2" }, f.actor), /ATTEMPT_BUDGET_EXHAUSTED/);
    await f.c.execute(f.c.reserve("C1", { requestKey: "k3" }, f.actor), limited(), f.actor);
    clear(f);
    f.c.addEvidence(
      {
        id: "src-C1-v2",
        taskId: "C1",
        kind: "LOCAL",
        uri: "x",
        revision: "r2",
        digest: "c".repeat(64),
        retrievedAt: now(),
        authorityTier: "PLANNING",
        authentication: "LOCAL_OWNER_REQUEST",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: [],
        metadata: {},
        supersedes: "src-C1",
      } as never,
      f.actor,
    );
    assert.throws(() => f.c.reserve("C1", { requestKey: "k4" }, f.actor), /SUPERSEDED_SOURCE/);
  } finally {
    f.close();
  }
});

test("receipts from before limits were recognised are listed for the owner, read-only", async () => {
  const f = setup();
  try {
    await f.c.execute(f.c.reserve("C1", { requestKey: "k1" }, f.actor), limited(), f.actor);
    clear(f);
    // A receipt from before recognition: the envelope is in its output only.
    const legacy = f.c.reserve("C2", { requestKey: "k2" }, f.actor);
    await f.c.execute(
      legacy,
      {
        async execute(r) {
          return receipt(r, {
            output:
              JSON.stringify({ type: "result", is_error: true, api_error_status: 429, api_error: "usage_limit_reached", result: "You've hit your session limit · resets 12pm (America/Denver)" }) + "\n",
          });
        },
      },
      f.actor,
    );
    const events = f.db.all("SELECT seq FROM events").length;
    const found = f.c.scanProviderLimits();
    assert.deepEqual(
      found.map((x) => [x.taskId, x.kind, x.markedInterrupted]),
      [
        ["C1", "USAGE_LIMIT", true],
        ["C2", "USAGE_LIMIT", false],
      ],
    );
    assert.equal(f.db.all("SELECT seq FROM events").length, events, "the scan records nothing");
  } finally {
    f.close();
  }
});

test("a worker whose requested advice comes from a paused provider waits for it rather than going ahead without it", async () => {
  const split = () =>
    ({
      version: 1,
      id: "split",
      routes: [
        { ...route("claude"), roles: ["advisor"] },
        { ...route("codex"), roles: ["worker", "reviewer", "assessor"] },
      ],
    }) as RoutingPolicy;
  const advised = {
    ...task("V1", "codex"),
    providers: ["codex", "claude"],
    advice: { rationale: "Claude knows the house style", sourceRef: "test:owner" },
  };
  const f = setup({ policy: split, extra: [advised as never] });
  try {
    const seen: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      async execute(r) {
        seen.push(r);
        return succeeding().execute(r);
      },
    };
    const o = new Orchestrator(f.c, { codex: adapter, claude: adapter }, "claude");
    const id = o.submit({ requestKey: randomUUID(), prompt: "Do V1", context: { cwd: f.root }, sourceRef: "test:owner" }).request.id;
    o.attach(id, ["V1"]);
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, {
      provider: "claude",
      kind: "USAGE_LIMIT",
      until: new Date(Date.now() + 600_000).toISOString(),
      validResetAt: new Date(Date.now() + 540_000).toISOString(),
      observedAt: now(),
    });
    const view = await o.drive(id, { live: true });
    assert.ok(!seen.some((r) => r.role === "worker" || r.role === "advisor"), seen.map((r) => r.role).join(","));
    assert.ok(
      view.tasks[0]!.steps.some((s: any) => s.stage === "ADVICE_WAITING_PROVIDER" && /PROVIDER_PAUSED:claude/.test(s.detail)),
      JSON.stringify(view.tasks[0]!.steps),
    );
  } finally {
    f.close();
  }
});

test("a review the provider's limit keeps cutting off uses the retry allowance, not the reviewer's three attempts per artifact", async () => {
  const f = setup();
  try {
    await f.c.execute(f.c.reserve("C1", { requestKey: "w" }, f.actor), succeeding(), f.actor);
    for (let i = 0; i < PROVIDER_RETRIES_PER_STEP; i++) {
      await f.c.execute(f.c.reserve("C1", { requestKey: "r" + i, role: "reviewer" }, f.actor), limited(), f.actor);
      clear(f);
    }
    assert.throws(() => f.c.reserve("C1", { requestKey: "r9", role: "reviewer" }, f.actor), /PROVIDER_RETRIES_EXHAUSTED:reviewer:C1:/);
    const step = f.c.inspect("C1").attempts.find((a: any) => a.role === "reviewer").step;
    f.c.extendRetryAllowance("C1", { step, reason: "owner: review again", sourceRef: "test:owner" }, f.actor);
    f.c.reserve("C1", { requestKey: "r10", role: "reviewer" }, f.actor);
  } finally {
    f.close();
  }
});

test("reset times that do not exist, that a clock change skips or repeats, or that no date can hold are not trusted (review S3-6)", () => {
  const env = (text: string) => JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: text });
  assert.equal(claudeLimit(env("resets Feb 31, 1pm (UTC)"), Date.parse("2026-02-28T12:00:00Z"))!.resetsAt, null);
  // Past clock changes, which every time-zone database agrees on (time-zone
  // data 2026e no longer has the example zone fall back in November 2026, so a test
  // of future changes would depend on the platform's data version).
  assert.equal(claudeLimit(env("resets Mar 10, 2:30am (America/Denver)"), Date.parse("2024-03-09T12:00:00Z"))!.resetsAt, null);
  assert.equal(claudeLimit(env("resets Nov 3, 1:30am (America/Denver)"), Date.parse("2024-11-02T12:00:00Z"))!.resetsAt, null);
  assert.equal(claudeLimit(env("resets Nov 3, 3:30am (America/Denver)"), Date.parse("2024-11-02T12:00:00Z"))!.resetsAt, "2024-11-03T10:30:00.000Z");
  assert.equal(claudeLimit(env("resets 1am (UTC)"), Date.parse("2026-10-31T12:00:00Z"))!.resetsAt, "2026-11-01T01:00:00.000Z");
  // A stated reset at the very end of year 9999 lies past it in UTC.
  const message = "You've hit your usage limit. try again at Dec 31st, 9999 11:59 PM.";
  for (const textual of [
    codexLimit("", { errorInfo: "usage_limit_exceeded", message, rateLimits: [], totalTokenUsage: null }, Date.now(), "America/Denver")!,
    codexLimit(JSON.stringify({ type: "error", message }), undefined, Date.now(), "America/Denver")!,
  ]) {
    assert.deepEqual([textual.kind, textual.resetsAt, textual.resetBasis], ["USAGE_LIMIT", null, "NONE"]);
    assert.ok(ProviderLimitSchema.safeParse(textual).success);
  }
  for (const resetsAt of [9e15, 8e12]) {
    const huge = codexLimit("", { errorInfo: "usage_limit_exceeded", message: null, rateLimits: [{ usedPercent: 100, resetsAt }], totalTokenUsage: null }, Date.now(), "UTC")!;
    assert.deepEqual([huge.kind, huge.resetsAt, huge.resetBasis], ["USAGE_LIMIT", null, "NONE"], String(resetsAt));
    assert.ok(ProviderLimitSchema.safeParse(huge).success, "the limit stays a valid record");
  }
});

test("a cancelled run stays cancelled when the provider's limit also cut it off (review S3-3)", async () => {
  const f = setup();
  try {
    const a = f.c.reserve("C1", { requestKey: "k1" }, f.actor);
    await f.c.execute(
      a,
      {
        async execute(r) {
          f.c.cancel(r.runId, f.actor);
          return receipt(r, { providerLimit: usageLimit(), costUsd: 0.1, tokens: 20 });
        },
      },
      f.actor,
    );
    const run = f.attempt(a.id);
    assert.equal(run.cancelRequested, true);
    assert.equal(f.c.providerPause("claude").state, "PAUSED", "the limit still pauses the provider");
    clear(f);
    assert.equal(f.c.task("C1").status, "REMEDIATION_REQUIRED");
    assert.throws(() => f.c.reserve("C1", { requestKey: "k2" }, f.actor), /UNCHANGED_FAILED_ATTEMPT_REQUIRES_RECONCILIATION/);
  } finally {
    f.close();
  }
});

test("a probe gets the same last check before launch, and one whose outcome is unknown keeps the recheck token (review S3-1, S3-2)", () => {
  const f = setup();
  try {
    const gate = f.c.probeGate(f.actor);
    assert.equal(gate.launch("claude", undefined), undefined, "a clear provider may be probed");
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: null, observedAt: now() });
    assert.match(String(gate.launch("claude", undefined)), /PROVIDER_PAUSED:claude/, "paused while the probe waited");
    // A new episode whose pause has run out.
    clear(f);
    ranOut(f);
    const begun = gate.before("claude");
    assert.ok(begun.go && begun.probeId);
    const probeId = (begun as { probeId: string }).probeId;
    assert.equal(gate.launch("claude", probeId), undefined, "the token's holder may launch");
    assert.match(String(gate.launch("claude", "someone-else")), /PROVIDER_RECHECK_IN_PROGRESS/);
    gate.after("claude", probeId, { status: "UNKNOWN" });
    assert.equal(f.c.recheckHolder(f.c.providerPause("claude")), "probe " + probeId);
    assert.ok(!gate.before("claude").go, "no second probe while the first may still run");
    gate.after("claude", probeId, undefined);
    assert.equal(f.c.recheckHolder(f.c.providerPause("claude")), "probe " + probeId);
    // A limit an unsettled probe reported still pauses the provider, and a
    // renewed pause stops even the token's holder from launching (round 2).
    const observations = f.db.all("SELECT seq FROM events WHERE kind='PROVIDER_LIMIT_OBSERVED'").length;
    gate.after("claude", probeId, { status: "UNKNOWN", providerLimit: usageLimit() });
    assert.equal(f.db.all("SELECT seq FROM events WHERE kind='PROVIDER_LIMIT_OBSERVED'").length, observations + 1);
    assert.equal(f.c.providerPause("claude").state, "PAUSED");
    assert.equal(f.c.recheckHolder(f.c.providerPause("claude")), "probe " + probeId);
    assert.match(String(gate.launch("claude", probeId)), /PROVIDER_PAUSED:claude:until=/);
  } finally {
    f.close();
  }
});

test("a step whose retry allowance is used up shows as a hold, not as ready to advance (review S3-7)", async () => {
  const f = setup();
  try {
    for (let i = 0; i < PROVIDER_RETRIES_PER_STEP; i++) {
      await f.c.execute(f.c.reserve("C1", { requestKey: "k" + i }, f.actor), limited(), f.actor);
      clear(f);
    }
    assert.match(String(f.c.retryHold("C1")), /^PROVIDER_RETRIES_EXHAUSTED:worker:C1:/);
    assert.equal(f.c.retryHold("C2"), undefined);
    const o = new Orchestrator(f.c, {}, "claude");
    const id = o.submit({ requestKey: randomUUID(), prompt: "Do C1", context: { cwd: f.root }, sourceRef: "test:owner" }).request.id;
    o.attach(id, ["C1"]);
    const view = o.inspect(id) as any;
    assert.ok(view.tasks[0].holds.some((h: string) => h.startsWith("PROVIDER_RETRIES_EXHAUSTED:")));
    assert.notEqual(view.status, "READY_TO_ADVANCE");
    assert.ok(f.c.operationalState(["C1"]).explanations.some((x) => x.hold === "PROVIDER_RETRIES_EXHAUSTED"));
  } finally {
    f.close();
  }
});

test("the scan reads harness records only, and opens the database read-only (review S3-8, S3-9)", async () => {
  const f = setup();
  try {
    // A successful run whose answer quotes a limit envelope is not a limit.
    await f.c.execute(
      f.c.reserve("C1", { requestKey: "k1" }, f.actor),
      {
        async execute(r) {
          return receipt(r, {
            status: "SUCCEEDED",
            exitCode: 0,
            identityVerified: true,
            output: JSON.stringify({ type: "result", is_error: true, api_error: "usage_limit_reached", result: "resets 10pm (UTC)" }),
          });
        },
      },
      f.actor,
    );
    assert.deepEqual(f.c.scanProviderLimits(), []);
    const missing = join(f.root, "absent.sqlite");
    assert.throws(() => scanProviderLimitsAt(missing), /DATABASE_NOT_FOUND/);
    assert.equal(existsSync(missing), false, "nothing was created");
    const path = join(f.root, "state.sqlite");
    const before = readFileSync(path);
    assert.deepEqual(scanProviderLimitsAt(path), []);
    assert.ok(readFileSync(path).equals(before), "the database file is unchanged");
  } finally {
    f.close();
  }
});

test("a paused provider's assessor is skipped for the advance, and another provider's assessor runs (review S3-5)", async () => {
  const both = () =>
    ({
      version: 1,
      id: "both",
      routes: [
        { ...route("codex"), roles: ["assessor"] },
        { ...route("claude"), roles: ["assessor", "worker", "reviewer"] },
        { ...route("claude", "STANDARD"), roles: ["reviewer"] },
      ],
    }) as RoutingPolicy;
  const t = { ...task("V2", "claude"), providers: ["codex", "claude"] };
  const f = setup({ policy: both, extra: [t as never] });
  try {
    const seen: ProviderRequest[] = [];
    const adapter: ProviderAdapter = {
      async execute(r) {
        seen.push(r);
        if (r.role === "assessor") {
          const p = (r.outputSchema as any)?.properties;
          return receipt(r, {
            status: "SUCCEEDED",
            exitCode: 0,
            identityVerified: true,
            output: JSON.stringify({
              taskId: r.taskId,
              specDigest: p.specDigest.enum[0],
              touches: { driveDocuments: [], codePaths: [], domainRules: false, canonicalText: false, ownerDecision: false },
              breaksIfWrong: "x",
              tierHint: "ROUTINE",
              reason: "small",
            }),
          });
        }
        return succeeding().execute(r);
      },
    };
    const o = new Orchestrator(f.c, { codex: adapter, claude: adapter }, "claude");
    const id = o.submit({ requestKey: randomUUID(), prompt: "Do V2", context: { cwd: f.root }, sourceRef: "test:owner" }).request.id;
    o.attach(id, ["V2"]);
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "codex", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: null, observedAt: now() });
    await o.drive(id, { live: true });
    const roles = seen.map((r) => r.role + ":" + r.provider);
    assert.ok(roles.includes("assessor:claude"), roles.join(","));
    assert.ok(!roles.some((r) => r.endsWith(":codex")), roles.join(","));
  } finally {
    f.close();
  }
});
