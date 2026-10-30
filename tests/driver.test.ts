import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { demoTask, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { driveRequests, progressFingerprint } from "../src/driver.js";
import { ProgressLog } from "../src/progress-log.js";
import { explainHold } from "../src/holds.js";
import { SqliteStore } from "../src/store.js";
import type { RoutingPolicy } from "../src/routing.js";
import { MockProvider, type BusyRun, type ProviderAdapter, type ProviderReceipt, type ProviderRequest, type RunActivity } from "../src/providers.js";

// One built-in driver, request pause and the compact view .

const now = () => new Date().toISOString();

/** Synthetic tasks, advanced in mock mode. */
function mock(tasks: Task[], host: "claude" | "codex" | "operator" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "longform-driver-"));
  const path = join(root, "state.sqlite");
  const stores: SqliteStore[] = [];
  const open = (as = host) => {
    const db = new SqliteStore(path);
    stores.push(db);
    const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "workspaces") });
    return { db, c, o: new Orchestrator(c, {}, as) };
  };
  const first = open();
  first.c.importTasks(tasks, first.c.localActor());
  for (const t of tasks)
    first.c.grant(
      t.id,
      { id: randomUUID(), operations: [...t.operations, "ACCEPT"], paths: t.writePaths, decisionText: "synthetic", sourceRef: "test:grant" },
      first.c.localActor(),
    );
  return {
    root,
    ...first,
    open,
    submit: (o: Orchestrator, taskIds: string[], projectKey?: string) =>
      o.submit({ requestKey: randomUUID(), prompt: "Handle the bounded tasks.", context: { cwd: root, ...(projectKey ? { projectKey } : {}) }, sourceRef: "test:owner", taskIds }).request.id,
    close: () => {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a synthetic request completes under the driver alone, and two projects are both served", async () => {
  const f = mock(["A", "B", "C", "D"].map((id) => demoTask(id)));
  try {
    const one = f.submit(f.o, ["A", "B"], "one");
    const two = f.submit(f.o, ["C", "D"], "two");
    const order: string[] = [];
    const real = f.o.drive.bind(f.o);
    (f.o as any).drive = (id: string, mode: any) => (order.push(id), real(id, mode));
    const run = await driveRequests(f.o, { mock: true });
    // Each round serves both projects: neither waits for the other to finish.
    assert.deepEqual(new Set(order.slice(0, 2)), new Set([one, two]), order.join(","));
    const byId = new Map(run.results.map((r) => [r.requestId, r]));
    for (const id of [one, two]) {
      assert.ok(f.o.inspect(id).tasks.every((t) => t.status === "VERIFIED"), JSON.stringify(f.o.inspect(id).tasks.map((t) => t.status)));
      assert.ok(["WAITING_FOR_OWNER", "FINISHED"].includes(byId.get(id)!.outcome), JSON.stringify(byId.get(id)));
      assert.ok(byId.get(id)!.advances >= 1);
    }
    // No starvation: both were served; the bound on advances is small.
    assert.ok(run.advances <= 10, String(run.advances));
  } finally {
    f.close();
  }
});

test("held work stops being advanced while other work goes on, and the driver returns saying why instead of looping", async () => {
  const f = mock([demoTask("A", { decisionRequired: true }), demoTask("B")]);
  try {
    const held = f.submit(f.o, ["A"], "held");
    const free = f.submit(f.o, ["B"], "free");
    let drives = 0;
    const real = f.o.drive.bind(f.o);
    (f.o as any).drive = (id: string, mode: any) => (drives++, real(id, mode));
    const run = await driveRequests(f.o, { mock: true });
    const result = (id: string) => run.results.find((r) => r.requestId === id)!;
    assert.equal(result(held).outcome, "HELD");
    assert.match(result(held).detail, /OWNER_DECISION_REQUIRED/);
    assert.equal(result(held).advances, 1, "not retried: nothing it waits for can change by itself");
    // The compact view explains the hold: what clears it, the command, whose authority.
    const explained = (f.o.compact(held) as any).holds[0].holds.find((h: any) => h.hold === "OWNER_DECISION_REQUIRED");
    assert.ok(explained && explained.clearedBy && explained.command && explained.authority, JSON.stringify((f.o.compact(held) as any).holds));
    assert.match((f.o.compact(held) as any).note, /grants nothing/);
    assert.ok(f.o.inspect(free).tasks.every((t) => t.status === "VERIFIED"));
    assert.ok(drives <= 5, String(drives));
  } finally {
    f.close();
  }
});

test("a project-wide question and the owner's pause stop a request without any advance; a task-scoped one does not", async () => {
  const f = mock([demoTask("A"), demoTask("B"), demoTask("C")]);
  try {
    const asked = f.submit(f.o, ["A"], "asked");
    f.o.ask(asked, { key: "q", text: "Which way?", projectWide: true });
    const paused = f.submit(f.o, ["B"], "paused");
    f.o.pauseRequest(paused, { text: "Hold this for now", sourceRef: "test:owner" });
    const scoped = f.submit(f.o, ["C"], "scoped");
    const run = await driveRequests(f.o, { mock: true });
    const result = (id: string) => run.results.find((r) => r.requestId === id)!;
    assert.equal(result(asked).outcome, "WAITING_FOR_ANSWERS");
    assert.equal(result(asked).advances, 0);
    assert.equal(result(paused).outcome, "PAUSED");
    assert.equal(result(paused).advances, 0);
    assert.equal(f.o.inspect(paused).status, "PAUSED");
    assert.ok(f.o.inspect(scoped).tasks.every((t) => t.status === "VERIFIED"));
    // Resume lifts only the pause.
    f.o.pauseRequest(paused, { text: "Go on", sourceRef: "test:owner" }, true);
    assert.equal(f.o.requestPause(paused), undefined);
    assert.throws(() => f.o.pauseRequest(paused, { text: "again", sourceRef: "s" }, true), /REQUEST_NOT_PAUSED/);
  } finally {
    f.close();
  }
});

test("a request refused for want of a slot is tried again with backoff, though that refusal is recorded only once", async () => {
  const f = mock(["S1", "S2", "S3", "X"].map((id) => demoTask(id)));
  try {
    const actor = f.c.localActor();
    // Every execution slot is taken by runs outside the driver.
    const busy = ["S1", "S2", "S3"].map((id) => f.c.reserve(id, { requestKey: "slot-" + id }, actor));
    const x = f.submit(f.o, ["X"], "x");
    let virtual = Date.now();
    const sleeps: number[] = [];
    const clock = {
      now: () => virtual,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        virtual += ms;
        // The slots free up only after the second wait.
        if (sleeps.length === 2) for (const a of busy) await f.c.execute(a, new MockProvider(), actor);
      },
    };
    const run = await driveRequests(f.o, { mock: true, clock });
    assert.deepEqual(sleeps.slice(0, 2), [30_000, 60_000], "backoff doubling: " + sleeps.join(","));
    assert.ok(f.o.inspect(x).tasks.every((t) => t.status === "VERIFIED"), JSON.stringify(run.results));
  } finally {
    f.close();
  }
});

test("a task-scoped question holds its task and the work that depends on it, and the rest of the request goes on", async () => {
  const f = mock([demoTask("A"), demoTask("B"), demoTask("C", { dependencies: ["A"] })]);
  try {
    const id = f.submit(f.o, ["A", "B", "C"], "scoped");
    f.o.ask(id, { key: "q-a", text: "Which way for A?", taskIds: ["A"] });
    const run = await driveRequests(f.o, { mock: true });
    const status = (t: string) => f.o.inspect(id).tasks.find((x) => x.taskId === t)!.status;
    assert.equal(status("B"), "VERIFIED", "unrelated work went on");
    for (const t of ["A", "C"]) assert.ok(!f.c.inspect(t).attempts.length, t + " never ran");
    const result = run.results.find((r) => r.requestId === id)!;
    assert.ok(["HELD", "WAITING_FOR_ANSWERS"].includes(result.outcome), JSON.stringify(result));
    assert.ok(result.advances <= 3, "not retried in a loop: " + result.advances);
  } finally {
    f.close();
  }
});

test("the driver serves only this host's requests; another host's is refused even when named, a neutral one only when named", async () => {
  const f = mock([demoTask("A"), demoTask("B"), demoTask("C")], "claude");
  try {
    const mine = f.submit(f.o, ["A"], "mine");
    const codex = f.open("codex");
    const theirs = f.submit(codex.o, ["B"], "theirs");
    const operator = f.open("operator");
    const neutral = f.submit(operator.o, ["C"], "neutral");
    const run = await driveRequests(f.o, { mock: true });
    assert.deepEqual(run.results.map((r) => r.requestId), [mine]);
    await assert.rejects(driveRequests(f.o, { mock: true, requestIds: [theirs] }), /REQUEST_OWNED_BY_OTHER_HOST/);
    const named = await driveRequests(f.o, { mock: true, requestIds: [neutral] });
    assert.deepEqual(named.results.map((r) => r.requestId), [neutral]);
  } finally {
    f.close();
  }
});

test("driver instances that stop after each advance, as restarts would, still carry a request to the end", async () => {
  const f = mock([demoTask("A"), demoTask("B")]);
  try {
    const id = f.submit(f.o, ["A", "B"], "restarts");
    for (let i = 0; i < 6; i++) {
      const fresh = f.open();
      await driveRequests(fresh.o, { mock: true, maxAdvances: 1 });
    }
    assert.ok(f.o.inspect(id).tasks.every((t) => t.status === "VERIFIED"));
    // An unchanged request has an unchanged fingerprint; a recorded answer changes it.
    const before = progressFingerprint(f.o, id);
    assert.equal(progressFingerprint(f.o, id), before);
  } finally {
    f.close();
  }
});

