/**
 * Test helpers for the adaptive workflow (issue #12): a simulation adaptive
 * policy, and synthetic evidence imported without a journal. Synthetic
 * evidence qualifies simulation tasks only (contract section 5.4); none of
 * this is quality evidence.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { digest } from "../../../src/domain.js";
import {
  ADAPTIVE_PROTOCOL_VERSION,
  arrangementId,
  candidateIdentity,
  EvaluationPlanSchema,
  freezePlan,
  importEvidence,
  NO_EXPOSURE,
  planDigest,
  SIMULATION_RUNTIME,
  type Arrangement,
  type EvaluationPlan,
  type ExposedContext,
} from "../../../src/evaluation.js";
import {
  RoutingPolicySchema,
  type RoutingPolicy,
} from "../../../src/routing.js";
import type { Persistence } from "../../../src/store.js";

const HEX = (c: string) => c.repeat(64);
export const example = () =>
  JSON.parse(
    readFileSync(
      new URL("../../../docs/examples/adaptive-routing-policy.example.json", import.meta.url),
      "utf8",
    ),
  );
type R = ReturnType<typeof example>["routes"][number];
/** The example's routes as simulation routes, plus any extras. */
export function simulationRoutes(extra: R[] = []): R[] {
  return [...example().routes, ...extra].map((r: R) => ({ ...r, simulation: true }));
}
export const sim = (r: { provider: string; model: string; effort: string }, role: "worker" | "reviewer" | "overseer" | "advisor") =>
  candidateIdentity({ ...r, simulation: true }, role, SIMULATION_RUNTIME);
const routeOf = (routes: R[], id: string) => {
  const r = routes.find((x) => x.id === id);
  if (!r) throw new Error("no route " + id);
  return r;
};
export function pairOf(routes: R[], workerId: string, reviewerId: string, context: ExposedContext = NO_EXPOSURE): Arrangement {
  return {
    kind: "PAIR",
    worker: sim(routeOf(routes, workerId), "worker"),
    reviewer: sim(routeOf(routes, reviewerId), "reviewer"),
    protocolVersion: ADAPTIVE_PROTOCOL_VERSION,
    context,
  };
}
export function overseerOf(routes: R[], id: string, demand: "BOUNDED" | "MODULE" | "PROGRAMME", mode: "COORDINATION_ONLY" | "SUBSTANTIVE" = "COORDINATION_ONLY"): Arrangement {
  return { kind: "OVERSEER", overseer: sim(routeOf(routes, id), "overseer"), demand, mode };
}
export type Quality = "strong" | "good" | "fair" | "poor";
const wrongOf = (q: Quality) => ({ strong: 0, good: 3, fair: 8, poor: 18 })[q];
const pairGrades = (q: Quality, i: number) => {
  // strong: 20/20 correct; good: 17/20; fair: 12/20; poor: 2/20. All but
  // poor qualify under the test thresholds; strong and fair are
  // conclusively apart, strong and good are not; poor fails.
  const wrong = wrongOf(q);
  const ok = i >= wrong;
  return {
    firstDraftCorrect: ok,
    finalCorrect: ok,
    sourceFaithful: true,
    taskFit: true,
    seriousErrors: 0,
    reviewer: { seeded: 2, detected: 2, falsePositives: 0 },
  };
};
const overseerGrades = (q: Quality, i: number) => {
  const wrong = wrongOf(q);
  return { validCheckpoint: true, coordinationCorrect: i >= wrong, seriousErrors: 0 };
};
/** A frozen plan with these classes and finalists, and imported evidence at the given quality. */
export function seedEvidence(
  db: Persistence,
  classes: Array<{
    key: string;
    kind: "PAIR" | "OVERSEER";
    finalists: Array<{ arrangement: Arrangement; quality: Quality }>;
  }>,
  id = "test-plan",
  /** Import later, by calling importNow (a plan listed before its evidence). */
  options: { deferImport?: boolean } = {},
): { plan: EvaluationPlan; ref: { id: string; digest: string }; importNow: () => void } {
  const plan = EvaluationPlanSchema.parse({
    version: 1,
    id,
    purpose: "QUALIFICATION",
    classes: classes.map((c) => ({
      key: c.key,
      kind: c.kind,
      important: true,
      datasetDigest: HEX("d"),
      rubricDigest: HEX("b"),
      cases: Array.from({ length: 20 }, (_, i) => ({ caseId: "C" + (i + 1), caseInputDigest: digest(c.key + i) })),
      finalists: c.finalists.map((f) => f.arrangement),
    })),
    sampling: { stages: [20] },
    thresholds: {
      pair: {
        maxSeriousErrorRate: 0.3,
        minFinalCorrectRate: 0.3,
        minSourceFidelityRate: 0.3,
        minTaskFitRate: 0.3,
        minReviewerRecall: 0.3,
        maxFalsePositivesPerCase: 1,
      },
      overseer: { maxSeriousErrorRate: 0.3, minValidCheckpointRate: 0.3, minCoordinationCorrectRate: 0.3 },
    },
    decisionRuleVersion: 1,
    graders: [{ id: "grader-1", kind: "HUMAN", blinded: true }],
    rationale: "Synthetic test evidence; qualifies simulation tasks only.",
  });
  freezePlan(db, plan, "owner");
  const importNow = () => importEvidence(
    db,
    {
      version: 1,
      planId: plan.id,
      planDigest: planDigest(plan),
      phase: "QUALIFICATION",
      journalHead: HEX("0"),
      results: classes.flatMap((c) =>
        c.finalists.flatMap((f) =>
          Array.from({ length: 20 }, (_, i) => ({
            caseId: "C" + (i + 1),
            classKey: c.key,
            arrangementId: arrangementId(f.arrangement),
            fixtureId: randomUUID(),
            runs: { worker: [], reviewer: [], rework: [], overseer: [] },
            graderId: "grader-1",
            grades: c.kind === "PAIR" ? pairGrades(f.quality, i) : overseerGrades(f.quality, i),
          })),
        ),
      ),
      limitations: [],
    },
    { actor: "owner" },
  );
  if (!options.deferImport) importNow();
  return { plan, ref: { id: plan.id, digest: planDigest(plan) }, importNow };
}
/** The simulation adaptive policy, intake on, with these plans listed. */
export function adaptivePolicy(
  plans: Array<{ id: string; digest: string }>,
  options: { routes?: R[]; floorExceptions?: unknown[]; continuations?: number; preference?: "AUTO" | "GUIDED"; intake?: "ENABLED" | "DISABLED"; defaultMode?: "COORDINATION_ONLY" | "SUBSTANTIVE"; assessmentRequired?: boolean } = {},
): RoutingPolicy {
  const base = example();
  return RoutingPolicySchema.parse({
    ...base,
    ...(options.assessmentRequired === undefined ? {} : { assessmentRequired: options.assessmentRequired }),
    adaptive: {
      ...base.adaptive,
      intake: options.intake ?? "ENABLED",
      preference: options.preference ?? "AUTO",
      evaluationPlans: plans,
      floorExceptions: options.floorExceptions ?? [],
      ceiling: { continuations: options.continuations ?? 1 },
      oversight: { ...base.adaptive.oversight, defaultMode: options.defaultMode ?? "COORDINATION_ONLY" },
    },
    routes: options.routes ?? simulationRoutes(),
  });
}
