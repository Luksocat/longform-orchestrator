/**
 * Deterministic selection for the adaptive workflow (issue #12;
 * implementation contract sections 4, 6, 7.3 and 8). Pure functions over
 * facts the controller gathers: nothing here reads providers, task prose or
 * prices, and nothing reserves. The controller pins what these return.
 */
import {
  ADAPTIVE_PROTOCOL_VERSION,
  arrangementId,
  candidateIdentity,
  frozenPlans,
  importedEvidence,
  normalContext,
  routeDefinitionDigest,
  SIMULATION_RUNTIME,
  type Arrangement,
  type Decision,
  type ExposedContext,
  type IdentityRole,
  type Interval,
  type OverseerMetrics,
  type PairArrangement,
  type PairMetrics,
  type Runtime,
} from "./evaluation.js";
import {
  effortRank,
  floorFor,
  isFableModel,
  QUALITY_EFFORTS,
  type AdaptivePolicy,
  type OversightDemand,
  type OversightMode,
  type RoutingPolicy,
} from "./routing.js";
import type { Persistence } from "./store.js";

export type Route = RoutingPolicy["routes"][number];
export type Tier = "COMPLEX" | "EXPERT";
export type AdaptiveRole = "worker" | "reviewer" | "overseer";
/** A route as a pin records it (contract section 7.1). */
export type ExactRoute = {
  routeId: string;
  provider: string;
  modelId: string;
  effort: string;
  role: AdaptiveRole;
  level: string;
  routeDefinitionDigest: string;
  simulation: boolean;
};
export function exactRoute(route: Route, role: AdaptiveRole): ExactRoute {
  return {
    routeId: route.id,
    provider: route.provider,
    modelId: route.model,
    effort: route.effort,
    role,
    level: route.level,
    routeDefinitionDigest: routeDefinitionDigest({ ...route, role }),
    simulation: route.simulation,
  };
}
/** The route a pin names, if the current policy still defines it identically. */
export function pinnedRoute(policy: RoutingPolicy, pinned: ExactRoute): Route | undefined {
  const route = policy.routes.find((r) => r.id === pinned.routeId);
  return route &&
    route.roles.includes(pinned.role) &&
    routeDefinitionDigest({ ...route, role: pinned.role }) === pinned.routeDefinitionDigest &&
    route.level === pinned.level
    ? route
    : undefined;
}

// ---------------------------------------------------------------- evidence

export type EvidenceMatch = {
  decision: Decision | "MISSING" | "STALE" | "CONTRADICTORY";
  metrics?: PairMetrics | OverseerMetrics;
  evidenceId?: string;
  planId?: string;
  reasons: string[];
};
/**
 * The evidence the current policy lets selection use (contract section
 * 5.4): one governing plan per class, the largest stage per arrangement,
 * no stale or contradicted evidence, synthetic evidence for simulation
 * tasks only.
 */
