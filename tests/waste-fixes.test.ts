import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { SqliteStore } from "../src/store.js";
import { Capture, EventCapture } from "../src/live.js";
import { resolveRoute, type RoutingPolicy } from "../src/routing.js";
import { TaskSchema } from "../src/domain.js";
import {
  DROPPED_CODEX_EVENTS,
  inspectCliOutput,
  normalizeCliResponse,
  skippableCodexEvent,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";

// Fixes for runs the orchestrator wasted .

const now = () => new Date().toISOString();

function task(id: string, budget: Record<string, number> = {}) {
  return {
    id,
    programme: "DEMO",
    lane: "STREAM",
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
    sources: [{ evidenceId: "src-" + id, revision: "r1", digest: "a".repeat(64) }],
    specificationAuthenticated: true,
    providers: ["claude"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/" + id],
    resources: [],
    risk: "LOW",
    reviewPolicy: { required: false, crossProvider: false, independentAudits: false },
    acceptance: [{ id: "a", description: "d", evidenceKind: "LOCAL" }],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    estimatedCostUsd: 0,
    budget: {
      deadlineMs: 10_000,
      maxAttempts: 1,
      maxCostUsd: 10,
      maxTokens: 1_000,
      ...budget,
    },
    artifactRevision: "rev1",
    simulation: false,
    createdAt: now(),
  };
}

const capability = (model: string, effort: string, expiresAt: number) => ({
  provider: "claude" as const,
  model,
  effort,
  verifiedAt: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(expiresAt).toISOString(),
  evidenceRef: "file:test",
});
const route = (
  id: string,
  level: string,
  model: string,
  effort: string,
  roles: string[],
  expiresAt = Date.now() + 60_000,
) => ({
  id,
  level,
  provider: "claude",
  model,
  effort,
  roles,
  simulation: false,
  enabled: true,
  capability: capability(model, effort, expiresAt),
});
const policy = (expiresAt = Date.now() + 60_000, effort = "low") =>
  ({
    version: 1,
    id: "p",
    routes: [
      route("claude-routine", "ROUTINE", "claude-haiku-5-5", effort, ["worker", "reviewer"], expiresAt),
    ],
  }) as RoutingPolicy;

function setup(options: {
  policy: () => RoutingPolicy;
  leaseMs?: number;
  serial?: boolean;
  tasks?: ReturnType<typeof task>[];
}) {
  const root = mkdtempSync(join(tmpdir(), "longform-waste-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    workspaceRoot: join(root, "ws"),
    ownerUid: process.getuid!(),
    allowRealLocalTasks: true,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options.serial ? { serialProviders: ["claude"] as const } : {}),
    routingPolicyLoader: options.policy,
    verifyRoutingCapability: () => true,
  });
  const actor = c.localActor();
  const tasks = options.tasks ?? [task("T")];
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
  const events = (kind: string) =>
    db
      .all<{ body: string }>("SELECT body FROM events WHERE kind=? ORDER BY seq", kind)
      .map((row) => JSON.parse(row.body));
  return {
    c,
    db,
    actor,
    events,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}

const receipt = (
  request: ProviderRequest,
  status: ProviderReceipt["status"],
  output = "",
): ProviderReceipt => ({
  runId: request.runId,
  taskId: request.taskId,
  provider: request.provider,
  model: request.model,
  effort: request.effort,
  sessionId: randomUUID(),
  exitCode: status === "SUCCEEDED" ? 0 : null,
  status,
  startedAt: now(),
  endedAt: now(),
  output,
  tests: [],
  costUsd: status === "SUCCEEDED" ? 0.01 : 0,
  tokens: status === "SUCCEEDED" ? 100 : 0,
  identityVerified: status === "SUCCEEDED",
  simulation: false,
});
/** Succeeds after `ms`, or reports CANCELLED as soon as the run is aborted. */
const slow = (ms: number, log?: string[]) => ({
  execute: (request: ProviderRequest) =>
    new Promise<ProviderReceipt>((resolve) => {
      log?.push("start " + request.taskId);
      const timer = setTimeout(() => {
        log?.push("end " + request.taskId);
        resolve(receipt(request, "SUCCEEDED", "done"));
      }, ms);
      request.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        log?.push("end " + request.taskId);
        resolve(receipt(request, "CANCELLED"));
      });
    }),
});