/** Real tasks with fake adapters, for pauses during runs. */
function live(
  extra: Array<{ id: string; provider: "claude" | "codex"; resources?: string[]; providers?: Array<"claude" | "codex">; fields?: Record<string, unknown> }> = [],
  options: { assessmentRequired?: boolean; roles?: { claude: string[]; codex: string[] }; leaseMs?: number } = {},
) {
  // A provider's routes can lose their capability proof (a test switch).
  const capable = { claude: true, codex: true };
  const root = mkdtempSync(join(tmpdir(), "longform-driver-live-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const route = (provider: "claude" | "codex", level: string) => ({
    id: provider + "-" + level,
    level,
    provider,
    model: provider + "-model",
    effort: "low",
    roles: options.roles?.[provider] ?? ["worker", "reviewer", "assessor", "advisor"],
    simulation: false,
    enabled: true,
    ...(capable[provider] ? { capability: { provider, model: provider + "-model", effort: "low", verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), evidenceRef: "file:test" } } : {}),
  });
  const policy = () => ({ version: 1, id: "p", ...(options.assessmentRequired ? { assessmentRequired: true } : {}), routes: ["ROUTINE", "STANDARD"].flatMap((l) => [route("claude", l), route("codex", l)]) }) as RoutingPolicy;
  const c = new Controller(db, { workspaceRoot: join(root, "ws"), ownerUid: process.getuid!(), allowRealLocalTasks: true, routingPolicyLoader: policy, verifyRoutingCapability: () => true, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  const actor = c.localActor();
  const task = (id: string, provider: "claude" | "codex", resources: string[] = [], providers: Array<"claude" | "codex"> = [provider]) => ({
    id,
    programme: "DEMO",
    lane: "L01",
    title: id,
    scope: "s",
    deliverable: "d",
    specVersion: 1,
    status: "DISCOVERED",
    dimensions: { authorization: "LOCAL_ONLY", sourceEffectuation: "CANDIDATE", implementation: "NOT_STARTED", review: "NONE", release: "NOT_AUTHORIZED" },
    dependencies: [],
    blockers: [],
    sources: [{ evidenceId: "src-" + id, revision: "r1", digest: "a".repeat(64) }],
    specificationAuthenticated: true,
    providers,
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/" + id],
    resources,
    risk: "LOW",
    reviewPolicy: { required: false, crossProvider: false, independentAudits: false },
    acceptance: [{ id: "a", description: "d", evidenceKind: "LOCAL" }],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    estimatedCostUsd: 0,
    budget: { deadlineMs: 10_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 },
    artifactRevision: "rev1",
    simulation: false,
    createdAt: now(),
  });
  const tasks = [task("P1", "claude"), task("P2", "claude"), task("Q1", "codex"), ...extra.map((e) => ({ ...task(e.id, e.provider, e.resources, e.providers), ...(e.fields ?? {}) }))];
  c.importTasks(tasks as never, actor);
  for (const t of tasks) {
    c.addEvidence({ id: "src-" + t.id, taskId: t.id, kind: "LOCAL", uri: "x", revision: "r1", digest: "a".repeat(64), retrievedAt: now(), authorityTier: "PLANNING", authentication: "LOCAL_OWNER_REQUEST", currentness: "CURRENT_AT_RETRIEVAL", claims: [], metadata: {} }, actor);
    c.grant(t.id, { id: "g-" + t.id, operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: t.writePaths, decisionText: "go", sourceRef: "test" }, actor);
  }
  const seen: ProviderRequest[] = [];
  const launchedAt: number[] = [];
  let during: ((r: ProviderRequest) => void) | undefined;
  let slow: ((r: ProviderRequest) => Promise<void>) | undefined;
  // What the adapter says of a run's processes when a stop is asked of it, and of runs still busy (a test sets them).
  let activity: ((runId: string) => RunActivity) | undefined;
  let busy: (() => BusyRun[]) | undefined;
  const adapter: ProviderAdapter = {
    activity: (runId) => activity?.(runId) ?? { processStopped: false, detail: "the fixture adapter cannot say" },
    busy: () => busy?.() ?? [],
    async execute(r) {
      seen.push(r);
      launchedAt.push(Date.now());
      during?.(r);
      await slow?.(r);
      if (r.role === "assessor") {
        const p = (r.outputSchema as any)?.properties;
        return receipt(r, JSON.stringify({ taskId: r.taskId, specDigest: p.specDigest.enum[0], touches: { driveDocuments: [], codePaths: [], domainRules: false, canonicalText: false, ownerDecision: false }, breaksIfWrong: "x", tierHint: "ROUTINE", reason: "small" }));
      }
      mkdirSync(join(r.cwd, "output", r.taskId), { recursive: true });
      writeFileSync(join(r.cwd, "output", r.taskId, "done.txt"), "done\n");
      return receipt(r, "done");
    },
  };
  const o = new Orchestrator(c, { claude: adapter, codex: adapter }, "claude");
  const stores = [db];
  return {
    root,
    db,
    c,
    o,
    seen,
    launchedAt,
    adapter,
    /** A fresh controller and orchestrator on the same database, as after a restart. */
    restart: () => {
      const again = new SqliteStore(join(root, "state.sqlite"));
      stores.push(again);
      const c2 = new Controller(again, { workspaceRoot: join(root, "ws"), ownerUid: process.getuid!(), allowRealLocalTasks: true, routingPolicyLoader: policy, verifyRoutingCapability: () => true });
      return { c: c2, o: new Orchestrator(c2, { claude: adapter, codex: adapter }, "claude") };
    },
    during: (hook: (r: ProviderRequest) => void) => (during = hook),
    slow: (hook: (r: ProviderRequest) => Promise<void>) => (slow = hook),
    activity: (hook: (runId: string) => RunActivity) => (activity = hook),
    busy: (hook: () => BusyRun[]) => (busy = hook),
    capable,
    actor,
    submit: (taskIds: string[], projectKey: string) =>
      o.submit({ requestKey: randomUUID(), prompt: "Do it.", context: { cwd: root, projectKey }, sourceRef: "test:owner", taskIds }).request.id,
    close: () => {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const receipt = (r: ProviderRequest, output: string): ProviderReceipt => ({
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
  output,
  tests: [],
  costUsd: 0.01,
  tokens: 10,
  identityVerified: true,
  simulation: false,
});

test("pausing a request during its run keeps that run's result, starts nothing next for it, and leaves other requests going", async () => {
  const f = live();
  try {
    const paused = f.submit(["P1", "P2"], "paused");
    const other = f.submit(["Q1"], "other");
    let pausedAt = -1;
    f.during((r) => {
      if (r.role === "worker" && r.taskId === "P1") {
        f.o.pauseRequest(paused, { text: "Stop after this one", sourceRef: "test:owner" });
        pausedAt = f.seen.length;
      }
    });
    const run = await driveRequests(f.o, { live: true });
    const worker = f.c.inspect("P1").attempts.find((a: any) => a.role === "worker");
    assert.equal(worker.state, "SUCCEEDED", "the run in progress finished and was recorded");
    const after = f.seen.slice(pausedAt).map((r) => r.role + ":" + r.taskId);
    assert.ok(pausedAt > 0);
    assert.ok(!after.some((r) => r.endsWith(":P1") || r.endsWith(":P2")), "nothing new started for the paused request: " + after.join(","));
    assert.equal(run.results.find((r) => r.requestId === paused)!.outcome, "PAUSED");
    assert.ok(f.seen.some((r) => r.taskId === "Q1" && r.role === "worker"), "the other request went on");
    // The pause changed no project input: P1's run was not stopped as stale.
    assert.ok(!f.db.all("SELECT body FROM events WHERE kind='RUN_STOPPED_BY_CONTROLLER'").length);
    const compact = f.o.compact(paused) as any;
    assert.equal(compact.status, "PAUSED");
    assert.ok(compact.pause.text.includes("Stop after this one"));
  } finally {
    f.close();
  }
});

test("a provider pause lets the other provider's work run, and the driver wakes at the reset to go on", async () => {
  const f = live();
  const limit = (ms: number) =>
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() + ms).toISOString(), validResetAt: new Date(Date.now() + ms - 60_000).toISOString(), observedAt: now() });
  try {
    const onClaude = f.submit(["P1"], "claude-work");
    const onCodex = f.submit(["Q1"], "codex-work");
    // A long pause: the other provider's work runs, and with only the paused
    // work left the driver waits for the reset, in sleeps of at most a minute
    // with state read again between them (a virtual clock, so the test does
    // not depend on machine speed; the budget ends before the reset).
    limit(600_000);
    const waits: number[] = [];
    let virtual = Date.now();
    const first = await driveRequests(f.o, {
      live: true,
      maxMinutes: 5,
      clock: { now: () => virtual, sleep: async (ms) => void (waits.push(ms), (virtual += ms)) },
    });
    assert.ok(f.seen.some((r) => r.provider === "codex" && r.taskId === "Q1" && r.role === "worker"), "the other provider's work ran");
    assert.ok(!f.seen.some((r) => r.provider === "claude"), "nothing reached the paused provider");
    const waiting = first.results.find((r) => r.requestId === onClaude)!;
    assert.equal(waiting.outcome, "WAITING_UNTIL", JSON.stringify(waiting));
    assert.ok(Math.abs(Date.parse(waiting.until!) - (Date.now() + 600_000)) < 120_000, "it waits for the reset: " + waiting.until);
    assert.ok(waits.length >= 4 && waits.every((ms) => ms > 0 && ms <= 60_000), "chunked waits: " + waits.join(","));
    assert.ok(waiting.advances <= 2, "not advanced again at each wake: " + waiting.advances);
    // A short pause, with only the paused provider's work left: the driver
    // really sleeps until the reset, then goes on.
    f.c.clearProviderPause("claude", { reason: "test: replace the long pause", evidence: ["test"], sourceRef: "test:operator" }, f.c.localActor());
    limit(3_000);
    const sleeps: number[] = [];
    const run = await driveRequests(f.o, {
      live: true,
      requestIds: [onClaude],
      clock: { now: () => Date.now(), sleep: (ms) => (sleeps.push(ms), new Promise((r) => setTimeout(r, ms))) },
    });
    assert.ok(f.seen.some((r) => r.provider === "claude" && r.taskId === "P1"), "after the reset the paused provider's work went on");
    assert.ok(sleeps.some((ms) => ms > 0 && ms <= 4_000), "it slept until the reset: " + sleeps.join(","));
    assert.equal(f.c.providerPause("claude").state, "CLEAR", "the run that tested the provider cleared the pause");
    assert.ok(run.results.every((r) => r.outcome !== "TIME_BUDGET_ENDED"), JSON.stringify(run.results));
    void onCodex;
  } finally {
    f.close();
  }
});

test("the reconciliation helper drafts from the records and asserts nothing it cannot know", async () => {
  const f = live();
  try {
    const a = f.c.reserve("P1", { requestKey: "k" }, f.c.localActor());
    await f.c.execute(a, { execute: async (r) => ({ ...receipt(r, "x"), status: "UNKNOWN", costUsd: null, tokens: null, identityVerified: false }) }, f.c.localActor()).catch(() => undefined);
    const events = f.db.all("SELECT seq FROM events").length;
    const draft = f.c.reconciliationDraft(a.id) as any;
    assert.equal(draft.reconcilable, true);
    assert.equal(draft.draftEnvelope.metadata.reconciliation.processStopped, null);
    assert.equal(draft.draftEnvelope.metadata.reconciliation.externalEffects, null);
    assert.equal(draft.draftEnvelope.metadata.reconciliation.usage, null);
    assert.ok(draft.mustConfirm.some((m: string) => m.startsWith("processStopped")));
    assert.ok(draft.cannotEstablish.some((m: string) => /usage/.test(m)));
    assert.equal(f.db.all("SELECT seq FROM events").length, events, "the helper records nothing");
  } finally {
    f.close();
  }
});

test("after a restart the driver still honours a recorded provider pause and an unknown run's custody, and says so instead of retrying", async () => {
  const f = live([
    { id: "R1", provider: "codex", resources: ["shared"] },
    { id: "R2", provider: "codex", resources: ["shared"] },
  ]);
  try {
    // An earlier run whose outcome is unknown keeps its claim on the resource.
    const r1 = f.c.reserve("R1", { requestKey: "r1" }, f.c.localActor());
    await f.c.execute(r1, { execute: async (r) => ({ ...receipt(r, "x"), status: "UNKNOWN", costUsd: null, tokens: null, identityVerified: false }) }, f.c.localActor()).catch(() => undefined);
    assert.equal(f.c.inspect("R1").attempts[0]!.state, "UNKNOWN");
    const until = Date.now() + 1_500;
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(until).toISOString(), validResetAt: new Date(until - 60_000).toISOString(), observedAt: now() });
    const onClaude = f.submit(["P1"], "claude-work");
    const blocked = f.submit(["R2"], "shared-work");
    const free = f.submit(["Q1"], "codex-work");
    // The driver and controller start afresh on the same database.
    const fresh = f.restart();
    assert.equal(fresh.c.providerPause("claude").state, "PAUSED", "the pause survives the restart");
    let drives = 0;
    const real = fresh.o.drive.bind(fresh.o);
    (fresh.o as any).drive = (id: string, mode: any) => (drives++, real(id, mode));
    const run = await driveRequests(fresh.o, { live: true });
    const result = (id: string) => run.results.find((r) => r.requestId === id)!;
    // Nothing reached the paused provider before its reset; afterwards its work ran.
    const claude = f.seen.map((r, i) => [r, f.launchedAt[i]!] as const).filter(([r]) => r.provider === "claude");
    assert.ok(claude.length > 0, "the paused provider's work ran after the reset");
    assert.ok(claude.every(([, at]) => at >= until), "no launch before the reset");
    assert.ok(f.seen.some((r) => r.taskId === "Q1" && r.role === "worker"), "other work went on");
    assert.ok(f.seen.some((r) => r.taskId === "P1" && r.role === "worker"), "P1's work ran after the reset");
    // The unknown run's claim still holds R2, and only reconciliation can clear it: no retry loop.
    assert.ok(!f.seen.some((r) => r.taskId === "R2"), "R2 never launched");
    assert.equal(result(blocked).outcome, "HELD", JSON.stringify(result(blocked)));
    assert.match(result(blocked).detail, /CLAIM_CONFLICT:resource:shared held by run .*attempt UNKNOWN/);
    // Its assessor, then its worker, each refused and recorded once; then not retried.
    assert.ok(result(blocked).advances <= 3, "not retried: " + result(blocked).advances);
    assert.ok(fresh.c.unresolvedClaims().some((h) => h.holderId === r1.id && h.resource === "resource:shared"), "custody kept");
    assert.equal(result(free).outcome !== "TIME_BUDGET_ENDED", true);
    assert.ok(drives <= 12, String(drives));
  } finally {
    f.close();
  }
});