export class EvidenceIndex {
  private readonly listed: Array<{ id: string; classes: Set<string> }>;
  private readonly imports: ReturnType<typeof importedEvidence>;
  constructor(
    db: Persistence,
    private readonly adaptive: AdaptivePolicy,
    private readonly now: number,
  ) {
    const frozen = frozenPlans(db);
    this.listed = adaptive.evaluationPlans
      .map((ref) => frozen.get(ref.id))
      .filter(
        (f, i): f is NonNullable<typeof f> =>
          !!f && f.planDigest === adaptive.evaluationPlans[i]!.digest,
      )
      .map((f) => ({ id: f.planId, classes: new Set(f.plan.classes.map((c) => c.key)) }));
    this.imports = importedEvidence(db);
  }
  /** The governing plan for a class: the first listed frozen plan covering it. */
  governing(classKey: string): string | undefined {
    return this.listed.find((p) => p.classes.has(classKey))?.id;
  }
  lookup(classKey: string, arrangement: Arrangement, simulation: boolean): EvidenceMatch {
    const planId = this.governing(classKey);
    if (!planId)
      return { decision: "MISSING", reasons: [`No listed, frozen evaluation plan covers ${classKey}`] };
    const id = arrangementId(arrangement);
    const usable = (planOf: string) => {
      // The importer fixes each class/arrangement's case prefix and grades.
      // Reimporting the same stage changes no measured evidence, even when
      // notes, result order or companion classes change the bundle digest.
      // A previously imported larger stage already contains every case of
      // a smaller prefix. Establish its age before filtering synthetic
      // bundles: removing an unverified class or tail can change eligibility.
      const firstImportedAt = new Map<number, string>();
      return this.imports
        .filter((e) => e.planId === planOf)
        .flatMap((e) =>
          e.aggregates
            .filter((a) => a.classKey === classKey && a.arrangementId === id)
            .map((a) => {
              // Imports (and map insertion order) are chronological. The
              // first prior superset is the first observation of this prefix.
              // Cache by stage; there are at most 20 stages in a frozen plan.
              const at = firstImportedAt.get(a.n) ??
                [...firstImportedAt].find(([n]) => n >= a.n)?.[1] ?? e.at;
              firstImportedAt.set(a.n, at);
              return { e, a, at };
            }),
        )
        .filter(({ e }) => simulation || !e.synthetic);
    };
    const found = usable(planId).sort((x, y) => y.a.n - x.a.n || y.e.seq - x.e.seq)[0];
    if (!found)
      return {
        decision: "MISSING",
        planId,
        reasons: [
          simulation
            ? `No evidence for this exact arrangement in plan ${planId}`
            : `No non-synthetic evidence for this exact arrangement in plan ${planId}`,
        ],
      };
    const ageDays = (this.now - Date.parse(found.at)) / 86_400_000;
    if (ageDays > this.adaptive.maxEvidenceAgeDays)
      return {
        decision: "STALE",
        planId,
        evidenceId: found.e.evidenceId,
        reasons: [`Evidence is ${Math.floor(ageDays)} days old, beyond ${this.adaptive.maxEvidenceAgeDays}`],
      };
    // Another listed plan contradicts only through its own governing, current
    // import of the arrangement: its largest stage, latest record, with the
    // stage's original age (E3 review F8).
    const best = (planOf: string) => usable(planOf).sort((x, y) => y.a.n - x.a.n || y.e.seq - x.e.seq)[0];
    const current = (e: { at: string }) =>
      (this.now - Date.parse(e.at)) / 86_400_000 <= this.adaptive.maxEvidenceAgeDays;
    if (
      found.a.decision === "QUALIFIED" &&
      this.listed.some((p) => {
        const other = p.id !== planId ? best(p.id) : undefined;
        return !!other && current(other) && other.a.decision === "FAILED";
      })
    )
      return {
        decision: "CONTRADICTORY",
        planId,
        evidenceId: found.e.evidenceId,
        reasons: ["Another listed plan failed this arrangement"],
      };
    return {
      decision: found.a.decision,
      metrics: found.a.metrics,
      planId,
      evidenceId: found.e.evidenceId,
      reasons: found.a.reasons,
    };
  }
}

// -------------------------------------------------------------- elimination

export type MetricSpec<T> =
  | { name: string; interval: (c: T) => Interval; lowerIsBetter?: boolean }
  | { name: string; sample: (c: T) => number };
/**
 * Set-based lexicographic elimination (contract section 6, step 7). At each
 * metric every candidate conclusively worse than another remaining one is
 * removed, judged against the set as it stood at the start of the metric,
 * so neither enumeration nor sort order can change the outcome. The stable
 * tie key picks among the survivors.
 */
