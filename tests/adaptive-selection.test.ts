/**
 * Issue #12, slice E3: deterministic selection over evidence (contract
 * sections 4, 6, 7.3 and 8). Pure functions over seeded synthetic evidence,
 * which qualifies simulation routes only. Scenario IDs identify synthetic regression cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDemand,
  eliminate,
  escalationDue,
  EvidenceIndex,
  exactRoute,
  planEscalation,
  routeExclusion,
  selectCoordinationOverseer,
  selectPair,
  type Availability,
  type DemandFacts,
  type FailureRecord,
  type PairFacts,
  type PinRevisionCore,
} from "../src/adaptive.js";
import { randomUUID } from "node:crypto";
import { digest } from "../src/domain.js";
import {
  ADAPTIVE_PROTOCOL_VERSION,
  arrangementId,
  candidateIdentity,
  EvaluationPlanSchema,
  freezePlan,
  importEvidence,
  NO_EXPOSURE,
  planDigest,
  type Arrangement,
} from "../src/evaluation.js";
import type { RoutingPolicy } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import {
  adaptivePolicy,
  example,
  overseerOf,
  pairOf,
  seedEvidence,
  simulationRoutes,
  type Quality,
} from "./fixtures/adaptive/evidence.js";

type R = ReturnType<typeof simulationRoutes>[number];
const none: Availability = () => undefined;
/** A listed plan that was never frozen here: no evidence at all. */
const UNFROZEN = [{ id: "unfrozen-plan", digest: "0".repeat(64) }];
const DAY = 86_400_000;
const solHighWorker = {
  id: "sol-complex-high-worker",
  level: "COMPLEX",
  provider: "codex",
  model: "gpt-6.1-sol",
  effort: "high",
  roles: ["worker"],
  simulation: false,
  enabled: true,
};
const solHighOverseer = {
  id: "sol-high-overseer",
  level: "COMPLEX",
  provider: "codex",
  model: "gpt-6.1-sol",
  effort: "high",
  roles: ["overseer"],
  simulation: false,
  enabled: true,
  demands: ["BOUNDED", "MODULE"],
};
const exception = (role: "worker" | "overseer", planId = "test-plan") => ({
  id: "floor-exception-" + role,
  provider: "codex",
  role,
  effort: "high",
  scope: role === "overseer" ? "BOUNDED_OVERSIGHT" : "BOUNDED_LOW_STAKES",
  approvalRef: "test:separately-approved-floor-rule",
  evaluationPlanId: planId,
});