// Review round 1 (S5-1..S5-8): each test below fails on 7bf2bb2.

/** Reconcile an unknown run as stopped with no effects, stating its usage. */
function reconcileUnknown(f: ReturnType<typeof live>, runId: string, taskId: string) {
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
      metadata: { runId, reconciliation: { processStopped: true, externalEffects: "NONE", assessment: "process gone; no effects", usage: { costUsd: 0.5, tokens: 300 } } },
    },
    f.actor,
  );
  f.c.reconcile(runId, "FAILED", "reconcile-" + runId, f.actor);
}
const virtualClock = (onSleep?: (ms: number, n: number) => void) => {
  let at = Date.now();
  const waits: number[] = [];
  return {
    waits,
    clock: { now: () => at, sleep: async (ms: number) => { waits.push(ms); at += ms; onSleep?.(ms, waits.length); } },
  };
};

test("S5-1: a run reserved before its request was paused does not launch, at its start or just before its process", async () => {
  const f = live();
  try {
    const paused = f.submit(["P1"], "paused");
    // The owner pauses the request after the worker's reservation, before its start.
    const execute = f.c.execute.bind(f.c);
    (f.c as any).execute = (a: any, adapter: any, actor: any) => {
      if (a.taskId === "P1" && a.role === "worker" && !f.o.requestPause(paused))
        f.o.pauseRequest(paused, { text: "Stop now", sourceRef: "test:owner" });
      return execute(a, adapter, actor);
    };
    await driveRequests(f.o, { live: true, maxAdvances: 3 });
    assert.ok(!f.seen.some((r) => r.taskId === "P1" && r.role === "worker"), "the worker never launched");
    const worker = f.c.inspect("P1").attempts.find((a: any) => a.role === "worker");
    assert.equal(worker.state, "NOT_STARTED");
    // Just before a process is spawned: the runner's gate refuses a paused request's run too.
    (f.c as any).execute = execute;
    f.o.pauseRequest(paused, { text: "Go on", sourceRef: "test:owner" }, true);
    let gate: string | undefined;
    f.during((r) => {
      if (r.taskId === "P1" && r.role === "worker") {
        f.o.pauseRequest(paused, { text: "Stop again", sourceRef: "test:owner" });
        gate = r.launchGate?.();
      }
    });
    await driveRequests(f.o, { live: true, maxAdvances: 3 });
    assert.match(String(gate), /REQUEST_PAUSED/);
  } finally {
    f.close();
  }
});

test("S5-2: one slow advance does not keep a free slot from another project", async () => {
  const f = live([{ id: "X1", provider: "codex" }]);
  try {
    for (const [task, project] of [["P1", "slow"], ["P2", "b"], ["Q1", "c"], ["X1", "d"]] as const) f.submit([task], project);
    let slowEnded = Infinity;
    f.slow(async (r) => {
      if (r.taskId === "P1" && r.role === "worker") {
        await new Promise((done) => setTimeout(done, 1_500));
        slowEnded = Date.now();
      }
    });
    await driveRequests(f.o, { live: true, maxMinutes: 2 });
    const x1 = f.seen.findIndex((r) => r.taskId === "X1" && r.role === "worker");
    assert.ok(x1 >= 0, "the fourth project was served");
    assert.ok(f.launchedAt[x1]! < slowEnded, "while the slow advance was still running");
  } finally {
    f.close();
  }
});

test("S5-3: a pause of a provider a request does not wait on leaves its permanent hold untimed", async () => {
  const f = mock([demoTask("A", { decisionRequired: true })]);
  try {
    const held = f.submit(f.o, ["A"], "held");
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "codex", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: new Date(Date.now() + 540_000).toISOString(), observedAt: now() });
    const v = virtualClock();
    const run = await driveRequests(f.o, { mock: true, clock: v.clock });
    const result = run.results.find((r) => r.requestId === held)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.match(result.detail, /OWNER_DECISION_REQUIRED/);
    assert.deepEqual(v.waits, [], "no wait for an unrelated reset");
  } finally {
    f.close();
  }
});

test("S5-4: a pause recorded while the driver waits ends the wait and is reported", async () => {
  const f = live();
  try {
    const id = f.submit(["P1"], "waiting");
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: new Date(Date.now() + 540_000).toISOString(), observedAt: now() });
    const v = virtualClock((_, n) => {
      if (n === 1) f.o.pauseRequest(id, { text: "Stop while it waits", sourceRef: "test:owner" });
    });
    const run = await driveRequests(f.o, { live: true, maxMinutes: 5, clock: v.clock });
    assert.equal(run.results[0]!.outcome, "PAUSED", JSON.stringify(run.results));
    assert.equal(v.waits.length, 1, "the wait ended at the next read: " + v.waits.join(","));
    assert.ok(v.waits[0]! <= 60_000);
  } finally {
    f.close();
  }
});

test("S5-5: reconciling the run whose claim held a request wakes it while the driver serves others", async () => {
  const f = live([
    { id: "R1", provider: "codex", resources: ["shared"] },
    { id: "R2", provider: "codex", resources: ["shared"] },
  ]);
  try {
    const r1 = f.c.reserve("R1", { requestKey: "r1" }, f.actor);
    await f.c.execute(r1, { execute: async (r) => ({ ...receipt(r, "x"), status: "UNKNOWN", costUsd: null, tokens: null, identityVerified: false }) }, f.actor).catch(() => undefined);
    const blocked = f.submit(["R2"], "shared-work");
    // Another request waits on a timed reset, so the driver stays and sleeps;
    // during its first sleep the operator reconciles the unknown run.
    f.submit(["P1"], "timed");
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: new Date(Date.now() + 540_000).toISOString(), observedAt: now() });
    const v = virtualClock((_, n) => {
      if (n === 1) reconcileUnknown(f, r1.id, "R1");
    });
    await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    assert.ok(f.seen.some((r) => r.taskId === "R2" && r.role === "worker"), "R2 ran once its blocker was released");
    void blocked;
  } finally {
    f.close();
  }
});

