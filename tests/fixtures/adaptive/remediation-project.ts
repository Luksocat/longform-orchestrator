/**
 * Issue #12, slice E3: adaptive selection, pins and linked revisions, effort
 * escalation and the Max ceiling, owner preferences and coordination-only
 * oversight, through the controller and the orchestrator in mock mode, on
 * simulation tasks with synthetic evidence (contract sections 6 to 9).
 * Synthetic evidence qualifies simulation tasks only. Scenario IDs identify synthetic regression cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller, PROPOSAL_QUESTION_PREFIX, type CheckpointPin, type PinnedTaskSelection } from "../../../src/controller.js";
import { canonical, demoTask, digest, reviewPayload, specDigest, type Review } from "../../../src/domain.js";
import { Orchestrator } from "../../../src/orchestrator.js";
import { COORDINATION_INSTRUCTION, type ProjectContext } from "../../../src/project.js";
import { MockProvider } from "../../../src/providers.js";
import { defaultRoutingPolicy, floorFor, RoutingPolicySchema, type RoutingPolicy } from "../../../src/routing.js";
import { SqliteStore } from "../../../src/store.js";
import {
  adaptivePolicy,
  overseerOf,
  pairOf,
  seedEvidence,
  sim,
  simulationRoutes,
  type Quality,
} from "./evidence.js";

const routes = simulationRoutes();
/** The context of a pair given the listed advisor's advice (contract section 5.1). */
const ADVISED = {
  mode: "COORDINATION_ONLY" as const,
  producers: [sim(routes.find((r) => r.id === "astra-advisor-moderator")!, "advisor")],
};
/** A Codex High worker: below the Complex floor except through a floor exception. */
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
const withHigh = simulationRoutes([solHighWorker]);
type Pair = [worker: string, reviewer: string, quality: Quality, context?: "advised"];
type Demand = "BOUNDED" | "MODULE" | "PROGRAMME";
type Evidence = {
  pairs: Record<string, Pair[]>;
  overseers: Partial<Record<Demand, Array<[route: string, quality: Quality]>>>;
};
const COMPLEX: Pair[] = [
  ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
  ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "fair"],
];
/** COMPLEX plus the Codex worker's pair measured with the listed advisor's advice. */
const ADVISED_COMPLEX: Pair[] = [
  ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong"],
  ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "fair"],
  ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "strong", "advised"],
];
const EVIDENCE: Evidence = {
  pairs: {
    "general/complex": COMPLEX,
    "general/complex/bounded": COMPLEX,
    "general/expert": [["sol-expert-max-worker", "opus-expert-xhigh-reviewer", "strong"]],
  },
  overseers: {
    BOUNDED: [
      ["opus-xhigh-overseer", "strong"],
      ["sol-xhigh-overseer", "fair"],
    ],
    MODULE: [["sol-max-overseer", "strong"]],
  },
};
function seed(db: SqliteStore, evidence: Evidence, id = "test-plan", options: { deferImport?: boolean } = {}) {
  return seedEvidence(
    db,
    [
      ...Object.entries(evidence.pairs).map(([key, list]) => ({
        key,
        kind: "PAIR" as const,
        finalists: list.map(([w, r, quality, context]) => ({
          arrangement: pairOf(withHigh, w, r, context === "advised" ? ADVISED : undefined),
          quality,
        })),
      })),
      ...Object.entries(evidence.overseers).map(([demand, list]) => ({
        key: "oversight/" + demand.toLowerCase(),
        kind: "OVERSEER" as const,
        finalists: list!.map(([route, quality]) => ({
          arrangement: overseerOf(routes, route, demand as Demand),
          quality,
        })),
      })),
    ],
    id,
    options,
  );
}
type Plans = Array<{ id: string; digest: string }>;
/** Five worker attempts, the most a task allows. */
const BUDGET = { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 0, maxTokens: 100_000 };
const adaptive = (plans: Plans, options: Parameters<typeof adaptivePolicy>[1] = {}) =>
  adaptivePolicy(plans, { assessmentRequired: false, ...options });

