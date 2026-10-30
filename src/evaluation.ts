/**
 * The versioned quality-evaluation registry and harness of the adaptive
 * workflow (issue #12; implementation contract section 5). An owner-frozen
 * plan fixes the classes, matched case pools, finalist arrangements,
 * thresholds and stages before any result exists; an owner import checks a
 * bundle of graded results against an evaluation journal and records a
 * deterministic decision per class and arrangement. Nothing here runs a
 * provider: running cases on real providers is a paid evaluation that needs
 * the owner's separate command (acceptance matrix Gates 4A and 4B).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canonical, digest, specDigest, TaskSchema, type Task } from "./domain.js";
import { providerReceiptSchema } from "./providers.js";
import { OversightDemand, OversightMode, QUALITY_EFFORTS } from "./routing.js";
import type { Persistence } from "./store.js";
import { SqliteStore } from "./store.js";

/** Bumped when the harness's journal records change shape. */
export const EVALUATION_HARNESS_VERSION = 2;
/** The review, rework and reply protocol of this code (contract section 5.1). */
export const ADAPTIVE_PROTOCOL_VERSION = 1;
/** Wilson 95% intervals and set-based elimination (contract sections 5.4, 6). */
export const DECISION_RULE_VERSION = 1;
/**
 * What each provider's runs may do in their sandbox, per role. Bumped when
 * providers.ts changes a role's tools or isolation, so evidence measured
 * under other tools stops applying (QAL-06).
 */
export const TOOL_PROFILES: Record<string, Record<string, string>> = {
  codex: {
    worker: "codex-exec-workspace-write-1",
    reviewer: "codex-exec-read-only-1",
    overseer: "codex-exec-read-only-1",
    advisor: "codex-exec-read-only-1",
  },
  claude: {
    worker: "claude-file-tools-1",
    reviewer: "claude-read-tools-1",
    overseer: "claude-read-tools-1",
    advisor: "claude-read-tools-1",
  },
  mock: {
    worker: "mock-1",
    reviewer: "mock-1",
    overseer: "mock-1",
    advisor: "mock-1",
  },
};
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const ident = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const IdentityRole = z.enum(["worker", "reviewer", "overseer", "advisor"]);
export type IdentityRole = z.infer<typeof IdentityRole>;
/** The toolchain a candidate ran on (contract section 5.1; QAL-04, QAL-06). */
export const RuntimeSchema = z
  .object({
    cliVersion: z.string().min(1).max(200),
    executableDigest: hex.nullable(),
  })
  .strict();
export type Runtime = z.infer<typeof RuntimeSchema>;
/** A live receipt must identify its actual toolchain, never a placeholder. */
function hasRecordedRuntime(receipt: { provenance?: unknown }): boolean {
  const runtime = (receipt.provenance ?? {}) as { cliVersion?: unknown; executableDigest?: unknown };
  return typeof runtime.cliVersion === "string" && !!runtime.cliVersion.trim() &&
    runtime.cliVersion !== "unrecorded" && typeof runtime.executableDigest === "string" &&
    /^[a-f0-9]{64}$/.test(runtime.executableDigest);
}
/** The runtime of every simulation route and mock receipt. */
export const SIMULATION_RUNTIME: Runtime = {
  cliVersion: "simulation",
  executableDigest: null,
};
/** A candidate's identity: never its route ID or level (QAL-06). */
export const CandidateIdentitySchema = z
  .object({
    provider: z.enum(["codex", "claude", "mock"]),
    modelId: z.string().min(1).max(160),
    effort: z.string().min(1).max(20),
    role: IdentityRole,
    routeDefinitionDigest: hex,
    runtime: RuntimeSchema,
  })
  .strict();
export type CandidateIdentity = z.infer<typeof CandidateIdentitySchema>;
/** The digest of a route's definition for one role (contract section 5.1). */
export function routeDefinitionDigest(route: {
  provider: string;
  model: string;
  effort: string;
  simulation: boolean;
  role: string;
}): string {
  return digest({
    provider: route.provider,
    model: route.model,
    effort: route.effort,
    role: route.role,
    simulation: route.simulation,
    toolProfile: TOOL_PROFILES[route.provider]?.[route.role] ?? "unknown",
  });
}
/** A candidate identity from a route (or an attempt) and its runtime. */
export function candidateIdentity(
  route: {
    provider: string;
    model: string;
    effort: string;
    simulation: boolean;
  },
  role: IdentityRole,
  runtime: Runtime,
): CandidateIdentity {
  return CandidateIdentitySchema.parse({
    provider: route.provider,
    modelId: route.model,
    effort: route.effort,
    role,
    routeDefinitionDigest: routeDefinitionDigest({ ...route, role }),
    runtime: route.simulation ? SIMULATION_RUNTIME : runtime,
  });
}
const sortIdentities = (list: CandidateIdentity[]) =>
  [...new Map(list.map((i) => [canonical(i), i])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, i]) => i);
/** What a worker saw besides its own work (contract section 5.1). */
export const ExposedContextSchema = z
  .object({
    mode: OversightMode,
    producers: z.array(CandidateIdentitySchema).max(64),
  })
  .strict();
export type ExposedContext = z.infer<typeof ExposedContextSchema>;
export const NO_EXPOSURE: ExposedContext = {
  mode: "COORDINATION_ONLY",
  producers: [],
};
/** The canonical form of a context: producers sorted and de-duplicated. */
export function normalContext(context: ExposedContext): ExposedContext {
  return { mode: context.mode, producers: sortIdentities(context.producers) };
}
export const PairArrangementSchema = z
  .object({
    kind: z.literal("PAIR"),
    worker: CandidateIdentitySchema,
    reviewer: CandidateIdentitySchema,
    protocolVersion: z.number().int().positive(),
    context: ExposedContextSchema,
  })
  .strict();
export type PairArrangement = z.infer<typeof PairArrangementSchema>;
export const OverseerArrangementSchema = z
  .object({
    kind: z.literal("OVERSEER"),
    overseer: CandidateIdentitySchema,
    demand: OversightDemand,
    mode: OversightMode,
  })
  .strict();
export type OverseerArrangement = z.infer<typeof OverseerArrangementSchema>;
export const ArrangementSchema = z.discriminatedUnion("kind", [
  PairArrangementSchema,
  OverseerArrangementSchema,
]);
export type Arrangement = z.infer<typeof ArrangementSchema>;
/** An arrangement's stable ID: the digest of its canonical form. */
export function arrangementId(a: Arrangement): string {
  return digest(
    a.kind === "PAIR"
      ? { ...a, context: normalContext(a.context) }
      : a,
  );
}
/** Candidate efforts are the quality efforts; others are never finalists. */
const qualityIdentity = (i: CandidateIdentity) =>
  (QUALITY_EFFORTS as readonly string[]).includes(i.effort);

const PairThresholdsSchema = z
  .object({
    maxSeriousErrorRate: z.number().min(0).max(1),
    minFinalCorrectRate: z.number().min(0).max(1),
    minSourceFidelityRate: z.number().min(0).max(1),
    minTaskFitRate: z.number().min(0).max(1),
    minReviewerRecall: z.number().min(0).max(1),
    maxFalsePositivesPerCase: z.number().min(0).max(1000),
  })
  .strict();
const OverseerThresholdsSchema = z
  .object({
    maxSeriousErrorRate: z.number().min(0).max(1),
    minValidCheckpointRate: z.number().min(0).max(1),
    minCoordinationCorrectRate: z.number().min(0).max(1),
  })
  .strict();
const PlanClassSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9/_.-]{0,119}$/),
    kind: z.enum(["PAIR", "OVERSEER"]),
    important: z.boolean(),
    datasetDigest: hex,
    rubricDigest: hex,
    /** The ordered case pool; stages are prefixes of it (contract section 5.2). */
    cases: z
      .array(z.object({ caseId: ident, caseInputDigest: hex }).strict())
      .min(1)
      .max(1000),
    finalists: z.array(ArrangementSchema).min(1).max(50),
  })
  .strict();