test("S5-6: slots held only by unknown runs are not retried as passing", async () => {
  const f = mock(["S1", "S2", "S3", "X"].map((id) => demoTask(id)));
  try {
    const actor = f.c.localActor();
    for (const id of ["S1", "S2", "S3"]) {
      const a = f.c.reserve(id, { requestKey: "slot-" + id }, actor);
      // As a run left unknown after a lost process: no settled invocation.
      const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", a.id)!.body);
      Object.assign(body, { state: "UNKNOWN", started: true, startedAt: now(), unknownAt: now() });
      f.db.run("UPDATE attempts SET state='UNKNOWN', body=? WHERE id=?", JSON.stringify(body), a.id);
    }
    const x = f.submit(f.o, ["X"], "x");
    const v = virtualClock();
    const run = await driveRequests(f.o, { mock: true, clock: v.clock });
    const result = run.results.find((r) => r.requestId === x)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.match(result.detail, /MAX_CONCURRENCY: slots held by run .* \(UNKNOWN\)/);
    assert.deepEqual(v.waits, [], "no backoff: only reconciliation frees those slots");
  } finally {
    f.close();
  }
});

test("S5-7: generated holds, nested ones too, say what clears them and the command", () => {
  const verify = explainHold("WORKFLOW_VERIFY_HELD:Error: MISSING_ACCEPTANCE_EVIDENCE:a");
  assert.match(String(verify.command), /bind <task> --criterion <id> --evidence-id <id>/);
  assert.match(verify.authority, /owner|operator/);
  const budget = explainHold("EXECUTION_BUDGET_EXHAUSTED");
  assert.match(String(budget.command), /budget-extend/);
  assert.equal(budget.authority, "the owner");
});

test("S5-8: a malformed time budget is refused before the driver starts", async () => {
  const f = mock([demoTask("A")]);
  try {
    f.submit(f.o, ["A"], "a");
    for (const maxMinutes of [Number.NaN, 0, 601, Infinity])
      await assert.rejects(driveRequests(f.o, { mock: true, maxMinutes }), /MAX_MINUTES_INVALID/, String(maxMinutes));
  } finally {
    f.close();
  }
});

// Review round 2 (S5-9, S5-10): each test below fails on 18ff247.

test("S5-9: a required assessment waiting for its paused provider is a timed wait, not a permanent hold", async () => {
  const f = live([], { assessmentRequired: true });
  try {
    const id = f.submit(["P1"], "assess");
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: new Date(Date.now() + 540_000).toISOString(), observedAt: now() });
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.ok(f.o.inspect(id).tasks[0]!.holds.some((h) => /^ASSESSMENT_REQUIRED: claude=PENDING/.test(h)), JSON.stringify(f.o.inspect(id).tasks[0]!.holds));
    assert.equal(result.outcome, "WAITING_UNTIL", JSON.stringify(result));
    assert.ok(v.waits.length >= 1);
    assert.ok(!f.seen.some((r) => r.provider === "claude"), "nothing ran on the paused provider");
  } finally {
    f.close();
  }
});

test("S5-10: an error while judging one advance does not return before another advance under way ends", async () => {
  const f = live();
  try {
    const quick = f.submit(["P2"], "quick");
    f.submit(["P1"], "slow");
    let slowEnded = Infinity;
    f.slow(async (r) => {
      if (r.taskId === "P1" && r.role === "assessor") {
        await new Promise((done) => setTimeout(done, 1_000));
        slowEnded = Date.now();
      }
    });
    let armed = false;
    const drive = f.o.drive.bind(f.o);
    (f.o as any).drive = async (id: string, mode: any) => {
      const result = await drive(id, mode);
      if (id === quick) armed = true;
      return result;
    };
    const inspect = f.o.inspect.bind(f.o);
    (f.o as any).inspect = (id: string) => {
      if (armed && id === quick) {
        armed = false;
        throw new Error("INJECTED_READ_FAILURE");
      }
      return inspect(id);
    };
    await assert.rejects(driveRequests(f.o, { live: true, maxMinutes: 2 }), /INJECTED_READ_FAILURE/);
    assert.ok(Date.now() >= slowEnded, "the other advance had ended before the driver threw");
  } finally {
    await new Promise((done) => setTimeout(done, 1_200));
    f.close();
  }
});

// Review round 3 (S5-9 remainder, S5-11): each test below fails on e28e06e.
const split = { claude: ["worker", "reviewer", "advisor"], codex: ["assessor"] };
const pauseFor = (f: ReturnType<typeof live>, provider: "claude" | "codex") =>
  f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider, kind: "USAGE_LIMIT", until: new Date(Date.now() + 600_000).toISOString(), validResetAt: new Date(Date.now() + 540_000).toISOString(), observedAt: now() });

test("S5-9: a required assessment whose assessor's provider is paused waits for that reset, the worker's provider being free", async () => {
  const f = live([{ id: "T1", provider: "claude", providers: ["claude", "codex"] }], { assessmentRequired: true, roles: split });
  try {
    const id = f.submit(["T1"], "split");
    pauseFor(f, "codex");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "WAITING_UNTIL", JSON.stringify(result));
    assert.ok(Math.abs(Date.parse(result.until!) - (Date.now() + 600_000)) < 120_000, String(result.until));
    assert.ok(!f.seen.some((r) => r.taskId === "T1"), "nothing ran for it");
  } finally {
    f.close();
  }
});

test("S5-11: a pending assessment blocked by something else does not wait for the worker provider's reset", async () => {
  const f = live(
    [
      { id: "R1", provider: "codex", resources: ["shared"], providers: ["claude", "codex"] },
      { id: "R2", provider: "claude", resources: ["shared"], providers: ["claude", "codex"] },
    ],
    { assessmentRequired: true, roles: split },
  );
  try {
    // An assessor run of R1 whose outcome is unknown keeps the shared resource.
    const r1 = f.c.reserve("R1", { requestKey: "r1", role: "assessor" }, f.actor);
    await f.c.execute(r1, { execute: async (r) => ({ ...receipt(r, "x"), status: "UNKNOWN", costUsd: null, tokens: null, identityVerified: false }) }, f.actor).catch(() => undefined);
    const id = f.submit(["R2"], "shared");
    pauseFor(f, "claude");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.match(result.detail, /CLAIM_CONFLICT:resource:shared held by run .*attempt UNKNOWN/);
    assert.deepEqual(v.waits, [], "the worker's reset cannot release the claim");
  } finally {
    f.close();
  }
});

// Found by the S6 integration test on f3e12f1: a stage's old refusal must not
// look current once the run it refused has gone ahead.
test("a refusal that has since cleared is not read as the request's current blocker", async () => {
  const f = live([
    { id: "F1", provider: "codex", resources: ["shared"] },
    { id: "X1", provider: "codex", resources: ["shared"] },
  ]);
  try {
    // A filing of another task holds the shared resource at first.
    const filing = f.c.acquireFilingClaims("F1", { update: [], create: [] }, (f.c as any).inspect("F1").specDigest, f.actor);
    const id = f.submit(["X1"], "x");
    const v = virtualClock((_, n) => {
      if (n === 1) f.c.releaseFilingClaims(filing);
    });
    const run = await driveRequests(f.o, { live: true, maxMinutes: 30, clock: v.clock });
    assert.ok(f.seen.some((r) => r.taskId === "X1" && r.role === "worker"), "X1's worker ran once the filing ended");
    const result = run.results.find((r) => r.requestId === id)!;
    // Its review cannot be recorded (this fixture's reviewer output is not a
    // report): a hold time cannot clear, reported as such, not retried.
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.doesNotMatch(result.detail, /CLAIM_CONFLICT/);
    assert.ok(v.waits.length <= 2, "no retry loop on a cleared refusal: " + v.waits.join(","));
  } finally {
    f.close();
  }
});

// Review round 4 (S5-12, S5-13): each test below fails on f3e12f1.

test("S5-12: a capacity refusal that has since cleared does not keep held work retrying", async () => {
  const f = live([{ id: "X1", provider: "codex" }]);
  try {
    // Every slot is taken by runs outside the driver; they end during its first wait.
    const busy = ["P1", "P2", "Q1"].map((id) => f.c.reserve(id, { requestKey: "slot-" + id }, f.actor));
    const id = f.submit(["X1"], "x");
    let freed: Promise<unknown> | undefined;
    const v = virtualClock((_, n) => {
      if (n === 1) freed = Promise.all(busy.map((a) => f.c.execute(a, f.adapter, f.actor)));
    });
    const clock = { now: v.clock.now, sleep: async (ms: number) => { await v.clock.sleep(ms); await freed; } };
    const run = await driveRequests(f.o, { live: true, maxMinutes: 30, clock });
    assert.ok(f.seen.some((r) => r.taskId === "X1" && r.role === "worker"), "X1 ran once the slots freed");
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.doesNotMatch(result.detail, /MAX_CONCURRENCY/);
  } finally {
    f.close();
  }
});

test("S5-13: an assessor that lost its route after a pause refusal is not waited for at the pause's reset", async () => {
  const f = live([{ id: "T1", provider: "claude", providers: ["claude", "codex"] }], { assessmentRequired: true, roles: split });
  try {
    const id = f.submit(["T1"], "split");
    pauseFor(f, "codex");
    // The assessor is refused for the pause first.
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    assert.ok(f.o.inspect(id).tasks[0]!.steps.some((x: any) => /ASSESSOR_RESERVATION\[codex\]:.*PROVIDER_PAUSED:codex/.test(x.detail)));
    // Then Codex's assessor route loses its capability proof.
    f.capable.codex = false;
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "a reset cannot restore the route");
  } finally {
    f.close();
  }
});

// Review round 5 (S5-14): each test below fails on d5d879b.

test("S5-14: one assessor having no route does not hide another assessor's reset", async () => {
  // Claude may assess and work; Codex may only assess, and has no capability proof.
  const f = live([{ id: "T1", provider: "claude", providers: ["claude", "codex"] }], {
    assessmentRequired: true,
    roles: { claude: ["worker", "reviewer", "advisor", "assessor"], codex: ["assessor"] },
  });
  try {
    f.capable.codex = false;
    const id = f.submit(["T1"], "two-assessors");
    pauseFor(f, "claude");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "WAITING_UNTIL", JSON.stringify(result));
    assert.ok(v.waits.length >= 1);
  } finally {
    f.close();
  }
});