export function eliminate<T>(
  items: T[],
  specs: MetricSpec<T>[],
  tieKey: (c: T) => string,
): { chosen: T; survivors: T[]; trace: string[] } {
  if (!items.length) throw new Error("ELIMINATION_EMPTY");
  let set = [...items];
  const trace: string[] = [];
  for (const spec of specs) {
    const before = set;
    const worse = (c: T) =>
      before.some((d) => {
        if (d === c) return false;
        if ("sample" in spec) return spec.sample(d) >= 2 * spec.sample(c);
        const a = spec.interval(d),
          b = spec.interval(c);
        return spec.lowerIsBetter ? a.high < b.low : a.low > b.high;
      });
    const kept = before.filter((c) => !worse(c));
    if (kept.length < before.length)
      trace.push(`${spec.name}: removed ${before.length - kept.length} of ${before.length}`);
    set = kept;
  }
  set.sort((a, b) => (tieKey(a) < tieKey(b) ? -1 : tieKey(a) > tieKey(b) ? 1 : 0));
  return { chosen: set[0]!, survivors: set, trace };
}
const pm = (c: { metrics: PairMetrics }) => c.metrics;
export const PAIR_METRICS: MetricSpec<{ metrics: PairMetrics }>[] = [
  { name: "serious-error rate", interval: (c) => pm(c).seriousErrorRate, lowerIsBetter: true },
  { name: "final-correct rate", interval: (c) => pm(c).finalCorrectRate },
  { name: "source fidelity", interval: (c) => pm(c).sourceFidelityRate },
  { name: "task fit", interval: (c) => pm(c).taskFitRate },
  { name: "reviewer recall", interval: (c) => pm(c).reviewerRecall },
  { name: "false positives per case", interval: (c) => pm(c).falsePositivesPerCase, lowerIsBetter: true },
  { name: "sample size", sample: (c) => pm(c).n },
];
const om = (c: { metrics: OverseerMetrics }) => c.metrics;
export const OVERSEER_METRICS: MetricSpec<{ metrics: OverseerMetrics }>[] = [
  { name: "serious-error rate", interval: (c) => om(c).seriousErrorRate, lowerIsBetter: true },
  { name: "valid checkpoints", interval: (c) => om(c).validCheckpointRate },
  { name: "coordination correct", interval: (c) => om(c).coordinationCorrectRate },
  { name: "sample size", sample: (c) => om(c).n },
];

// --------------------------------------------------------- pair selection

/** A failed review in a task's history (contract section 7.3). */
export type FailureRecord = {
  reviewRunId: string;
  tier: string;
  provider: string;
  model: string;
  effort: string;
  consumed: boolean;
};
export type PairFacts = {
  taskId: string;
  providers: readonly string[];
  simulation: boolean;
  tier: Tier;
  boundedLowStakes: boolean;
  classKey: string;
  authorship: { providers: string[]; unknown: boolean };
  context: ExposedContext;
  history: FailureRecord[];
  ceiling: { used: number; allowed: number };
  preference: { mode: "AUTO" | "GUIDED" | "PINNED"; workerRouteId?: string; reviewerRouteId?: string };
};
export type Exclusion = { routeId: string; role: AdaptiveRole; reason: string };
export type PairCandidate = {
  worker: Route;
  reviewer: Route;
  arrangement?: PairArrangement;
  arrangementId?: string;
  match: EvidenceMatch;
};
export type PairSelection =
  | {
      ok: true;
      worker: Route;
      reviewer: Route;
      arrangement: PairArrangement;
      arrangementId: string;
      match: EvidenceMatch & { metrics: PairMetrics };
      ceilingContinuation: boolean;
      exclusions: Exclusion[];
      candidates: PairCandidate[];
      trace: string[];
    }
  | { ok: false; code: string; reasons: string[]; exclusions: Exclusion[]; candidates: PairCandidate[] };
export type Availability = (route: Route, role: AdaptiveRole) => string | undefined;
export type RuntimeOf = (route: Route) => Runtime | undefined;
/** The candidate identity of a route for a role, when its runtime is known. */
export function identityOf(route: Route, role: IdentityRole, runtimeOf: RuntimeOf) {
  const runtime = route.simulation ? SIMULATION_RUNTIME : runtimeOf(route);
  return runtime ? candidateIdentity(route, role, runtime) : undefined;
}
const failuresAt = (history: FailureRecord[], tier: string, route: { provider: string; model: string; effort: string }) =>
  history.filter(
    (f) => f.tier === tier && f.provider === route.provider && f.model === route.model && f.effort === route.effort,
  );