function store() {
  const root = mkdtempSync(join(tmpdir(), "adaptive-selection-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  return {
    db,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const facts = (over: Partial<PairFacts> = {}): PairFacts => ({
  taskId: "T",
  providers: ["codex", "claude"],
  simulation: true,
  tier: "COMPLEX",
  boundedLowStakes: false,
  classKey: "general/complex",
  authorship: { providers: [], unknown: false },
  context: NO_EXPOSURE,
  history: [],
  ceiling: { used: 0, allowed: 1 },
  preference: { mode: "AUTO" },
  ...over,
});
type Finalist = [worker: string, reviewer: string, quality: Quality];
/** Seed one pair class with these finalists, then select under that evidence. */
function select(
  finalists: Finalist[],
  over: Partial<PairFacts> = {},
  options: {
    extra?: R[];
    routes?: (all: R[]) => R[];
    floorExceptions?: unknown[];
    available?: Availability;
    now?: number;
    evidenceClass?: string;
  } = {},
) {
  const s = store();
  try {
    const all = simulationRoutes(options.extra ?? []);
    const { ref } = seedEvidence(s.db, [
      {
        key: options.evidenceClass ?? over.classKey ?? "general/complex",
        kind: "PAIR",
        finalists: finalists.map(([w, r, quality]) => ({ arrangement: pairOf(all, w, r), quality })),
      },
    ]);
    const policy = adaptivePolicy([ref], {
      routes: options.routes ? options.routes(all) : all,
      floorExceptions: options.floorExceptions ?? [],
    });
    return selectPair(
      facts(over),
      policy,
      policy.adaptive!,
      options.available ?? none,
      () => undefined,
      new EvidenceIndex(s.db, policy.adaptive!, options.now ?? Date.now()),
    );
  } finally {
    s.close();
  }
}
const pick = (s: ReturnType<typeof selectPair>) => {
  assert.ok(s.ok, s.ok ? "" : s.code + ": " + s.reasons.join("; "));
  return [s.worker.id, s.reviewer.id];
};

test("SEL-02/SEL-03: the evidence decides the provider, whichever way it points", () => {
  const opus = select([
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "strong"],
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair"],
  ]);
  assert.deepEqual(pick(opus), ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer"]);
  const sol = select([
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "fair"],
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
  ]);
  assert.deepEqual(pick(sol), ["sol-complex-xhigh-worker", "opus-complex-high-reviewer"]);
  assert.ok(sol.ok && sol.trace.includes("final-correct rate: removed 1 of 2"), canonicalTrace(sol));
  // Every candidate pairs a worker with a reviewer from the other provider.
  for (const c of sol.candidates) assert.notEqual(c.worker.provider, c.reviewer.provider);
});
const canonicalTrace = (s: ReturnType<typeof selectPair>) => (s.ok ? s.trace.join("; ") : s.reasons.join("; "));

test("SEL-04: the exact model and effort measured is selected; Max wins only on evidence", () => {
  assert.deepEqual(
    pick(
      select([
        ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair"],
        ["sol-complex-max-worker", "opus-complex-high-reviewer", "strong"],
      ]),
    ),
    ["sol-complex-max-worker", "opus-complex-high-reviewer"],
  );
  assert.deepEqual(
    pick(
      select([
        ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
        ["sol-complex-max-worker", "opus-complex-high-reviewer", "fair"],
      ]),
    ),
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer"],
  );
  // An eligible Max route without its own evidence is never chosen.
  const only = select([["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair"]]);
  assert.deepEqual(pick(only), ["sol-complex-xhigh-worker", "opus-complex-high-reviewer"]);
  assert.ok(
    only.candidates.some(
      (c) => c.worker.id === "sol-complex-max-worker" && c.match.decision === "MISSING",
    ),
  );
});

test("SEL-05/SEL-01: High below the floor is excluded unless a floor exception and its own plan qualify the pair", () => {
  const finalists: Finalist[] = [["sol-complex-high-worker", "opus-complex-high-reviewer", "strong"]];
  const bounded = { boundedLowStakes: true, classKey: "general/complex/bounded" };
  // No exception: the High route is excluded and nothing else has evidence.
  const refused = select(finalists, bounded, { extra: [solHighWorker] });
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.code === "ADAPTIVE_EVIDENCE_MISSING");
  assert.ok(
    refused.exclusions.some(
      (e) => e.routeId === "sol-complex-high-worker" && e.reason === "EFFORT_BELOW_FLOOR",
    ),
  );
  // A separately approved, versioned exception whose plan qualifies the pair.
  assert.deepEqual(
    pick(select(finalists, bounded, { extra: [solHighWorker], floorExceptions: [exception("worker")] })),
    ["sol-complex-high-worker", "opus-complex-high-reviewer"],
  );
  // The exception never applies outside bounded low-stakes work...
  const unbounded = select(finalists, { classKey: "general/complex/bounded" }, {
    extra: [solHighWorker],
    floorExceptions: [exception("worker")],
  });
  assert.ok(
    !unbounded.ok &&
      unbounded.exclusions.some((e) => e.routeId === "sol-complex-high-worker" && e.reason === "EFFORT_BELOW_FLOOR"),
  );
  // ...nor on another plan's evidence.
  const otherPlan = select(finalists, bounded, {
    extra: [solHighWorker],
    floorExceptions: [exception("worker", "another-plan")],
  });
  assert.ok(!otherPlan.ok && otherPlan.code === "ADAPTIVE_EVIDENCE_MISSING", canonicalTrace(otherPlan));
  assert.ok(
    !otherPlan.ok && otherPlan.reasons.some((r) => /below the xhigh floor/.test(r)),
    canonicalTrace(otherPlan),
  );
});

test("SEL-06: missing, stale, contradicted or synthetic-for-live evidence holds, and nothing falls back", () => {
  const strong: Finalist[] = [["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"]];
  // No listed plan covers the class.
  const missing = select(strong, { tier: "EXPERT", classKey: "general/expert" }, { evidenceClass: "general/complex" });
  assert.ok(!missing.ok && missing.code === "ADAPTIVE_EVIDENCE_MISSING");
  assert.match(!missing.ok ? missing.reasons.join("|") : "", /never falls back to the fixed pairing/);
  // Evidence older than the policy's limit.
  const stale = select(strong, {}, { now: Date.now() + 100 * DAY });
  assert.ok(!stale.ok && stale.code === "ADAPTIVE_EVIDENCE_MISSING");
  assert.match(!stale.ok ? stale.reasons.join("|") : "", /STALE \(Evidence is (99|100) days old, beyond 90\)/);
  // Two listed plans disagree about the same arrangement.
  const s = store();
  try {
    const all = simulationRoutes();
    const arrangement = pairOf(all, "sol-complex-xhigh-worker", "opus-complex-high-reviewer");
    const a = seedEvidence(s.db, [{ key: "general/complex", kind: "PAIR", finalists: [{ arrangement, quality: "strong" }] }], "plan-a");
    const b = seedEvidence(s.db, [{ key: "general/complex", kind: "PAIR", finalists: [{ arrangement, quality: "poor" }] }], "plan-b");
    const run = (plans: Array<{ id: string; digest: string }>) => {
      const policy = adaptivePolicy(plans);
      return selectPair(facts(), policy, policy.adaptive!, none, () => undefined, new EvidenceIndex(s.db, policy.adaptive!, Date.now()));
    };
    const contradicted = run([a.ref, b.ref]);
    assert.ok(!contradicted.ok && contradicted.code === "ADAPTIVE_EVIDENCE_CONTRADICTORY", canonicalTrace(contradicted));
    // The first listed plan governs: listed first, plan B's failure is the answer.
    const governed = run([b.ref, a.ref]);
    assert.ok(!governed.ok && governed.code === "ADAPTIVE_EVIDENCE_MISSING");
    assert.match(!governed.ok ? governed.reasons.join("|") : "", /FAILED/);
    // An unlisted plan is ignored.
    assert.ok(run([a.ref]).ok);
  } finally {
    s.close();
  }
  // Synthetic evidence never qualifies a live task.
  const live = store();
  try {
    const runtime = { cliVersion: "cli 1.0.0", executableDigest: null };
    const routes: R[] = example().routes;
    const route = (id: string) => routes.find((r) => r.id === id)!;
    const arrangement: Arrangement = {
      kind: "PAIR",
      worker: candidateIdentity(route("sol-complex-xhigh-worker"), "worker", runtime),
      reviewer: candidateIdentity(route("opus-complex-high-reviewer"), "reviewer", runtime),
      protocolVersion: ADAPTIVE_PROTOCOL_VERSION,
      context: NO_EXPOSURE,
    };
    const { ref } = seedEvidence(live.db, [{ key: "general/complex", kind: "PAIR", finalists: [{ arrangement, quality: "strong" }] }]);
    const policy = adaptivePolicy([ref], { routes });
    const index = new EvidenceIndex(live.db, policy.adaptive!, Date.now());
    const liveTask = selectPair(facts({ simulation: false }), policy, policy.adaptive!, none, () => runtime, index);
    assert.ok(!liveTask.ok && liveTask.code === "ADAPTIVE_EVIDENCE_MISSING");
    assert.match(!liveTask.ok ? liveTask.reasons.join("|") : "", /No non-synthetic evidence/);
    // The same identities without an attested runtime are never matched.
    const unattested = selectPair(facts({ simulation: false }), policy, policy.adaptive!, none, () => undefined, index);
    assert.ok(!unattested.ok && unattested.code === "ADAPTIVE_EVIDENCE_MISSING");
    assert.match(!unattested.ok ? unattested.reasons.join("|") : "", /not attested/);
  } finally {
    live.close();
  }
});

test("SEL-07: indistinguishable qualified pairs go to the stable route-ID order, whatever the policy's order", () => {
  const finalists: Finalist[] = [
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "good"],
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "strong"],
  ];
  const forward = select(finalists);
  const reversed = select(finalists, {}, { routes: (all) => [...all].reverse() });
  assert.deepEqual(pick(forward), ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer"]);
  assert.deepEqual(pick(reversed), pick(forward));
  // Nothing was conclusively worse, so nothing was removed.
  assert.ok(forward.ok && forward.trace.length === 0, canonicalTrace(forward));
});

