/** Issue #12 T1/T2/T4/T5/Z6: controller admission and real driver recovery. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Controller, type PinnedTaskSelection } from "../src/controller.js";
import { exactRoute, type FailureRecord } from "../src/adaptive.js";
import { canonical, demoTask, digest, reviewPayload, specDigest, type Review } from "../src/domain.js";
import { NO_EXPOSURE } from "../src/evaluation.js";
import { driveRequests } from "../src/driver.js";
import { Orchestrator } from "../src/orchestrator.js";
import { COORDINATION_INSTRUCTION } from "../src/project.js";
import { MockProvider } from "../src/providers.js";
import { type RoutingPolicy } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { adaptivePolicy, overseerOf, pairOf, seedEvidence, simulationRoutes } from "./fixtures/adaptive/evidence.js";

const routes = simulationRoutes();
const pair = (quality: "strong" | "poor") => [
  { arrangement: pairOf(routes, "sol-complex-xhigh-worker", "opus-complex-high-reviewer"), quality },
];
function fixture(guided = false, extraTask = false) {
  const root = mkdtempSync(join(tmpdir(), "adaptive-integration-remed-"));
  const path = join(root, "state.sqlite");
  const db = new SqliteStore(path);
  const { ref } = seedEvidence(db, [
    { key: "general/complex", kind: "PAIR", finalists: pair("strong") },
    { key: "general/complex/bounded", kind: "PAIR", finalists: pair("strong") },
    { key: "oversight/bounded", kind: "OVERSEER", finalists: [
      { arrangement: overseerOf(routes, "opus-xhigh-overseer", "BOUNDED"), quality: "strong" },
      { arrangement: overseerOf(routes, "sol-xhigh-overseer", "BOUNDED"), quality: "fair" },
    ] },
  ]);
  let policy = adaptivePolicy([ref], { assessmentRequired: false, preference: guided ? "GUIDED" : "AUTO" });
  const c = new Controller(db, {
    ownerUid: process.getuid!(), workspaceRoot: join(root, "workspaces"),
    routingPolicyLoader: () => policy, verifyRoutingCapability: () => true,
  });
  const adapters = { codex: new MockProvider(), claude: new MockProvider() };
  const o = new Orchestrator(c, adapters, "operator");
  const id = o.submit({ requestKey: randomUUID(), prompt: "Adaptive integration regression", context: { cwd: root, projectKey: "integration" }, sourceRef: "test:owner" }).request.id;
  c.importTasks(["A", ...(extraTask ? ["B"] : [])].map((id) => demoTask(id, {
    simulation: true,
    ...(id === "B" ? { providers: ["claude"] } : {}),
    budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 0, maxTokens: 100_000 },
  })), c.localActor());
  for (const t of c.tasks()) c.grant(t.id, { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/" + t.id], decisionText: "Simulation", sourceRef: "test:owner" }, c.localActor());
  o.attach(id, c.tasks().map((t) => t.id));
  return { root, path, c, db, o, id, adapters,
    get policy() { return policy; },
    setPolicy(next: RoutingPolicy) { policy = next; },
    contradict() {
      const bad = seedEvidence(db, [
        { key: "general/complex", kind: "PAIR", finalists: pair("poor") },
        { key: "general/complex/bounded", kind: "PAIR", finalists: pair("poor") },
      ], "contradicting-plan");
      policy = { ...policy, adaptive: { ...policy.adaptive!, evaluationPlans: [...policy.adaptive!.evaluationPlans, bad.ref] } };
    },
    close() { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
type Fixture = ReturnType<typeof fixture>;
async function checkpoint(f: Fixture) {
  const a = f.c.reserve("A", { role: "overseer", projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
  const context = a.projectContext!;
  const plan = {
    inputDigest: context.snapshot.inputDigest, summary: "SIMULATION: coordination only", outcome: "CONTINUE",
    assignments: context.snapshot.tasks.map((t) => ({ taskId: t.task.id, instruction: COORDINATION_INSTRUCTION })),
    nextTaskIds: context.snapshot.tasks.map((t) => t.task.id), milestones: [], technicalDecisions: [], risks: [], questionsForOwner: [], questionsForOperator: [],
  };
  const receipt = await f.c.execute(a, new MockProvider({ output: canonical(plan) }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED");
  f.db.transaction(() => f.c.recordProjectCheckpoint(context, a.id, receipt.output));
}
async function work(f: Fixture) {
  const a = f.c.reserve("A", { requestKey: randomUUID(), projectRequestId: f.id }, f.c.localActor());
  const receipt = await f.c.execute(a, new MockProvider({ output: "SIMULATION: original work" }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED");
  return a;
}
async function review(f: Fixture, proposals = false) {
  const a = f.c.reserve("A", { role: "reviewer", requestKey: randomUUID(), projectRequestId: f.id }, f.c.localActor());
  const t = f.c.task("A");
  const evidenceIds = f.c.evidenceFor("A").map((e) => e.id);
  const report: Review = {
    id: "review-" + a.id, taskId: "A", runId: a.id, artifactRevision: t.artifactRevision, specDigest: specDigest(t),
    reviewerSession: "pending", provider: a.provider, authorshipDisclosure: "Independent synthetic review", availableEvidence: evidenceIds,
    findings: [], testsExecuted: [], testsNotExecuted: ["synthetic"], conflictingEvidence: [], remediation: [], residualHolds: [], verdict: "PASS",
    scope: "Simulation", nextAuthorizedStep: "Audit and verify", auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({ kind, result: "PASS", evidenceIds, assessment: "Simulation", limitations: [] })) as Review["auditAssessments"],
    ...(proposals ? { proposals: [{ what: "Change the greeting", why: "Opening text", userImpact: "More welcoming", weight: "IDEA" as const, touchesDecision: false }] } : {}),
  };
  const receipt = await f.c.execute(a, new MockProvider({ output: canonical(reviewPayload(report)) }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED");
  f.c.review({ ...JSON.parse(receipt.output), id: report.id, runId: a.id, reviewerSession: receipt.sessionId }, f.c.localActor());
  return a;
}
function pause(f: Fixture, provider: "codex" | "claude", ms = 10_000) {
  f.db.event("PROVIDER_LIMIT_OBSERVED", null, { provider, kind: "USAGE_LIMIT", until: new Date(Date.now() + ms).toISOString(), validResetAt: new Date(Date.now() + ms - 60_000).toISOString(), observedAt: new Date().toISOString() });
}

test("T1: an unpinned qualified pair waits through the driver and resumes after its provider reset", async (t) => {
  const f = fixture();
  try {
    await checkpoint(f);
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    pause(f, "codex");
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE kind='ADAPTIVE_TASK_PAIR_PINNED'")!.n, 0);
    assert.deepEqual(f.c.adaptivePauseProviders("A"), ["codex"]);
    assert.ok(f.o.inspect(f.id).tasks[0]!.holds.includes("PROVIDER_PAUSED:codex"));
    const waits: number[] = [];
    const result = await driveRequests(f.o, {
      mock: true, requestIds: [f.id], maxMinutes: 2,
      clock: { now: () => Date.now(), sleep: async (ms) => { waits.push(ms); t.mock.timers.tick(ms); } },
    });
    assert.ok(waits.length > 0, "the actual driver waited for the reset");
    assert.ok(f.db.get("SELECT id FROM attempts WHERE task_id='A' AND role='worker' AND state='SUCCEEDED'"), canonical(result));
    assert.equal(f.c.providerPause("codex").state, "CLEAR");
    assert.ok(!result.results.some((r) => r.outcome === "TIME_BUDGET_ENDED"), canonical(result));
  } finally { t.mock.timers.reset(); f.close(); }
});

test("T1 negative: an unrelated pause cannot disguise a permanent independence or evidence hold", async () => {
  const f = fixture(false, true);
  try {
    await checkpoint(f);
    pause(f, "claude");
    assert.deepEqual(f.c.adaptivePauseProviders("B"), []);
    const holds = f.o.inspect(f.id).tasks.find((t) => t.taskId === "B")!.holds;
    assert.ok(!holds.includes("PROVIDER_PAUSED:claude"), canonical(holds));
    assert.ok(holds.some((h) => h.startsWith("ADAPTIVE_")));
    f.contradict();
    assert.deepEqual(f.c.adaptivePauseProviders("A"), []);
  } finally { f.close(); }
});

test("T2: proposal replies probe their worker continuation, and reviewed work advances to verification", async () => {
  const f = fixture();
  try {
    await checkpoint(f); await work(f); const opening = await review(f, true); await checkpoint(f);
    assert.equal(f.c.proposalRound("A")?.stage, "AWAITING_REPLY");
    const card = f.c.adaptiveScorecard("A");
    assert.equal(card.nextStep, "worker");
    assert.equal(card.proposalRound, opening.id);
    assert.equal(card.heldBecause, null, canonical(card));
    assert.equal(f.c.admissionRefusal("A", { role: "worker", proposalRound: opening.id, projectRequestId: f.id }), undefined);
  } finally { f.close(); }
  const g = fixture();
  try {
    await checkpoint(g); await work(g); await review(g);
    const card = g.c.adaptiveScorecard("A");
    assert.equal(card.nextStep, "verify");
    assert.doesNotMatch(canonical(card.heldBecause), /REVIEW_ALREADY_RECORDED_FOR_ARTIFACT/);
  } finally { g.close(); }
});

test("T4: a paused immutable checkpoint pin is displayed without recommending a substitute", async () => {
  const f = fixture();
  try {
    const a = f.c.reserve("A", { role: "overseer", projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(a.provider, "claude");
    await f.c.execute(a, new MockProvider({ outcome: "failure", limit: { kind: "USAGE_LIMIT", evidence: "test:limit", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), resetBasis: "STRUCTURED", message: "Usage limit" } }), f.c.localActor());
    const card = f.c.checkpointScorecard(f.id);
    assert.equal(card.labels.pinned, true);
    assert.equal(card.labels.recommended, false);
    assert.equal(card.overseerNow, "opus-xhigh-overseer");
    assert.match(canonical(card.heldBecause), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE/);
    assert.throws(() => f.c.reserve("A", { role: "overseer", projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor()), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE/);
  } finally { f.close(); }
});

test("T5: lapsed evidence on a GUIDED proposal reply asks one owner question through the workflow", async () => {
  const f = fixture(true);
  try {
    await checkpoint(f); await work(f); await review(f, true); await checkpoint(f);
    f.contradict();
    await (f.o as any).answerProposals(f.id, "A", false);
    await assert.rejects(() => (f.o as any).answerProposals(f.id, "A", false), /REQUEST_HAS_OPEN_QUESTIONS/);
    const questions = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r) => JSON.parse(r.body).question).filter((q) => q.key.startsWith("adaptive-routing:"));
    assert.equal(questions.length, 1, canonical(f.o.inspect(f.id).tasks));
    assert.match(questions[0].text, /no longer have qualifying evaluation evidence/);
    assert.equal(f.c.proposalRound("A")?.stage, "AWAITING_REPLY");
  } finally { f.close(); }
});

test("Z6: wrapped adaptive holds and missing runtime metadata renew the relevant exact capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "adaptive-attestation-remed-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const liveRoutes = routes.map((r) => ({ ...r, simulation: false, capability: {
    provider: r.provider, model: r.model, effort: r.effort,
    verifiedAt: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString(),
    evidenceRef: "test:capability", cliVersion: "test-cli",
  } }));
  let policy = adaptivePolicy([{ id: "unimported-plan", digest: "a".repeat(64) }], { routes: liveRoutes, assessmentRequired: false });
  const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "ws"), allowRealLocalTasks: true, routingPolicyLoader: () => policy, verifyRoutingCapability: () => true });
  const attested: string[] = [];
  const o = new Orchestrator(c, {}, "operator", { attest: async (routeId) => {
    attested.push(routeId);
    policy = { ...policy, routes: policy.routes.map((r) => r.id === routeId ? { ...r, capability: { ...r.capability!, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cliVersion: "renewed-cli" } } : r) };
  } });
  try {
    c.importTasks([demoTask("A", { simulation: false, budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 } })], c.localActor());
    const before = c.route("A", "worker");
    assert.equal(before.ok, false);
    assert.match(canonical(before.reasons), /ADAPTIVE_NO_ELIGIBLE_WORKER/);
    await (o as any).ensureAttested("A", "worker");
    assert.ok(attested.includes("sol-complex-xhigh-worker"));
    assert.ok(attested.includes("opus-complex-high-reviewer"));
    assert.ok(!attested.includes("sol-expert-max-worker"), "a different tier is not refreshed");
    attested.length = 0;
    policy = { ...policy, routes: policy.routes.map((r) => r.id === "sol-complex-xhigh-worker" ? { ...r, capability: { ...r.capability!, cliVersion: undefined } } : r) };
    await (o as any).ensureAttested("A", "worker");
    assert.deepEqual(attested, ["sol-complex-xhigh-worker"]);
    assert.equal(c.route("A", "worker").ok, false, "renewal cannot invent genuine evaluation evidence");
    assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

/**
 * Projection/hook boundary fixture: only the persisted pin/history reads are
 * supplied. Routing, escalation, capability checks, ensureAttested and evidence
 * admission remain real; the hook body renews an in-memory policy. No live
 * qualification, pin or run is fabricated.
 */