export const EvaluationPlanSchema = z
  .object({
    version: z.literal(1),
    id: ident,
    purpose: z.enum(["PILOT", "QUALIFICATION"]),
    classes: z.array(PlanClassSchema).min(1).max(100),
    sampling: z.union([
      z.object({ pilot: z.object({ min: z.number().int(), max: z.number().int() }).strict() }).strict(),
      z.object({ stages: z.array(z.number().int().positive()).min(1).max(20) }).strict(),
    ]),
    thresholds: z
      .object({ pair: PairThresholdsSchema, overseer: OverseerThresholdsSchema })
      .strict(),
    decisionRuleVersion: z.literal(DECISION_RULE_VERSION),
    graders: z
      .array(
        z
          .object({
            id: ident,
            kind: z.enum(["OWNER", "HUMAN", "MODEL"]),
            blinded: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    rationale: z.string().trim().min(1).max(20_000),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    const stages =
      "stages" in plan.sampling ? plan.sampling.stages : undefined;
    const pilot = "pilot" in plan.sampling ? plan.sampling.pilot : undefined;
    // Owner decision 2: a pilot uses about 8 to 12 matched tasks and is
    // calibration only; qualification starts with 20 to 30 per class and
    // finalist arrangement and expands by a fixed step when uncertain.
    if (plan.purpose === "PILOT") {
      if (!pilot) issue("A pilot plan states pilot sampling");
      else if (!(8 <= pilot.min && pilot.min <= pilot.max && pilot.max <= 12))
        issue("Pilot sampling must lie within 8 to 12 matched cases");
    } else {
      if (!stages) issue("A qualification plan states its stages");
      else {
        if (!(stages[0]! >= 20 && stages[0]! <= 30))
          issue("The first qualification stage must be 20 to 30 matched cases");
        const steps = stages.slice(1).map((n, i) => n - stages[i]!);
        if (steps.some((s) => s <= 0 || s !== steps[0]))
          issue("Qualification stages grow by one fixed step");
      }
    }
    const cap = stages ? stages.at(-1)! : (pilot?.max ?? 0);
    const keys = new Set<string>();
    for (const c of plan.classes) {
      if (keys.has(c.key)) issue("Duplicate class key " + c.key);
      keys.add(c.key);
      if (new Set(c.cases.map((x) => x.caseId)).size !== c.cases.length)
        issue("Duplicate case IDs in " + c.key);
      if (c.cases.length < cap)
        issue(`Class ${c.key} has fewer cases than the sampling cap`);
      const ids = c.finalists.map(arrangementId);
      if (new Set(ids).size !== ids.length)
        issue("Duplicate finalist arrangements in " + c.key);
      for (const f of c.finalists) {
        if (f.kind !== c.kind) issue(`Finalist kind differs from class ${c.key}`);
        const identities =
          f.kind === "PAIR" ? [f.worker, f.reviewer] : [f.overseer];
        if (!identities.every(qualityIdentity))
          issue("Finalists use high, xhigh or max efforts");
        if (f.kind === "PAIR" && f.worker.provider === f.reviewer.provider)
          issue("A pair's reviewer is from the other provider");
        // Each identity is measured in its own role (review E2 F12).
        if (f.kind === "PAIR" && (f.worker.role !== "worker" || f.reviewer.role !== "reviewer"))
          issue("A pair's identities are a worker's and a reviewer's");
        if (f.kind === "OVERSEER" && f.overseer.role !== "overseer")
          issue("An overseer finalist's identity is an overseer's");
      }
    }
  });
export type EvaluationPlan = z.infer<typeof EvaluationPlanSchema>;
export const planDigest = (plan: EvaluationPlan) => digest(plan);

const RunRefSchema = z
  .object({ runId: z.string().min(1).max(100), receiptDigest: hex })
  .strict();
const PairGradesSchema = z
  .object({
    firstDraftCorrect: z.boolean(),
    finalCorrect: z.boolean(),
    sourceFaithful: z.boolean(),
    taskFit: z.boolean(),
    seriousErrors: z.number().int().min(0),
    reviewer: z
      .object({
        seeded: z.number().int().min(0),
        detected: z.number().int().min(0),
        falsePositives: z.number().int().min(0),
      })
      .strict()
      .refine((r) => r.detected <= r.seeded, "detected exceeds seeded"),
  })
  .strict();
const OverseerGradesSchema = z
  .object({
    validCheckpoint: z.boolean(),
    coordinationCorrect: z.boolean(),
    seriousErrors: z.number().int().min(0),
  })
  .strict();
const ResultSchema = z
  .object({
    caseId: ident,
    classKey: z.string().min(1).max(120),
    arrangementId: hex,
    fixtureId: z.string().uuid(),
    runs: z
      .object({
        worker: z.array(RunRefSchema).max(20),
        reviewer: z.array(RunRefSchema).max(20),
        rework: z.array(RunRefSchema).max(20),
        overseer: z.array(RunRefSchema).max(20),
      })
      .strict(),
    graderId: ident,
    grades: z.union([PairGradesSchema, OverseerGradesSchema]),
  })
  .strict();
export const EvaluationBundleSchema = z
  .object({
    version: z.literal(1),
    planId: ident,
    planDigest: hex,
    phase: z.enum(["PILOT", "QUALIFICATION"]),
    journalHead: hex,
    results: z.array(ResultSchema).min(1).max(100_000),
    limitations: z.array(z.string().max(2000)).max(100),
  })
  .strict();
export type EvaluationBundle = z.infer<typeof EvaluationBundleSchema>;
type PairGrades = z.infer<typeof PairGradesSchema>;
type OverseerGrades = z.infer<typeof OverseerGradesSchema>;

/** A 95% Wilson score interval for k successes in n trials. */
export function wilson(k: number, n: number): { point: number; low: number; high: number } {
  if (n <= 0) return { point: 0, low: 0, high: 1 };
  const z = 1.959963984540054;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    point: p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}
/** A mean with a normal 95% interval, clamped at zero (false positives per case). */
function meanInterval(values: number[]) {
  const n = values.length;
  if (!n) return { point: 0, low: 0, high: Infinity };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.959963984540054 * Math.sqrt(variance / n);
  return { point: mean, low: Math.max(0, mean - half), high: mean + half };
}
export type Interval = { point: number; low: number; high: number };
export type PairMetrics = {
  n: number;
  seriousErrorRate: Interval;
  finalCorrectRate: Interval;
  sourceFidelityRate: Interval;
  taskFitRate: Interval;
  reviewerRecall: Interval;
  falsePositivesPerCase: Interval;
  /** Reported, never ranked (QAL-03). */
  firstDraftCorrectRate: Interval;
  seededDefects: number;
};
export type OverseerMetrics = {
  n: number;
  seriousErrorRate: Interval;
  validCheckpointRate: Interval;
  coordinationCorrectRate: Interval;
};
export function pairMetrics(grades: PairGrades[]): PairMetrics {
  const n = grades.length;
  const count = (f: (g: PairGrades) => boolean) => grades.filter(f).length;
  const seeded = grades.reduce((a, g) => a + g.reviewer.seeded, 0);
  const detected = grades.reduce((a, g) => a + g.reviewer.detected, 0);
  return {
    n,
    seriousErrorRate: wilson(count((g) => g.seriousErrors > 0), n),
    finalCorrectRate: wilson(count((g) => g.finalCorrect), n),
    sourceFidelityRate: wilson(count((g) => g.sourceFaithful), n),
    taskFitRate: wilson(count((g) => g.taskFit), n),
    reviewerRecall: wilson(detected, seeded),
    falsePositivesPerCase: meanInterval(grades.map((g) => g.reviewer.falsePositives)),
    firstDraftCorrectRate: wilson(count((g) => g.firstDraftCorrect), n),
    seededDefects: seeded,
  };
}
export function overseerMetrics(grades: OverseerGrades[]): OverseerMetrics {
  const n = grades.length;
  const count = (f: (g: OverseerGrades) => boolean) => grades.filter(f).length;
  return {
    n,
    seriousErrorRate: wilson(count((g) => g.seriousErrors > 0), n),
    validCheckpointRate: wilson(count((g) => g.validCheckpoint), n),
    coordinationCorrectRate: wilson(count((g) => g.coordinationCorrect), n),
  };
}
export type Decision =
  | "CALIBRATION_ONLY"
  | "INSUFFICIENT"
  | "FAILED"
  | "UNCERTAIN"
  | "QUALIFIED";
/**
 * The deterministic decision for one class and arrangement (contract
 * section 5.4). Serious errors are judged at the interval's upper bound,
 * rates and recall at the lower bound, false positives at the point value.
 */
export function decide(
  plan: EvaluationPlan,
  kind: "PAIR" | "OVERSEER",
  metrics: PairMetrics | OverseerMetrics,
): { decision: Decision; reasons: string[] } {
  if (plan.purpose === "PILOT")
    return {
      decision: "CALIBRATION_ONLY",
      reasons: ["A pilot calibrates the plan; its results qualify no route (owner decision 2)"],
    };
  const first =
    "stages" in plan.sampling ? plan.sampling.stages[0]! : Infinity;
  if (metrics.n < first)
    return {
      decision: "INSUFFICIENT",
      reasons: [`${metrics.n} matched cases, below the first stage of ${first}`],
    };
  const reasons: string[] = [];
  let failed = false,
    uncertain = false;
  const atMost = (name: string, i: Interval, max: number) => {
    if (i.point > max) {
      failed = true;
      reasons.push(`${name} ${i.point.toFixed(3)} exceeds ${max}`);
    } else if (i.high > max) {
      uncertain = true;
      reasons.push(`${name} could be as high as ${i.high.toFixed(3)}, above ${max}`);
    }
  };
  const atLeast = (name: string, i: Interval, min: number) => {
    if (i.point < min) {
      failed = true;
      reasons.push(`${name} ${i.point.toFixed(3)} is below ${min}`);
    } else if (i.low < min) {
      uncertain = true;
      reasons.push(`${name} could be as low as ${i.low.toFixed(3)}, below ${min}`);
    }
  };
  if (kind === "PAIR") {
    const m = metrics as PairMetrics,
      t = plan.thresholds.pair;
    if (m.seededDefects === 0)
      return {
        decision: "INSUFFICIENT",
        reasons: ["No seeded defects, so reviewer recall was not measured"],
      };
    atMost("Serious-error rate", m.seriousErrorRate, t.maxSeriousErrorRate);
    atLeast("Final-correct rate", m.finalCorrectRate, t.minFinalCorrectRate);
    atLeast("Source fidelity", m.sourceFidelityRate, t.minSourceFidelityRate);
    atLeast("Task fit", m.taskFitRate, t.minTaskFitRate);
    atLeast("Reviewer recall", m.reviewerRecall, t.minReviewerRecall);
    if (m.falsePositivesPerCase.point > t.maxFalsePositivesPerCase) {
      failed = true;
      reasons.push(
        `False positives per case ${m.falsePositivesPerCase.point.toFixed(3)} exceed ${t.maxFalsePositivesPerCase}`,
      );
    }
  } else {
    const m = metrics as OverseerMetrics,
      t = plan.thresholds.overseer;
    atMost("Serious-error rate", m.seriousErrorRate, t.maxSeriousErrorRate);
    atLeast("Valid checkpoints", m.validCheckpointRate, t.minValidCheckpointRate);
    atLeast(
      "Coordination correct",
      m.coordinationCorrectRate,
      t.minCoordinationCorrectRate,
    );
  }
  return failed
    ? { decision: "FAILED", reasons }
    : uncertain
      ? { decision: "UNCERTAIN", reasons: [...reasons, "Expand the sample to the next stage"] }
      : { decision: "QUALIFIED", reasons: ["Every threshold passes at its interval bound"] };
}

export type FrozenPlan = { planId: string; planDigest: string; plan: EvaluationPlan; seq: number; at: string };
/** Every frozen plan in this database, by ID (event ADAPTIVE_EVALUATION_PLAN_FROZEN). */
export function frozenPlans(db: Persistence): Map<string, FrozenPlan> {
  const out = new Map<string, FrozenPlan>();
  for (const row of db.all<{ seq: number; at: string; body: string }>(
    "SELECT seq, at, body FROM events WHERE kind='ADAPTIVE_EVALUATION_PLAN_FROZEN' ORDER BY seq",
  )) {
    const body = JSON.parse(row.body);
    if (!out.has(body.planId))
      out.set(body.planId, {
        planId: body.planId,
        planDigest: body.planDigest,
        plan: EvaluationPlanSchema.parse(body.plan),
        seq: row.seq,
        at: row.at,
      });
  }
  return out;
}
/**
 * Freeze a plan (owner command). An ID is frozen once: the same bytes again
 * change nothing, other bytes under the same ID are refused.
 */
export function freezePlan(db: Persistence, value: unknown, actor: string) {
  const plan = EvaluationPlanSchema.parse(value);
  const d = planDigest(plan);
  return db.transaction(() => {
    const existing = frozenPlans(db).get(plan.id);
    if (existing) {
      if (existing.planDigest !== d) throw new Error("EVALUATION_PLAN_ID_REUSED:" + plan.id);
      return { planId: plan.id, planDigest: d, alreadyFrozen: true };
    }
    db.event("ADAPTIVE_EVALUATION_PLAN_FROZEN", null, {
      planId: plan.id,
      planDigest: d,
      plan,
      actor,
    });
    return { planId: plan.id, planDigest: d, alreadyFrozen: false };
  });
}

/** Owner and operator records that change a case's input after its fixture (contract section 5.3). */
const INPUT_CHANGING_EVENTS = new Set([
  "GRANT_RECORDED",
  "GRANT_REVOKED",
  "OWNER_DECISION",
  "DECISION_REVOKED",
  "SPECIFICATION_REVISED",
  "BUDGET_EXTENDED",
  "RETRY_ALLOWANCE_EXTENDED",
  "ASSESSMENT_WAIVED",
  "ASSESSMENT_RETRY",
  "MACRO_DRIFT_ACKNOWLEDGED",
  "REVIEW_HOLD_RESOLVED",
  "ACCEPTANCE_EVIDENCE_BOUND",
  "WORKFLOW_TASKS_ATTACHED",
  "WORKFLOW_TASKS_REBOUND",
  "WORKFLOW_QUESTION_DEFERRED",
  "KIND_BOUND",
  "EVALUATION_GUIDANCE_BOUND",
]);
type Reader = Pick<Persistence, "get" | "all">;
/**
 * Whether an evidence record is one the controller derived itself from a
 * run, review or command in the same database, which changes no case
 * input. Judged by the record it names and by the controller's exact shape
 * for it, every content field included, never by its ID alone: an owner
 * may choose any ID and any field (reviews E2 F6 and r2 N3).
 */
function controllerDerived(db: Reader, e: Record<string, any>): boolean {
  const id = String(e.id ?? "");
  const body = (sql: string, key: string) => {
    const row = db.get<{ body: string }>(sql, key);
    return row ? JSON.parse(row.body) : undefined;
  };
  // Only the timestamp is the envelope's own; every other field is the
  // controller's (review E2 r3 M3).
  const shaped = (fields: Record<string, unknown>) =>
    canonical(e) === canonical({ id, taskId: e.taskId, retrievedAt: e.retrievedAt, ...fields });
  const common = { authentication: "LOCAL_IMPORT", currentness: "CURRENT_AT_RETRIEVAL" };
  let m: RegExpExecArray | null;
  if ((m = /^output-(.+)$/.exec(id))) {
    const a = body("SELECT body FROM attempts WHERE id=?", m[1]!);
    const r = body("SELECT body FROM receipts WHERE attempt_id=?", m[1]!);
    return (
      !!a &&
      !!r &&
      a.taskId === e.taskId &&
      a.role === "worker" &&
      shaped({
        ...common,
        kind: "LOCAL",
        uri: "workspace:" + m[1],
        revision: a.artifactRevision,
        digest: digest(r.output),
        authorityTier: "IMPLEMENTATION",
        claims: ["Provider output captured; not independent verification"],
        metadata: { runId: m[1], simulation: r.simulation, workspaceDigest: a.workspaceDigest },
      })
    );
  }
  if ((m = /^review-(.+)$/.exec(id))) {
    const r = body("SELECT body FROM reviews WHERE id=?", m[1]!);
    if (!r || r.taskId !== e.taskId || typeof r.workerRunId !== "string") return false;
    const report = { ...r };
    for (const f of ["independence", "simulation", "at", "workspaceDigest", "evidenceDigest", "workerRunId"])
      delete report[f];
    return shaped({
      ...common,
      kind: "REVIEW",
      uri: "controller-review:" + r.id,
      revision: r.artifactRevision,
      digest: digest(report),
      retrievedAt: r.at,
      authorityTier: "REVIEW",
      claims: [
        "Controller-derived evidence of an authenticated reviewer report for this sealed worker artifact; not owner acceptance",
      ],
      metadata: {
        reviewId: r.id,
        reviewRunId: r.runId,
        reviewerSession: r.reviewerSession,
        provider: r.provider,
        specDigest: r.specDigest,
        workspaceDigest: r.workspaceDigest,
        workerRunId: r.workerRunId,
        simulation: r.simulation,
        independence: r.independence,
      },
    });
  }
  if ((m = /^drive-(.+)$/.exec(id))) {
    // The host's gateway record of the run, as the controller reads it.
    const a = body("SELECT body FROM attempts WHERE id=?", m[1]!);
    const r = body("SELECT body FROM receipts WHERE attempt_id=?", m[1]!);
    if (!a || !r || a.taskId !== e.taskId || a.role !== "worker") return false;
    try {
      const ref = String(r.provenance?.identityEvidenceRef ?? "");
      const found = /^file:(\/[^#]+)#sha256=([a-f0-9]{64})$/.exec(ref);
      if (!found) return false;
      const runBytes = readFileSync(found[1]!);
      if (digest(runBytes) !== found[2]) return false;
      const run = JSON.parse(runBytes.toString("utf8"));
      const auditDir = run.drive?.auditDir;
      if (run.runId !== m[1] || typeof auditDir !== "string") return false;
      const log = join(auditDir, "log.jsonl");
      const bytes: Buffer = existsSync(log) ? readFileSync(log) : Buffer.alloc(0);
      // Sealed in a later successful worker run of the same task, holding
      // the same record, if at all (review E2 r4 Q3).
      const sealedIn = e.metadata?.sealedIn;
      if (sealedIn !== undefined) {
        const later = body("SELECT body FROM attempts WHERE id=?", String(sealedIn));
        const order = (id: string) => db.get<{ rowid: number }>("SELECT rowid FROM attempts WHERE id=?", id)?.rowid ?? 0;
        if (
          !later ||
          sealedIn === m[1] ||
          later.taskId !== a.taskId ||
          later.role !== "worker" ||
          later.state !== "SUCCEEDED" ||
          order(String(sealedIn)) <= order(m[1]!)
        )
          return false;
        const copy = join(later.workspace, "drive-changes", m[1]!, "log.jsonl");
        if (!existsSync(copy) || !readFileSync(copy).equals(bytes)) return false;
      }
      return shaped({
        ...common,
        kind: "DRIVE",
        uri: "drive-gateway:" + m[1],
        revision: a.artifactRevision,
        digest: digest(bytes),
        authorityTier: "IMPLEMENTATION",
        claims: [
          "Host-side Drive gateway record of the worker's Drive calls, with before/after/uploaded copies; Drive was not re-read",
        ],
        metadata: {
          runId: m[1],
          workspaceDigest: a.workspaceDigest,
          ...(e.metadata?.sealedIn !== undefined ? { sealedIn: e.metadata.sealedIn } : {}),
          auditDir,
          runEvidenceRef: ref,
          writes: run.drive.writes ?? [],
        },
      });
    } catch {
      return false;
    }
  }
  if ((m = /^command-(.+)$/.exec(id))) {
    const c = db.get<{ task_id: string; body: string }>(
      "SELECT task_id, body FROM command_receipts WHERE id=?",
      m[1]!,
    );
    if (!c || c.task_id !== e.taskId) return false;
    const receipt = JSON.parse(c.body);
    const task = body("SELECT body FROM tasks WHERE id=?", c.task_id);
    const checked = body("SELECT body FROM attempts WHERE id=?", String(receipt.workerAttemptId ?? ""));
    if (!checked) return false;
    return shaped({
      ...common,
      kind: "TEST_RECEIPT",
      uri: "controller-command:" + m[1],
      revision: checked.artifactRevision,
      digest: digest(receipt),
      retrievedAt: receipt.endedAt,
      authorityTier: "IMPLEMENTATION",
      claims: [receipt.name + ":" + (receipt.passed ? "PASS" : "FAIL")],
      metadata: { receiptId: m[1], simulation: !!task?.simulation },
    });
  }
  return false;
}
/** The orchestrator's own question keys (RESERVED_QUESTION_KEYS): runs and steps ask them. */
const RUN_QUESTION_KEYS = [
  "adaptive-routing:",
  "proposal-question:",
  "worker-question:",
  "worker-operator-question:",
  "overseer-question:",
  "overseer-operator-question:",
  "pre-design-question:",
];
export const runQuestionKeysForTest = RUN_QUESTION_KEYS;

/**
 * A case's normalized fixture (contract section 5.2): everything seeded for
 * it before any arrangement runs, with identity and routing fields replaced
 * by case-local ordinals, so the same case run under different arrangements
 * has the same input. Ordinals follow the order the harness lists the
 * case's tasks and requests in, never their generated IDs; they replace
 * identity fields only, never text; and every record keeps the task it
 * belongs to (review E2 F7 to F9).
 */
export function normalizedFixture(input: {
  requests: Array<{ id: string; prompt: string; inputDigest?: string; sourceRef?: string }>;
  tasks: Task[];
  grants: Array<Record<string, any>>;
  decisions: Array<Record<string, any>>;
  evidence: Array<Record<string, any>>;
  /**
   * Each task's specification digests in the order they held, oldest first,
   * ending with the current one: a question's or answer's binding to a
   * specification is kept as its place in that order (review E2 r4 Q6).
   */
  specHistory?: Record<string, string[]>;
  /** The requests' questions as they stood, with their answers and deferrals (reviews E2 r2 N2, r3 M4). */
  questions?: Array<{
    question: Record<string, any>;
    answers: Array<Record<string, any>>;
    deferrals: Array<Record<string, any>>;
  }>;
  /** Frozen work-type behavior and the exact role guidance, including owner rules. */
  workKinds?: Array<{
    taskId: string;
    kind: string;
    settings: Record<string, any>;
    guidance: Record<string, string>;
  }>;
  scriptedAnswers: Array<{ questionKey: string; text: string }>;
}) {
  const strip = (
    record: Record<string, any>,
    fields: string[],
  ): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([k]) => !fields.includes(k)));
  const ordinals = (ids: string[], prefix: string) =>
    new Map(ids.map((id, i) => [id, "<" + prefix + (i + 1) + ">"]));
  const byContent = (a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b));
  const tasks = ordinals(input.tasks.map((t) => t.id), "T");
  const task = (id: unknown) => (typeof id === "string" && tasks.get(id)) || id;
  // A request's generated identities (its ID and input digest) are replaced
  // in the identity fields that carry them: an owner-source envelope's URI,
  // revision and metadata, and a task source's revision; never in text
  // (reviews E2 r2 N7 and r3 M2). That comes before evidence is ordered, so
  // the order never depends on them (r4 Q4).
  const requestIds = new Map<string, string>();
  const inputDigests = new Map<string, string>();
  input.requests.forEach((r, i) => {
    requestIds.set(r.id, "<R" + (i + 1) + ">");
    if (r.inputDigest) inputDigests.set(r.inputDigest, "<R" + (i + 1) + ".input>");
  });
  const requestUri = (uri: unknown) => {
    const m = typeof uri === "string" ? /^orchestrator-request:(.+)$/.exec(uri) : null;
    return m && requestIds.has(m[1]!) ? "orchestrator-request:" + requestIds.get(m[1]!) : uri;
  };
  const inputRevision = (revision: unknown) =>
    (typeof revision === "string" && inputDigests.get(revision)) || revision;
  const requestFields = (e: Record<string, any>) => ({
    ...e,
    uri: requestUri(e.uri),
    revision: inputRevision(e.revision),
    ...(e.metadata && typeof e.metadata === "object"
      ? {
          metadata: {
            ...e.metadata,
            ...(typeof e.metadata.requestId === "string" && requestIds.has(e.metadata.requestId)
              ? { requestId: requestIds.get(e.metadata.requestId) }
              : {}),
          },
        }
      : {}),
  });
  // Ordered source/answer positions distinguish otherwise equal envelopes.
  // Supersession is a forest (one predecessor per envelope). Canonicalize
  // the entire forest, not just immediate predecessor content: equal roots
  // with differently referenced descendants are not interchangeable (X1).
  const references = new Map<string, string[]>();
  const reference = (id: unknown, position: string) => {
    if (typeof id !== "string") return;
    const positions = references.get(id) ?? [];
    positions.push(position);
    references.set(id, positions);
  };
  input.tasks.forEach((t) => t.sources.forEach((s, i) => reference(s.evidenceId, "source:" + task(t.id) + ":" + i)));
  (input.questions ?? []).forEach(({ answers }, q) => answers.forEach((a, i) => {
    if (Array.isArray(a.evidence))
      a.evidence.forEach((id: unknown, j: number) => reference(id, "answer:" + q + ":" + i + ":" + j));
  }));
  const envelopes = input.evidence.map((e) => ({
      id: String(e.id),
      supersedes: e.supersedes as string | undefined,
      rest: requestFields({ ...strip(e, ["id", "taskId", "retrievedAt", "supersedes"]), taskId: task(e.taskId) }),
      referrers: (references.get(String(e.id)) ?? []).sort(),
    }));
  type Envelope = (typeof envelopes)[number];
  const byId = new Map(envelopes.map((e) => [e.id, e]));
  if (byId.size !== envelopes.length) throw new Error("EVALUATION_EVIDENCE_ID_DUPLICATE");
  const children = new Map<string, Envelope[]>();
  for (const e of envelopes)
    if (e.supersedes && byId.has(e.supersedes)) {
      const descendants = children.get(e.supersedes) ?? [];
      descendants.push(e);
      children.set(e.supersedes, descendants);
    }
  const roots = envelopes.filter((e) => !e.supersedes || !byId.has(e.supersedes));
  const signatures = new Map<string, string>();
  const pending = roots.map((e) => ({ e, visited: false }));
  while (pending.length) {
    const { e, visited } = pending.pop()!;
    const descendants = children.get(e.id) ?? [];
    if (!visited) {
      pending.push({ e, visited: true });
      for (const child of descendants) pending.push({ e: child, visited: false });
    } else
      signatures.set(e.id, digest([
        e.rest, e.referrers,
        e.supersedes && !byId.has(e.supersedes) ? e.supersedes : null,
        descendants.map((child) => signatures.get(child.id)!).sort(),
      ]));
  }
  // A cycle has no root and cannot occur through append-only supersession.
  if (signatures.size !== envelopes.length) throw new Error("EVALUATION_EVIDENCE_SUPERSESSION_CYCLE");
  const ordered = (list: Envelope[]) => [...list].sort((a, b) => signatures.get(a.id)!.localeCompare(signatures.get(b.id)!));
  const evidence: Envelope[] = [];
  const traversal = ordered(roots).reverse();
  while (traversal.length) {
    const e = traversal.pop()!;
    evidence.push(e);
    for (const child of ordered(children.get(e.id) ?? []).reverse()) traversal.push(child);
  }
  const evidenceIds = ordinals(evidence.map((e) => e.id), "E");
  const ev = (id: unknown) => (typeof id === "string" && evidenceIds.get(id)) || id;
  // A specification is the task's current one, or an earlier one a
  // question or answer refers to, numbered among those alone: history no
  // record refers to, such as a revision while the case was set up, leaves
  // no trace (review E2 r5 S3).
  const history = (taskId: string) => {
    const t = input.tasks.find((x) => x.id === taskId);
    return input.specHistory?.[taskId] ?? (t ? [specDigest(t)] : []);
  };
  const referenced = new Map<string, Set<string>>();
  const refer = (taskId: unknown, d: unknown) => {
    if (typeof taskId !== "string" || typeof d !== "string") return;
    referenced.set(taskId, (referenced.get(taskId) ?? new Set()).add(d));
  };
  for (const { question: q, answers } of input.questions ?? []) {
    if (q.taskId) refer(q.taskId, q.specDigest);
    for (const [id, d] of Object.entries((q.specDigests ?? {}) as Record<string, string>)) refer(id, d);
    for (const a of answers)
      for (const [id, d] of Object.entries((a.historicalForSpec ?? {}) as Record<string, string>)) refer(id, d);
  }
  const spec = (taskId: unknown, d: unknown) => {
    if (typeof taskId !== "string" || typeof d !== "string") return "<unknown specification>";
    const list = history(taskId);
    const i = list.indexOf(d);
    if (i < 0) return "<unknown specification>";
    if (i === list.length - 1) return task(taskId) + ".current";
    const earlier = list.slice(0, -1).filter((x) => referenced.get(taskId)?.has(x));
    return task(taskId) + ".earlier" + (earlier.indexOf(d) + 1);
  };
  const requestIdentity = <T extends Record<string, any>>(value: T) => ({
    ...value,
    tasks: value.tasks.map((t: Record<string, any>) => ({
      ...t,
      sources: t.sources.map((x: Record<string, any>) => ({ ...x, revision: inputRevision(x.revision) })),
    })),
  });
  // A question's tasks are a set: recorded in ID order, so their ordinals
  // are sorted (review E2 r5 S4).
  const scope = (q: Record<string, any>) =>
    [...new Set([...(q.taskId ? [q.taskId] : []), ...(Array.isArray(q.taskIds) ? q.taskIds : [])].map(task))].sort(
      (a, b) => String(a).localeCompare(String(b)),
    );
  return requestIdentity({
    requests: input.requests.map((r) => ({ prompt: r.prompt })),
    ...(input.workKinds?.length
      ? { workKinds: input.workKinds.map((k) => ({ ...k, taskId: task(k.taskId) })) }
      : {}),
    tasks: input.tasks.map((t) => ({
      ...strip(t as any, ["id", "providers", "status", "createdAt", "artifactRevision"]),
      dependencies: t.dependencies.map(task),
      sources: t.sources.map((s) => ({ ...s, evidenceId: ev(s.evidenceId) })),
      ...(t.fixes ? { fixes: task(t.fixes) } : {}),
    })),
    grants: input.grants
      .map((g) => ({
        ...strip(g, ["id", "taskId", "specDigest", "actor", "at", "recordedAt"]),
        taskId: task(g.taskId),
      }))
      .sort(byContent),
    decisions: input.decisions
      .map((d) => ({
        ...strip(d, ["id", "taskId", "specDigest", "artifactRevision", "supersedes", "actor", "at", "recordedAt"]),
        taskId: task(d.taskId),
      }))
      .sort(byContent),
    evidence: evidence.map((e) => ({
      ...e.rest,
      id: ev(e.id),
      ...(e.supersedes ? { supersedes: ev(e.supersedes) } : {}),
    })),
    questions: (input.questions ?? []).map(({ question: q, answers, deferrals }) => ({
      ...strip(q, ["id", "taskId", "taskIds", "specDigest", "specDigests", "actor", "createdAt", "askedBy"]),
      ...(q.askedBy ? { askedBy: "<run>" } : {}),
      tasks: scope(q),
      // The specification each covered task had when it was asked.
      askedOn: [
        ...(q.taskId ? [[task(q.taskId), spec(q.taskId, q.specDigest)]] : []),
        ...Object.entries((q.specDigests ?? {}) as Record<string, string>).map(([id, d]) => [task(id), spec(id, d)]),
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      // Everything an answer or deferral says, apart from its identity and
      // time; evidence it cites by ID, and the specifications it was
      // historical for, as ordinals (review E2 r4 Q5, Q6).
      answers: answers.map((a) => ({
        ...strip(a, ["questionId", "replyKey", "inputDigest", "actor", "createdAt", "historicalForSpec", "evidence"]),
        ...(Array.isArray(a.evidence) ? { evidence: a.evidence.map(ev) } : {}),
        ...(a.historicalForSpec
          ? {
              historicalFor: Object.entries(a.historicalForSpec as Record<string, string>)
                .map(([id, d]) => [task(id), spec(id, d)])
                .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
            }
          : {}),
      })),
      deferrals: deferrals.map((d) => strip(d, ["questionId", "inputDigest", "actor", "createdAt"])),
    })),
    scriptedAnswers: [...input.scriptedAnswers].sort((a, b) =>
      a.questionKey.localeCompare(b.questionKey),
    ),
  });
}

type JournalRow = { seq: number; at: string; kind: string; task_id: string | null; body: string; previous_hash: string; hash: string };
/** Read access to an evaluation journal, opened read-only: an import never writes to it. */
class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (!existsSync(path)) throw new Error("EVALUATION_JOURNAL_MISSING");
    this.db = new DatabaseSync(path, { readOnly: true });
  }
  all<T>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  get<T>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  events(): JournalRow[] {
    return this.all<JournalRow>("SELECT * FROM events ORDER BY seq");
  }
  close() {
    this.db.close();
  }
}
/** The event chain check of SqliteStore.verifyEvents, over a read-only journal. */
function verifyChain(rows: JournalRow[]): boolean {
  let previous = "GENESIS";
  for (const e of rows) {
    if (
      e.previous_hash !== previous ||
      e.hash !== digest({ prev: previous, at: e.at, kind: e.kind, taskId: e.task_id, body: e.body })
    )
      return false;
    previous = e.hash;
  }
  return true;
}
export type ImportedEvidence = {
  evidenceId: string;
  planId: string;
  planDigest: string;
  phase: "PILOT" | "QUALIFICATION";
  synthetic: boolean;
  journalHead: string;
  aggregates: Array<{
    classKey: string;
    kind: "PAIR" | "OVERSEER";
    arrangementId: string;
    arrangement: Arrangement;
    n: number;
    caseIds: string[];
    executions: Array<{ caseId: string; fixtureId: string; runIds: string[]; gradesDigest: string; taskIds?: string[] }>;
    metrics: PairMetrics | OverseerMetrics;
    decision: Decision;
    reasons: string[];
  }>;
  importedBy: string;
};
/** Every import recorded in this database, oldest first. */
export function importedEvidence(db: Persistence): Array<ImportedEvidence & { seq: number; at: string }> {
  return db
    .all<{ seq: number; at: string; body: string }>(
      "SELECT seq, at, body FROM events WHERE kind='ADAPTIVE_EVIDENCE_IMPORTED' ORDER BY seq",
    )
    .map((r) => ({ ...(JSON.parse(r.body) as ImportedEvidence), seq: r.seq, at: r.at }));
}

/**
 * An import may extend its own case executions, never regrade them or lend
 * their runs, fixtures or tasks to another case. Call inside the final write
 * transaction: validation before that transaction is only a stale snapshot
 * when another importer is running (whole-PR review Z4).
 */
function assertImportContinuity(earlier: ImportedEvidence[], record: ImportedEvidence) {
  const resources = new Map<string, string>();
  const priorCases = new Map<string, ImportedEvidence["aggregates"][number]["executions"][number]>();
  const keys = (ex: ImportedEvidence["aggregates"][number]["executions"][number]) => [
    "fixture:" + ex.fixtureId,
    ...ex.runIds.map((id) => "run:" + id),
    ...(ex.taskIds ?? []).map((id) => "task:" + id),
  ];
  for (const prior of earlier.filter((e) => e.planId === record.planId))
    for (const a of prior.aggregates)
      for (const ex of a.executions) {
        const owner = canonical([a.classKey, a.arrangementId, ex.caseId]);
        const previous = priorCases.get(owner);
        if (previous && canonical(previous) !== canonical(ex))
          throw new Error("STAGE_REWRITES_CASES:" + ex.caseId);
        priorCases.set(owner, ex);
        for (const key of keys(ex)) {
          const previousOwner = resources.get(key);
          if (previousOwner !== undefined && previousOwner !== owner)
            throw new Error("CASE_EXECUTION_REUSED:" + key);
          resources.set(key, owner);
        }
      }
  for (const a of record.aggregates)
    for (const ex of a.executions) {
      const owner = canonical([a.classKey, a.arrangementId, ex.caseId]);
      const previous = priorCases.get(owner);
      if (previous && canonical(previous) !== canonical(ex))
        throw new Error("STAGE_REWRITES_CASES:" + ex.caseId);
      for (const key of keys(ex)) {
        const previousOwner = resources.get(key);
        if (previousOwner !== undefined && previousOwner !== owner)
          throw new Error("CASE_EXECUTION_REUSED:" + key);
        resources.set(key, owner);
      }
    }
}

/**
 * Check and record an evidence bundle (owner command; contract section 5.3).
 * Every check must pass or nothing is written. `synthetic` is computed from
 * the journal's own receipts, never read from the bundle.
 */
export function importEvidence(
  db: Persistence,
  value: unknown,
  options: { journalPath?: string; actor: string },
): ImportedEvidence {
  const bundle = EvaluationBundleSchema.parse(value);
  const evidenceId = digest(bundle);
  const frozen = frozenPlans(db).get(bundle.planId);
  if (!frozen) throw new Error("EVALUATION_PLAN_NOT_FROZEN:" + bundle.planId);
  if (frozen.planDigest !== bundle.planDigest)
    throw new Error("EVALUATION_PLAN_DIGEST_MISMATCH");
  const plan = frozen.plan;
  if (plan.purpose !== bundle.phase)
    throw new Error("EVALUATION_PHASE_MISMATCH: plan " + plan.purpose + ", bundle " + bundle.phase);
  const earlier = importedEvidence(db);
  const same = earlier.find((e) => e.evidenceId === evidenceId);
  if (same) return same;
  const classes = new Map(plan.classes.map((c) => [c.key, c]));
  const graders = new Set(plan.graders.map((g) => g.id));
  // 3. Matched, staged cases: every finalist has exactly the same prefix.
  const byClass = new Map<string, typeof bundle.results>();
  for (const r of bundle.results) {
    const c = classes.get(r.classKey);
    if (!c) throw new Error("EVALUATION_CLASS_UNKNOWN:" + r.classKey);
    if (!c.finalists.some((f) => arrangementId(f) === r.arrangementId))
      throw new Error("EVALUATION_ARRANGEMENT_NOT_FINALIST:" + r.arrangementId);
    if (!graders.has(r.graderId)) throw new Error("EVALUATION_GRADER_UNKNOWN:" + r.graderId);
    const pairGrades = PairGradesSchema.safeParse(r.grades).success;
    if (pairGrades !== (c.kind === "PAIR")) throw new Error("EVALUATION_GRADES_KIND_MISMATCH");
    byClass.set(r.classKey, [...(byClass.get(r.classKey) ?? []), r]);
  }
  const sampling = plan.sampling;
  const stageSizes =
    "stages" in sampling
      ? sampling.stages
      : ((pilot) =>
          Array.from({ length: pilot.max - pilot.min + 1 }, (_, i) => pilot.min + i))(
          sampling.pilot,
        );
  for (const [key, results] of byClass) {
    const c = classes.get(key)!;
    const ids = c.finalists.map(arrangementId);
    let n: number | undefined;
    for (const id of ids) {
      const cases = results.filter((r) => r.arrangementId === id).map((r) => r.caseId);
      if (n === undefined) n = cases.length;
      const prefix = c.cases.slice(0, n).map((x) => x.caseId);
      if (cases.length !== n || canonical([...cases].sort()) !== canonical([...prefix].sort()))
        throw new Error("UNMATCHED_CASES:" + key);
    }
    if (!stageSizes.includes(n!)) throw new Error("UNMATCHED_CASES: " + n + " is not a stage of " + key);
  }
  // 5. The journal: chain, head, plan binding, one input-bound execution per case.
  let synthetic = !options.journalPath;
  type Execution = ImportedEvidence["aggregates"][number]["executions"][number];
  const executions = new Map<string, Execution>();
  // Executions are per class: two classes may share case IDs (review E2 F10).
  const executionKey = (classKey: string, caseId: string, arrangement: string) =>
    canonical([classKey, caseId, arrangement]);
  const gradesDigest = (r: (typeof bundle.results)[number]) =>
    digest({ graderId: r.graderId, grades: r.grades });
  if (options.journalPath) {
    const journal = new Journal(options.journalPath);
    try {
      const rows = journal.events();
      if (!verifyChain(rows)) throw new Error("EVALUATION_JOURNAL_CHAIN_BROKEN");
      if (rows.at(-1)?.hash !== bundle.journalHead) throw new Error("EVALUATION_JOURNAL_HEAD_MISMATCH");
      const first = rows[0];
      const binding = first && JSON.parse(first.body);
      if (
        first?.kind !== "ADAPTIVE_EVALUATION_HARNESS" ||
        binding.planId !== plan.id ||
        binding.planDigest !== frozen.planDigest ||
        binding.harnessVersion !== EVALUATION_HARNESS_VERSION
      )
        throw new Error("EVALUATION_JOURNAL_NOT_BOUND_TO_PLAN");
      // Thresholds and rules are fixed before any result exists: nothing in
      // the journal may predate the plan's freeze here (contract section 5.2).
      if (first.at < frozen.at) throw new Error("EVALUATION_RESULT_BEFORE_FREEZE");
      const fixtures = new Map<string, { seq: number; at: string; body: any }>();
      for (const r of rows)
        if (r.kind === "ADAPTIVE_EVALUATION_CASE_FIXTURE") {
          const body = JSON.parse(r.body);
          fixtures.set(body.fixtureId, { seq: r.seq, at: r.at, body });
        }
      const chained = chainedRuns(rows, journal);
      const checkpointPins = new Map<string, { demand: string; mode: string }>(
        rows
          .filter((e) => e.kind === "ADAPTIVE_CHECKPOINT_PINNED")
          .map((e) => JSON.parse(e.body))
          .map((pin) => [pin.pinId, pin]),
      );
      const usedFixtures = new Set<string>(),
        usedRuns = new Set<string>(),
        usedTasks = new Set<string>();
      // An execution an earlier import of this plan cited stays that case's:
      // another class, arrangement or case cannot cite it (review E2 r3 M6).
      const citedBefore = new Map<string, string>();
      for (const prior of earlier.filter((e) => e.planId === plan.id))
        for (const a of prior.aggregates)
          for (const ex of a.executions) {
            const owner = canonical([a.classKey, a.arrangementId, ex.caseId]);
            citedBefore.set("fixture:" + ex.fixtureId, owner);
            for (const id of ex.runIds) citedBefore.set("run:" + id, owner);
            for (const id of ex.taskIds ?? []) citedBefore.set("task:" + id, owner);
          }
      const reusedElsewhere = (key: string, r: (typeof bundle.results)[number]) => {
        const owner = citedBefore.get(key);
        return owner !== undefined && owner !== canonical([r.classKey, r.arrangementId, r.caseId]);
      };
      for (const r of bundle.results) {
        const c = classes.get(r.classKey)!;
        const arrangement = c.finalists.find((f) => arrangementId(f) === r.arrangementId)!;
        // The executions ran under this arrangement's protocol (review E2 F11).
        if (arrangement.kind === "PAIR" && arrangement.protocolVersion !== binding.protocolVersion)
          throw new Error("EVALUATION_PROTOCOL_MISMATCH:" + r.caseId);
        const fixture = fixtures.get(r.fixtureId);
        if (!fixture) throw new Error("CASE_FIXTURE_MISSING:" + r.caseId);
        const planCase = c.cases.find((x) => x.caseId === r.caseId)!;
        if (
          fixture.body.caseId !== r.caseId ||
          fixture.body.classKey !== r.classKey ||
          fixture.body.arrangementId !== r.arrangementId ||
          fixture.body.fixtureDigest !== planCase.caseInputDigest ||
          digest(fixture.body.fixture) !== fixture.body.fixtureDigest
        )
          throw new Error("CASE_INPUT_MISMATCH:" + r.caseId);
        if (usedFixtures.has(r.fixtureId) || reusedElsewhere("fixture:" + r.fixtureId, r))
          throw new Error("CASE_EXECUTION_REUSED:" + r.caseId);
        usedFixtures.add(r.fixtureId);
        const taskIds: string[] = fixture.body.taskIds;
        const requestIds: string[] = fixture.body.requestIds;
        for (const id of taskIds) {
          if (usedTasks.has(id) || reusedElsewhere("task:" + id, r)) throw new Error("CASE_EXECUTION_REUSED:" + id);
          usedTasks.add(id);
        }
        // A case task's Drive content is downloaded when its runs start, so
        // it is not part of the fixture and executions could be given
        // different bytes: such cases are refused (review E2 r6 U2).
        for (const id of taskIds) {
          const row = journal.get<{ body: string }>("SELECT body FROM tasks WHERE id=?", id);
          if (row && JSON.parse(row.body).drive) throw new Error("EVALUATION_CASE_DRIVE_UNSUPPORTED:" + r.caseId);
        }
        // A case's tasks are fresh: no run of them before the fixture, whose
        // work a later run could take over (review E2 r4 Q1).
        for (const run of chained.values())
          if (taskIds.includes(run.decision.taskId) && run.seq < fixture.seq && !run.notStarted)
            throw new Error("CASE_TASK_RAN_BEFORE_FIXTURE:" + r.caseId);
        // What actually ran matches the fixture: each task as recorded now
        // (its specification unrevised) normalizes back to the fixture, and
        // no owner or operator record reached the execution afterwards,
        // apart from a scripted answer the fixture declared.
        const recomputed = fixtureOf(journal, taskIds, requestIds, fixture.body.fixture.scriptedAnswers ?? [], fixture.seq);
        if (digest(recomputed) !== fixture.body.fixtureDigest)
          throw new Error("CASE_INPUT_MISMATCH:" + r.caseId);
        // Each role's exact guidance is recorded by the controller from the
        // same bytes it places in the brief. Profile edits and owner-rule
        // edits between matched executions cannot disappear from the input
        // comparison (review E2 r7 X2). Advisors count as inputs as well.
        const workKinds = new Map(
          (recomputed.workKinds ?? []).map((k: any) => [k.taskId, k] as const),
        );
        for (const run of chained.values()) {
          const taskIndex = taskIds.indexOf(run.decision.taskId);
          if (taskIndex < 0 || run.seq <= fixture.seq || !run.executed || run.notStarted) continue;
          const kind = workKinds.get("<T" + (taskIndex + 1) + ">") as { guidance: Record<string, string> } | undefined;
          if (!kind || !["worker", "reviewer", "advisor"].includes(run.decision.role)) continue;
          const actual = rows
            .filter((e) => e.kind === "EVALUATION_RUN_GUIDANCE" && e.task_id === run.decision.taskId && e.seq > run.seq)
            .map((e) => JSON.parse(e.body))
            .filter((e) => e.runId === run.decision.runId);
          if (actual.length !== 1 || actual[0].guidance !== kind.guidance[run.decision.role])
            throw new Error("CASE_INPUT_MISMATCH:" + r.caseId + ":WORK_KIND_GUIDANCE");
        }
        const scripted = new Set(
          (fixture.body.fixture.scriptedAnswers ?? []).map((a: any) => canonical([a.questionKey, a.text])),
        );
        for (const e of rows) {
          if (e.seq <= fixture.seq) continue;
          const body = JSON.parse(e.body);
          // A record of the case's tasks or requests, or one binding a case
          // task to any request (review E2 F4).
          const ofCase =
            (e.task_id && taskIds.includes(e.task_id)) ||
            (body?.requestId && requestIds.includes(body.requestId)) ||
            (Array.isArray(body?.bindings) &&
              body.bindings.some((b: any) => taskIds.includes(b?.taskId)));
          if (!ofCase) continue;
          if (INPUT_CHANGING_EVENTS.has(e.kind))
            throw new Error("CASE_INPUT_CHANGED:" + r.caseId + ":" + e.kind);
          if (e.kind === "EVIDENCE_APPENDED") {
            const row = journal.get<{ task_id: string; body: string }>(
              "SELECT task_id, body FROM evidence WHERE id=?",
              String(body.id),
            );
            if (!row || !controllerDerived(journal, { ...JSON.parse(row.body), taskId: row.task_id }))
              throw new Error("CASE_INPUT_CHANGED:" + r.caseId + ":EVIDENCE_APPENDED");
          }
          // A question the owner or operator asks after the fixture is new
          // input; one a run or a controller step asks is the execution's.
          if (
            e.kind === "WORKFLOW_QUESTION" &&
            !body.question?.askedBy &&
            !RUN_QUESTION_KEYS.some((k) => String(body.question?.key ?? "").startsWith(k))
          )
            throw new Error("CASE_INPUT_CHANGED:" + r.caseId + ":WORKFLOW_QUESTION");
          if (e.kind === "WORKFLOW_REPLY") {
            const reply = body.reply ?? {};
            const question = rows
              .filter((q) => q.kind === "WORKFLOW_QUESTION")
              .map((q) => JSON.parse(q.body).question)
              .find((q: any) => q?.id === reply.questionId);
            if (!scripted.has(canonical([question?.key, reply.text])))
              throw new Error("CASE_INPUT_CHANGED:" + r.caseId + ":WORKFLOW_REPLY");
          }
        }
        // The execution's runs are every successful run of its tasks, as the
        // journal's own records list them, none left out and none added, and
        // they include the arrangement's own roles (review E2 F1).
        const listed = executionRuns(journal, chained, taskIds, fixture.seq);
        if (canonical(listed) !== canonical(r.runs))
          throw new Error("EVALUATION_RUNS_INCOMPLETE:" + r.caseId);
        const succeeded = (refs: Array<{ runId: string }>) =>
          refs.some((x) => chained.get(x.runId)?.executed?.status === "SUCCEEDED");
        if (
          arrangement.kind === "PAIR"
            ? !succeeded([...listed.worker, ...listed.rework]) || !succeeded(listed.reviewer)
            : !succeeded(listed.overseer)
        )
          throw new Error("EVALUATION_EXECUTION_EMPTY:" + r.caseId);
        const runIds: string[] = [];
        const slots: Array<[keyof typeof r.runs, IdentityRole]> = [
          ["worker", "worker"],
          ["rework", "worker"],
          ["reviewer", "reviewer"],
          ["overseer", "overseer"],
        ];
        for (const [slot, role] of slots)
          for (const ref of r.runs[slot]) {
            if (usedRuns.has(ref.runId) || reusedElsewhere("run:" + ref.runId, r))
              throw new Error("CASE_EXECUTION_REUSED:" + ref.runId);
            usedRuns.add(ref.runId);
            runIds.push(ref.runId);
            const chainedRun = chained.get(ref.runId);
            if (
              !chainedRun ||
              !taskIds.includes(chainedRun.decision.taskId) ||
              chainedRun.decision.role !== role ||
              chainedRun.seq <= fixture.seq
            )
              throw new Error("EVALUATION_RUN_OUTSIDE_EXECUTION:" + ref.runId);
            if (chainedRun.at < frozen.at) throw new Error("EVALUATION_RESULT_BEFORE_FREEZE:" + ref.runId);
            // Every run is routed on the specification the fixture recorded
            // (review E2 r2 N1).
            if (fixture.body.specDigests?.[chainedRun.decision.taskId] !== chainedRun.decision.specDigest)
              throw new Error("CASE_INPUT_MISMATCH:" + r.caseId + ":SPECIFICATION");
            const run = verifiedRun(journal, chainedRun);
            if (digest(run.receiptBody) !== ref.receiptDigest)
              throw new Error("EVALUATION_RUN_UNVERIFIED:" + ref.runId);
            // What a run saw of a project is exactly the fixture's project
            // (reviews E2 F4 and r2 N2).
            if (run.projectContext) {
              const seen = new Set((run.projectContext.snapshot?.tasks ?? []).map((x: any) => x?.task?.id));
              if (
                !requestIds.includes(run.projectContext.requestId) ||
                seen.size !== taskIds.length ||
                taskIds.some((id) => !seen.has(id))
              )
                throw new Error("CASE_INPUT_MISMATCH:" + r.caseId + ":PROJECT_CONTEXT");
            }
            // Any simulated, mock or unverified run makes the evidence synthetic.
            if (
              chainedRun.decision.simulation ||
              run.receipt.simulation !== false ||
              chainedRun.decision.provider === "mock" ||
              run.receipt.identityVerified !== true
            )
              synthetic = true;
            // The arrangement's own roles are measured; the others support
            // the execution, such as a pair case's checkpoint overseer (N5).
            const expected =
              arrangement.kind === "PAIR"
                ? role === "worker"
                  ? arrangement.worker
                  : role === "reviewer"
                    ? arrangement.reviewer
                    : undefined
                : role === "overseer"
                  ? arrangement.overseer
                  : undefined;
            // Missing runtime provenance is missing for a successful run
            // too. A placeholder runtime must never qualify a live route
            // (review E2 r7 X3); supporting roles are subject to this as well.
            const recorded = (run.receipt.provenance ?? {}) as { cliVersion?: unknown; executableDigest?: unknown };
            if (!chainedRun.decision.simulation && !hasRecordedRuntime(run.receipt))
              synthetic = true;
            if (!expected) continue;
            // The run's own role and identity, never the arrangement's claim
            // (F12). A run that ended without success may record no runtime:
            // only what it did not record is taken as expected, for its
            // other fields; whatever it recorded must match (reviews E2 r4
            // Q2, r5 S2). A runtime it did not record is not shown to be the
            // arrangement's, so the evidence is synthetic (r6 U1).
            const measured =
              chainedRun.executed?.status === "SUCCEEDED" || chainedRun.decision.simulation
                ? run.identity
                : {
                    ...run.identity,
                    runtime: {
                      ...expected.runtime,
                      ...(typeof recorded.cliVersion === "string" && recorded.cliVersion ? { cliVersion: recorded.cliVersion } : {}),
                      ...(typeof recorded.executableDigest === "string" ? { executableDigest: recorded.executableDigest } : {}),
                    },
                  };
            if (canonical(measured) !== canonical(expected))
              throw new Error("EVALUATION_RUN_IDENTITY_MISMATCH:" + ref.runId);
            // An overseer was measured under the demand and mode its own
            // checkpoint pin sealed (review E2 r2 N9).
            if (arrangement.kind === "OVERSEER") {
              const pinId = chainedRun.decision.routing?.adaptive?.checkpointPinId;
              const pin = pinId ? checkpointPins.get(pinId) : undefined;
              if (!pin || pin.demand !== arrangement.demand || pin.mode !== arrangement.mode)
                throw new Error("EVALUATION_OVERSEER_CONDITIONS_UNVERIFIED:" + ref.runId);
            }
          }
        if (arrangement.kind === "PAIR") {
          const context = executedContext(
            journal,
            chained,
            r.runs.worker.concat(r.runs.rework).map((x) => x.runId),
            taskIds,
          );
          if (context.synthetic) synthetic = true;
          if (canonical(normalContext(context)) !== canonical(normalContext(arrangement.context)))
            throw new Error("EVALUATION_CONTEXT_MISMATCH:" + r.caseId);
        }
        executions.set(executionKey(r.classKey, r.caseId, r.arrangementId), {
          caseId: r.caseId,
          fixtureId: r.fixtureId,
          runIds,
          gradesDigest: gradesDigest(r),
          taskIds,
        });
      }
    } finally {
      journal.close();
    }
  } else
    for (const r of bundle.results)
      executions.set(executionKey(r.classKey, r.caseId, r.arrangementId), {
        caseId: r.caseId,
        fixtureId: r.fixtureId,
        runIds: Object.values(r.runs).flat().map((x) => x.runId),
        gradesDigest: gradesDigest(r),
      });
  // Aggregates and decisions, per class and arrangement.
  const aggregates: ImportedEvidence["aggregates"] = [];
  for (const [key, results] of byClass) {
    const c = classes.get(key)!;
    for (const f of c.finalists) {
      const id = arrangementId(f);
      const mine = results.filter((r) => r.arrangementId === id);
      const metrics =
        c.kind === "PAIR"
          ? pairMetrics(mine.map((r) => r.grades as PairGrades))
          : overseerMetrics(mine.map((r) => r.grades as OverseerGrades));
      const { decision, reasons } = decide(plan, c.kind, metrics);
      const caseIds = c.cases.slice(0, mine.length).map((x) => x.caseId);
      const execs = caseIds.map((cid) => executions.get(executionKey(key, cid, id))!);
      // An expansion repeats the earlier stage's executions and their
      // grades exactly (STAGE_REWRITES_CASES; review E2 F3).
      for (const prior of earlier.filter((e) => e.planId === plan.id))
        for (const a of prior.aggregates.filter((x) => x.classKey === key && x.arrangementId === id))
          for (const ex of a.executions) {
            const now = execs.find((x) => x.caseId === ex.caseId);
            if (now && canonical(now) !== canonical(ex))
              throw new Error("STAGE_REWRITES_CASES:" + ex.caseId);
          }
      aggregates.push({
        classKey: key,
        kind: c.kind,
        arrangementId: id,
        arrangement: f,
        n: mine.length,
        caseIds,
        executions: execs,
        metrics,
        decision: synthetic && decision === "QUALIFIED" ? decision : decision,
        reasons: synthetic ? [...reasons, "SYNTHETIC: qualifies simulation tasks only"] : reasons,
      });
    }
  }
  const record: ImportedEvidence = {
    evidenceId,
    planId: plan.id,
    planDigest: frozen.planDigest,
    phase: bundle.phase,
    synthetic,
    journalHead: bundle.journalHead,
    aggregates,
    importedBy: options.actor,
  };
  return db.transaction(() => {
    const current = importedEvidence(db);
    const same = current.find((e) => e.evidenceId === evidenceId);
    if (same) return same;
    assertImportContinuity(current, record);
    db.event("ADAPTIVE_EVIDENCE_IMPORTED", null, record);
    return record;
  });
}

/** The normalized fixture of a case's tasks and requests as a database holds them now. */
function fixtureOf(
  db: Reader,
  taskIds: string[],
  requestIds: string[],
  scriptedAnswers: Array<{ questionKey: string; text: string }>,
  /** Records as they stood at this event: the case's fixture event, at import. */
  atSeq?: number,
) {
  const tasks = taskIds.map((id) => {
    const row = db.get<{ body: string }>("SELECT body FROM tasks WHERE id=?", id);
    if (!row) throw new Error("CASE_TASK_MISSING:" + id);
    return TaskSchema.parse(JSON.parse(row.body));
  });
  const submitted = new Map<string, any>(
    db
      .all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_SUBMITTED' ORDER BY seq")
      .map((r) => JSON.parse(r.body).request)
      .map((r: any) => [r.id, r]),
  );
  const requests = requestIds.map((id) => {
    const r = submitted.get(id);
    if (!r) throw new Error("CASE_REQUEST_MISSING:" + id);
    return r;
  });
  // Every record keeps its task; a revoked grant or decision says so.
  const rowsOf = (table: string, revocations?: [table: string, column: string]) =>
    taskIds.flatMap((id) =>
      db
        .all<{ id: string; task_id: string; body: string }>(
          `SELECT id, task_id, body FROM ${table} WHERE task_id=?`,
          id,
        )
        .map((r) => ({
          ...JSON.parse(r.body),
          taskId: r.task_id,
          ...(revocations &&
          db.get(`SELECT 1 FROM ${revocations[0]} WHERE ${revocations[1]}=?`, r.id)
            ? { revoked: true }
            : {}),
        })),
    );
  // The requests' questions and answers are part of the project's input.
  const workflow = db
    .all<{ seq: number; kind: string; body: string }>(
      "SELECT seq, kind, body FROM events WHERE kind IN ('WORKFLOW_QUESTION','WORKFLOW_REPLY','WORKFLOW_QUESTION_DEFERRED') ORDER BY seq",
    )
    .filter((e) => atSeq === undefined || e.seq < atSeq)
    .map((e) => ({ kind: e.kind, body: JSON.parse(e.body) }))
    .filter((e) => requestIds.includes(e.body.requestId));
  const questions = workflow
    .filter((e) => e.kind === "WORKFLOW_QUESTION")
    .map((e) => e.body.question as Record<string, any>)
    .map((question) => ({
      question,
      answers: workflow
        .filter((e) => e.kind === "WORKFLOW_REPLY" && e.body.reply?.questionId === question.id)
        .map((e) => e.body.reply as Record<string, any>),
      deferrals: workflow
        .filter((e) => e.kind === "WORKFLOW_QUESTION_DEFERRED" && e.body.deferral?.questionId === question.id)
        .map((e) => e.body.deferral as Record<string, any>),
    }));
  const specHistory = Object.fromEntries(
    tasks.map((t) => {
      const revised = db
        .all<{ seq: number; body: string }>(
          "SELECT seq, body FROM events WHERE kind='SPECIFICATION_REVISED' AND task_id=? ORDER BY seq",
          t.id,
        )
        .filter((e) => atSeq === undefined || e.seq < atSeq)
        .map((e) => JSON.parse(e.body) as { old: string; new: string });
      const list = revised.length ? [revised[0]!.old, ...revised.map((x) => x.new)] : [specDigest(t)];
      return [t.id, list];
    }),
  );
  const workKinds = tasks.filter((t) => t.kind).map((t) => {
    const bound = (kind: string) => db
      .all<{ seq: number; body: string }>("SELECT seq, body FROM events WHERE task_id=? AND kind=? ORDER BY seq", t.id, kind)
      .filter((e) => atSeq === undefined || e.seq < atSeq)
      .map((e) => JSON.parse(e.body))
      .filter((e) => e.specDigest === specDigest(t))
      .at(-1);
    const settings = bound("KIND_BOUND");
    const guidance = bound("EVALUATION_GUIDANCE_BOUND");
    if (!settings || settings.kind !== t.kind || !guidance ||
      !["worker", "reviewer", "advisor"].every((role) => typeof guidance.guidance?.[role] === "string"))
      throw new Error("EVALUATION_CASE_GUIDANCE_UNBOUND:" + t.id);
    return { taskId: t.id, kind: t.kind!, settings: settings.settings, guidance: guidance.guidance };
  });
  return normalizedFixture({
    requests,
    tasks,
    grants: rowsOf("grants", ["grant_revocations", "grant_id"]),
    decisions: rowsOf("decisions", ["decision_revocations", "decision_id"]),
    evidence: rowsOf("evidence").filter((e) => !controllerDerived(db, e)),
    specHistory,
    questions,
    workKinds,
    scriptedAnswers,
  });
}

/** A run as the journal's hash-chained events record it. */
type ChainedRun = {
  seq: number;
  at: string;
  decision: {
    runId: string;
    taskId: string;
    role: string;
    specDigest: string;
    simulation?: boolean;
    provider: string;
    model: string;
    effort: string;
    routing?: { adaptive?: { checkpointPinId?: string } };
    projectContextDigest?: string;
  };
  reserved?: { rework?: string; checkRework?: string; proposalRound?: string };
  executed?: { status: string; sessionId?: string; simulation?: boolean; identityVerified?: boolean };
  /** A chained launch intent, before the provider can confirm a pre-launch refusal. */
  startIntent?: boolean;
  /** A chained record that the run never started. */
  notStarted?: boolean;
};
/**
 * Every run of a journal from its hash-chained routing decision, reservation
 * and receipt events, which a later edit of the attempt or receipt tables
 * cannot change (review E2 F1, F2).
 */
function chainedRuns(rows: JournalRow[], journal: Journal): Map<string, ChainedRun> {
  const runs = new Map<string, ChainedRun>();
  for (const e of rows) {
    if (e.kind === "ROUTING_DECISION") {
      const body = JSON.parse(e.body);
      runs.set(body.runId, { seq: e.seq, at: e.at, decision: body });
    } else if (e.kind === "ATTEMPT_RESERVED") {
      const body = JSON.parse(e.body);
      const run = runs.get(body.id);
      if (run) run.reserved = body;
    } else if (e.kind === "PROCESS_START_INTENT") {
      const body = JSON.parse(e.body);
      const run = runs.get(body.runId);
      if (run) run.startIntent = true;
    } else if (e.kind === "EXECUTION_RECEIPT") {
      const body = JSON.parse(e.body);
      const run = runs.get(body.runId);
      if (run) {
        run.executed = body;
        // The controller marks a run whose receipt says it never launched as
        // not started, with no event of its own (review E2 r5 S1).
        const receipt = journal.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", body.runId);
        if (receipt && JSON.parse(receipt.body).notLaunched === true) run.notStarted = true;
      }
    } else if (e.kind === "ATTEMPT_NOT_STARTED" || e.kind === "LEASE_RECOVERED" || e.kind === "CANCELLED_BEFORE_START") {
      const body = JSON.parse(e.body);
      const run = runs.get(body.runId);
      if (run && (e.kind !== "LEASE_RECOVERED" || body.outcome === "DEFINITELY_NOT_STARTED")) run.notStarted = true;
    }
  }
  for (const [runId, run] of runs) {
    if (!run.notStarted) continue;
    // A no-start marker cannot settle an invocation whose launch was
    // recorded but whose receipt is missing, even after owner reconciliation
    // (review R6 X4). A genuine never-launched lease has no start intent.
    if (!run.executed) {
      if (run.startIntent) throw new Error("EVALUATION_RUN_START_CONTRADICTION:" + runId);
      continue;
    }
    // A no-start marker cannot erase a receipt of work that ran, including
    // failed work (review X4). The sole exception is a receipt that itself
    // verifies a refusal before launch: its chained identity must match,
    // and the provider schema requires a non-success status and zero usage.
    const { receipt } = verifiedRun(journal, run);
    if (receipt.notLaunched !== true || !providerReceiptSchema.safeParse(receipt).success)
      throw new Error("EVALUATION_RUN_START_CONTRADICTION:" + runId);
  }
  return runs;
}
/**
 * Every worker, reviewer and overseer run of a case's tasks reserved after
 * its fixture that ran, whatever its outcome, by role (review E2 r2 N5: runs
 * before the fixture set the case up; r3 M1: a run that ended early, such as
 * one a provider limit cut off, may still have produced work its successor
 * resumed). A launched run with no receipt is unresolved and refused.
 */
function executionRuns(journal: Journal, chained: Map<string, ChainedRun>, taskIds: string[], afterSeq: number) {
  const runs: EvaluationBundle["results"][number]["runs"] = {
    worker: [],
    reviewer: [],
    rework: [],
    overseer: [],
  };
  for (const [runId, run] of chained) {
    if (run.seq <= afterSeq || !taskIds.includes(run.decision.taskId)) continue;
    const measured = ["worker", "reviewer", "overseer"].includes(run.decision.role);
    if (!run.executed) {
      if (measured && !run.notStarted) throw new Error("EVALUATION_RUN_UNRESOLVED:" + runId);
      continue;
    }
    const again = run.reserved?.rework || run.reserved?.checkRework || run.reserved?.proposalRound;
    const slot =
      run.decision.role === "worker"
        ? again
          ? "rework"
          : "worker"
        : run.decision.role === "reviewer" || run.decision.role === "overseer"
          ? run.decision.role
          : undefined;
    if (!slot) continue;
    const receipt = journal.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", runId);
    if (!receipt) throw new Error("EVALUATION_RUN_UNVERIFIED:" + runId);
    // A run that never launched did nothing (review E2 r4 Q2).
    if (JSON.parse(receipt.body).notLaunched === true || run.notStarted) continue;
    runs[slot].push({ runId, receiptDigest: digest(receipt.body) });
  }
  return runs;
}
/**
 * A run's identity from its hash-chained routing decision; the attempt and
 * receipt rows must agree with it and with the chained receipt record
 * (review E2 F2), and an attempt's project context must be the one its
 * decision sealed.
 */
function verifiedRun(journal: Journal, run: ChainedRun) {
  const runId = run.decision.runId;
  const attemptRow = journal.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId);
  const receiptRow = journal.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", runId);
  if (!attemptRow || !receiptRow || !run.executed) throw new Error("EVALUATION_RUN_UNVERIFIED:" + runId);
  const d = run.decision,
    a = JSON.parse(attemptRow.body),
    rc = JSON.parse(receiptRow.body);
  const same = (x: any) => x.provider === d.provider && x.model === d.model && x.effort === d.effort;
  if (
    !same(a) ||
    !same(rc) ||
    // The receipt is this run's own, of its session (review E2 r2 N8).
    rc.runId !== runId ||
    rc.taskId !== d.taskId ||
    rc.sessionId !== run.executed.sessionId ||
    a.taskId !== d.taskId ||
    a.role !== d.role ||
    !!a.simulation !== !!d.simulation ||
    rc.status !== run.executed.status ||
    rc.simulation !== run.executed.simulation ||
    rc.identityVerified !== run.executed.identityVerified ||
    (d.projectContextDigest === undefined
      ? a.projectContext !== undefined
      : digest(a.projectContext) !== d.projectContextDigest)
  )
    throw new Error("EVALUATION_RUN_IDENTITY_MISMATCH:" + runId);
  return {
    receipt: rc,
    receiptBody: receiptRow.body,
    projectContext: a.projectContext as { requestId: string; snapshot?: { tasks?: Array<{ task?: { id?: string } }> } } | undefined,
    identity: runIdentity(run, rc),
  };
}
/** A chained run's candidate identity in its own role, with its receipt's runtime. */
function runIdentity(run: ChainedRun, receipt: any, role = run.decision.role as IdentityRole) {
  const d = run.decision;
  return candidateIdentity(
    { provider: d.provider, model: d.model, effort: d.effort, simulation: !!d.simulation },
    role,
    d.simulation
      ? SIMULATION_RUNTIME
      : {
          cliVersion: receipt.provenance?.cliVersion || "unrecorded",
          executableDigest: receipt.provenance?.executableDigest ?? null,
        },
  );
}

