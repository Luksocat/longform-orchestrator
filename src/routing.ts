import { z } from "zod";
import { digest, overlaps, Provider, type Task } from "./domain.js";
import type { ProviderId } from "./providers.js";

/**
 * Tiers, weakest first. APEX is the step above EXPERT: no rule, hint or
 * assessment asks for it; only a worker that failed review twice at EXPERT
 * moves up to it.
 */
export const ComplexityLevel = z.enum([
  "ROUTINE",
  "STANDARD",
  "COMPLEX",
  "EXPERT",
  "APEX",
]);
export type ComplexityLevel = z.infer<typeof ComplexityLevel>;
/** The tiers a hint or a difficulty assessment may ask for. */
export const HintLevel = z.enum(["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"]);
export type HintLevel = z.infer<typeof HintLevel>;
export type RoutingRole =
  | "worker"
  | "reviewer"
  | "advisor"
  | "moderator"
  | "assessor"
  | "overseer";
export interface ComplexityAssessment {
  level: ComplexityLevel;
  confidence: "HEURISTIC";
  reasons: string[];
}

const levels: readonly ComplexityLevel[] = ComplexityLevel.options;
const rank = (level: ComplexityLevel) => levels.indexOf(level);
const driveFileId = z.string().regex(/^[A-Za-z0-9_-]{10,128}$/);
const named = z
  .object({ id: driveFileId, name: z.string().trim().min(1).max(200) })
  .strict();
const guidance = z.array(z.string().trim().min(1).max(2_000)).max(20).default([]);
/**
 * A kind of work in this project (one orchestrator,
 * with work types): what its worker keeps in mind, what its reviewer checks
 * beyond the task's acceptance, and whether its first review proposes
 * improvements. Text for the briefs; it grants nothing.
 */
export const WorkKindSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    worker: guidance,
    reviewer: guidance,
    /** Whether the first review proposes improvements; records and filing don't. */
    proposals: z.boolean().default(true),
    /** Work of this kind is EXPERT and needs independent review, like a protected document. */
    expert: z.boolean().default(false),
  })
  .strict();
export type WorkKind = z.infer<typeof WorkKindSchema>;
export const workKindId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/** A kind the profile itself defines, never an inherited object property (review K7). */
export function profileKind(
  profile: { kinds?: Record<string, WorkKind> },
  id: string,
): WorkKind | undefined {
  const kinds = profile.kinds ?? {};
  return Object.hasOwn(kinds, id) ? kinds[id] : undefined;
}
/**
 * What is at stake in this project, kept outside the core: changing a listed document, creating in a listed folder or
 * writing under a code path is EXPERT work that needs independent review,
 * whatever the task record says.
 */
export const ProjectProfileSchema = z
  .object({
    version: z.literal(1),
    /** Drive documents that other documents treat as authority. */
    protectedDocuments: z.array(named).max(512).default([]),
    /** Drive folders where a new file carries the same weight. */
    protectedFolders: z.array(named).max(64).default([]),
    /** Workspace path prefixes that hold code. */
    codePaths: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[^/\\\0][^\\\0]*$/)
          .refine((p) => !p.endsWith("/") && !p.split("/").includes("..")),
      )
      .max(64)
      .default([]),
    /**
     * The owner's working rules, attached to the briefs of tasks that name a
     * kind: these sections of this file, read at each brief, so the rules
     * live in one place.
     */
    ownerRules: z
      .object({
        file: z.string().regex(/^\/[^\0]+$/),
        sections: z.array(z.string().regex(/^\d{1,2}$/)).min(1).max(20),
      })
      .strict()
      .optional(),
    /** The kinds of work a task may name (`kind`). */
    kinds: z.record(workKindId, WorkKindSchema).optional(),
  })
  .strict();
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
export const EMPTY_PROFILE: ProjectProfile = ProjectProfileSchema.parse({
  version: 1,
});
/**
 * A model's reading of a task: what it touches, what breaks if it is wrong,
 * and a tier hint that can only raise the tier (a
 * model assesses, the engine decides). Data, never a decision.
 */
export const DifficultyAssessmentSchema = z
  .object({
    taskId: z.string(),
    specDigest: z.string(),
    touches: z
      .object({
        driveDocuments: z.array(driveFileId).max(200),
        codePaths: z.array(z.string().max(512)).max(200),
        domainRules: z.boolean(),
        canonicalText: z.boolean(),
        ownerDecision: z.boolean(),
      })
      .strict(),
    breaksIfWrong: z.string().max(2_000),
    tierHint: HintLevel,
    reason: z.string().max(2_000),
  })
  .strict();
export type DifficultyAssessment = z.infer<typeof DifficultyAssessmentSchema>;