function escalationAttestationFixture(t: import("node:test").TestContext, tier: "COMPLEX" | "EXPERT") {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const root = mkdtempSync(join(tmpdir(), "adaptive-escalation-attestation-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const capability = (r: RoutingPolicy["routes"][number], fresh = false) => ({
    provider: r.provider, model: r.model, effort: r.effort,
    verifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + (fresh ? 3_600_000 : -1_000)).toISOString(),
    evidenceRef: "test:capability", cliVersion: "test-cli",
  });
  let policy = adaptivePolicy([{ id: "unimported-plan", digest: "a".repeat(64) }], { assessmentRequired: false, routes: routes.map((r) => ({
    ...r, simulation: false, capability: capability(r),
  })) });
  const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "ws"),
    allowRealLocalTasks: true, routingPolicyLoader: () => policy, verifyRoutingCapability: () => true });
  c.importTasks([demoTask("A", { simulation: false,
    budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 } })], c.localActor());
  const route = (id: string) => policy.routes.find((r) => r.id === id)!;
  const worker = route(tier === "COMPLEX" ? "sol-complex-xhigh-worker" : "opus-expert-xhigh-worker");
  const reviewer = route(tier === "COMPLEX" ? "opus-complex-high-reviewer" : "sol-expert-max-reviewer");
  const targets = tier === "COMPLEX"
    ? ["sol-expert-max-worker", "opus-expert-xhigh-reviewer"]
    : ["opus-expert-max-worker", "sol-expert-max-reviewer"];
  const pin: PinnedTaskSelection = {
    version: 1, selectionId: "test-existing-pin", taskId: "A", specDigest: specDigest(c.task("A")),
    workflow: "CAPABILITY_BIDIRECTIONAL_V1", policyId: policy.id, policyDigest: digest(policy),
    revision: 1, reason: "INITIAL", previousSelectionId: null, tier,
    classKey: "general/" + tier.toLowerCase(), boundedLowStakes: false,
    worker: exactRoute(worker, "worker"), reviewer: exactRoute(reviewer, "reviewer"),
    assessment: { level: tier, confidence: "HEURISTIC", reasons: ["Fixture's existing selection"] },
    context: NO_EXPOSURE, oversight: { checkpointRunId: null, mode: "NONE" }, evidence: [],
    assessmentRunId: null, lineage: { providers: [], digest: digest([]) },
    preference: { mode: "AUTO", eventSeq: null }, ceiling: null, trigger: null,
    exclusions: [], rationale: [], at: new Date().toISOString(), actor: "test:owner",
  };
  let history: FailureRecord[] = [1, 2].map((i) => ({ reviewRunId: "failed-review-" + i, tier,
    provider: worker.provider, model: worker.model, effort: worker.effort, consumed: false }));
  let currentPin: PinnedTaskSelection | undefined = pin;
  // Explicit read seams: the test does not append a forged live qualification.
  t.mock.method(c as any, "latestPin", () => currentPin);
  t.mock.method(c as any, "adaptiveFailureHistory", () => history);
  const attested: string[] = [];
  const o = new Orchestrator(c, {}, "operator", { attest: async (id) => {
    attested.push(id);
    policy = { ...policy, routes: policy.routes.map((r) => r.id === id ? { ...r, capability: capability(r, true) } : r) };
  } });
  return { db, c, o, pin, targets, attested,
    get policy() { return policy; }, setPolicy(p: RoutingPolicy) { policy = p; },
    setPin(p: PinnedTaskSelection | undefined) { currentPin = p; },
    get history() { return history; }, setHistory(h: FailureRecord[]) { history = h; },
    capability, close() { db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const tier of ["COMPLEX", "EXPERT"] as const)
for (const condition of ["stale", "missing", "missing runtime"] as const)
test(`escalation attestation: ${tier} refreshes ${condition} target capabilities and preserves evidence holds`, async (t) => {
  const f = escalationAttestationFixture(t, tier);
  try {
    if (condition !== "stale") f.setPolicy({ ...f.policy, routes: f.policy.routes.map((r) =>
      !f.targets.includes(r.id) ? r : { ...r, capability: condition === "missing"
        ? undefined : { ...f.capability(r, true), cliVersion: undefined } }) });
    const before = canonical(f.db.all("SELECT * FROM events ORDER BY seq"));
    const pinBefore = canonical(f.pin);
    const held = f.c.route("A", "worker");
    assert.equal(held.ok, false);
    assert.match(canonical(held.reasons), condition === "missing runtime"
      ? /ADAPTIVE_ESCALATION_UNQUALIFIED/ : /ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE/);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker"), f.targets);
    await (f.o as any).ensureAttested("A", "worker");
    assert.deepEqual(f.attested, f.targets, "renew the impending pair, not the old routes or another provider");
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker"), []);
    const after = f.c.route("A", "worker");
    assert.equal(after.ok, false, "capability renewal cannot create qualification evidence");
    assert.match(canonical(after.reasons), /ADAPTIVE_ESCALATION_UNQUALIFIED/);
    assert.equal(canonical(f.pin), pinBefore, "refresh does not revise the pin");
    assert.equal(canonical(f.db.all("SELECT * FROM events ORDER BY seq")), before);
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n, 0);
  } finally { f.close(); }
});