/**
 * The exposed context of a case execution's worker runs (contract section
 * 5.1): the identities of the producers other than the execution's own
 * workers, from the journal's exposure records (contract section 10.1). A
 * worker run without a record counts as unexposed only when nothing else
 * could have reached it: no project context, no advisor run on the case's
 * tasks and no fixed task; otherwise the import fails closed (review E2 F5).
 */
function executedContext(
  journal: Journal,
  chained: Map<string, ChainedRun>,
  workerRunIds: string[],
  taskIds: string[],
): ExposedContext & { synthetic: boolean } {
  const producers: CandidateIdentity[] = [];
  let substantive = false;
  let synthetic = false;
  const recorded = new Set<string>();
  for (const row of journal.all<{ body: string }>(
    "SELECT body FROM events WHERE kind='ADAPTIVE_EXPOSURE_RECORDED' ORDER BY seq",
  )) {
    const body = JSON.parse(row.body);
    if (!workerRunIds.includes(body.runId)) continue;
    recorded.add(body.runId);
    for (const source of body.sources ?? []) {
      if (!["CHECKPOINT_PLAN", "QUESTION", "SCREENING", "ADVICE"].includes(source.kind)) continue;
      const producer = chained.get(source.producerRunId);
      const receipt = journal.get<{ body: string }>(
        "SELECT body FROM receipts WHERE attempt_id=?",
        source.producerRunId,
      );
      if (!producer || !receipt) throw new Error("EVALUATION_CONTEXT_UNKNOWN:" + source.producerRunId);
      const verified = verifiedRun(journal, producer);
      if (producer.decision.simulation || producer.decision.provider === "mock" ||
          verified.receipt.simulation !== false || verified.receipt.identityVerified !== true ||
          !hasRecordedRuntime(verified.receipt))
        synthetic = true;
      producers.push(
        runIdentity(producer, verified.receipt, producer.decision.role === "advisor" ? "advisor" : "overseer"),
      );
      if (source.kind === "CHECKPOINT_PLAN" || source.kind === "SCREENING") substantive = true;
    }
  }
  const unrecorded = workerRunIds.filter((id) => !recorded.has(id));
  if (unrecorded.length) {
    // Any advisor run on the case's tasks, whatever its recorded outcome,
    // may have reached a worker (review E2 r2 N4). A moderator belongs to
    // the review and reply protocol the arrangement names (N6).
    // Only advice on the specification a worker ran on, reserved before it,
    // can have reached it (review E2 r3 M5).
    // An advisor that never started gave none (r4 Q8); one whose chained or
    // recorded specification is the worker's may have (r4 Q7).
    const advisedFor = (worker: ChainedRun) =>
      [...chained.values()].some((run) => {
        if (run.decision.role !== "advisor" || run.decision.taskId !== worker.decision.taskId) return false;
        if (run.seq >= worker.seq || run.notStarted) return false;
        const row = journal.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", run.decision.runId);
        const recorded = row ? (JSON.parse(row.body).specDigest as string | undefined) : undefined;
        return run.decision.specDigest === worker.decision.specDigest || recorded === worker.decision.specDigest;
      });
    const fixing = taskIds.some((id) => {
      const row = journal.get<{ body: string }>("SELECT body FROM tasks WHERE id=?", id);
      return !!row && !!JSON.parse(row.body).fixes;
    });
    for (const runId of unrecorded) {
      const worker = chained.get(runId);
      if (!worker || advisedFor(worker) || fixing || worker.decision.projectContextDigest !== undefined)
        throw new Error("EVALUATION_EXPOSURE_UNRECORDED:" + runId);
    }
  }
  return { mode: substantive ? "SUBSTANTIVE" : "COORDINATION_ONLY", producers: sortIdentities(producers), synthetic };
}

