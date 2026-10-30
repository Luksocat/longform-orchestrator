import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

export const Status = z.enum([
  "DISCOVERED",
  "READY",
  "BLOCKED",
  "RUNNING",
  "WAITING_REVIEW",
  "REMEDIATION_REQUIRED",
  "WAITING_OWNER",
  "VERIFIED",
  "ACCEPTED",
  "CANCELLED",
  "SUPERSEDED",
]);
export type Status = z.infer<typeof Status>;
export const Provider = z.enum(["codex", "claude", "mock"]);
export const Operation = z.enum([
  "READ_LOCAL",
  "WRITE_LOCAL",
  "READ_DRIVE",
  "WRITE_DRIVE",
  "READ_GITHUB",
  "SOURCE_LAW",
  "COMMIT",
  "PUSH",
  "CREATE_PR",
  "MERGE",
  "HOSTED_DATABASE",
  "PROVISION_CREDENTIAL",
  "DEPLOY",
  "COHORT_LAUNCH",
  "ACCEPT",
]);
export type Operation = z.infer<typeof Operation>;
export const forbiddenExternal = new Set<Operation>([
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
export const safePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes("\0") &&
      !p.startsWith("/") &&
      !p.split("/").some((s) => s === ".." || s === "." || s === "") &&
      p !== ".git" &&
      !p.startsWith(".git/"),
    "relative normalized path required",
  );
const driveFileId = z.string().regex(/^[A-Za-z0-9_-]{10,128}$/);
/** Drive reach for a live worker, enforced by the host-side Drive gateway. */
export const DrivePolicySchema = z
  .object({
    /** "ANY" or file/folder IDs (a folder makes its direct children readable). */
    read: z.union([z.literal("ANY"), z.array(driveFileId).min(1).max(512)]),
    /** Files whose content may be replaced. */
    update: z.array(driveFileId).max(512).default([]),
    /** Folders new files may be created in. */
    createIn: z.array(driveFileId).max(64).default([]),
    /**
     * Source pack: files the host reads for the worker before it starts and
     * saves in its workspace; they count as read in that run. Optional, so
     * absence preserves legacy hashes.
     */
    pack: z
      .array(driveFileId)
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate pack file")
      .optional(),
    /**
     * Governing sources that must be current when the work is published
     * : before each write a worker must have read
     * each at Drive's current version, and filing stops if one changed since
     * the sealed work read it. Version checks, not content comparisons.
     * Optional, so absence preserves legacy hashes.
     */
    requireLatest: z
      .array(driveFileId)
      .min(1)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate required source")
      .optional(),
  })
  .strict();
export type DrivePolicy = z.infer<typeof DrivePolicySchema>;
/**
 * Deterministic checks of a worker's sealed work, run by the controller before
 * any review; evaluated in checks.ts.
 */
const checkPaths = z.array(safePath).min(1).max(64);
export const CheckSchema = z.discriminatedUnion("kind", [
  /** Each file exists in the work, is a regular file and is not empty. */
  z.object({ kind: z.literal("FILES_PRESENT"), paths: checkPaths }).strict(),
  /**
   * None of these words or phrases appear in these files (whole words, any
   * case): for owner-facing text that must avoid process codes and jargon.
   */
  z
    .object({
      kind: z.literal("WORDS_ABSENT"),
      paths: checkPaths,
      words: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
    })
    .strict(),
  /**
   * Every Drive file ID cited in these files was read in a worker run of the
   * current specification (read, pack, update or create in the host record),
   * except the ones listed.
   */
  z
    .object({
      kind: z.literal("CITED_DRIVE_IDS_READ"),
      paths: checkPaths,
      except: z.array(driveFileId).max(512).default([]),
    })
    .strict(),
  /** At most this many Drive files were created across the specification's worker runs. */
  z
    .object({
      kind: z.literal("DRIVE_CREATES_AT_MOST"),
      max: z.number().int().min(0).max(64),
    })
    .strict(),
]);
export type Check = z.infer<typeof CheckSchema>;
export const ChecksSchema = z.array(CheckSchema).min(1).max(16);

export const TaskSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
    programme: z.string().min(1),
    lane: z.string().min(1),
    title: z.string().min(1),
    scope: z.string().min(1),
    deliverable: z.string().min(1),
    specVersion: z.number().int().positive(),
    status: Status.default("DISCOVERED"),
    dimensions: z.object({
      authorization: z.enum(["HELD", "READ_ONLY", "LOCAL_ONLY", "EXPLICIT"]),
      sourceEffectuation: z.enum(["UNKNOWN", "CANDIDATE", "EFFECTUATED"]),
      implementation: z.enum(["HELD", "NOT_STARTED", "PARTIAL", "COMPLETE"]),
      review: z.enum(["NONE", "PARTIAL", "PASSED"]),
      release: z.enum(["NOT_AUTHORIZED", "AUTHORIZED"]),
    }),
    dependencies: z.array(z.string()).default([]),
    blockers: z.array(z.string()).default([]),
    sources: z
      .array(
        z.object({
          evidenceId: z.string(),
          revision: z.string(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .default([]),
    specificationAuthenticated: z.boolean().default(false),
    providers: z.array(Provider).min(1),
    operations: z.array(Operation).min(1),
    writePaths: z.array(safePath).default([]),
    resources: z.array(z.string()).default([]),
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]).default("HIGH"),
    // Optional authenticated specification hint; absence preserves legacy hashes.
    // Provider/model/effort remain controller configuration, never task fields.
    complexity: z
      .object({
        level: z.enum(["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"]),
        rationale: z.string().trim().min(1),
        sourceRef: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    // Optional: the task whose failed work this one fixes. The controller checks
    // that the fix stays within the original's scope, and the original's failed
    // reviews count toward this task's tier. Absence
    // preserves legacy hashes.
    fixes: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/)
      .optional(),
    // Optional owner request for advice from the configured advisor model
    // before the worker runs; absence preserves legacy hashes. Advice is data
    // for the worker and never gates, authorizes, reviews or accepts anything.
    advice: z
      .object({
        rationale: z.string().trim().min(1),
        sourceRef: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    // Optional live-worker Drive scope; absence preserves legacy hashes.
    drive: DrivePolicySchema.optional(),
    // Optional deterministic checks of the sealed work before any review
    //; absence preserves legacy hashes.
    checks: ChecksSchema.optional(),
    // Optional kind of work, defined in the project profile; absence preserves legacy hashes and briefs.
    kind: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .optional(),
    // Optional pinned code to start from: a repository configured by the
    // operator and an exact commit; absence
    // preserves legacy hashes.
    repo: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict()
      .optional(),
    // Optional opt-in to pre-design decision discovery (proposal #17): before
    // the task's first worker run, Astra screens it for the choices only the
    // owner can make, and the controller admits the worker only on a current
    // screening whose owner choices are settled. REQUIRED always screens;
    // AUTO applies the deterministic classifier in screening.ts; EXEMPT
    // records why no screening is needed. Absence preserves legacy hashes
    // and behaviour.
    preDesignDiscovery: z
      .object({
        policy: z.enum(["REQUIRED", "AUTO", "EXEMPT"]),
        rationale: z.string().trim().min(1),
        sourceRef: z.string().trim().min(1),
      })
      .strict()
      .optional(),
    reviewPolicy: z.object({
      required: z.boolean(),
      crossProvider: z.boolean(),
      independentAudits: z.boolean(),
    }),
    acceptance: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          evidenceKind: z.enum([
            "DRIVE",
            "GITHUB",
            "LOCAL",
            "TEST_RECEIPT",
            "REVIEW",
            "SOURCE_BINDING",
          ]),
        }),
      )
      .min(1),
    requiredTests: z.array(z.string()).default([]),
    decisionRequired: z.boolean().default(false),
    priority: z.number().int().min(0).max(100).default(50),
    estimatedCostUsd: z.number().nonnegative().default(0),
    budget: z.object({
      deadlineMs: z.number().int().min(10).max(3_600_000),
      maxAttempts: z.number().int().min(1).max(5),
      maxCostUsd: z.number().nonnegative(),
      maxTokens: z.number().int().positive(),
    }),
    artifactRevision: z.string().min(1),
    simulation: z.boolean().default(false),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.writePaths.length && !task.operations.includes("WRITE_LOCAL"))
      ctx.addIssue({
        code: "custom",
        message: "Writable paths require declared WRITE_LOCAL",
      });
    if (
      task.dimensions.authorization === "READ_ONLY" &&
      (task.writePaths.length > 0 || task.operations.includes("WRITE_LOCAL"))
    )
      ctx.addIssue({
        code: "custom",
        message: "READ_ONLY cannot declare writable paths or operations",
      });
    const driveWrites =
      !!task.drive &&
      (task.drive.update.length > 0 || task.drive.createIn.length > 0);
    if (task.drive && !task.operations.includes("READ_DRIVE"))
      ctx.addIssue({
        code: "custom",
        message: "A Drive scope requires declared READ_DRIVE",
      });
    if (driveWrites !== task.operations.includes("WRITE_DRIVE"))
      ctx.addIssue({
        code: "custom",
        message:
          "WRITE_DRIVE must be declared exactly when the Drive scope lists update files or create folders",
      });
    // The gateway's record of every Drive call is copied into the workspace.
    if (task.drive && !task.writePaths.includes("drive-changes"))
      ctx.addIssue({
        code: "custom",
        message: 'A Drive scope requires "drive-changes" in writePaths',
      });
    for (const check of task.checks ?? []) {
      if ("paths" in check)
        for (const path of check.paths)
          if (!permittedPath(path, task.writePaths))
            ctx.addIssue({
              code: "custom",
              message: `Check path ${path} must lie within writePaths`,
            });
      if (
        (check.kind === "CITED_DRIVE_IDS_READ" ||
          check.kind === "DRIVE_CREATES_AT_MOST") &&
        !task.drive
      )
        ctx.addIssue({
          code: "custom",
          message: `${check.kind} requires a Drive scope`,
        });
    }
    if (
      task.risk === "HIGH" &&
      (!task.reviewPolicy.required ||
        !task.reviewPolicy.crossProvider ||
        !task.reviewPolicy.independentAudits)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "HIGH risk requires independent cross-provider review and audits",
      });
  });