test("escalation attestation: trigger, role and static exclusions preserve the required pair", (t) => {
  const f = escalationAttestationFixture(t, "COMPLEX");
  try {
    const original = f.policy, failures = f.history;
    const oldPair = [f.pin.worker.routeId, f.pin.reviewer.routeId];
    const before = canonical(f.db.all("SELECT * FROM events ORDER BY seq"));
    for (const history of [[], failures.slice(0, 1), failures.map((r) => ({ ...r, consumed: true }))]) {
      f.setHistory(history);
      assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker"), oldPair);
    }
    f.setHistory(failures);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "reviewer"), oldPair, "reviewer continues under its current pin");
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker", { excludeProviders: ["codex"] }), [f.targets[1]]);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker", { excludeProviders: ["claude", "codex"] }), []);
    for (const absent of [false, true]) {
      f.setPolicy({ ...original, routes: absent
        ? original.routes.filter((r) => r.id !== f.targets[0])
        : original.routes.map((r) => r.id === f.targets[0] ? { ...r, enabled: false } : r) });
      assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "worker"), [], "no substitute or old pair when escalation cannot exist");
      assert.match(canonical(f.c.route("A", "worker").reasons), /ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE/);
    }
    assert.equal(canonical(f.db.all("SELECT * FROM events ORDER BY seq")), before);
    assert.deepEqual(f.attested, []);
  } finally { f.close(); }
});