test("F3: a run in flight is not stopped when its route's attestation ages out", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  const expiresAt = Date.now() + 400;
  const f = setup({ leaseMs: 90, policy: () => policy(expiresAt) });
  try {
    const a = f.c.reserve("T", { requestKey: "k" }, f.actor);
    const pending = f.c.execute(a, slow(800), f.actor);
    // Keep real controller heartbeat callbacks and the original short lease,
    // but advance their clock deliberately: a busy CI event loop must not
    // turn this attestation-expiry test into an unrelated lost-lease test.
    void pending.catch(() => {}); // the await below still reports an early failure
    for (let elapsed = 30; elapsed <= 810; elapsed += 30) {
      t.mock.timers.tick(30);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (elapsed === 420) {
        assert.equal(f.c.inspect("T").attempts[0].state, "STARTED");
        assert.equal(f.c.route("T").ok, false, "the attestation expires while the run is still in flight");
      }
    }
    const result = await pending;
    assert.ok(Date.now() > expiresAt);
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(f.c.inspect("T").attempts[0].state, "SUCCEEDED");
    assert.equal(f.events("RUN_STOPPED_BY_CONTROLLER").length, 0);
    // A new run still can't start on the aged attestation.
    assert.equal(f.c.route("T").ok, false);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("F3: a run in flight still stops when its route itself changes, and the reason is recorded", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() });
  let effort = "low";
  const f = setup({ leaseMs: 90, policy: () => policy(undefined, effort) });
  try {
    const a = f.c.reserve("T", { requestKey: "k" }, f.actor);
    setTimeout(() => (effort = "medium"), 150);
    const pending = f.c.execute(a, slow(5_000), f.actor);
    void pending.catch(() => {}); // the await below still reports an early failure
    // Exercise the real short-lease heartbeats without letting CI scheduling
    // expire the lease before the route-change cancellation can be recorded.
    for (let elapsed = 30; elapsed <= 240; elapsed += 30) {
      t.mock.timers.tick(30);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (elapsed === 120) {
        assert.equal(f.c.inspect("T").attempts[0].state, "STARTED");
        assert.equal(f.events("RUN_STOPPED_BY_CONTROLLER").length, 0);
      }
    }
    assert.equal(f.events("RUN_STOPPED_BY_CONTROLLER").length, 1);
    const result = await pending;
    assert.equal(result.status, "CANCELLED");
    const stops = f.events("RUN_STOPPED_BY_CONTROLLER");
    assert.equal(stops.length, 1);
    assert.equal(stops[0].runId, a.id);
    assert.match(stops[0].reason, /ROUTING_POLICY_CHANGED_REPLAN_REQUIRED/);
  } finally {
    t.mock.timers.reset();
    f.close();
  }
});