test("SEL-09: an owner's pinned route never waives a floor, evidence or independence; a qualified pin is honoured", () => {
  const finalists: Finalist[] = [
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "fair"],
  ];
  const pinned = (workerRouteId: string, reviewerRouteId?: string) =>
    select(finalists, { preference: { mode: "PINNED", workerRouteId, ...(reviewerRouteId ? { reviewerRouteId } : {}) } }, { extra: [solHighWorker] });
  const belowFloor = pinned("sol-complex-high-worker");
  assert.ok(!belowFloor.ok && belowFloor.code === "ADAPTIVE_PINNED_PREFERENCE_REFUSED");
  assert.match(!belowFloor.ok ? belowFloor.reasons.join("|") : "", /sol-complex-high-worker: EFFORT_BELOW_FLOOR/);
  assert.match(!belowFloor.ok ? belowFloor.reasons[0]! : "", /cannot waive floors, attestation, evidence or independence/);
  // A same-provider reviewer is never a candidate.
  const sameProvider = pinned("opus-complex-xhigh-worker", "opus-complex-high-reviewer");
  assert.ok(!sameProvider.ok && sameProvider.code === "ADAPTIVE_PINNED_PREFERENCE_REFUSED");
  // An eligible pair without evidence is refused.
  const unmeasured = pinned("sol-complex-max-worker");
  assert.ok(!unmeasured.ok && unmeasured.code === "ADAPTIVE_PINNED_PREFERENCE_REFUSED");
  // A qualified, independent pair is honoured even when it is not the best.
  assert.deepEqual(pick(pinned("opus-complex-xhigh-worker")), ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer"]);
});