/** A floor exception that could let this High route serve this task (contract section 3.3). */
function floorException(adaptive: AdaptivePolicy, route: Route, role: "worker" | "reviewer" | "overseer", bounded: boolean) {
  return adaptive.floorExceptions.find(
    (e) =>
      e.provider === route.provider &&
      e.role === role &&
      route.effort === "high" &&
      (role === "overseer" ? e.scope === "BOUNDED_OVERSIGHT" : e.scope === "BOUNDED_LOW_STAKES" && bounded),
  );
}
/**
 * Exclusions for one adaptive route in one role, before evidence (contract
 * section 6, step 1).
 */
export function routeExclusion(
  route: Route,
  role: AdaptiveRole,
  facts: { simulation: boolean; providers: readonly string[]; tier: Tier; boundedLowStakes?: boolean },
  adaptive: AdaptivePolicy,
  available: Availability,
): string | undefined {
  if (!route.roles.includes(role)) return "ROLE";
  if (route.simulation !== facts.simulation) return "SIMULATION_MISMATCH";
  if (!facts.providers.includes(route.provider)) return "PROVIDER_NOT_IN_TASK";
  if (!route.enabled) return "ROUTE_DISABLED";
  if (isFableModel(route.model)) return "FABLE_QUARANTINED";
  if (role !== "overseer" && route.level !== facts.tier) return "TIER_MISMATCH";
  const floor = floorFor(route.provider, role, facts.tier);
  if (!floor) return "PROVIDER_HAS_NO_FLOOR";
  if (
    effortRank(route.effort) < effortRank(floor) &&
    !(facts.tier === "COMPLEX" && floorException(adaptive, route, role, !!facts.boundedLowStakes))
  )
    return "EFFORT_BELOW_FLOOR";
  return available(route, role);
}
/**
 * Select the worker and independent reviewer for a new pin (contract
 * section 6). Returns the choice with every exclusion and the qualified
 * alternatives, or a hold.
 */