for (const target of ["astra-advisor-moderator", "sol-complex-xhigh-worker", "opus-complex-high-reviewer"])
for (const condition of ["stale", "missing", "missing runtime"] as const)
test(`advisor attestation: refreshes ${condition} ${target} without granting qualification`, async (t) => {
  const f = escalationAttestationFixture(t, "COMPLEX");
  try {
    f.setPin(undefined); f.setHistory([]);
    f.setPolicy({ ...f.policy, routes: f.policy.routes.map((r) => ({ ...r,
      capability: r.id !== target ? f.capability(r, true)
        : condition === "missing" ? undefined
          : condition === "missing runtime" ? { ...f.capability(r, true), cliVersion: undefined }
            : f.capability(r),
    })) });
    const before = canonical(f.db.all("SELECT * FROM events ORDER BY seq"));
    const held = f.c.route("A", "advisor");
    assert.equal(held.ok, false);
    assert.ok(held.reasons.every((reason) => !/^LIVE_CAPABILITY_/.test(reason)), "the failure is wrapped by adaptive planning");
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), [target]);
    await (f.o as any).ensureAttested("A", "advisor");
    assert.deepEqual(f.attested, [target]);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), []);
    const after = f.c.route("A", "advisor");
    assert.equal(after.ok, false, "renewal cannot invent evidence measured with this advisor's context");
    assert.match(canonical(after.reasons), /ADAPTIVE_EVIDENCE_MISSING/);
    assert.equal(canonical(f.db.all("SELECT * FROM events ORDER BY seq")), before);
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n, 0);
  } finally { f.close(); }
});