test("SEL-10: with no eligible independent reviewer there is no selection at all", () => {
  const finalists: Finalist[] = [
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "fair"],
  ];
  const codexOnly = select(finalists, { providers: ["codex"] });
  assert.ok(!codexOnly.ok && codexOnly.code === "ADAPTIVE_NO_INDEPENDENT_REVIEWER");
  assert.ok(
    !codexOnly.ok &&
      codexOnly.exclusions.some((e) => e.routeId === "opus-complex-high-reviewer" && e.reason === "PROVIDER_NOT_IN_TASK"),
  );
  // Work Claude already shaped stays with Claude and is reviewed by Codex,
  // although the evidence prefers the Codex worker.
  assert.deepEqual(pick(select(finalists, { authorship: { providers: ["claude"], unknown: false } })), [
    "opus-complex-xhigh-worker",
    "sol-complex-xhigh-reviewer",
  ]);
  const both = select(finalists, { authorship: { providers: ["claude", "codex"], unknown: false } });
  assert.ok(!both.ok && both.code === "ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED");
  const unknown = select(finalists, { authorship: { providers: [], unknown: true } });
  assert.ok(!unknown.ok && unknown.code === "ADAPTIVE_AUTHORSHIP_UNKNOWN");
});

test("SEL-11: a route without access is excluded before any run", () => {
  const finalists: Finalist[] = [
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "strong"],
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair"],
  ];
  const s = select(finalists, {}, {
    available: (route) =>
      route.id === "opus-complex-xhigh-worker" ? "LIVE_CAPABILITY_MISSING: opus-complex-xhigh-worker" : undefined,
  });
  assert.deepEqual(pick(s), ["sol-complex-xhigh-worker", "opus-complex-high-reviewer"]);
  assert.ok(
    s.ok &&
      s.exclusions.some(
        (e) => e.routeId === "opus-complex-xhigh-worker" && e.reason === "LIVE_CAPABILITY_MISSING: opus-complex-xhigh-worker",
      ),
  );
});

test("route exclusions: role, simulation, provider, disabled, Fable and tier", () => {
  const routes = simulationRoutes();
  const route = (id: string) => routes.find((r) => r.id === id)!;
  const policy = adaptivePolicy(UNFROZEN);
  const f = { simulation: true, providers: ["codex", "claude"], tier: "COMPLEX" as const };
  const why = (r: R, role: "worker" | "reviewer" | "overseer" = "worker", over = {}) =>
    routeExclusion(r, role, { ...f, ...over }, policy.adaptive!, none);
  assert.equal(why(route("sol-complex-xhigh-worker")), undefined);
  assert.equal(why(route("sol-complex-xhigh-worker"), "reviewer"), "ROLE");
  assert.equal(why(route("sol-complex-xhigh-worker"), "worker", { simulation: false }), "SIMULATION_MISMATCH");
  assert.equal(why(route("sol-complex-xhigh-worker"), "worker", { providers: ["claude"] }), "PROVIDER_NOT_IN_TASK");
  assert.equal(why({ ...route("sol-complex-xhigh-worker"), enabled: false }), "ROUTE_DISABLED");
  assert.equal(why({ ...route("opus-complex-xhigh-worker"), model: "claude-fable-5-1" }), "FABLE_QUARANTINED");
  assert.equal(why(route("sol-complex-xhigh-worker"), "worker", { tier: "EXPERT" }), "TIER_MISMATCH");
  assert.equal(why(route("sol-xhigh-overseer"), "overseer", { tier: "EXPERT" }), undefined);
});