export function selectPair(
  facts: PairFacts,
  policy: RoutingPolicy,
  adaptive: AdaptivePolicy,
  available: Availability,
  runtimeOf: RuntimeOf,
  evidence: EvidenceIndex,
): PairSelection {
  const exclusions: Exclusion[] = [];
  const eligible = (role: "worker" | "reviewer") =>
    policy.routes.filter((route) => {
      if (!route.roles.includes(role)) return false;
      let reason = routeExclusion(route, role, facts, adaptive, available);
      if (!reason && role === "worker") {
        const failures = failuresAt(facts.history, facts.tier, route).length;
        if (failures >= 2 && !(route.effort === "max" && facts.ceiling.used < facts.ceiling.allowed))
          reason =
            route.effort === "max"
              ? "CEILING_EXHAUSTED: two failed reviews at max and no continuation left"
              : "EFFORT_ESCALATION_REQUIRED: two failed reviews at this exact tier, model and effort";
      }
      if (reason) exclusions.push({ routeId: route.id, role, reason });
      return !reason;
    });
  const hold = (code: string, reasons: string[], candidates: PairCandidate[] = []): PairSelection => ({
    ok: false,
    code,
    reasons,
    exclusions,
    candidates,
  });
  if (facts.authorship.unknown)
    return hold("ADAPTIVE_AUTHORSHIP_UNKNOWN", [
      "Who shaped this task's work cannot be established, so no review can be called independent",
    ]);
  if (facts.authorship.providers.length > 1)
    return hold("ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED", [
      "Both providers already contributed to this task, so neither can review it independently: split the work or change the review plan",
    ]);
  const workers = eligible("worker").filter(
    (w) => !facts.authorship.providers.length || facts.authorship.providers.includes(w.provider),
  );
  const reviewers = eligible("reviewer");
  // Holds name every exclusion, so the owner sees why each route is out.
  const excluded = () => exclusionText(exclusions).slice(0, 60);
  const ceilingExhausted = () =>
    exclusions.some((e) => e.role === "worker" && e.reason.startsWith("CEILING_EXHAUSTED"));
  if (!workers.length)
    return ceilingExhausted()
      ? hold("ADAPTIVE_CEILING_EXHAUSTED", [
          "The worker reached its Max ceiling and its bounded continuations are used; the owner decides how to go on",
          ...excluded(),
        ])
      : hold("ADAPTIVE_NO_ELIGIBLE_WORKER", ["No eligible worker route for this task", ...excluded()]);
  const candidates: PairCandidate[] = [];
  for (const w of workers)
    for (const r of reviewers) {
      if (r.provider === w.provider || facts.authorship.providers.includes(r.provider)) continue;
      const worker = identityOf(w, "worker", runtimeOf),
        reviewer = identityOf(r, "reviewer", runtimeOf);
      if (!worker || !reviewer) {
        candidates.push({
          worker: w,
          reviewer: r,
          match: { decision: "MISSING", reasons: ["A route's runtime (CLI version) is not attested"] },
        });
        continue;
      }
      const arrangement: PairArrangement = {
        kind: "PAIR",
        worker,
        reviewer,
        protocolVersion: ADAPTIVE_PROTOCOL_VERSION,
        context: normalContext(facts.context),
      };
      let match = evidence.lookup(facts.classKey, arrangement, facts.simulation);
      // A floor exception holds only while its own plan qualifies the pair.
      for (const [route, role] of [[w, "worker"], [r, "reviewer"]] as const) {
        const floor = floorFor(route.provider, role, facts.tier)!;
        if (effortRank(route.effort) < effortRank(floor)) {
          const exception = floorException(adaptive, route, role, facts.boundedLowStakes);
          if (!exception || match.planId !== exception.evaluationPlanId || match.decision !== "QUALIFIED")
            match = {
              decision: "MISSING",
              reasons: [`High is below the ${floor} floor here unless floor exception evidence qualifies this exact pair`],
            };
        }
      }
      candidates.push({ worker: w, reviewer: r, arrangement, arrangementId: arrangementId(arrangement), match });
    }
  if (!candidates.length)
    return hold("ADAPTIVE_NO_INDEPENDENT_REVIEWER", [
      "No eligible reviewer from the other provider: no initial reservation is made (SEL-10)",
    ]);
  let pool = candidates;
  if (facts.preference.mode === "PINNED") {
    pool = candidates.filter(
      (c) =>
        c.worker.id === facts.preference.workerRouteId &&
        (!facts.preference.reviewerRouteId || c.reviewer.id === facts.preference.reviewerRouteId),
    );
    const usable = pool.filter((c) => c.match.decision === "QUALIFIED");
    if (!usable.length)
      return hold(
        "ADAPTIVE_PINNED_PREFERENCE_REFUSED",
        [
          `The owner's pinned routes (${facts.preference.workerRouteId}${facts.preference.reviewerRouteId ? ", " + facts.preference.reviewerRouteId : ""}) are not an eligible, qualified, independent pair here; a preference cannot waive floors, attestation, evidence or independence`,
          ...exclusions
            .filter((e) => e.routeId === facts.preference.workerRouteId || e.routeId === facts.preference.reviewerRouteId)
            .map((e) => `${e.routeId}: ${e.reason}`),
          ...pool.map((c) => `${c.worker.id}|${c.reviewer.id}: ${c.match.decision}`),
        ],
        candidates,
      );
  }
  const qualified = pool.filter(
    (c): c is PairCandidate & { arrangement: PairArrangement; arrangementId: string; match: EvidenceMatch & { metrics: PairMetrics } } =>
      c.match.decision === "QUALIFIED" && !!c.arrangement && !!c.match.metrics,
  );
  if (!qualified.length) {
    // A max worker past its bounded continuations is the owner's decision
    // (owner decision 1), even when a fix task or revision selects anew.
    const ceiling = ceilingExhausted();
    return hold(
      ceiling
        ? "ADAPTIVE_CEILING_EXHAUSTED"
        : pool.some((c) => c.match.decision === "CONTRADICTORY")
          ? "ADAPTIVE_EVIDENCE_CONTRADICTORY"
          : "ADAPTIVE_EVIDENCE_MISSING",
      [
        ceiling
          ? "The worker reached its Max ceiling and its bounded continuations are used; the owner decides how to go on"
          : "No worker and reviewer pair has qualifying evidence for this task class; the adaptive workflow never falls back to the fixed pairing",
        ...pool.map((c) => `${c.worker.id}|${c.reviewer.id}: ${c.match.decision}${c.match.reasons.length ? " (" + c.match.reasons[0] + ")" : ""}`),
        ...excluded(),
      ],
      candidates,
    );
  }
  const { chosen, trace } = eliminate(
    qualified.map((c) => ({ ...c, metrics: c.match.metrics })),
    PAIR_METRICS,
    (c) => c.worker.id + "|" + c.reviewer.id,
  );
  return {
    ok: true,
    worker: chosen.worker,
    reviewer: chosen.reviewer,
    arrangement: chosen.arrangement,
    arrangementId: chosen.arrangementId,
    match: chosen.match,
    ceilingContinuation:
      chosen.worker.effort === "max" && failuresAt(facts.history, facts.tier, chosen.worker).length >= 2,
    exclusions,
    candidates,
    trace,
  };
}

