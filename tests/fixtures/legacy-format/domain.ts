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
  return /(?:^|[^\p{L}\p{N}])HOLD(?=$|[^\p{L}\p{N}])/iu.test(lane);
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
    deliverable: "Synthetic receipt; no Longform implementation",
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