const exact = (routes: R[], worker: string, reviewer: string, tier: "COMPLEX" | "EXPERT"): PinRevisionCore => ({
  tier,
  worker: exactRoute(routes.find((r) => r.id === worker)!, "worker"),
  reviewer: exactRoute(routes.find((r) => r.id === reviewer)!, "reviewer"),
});
const failure = (n: number, tier: string, provider: string, model: string, effort: string, consumed = false): FailureRecord => ({
  reviewRunId: "review-" + n,
  tier,
  provider,
  model,
  effort,
  consumed,
});

test("DUR-10: two failed reviews at Complex move the pin to Expert, the worker one effort up and the reviewer to its floor, on the same providers and models", () => {
  const policy = adaptivePolicy(UNFROZEN);
  const routes = policy.routes as R[];
  const facts = { simulation: true, providers: ["codex", "claude"], boundedLowStakes: false };
  const pin = exact(routes, "sol-complex-xhigh-worker", "opus-complex-high-reviewer", "COMPLEX");
  const history = [failure(1, "COMPLEX", "codex", "gpt-6.1-sol", "xhigh"), failure(2, "COMPLEX", "codex", "gpt-6.1-sol", "xhigh")];
  assert.equal(escalationDue(pin, history.slice(0, 1)), undefined);
  const due = escalationDue(pin, history);
  assert.deepEqual(due, { rule: "TIER", trigger: ["review-1", "review-2"] });
  const plan = planEscalation(pin, due!, policy, facts, policy.adaptive!, none);
  assert.ok(plan.ok);
  assert.deepEqual([plan.tier, plan.worker.id, plan.reviewer.id, plan.reason], [
    "EXPERT",
    "sol-expert-max-worker",
    "opus-expert-xhigh-reviewer",
    "EFFORT_ESCALATION",
  ]);
  assert.deepEqual(plan.ceiling, { worker: false, reviewer: false });
  // A revision consumes its trigger: the same failures never fire twice.
  assert.equal(escalationDue(pin, history.map((f) => ({ ...f, consumed: true }))), undefined);
  // At Expert, two failures at the exact effort raise the worker one step;
  // the reviewer stays at least at its floor.
  const expert = exact(routes, "opus-expert-xhigh-worker", "sol-expert-max-reviewer", "EXPERT");
  const exactFailures = [failure(3, "EXPERT", "claude", "claude-opus-5-5", "xhigh"), failure(4, "EXPERT", "claude", "claude-opus-5-5", "xhigh")];
  assert.equal(escalationDue(expert, [exactFailures[0]!, failure(5, "EXPERT", "claude", "claude-opus-5-5", "max")]), undefined);
  const effort = planEscalation(expert, escalationDue(expert, exactFailures)!, policy, facts, policy.adaptive!, none);
  assert.ok(effort.ok);
  assert.deepEqual([effort.worker.id, effort.reviewer.id, effort.reason], [
    "opus-expert-max-worker",
    "sol-expert-max-reviewer",
    "EFFORT_ESCALATION",
  ]);
  assert.deepEqual(effort.ceiling, { worker: false, reviewer: true });
  // No eligible escalated route: a hold, never a weaker or other route.
  const without = adaptivePolicy(UNFROZEN, { routes: simulationRoutes().filter((r) => r.id !== "opus-expert-max-worker") });
  const held = planEscalation(expert, { rule: "EFFORT" }, without, facts, without.adaptive!, none);
  assert.ok(!held.ok && held.code === "ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE");
  const paused = planEscalation(expert, { rule: "EFFORT" }, policy, facts, policy.adaptive!, (r) =>
    r.provider === "claude" ? "PROVIDER_PAUSED:claude" : undefined,
  );
  assert.ok(!paused.ok && paused.code === "ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE");
});