/**
 * Start an isolated evaluation journal bound to a frozen plan (harness;
 * contract section 5.5). It refuses a database that already has events.
 */
export function initEvaluationJournal(path: string, plan: EvaluationPlan) {
  const store = new SqliteStore(path);
  try {
    if (store.all("SELECT seq FROM events LIMIT 1").length)
      throw new Error("EVALUATION_JOURNAL_NOT_EMPTY");
    store.event("ADAPTIVE_EVALUATION_HARNESS", null, {
      planId: plan.id,
      planDigest: planDigest(plan),
      harnessVersion: EVALUATION_HARNESS_VERSION,
      protocolVersion: ADAPTIVE_PROTOCOL_VERSION,
    });
  } finally {
    store.close();
  }
}
/**
 * Record a case execution's fixture, before any of its runs (harness): the
 * normalized fixture of its seeded tasks and requests, and its digest.
 */
export function recordCaseFixture(
  db: Persistence,
  input: {
    caseId: string;
    /** The plan class the execution measures (review E2 r3 M6). */
    classKey: string;
    arrangementId: string;
    taskIds: string[];
    requestIds: string[];
    scriptedAnswers?: Array<{ questionKey: string; text: string }>;
  },
) {
  const fixture = fixtureOf(db, input.taskIds, input.requestIds, input.scriptedAnswers ?? []);
  const fixtureId = randomUUID();
  const fixtureDigest = digest(fixture);
  // The specification each case task has now: every run must be routed on it.
  const specDigests = Object.fromEntries(
    input.taskIds.map((id) => {
      const row = db.get<{ body: string }>("SELECT body FROM tasks WHERE id=?", id)!;
      return [id, specDigest(TaskSchema.parse(JSON.parse(row.body)))];
    }),
  );
  db.event("ADAPTIVE_EVALUATION_CASE_FIXTURE", null, {
    fixtureId,
    caseId: input.caseId,
    classKey: input.classKey,
    arrangementId: input.arrangementId,
    taskIds: input.taskIds,
    requestIds: input.requestIds,
    specDigests,
    fixture,
    fixtureDigest,
  });
  return { fixtureId, fixtureDigest, fixture };
}
/**
 * Build a bundle from an evaluation journal and the graders' results
 * (harness): the runs of each execution, with their receipt digests, come
 * from the journal itself.
 */