// --------------------------------------------------- escalation and ceiling

export type PinRevisionCore = {
  tier: Tier;
  worker: ExactRoute;
  reviewer: ExactRoute;
};
/** Which trigger fires for the next worker run under a pin, if any (contract section 7.3). */
export function escalationDue(
  pin: PinRevisionCore,
  history: FailureRecord[],
): { rule: "TIER" | "EFFORT"; trigger: string[] } | undefined {
  const open = history.filter((f) => !f.consumed);
  if (pin.tier === "COMPLEX") {
    const complex = open.filter((f) => f.tier === "COMPLEX");
    if (complex.length >= 2) return { rule: "TIER", trigger: complex.map((f) => f.reviewRunId) };
  }
  const exact = open.filter(
    (f) =>
      f.tier === pin.tier &&
      f.provider === pin.worker.provider &&
      f.model === pin.worker.modelId &&
      f.effort === pin.worker.effort,
  );
  if (exact.length >= 2) return { rule: "EFFORT", trigger: exact.map((f) => f.reviewRunId) };
  return undefined;
}
export type EscalationPlan =
  | {
      ok: true;
      tier: Tier;
      worker: Route;
      reviewer: Route;
      reason: "EFFORT_ESCALATION" | "CEILING_CONTINUATION";
      ceiling: { worker: boolean; reviewer: boolean };
    }
  | { ok: false; code: string; reasons: string[] };
/**
 * The routes of the revision a trigger requires: the worker one effort up
 * (at least the tier's floor), the reviewer at least the floor, both on
 * their provider and model. A worker already at max stays there: the worker
 * ceiling (owner decision 1).
 */