test("S5-14: an assessor whose route came back while it is paused is waited for, despite the older 'no route' record", async () => {
  const f = live([{ id: "T1", provider: "claude", providers: ["claude", "codex"] }], { assessmentRequired: true, roles: split });
  try {
    const id = f.submit(["T1"], "route-back");
    pauseFor(f, "codex");
    // Refused for the pause first; then the route goes, recorded as unavailable.
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    f.capable.codex = false;
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    const steps = f.o.inspect(id).tasks[0]!.steps.map((x: any) => x.detail);
    assert.ok(steps.some((d: string) => /ASSESSOR_RESERVATION\[codex\]:.*PROVIDER_PAUSED/.test(d)) && /ASSESSOR_UNAVAILABLE/.test(steps.at(-1)), JSON.stringify(steps));
    // The route comes back while Codex is still paused; the pause refusal, being
    // the same as before, is not recorded again.
    f.capable.codex = true;
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "WAITING_UNTIL", JSON.stringify(result));
    assert.ok(!f.seen.some((r) => r.taskId === "T1"), "nothing ran before the reset");
  } finally {
    f.close();
  }
});

// Whole-stack review round 1 (W-1): fails on 96bf586.
test("W-1: a recheck held by a run whose outcome is unknown is reported for reconciliation, not retried", async () => {
  const f = live();
  try {
    // Claude's pause has run out: one run may test it (the recheck token).
    f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider: "claude", kind: "USAGE_LIMIT", until: new Date(Date.now() - 1_000).toISOString(), validResetAt: new Date(Date.now() - 61_000).toISOString(), observedAt: now() });
    assert.equal(f.c.providerPause("claude").state, "RECHECK");
    const tester = f.c.reserve("P1", { requestKey: "tester" }, f.actor);
    assert.equal((tester as any).recheckOf, f.c.providerPause("claude").episode, "the run holds the recheck");
    // Its process was lost: unknown, with no settled invocation.
    const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", tester.id)!.body);
    Object.assign(body, { state: "UNKNOWN", started: true, startedAt: now(), unknownAt: now() });
    f.db.run("UPDATE attempts SET state='UNKNOWN', body=? WHERE id=?", JSON.stringify(body), tester.id);
    const id = f.submit(["P2"], "waiting");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.match(result.detail, /PROVIDER_RECHECK_IN_PROGRESS:claude held by run .* \(attempt UNKNOWN\)/);
    assert.deepEqual(v.waits, [], "only reconciliation frees the recheck");
  } finally {
    f.close();
  }
});

// Review round 6 (S5-15, S5-16): each test below fails on d1b3f54.

/** Mark a reservation as a run left unknown after a lost process (no settled invocation). */
function makeUnknown(f: ReturnType<typeof live>, runId: string) {
  const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId)!.body);
  const earlier = new Date(Date.now() - 2_000).toISOString();
  const seq = f.db.get<{ n: number }>("SELECT MAX(seq) AS n FROM events")!.n;
  Object.assign(body, { state: "UNKNOWN", started: true, startedAt: earlier, unknownAt: earlier, unknownEventSeq: seq });
  f.db.run("UPDATE attempts SET state='UNKNOWN', body=? WHERE id=?", JSON.stringify(body), runId);
}

test("S5-15: a paused assessor is not waited for while every slot is held by unknown runs", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude" },
      { id: "U1", provider: "codex" },
      { id: "U2", provider: "codex" },
    ],
    { assessmentRequired: true },
  );
  try {
    for (const task of ["Q1", "U1", "U2"]) makeUnknown(f, f.c.reserve(task, { requestKey: "slot-" + task, role: "assessor" }, f.actor).id);
    const id = f.submit(["T1"], "assess");
    pauseFor(f, "claude");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.match(result.detail, /MAX_CONCURRENCY: slots held by run .* \(UNKNOWN\)/);
    assert.deepEqual(v.waits, [], "the reset cannot free those slots");
  } finally {
    f.close();
  }
});

test("S5-16: an assessor with no route does not keep a capacity refusal alive after the slots free", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude", providers: ["claude", "codex"] },
      { id: "U1", provider: "codex" },
      { id: "U2", provider: "codex" },
    ],
    { assessmentRequired: true, roles: split },
  );
  try {
    const busy = ["Q1", "U1", "U2"].map((task) => f.c.reserve(task, { requestKey: "slot-" + task, role: "assessor" }, f.actor));
    const id = f.submit(["T1"], "assess");
    // The assessor is refused for capacity, held by runs that are reserved.
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    assert.ok(f.o.inspect(id).tasks[0]!.steps.some((x: any) => /ASSESSOR_RESERVATION\[codex\]:.*MAX_CONCURRENCY/.test(x.detail)));
    // The reservations are cancelled, freeing every slot, and Codex's assessor loses its route.
    for (const a of busy) f.c.cancel(a.id, f.actor);
    f.capable.codex = false;
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "no retry on a capacity refusal that no longer applies");
  } finally {
    f.close();
  }
});

// Review round 7 (S5-15 and S5-16 variants, S5-17): each test below fails on 668008d.
const both = { claude: ["worker", "reviewer", "advisor", "assessor"], codex: ["assessor"] };

test("S5-17: a capacity refusal that has cleared is not kept alive by its old holders' unrelated uncertain writes", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude" },
      { id: "U1", provider: "codex" },
      { id: "U2", provider: "codex" },
    ],
    { assessmentRequired: true },
  );
  try {
    const id = f.submit(["T1"], "assess");
    pauseFor(f, "claude");
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    // During the pause, three other runs become unknown, each with an uncertain write elsewhere.
    const holders = ["Q1", "U1", "U2"].map((task) => {
      const a = f.c.reserve(task, { requestKey: "slot-" + task, role: "assessor" }, f.actor);
      makeUnknown(f, a.id);
      f.db.run("INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)", randomUUID(), "INTENT", "drive:file:other" + task + "AAAAAAAA", "run", a.id, task, "x", "UNCERTAIN", null, now(), "{}");
      return [a.id, task] as const;
    });
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    assert.ok(f.o.inspect(id).tasks[0]!.steps.some((x: any) => /MAX_CONCURRENCY/.test(x.detail)));
    // They are reconciled: the slots are free; their uncertain writes stay.
    for (const [run, task] of holders) reconcileUnknown(f, run, task);
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "WAITING_UNTIL", JSON.stringify(result));
  } finally {
    f.close();
  }
});

test("S5-15 (two assessors): capacity held by unknown runs blocks every pending assessor, refused or not yet asked", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude", providers: ["claude", "codex"] },
      { id: "U1", provider: "codex" },
      { id: "U2", provider: "codex" },
    ],
    { assessmentRequired: true, roles: both },
  );
  try {
    for (const task of ["Q1", "U1", "U2"]) makeUnknown(f, f.c.reserve(task, { requestKey: "slot-" + task, role: "assessor" }, f.actor).id);
    const id = f.submit(["T1"], "assess");
    pauseFor(f, "claude");
    pauseFor(f, "codex");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "no reset frees those slots");
  } finally {
    f.close();
  }
});

test("S5-16 (repeated unavailability): a stale capacity refusal does not come back through the task's latest step", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude", providers: ["claude", "codex"] },
      { id: "U1", provider: "codex" },
      { id: "U2", provider: "codex" },
    ],
    { assessmentRequired: true, roles: split },
  );
  try {
    const id = f.submit(["T1"], "assess");
    f.capable.codex = false;
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    // The route comes back while every slot is reserved: a capacity refusal.
    f.capable.codex = true;
    const busy = ["Q1", "U1", "U2"].map((task) => f.c.reserve(task, { requestKey: "slot-" + task, role: "assessor" }, f.actor));
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    // The slots free and the route goes again (the unavailability is not recorded twice).
    for (const a of busy) f.c.cancel(a.id, f.actor);
    f.capable.codex = false;
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "nothing time can clear");
  } finally {
    f.close();
  }
});

test("the admission probe answers what would refuse a reservation now, and records, reserves and creates nothing", () => {
  const f = live([{ id: "R1", provider: "codex", resources: ["shared"] }, { id: "R2", provider: "codex", resources: ["shared"] }]);
  try {
    const count = () => [f.db.all("SELECT seq FROM events").length, f.db.all("SELECT id FROM attempts").length, f.db.all("SELECT id FROM resource_claims").length];
    const ws = join(f.root, "ws");
    const entries = () => { try { return readdirSync(ws).length; } catch { return 0; } };
    const before = [...count(), entries()];
    assert.equal(f.c.admissionRefusal("R2", { role: "worker" }), undefined, "admissible");
    assert.deepEqual([...count(), entries()], before, "nothing recorded, reserved or created");
    f.c.reserve("R1", { requestKey: "r1" }, f.actor);
    assert.match(String(f.c.admissionRefusal("R2", { role: "worker" })), /CLAIM_CONFLICT:resource:shared held by run/);
  } finally {
    f.close();
  }
});

// Review round 8 (S5-18, S5-19): each test below fails on 4acd4f6.

test("S5-18: the probe refuses an assessor whose brief cannot fit, as reservation does", async () => {
  const f = live([{ id: "T1", provider: "claude", providers: ["claude", "codex"], fields: { scope: "detail ".repeat(20_000) } }], { assessmentRequired: true, roles: split });
  try {
    assert.match(String(f.c.admissionRefusal("T1", { role: "assessor", excludeProviders: ["claude", "mock"] })), /BRIEF_EXCEEDS_PROVIDER_LIMIT/);
    const id = f.submit(["T1"], "long");
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "a revision is needed, not time");
  } finally {
    f.close();
  }
});