/** Operations that change code, source law or production. */
const WEIGHTY_OPERATIONS = new Set<Task["operations"][number]>([
  "SOURCE_LAW",
  "COMMIT",
  "PUSH",
  "CREATE_PR",
  "MERGE",
  "HOSTED_DATABASE",
  "PROVISION_CREDENTIAL",
  "DEPLOY",
  "COHORT_LAUNCH",
]);
/**
 * The tier the task's stakes demand, from facts in its record and the project
 * profile, with a model's assessment of what it touches if there is one.
 * ROUTINE when no rule applies (the stakes then demand nothing), never above
 * EXPERT. Counting files, sources or tests is not difficulty, so nothing here
 * counts them.
 */
export function stakes(
  task: Task,
  profile: ProjectProfile = EMPTY_PROFILE,
  assessment?: DifficultyAssessment,
): { level: ComplexityLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: ComplexityLevel = "ROUTINE";
  const raise = (to: ComplexityLevel, why: string) => {
    if (rank(to) > rank(level)) level = to;
    reasons.push(`${to}: ${why}`);
  };
  const drive = task.drive;
  if (
    task.operations.includes("WRITE_DRIVE") ||
    (drive && (drive.update.length > 0 || drive.createIn.length > 0))
  )
    raise("COMPLEX", "changes Google Drive documents");
  const docs = new Map(profile.protectedDocuments.map((d) => [d.id, d.name]));
  const folders = new Map(profile.protectedFolders.map((d) => [d.id, d.name]));
  const protectedDocs = [
    ...(drive?.update ?? []),
    ...(assessment?.touches.driveDocuments ?? []),
  ].filter((id) => docs.has(id));
  const protectedFolders = (drive?.createIn ?? []).filter((id) =>
    folders.has(id),
  );
  if (protectedDocs.length || protectedFolders.length)
    raise(
      "EXPERT",
      "touches protected documents: " +
        [
          ...new Set([
            ...protectedDocs.map((id) => docs.get(id)!),
            ...protectedFolders.map((id) => folders.get(id)! + "/"),
          ]),
        ].join(", "),
    );
  const weighty = task.operations.filter((op) => WEIGHTY_OPERATIONS.has(op));
  if (weighty.length)
    raise(
      "EXPERT",
      "changes code, source law or production (" + weighty.join(", ") + ")",
    );
  const code = [
    ...task.writePaths,
    ...(assessment?.touches.codePaths ?? []),
  ].filter((p) => profile.codePaths.some((c) => overlaps(p, c)));
  if (code.length)
    raise("EXPERT", "writes code: " + [...new Set(code)].join(", "));
  if (task.decisionRequired || assessment?.touches.ownerDecision)
    raise("EXPERT", "needs a decision only the owner can make");
  const kind = task.kind ? profileKind(profile, task.kind) : undefined;
  if (kind?.expert) raise("EXPERT", "is " + kind.title + " work");
  if (assessment?.touches.domainRules)
    raise("EXPERT", "touches domain rules (assessor)");
  if (assessment?.touches.canonicalText)
    raise("EXPERT", "touches canonical text (assessor)");
  return { level, reasons };
}
/**
 * Why the task's stakes require independent cross-provider review (empty when
 * they don't): HIGH risk, or any EXPERT stakes reason from the record, the
 * profile and, when given, a model's assessment of what the work touches.
 */