test("F3: a started run keeps its route; a new run is routed as before", () => {
  const t = TaskSchema.parse(task("T"));
  const p = {
    version: 1,
    id: "p",
    routes: [
      route("advisor-1", "EXPERT", "claude-fable-5-1", "max", ["advisor"]),
      route("advisor-2", "EXPERT", "claude-opus-5-5", "max", ["advisor"]),
      route("claude-routine", "ROUTINE", "claude-haiku-5-5", "low", ["worker"]),
    ],
  } as RoutingPolicy;
  const usable = (...models: string[]) => (cap: { model: string }) =>
    models.includes(cap.model);
  // Fable isn't usable when the advisor starts, so it runs on Opus.
  const start = resolveRoute(t, "advisor", p, {
    verifyLiveCapability: usable("claude-opus-5-5"),
  });
  assert.ok(start.ok && start.routeId === "advisor-2");
  // Mid-run Fable becomes usable and Opus's attestation lapses: the run keeps Opus.
  const midRun = resolveRoute(t, "advisor", p, {
    verifyLiveCapability: usable("claude-fable-5-1"),
    startedRouteId: "advisor-2",
  });
  assert.ok(midRun.ok && start.ok);
  if (midRun.ok && start.ok) {
    assert.equal(midRun.routeId, "advisor-2");
    assert.equal(midRun.routeDigest, start.routeDigest);
    assert.equal(midRun.policyDigest, start.policyDigest);
  }
  // A new advisor run takes Fable.
  const fresh = resolveRoute(t, "advisor", p, {
    verifyLiveCapability: usable("claude-fable-5-1"),
  });
  assert.ok(fresh.ok && fresh.routeId === "advisor-1");
  // Tiered routes: a lapsed attestation holds a new run, not a started one.
  assert.equal(resolveRoute(t, "worker", p, { verifyLiveCapability: () => false }).ok, false);
  assert.equal(
    resolveRoute(t, "worker", p, {
      verifyLiveCapability: () => false,
      startedRouteId: "claude-routine",
    }).ok,
    true,
  );
  // A disabled route isn't kept, started or not.
  const disabled = {
    ...p,
    routes: p.routes.map((r) => (r.id === "advisor-2" ? { ...r, enabled: false } : r)),
  } as RoutingPolicy;
  assert.equal(
    resolveRoute(t, "advisor", disabled, {
      verifyLiveCapability: () => true,
      startedRouteId: "advisor-2",
    }).ok,
    false,
  );
});

test("F5: a reservation that never started uses up no attempt", async (t) => {
  // Advance lease expiry explicitly; host scheduling must not expire the
  // subsequent successful run in this attempt-accounting test.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = setup({ leaseMs: 50, policy: () => policy() });
  try {
    const unused = f.c.reserve("T", { requestKey: "k1" }, f.actor);
    t.mock.timers.tick(80);
    assert.ok(unused.leaseUntil < Date.now(), "the unused reservation really expired");
    f.c.recover(f.actor);
    assert.equal(f.c.inspect("T").attempts[0].state, "NOT_STARTED");
    assert.deepEqual(f.c.reasons("T"), []);
    const a = f.c.reserve("T", { requestKey: "k2" }, f.actor);
    assert.ok(a.leaseUntil > Date.now(), "the replacement reservation is current");
    assert.equal((await f.c.execute(a, slow(10), f.actor)).status, "SUCCEEDED");
    // Its one attempt is used now.
    assert.ok(f.c.reasons("T").includes("ATTEMPT_BUDGET_EXHAUSTED"));
  } finally {
    f.close();
  }
});

test("F6: a serial provider's runs go one at a time; a waiting run keeps its reservation, and its deadline starts with its turn", async () => {
  // Each run takes 900 ms against a 1,200 ms deadline, so the second only
  // finishes if the wait for its turn doesn't count. The 300 ms lease is
  // shorter than that wait, so the waiting run keeps its reservation only by
  // its heartbeats, with room for a slow test machine.
  const f = setup({
    leaseMs: 300,
    serial: true,
    policy: () => policy(),
    tasks: [task("T1", { deadlineMs: 1_200 }), task("T2", { deadlineMs: 1_200 })],
  });
  try {
    const log: string[] = [];
    const a1 = f.c.reserve("T1", { requestKey: "k1" }, f.actor);
    const a2 = f.c.reserve("T2", { requestKey: "k2" }, f.actor);
    const [r1, r2] = await Promise.all([
      f.c.execute(a1, slow(900, log), f.actor),
      f.c.execute(a2, slow(900, log), f.actor),
    ]);
    assert.equal(r1.status, "SUCCEEDED");
    assert.equal(r2.status, "SUCCEEDED");
    assert.deepEqual(log, ["start T1", "end T1", "start T2", "end T2"]);
  } finally {
    f.close();
  }
});