export type Task = z.infer<typeof TaskSchema>;
export const AuditKind = z.enum([
  "ACCURACY",
  "LOCAL_ANTI_DRIFT",
  "MACRO_ANTI_DRIFT",
]);
export type AuditKind = z.infer<typeof AuditKind>;
export const AuditResult = z.enum([
  "PASS",
  "PASS_WITH_LIMITATIONS",
  "FAIL",
  "NOT_EXECUTED",
]);
/** Proposals a review's round puts to the worker (the first ones, strongest first). */
export const MAX_PROPOSALS = 5;
/**
 * A reviewer's idea for doing the work better. It never blocks a pass, so the
 * schema is lenient: a recorded review must match the reviewer's output byte
 * for byte, and a long or blank field must not throw out a good review. The
 * round skips blank proposals and bounds what it passes on.
 */
export const ProposalSchema = z
  .object({
    /** The change, in one or two sentences. */
    what: z.string().max(16_000),
    /** The reason, citing the file, source or accepted decision it rests on. */
    why: z.string().max(16_000),
    /** What the audience or end user would notice. */
    userImpact: z.string().max(16_000),
    /** STRONG: the reviewer would push for it. IDEA: worth considering. */
    weight: z.enum(["STRONG", "IDEA"]),
    /** It would change a domain rule or an accepted decision. */
    touchesDecision: z.boolean(),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;
/** Proposals are referred to by position: P1 is the first. */
export const proposalId = (index: number) => "P" + (index + 1);
export const ReviewSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    runId: z.string(),
    artifactRevision: z.string(),
    specDigest: z.string(),
    reviewerSession: z.string(),
    provider: Provider,
    authorshipDisclosure: z.string().min(1),
    availableEvidence: z.array(z.string()),
    findings: z.array(
      z.object({
        materiality: z.enum(["CRITICAL", "MAJOR", "MINOR", "INFO"]),
        evidenceIds: z.array(z.string()),
        description: z.string(),
      }),
    ),
    testsExecuted: z.array(z.string()),
    testsNotExecuted: z.array(z.string()),
    conflictingEvidence: z.array(z.string()),
    remediation: z.array(z.string()),
    residualHolds: z.array(z.string()),
    verdict: z.enum(["PASS", "PASS_WITH_LIMITATIONS", "FAIL"]),
    scope: z.string().min(1),
    nextAuthorizedStep: z.string().min(1),
    auditAssessments: z
      .array(
        z.object({
          kind: AuditKind,
          result: AuditResult,
          evidenceIds: z.array(z.string()),
          assessment: z.string().min(1),
          limitations: z.array(z.string()),
        }),
      )
      .default([]),
    // Optional ideas for doing the work better; absence preserves legacy
    // hashes. Only the first review of a specification opens a proposal
    // round, with its first MAX_PROPOSALS proposals.
    proposals: z.array(ProposalSchema).max(20).optional(),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;
/** Session/run identifiers come from the harness; all assessed content comes from the reviewer output. */
export function reviewPayload(review: Review) {
  const { id, runId, reviewerSession, ...payload } = review;
  return payload;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        // Match JSON object semantics: an absent optional member is not null.
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : canonical(value),
    )
    .digest("hex");
export function specDigest(task: Task): string {
  // Authorization and source/review/release dimensions are part of the contract.
  const { status, ...spec } = task;
  return digest(spec);
}
export function isReservedLane(lane: string): boolean {
  // HOLD is a permanently reserved workstream token. Require a whole token
  // so ordinary names such as "shareholder-research" are not excluded.
  return /(?:^|[^\p{L}\p{N}])HOLD(?=$|[^\p{L}\p{N}])/iu.test(
    lane,
  );
}
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
export function validateGraph(tasks: Task[]): void {
  const map = new Map(tasks.map((t) => [t.id, t]));
  if (map.size !== tasks.length) throw new Error("DUPLICATE_TASK");
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("DEPENDENCY_CYCLE:" + id);
    if (done.has(id)) return;
    const task = map.get(id);
    if (!task) throw new Error("MISSING_DEPENDENCY:" + id);
    visiting.add(id);
    task.dependencies.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  tasks.forEach((t) => visit(t.id));
}
export function permittedPath(path: string, allow: string[]): boolean {
  const p = safePath.safeParse(path);
  return (
    p.success &&
    posix.normalize(path) === path &&
    allow.some((a) => path === a || path.startsWith(a + "/"))
  );
}
export const transitions: Record<Status, readonly Status[]> = {
  DISCOVERED: ["READY", "BLOCKED", "WAITING_OWNER", "CANCELLED", "SUPERSEDED"],
  READY: ["RUNNING", "BLOCKED", "WAITING_OWNER", "CANCELLED", "SUPERSEDED"],
  BLOCKED: ["READY", "WAITING_OWNER", "CANCELLED", "SUPERSEDED"],
  RUNNING: ["WAITING_REVIEW", "REMEDIATION_REQUIRED", "BLOCKED", "CANCELLED"],
  WAITING_REVIEW: [
    "VERIFIED",
    "REMEDIATION_REQUIRED",
    "BLOCKED",
    "WAITING_OWNER",
    "CANCELLED",
  ],
  REMEDIATION_REQUIRED: [
    "READY",
    "BLOCKED",
    "WAITING_OWNER",
    "CANCELLED",
    "SUPERSEDED",
  ],
  WAITING_OWNER: ["READY", "BLOCKED", "ACCEPTED", "CANCELLED", "SUPERSEDED"],
  VERIFIED: [
    "ACCEPTED",
    "WAITING_OWNER",
    "REMEDIATION_REQUIRED",
    "BLOCKED",
    "SUPERSEDED",
  ],
  ACCEPTED: ["SUPERSEDED"],
  CANCELLED: [],
  SUPERSEDED: [],
};

export function demoTask(id: string, overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id,
    programme: "ORCHESTRATOR_DEMO",
    lane: "LOCAL",
    title: "Disposable mock " + id,
    scope: "Isolated synthetic fixture only",
    deliverable: "Synthetic receipt; no real project implementation",
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
    sources: [],
    specificationAuthenticated: true,
    providers: ["codex", "claude"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/" + id],
    resources: [],
    risk: "LOW",
    reviewPolicy: {
      required: true,
      crossProvider: true,
      independentAudits: false,
    },
    acceptance: [
      {
        id: "receipt",
        description: "Controller verified synthetic output",
        evidenceKind: "LOCAL",
      },
    ],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    estimatedCostUsd: 0,
    budget: {
      deadlineMs: 2000,
      maxAttempts: 2,
      maxCostUsd: 0,
      maxTokens: 1000,
    },
    artifactRevision: digest(id),
    simulation: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}