export function planEscalation(
  pin: PinRevisionCore,
  due: { rule: "TIER" | "EFFORT" },
  policy: RoutingPolicy,
  facts: { simulation: boolean; providers: readonly string[]; boundedLowStakes: boolean },
  adaptive: AdaptivePolicy,
  available: Availability,
): EscalationPlan {
  const tier: Tier = due.rule === "TIER" ? "EXPERT" : pin.tier;
  const up = (effort: string) => QUALITY_EFFORTS[Math.min(effortRank(effort) + 1, QUALITY_EFFORTS.length - 1)]!;
  const atLeast = (effort: string, floor: string) =>
    effortRank(effort) >= effortRank(floor) ? effort : floor;
  const workerFloor = floorFor(pin.worker.provider, "worker", tier)!;
  const reviewerFloor = floorFor(pin.reviewer.provider, "reviewer", tier)!;
  const workerCeiling = pin.worker.effort === "max";
  const workerEffort = atLeast(workerCeiling ? "max" : up(pin.worker.effort), workerFloor);
  const reviewerEffort = atLeast(pin.reviewer.effort, reviewerFloor);
  const find = (role: "worker" | "reviewer", provider: string, model: string, effort: string) =>
    policy.routes
      .filter(
        (r) =>
          r.roles.includes(role) &&
          r.provider === provider &&
          r.model === model &&
          r.effort === effort &&
          r.level === tier,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find((r) => !routeExclusion(r, role, { ...facts, tier }, adaptive, available));
  const worker = find("worker", pin.worker.provider, pin.worker.modelId, workerEffort);
  const reviewer = find("reviewer", pin.reviewer.provider, pin.reviewer.modelId, reviewerEffort);
  if (!worker || !reviewer)
    return {
      ok: false,
      code: "ADAPTIVE_ESCALATION_ROUTE_UNAVAILABLE",
      reasons: [
        `The escalated pair needs an eligible ${tier} worker ${pin.worker.provider}/${pin.worker.modelId} at ${workerEffort} and reviewer ${pin.reviewer.provider}/${pin.reviewer.modelId} at ${reviewerEffort}; no weaker reviewer, lower effort or other provider is substituted`,
      ],
    };
  const rises = tier !== pin.tier || workerEffort !== pin.worker.effort || reviewerEffort !== pin.reviewer.effort;
  return {
    ok: true,
    tier,
    worker,
    reviewer,
    reason: rises ? "EFFORT_ESCALATION" : "CEILING_CONTINUATION",
    ceiling: { worker: workerCeiling, reviewer: reviewerEffort === "max" },
  };
}

// ----------------------------------------------------------------- oversight

export type DemandFacts = {
  openTasks: Array<{
    id: string;
    dependencies: string[];
    claims: string[];
    driveReads: string[];
    driveChanges: string[];
    repo?: string;
    protectedStakes: boolean;
    failedReviews: number;
    staleSource: boolean;
    decisionRequired: boolean;
    needsScreening: boolean;
  }>;
  openOwnerQuestions: Array<{ projectWide: boolean }>;
};
/** The oversight demand of a checkpoint, with reasons (contract section 8.1). */
export function classifyDemand(
  facts: DemandFacts,
  thresholds: AdaptivePolicy["oversight"],
): { demand: OversightDemand; reasons: string[]; coupling: number } {
  const open = facts.openTasks;
  const ids = new Set(open.map((t) => t.id));
  let coupling = 0;
  const reasons: string[] = [];
  for (const t of open) for (const d of t.dependencies) if (ids.has(d)) coupling++;
  for (let i = 0; i < open.length; i++)
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!,
        b = open[j]!;
      const shared =
        a.claims.some((c) => b.claims.includes(c)) ||
        a.driveChanges.some((x) => b.driveReads.includes(x) || b.driveChanges.includes(x)) ||
        b.driveChanges.some((x) => a.driveReads.includes(x)) ||
        (!!a.repo && a.repo === b.repo);
      if (shared) coupling++;
    }
  const forks =
    facts.openOwnerQuestions.length +
    open.filter((t) => t.needsScreening).length +
    open.filter((t) => t.decisionRequired).length;
  const protectedStakes = open.filter((t) => t.protectedStakes).length;
  const failing = open.filter((t) => t.failedReviews >= 2).length;
  const stale = open.filter((t) => t.staleSource).length;
  const p = thresholds.programmeAt,
    m = thresholds.moduleAt;
  const programme = [
    coupling >= p.coupling && `coupling ${coupling} reaches ${p.coupling}`,
    open.length >= p.openTasks && coupling > 0 && `${open.length} open tasks with coupling`,
    protectedStakes >= 2 && coupling > 0 && `${protectedStakes} protected-stakes tasks are coupled`,
    failing >= 2 && `${failing} tasks failed review repeatedly`,
    facts.openOwnerQuestions.some((q) => q.projectWide) && "an open project-wide owner question",
  ].filter((x): x is string => !!x);
  if (programme.length) return { demand: "PROGRAMME", reasons: programme, coupling };
  const module = [
    coupling >= m.coupling && `coupling ${coupling}`,
    open.length >= m.openTasks && `${open.length} open tasks`,
    forks > 0 && `${forks} open decision forks`,
    protectedStakes > 0 && "a protected-stakes task",
    failing > 0 && "a task failed review repeatedly",
    stale > 0 && "a stale source",
  ].filter((x): x is string => !!x);
  if (module.length) return { demand: "MODULE", reasons: module, coupling };
  reasons.push(
    open.length ? `${open.length} independent open task(s), no fork or shared state` : "no open task",
  );
  return { demand: "BOUNDED", reasons, coupling };
}
/** A qualified overseer route and its measured intervals, for scorecards. */
export type OverseerCandidate = { routeId: string; metrics: OverseerMetrics };
export type OverseerSelection =
  | {
      ok: true;
      route: Route;
      arrangement: Arrangement;
      match: EvidenceMatch;
      exclusions: Exclusion[];
      candidates: OverseerCandidate[];
      trace: string[];
    }
  | { ok: false; code: string; reasons: string[]; exclusions: Exclusion[]; candidates: OverseerCandidate[] };