test("DUR-12: at Max the revision is a ceiling continuation, and selection allows only the bounded continuations", () => {
  const policy = adaptivePolicy(UNFROZEN);
  const routes = policy.routes as R[];
  const pin = exact(routes, "sol-expert-max-worker", "opus-expert-xhigh-reviewer", "EXPERT");
  const history = [failure(1, "EXPERT", "codex", "gpt-6.1-sol", "max"), failure(2, "EXPERT", "codex", "gpt-6.1-sol", "max")];
  const plan = planEscalation(pin, escalationDue(pin, history)!, policy, { simulation: true, providers: ["codex", "claude"], boundedLowStakes: false }, policy.adaptive!, none);
  assert.ok(plan.ok);
  assert.deepEqual([plan.worker.id, plan.reviewer.id, plan.reason], [
    "sol-expert-max-worker",
    "opus-expert-xhigh-reviewer",
    "CEILING_CONTINUATION",
  ]);
  assert.deepEqual(plan.ceiling, { worker: true, reviewer: false });
  // A new selection with two failures at Max: one continuation, then none.
  const atMax = [failure(1, "COMPLEX", "codex", "gpt-6.1-sol", "max"), failure(2, "COMPLEX", "codex", "gpt-6.1-sol", "max")];
  const finalists: Finalist[] = [["sol-complex-max-worker", "opus-complex-high-reviewer", "strong"]];
  const continued = select(finalists, { history: atMax, ceiling: { used: 0, allowed: 1 } });
  assert.ok(continued.ok && continued.ceilingContinuation && continued.worker.id === "sol-complex-max-worker");
  const exhausted = select(finalists, { history: atMax, ceiling: { used: 1, allowed: 1 } });
  assert.ok(!exhausted.ok && exhausted.code === "ADAPTIVE_CEILING_EXHAUSTED");
  assert.match(!exhausted.ok ? exhausted.reasons.join("|") : "", /worker sol-complex-max-worker: CEILING_EXHAUSTED/);
  assert.ok(
    !exhausted.ok &&
      exhausted.exclusions.some((e) => e.routeId === "sol-complex-max-worker" && /^CEILING_EXHAUSTED/.test(e.reason)),
  );
  // Below Max the same failures require an escalation, not a repeat.
  const xhigh = select([["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"]], {
    history: [failure(1, "COMPLEX", "codex", "gpt-6.1-sol", "xhigh"), failure(2, "COMPLEX", "codex", "gpt-6.1-sol", "xhigh")],
  });
  assert.ok(
    !xhigh.ok &&
      xhigh.exclusions.some((e) => e.routeId === "sol-complex-xhigh-worker" && /^EFFORT_ESCALATION_REQUIRED/.test(e.reason)),
  );
});

const task = (id: string, over: Partial<DemandFacts["openTasks"][number]> = {}): DemandFacts["openTasks"][number] => ({
  id,
  dependencies: [],
  claims: [],
  driveReads: [],
  driveChanges: [],
  protectedStakes: false,
  failedReviews: 0,
  staleSource: false,
  decisionRequired: false,
  needsScreening: false,
  ...over,
});

test("OVS-01/OVS-02/OVS-04: a checkpoint's demand comes from the project's shape, never its name or size alone", () => {
  const thresholds = adaptivePolicy(UNFROZEN).adaptive!.oversight;
  const demand = (openTasks: DemandFacts["openTasks"], questions: DemandFacts["openOwnerQuestions"] = []) =>
    classifyDemand({ openTasks, openOwnerQuestions: questions }, thresholds);
  // One small independent task, however large the project's name or history.
  assert.equal(demand([task("A")]).demand, "BOUNDED");
  assert.equal(demand([]).demand, "BOUNDED");
  assert.equal(demand(["A", "B", "C", "D"].map((id) => task(id))).demand, "MODULE");
  assert.equal(demand([task("A", { decisionRequired: true })]).demand, "MODULE");
  assert.equal(demand([task("A", { staleSource: true })]).demand, "MODULE");
  assert.equal(demand([task("A"), task("B", { dependencies: ["A"] })]).demand, "MODULE");
  // Easy tasks that share state: four on one claim are six coupled pairs.
  const shared = demand(["A", "B", "C", "D"].map((id) => task(id, { claims: ["resource:greeting"] })));
  assert.equal(shared.demand, "PROGRAMME");
  assert.equal(shared.coupling, 6);
  // A Drive file one task changes and another reads couples them.
  assert.equal(demand([task("A", { driveChanges: ["F1"] }), task("B", { driveReads: ["F1"] })]).coupling, 1);
  const many = Array.from({ length: 12 }, (_, i) => task("T" + i, i === 1 ? { dependencies: ["T0"] } : {}));
  assert.equal(demand(many).demand, "PROGRAMME");
  // Accumulating failures and a project-wide owner question escalate.
  assert.equal(demand([task("A", { failedReviews: 2 }), task("B", { failedReviews: 2 })]).demand, "PROGRAMME");
  assert.equal(demand([task("A")], [{ projectWide: true }]).demand, "PROGRAMME");
  assert.equal(demand([task("A")], [{ projectWide: false }]).demand, "MODULE");
});