test("S5-19: an assessor a task-scoped question holds back does not keep the request polling", async () => {
  const f = live(
    [
      { id: "T1", provider: "claude", providers: ["claude", "codex"] },
      { id: "T2", provider: "claude", providers: ["claude", "codex"], fields: { blockers: ["WAITING_FOR_A_PERSON"] } },
    ],
    { assessmentRequired: true, roles: split },
  );
  try {
    const id = f.submit(["T1", "T2"], "asked");
    f.capable.codex = false;
    await driveRequests(f.o, { live: true, maxAdvances: 1, clock: virtualClock().clock });
    f.o.ask(id, { key: "q-t1", text: "Which way for T1?", taskIds: ["T1"] });
    f.capable.codex = true;
    const v = virtualClock();
    const run = await driveRequests(f.o, { live: true, maxMinutes: 3, clock: v.clock });
    const result = run.results.find((r) => r.requestId === id)!;
    assert.equal(result.outcome, "HELD", JSON.stringify(result));
    assert.deepEqual(v.waits, [], "the question and the blocker need people");
    assert.ok(!f.seen.some((r) => r.taskId === "T1" || r.taskId === "T2"), "nothing ran");
  } finally {
    f.close();
  }
});

// PR #13 automated review (P2): fails on 0449c29.
test("a request waiting for a reset is woken when the operator clears the pause early", async () => {
  const f = live();
  try {
    const id = f.submit(["P1"], "cleared");
    pauseFor(f, "claude");
    // During the driver's first wait the operator records evidence that the limit is lifted.
    const v = virtualClock((_, n) => {
      if (n === 1)
        f.c.clearProviderPause("claude", { reason: "the usage page shows the limit lifted", evidence: ["usage page"], sourceRef: "test:operator" }, f.actor);
    });
    const run = await driveRequests(f.o, { live: true, maxMinutes: 5, clock: v.clock });
    assert.ok(f.seen.some((r) => r.taskId === "P1" && r.role === "worker"), "P1 ran once the pause was cleared");
    assert.ok(v.waits.length <= 2, "it did not wait out the old reset: " + v.waits.join(","));
    assert.notEqual(run.results.find((r) => r.requestId === id)!.outcome, "WAITING_UNTIL");
  } finally {
    f.close();
  }
});

test("clearing one of two pauses a request waits on wakes it, though the earliest reset is unchanged (PR #13 review P-1)", async () => {
  const f = live();
  try {
    const id = f.submit(["P1", "Q1"], "two-pauses");
    const pause = (provider: "claude" | "codex", ms: number) =>
      f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider, kind: "USAGE_LIMIT", until: new Date(Date.now() + ms).toISOString(), validResetAt: new Date(Date.now() + ms - 60_000).toISOString(), observedAt: now() });
    pause("claude", 600_000);
    pause("codex", 1_200_000);
    const v = virtualClock((_, n) => {
      if (n === 1)
        f.c.clearProviderPause("codex", { reason: "the usage page shows Codex's limit lifted", evidence: ["usage page"], sourceRef: "test:operator" }, f.actor);
    });
    await driveRequests(f.o, { live: true, maxMinutes: 5, clock: v.clock });
    assert.ok(f.seen.some((r) => r.taskId === "Q1" && r.role === "worker"), "Codex work ran once its pause was cleared");
    assert.ok(!f.seen.some((r) => r.provider === "claude"), "Claude stayed paused");
    void id;
  } finally {
    f.close();
  }
});

test("a clear recorded just after the driver read the paused view still wakes the wait (PR #13 review P-2)", async () => {
  const f = live();
  try {
    const id = f.submit(["P1"], "race");
    pauseFor(f, "claude");
    // Another process clears the pause right after the driver's view read,
    // before its next read of the pauses (the race the review reproduced).
    let armed = false,
      inInspect = 0;
    const drive = f.o.drive.bind(f.o);
    (f.o as any).drive = async (rid: string, mode: any) => {
      const result = await drive(rid, mode);
      armed = true;
      return result;
    };
    const inspect = f.o.inspect.bind(f.o);
    (f.o as any).inspect = (rid: string) => {
      inInspect++;
      try {
        return inspect(rid);
      } finally {
        inInspect--;
      }
    };
    const pauses = f.c.providerPauses.bind(f.c);
    (f.c as any).providerPauses = (...args: any[]) => {
      if (armed && !inInspect) {
        armed = false;
        f.c.clearProviderPause("claude", { reason: "cleared elsewhere", evidence: ["usage page"], sourceRef: "test:operator" }, f.actor);
      }
      return pauses(...args);
    };
    const v = virtualClock();
    await driveRequests(f.o, { live: true, maxMinutes: 5, clock: v.clock });
    assert.ok(f.seen.some((r) => r.taskId === "P1" && r.role === "worker"), "P1 ran once the pause was cleared");
    void id;
  } finally {
    f.close();
  }
});

// The progress log : the owner can see the driver
// working; the log never changes what the driver does.
test("the progress log shows the driver starting, each advance and run, and stopping, and the driver decides exactly as without it", async () => {
  const outcome = async (withLog: boolean) => {
    const f = mock([demoTask("A"), demoTask("B", { decisionRequired: true })]);
    try {
      const one = f.submit(f.o, ["A"], "one");
      const two = f.submit(f.o, ["B"], "two");
      const lines: string[] = [];
      const run = await driveRequests(f.o, {
        mock: true,
        ...(withLog ? { progress: new ProgressLog((text) => lines.push(text)) } : {}),
      });
      const results = run.results.map(({ requestId, ...r }) => ({ request: requestId === one ? "one" : requestId === two ? "two" : "?", ...r }));
      return { results, advances: run.advances, lines, one: one.slice(0, 8), two: two.slice(0, 8) };
    } finally {
      f.close();
    }
  };
  const plain = await outcome(false);
  const logged = await outcome(true);
  assert.deepEqual(logged.results, plain.results);
  assert.equal(logged.advances, plain.advances);
  assert.equal(plain.lines.length, 0);
  const text = logged.lines.join("");
  const { one, two } = logged;
  assert.match(logged.lines[0]!, new RegExp(`^\\S+Z driver\\[${process.pid}\\] started \\(mock, budget 50 min\\): ${one} \\(one\\), ${two} \\(two\\)\\n$`));
  assert.match(text, new RegExp(`${one} advance 1 started\\n`));
  assert.match(text, new RegExp(`${one} run started: A worker on \\w+ \\(\\S+\\)\\n`));
  assert.match(text, new RegExp(`${one} run finished: A worker on \\w+: SUCCEEDED after \\d+s\\n`));
  assert.match(text, new RegExp(`${one} run finished: A reviewer on \\w+: SUCCEEDED after \\d+s\\n`));
  assert.match(text, new RegExp(`${one} advance 1 ended after \\d+s: (progress recorded|WAITING_FOR_OWNER: |FINISHED: )`));
  // The held request says why, once, and is not advanced again.
  assert.match(text, new RegExp(`${two} advance 1 ended after \\d+s: held: .*OWNER_DECISION_REQUIRED`));
  assert.doesNotMatch(text, new RegExp(`${two} advance 2 started`));
  assert.match(logged.lines.at(-1)!, new RegExp(`driver\\[${process.pid}\\] stopped after ${logged.advances} advance\\(s\\): ${one} (WAITING_FOR_OWNER|FINISHED); ${two} HELD\\n$`));
  // No run of either request goes unreported, and none twice.
  for (const id of [one, two]) {
    const started = logged.lines.filter((l) => l.includes(`${id} run started:`)).length;
    const ended = logged.lines.filter((l) => new RegExp(`${id} run (finished|released|outcome)`).test(l)).length;
    assert.equal(started, ended, text);
  }
});

test("while an advance is under way the log says what is going on after a quiet stretch, and nothing is written once the driver returns", async () => {
  const f = mock([demoTask("A")]);
  try {
    const id = f.submit(f.o, ["A"], "slow");
    const real = f.o.drive.bind(f.o);
    (f.o as any).drive = async (rid: string, mode: any) => {
      await new Promise((done) => setTimeout(done, 120));
      return real(rid, mode);
    };
    const lines: string[] = [];
    await driveRequests(f.o, { mock: true, progress: new ProgressLog((text) => lines.push(text), Date.now, { pollMs: 10, quietMs: 30 }) });
    assert.ok(lines.some((l) => l.includes(`${id.slice(0, 8)} still advancing`)), lines.join(""));
    const count = lines.length;
    await new Promise((done) => setTimeout(done, 60));
    assert.equal(lines.length, count, "the timer stops with the driver");
  } finally {
    f.close();
  }
});

test("a failure while logging never stops the driver or changes what it does; the first failure is kept", async () => {
  const f = mock([demoTask("A")]);
  try {
    f.submit(f.o, ["A"], "one");
    (f.c as any).progressRuns = () => {
      throw new Error("database is gone");
    };
    const log = new ProgressLog(() => {});
    const run = await driveRequests(f.o, { mock: true, progress: log });
    assert.ok(["WAITING_FOR_OWNER", "FINISHED"].includes(run.results[0]!.outcome), JSON.stringify(run.results));
    assert.match(log.failure!, /database is gone/);
  } finally {
    f.close();
  }
});

test("PR #14 review: a run released before it launched, and one going when the driver started, both get their closing lines", async () => {
  const f = live();
  try {
    const paused = f.submit(["P1"], "paused");
    // As in S5-1: the owner pauses the request after the worker's reservation, before its start.
    const execute = f.c.execute.bind(f.c);
    (f.c as any).execute = (a: any, adapter: any, actor: any) => {
      if (a.taskId === "P1" && a.role === "worker" && !f.o.requestPause(paused))
        f.o.pauseRequest(paused, { text: "Stop now", sourceRef: "test:owner" });
      return execute(a, adapter, actor);
    };
    const lines: string[] = [];
    await driveRequests(f.o, { live: true, maxAdvances: 3, progress: new ProgressLog((text) => lines.push(text)) });
    const text = lines.join("");
    assert.match(text, new RegExp(`${paused.slice(0, 8)} run released before launch: P1 worker on \\w+\\n`), text);
    assert.doesNotMatch(text, /run started: P1 worker/);
    // Runs settled before the journal position are left out unless named; named, they come back with their end.
    const position = f.c.journalPosition();
    const settled = f.c.inspect("P1").attempts.filter((a: any) => !["RESERVED", "STARTED", "UNKNOWN"].includes(a.state));
    assert.ok(settled.length >= 1);
    assert.deepEqual(f.c.progressRuns(position), []);
    const named = f.c.progressRuns(position, settled.map((a: any) => a.id));
    assert.deepEqual(named.map((r) => r.runId).sort(), settled.map((a: any) => a.id).sort());
    const done = named.find((r) => r.state === "SUCCEEDED");
    if (done) assert.ok(done.endedAt, JSON.stringify(done));
  } finally {
    f.close();
  }
});