test("advisor attestation: a pin refreshes only its exact pair and compatible advisor, without escalation", async (t) => {
  const f = escalationAttestationFixture(t, "COMPLEX");
  try {
    const expected = ["astra-advisor-moderator", f.pin.worker.routeId, f.pin.reviewer.routeId];
    const before = canonical(f.db.all("SELECT * FROM events ORDER BY seq")), pinBefore = canonical(f.pin);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), expected, "even with two failed reviews, advice previews the existing pin");
    await (f.o as any).ensureAttested("A", "advisor");
    assert.deepEqual(f.attested, expected);
    assert.equal(f.c.route("A", "advisor").ok, false);
    assert.equal(canonical(f.pin), pinBefore);
    assert.equal(canonical(f.db.all("SELECT * FROM events ORDER BY seq")), before);
    f.setPolicy({ ...f.policy, routes: f.policy.routes.map((r) => ({ ...r, capability: f.capability(r) })) });
    f.setPin({ ...f.pin,
      worker: exactRoute(f.policy.routes.find((r) => r.id === "opus-complex-xhigh-worker")!, "worker"),
      reviewer: exactRoute(f.policy.routes.find((r) => r.id === "sol-complex-xhigh-reviewer")!, "reviewer"),
    });
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), [], "the advisor cannot be the pinned reviewer's provider");
    f.setPin(f.pin);
    f.setPolicy({ ...f.policy, routes: f.policy.routes.filter((r) => r.id !== f.pin.worker.routeId) });
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), [expected[0], expected[2]], "a removed pin route is never replaced");
    assert.equal(f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n, 0);
  } finally { f.close(); }
});