/** Seed overseer classes, then select a coordination-only overseer for one demand. */
function oversee(
  classes: Array<{ demand: "BOUNDED" | "MODULE" | "PROGRAMME"; finalists: Array<[route: string, quality: Quality]> }>,
  demand: "BOUNDED" | "MODULE" | "PROGRAMME",
  options: { extra?: R[]; floorExceptions?: unknown[] } = {},
) {
  const s = store();
  try {
    const all = simulationRoutes(options.extra ?? []);
    const { ref } = seedEvidence(
      s.db,
      classes.map((c) => ({
        key: "oversight/" + c.demand.toLowerCase(),
        kind: "OVERSEER" as const,
        finalists: c.finalists.map(([id, quality]) => ({ arrangement: overseerOf(all, id, c.demand), quality })),
      })),
    );
    const policy: RoutingPolicy = adaptivePolicy([ref], { routes: all, floorExceptions: options.floorExceptions ?? [] });
    return selectCoordinationOverseer(
      { demand, mode: "COORDINATION_ONLY", simulation: true, providers: ["codex", "claude"] },
      policy,
      policy.adaptive!,
      none,
      () => undefined,
      new EvidenceIndex(s.db, policy.adaptive!, Date.now()),
    );
  } finally {
    s.close();
  }
}

test("OVS-01/OVS-03/OVS-06: the checkpoint overseer is the qualified route approved for the demand, else the checkpoint holds", () => {
  const bounded = oversee([{ demand: "BOUNDED", finalists: [["sol-xhigh-overseer", "fair"], ["opus-xhigh-overseer", "strong"]] }], "BOUNDED");
  assert.ok(bounded.ok && bounded.route.id === "opus-xhigh-overseer");
  // Astra is not forced: its routes are not approved for a bounded checkpoint.
  assert.ok(bounded.ok && bounded.exclusions.some((e) => e.routeId === "astra-xhigh-overseer" && e.reason === "NOT_APPROVED_FOR_BOUNDED"));
  const flipped = oversee([{ demand: "BOUNDED", finalists: [["sol-xhigh-overseer", "strong"], ["opus-xhigh-overseer", "fair"]] }], "BOUNDED");
  assert.ok(flipped.ok && flipped.route.id === "sol-xhigh-overseer");
  const programme = oversee([{ demand: "PROGRAMME", finalists: [["astra-xhigh-overseer", "strong"]] }], "PROGRAMME");
  assert.ok(programme.ok && programme.route.id === "astra-xhigh-overseer");
  // No qualified overseer for the demand: the checkpoint holds.
  const held = oversee([{ demand: "BOUNDED", finalists: [["sol-xhigh-overseer", "strong"]] }], "MODULE");
  assert.ok(!held.ok && held.code === "ADAPTIVE_CHECKPOINT_NO_QUALIFIED_OVERSEER");
  assert.match(!held.ok ? held.reasons[0]! : "", /no worker is admitted/);
  // A High overseer needs its floor exception, and only for bounded checkpoints.
  const high = [{ demand: "BOUNDED" as const, finalists: [["sol-high-overseer", "strong"]] as Array<[string, Quality]> }];
  const noException = oversee(high, "BOUNDED", { extra: [solHighOverseer] });
  assert.ok(!noException.ok && noException.exclusions.some((e) => e.routeId === "sol-high-overseer" && e.reason === "EFFORT_BELOW_FLOOR"));
  const withException = oversee(high, "BOUNDED", { extra: [solHighOverseer], floorExceptions: [exception("overseer")] });
  assert.ok(withException.ok && withException.route.id === "sol-high-overseer");
  const module = oversee([{ demand: "MODULE", finalists: [["sol-high-overseer", "strong"]] }], "MODULE", {
    extra: [solHighOverseer],
    floorExceptions: [exception("overseer")],
  });
  assert.ok(!module.ok && module.exclusions.some((e) => e.routeId === "sol-high-overseer" && e.reason === "EFFORT_BELOW_FLOOR"));
});