/**
 * A started attempt with an expired heartbeat remains protected until an
 * operator establishes what actually happened. Seeing an expired timestamp
 * must not invent process death, lost usage, or permission to replay effects.
 */
test("watchdog reports an already-expired STARTED lease before advancing", async () => {
  const f = live();
  try {
    const requestId = f.submit(["P1"], "expired-at-start");
    const a = f.c.reserve("P1", { requestKey: "expired" }, f.actor);
    const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", a.id)!;
    const body = JSON.parse(row.body);
    Object.assign(body, {
      state: "STARTED",
      started: true,
      startedAt: now(),
      leaseUntil: Date.now() - 2_000,
    });
    f.db.run(
      "UPDATE attempts SET state='STARTED', lease_until=?,body=? WHERE id=?",
      body.leaseUntil,
      JSON.stringify(body),
      a.id,
    );
    const v = virtualClock();
    const lines: string[] = [];
    const result = await driveRequests(f.o, {
      live: true,
      requestIds: [requestId],
      clock: v.clock,
      maxMinutes: 1,
      progress: new ProgressLog((text) => lines.push(text)),
    });
    const first = result.results[0]!;
    // The notice is in the progress log too, under its request.
    assert.ok(lines.some((l) => l.includes(`${requestId.slice(0, 8)} watchdog: RUN_LEASE_EXPIRED: ${a.id}`)), lines.join(""));
    assert.equal(first.outcome, "HELD", JSON.stringify(first));
    assert.equal(result.advances, 0);
    assert.match(first.detail, new RegExp("RUN_LEASE_EXPIRED: " + a.id));
    assert.match(first.detail, /process death and external effects are NOT established/);
    assert.match(first.detail, /resume --execute/);
    assert.match(first.detail, /reconcile-helper/);
    assert.match(first.nextActions.join("\n"), /reconcile/);
    assert.deepEqual(v.waits, [], "already expired: no polling delay");
    assert.equal(f.c.inspect("P1").attempts[0]!.state, "STARTED", "watchdog cannot auto-reconcile");
    assert.equal(f.seen.length, 0, "no retry or external work");
  } finally {
    f.close();
  }
});

test("watchdog reports an expired lease promptly but retains the running advance's ownership", async () => {
  const f = live();
  try {
    const requestId = f.submit(["P1"], "hung-advance");
    let runId = "";
    let releaseAdvance!: () => void;
    const neverFinishesUntilReleased = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    (f.o as any).drive = () => {
      const a = f.c.reserve("P1", { requestKey: "hung-run" }, f.actor);
      runId = a.id;
      const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", a.id)!;
      const body = JSON.parse(row.body);
      Object.assign(body, {
        state: "STARTED",
        started: true,
        startedAt: now(),
        leaseUntil: Date.now() + 60_000,
      });
      f.db.run(
        "UPDATE attempts SET state='STARTED', lease_until=?,body=? WHERE id=?",
        body.leaseUntil,
        JSON.stringify(body),
        a.id,
      );
      return neverFinishesUntilReleased;
    };
    const v = virtualClock((_ms, n) => {
      if (n !== 1) return;
      const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId)!;
      const body = JSON.parse(row.body);
      body.leaseUntil = Date.now() - 1_000;
      f.db.run(
        "UPDATE attempts SET lease_until=?,body=? WHERE id=?",
        body.leaseUntil,
        JSON.stringify(body),
        runId,
      );
    });
    const notices: string[] = [];
    const run = await driveRequests(f.o, {
      live: true,
      requestIds: [requestId],
      clock: v.clock,
      watchdogClock: v.clock,
      maxMinutes: 1,
      notify: (notice) => {
        notices.push(notice);
        if (!notice.startsWith("RUN_LEASE_EXPIRED: ")) return;
        assert.match(notice, new RegExp("RUN_LEASE_EXPIRED: " + runId));
        // The worker has not stopped, and its lease/claims have not been
        // released merely because a watchdog discovered the expiry.
        assert.equal(f.c.inspect("P1").attempts[0]!.state, "STARTED");
        releaseAdvance(); // simulate actual quiescence; safe to return now
      },
    });
    assert.equal(run.advances, 1);
    assert.ok(v.waits.length >= 1, "driver must wake while the promise is pending");
    assert.equal(notices.filter((n) => n.startsWith("RUN_LEASE_EXPIRED: ")).length, 1, "no repeated alert spam");
    // The run is no process's here (drive() was replaced), so the stop asked of it touches nothing.
    assert.ok(notices.some((n) => /stop NOT_IN_PROCESS/.test(n)), notices.join("\n"));
    assert.equal(run.results[0]!.outcome, "HELD", JSON.stringify(run));
    assert.match(run.results[0]!.detail, /process death and external effects are NOT established/);
    assert.equal(f.c.inspect("P1").attempts[0]!.state, "STARTED", "reporting grants no recovery");
  } finally {
    f.close();
  }
});

test("watchdog does not mistake an expired lease on unrelated work for this request", async () => {
  const f = live();
  try {
    const own = f.submit(["P1"], "own-project");
    const other = f.submit(["Q1"], "other-project");
    const a = f.c.reserve("Q1", { requestKey: "expired-elsewhere" }, f.actor);
    const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", a.id)!;
    const body = JSON.parse(row.body);
    Object.assign(body, {
      state: "STARTED",
      started: true,
      startedAt: now(),
      leaseUntil: Date.now() - 3_000,
    });
    f.db.run(
      "UPDATE attempts SET state='STARTED',lease_until=?,body=? WHERE id=?",
      body.leaseUntil,
      JSON.stringify(body),
      a.id,
    );
    const run = await driveRequests(f.o, {
      live: true,
      requestIds: [own],
      maxMinutes: 1,
    });
    assert.notEqual(run.results[0]!.outcome, "TIME_BUDGET_ENDED", JSON.stringify(run));
    assert.ok(run.results[0]!.advances >= 1, "unrelated work was served");
    assert.ok(!run.results[0]!.detail.includes("RUN_LEASE_EXPIRED"));
    assert.equal(f.c.inspect("Q1").attempts[0]!.state, "STARTED", "other request is unchanged");
    void other;
  } finally {
    f.close();
  }
});

// Supervised quiescence : an expired run an
// advance still waits on is asked to stop, scoped to it; the advance, and the
// host lock and database with it, are kept until the controller ends it.

/** The run's stored lease put in the past, as a dead process leaves it. */
function expireLease(f: ReturnType<typeof live>, runId: string) {
  const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId)!;
  const body = JSON.parse(row.body);
  body.leaseUntil = Date.now() - 1_000;
  f.db.run("UPDATE attempts SET lease_until=?,body=? WHERE id=?", body.leaseUntil, JSON.stringify(body), runId);
}
const until = async (ready: () => boolean, what: string, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error("not in time: " + what);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const started = (f: ReturnType<typeof live>, runId: () => string) => () =>
  runId() !== "" && f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId())?.state === "STARTED";
/** The real clock, woken at most every 20 ms (the watchdog otherwise waits 10 s). */
const quickClock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((done) => {
      const timer = setTimeout(done, Math.min(ms, 20));
      signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
    }),
};
const eventsFor = (f: ReturnType<typeof live>, kind: string, runId: string) =>
  f.db.all<{ body: string }>("SELECT body FROM events WHERE kind=?", kind).map((r) => JSON.parse(r.body)).filter((e) => e.runId === runId);
const countStops = (f: ReturnType<typeof live>) => {
  const counter = { stops: 0 };
  const real = f.c.stopRun.bind(f.c);
  (f.c as any).stopRun = (...args: Parameters<typeof real>) => (counter.stops++, real(...args));
  return counter;
};

test("an expired in-flight run is asked to stop; one whose adapter never answers is ended here once nothing of it runs, and recorded unknown", async () => {
  const f = live([], { leaseMs: 400 });
  try {
    const requestId = f.submit(["P1"], "hung-adapter");
    let runId = "";
    // The adapter ignores its abort signal and never settles: the hazard the incident brief feared.
    f.slow((r) => ((runId ||= r.runId), new Promise<void>(() => {})));
    f.activity(() => ({ processStopped: true, detail: "fixture: no process of it" }));
    const notices: string[] = [];
    const driving = driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1, notify: (m) => void notices.push(m) });
    await until(started(f, () => runId), "the run started");
    expireLease(f, runId);
    const run = await driving;
    assert.equal(run.results[0]!.outcome, "HELD", JSON.stringify(run));
    assert.match(run.results[0]!.detail, new RegExp("RUN_LEASE_EXPIRED: " + runId + " \\(UNKNOWN"));
    assert.match(run.results[0]!.detail, /reconcile-helper --run-id/);
    assert.doesNotMatch(run.results[0]!.detail, /resume --execute/, "the run was recorded here; global recovery is not the next step");
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "UNKNOWN");
    assert.ok(eventsFor(f, "RUN_STOPPED_BY_CONTROLLER", runId).length >= 1, "the stop was asked as any stop is");
    const unconfirmed = eventsFor(f, "RUN_STOP_UNCONFIRMED", runId);
    assert.equal(unconfirmed.length, 1);
    assert.equal(unconfirmed[0].processStopped, true);
    assert.equal(unconfirmed[0].openDriveWrites, 0);
    assert.equal(eventsFor(f, "UNKNOWN_OUTCOME_RECORDED", runId).length, 1);
    assert.ok(notices.some((n) => /stop ABANDONED/.test(n)), notices.join("\n"));
    assert.ok(notices.some((n) => new RegExp("advance ended; run " + runId + " is UNKNOWN").test(n)), notices.join("\n"));
    assert.equal(f.seen.length, 1, "nothing replayed");
    // The unknown run keeps its custody: the request waits for reconciliation.
    const view = f.o.inspect(requestId);
    assert.equal(view.status, "HELD_RECONCILIATION");
    assert.deepEqual((view.tasks.find((t) => t.taskId === "P1") as any).unresolvedRuns, [{ runId, state: "UNKNOWN" }]);
  } finally {
    f.close();
  }
});