test("F6: a run cancelled while it waits its turn never launches", async () => {
  // The lease outlasts the running run, so a slow test machine can't expire it.
  const f = setup({
    leaseMs: 600,
    serial: true,
    policy: () => policy(),
    tasks: [task("T1"), task("T2")],
  });
  try {
    const log: string[] = [];
    const a1 = f.c.reserve("T1", { requestKey: "k1" }, f.actor);
    const a2 = f.c.reserve("T2", { requestKey: "k2" }, f.actor);
    const first = f.c.execute(a1, slow(300, log), f.actor);
    const second = f.c.execute(a2, slow(300, log), f.actor);
    f.c.cancel(a2.id, f.actor);
    await assert.rejects(second, /LEASE_NOT_OWNED|CANCELLATION_REQUESTED/);
    assert.equal((await first).status, "SUCCEEDED");
    assert.deepEqual(log, ["start T1", "end T1"]);
  } finally {
    f.close();
  }
});

test("F19: reservations last minutes by default, and a slow check can't expire a lease during a heartbeat", () => {
  const f = setup({ policy: () => policy() });
  try {
    const a = f.c.reserve("T", { requestKey: "k" }, f.actor);
    assert.ok(a.leaseUntil - Date.now() > 4 * 60_000);
  } finally {
    f.close();
  }
  const g = setup({ leaseMs: 200, policy: () => policy() });
  try {
    const a = g.c.reserve("T", { requestKey: "k" }, g.actor);
    const c = g.c as unknown as { executionReady: (t: unknown) => boolean };
    const ready = c.executionReady.bind(g.c);
    // A check slower than the whole lease.
    c.executionReady = (t) => {
      const end = Date.now() + 300;
      while (Date.now() < end);
      return ready(t);
    };
    g.c.heartbeat(a.id, a.leaseOwner);
    assert.ok(g.c.inspect("T").attempts[0].leaseUntil > Date.now());
  } finally {
    g.close();
  }
});

test("F17: long diagnostic output keeps its start and end in whole lines; short output is kept exactly", () => {
  const lines = Array.from(
    { length: 2_000 },
    (_, i) =>
      JSON.stringify({
        type: i === 0 ? "thread.started" : i === 1_999 ? "turn.completed" : "item",
        n: i,
      }) + "\n",
  );
  const all = lines.join("");
  const capture = new Capture(4_096);
  for (let i = 0; i < all.length; i += 777)
    capture.add(Buffer.from(all.slice(i, i + 777)));
  const kept = capture.text();
  assert.ok(Buffer.byteLength(kept) <= 4_096);
  // Half the room for the start, half for the end; the rest was dropped.
  assert.equal(capture.dropped, all.length - 4_096);
  const events = kept
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0].type, "thread.started");
  assert.equal(events.at(-1).type, "turn.completed");
  const small = new Capture(4_096);
  small.add(Buffer.from("a\nb"));
  assert.equal(small.text(), "a\nb");
  assert.equal(small.dropped, 0);
});

// Regressions for the independent review of these fixes (round 1).

test("R1: a run that gives up waiting leaves the queue intact for later runs", async () => {
  // The lease outlasts the running run, so a slow test machine can't expire it.
  const f = setup({
    leaseMs: 600,
    serial: true,
    policy: () => policy(),
    tasks: [task("T1"), task("T2"), task("T3")],
  });
  try {
    const log: string[] = [];
    const a1 = f.c.reserve("T1", { requestKey: "k1" }, f.actor);
    const a2 = f.c.reserve("T2", { requestKey: "k2" }, f.actor);
    const first = f.c.execute(a1, slow(400, log), f.actor);
    const second = f.c.execute(a2, slow(300, log), f.actor);
    f.c.cancel(a2.id, f.actor);
    await assert.rejects(second, /LEASE_NOT_OWNED|CANCELLATION_REQUESTED/);
    // The first run is still going, so a run reserved now waits for it.
    const a3 = f.c.reserve("T3", { requestKey: "k3" }, f.actor);
    const third = f.c.execute(a3, slow(50, log), f.actor);
    assert.equal((await first).status, "SUCCEEDED");
    assert.equal((await third).status, "SUCCEEDED");
    assert.deepEqual(log, ["start T1", "end T1", "start T3", "end T3"]);
  } finally {
    f.close();
  }
});