test("advisor attestation: role, provider, simulation, floor and quarantine exclusions remain effective", (t) => {
  const f = escalationAttestationFixture(t, "COMPLEX");
  try {
    f.setPin(undefined); f.setHistory([]);
    const original = f.policy;
    const expected = ["astra-advisor-moderator", "sol-complex-xhigh-worker", "sol-complex-max-worker",
      "opus-complex-high-reviewer", "opus-complex-xhigh-reviewer", "opus-complex-max-reviewer"];
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), expected);
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor", { excludeProviders: ["codex"] }), expected.slice(3));
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor", { excludeProviders: ["codex", "claude"] }), []);
    for (const change of [{ enabled: false }, { simulation: true }, { roles: ["moderator"] }, { model: "claude-fable-5" }]) {
      f.setPolicy({ ...original, routes: original.routes.map((r) => r.roles.includes("advisor") ? { ...r, ...change } : r) } as RoutingPolicy);
      assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), [], "no preview pair without an eligible advisor");
    }
    f.setPolicy({ ...original, routes: original.routes.map((r) => r.id === expected[1] ? { ...r, effort: "high" } : r) });
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), expected.filter((id) => id !== expected[1]), "below-floor workers are not refreshed");
    f.setPolicy(original);
    f.c.importTasks([demoTask("B", { simulation: false, providers: ["claude"],
      budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 } })], f.c.localActor());
    assert.deepEqual(f.c.adaptiveAttestationRoutes("B", "advisor"), [], "the task excludes the listed advisor's provider");
    f.setPolicy({ ...original, workflow: "ASTRA_TWO_TIER" });
    assert.deepEqual(f.c.adaptiveAttestationRoutes("A", "advisor"), [], "the existing installation workflow is unchanged");
  } finally { f.close(); }
});