/**
 * Choose a coordination-only checkpoint's overseer (contract section 8.3):
 * routes approved for the demand, eligible, qualified on overseer evidence,
 * by elimination on the overseer metrics.
 */
export function selectCoordinationOverseer(
  facts: { demand: OversightDemand; mode: OversightMode; simulation: boolean; providers: readonly string[] },
  policy: RoutingPolicy,
  adaptive: AdaptivePolicy,
  available: Availability,
  runtimeOf: RuntimeOf,
  evidence: EvidenceIndex,
): OverseerSelection {
  const exclusions: Exclusion[] = [];
  const qualified: Array<{ route: Route; arrangement: Arrangement; match: EvidenceMatch; metrics: OverseerMetrics }> = [];
  for (const route of policy.routes) {
    if (!route.roles.includes("overseer")) continue;
    let reason = !route.demands?.includes(facts.demand)
      ? "NOT_APPROVED_FOR_" + facts.demand
      : routeExclusion(
          route,
          "overseer",
          { simulation: facts.simulation, providers: facts.providers, tier: "COMPLEX" },
          adaptive,
          available,
        );
    if (!reason && route.effort === "high" && facts.demand !== "BOUNDED") reason = "EFFORT_BELOW_FLOOR";
    if (reason) {
      exclusions.push({ routeId: route.id, role: "overseer", reason });
      continue;
    }
    const overseer = identityOf(route, "overseer", runtimeOf);
    if (!overseer) {
      exclusions.push({ routeId: route.id, role: "overseer", reason: "RUNTIME_UNATTESTED" });
      continue;
    }
    const arrangement: Arrangement = { kind: "OVERSEER", overseer, demand: facts.demand, mode: facts.mode };
    const match = evidence.lookup("oversight/" + facts.demand.toLowerCase(), arrangement, facts.simulation);
    if (route.effort === "high") {
      const exception = floorException(adaptive, route, "overseer", true);
      if (!exception || match.planId !== exception.evaluationPlanId) {
        exclusions.push({ routeId: route.id, role: "overseer", reason: "EFFORT_BELOW_FLOOR" });
        continue;
      }
    }
    if (match.decision !== "QUALIFIED" || !match.metrics) {
      exclusions.push({ routeId: route.id, role: "overseer", reason: "EVIDENCE_" + match.decision });
      continue;
    }
    qualified.push({ route, arrangement, match, metrics: match.metrics as OverseerMetrics });
  }
  if (!qualified.length)
    return {
      ok: false,
      code: "ADAPTIVE_CHECKPOINT_NO_QUALIFIED_OVERSEER",
      reasons: [
        `No ${facts.demand} overseer route has qualifying checkpoint evidence; the checkpoint holds and no worker is admitted`,
        ...exclusions.map((e) => `${e.routeId}: ${e.reason}`),
      ],
      exclusions,
      candidates: [],
    };
  const { chosen, trace } = eliminate(qualified, OVERSEER_METRICS, (c) => c.route.id);
  const candidates = qualified.map((q) => ({ routeId: q.route.id, metrics: q.metrics }));
  return { ok: true, route: chosen.route, arrangement: chosen.arrangement, match: chosen.match, exclusions, candidates, trace };
}
/** A canonical, comparable summary of exclusions for pins and scorecards. */
export const exclusionText = (list: Exclusion[]) =>
  list.map((e) => `${e.role} ${e.routeId}: ${e.reason}`).sort();