test("R2: long Codex output drops only tool events, so the parsers decide exactly as on the full stream", () => {
  const tool = (i: number) => ({
    type: "item.completed",
    item: { type: "command_execution", aggregated_output: "x".repeat(500) + i },
  });
  const stream = (middle: unknown[]) =>
    [
      { type: "thread.started", thread_id: "t" },
      ...Array.from({ length: 200 }, (_, i) => tool(i)),
      ...middle,
      ...Array.from({ length: 200 }, (_, i) => tool(i)),
      { type: "item.completed", item: { type: "agent_message", text: "OK" } },
      { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } },
    ]
      .map((event) => JSON.stringify(event) + "\n")
      .join("");
  const kept = (text: string, budget = 4_096, chunk = 1_000) => {
    const capture = new EventCapture(budget, true);
    for (let i = 0; i < text.length; i += chunk)
      capture.add(Buffer.from(text.slice(i, i + chunk)));
    return capture;
  };
  const outcome = (text: string) => {
    try {
      return normalizeCliResponse("codex", text);
    } catch (error) {
      return (error as Error).message;
    }
  };
  // A clean run: the same answer, with the bulk gone.
  const clean = stream([]);
  assert.equal(outcome(clean), "OK");
  const trimmed = kept(clean);
  assert.equal(trimmed.incomplete, false);
  assert.ok(trimmed.dropped > 150_000);
  assert.equal(outcome(trimmed.text()), "OK");
  assert.equal(inspectCliOutput("codex", trimmed.text(), "m").tokens, 10);
  // Whatever the parsers act on in the middle is kept: the verdict doesn't change.
  for (const middle of [
    [{ type: "error", message: "boom" }],
    [{ type: "turn.failed" }],
    [{ type: "item.completed", item: { type: "agent_message", text: "another answer" } }],
    [{ type: "item.completed", item: "malformed" }],
    ["not an object"],
  ]) {
    const text = stream(middle);
    assert.notEqual(outcome(text), "OK", JSON.stringify(middle));
    // A budget the first tool event fills, so nothing after it fits by luck.
    assert.equal(outcome(kept(text, 600).text()), outcome(text), JSON.stringify(middle));
  }
  assert.equal(
    inspectCliOutput("codex", kept(stream([{ type: "error" }])).text(), "m").complete,
    false,
  );
  // Lines that must be kept but outgrow four budgets: the output is incomplete.
  const huge = stream([
    { type: "item.completed", item: { type: "agent_message", text: "y".repeat(20_000) } },
  ]);
  assert.equal(kept(huge).incomplete, true); // as a line still arriving
  assert.equal(kept(huge, 4_096, huge.length).incomplete, true); // as a whole line
  // Round 2: one skipped stand-in line takes the place of the dropped ones, so
  // a blank or BOM line, which the parsers reject in the middle of the stream
  // but trim away at its edges, never moves to an edge.
  assert.equal(skippableCodexEvent(DROPPED_CODEX_EVENTS), true);
  const line = (event: unknown) => JSON.stringify(event) + "\n";
  const protocol =
    line({ type: "thread.started", thread_id: "t" }) +
    line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) +
    line({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
  const bulky = line({
    type: "item.completed",
    item: { type: "command_execution", aggregated_output: "x".repeat(2_000) },
  });
  for (const text of [
    protocol + "\n" + bulky,
    bulky + "\n" + protocol,
    protocol + "\uFEFF\n" + bulky,
    bulky + bulky + "\n" + protocol,
  ]) {
    assert.notEqual(outcome(text), "OK", JSON.stringify(text.slice(0, 80)));
    const capture = kept(text, 600);
    assert.ok(capture.dropped >= 2_000);
    assert.equal(outcome(capture.text()), outcome(text));
    assert.equal(
      inspectCliOutput("codex", capture.text(), "m").complete,
      inspectCliOutput("codex", text, "m").complete,
    );
  }
  // A run of dropped events leaves one stand-in line.
  const run = kept(protocol + bulky + bulky + bulky, 600).text();
  assert.equal(run.split(DROPPED_CODEX_EVENTS).length - 1, 1);
  assert.equal(outcome(run), "OK");
});