export function buildBundle(
  journalPath: string,
  plan: EvaluationPlan,
  graded: Array<{
    caseId: string;
    classKey: string;
    arrangementId: string;
    fixtureId: string;
    graderId: string;
    grades: PairGrades | OverseerGrades;
  }>,
  limitations: string[] = [],
): EvaluationBundle {
  const journal = new Journal(journalPath);
  try {
    const rows = journal.events();
    const fixtures = new Map(
      rows
        .filter((r) => r.kind === "ADAPTIVE_EVALUATION_CASE_FIXTURE")
        .map((r) => [JSON.parse(r.body).fixtureId, { seq: r.seq, body: JSON.parse(r.body) }]),
    );
    const chained = chainedRuns(rows, journal);
    const results = graded.map((g) => {
      const fixture = fixtures.get(g.fixtureId);
      if (!fixture) throw new Error("CASE_FIXTURE_MISSING:" + g.caseId);
      const runs = executionRuns(journal, chained, fixture.body.taskIds, fixture.seq);
      return { ...g, runs };
    });
    return EvaluationBundleSchema.parse({
      version: 1,
      planId: plan.id,
      planDigest: planDigest(plan),
      phase: plan.purpose,
      journalHead: rows.at(-1)!.hash,
      results,
      limitations,
    });
  } finally {
    journal.close();
  }
}