export function requiresIndependentReview(
  task: Task,
  profile: ProjectProfile = EMPTY_PROFILE,
  assessment?: DifficultyAssessment,
): string[] {
  return [
    ...(task.risk === "HIGH" ? ["EXPERT: HIGH risk"] : []),
    ...stakes(task, profile, assessment).reasons.filter((r) =>
      r.startsWith("EXPERT: "),
    ),
  ];
}
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const modelIdentifier = identifier.refine(
  (model) =>
    !/^(?:sonnet|opus|haiku|claude|codex|best|fable|opusplan)$/i.test(model) &&
    !/(?:^|[._:-])(?:default|latest|auto)(?:$|[._:-])/i.test(model),
  "An explicit model identifier is required; aliases are not permitted",
);
const effort = z.enum(["low", "medium", "high", "xhigh", "max", "test"]);
const capabilitySchema = z
  .object({
    provider: Provider,
    model: modelIdentifier,
    effort,
    verifiedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    evidenceRef: z.string().trim().min(1).max(512),
    /**
     * The CLI release and executable the attestation ran on, when it
     * recorded them (issue #12): adaptive quality evidence applies only to
     * the toolchain it was measured on. Optional, so older attestations and
     * policies still parse; capability is outside every policy digest.
     */
    cliVersion: z.string().trim().min(1).max(200).optional(),
    executableDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type RoutingCapability = z.infer<typeof capabilitySchema>;

/**
 * The workflows a policy may name (issue #12). ASTRA_TWO_TIER is the fixed
 * pairing that runs today; CAPABILITY_BIDIRECTIONAL_V1 is the opt-in
 * adaptive workflow, chosen per task from evidence. Both are project
 * governed: checkpoints, project questions and forced independent review.
 */
export const Workflow = z.enum(["ASTRA_TWO_TIER", "CAPABILITY_BIDIRECTIONAL_V1"]);
export type Workflow = z.infer<typeof Workflow>;
/** Project governance is in force: either workflow (contract section 2). */
export const projectGovernedWorkflow = (workflow: string | undefined) =>
  workflow === "ASTRA_TWO_TIER" || workflow === "CAPABILITY_BIDIRECTIONAL_V1";
/** How much coordination a checkpoint needs (design section 6). */
export const OversightDemand = z.enum(["BOUNDED", "MODULE", "PROGRAMME"]);
export type OversightDemand = z.infer<typeof OversightDemand>;
/** Whether an overseer's text may reach workers (design section 7). */
export const OversightMode = z.enum(["COORDINATION_ONLY", "SUBSTANTIVE"]);
export type OversightMode = z.infer<typeof OversightMode>;
/** The efforts adaptive worker, reviewer and overseer routes may use, weakest first. */
export const QUALITY_EFFORTS = ["high", "xhigh", "max"] as const;
export type QualityEffort = (typeof QUALITY_EFFORTS)[number];
/** An effort's place among QUALITY_EFFORTS, or -1 for any other effort. */
export const effortRank = (value: string) =>
  (QUALITY_EFFORTS as readonly string[]).indexOf(value);
/**
 * The inherited effort floors (contract section 3.3): the live policy's
 * two-tier and legacy-pairing efforts. A policy can never lower them.
 */
export const INHERITED_FLOORS = {
  codex: { COMPLEX: "xhigh", EXPERT: "max" },
  claude: { COMPLEX: "high", EXPERT: "xhigh" },
} as const;
/** Overseers on either provider: High only through a validated floor exception. */
export const OVERSEER_FLOOR: QualityEffort = "xhigh";
/** The floor for an adaptive route, or undefined for a provider without one. */
export function floorFor(
  provider: string,
  role: "worker" | "reviewer" | "overseer",
  tier: "COMPLEX" | "EXPERT",
): QualityEffort | undefined {
  if (role === "overseer") return OVERSEER_FLOOR;
  return provider === "codex" || provider === "claude"
    ? INHERITED_FLOORS[provider][tier]
    : undefined;
}
/**
 * Fable stays out of every adaptive role until a separate, versioned change
 * after its own diagnostic (design section 4; DUR-07).
 */
export const isFableModel = (model: string) =>
  /(^|[-_.])fable([-_.]|$)/i.test(model);
const digestHex = z.string().regex(/^[a-f0-9]{64}$/);
const demandThresholds = z
  .object({
    openTasks: z.number().int().min(1).max(10_000),
    coupling: z.number().int().min(1).max(10_000),
  })
  .strict();
/**
 * A policy-level floor exception (contract section 3.3): High for a bounded
 * class, active only while the named frozen plan qualifies that exact
 * arrangement. It never applies to EXPERT work.
 */
export const FloorExceptionSchema = z
  .object({
    id: identifier,
    provider: z.enum(["codex", "claude"]),
    role: z.enum(["worker", "reviewer", "overseer"]),
    effort: z.literal("high"),
    scope: z.enum(["BOUNDED_LOW_STAKES", "BOUNDED_OVERSIGHT"]),
    approvalRef: z.string().trim().min(1).max(512),
    evaluationPlanId: identifier,
  })
  .strict()
  .refine(
    (e) => (e.role === "overseer") === (e.scope === "BOUNDED_OVERSIGHT"),
    "BOUNDED_OVERSIGHT exceptions are for overseers, and only for them",
  );
export type FloorException = z.infer<typeof FloorExceptionSchema>;
/** The adaptive workflow's own settings (contract section 3.1). */
export const AdaptivePolicySchema = z
  .object({
    version: z.literal(1),
    /** DISABLED stops new pins; pinned work continues (intake rollback). */
    intake: z.enum(["ENABLED", "DISABLED"]),
    preference: z.enum(["AUTO", "GUIDED"]),
    /** Frozen plans whose results may qualify routes, in governing order. */
    evaluationPlans: z
      .array(z.object({ id: identifier, digest: digestHex }).strict())
      .min(1)
      .max(16)
      .refine(
        (plans) => new Set(plans.map((p) => p.id)).size === plans.length,
        "Duplicate evaluation plan IDs",
      ),
    maxEvidenceAgeDays: z.number().int().min(1).max(365),
    oversight: z
      .object({
        defaultMode: OversightMode,
        moduleAt: demandThresholds,
        programmeAt: demandThresholds,
      })
      .strict(),
    floorExceptions: z
      .array(FloorExceptionSchema)
      .max(16)
      .refine(
        (list) => new Set(list.map((e) => e.id)).size === list.length,
        "Duplicate floor exception IDs",
      ),
    ceiling: z.object({ continuations: z.number().int().min(0).max(2) }).strict(),
  })
  .strict();
export type AdaptivePolicy = z.infer<typeof AdaptivePolicySchema>;

export const RoutingPolicySchema = z
  .object({
    version: z.literal(1),
    id: identifier,
    routes: z
      .array(
        z
          .object({
            id: identifier,
            level: ComplexityLevel,
            provider: Provider,
            model: modelIdentifier,
            effort,
            roles: z
              .array(
                z.enum([
                  "worker",
                  "reviewer",
                  "advisor",
                  "moderator",
                  "assessor",
                  "overseer",
                ]),
              )
              .min(1)
              .refine((roles) => new Set(roles).size === roles.length),
            simulation: z.boolean(),
            enabled: z.boolean(),
            /**
             * Two-tier only: a route for work Claude already did before the
             * switch. Claude keeps reworking its own
             * drafts and Sol reviews them, the pairing they started under.
             */
            legacyPairing: z.boolean().optional(),
            /**
             * Adaptive workflow only, and required on its overseer routes:
             * the oversight demands the policy author approves this route for
             * (contract section 3.2). Data, not a brand ranking.
             */
            demands: z
              .array(OversightDemand)
              .min(1)
              .max(3)
              .refine((list) => new Set(list).size === list.length)
              .optional(),
            capability: capabilitySchema.optional(),
          })
          .strict()
          .superRefine((route, context) => {
            if (!route.simulation && route.effort === "test")
              context.addIssue({
                code: "custom",
                message: "Test effort is limited to simulation routes",
              });
            if (!route.simulation && route.provider === "mock")
              context.addIssue({
                code: "custom",
                message: "The mock provider cannot be a live route",
              });
          }),
      )
      .max(512),
    /**
     * Hold a real task's first worker run until a model has assessed its
     * specification. Each provider's assessor is
     * tried once; when every one has failed, the task waits for the owner's
     * word instead of proceeding on the stakes rules alone.
     */
    assessmentRequired: z.boolean().optional(),
    workflow: Workflow.optional(),
    /** Required exactly for CAPABILITY_BIDIRECTIONAL_V1 (contract section 3.1). */
    adaptive: AdaptivePolicySchema.optional(),
  })
  .strict()
  .superRefine((policy, context) => {
    const adaptive = policy.workflow === "CAPABILITY_BIDIRECTIONAL_V1";
    if (adaptive !== !!policy.adaptive)
      context.addIssue({
        code: "custom",
        message: adaptive
          ? "The adaptive workflow requires its adaptive section"
          : "The adaptive section belongs only to the adaptive workflow",
      });
    if (!adaptive && policy.routes.some((route) => route.demands))
      context.addIssue({
        code: "custom",
        message: "Oversight demands belong only to the adaptive workflow",
      });
    if (adaptive)
      for (const route of policy.routes) {
        if (!["COMPLEX", "EXPERT"].includes(route.level))
          context.addIssue({
            code: "custom",
            message: "Adaptive routes must be COMPLEX or EXPERT",
          });
        const pair = route.roles.filter(
          (role) => role === "worker" || role === "reviewer",
        );
        if (pair.length && route.roles.length !== 1)
          context.addIssue({
            code: "custom",
            message: "An adaptive worker or reviewer route has exactly one role",
          });
        const overseer = route.roles.includes("overseer");
        if (overseer !== !!route.demands)
          context.addIssue({
            code: "custom",
            message: overseer
              ? "An adaptive overseer route names the demands it serves"
              : "Only overseer routes name oversight demands",
          });
        if (
          (pair.length || overseer) &&
          effortRank(route.effort) < 0
        )
          context.addIssue({
            code: "custom",
            message:
              "Adaptive worker, reviewer and overseer routes use high, xhigh or max",
          });
      }
    if (policy.workflow === "ASTRA_TWO_TIER") {
      for (const route of policy.routes) {
        if (!["COMPLEX", "EXPERT"].includes(route.level))
          context.addIssue({
            code: "custom",
            message: "Two-tier routes must be COMPLEX or EXPERT",
          });
        const reviewer = route.roles.includes("reviewer");
        const expected = reviewer !== !!route.legacyPairing ? "claude" : "codex";
        if (!route.simulation && route.provider !== expected)
          context.addIssue({
            code: "custom",
            message: route.legacyPairing
              ? "Legacy-pairing workers use Claude; their reviewers use Codex"
              : "Two-tier workers/oversight use Codex; reviewers use Claude",
          });
        if (reviewer && route.roles.length !== 1)
          context.addIssue({
            code: "custom",
            message: "Reviewer route must be independent of authoring roles",
          });
        if (
          route.legacyPairing &&
          (route.roles.length !== 1 ||
            !["worker", "reviewer"].includes(route.roles[0]!))
        )
          context.addIssue({
            code: "custom",
            message: "A legacy-pairing route is one worker or reviewer role",
          });
      }
    } else if (policy.routes.some((route) => route.legacyPairing))
      context.addIssue({
        code: "custom",
        message: "Legacy-pairing routes exist only in the two-tier workflow",
      });
    if (
      new Set(policy.routes.map((route) => route.id)).size !==
      policy.routes.length
    )
      context.addIssue({ code: "custom", message: "Duplicate route IDs" });
  });
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

/**
 * The tier a task starts at: STANDARD, or ROUTINE for a bounded low-risk local
 * chore, raised by its stakes (stakes()), by a model's assessment of it and by
 * an authenticated hint in its record, never lowered by any of them; then the
 * risk and role floors. A deterministic rule over recorded facts, never an
 * authority decision (the model assesses, the engine
 * decides). Reviewers get the same stakes tier as workers.
 */
export function assessComplexity(
  task: Task,
  role: RoutingRole,
  context: {
    profile?: ProjectProfile;
    /** A successful assessor run's reading of this specification. */
    assessment?: { by: string; assessment: DifficultyAssessment };
  } = {},
): ComplexityAssessment {
  const reasons: string[] = [];
  let level: ComplexityLevel = "STANDARD";
  // A single broad root such as "src" does not establish boundedness. Neither
  // prose nor a lack of recorded requirements is proof that work is routine.
  const boundedWrite =
    task.writePaths.length === 1 &&
    /[/.]/.test(task.writePaths[0]!) &&
    task.operations.every((operation) =>
      ["READ_LOCAL", "WRITE_LOCAL"].includes(operation),
    );
  if (task.risk === "LOW" && boundedWrite && !task.decisionRequired) {
    level = "ROUTINE";
    reasons.push(
      "Low-risk local work with one bounded write scope and no owner decision starts at ROUTINE",
    );
  } else reasons.push("Work starts at STANDARD; its stakes raise it");
  const assessed = context.assessment?.assessment;
  const s = stakes(task, context.profile, assessed);
  if (rank(s.level) > rank(level)) level = s.level;
  reasons.push(...s.reasons.map((r) => "Stakes " + r));
  if (assessed) {
    if (rank(assessed.tierHint) > rank(level)) level = assessed.tierHint;
    reasons.push(
      `Assessor ${context.assessment!.by} rated it ${assessed.tierHint}: ${assessed.reason.slice(0, 300)}`,
    );
  }
  const hint = (
    task as Task & {
      complexity?: { level: HintLevel; rationale: string; sourceRef: string };
    }
  ).complexity;
  if (hint) {
    if (rank(hint.level) > rank(level)) level = hint.level;
    reasons.push(
      `Structured complexity hint ${hint.level} considered; hints cannot lower stakes or risk floors`,
    );
  }
  const floor: ComplexityLevel =
    task.risk === "HIGH"
      ? "EXPERT"
      : task.risk === "MEDIUM" || role === "reviewer"
        ? "STANDARD"
        : "ROUTINE";
  if (rank(level) < rank(floor)) level = floor;
  reasons.push(`Risk ${task.risk} and role ${role} require at least ${floor}`);
  return { level, confidence: "HEURISTIC", reasons };
}

/** Failed reviews of a task's worker runs at one tier before its next worker run moves up a tier. */
export const ESCALATE_AFTER_FAILED_REVIEWS = 2;

/**
 * Moves a worker up one tier for each tier at which the task's worker runs have
 * already failed review ESCALATE_AFTER_FAILED_REVIEWS times. It never lowers a
 * level; at the top tier the existing attempt budget is the stop.
 */
export function escalateForFailedReviews(
  assessment: ComplexityAssessment,
  failedReviewLevels: readonly ComplexityLevel[],
): ComplexityAssessment {
  const failures = (level: ComplexityLevel) =>
    failedReviewLevels.filter((failed) => failed === level).length;
  let level = assessment.level;
  const reasons = [...assessment.reasons];
  while (
    rank(level) < levels.length - 1 &&
    failures(level) >= ESCALATE_AFTER_FAILED_REVIEWS
  ) {
    const next = levels[rank(level) + 1]!;
    reasons.push(
      `ESCALATED ${level} -> ${next}: ${failures(level)} failed reviews of worker runs at ${level}`,
    );
    level = next;
  }
  return level === assessment.level
    ? assessment
    : { ...assessment, level, reasons };
}

export type RouteResolution =
  | {
      ok: true;
      provider: ProviderId;
      model: string;
      effort: string;
      routeId: string;
      policyId: string;
      policyDigest: string;
      routeDigest: string;
      assessment: ComplexityAssessment;
      reasons: string[];
      simulation: boolean;
    }
  | { ok: false; assessment: ComplexityAssessment; reasons: string[] };

export function withoutCapability<T extends { capability?: unknown }>(route: T) {
  const { capability: _capability, ...rest } = route;
  return rest;
}
export function withoutCapabilities(policy: RoutingPolicy) {
  return { ...policy, routes: policy.routes.map(withoutCapability) };
}

/** Even authenticated discovery is time-bounded; no indefinite cached capability. */
export const MAX_CAPABILITY_AGE_MS = 24 * 60 * 60 * 1000;

/** Why a live route's attested capability cannot be used now, if it cannot. */
export function capabilityHold(
  selected: RoutingPolicy["routes"][number],
  options: {
    now?: number;
    verifyLiveCapability?: (capability: RoutingCapability) => boolean;
  },
): string | undefined {
  if (selected.simulation) return undefined;
  const capability = selected.capability;
  if (!capability) return `LIVE_CAPABILITY_MISSING: ${selected.id}`;
  if (
    capability.provider !== selected.provider ||
    capability.model !== selected.model ||
    capability.effort !== selected.effort
  )
    return `LIVE_CAPABILITY_MISMATCH: ${selected.id}`;
  const now = options.now ?? Date.now();
  const verifiedAt = Date.parse(capability.verifiedAt);
  const expiresAt = Date.parse(capability.expiresAt);
  if (
    !Number.isFinite(now) ||
    verifiedAt > now ||
    now - verifiedAt > MAX_CAPABILITY_AGE_MS ||
    expiresAt <= now ||
    expiresAt <= verifiedAt
  )
    return `LIVE_CAPABILITY_STALE_OR_FUTURE: ${selected.id}`;
  let authenticated = false;
  try {
    authenticated = options.verifyLiveCapability?.(capability) === true;
  } catch {
    // Discovery failures hold the exact route; they never select a fallback.
  }
  if (!authenticated) return `LIVE_CAPABILITY_UNAUTHENTICATED: ${selected.id}`;
  return undefined;
}

/**
 * Advice never gates work, so unlike workers and reviewers an advisor is the
 * first usable advisor route in the policy's own order (the owner's
 * preference), restricted to the task's providers. When none is usable the
 * task simply proceeds without advice. A moderator is chosen the same way
 * from the moderator routes; without one, open proposals go to the owner
 * without a recommendation.
 */
function resolveListedRoute(
  task: Task,
  role: "advisor" | "moderator" | "assessor" | "overseer",
  approved: RoutingPolicy,
  assessment: ComplexityAssessment,
  options: {
    now?: number;
    verifyLiveCapability?: (capability: RoutingCapability) => boolean;
    startedRouteId?: string;
    /** Assessors: providers whose assessor already ran for this specification. */
    excludeProviders?: ProviderId[];
  },
): RouteResolution {
  const reasons: string[] = [];
  // A run already started on a listed route keeps it: neither an earlier route
  // that became usable meanwhile nor its own attestation ageing stops it.
  const started = options.startedRouteId
    ? approved.routes.find((route) => route.id === options.startedRouteId)
    : undefined;
  for (const route of started ? [started] : approved.routes) {
    if (
      !route.roles.includes(role) ||
      route.simulation !== task.simulation ||
      !task.providers.includes(route.provider)
    )
      continue;
    // Each provider's assessor runs once per specification: the next assessor route is the first untried one.
    if (
      route !== started &&
      options.excludeProviders?.includes(route.provider)
    ) {
      reasons.push(`${role.toUpperCase()}_ALREADY_RUN: ${route.id}`);
      continue;
    }
    const hold = !route.enabled
      ? `ROUTE_DISABLED: ${route.id}`
      : approved.workflow === "CAPABILITY_BIDIRECTIONAL_V1" &&
          isFableModel(route.model)
        ? `FABLE_QUARANTINED: ${route.id}`
        : route === started
          ? undefined
          : capabilityHold(route, options);
    if (hold) {
      reasons.push(hold);
      continue;
    }
    return {
      ok: true,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      routeId: route.id,
      policyId: approved.id,
      policyDigest: digest(withoutCapabilities(approved)),
      routeDigest: digest(withoutCapability(route)),
      assessment,
      reasons: [
        ...reasons,
        `Selected ${role} ${route.id}: first usable ${role} route in policy order`,
        route.simulation
          ? "SIMULATION ONLY: model and effort are synthetic labels; no model invocation is established"
          : `Authenticated current capability permits this ${role} route; actual execution identity requires its own receipt`,
      ],
      simulation: route.simulation,
    };
  }
  return {
    ok: false,
    assessment,
    reasons: reasons.length
      ? reasons
      : [
          `${role.toUpperCase()}_ROUTE_UNAVAILABLE: no ${role} route for the task's providers, simulation=${task.simulation}`,
        ],
  };
}

/** Select only from trusted policy. Task prose cannot supply an executable route. */
export function resolveRoute(
  task: Task,
  role: RoutingRole,
  policy: RoutingPolicy,
  options: {
    authors?: ProviderId[];
    /** Providers that advised on the current specification (co-authors). */
    advisors?: ProviderId[];
    /** The tier of each of the task's worker runs whose review failed (workers only). */
    failedReviewLevels?: ComplexityLevel[];
    artifactTier?: ComplexityLevel;
    /**
     * Workers only: the one provider allowed. A worker's reply to a review's
     * proposals stays with the provider that did the work.
     */
    provider?: ProviderId;
    now?: number;
    verifyLiveCapability?: (capability: RoutingCapability) => boolean;
    /**
     * The route of a run that has already started. Its capability was checked
     * when it started, so its attestation is not re-checked for age (an ageing attestation never stops a run in flight).
     */
    startedRouteId?: string;
    /** Assessors only: providers whose assessor already ran for this specification. */
    excludeProviders?: ProviderId[];
    /** The project's stakes (protected documents, code paths). */
    profile?: ProjectProfile;
    /** A model's assessment of this specification, if one succeeded. */
    assessment?: { by: string; assessment: DifficultyAssessment };
    /**
     * Two-tier only: Claude did some of this task's work before the switch, so
     * it keeps the legacy pairing (Claude works, Sol reviews).
     */
    legacyClaudeAuthorship?: boolean;
  } = {},
): RouteResolution {
  const context = {
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.assessment ? { assessment: options.assessment } : {}),
  };
  let assessment =
    role === "worker"
      ? escalateForFailedReviews(
          assessComplexity(task, role, context),
          options.failedReviewLevels ?? [],
        )
      : assessComplexity(task, role, context);
  const hold = (...reasons: string[]): RouteResolution => ({
    ok: false,
    assessment,
    reasons,
  });
  const parsed = RoutingPolicySchema.safeParse(policy);
  if (!parsed.success)
    return hold(
      "ROUTING_POLICY_INVALID: " +
        parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  const approved = parsed.data;
  // Both project-governed workflows use the Complex/Expert tier vocabulary
  // (contract section 2); only ASTRA_TWO_TIER fixes the pairing below.
  if (projectGovernedWorkflow(approved.workflow)) {
    assessment = assessTwoTier(
      task,
      options.profile,
      options.assessment?.assessment,
    );
    if (
      role === "worker" &&
      (options.failedReviewLevels ?? []).filter((x) => x === "COMPLEX")
        .length >= 2
    ) {
      assessment.level = "EXPERT";
      assessment.reasons.push(
        "ESCALATED COMPLEX -> EXPERT: two failed reviews; Expert is the ceiling",
      );
    }
    if (role === "reviewer" && options.artifactTier) {
      assessment.level =
        options.artifactTier === "EXPERT" || options.artifactTier === "APEX"
          ? "EXPERT"
          : "COMPLEX";
      assessment.reasons.push(
        "Reviewer follows the sealed artifact's worker tier",
      );
    }
  }
  // Under the adaptive workflow the controller selects and pins workers,
  // reviewers and overseers from evidence (contract sections 6 to 8); this
  // fixed resolver never chooses them, so a direct call holds.
  if (
    approved.workflow === "CAPABILITY_BIDIRECTIONAL_V1" &&
    (role === "worker" || role === "reviewer" || role === "overseer")
  )
    return hold(
      `ADAPTIVE_SELECTION_REQUIRED: the adaptive workflow selects the ${role} from evidence and pins it; no fixed route applies`,
    );
  if (
    role === "advisor" ||
    role === "moderator" ||
    role === "assessor" ||
    role === "overseer"
  )
    return resolveListedRoute(task, role, approved, assessment, options);
  const authors = new Set(options.authors ?? []);
  let providers = [...new Set(task.providers)];
  // Work Claude already did keeps its pairing: Claude reworks, Sol reviews.
  const legacy =
    approved.workflow === "ASTRA_TWO_TIER" &&
    !task.simulation &&
    !!options.legacyClaudeAuthorship;
  if (approved.workflow === "ASTRA_TWO_TIER" && !task.simulation)
    providers = providers.filter(
      (p) => p === ((role === "reviewer") !== legacy ? "claude" : "codex"),
    );
  // An advisor is a co-author: with cross-provider review, the worker must be
  // the advisor's provider so that a provider which shaped neither can review.
  const advisors = new Set(options.advisors ?? []);
  // A legacy-pairing task keeps Claude as its worker: Codex (Astra) advice
  // does not count as co-authorship there (see Controller.authors).
  if (legacy) advisors.delete("codex");
  if (role === "worker" && task.reviewPolicy.crossProvider && advisors.size)
    providers = providers.filter((provider) => advisors.has(provider));
  if (role === "worker" && options.provider)
    providers = providers.filter((provider) => provider === options.provider);
  if (role === "reviewer") {
    if (task.reviewPolicy.crossProvider && authors.size === 0)
      return hold(
        "REVIEW_AUTHORSHIP_UNAVAILABLE: cross-provider routing requires actual authors",
      );
    if (task.reviewPolicy.crossProvider)
      providers = providers.filter((provider) => !authors.has(provider));
    else
      providers = [
        ...providers.filter((provider) => !authors.has(provider)),
        ...providers.filter((provider) => authors.has(provider)),
      ];
  }
  const provider = providers[0];
  if (!provider)
    return hold(
      "NO_ELIGIBLE_PROVIDER: authorship or task provider restrictions",
    );
  const candidates = approved.routes
    .filter(
      (route) =>
        route.level === assessment.level &&
        route.provider === provider &&
        route.roles.includes(role) &&
        route.simulation === task.simulation &&
        !!route.legacyPairing === legacy,
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = candidates[0];
  if (!selected)
    return hold(
      `ROUTE_UNAVAILABLE: exact ${assessment.level} ${role} route for ${provider}, simulation=${task.simulation}${legacy ? ", legacy pairing" : ""}; no substitution permitted`,
    );
  if (!selected.enabled)
    return hold(`ROUTE_DISABLED: ${selected.id}; no substitution permitted`);
  const capabilityProblem =
    selected.id === options.startedRouteId
      ? undefined
      : capabilityHold(selected, options);
  if (capabilityProblem) return hold(capabilityProblem);
  return {
    ok: true,
    provider: selected.provider,
    model: selected.model,
    effort: selected.effort,
    routeId: selected.id,
    policyId: approved.id,
    // Capability metadata (when it was last attested, and by which evidence) is
    // not part of a route's identity: it is checked for currency on every
    // resolution, so re-attesting does not count as a policy change.
    policyDigest: digest(withoutCapabilities(approved)),
    routeDigest: digest(withoutCapability(selected)),
    assessment,
    reasons: [
      ...assessment.reasons,
      `Selected ${selected.id} at exact tier ${assessment.level} using ${provider} provider preference`,
      selected.simulation
        ? "SIMULATION ONLY: model and effort are synthetic labels; no model invocation is established"
        : "Authenticated current capability permits this requested route; actual execution identity requires its own receipt",
    ],
    simulation: selected.simulation,
  };
}

/** Safe out-of-box demonstrations; these model labels never denote live models. */
export function defaultRoutingPolicy(): RoutingPolicy {
  const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
  return RoutingPolicySchema.parse({
    version: 1,
    id: "synthetic-complexity-v1",
    routes: (["codex", "claude", "mock"] as const).flatMap((provider) =>
      levels.map((level, index) => ({
        id: `synthetic-${provider}-${level.toLowerCase()}`,
        level,
        provider,
        model: `synthetic-${provider}-${level.toLowerCase()}`,
        effort: efforts[index],
        roles: ["worker", "reviewer", "advisor", "moderator", "assessor"],
        simulation: true,
        enabled: true,
      })),
    ),
  });
}

/** Active two-tier policy. Legacy enums remain readable for historical records. */
export function assessTwoTier(
  task: Task,
  profile: ProjectProfile = EMPTY_PROFILE,
  assessment?: DifficultyAssessment,
): ComplexityAssessment {
  const reasons = stakes(task, profile, assessment).reasons.filter(
    (r) =>
      !r.includes("writes code:") &&
      !r.includes("changes code, source law or production"),
  );
  const serious = task.operations.filter((op) =>
    [
      "SOURCE_LAW",
      "MERGE",
      "HOSTED_DATABASE",
      "PROVISION_CREDENTIAL",
      "DEPLOY",
      "COHORT_LAUNCH",
    ].includes(op),
  );
  if (serious.length)
    reasons.push(
      "EXPERT: protected or production operation: " + serious.join(", "),
    );
  if (task.risk === "HIGH") reasons.push("EXPERT: HIGH risk");
  if (assessment?.tierHint === "EXPERT" || task.complexity?.level === "EXPERT")
    reasons.push("EXPERT: difficulty assessment or authenticated hint");
  const level = reasons.some((r) => r.startsWith("EXPERT:"))
    ? "EXPERT"
    : "COMPLEX";
  return {
    level,
    confidence: "HEURISTIC",
    reasons: [
      "Two-tier workflow: Complex is the starting level; ordinary code retains independent review",
      ...reasons,
    ],
  };
}