test("R6: trimming never makes the kept output longer than the whole", () => {
  const line = (event: unknown) => JSON.stringify(event) + "\n";
  // Round 3's case: past the budget, a tool event shorter than the stand-in.
  const full =
    line({ type: "thread.started", thread_id: "t" }) +
    line({ type: "item.completed", item: { type: "agent_message", text: "x".repeat(777) } }) +
    line({ type: "item.completed", item: { type: "command_execution" } }) +
    line({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
  const capture = new EventCapture(768, true);
  capture.add(Buffer.from(full));
  assert.equal(capture.text(), full);
  assert.equal(capture.incomplete, false);
  // Short and long tool events, in runs of every length, at several budgets.
  const tool = (size: number) =>
    line({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(size) } });
  for (const budget of [64, 200, 768, 2_000])
    for (const sizes of [[0], [0, 0], [0, 500], [500, 0], [5, 5, 5], [300, 1, 300], [2_000]]) {
      const text =
        line({ type: "thread.started", thread_id: "t" }) +
        sizes.map(tool).join("") +
        line({ type: "item.completed", item: { type: "agent_message", text: "OK" } }) +
        sizes.map(tool).join("") +
        line({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
      const kept = new EventCapture(budget, true);
      kept.add(Buffer.from(text));
      if (kept.incomplete) continue;
      assert.ok(
        Buffer.byteLength(kept.text()) <= Buffer.byteLength(text),
        JSON.stringify({ budget, sizes }),
      );
      assert.equal(normalizeCliResponse("codex", kept.text()), "OK");
    }
});

test("R5: stdout that isn't a Codex event stream is never filtered, even past the budget", () => {
  // A Claude result split across lines, one of which looks like a Codex event.
  const envelope =
    '{"type":"result","is_error":false,"session_id":"s","result":"' +
    "p".repeat(700) +
    '",\n"structured_output":{"items":[\n' +
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", text: "required evidence" },
    }) +
    "\n]}}\n";
  assert.ok(JSON.parse(envelope));
  const capture = new EventCapture(600);
  capture.add(Buffer.from(envelope));
  assert.equal(capture.text(), envelope);
  assert.equal(capture.dropped, 0);
});

test("R3: a run another model also worked on counts its cache reads at the highest share among them", () => {
  const envelope = (models: string[]) =>
    JSON.stringify({
      type: "result",
      is_error: false,
      session_id: "s",
      usage: {
        input_tokens: 0,
        output_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      },
      modelUsage: Object.fromEntries(models.map((model) => [model, {}])),
    });
  const tokens = (models: string[]) =>
    inspectCliOutput("claude", envelope(models), "claude-fable-5-1").tokens;
  assert.equal(tokens(["claude-fable-5-1"]), 100 + 25_000);
  assert.equal(tokens(["claude-fable-5-1", "claude-opus-5-5"]), 100 + 50_000);
  assert.equal(tokens(["claude-fable-5-1", "claude-opus-4-8"]), 100 + 100_000);
});