test("elimination is set-based: the outcome never depends on the candidates' order", () => {
  const items = [
    { id: "A", m1: { point: 0.85, low: 0.8, high: 0.9 }, m2: { point: 0.5, low: 0.4, high: 0.6 } },
    { id: "B", m1: { point: 0.7, low: 0.5, high: 0.85 }, m2: { point: 0.2, low: 0.1, high: 0.3 } },
    { id: "C", m1: { point: 0.4, low: 0.2, high: 0.6 }, m2: { point: 0.95, low: 0.9, high: 1 } },
  ];
  const specs = [
    { name: "m1", interval: (c: (typeof items)[number]) => c.m1 },
    { name: "m2", interval: (c: (typeof items)[number]) => c.m2 },
  ];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders) {
    const result = eliminate(order.map((i) => items[i]!), specs, (c) => c.id);
    // C falls on m1 (A is conclusively better), so it cannot remove B on
    // m2; A then removes B on m2.
    assert.deepEqual(result.survivors.map((c) => c.id), ["A"]);
    assert.deepEqual(result.trace, ["m1: removed 1 of 3", "m2: removed 1 of 2"]);
  }
  assert.throws(() => eliminate([], specs, (c) => c.id), /ELIMINATION_EMPTY/);
});

test("E3 review F8: only another plan's governing, current import can contradict", () => {
  const s = store();
  try {
    const all = simulationRoutes();
    const arrangement = pairOf(all, "sol-complex-xhigh-worker", "opus-complex-high-reviewer");
    const a = seedEvidence(s.db, [{ key: "general/complex", kind: "PAIR", finalists: [{ arrangement, quality: "strong" }] }], "plan-a");
    // Plan B failed the arrangement at its first stage, then grew to an
    // uncertain second stage with the same twenty executions.
    const plan = EvaluationPlanSchema.parse({
      ...a.plan,
      id: "plan-b",
      classes: [{ ...a.plan.classes[0]!, cases: Array.from({ length: 25 }, (_, i) => ({ caseId: "C" + (i + 1), caseInputDigest: digest("b" + i) })) }],
      sampling: { stages: [20, 25] },
    });
    freezePlan(s.db, plan, "owner");
    const fixtures = Array.from({ length: 25 }, () => randomUUID());
    const bundle = (n: number) => ({
      version: 1,
      planId: plan.id,
      planDigest: planDigest(plan),
      phase: "QUALIFICATION",
      journalHead: "0".repeat(64),
      results: Array.from({ length: n }, (_, i) => ({
        caseId: "C" + (i + 1),
        classKey: "general/complex",
        arrangementId: arrangementId(arrangement),
        fixtureId: fixtures[i]!,
        runs: { worker: [], reviewer: [], rework: [], overseer: [] },
        graderId: "grader-1",
        grades: {
          firstDraftCorrect: i < 5 || i >= 20,
          finalCorrect: i < 5 || i >= 20,
          sourceFaithful: true,
          taskFit: true,
          seriousErrors: 0,
          reviewer: { seeded: 2, detected: 2, falsePositives: 0 },
        },
      })),
      limitations: [],
    });
    assert.equal(importEvidence(s.db, bundle(20), { actor: "owner" }).aggregates[0]!.decision, "FAILED");
    assert.equal(importEvidence(s.db, bundle(25), { actor: "owner" }).aggregates[0]!.decision, "UNCERTAIN");
    const policy = adaptivePolicy([a.ref, { id: plan.id, digest: planDigest(plan) }]);
    const match = new EvidenceIndex(s.db, policy.adaptive!, Date.now()).lookup("general/complex", arrangement, true);
    assert.equal(match.decision, "QUALIFIED");
  } finally {
    s.close();
  }
});

test("E3 review F9: a task whose only worker left is an exhausted Max route holds for the ceiling", () => {
  const exhausted = select(
    [["sol-expert-max-worker", "opus-expert-xhigh-reviewer", "strong"]],
    {
      tier: "EXPERT",
      classKey: "general/expert",
      authorship: { providers: ["codex"], unknown: false },
      history: [failure(1, "EXPERT", "codex", "gpt-6.1-sol", "max"), failure(2, "EXPERT", "codex", "gpt-6.1-sol", "max")],
      ceiling: { used: 1, allowed: 1 },
    },
  );
  assert.ok(!exhausted.ok && exhausted.code === "ADAPTIVE_CEILING_EXHAUSTED", canonicalTrace(exhausted));
});