test("while a process of the expired run may be alive, the advance and the host are kept, and the stop is asked again", async () => {
  const f = live([], { leaseMs: 400 });
  try {
    const requestId = f.submit(["P1"], "hung-process");
    let runId = "";
    f.slow((r) => ((runId ||= r.runId), new Promise<void>(() => {})));
    let alive = true;
    f.activity(() => ({ processStopped: !alive, detail: alive ? "fixture: its process is alive" : "fixture: no process of it" }));
    const counter = countStops(f);
    const notices: string[] = [];
    let returned = false;
    const driving = driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1, notify: (m) => void notices.push(m) }).then((r) => ((returned = true), r));
    await until(started(f, () => runId), "the run started");
    expireLease(f, runId);
    await until(() => counter.stops >= 3, "the stop asked again");
    assert.equal(returned, false, "the advance, and the host with it, is kept while a process of the run may be alive");
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "STARTED");
    assert.equal(eventsFor(f, "RUN_STOP_UNCONFIRMED", runId).length, 0, "nothing abandoned");
    assert.equal(notices.filter((n) => /stop UNCONFIRMED/.test(n)).length, 1, "said once, not at every wake: " + notices.join("\n"));
    assert.match(notices.find((n) => /stop UNCONFIRMED/.test(n))!, /its process is alive/);
    alive = false;
    const run = await driving;
    assert.equal(run.results[0]!.outcome, "HELD");
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "UNKNOWN");
    assert.equal(notices.filter((n) => /stop ABANDONED/.test(n)).length, 1, notices.join("\n"));
  } finally {
    f.close();
  }
});

test("a Drive write of the expired run still open keeps the advance and the host until it ends", async () => {
  const f = live([], { leaseMs: 400 });
  try {
    const requestId = f.submit(["P1"], "open-write");
    let runId = "";
    f.slow((r) => ((runId ||= r.runId), new Promise<void>(() => {})));
    f.activity(() => ({ processStopped: true, detail: "fixture: no process of it" }));
    const counter = countStops(f);
    const notices: string[] = [];
    let returned = false;
    const driving = driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1, notify: (m) => void notices.push(m) }).then((r) => ((returned = true), r));
    await until(started(f, () => runId), "the run started");
    // A write intent of the run begun and not ended, as the gateway records one around a Drive call.
    f.db.run("INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)", "intent-open", "INTENT", "drive:create:folder-1:intent-open", "run", runId, "P1", "spec", "OPEN", null, now(), JSON.stringify({ kind: "create", folderId: "folder-1" }));
    // Another process's open write is its own: not this host's to wait for.
    f.db.run("INSERT INTO resource_claims VALUES(?,?,?,?,?,?,?,?,?,?,?)", "intent-elsewhere", "INTENT", "drive:create:folder-2:intent-elsewhere", "run", "run-of-another-process", "Q1", "spec", "OPEN", null, now(), JSON.stringify({ kind: "create", folderId: "folder-2" }));
    assert.deepEqual(f.c.openDriveWritesHere(), [{ runId, intentId: "intent-open", resource: "drive:create:folder-1:intent-open" }]);
    expireLease(f, runId);
    await until(() => counter.stops >= 2, "the stop asked again");
    assert.equal(returned, false, "kept while a write of the run may be in flight");
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "STARTED");
    assert.match(notices.find((n) => /stop UNCONFIRMED/.test(n))!, /1 Drive write\(s\) of it open/);
    f.db.run("UPDATE resource_claims SET state='RESOLVED' WHERE id='intent-open'");
    const run = await driving;
    assert.equal(run.results[0]!.outcome, "HELD");
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "UNKNOWN");
    assert.equal(eventsFor(f, "RUN_STOP_UNCONFIRMED", runId)[0]?.openDriveWrites, 0);
  } finally {
    f.close();
  }
});

test("an adapter that answers its stop ends the run itself; nothing is abandoned", async () => {
  const f = live([], { leaseMs: 400 });
  try {
    const requestId = f.submit(["P1"], "answers-stop");
    let runId = "";
    // Stopped, the adapter returns as a cancelled run does; the controller records the outcome.
    f.slow((r) => ((runId ||= r.runId), new Promise<void>((resolve) => r.signal?.addEventListener("abort", () => resolve(), { once: true }))));
    f.activity(() => ({ processStopped: true, detail: "fixture: no process of it" }));
    const notices: string[] = [];
    const driving = driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 500, maxMinutes: 1, notify: (m) => void notices.push(m) });
    await until(started(f, () => runId), "the run started");
    expireLease(f, runId);
    const run = await driving;
    assert.equal(run.results[0]!.outcome, "HELD", JSON.stringify(run));
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state, "UNKNOWN");
    assert.equal(eventsFor(f, "RUN_STOP_UNCONFIRMED", runId).length, 0);
    assert.ok(!notices.some((n) => /ABANDONED/.test(n)), notices.join("\n"));
    assert.equal(f.seen.length, 1);
  } finally {
    f.close();
  }
});

test("a run whose lease is live is left alone however often the watchdog wakes", async () => {
  const f = live([], { leaseMs: 2_000 });
  try {
    const requestId = f.submit(["P1"], "slow-but-alive");
    // Slower than a heartbeat interval, so heartbeats come while it runs; its lease never expires.
    f.slow(() => new Promise<void>((r) => setTimeout(r, 700)));
    const counter = countStops(f);
    const notices: string[] = [];
    const run = await driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1, notify: (m) => void notices.push(m) });
    assert.equal(counter.stops, 0, "no stop asked");
    assert.deepEqual(notices, []);
    assert.ok(run.results[0]!.advances >= 1);
    assert.ok(!run.results[0]!.detail.includes("RUN_LEASE_EXPIRED"), run.results[0]!.detail);
    assert.ok(f.c.inspect("P1").attempts.every((a: any) => a.state !== "UNKNOWN"), "no run recorded unknown");
  } finally {
    f.close();
  }
});

test("another host's expired run is neither stopped nor recorded by this host's driver", async () => {
  const f = live();
  try {
    const own = f.submit(["P1"], "own");
    const codexHost = new Orchestrator(f.c, { claude: f.adapter, codex: f.adapter }, "codex");
    codexHost.submit({ requestKey: randomUUID(), prompt: "Do it.", context: { cwd: f.root, projectKey: "theirs" }, sourceRef: "test:owner", taskIds: ["Q1"] });
    const theirs = f.c.reserve("Q1", { requestKey: "theirs-run" }, f.actor);
    const row = f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", theirs.id)!;
    const body = JSON.parse(row.body);
    Object.assign(body, { state: "STARTED", started: true, startedAt: now() });
    f.db.run("UPDATE attempts SET state='STARTED',body=? WHERE id=?", JSON.stringify(body), theirs.id);
    expireLease(f, theirs.id);
    const counter = countStops(f);
    const run = await driveRequests(f.o, { live: true, requestIds: [own], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1 });
    assert.equal(counter.stops, 0);
    assert.ok(run.results[0]!.advances >= 1, "this host's work went on");
    assert.ok(!run.results[0]!.detail.includes("RUN_LEASE_EXPIRED"), run.results[0]!.detail);
    assert.equal(f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", theirs.id)!.state, "STARTED");
    assert.equal(eventsFor(f, "RUN_STOPPED_BY_CONTROLLER", theirs.id).length, 0);
  } finally {
    f.close();
  }
});

test("the driver does not return while a process of a run whose advance has ended is still alive", async () => {
  const f = live([], { leaseMs: 400 });
  try {
    const requestId = f.submit(["P1"], "still-stopping");
    let runId = "";
    // Stopped, the adapter returns at once, as a cancellation it gave up confirming does, while its process is still stopping.
    f.slow((r) => ((runId ||= r.runId), new Promise<void>((resolve) => r.signal?.addEventListener("abort", () => resolve(), { once: true }))));
    let alive = true;
    f.busy(() => (alive ? [{ runId, detail: "fixture: its process is still stopping" }] : []));
    const notices: string[] = [];
    let returned = false;
    const lines: string[] = [];
    const driving = driveRequests(f.o, { live: true, requestIds: [requestId], watchdogClock: quickClock, stopGraceMs: 50, maxMinutes: 1, notify: (m) => void notices.push(m), progress: new ProgressLog((text) => lines.push(text)) }).then((r) => ((returned = true), r));
    await until(started(f, () => runId), "the run started");
    expireLease(f, runId);
    await until(() => notices.some((n) => /waiting before the host lock and database go/.test(n)), "the wait said");
    await until(() => f.db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", runId)!.state === "UNKNOWN", "the run ended unknown");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(returned, false, "the advance ended, but the host is kept while the process is alive");
    assert.match(notices.find((n) => /waiting before/.test(n))!, /its process is still stopping/);
    alive = false;
    const run = await driving;
    assert.equal(run.results[0]!.outcome, "HELD", JSON.stringify(run));
    assert.equal(notices.filter((n) => /waiting before/.test(n)).length, 1, "said once: " + notices.join("\n"));
    // The host's wait is in the progress log too, before the driver's last line.
    const waited = lines.findIndex((l) => l.includes(`driver[${process.pid}] watchdog: waiting before the host lock and database go`));
    assert.ok(waited >= 0 && waited < lines.length - 1, lines.join(""));
    assert.match(lines.at(-1)!, /stopped after 1 advance\(s\)/);
  } finally {
    f.close();
  }
});

test("stopRun: a run not going in this process is left alone, and only the owner's actor may ask", async () => {
  const f = live();
  try {
    const stop = await f.c.stopRun("no-such-run", f.actor, { reason: "test", graceMs: 10 });
    assert.equal(stop.outcome, "NOT_IN_PROCESS");
    await assert.rejects(f.c.stopRun("no-such-run", { id: "x", uid: process.getuid!(), role: "OWNER" } as any, { reason: "test", graceMs: 10 }), /UNAUTHENTICATED_ACTOR/);
  } finally {
    f.close();
  }
});