test("T6: simultaneous controllers in separate processes ask a GUIDED routing question once across requests", async () => {
  const f = fixture(true);
  const exec = promisify(execFile);
  try {
    const other = f.o.submit({ requestKey: randomUUID(), prompt: "Another request for the same project", context: { cwd: f.root, projectKey: "integration" }, sourceRef: "test:owner" }).request.id;
    f.o.attach(other, ["A"]);
    f.contradict();
    const resolution = f.c.route("A", "worker");
    assert.equal(resolution.ok, false);
    const error = resolution.reasons.join("|");
    assert.match(error, /ADAPTIVE_EVIDENCE_CONTRADICTORY/);
    const release = join(f.root, "release");
    const source = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      import { Controller } from ${JSON.stringify(new URL("../src/controller.ts", import.meta.url).href)};
      import { Orchestrator } from ${JSON.stringify(new URL("../src/orchestrator.ts", import.meta.url).href)};
      import { SqliteStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      const data = JSON.parse(process.argv[1]);
      const db = new SqliteStore(data.path);
      const c = new Controller(db, { ownerUid: process.getuid(), workspaceRoot: data.workspaceRoot, routingPolicy: data.policy, verifyRoutingCapability: () => true });
      const o = new Orchestrator(c, {}, 'operator');
      writeFileSync(data.ready, 'ready');
      while (!existsSync(data.release)) await setTimeout(10);
      o.askAdaptiveRouting(data.id, 'A', new Error(data.error));
      db.close();
    `;
    const ready = [join(f.root, "ready-1"), join(f.root, "ready-2")];
    const executions = [f.id, other].map((id, index) => exec(process.execPath, ["--import", "tsx", "--input-type", "module", "-e", source,
      JSON.stringify({ path: f.path, workspaceRoot: join(f.root, "workspaces"), policy: f.policy, id, error, ready: ready[index], release })],
      { timeout: 20_000, maxBuffer: 1_000_000 }).then(() => null, (error) => error));
    for (let i = 0; i < 500 && !ready.every(existsSync); i++) await delay(10);
    const bothReady = ready.every(existsSync);
    writeFileSync(release, "release");
    const errors = (await Promise.all(executions)).filter(Boolean);
    assert.ok(bothReady, "both independent processes reached the contention barrier");
    assert.deepEqual(errors.map(String), []);
    const questions = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r) => JSON.parse(r.body).question).filter((q) => q.key.startsWith("adaptive-routing:"));
    assert.equal(questions.length, 1);
  } finally { f.close(); }
});