function project(
  options: {
    evidence?: Evidence;
    policy?: (plans: Plans) => RoutingPolicy;
    tasks?: Array<{
      id: string;
      scope?: string;
      providers?: Array<"codex" | "claude">;
      resources?: string[];
      advice?: boolean;
      /** Expert work (the expert class's evidence routes it). */
      expert?: boolean;
      /** Its runs may leave a Drive gateway record in the workspace. */
      drive?: boolean;
      /** Acceptance also needs the controller's review receipt. */
      reviewAcceptance?: boolean;
      /** Worker attempts allowed (default the test budget's). */
      maxAttempts?: number;
    }>;
    /** A repository named "seed" that tasks may pin. */
    repo?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "adaptive-project-"));
  const repoPath = join(root, "seed-repo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoPath, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString().trim();
  if (options.repo) {
    mkdirSync(repoPath);
    git("init", "-q");
    writeFileSync(join(repoPath, "README.md"), "seed\n");
    git("add", ".");
    git("commit", "-q", "-m", "seed");
  }
  const path = join(root, "state.sqlite");
  let db = new SqliteStore(path);
  const { ref } = seed(db, options.evidence ?? EVIDENCE);
  let policy = (options.policy ?? ((plans) => adaptive(plans)))([ref]);
  const make = (store: SqliteStore) =>
    new Controller(store, {
      ownerUid: process.getuid!(),
      workspaceRoot: join(root, "workspaces"),
      routingPolicy: policy,
      verifyRoutingCapability: () => true,
      driveAuditRoot: join(root, "drive-audit"),
      ...(options.repo ? { repos: { seed: { path: repoPath } } } : {}),
    });
  const adapters = { codex: new MockProvider(), claude: new MockProvider() };
  let c = make(db),
    o = new Orchestrator(c, adapters, "claude");
  const id = o.submit({
    requestKey: randomUUID(),
    prompt: "An adaptive simulation project",
    context: { cwd: root, projectKey: "adaptive" },
    sourceRef: "test:owner",
  }).request.id;
  const tasks = options.tasks ?? [{ id: "A" }];
  c.importTasks(
    tasks.map((t) =>
      demoTask(t.id, {
        simulation: true,
        ...(t.scope ? { scope: t.scope } : {}),
        ...(t.providers ? { providers: t.providers } : {}),
        ...(t.resources ? { resources: t.resources } : {}),
        ...(t.advice ? { advice: { rationale: "Advice first", sourceRef: "test:owner" } } : {}),
        ...(t.expert ? { complexity: { level: "EXPERT" as const, rationale: "Expert work", sourceRef: "test:owner" } } : {}),
        ...(t.drive ? { writePaths: ["output/" + t.id, "drive-changes"] } : {}),
        ...(t.reviewAcceptance
          ? {
              acceptance: [
                { id: "receipt", description: "Controller verified synthetic output", evidenceKind: "LOCAL" as const },
                { id: "review", description: "Independent review passed", evidenceKind: "REVIEW" as const },
              ],
            }
          : {}),
        budget: t.maxAttempts ? { ...BUDGET, maxAttempts: t.maxAttempts } : BUDGET,
      }),
    ),
    c.localActor(),
  );
  for (const t of tasks)
    c.grant(
      t.id,
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: t.drive ? ["output/" + t.id, "drive-changes"] : ["output/" + t.id],
        decisionText: "Simulation work",
        sourceRef: "test:owner",
      },
      c.localActor(),
    );
  o.attach(id, tasks.map((t) => t.id));
  return {
    get c() {
      return c;
    },
    get o() {
      return o;
    },
    get db() {
      return db;
    },
    root,
    id,
    ref,
    /** Commit files to the seed repository; returns the commit. */
    commit(files: Record<string, string>) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repoPath, path)), { recursive: true });
        writeFileSync(join(repoPath, path), text);
      }
      git("add", ".");
      git("commit", "-q", "-m", "files");
      return git("rev-parse", "HEAD");
    },
    restart(next?: RoutingPolicy) {
      if (next) policy = next;
      db.close();
      db = new SqliteStore(path);
      c = make(db);
      o = new Orchestrator(c, adapters, "claude");
    },
    /** A second controller on its own connection to the same database. */
    second() {
      const other = new SqliteStore(path);
      return { c: make(other), close: () => other.close() };
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
type Project = ReturnType<typeof project>;
const ADVISED_EVIDENCE: Evidence = { ...EVIDENCE, pairs: { ...EVIDENCE.pairs, "general/complex": ADVISED_COMPLEX, "general/complex/bounded": ADVISED_COMPLEX } };

const taskPins = (f: Project, taskId = "A") =>
  f.db
    .all<{ body: string }>(
      "SELECT body FROM events WHERE kind='ADAPTIVE_TASK_PAIR_PINNED' AND task_id=? ORDER BY seq",
      taskId,
    )
    .map((r) => JSON.parse(r.body) as PinnedTaskSelection);
const checkpointPins = (f: Project) =>
  f.db
    .all<{ body: string }>("SELECT body FROM events WHERE kind='ADAPTIVE_CHECKPOINT_PINNED' ORDER BY seq")
    .map((r) => JSON.parse(r.body) as CheckpointPin);
const runs = (f: Project, role: string, taskId = "A") =>
  f.db
    .all<{ body: string }>("SELECT body FROM attempts WHERE task_id=? AND role=? ORDER BY rowid", taskId, role)
    .map((r) => JSON.parse(r.body));

const coordination = (context: ProjectContext, summary = "SIMULATION: coordination only.") => ({
  inputDigest: context.snapshot.inputDigest,
  summary,
  outcome: context.snapshot.tasks.every((t) => ["VERIFIED", "ACCEPTED"].includes(t.task.status))
    ? "COMPLETE"
    : "CONTINUE",
  assignments: context.snapshot.tasks.map((t) => ({ taskId: t.task.id, instruction: COORDINATION_INSTRUCTION })),
  nextTaskIds: context.snapshot.tasks
    .filter((t) => !["VERIFIED", "ACCEPTED"].includes(t.task.status))
    .map((t) => t.task.id),
  milestones: ["OWNER-ONLY-MILESTONE"],
  technicalDecisions: [] as unknown[],
  risks: ["OWNER-ONLY-RISK"],
  questionsForOwner: [],
  questionsForOperator: [],
});
/** A checkpoint recorded the way the orchestrator records one in mock mode. */
async function checkpoint(
  f: Project,
  plan: (context: ProjectContext) => unknown = (context) => coordination(context),
  taskId = "A",
) {
  const a = f.c.reserve(
    taskId,
    { role: "overseer", projectRequestId: f.id, requestKey: "oversight:" + randomUUID() },
    f.c.localActor(),
  );
  const context = a.projectContext!;
  const receipt = await f.c.execute(a, new MockProvider({ output: canonical(plan(context)) }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  f.db.transaction(() => {
    const recorded = f.c.recordProjectCheckpoint(context, a.id, receipt.output);
    (f.o as any).recordAstraQuestions(f.id, recorded);
  });
  return a;
}
/** The brief a live worker on the task would get now (question-routing.test.ts does the same). */
function liveWorkerBrief(f: Project, taskId = "A"): string {
  const context = f.c.projectContextFor(f.id);
  const a = {
    id: "preview-run",
    taskId,
    role: "worker",
    projectContext: context,
    provider: "codex",
    model: "m",
    effort: "e",
    specDigest: "",
    artifactRevision: "r1",
    workspace: "",
    state: "RESERVED",
    leaseOwner: "",
    leaseUntil: 0,
    started: false,
    simulation: false,
    baseline: {},
    macroBaseline: "",
    condition: "",
    requestKey: "",
  };
  return (f.c as any).briefParts({ ...f.c.task(taskId), simulation: false }, a, true).text as string;
}
/** A worker run (the pending rework, if a review failed), with its brief. */
async function work(f: Project, output = "SIMULATION: the work " + randomUUID(), taskId = "A") {
  const rework = f.c.reworkPending(taskId);
  const a = f.c.reserve(
    taskId,
    {
      requestKey: "work:" + randomUUID(),
      projectRequestId: f.id,
      ...(rework ? { rework: rework.reviewRunId } : {}),
    },
    f.c.localActor(),
  );
  const provider = new MockProvider({ output });
  const receipt = await f.c.execute(a, provider, f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  return { attempt: a, brief: provider.requests[0]!.brief, receipt };
}
/** A worker run that does something in its workspace while it runs. */
async function workWith(
  f: Project,
  taskId: string,
  act: (a: Attempt) => void,
  provider = new MockProvider({ output: "SIMULATION: the work " + randomUUID() }),
) {
  const rework = f.c.reworkPending(taskId);
  const a = f.c.reserve(
    taskId,
    { requestKey: "work:" + randomUUID(), projectRequestId: f.id, ...(rework ? { rework: rework.reviewRunId } : {}) },
    f.c.localActor(),
  );
  act(a);
  const receipt = await f.c.execute(a, provider, f.c.localActor());
  return { attempt: a, receipt };
}
type Attempt = ReturnType<Controller["reserve"]>;
/** A file a run writes in its workspace. */
function put(a: Attempt, path: string, text: string) {
  mkdirSync(dirname(join(a.workspace, path)), { recursive: true });
  writeFileSync(join(a.workspace, path), text);
}
/** A Drive gateway record, as the gateway leaves one. */
function gateway(dir: string, entries: unknown[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const AT = "2026-10-29T00:00:00.000Z";
/** An evidence envelope a person files, naming the run it came from. */
const note = (id: string, taskId: string, runId: string, text = id) => ({
  id,
  taskId,
  kind: "LOCAL",
  uri: "local:" + id,
  revision: "r1",
  digest: digest(text),
  retrievedAt: AT,
  authorityTier: "UNVERIFIED",
  authentication: "LOCAL_IMPORT",
  currentness: "CURRENT_AT_RETRIEVAL",
  claims: ["A note"],
  metadata: { runId },
});
/** A reviewer run and its recorded report, as the orchestrator records one. */
async function review(f: Project, verdict: "PASS" | "FAIL", taskId = "A", act?: (a: Attempt) => void) {
  const a = f.c.reserve(
    taskId,
    { role: "reviewer", projectRequestId: f.id, requestKey: "review:" + randomUUID() },
    f.c.localActor(),
  );
  act?.(a);
  const t = f.c.task(taskId);
  const evidenceIds = f.c.evidenceFor(taskId).map((e) => e.id);
  const report: Review = {
    id: "workflow-review-" + a.id,
    taskId,
    runId: a.id,
    artifactRevision: t.artifactRevision,
    specDigest: specDigest(t),
    reviewerSession: "pending-harness-session",
    provider: a.provider,
    authorshipDisclosure: "Separate synthetic provider and session fixture.",
    availableEvidence: evidenceIds,
    findings:
      verdict === "FAIL"
        ? [{ materiality: "MAJOR", evidenceIds: [], description: "The greeting is wrong" }]
        : [],
    testsExecuted: [],
    testsNotExecuted: ["Synthetic reviewer executed no tests."],
    conflictingEvidence: [],
    remediation: verdict === "FAIL" ? ["Correct the greeting"] : [],
    residualHolds: [],
    verdict,
    scope: "Synthetic fixture " + taskId,
    nextAuthorizedStep: "Run deterministic audits and verification.",
    auditAssessments: (["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"] as const).map((kind) => ({
      kind,
      result: "PASS" as const,
      evidenceIds,
      assessment: "Simulated assessment for an orchestration fixture only.",
      limitations: [],
    })),
  };
  const receipt = await f.c.execute(
    a,
    new MockProvider({ output: canonical(reviewPayload(report)) }),
    f.c.localActor(),
  );
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  f.c.review(
    { ...JSON.parse(receipt.output), id: "workflow-review-" + a.id, runId: a.id, reviewerSession: receipt.sessionId },
    f.c.localActor(),
  );
  return a;
}
const exactOf = (a: any) => [a.provider, a.model, a.effort];

/** The owner accepts a task's reviewed work, its audits taken from that review. */
function acceptTask(f: Project, taskId: string, reviewRunId: string) {
  const actor = f.c.localActor();
  f.c.grant(
    taskId,
    { id: randomUUID(), operations: ["ACCEPT"], paths: ["output/" + taskId], decisionText: "The owner may accept", sourceRef: "test:owner" },
    actor,
  );
  f.c.audit(taskId, actor, reviewRunId);
  f.c.verify(taskId, actor);
  f.c.decide(
    taskId,
    {
      id: "accept-" + taskId,
      text: "Accept the synthetic work",
      sourceRef: "test:owner",
      alternatives: [],
      limits: ["simulation"],
      operations: ["ACCEPT"],
      artifactRevision: f.c.task(taskId).artifactRevision,
    },
    actor,
  );
  f.c.accept(taskId, actor);
}
/** Revise a task to name evidence as its sources, and grant its work again. */
function bind(f: Project, taskId: string, evidence: Array<{ id: string; digest: string; revision: string }>) {
  const prior = f.c.task(taskId);
  f.c.revise(
    taskId,
    { ...prior, specVersion: prior.specVersion + 1, sources: evidence.map((e) => ({ evidenceId: e.id, revision: e.revision, digest: e.digest })) },
    f.c.localActor(),
  );
  f.o.rebind(f.id, [taskId]);
  f.c.grant(
    taskId,
    { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/" + taskId], decisionText: "Revised work", sourceRef: "test:owner" },
    f.c.localActor(),
  );
}


export { project, checkpoint, work, workWith, review, put, gateway, note, taskPins, checkpointPins, runs, coordination, bind, acceptTask, seed, EVIDENCE, COMPLEX, ADVISED_EVIDENCE, BUDGET, AT };
export type { Project, Evidence, Pair, Attempt };
