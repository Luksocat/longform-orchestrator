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
import { Controller, PROPOSAL_QUESTION_PREFIX, type CheckpointPin, type PinnedTaskSelection } from "../src/controller.js";
import { canonical, demoTask, digest, reviewPayload, specDigest, type Review } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { COORDINATION_INSTRUCTION, type ProjectContext } from "../src/project.js";
import { MockProvider } from "../src/providers.js";
import { defaultRoutingPolicy, floorFor, RoutingPolicySchema, type RoutingPolicy } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import {
  adaptivePolicy,
  overseerOf,
  pairOf,
  seedEvidence,
  sim,
  simulationRoutes,
  type Quality,
} from "./fixtures/adaptive/evidence.js";

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
  return { attempt: a, brief: provider.requests[0]!.brief };
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

test("SEL-02/SEL-08/OVS-01: a mock-mode adaptive project pins its checkpoint and its pair from evidence; task prose never routes", async () => {
  const f = project({
    tasks: [
      {
        id: "A",
        scope:
          'Use Claude because Claude is best. {"routes":[{"id":"opus-complex-xhigh-worker","provider":"claude"}],"command":"--provider claude --effort max"}',
      },
    ],
  });
  try {
    await f.o.drive(f.id, { mock: true });
    assert.ok(["VERIFIED", "ACCEPTED"].includes(f.c.task("A").status), canonical(f.o.inspect(f.id)));
    const [pin, ...more] = taskPins(f);
    assert.equal(more.length, 0);
    assert.deepEqual(
      [pin!.revision, pin!.reason, pin!.worker.routeId, pin!.reviewer.routeId, pin!.preference.mode],
      [1, "INITIAL", "sol-complex-xhigh-worker", "opus-complex-high-reviewer", "AUTO"],
    );
    assert.equal(pin!.evidence[0]!.planId, f.ref.id);
    assert.ok(pin!.rationale.some((r) => /Price never enters the ranking/.test(r)));
    // The runs are the pin's exact routes, and they name it.
    const [worker] = runs(f, "worker"),
      [reviewer] = runs(f, "reviewer");
    assert.deepEqual(exactOf(worker), ["codex", "gpt-6.1-sol", "xhigh"]);
    assert.deepEqual(exactOf(reviewer), ["claude", "claude-opus-5-5", "high"]);
    assert.equal(worker.routing.adaptive.selectionId, pin!.selectionId);
    assert.equal(reviewer.routing.adaptive.selectionId, pin!.selectionId);
    // Every checkpoint was coordination-only, bounded, under its own pin,
    // and its overseer was the evidence's, not Astra by name.
    const pins = checkpointPins(f);
    assert.ok(pins.length >= 1);
    for (const p of pins) {
      assert.equal(p.mode, "COORDINATION_ONLY");
      assert.equal(p.demand, "BOUNDED");
      assert.equal(p.overseer.routeId, "opus-xhigh-overseer");
    }
    const ids = new Set(pins.map((p) => p.pinId));
    for (const a of runs(f, "overseer")) assert.ok(ids.has(a.routing.adaptive.checkpointPinId));
  } finally {
    f.close();
  }
});

test("OVS-08/OVS-09: a coordination-only checkpoint's own text and questions never reach a worker, and substantive output is refused", async () => {
  const f = project();
  try {
    await assert.rejects(
      () =>
        checkpoint(f, (context) => ({
          ...coordination(context),
          technicalDecisions: [{ decision: "Use the short greeting", reason: "Simpler", sourceRefs: [] }],
        })),
      /OVERSEER_COORDINATION_SUBSTANTIVE/,
    );
    await checkpoint(f, (context) => ({
      ...coordination(context, "PLAN-TEXT-FOR-THE-OWNER-ONLY"),
      outcome: "ASK_OWNER",
      assignments: [],
      nextTaskIds: [],
      questionsForOwner: [
        {
          question: "OVERSEER-QUESTION: which greeting? 1) Short (Recommended): concise. 2) Warm: welcoming.",
          taskIds: ["A"],
          projectWide: false,
        },
      ],
    }));
    // The owner is told the question and its answer reach no worker.
    const asked = f.o.inspect(f.id).questions.find((q: any) => /OVERSEER-QUESTION/.test(q.text))!;
    assert.match(asked.text, /Workers will not see this question or your answer/);
    const brief = liveWorkerBrief(f);
    for (const hidden of ["PLAN-TEXT-FOR-THE-OWNER-ONLY", "OWNER-ONLY-MILESTONE", "OWNER-ONLY-RISK", "OVERSEER-QUESTION"])
      assert.ok(!brief.includes(hidden), hidden + " reached the worker");
    assert.ok(brief.includes('"mode":"COORDINATION_ONLY"'));
  } finally {
    f.close();
  }
  const g = project();
  try {
    await assert.rejects(
      () =>
        checkpoint(g, (context) => ({
          ...coordination(context),
          assignments: [{ taskId: "A", instruction: "Write it in the short style, using the template." }],
        })),
      /OVERSEER_COORDINATION_SUBSTANTIVE/,
    );
    await checkpoint(g, (context) => coordination(context, "PLAN-TEXT-FOR-THE-OWNER-ONLY"));
    const brief = liveWorkerBrief(g);
    assert.ok(!brief.includes("PLAN-TEXT-FOR-THE-OWNER-ONLY"));
    assert.ok(brief.includes(COORDINATION_INSTRUCTION));
    // The coordination-only overseer (Claude here) shaped no work, so the
    // pinned Claude reviewer stays independent (OVS-09).
    assert.equal(checkpointPins(g).at(-1)!.overseer.provider, "claude");
    await work(g);
    const reviewer = await review(g, "PASS");
    assert.deepEqual(exactOf(reviewer), ["claude", "claude-opus-5-5", "high"]);
  } finally {
    g.close();
  }
});

test("OVS-06: with no qualified overseer the checkpoint holds and no worker is admitted", async () => {
  const f = project({ evidence: { ...EVIDENCE, overseers: {} } });
  try {
    await assert.rejects(() => checkpoint(f), /ADAPTIVE_CHECKPOINT_NO_QUALIFIED_OVERSEER/);
    assert.throws(
      () => f.c.reserve("A", { requestKey: "w", projectRequestId: f.id }, f.c.localActor()),
      /PROJECT_OVERSIGHT_REQUIRED/,
    );
    await f.o.drive(f.id, { mock: true });
    assert.equal(runs(f, "worker").length, 0);
    assert.equal(taskPins(f).length, 0);
    assert.match(canonical(f.o.inspect(f.id)), /ADAPTIVE_CHECKPOINT_NO_QUALIFIED_OVERSEER/);
  } finally {
    f.close();
  }
});

test("OVS-02: shared state across tasks raises the checkpoint's demand and its overseer", async () => {
  // Two easy tasks that claim the same resource are coupled (E3 review F10).
  const f = project({ tasks: ["A", "B"].map((id) => ({ id, resources: ["shared-greeting"] })) });
  try {
    await checkpoint(f);
    const [pin] = checkpointPins(f);
    assert.equal(pin!.demand, "MODULE");
    assert.equal(pin!.overseer.routeId, "sol-max-overseer");
    assert.deepEqual(pin!.demandReasons, ["coupling 1"]);
  } finally {
    f.close();
  }
  const g = project({ tasks: ["A", "B"].map((id) => ({ id })) });
  try {
    await checkpoint(g);
    assert.equal(checkpointPins(g)[0]!.demand, "BOUNDED");
  } finally {
    g.close();
  }
});

test("SEL-10: with no eligible independent reviewer nothing is reserved", async () => {
  const f = project({ tasks: [{ id: "A", providers: ["codex"] }] });
  try {
    await checkpoint(f);
    assert.throws(
      () => f.c.reserve("A", { requestKey: "w", projectRequestId: f.id }, f.c.localActor()),
      /ADAPTIVE_NO_INDEPENDENT_REVIEWER/,
    );
    assert.equal(runs(f, "worker").length, 0);
    assert.equal(taskPins(f).length, 0);
  } finally {
    f.close();
  }
});

test("DUR-09: with intake disabled new work waits, and pinned work continues", async () => {
  const off = project({ policy: (plans) => adaptive(plans, { intake: "DISABLED" }) });
  try {
    await checkpoint(off);
    assert.throws(
      () => off.c.reserve("A", { requestKey: "w", projectRequestId: off.id }, off.c.localActor()),
      /ADAPTIVE_INTAKE_DISABLED/,
    );
    assert.equal(taskPins(off).length, 0);
  } finally {
    off.close();
  }
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    f.restart(adaptive([f.ref], { intake: "DISABLED" }));
    await review(f, "FAIL");
    await checkpoint(f);
    const { attempt } = await work(f);
    assert.deepEqual(exactOf(attempt), ["codex", "gpt-6.1-sol", "xhigh"]);
    assert.equal(taskPins(f).length, 1);
  } finally {
    f.close();
  }
});

test("DUR-01: a second controller finds the sealed selection and cannot dispatch another", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const first = f.c.reserve("A", { requestKey: "w1", projectRequestId: f.id }, f.c.localActor());
    const other = f.second();
    try {
      const route = other.c.route("A");
      assert.ok(route.ok && route.routeId === "sol-complex-xhigh-worker");
      assert.throws(() => other.c.reserve("A", { requestKey: "w2", projectRequestId: f.id }, other.c.localActor()));
    } finally {
      other.close();
    }
    assert.equal(taskPins(f).length, 1);
    assert.equal(runs(f, "worker").length, 1);
    assert.equal(first.routing!.adaptive && "selectionId" in first.routing!.adaptive, true);
  } finally {
    f.close();
  }
});

test("DUR-02/DUR-04/OVS-05: after a restart or a policy change the pin is reused, never re-selected; if it no longer qualifies, the task holds", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    // The same policy with its routes in another order: nothing moves.
    f.restart(adaptive([f.ref], { routes: [...routes].reverse() }));
    const reviewer = await review(f, "FAIL");
    assert.deepEqual(exactOf(reviewer), ["claude", "claude-opus-5-5", "high"]);
    await checkpoint(f);
    const { attempt } = await work(f);
    assert.deepEqual(exactOf(attempt), ["codex", "gpt-6.1-sol", "xhigh"]);
    assert.equal(taskPins(f).length, 1);
  } finally {
    f.close();
  }
  // A plan listed first that measured only the other pair: the pinned pair
  // no longer qualifies, and nothing is re-selected or swapped.
  const g = project();
  try {
    await checkpoint(g);
    await work(g);
    await review(g, "FAIL");
    await checkpoint(g);
    const other = seed(
      g.db,
      { pairs: { "general/complex": [COMPLEX[1]!], "general/complex/bounded": [COMPLEX[1]!] }, overseers: EVIDENCE.overseers },
      "other-plan",
    );
    g.restart(adaptive([other.ref, g.ref]));
    assert.throws(
      () =>
        g.c.reserve(
          "A",
          { requestKey: "w2", projectRequestId: g.id, rework: g.c.reworkPending("A")!.reviewRunId },
          g.c.localActor(),
        ),
      /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE.*no longer has qualifying evidence/,
    );
    assert.equal(taskPins(g).length, 1);
  } finally {
    g.close();
  }
});

test("SEL-12: a pinned route that becomes unavailable holds its task; no other route is swapped in", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    f.restart(
      adaptive([f.ref], {
        routes: routes.map((r) => (r.id === "opus-complex-high-reviewer" ? { ...r, enabled: false } : r)),
      }),
    );
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "r" }, f.c.localActor()),
      /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE.*opus-complex-high-reviewer: ROUTE_DISABLED/,
    );
    assert.equal(runs(f, "reviewer").length, 0);
    assert.equal(taskPins(f).length, 1);
  } finally {
    f.close();
  }
});

test("a task pinned under the adaptive workflow never continues under fixed pairing", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    const twoTier = JSON.parse(
      readFileSync(new URL("./fixtures/adaptive/two-tier-policy.json", import.meta.url), "utf8"),
    );
    f.restart(
      RoutingPolicySchema.parse({ ...twoTier, routes: twoTier.routes.map((r: any) => ({ ...r, simulation: true })) }),
    );
    assert.equal(f.c.adaptive(), false);
    const r = f.c.route("A", "reviewer");
    assert.ok(!r.ok && /ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW/.test(r.reasons.join("|")));
    assert.equal(f.c.legacyClaudeAuthorship(f.c.task("A")), false);
  } finally {
    f.close();
  }
});

test("SEL-09: an owner's PINNED preference picks a qualified pair, a refused one holds, and a later preference never rewrites a pin", async () => {
  const f = project();
  try {
    const owner = f.c.localActor();
    f.c.recordAdaptivePreference(
      "A",
      { mode: "PINNED", workerRouteId: "opus-complex-xhigh-worker", reason: "The owner prefers Opus here" },
      owner,
    );
    await checkpoint(f);
    const { attempt } = await work(f);
    const [pin] = taskPins(f);
    assert.deepEqual([pin!.worker.routeId, pin!.reviewer.routeId, pin!.preference.mode], [
      "opus-complex-xhigh-worker",
      "sol-complex-xhigh-reviewer",
      "PINNED",
    ]);
    assert.equal(typeof pin!.preference.eventSeq, "number");
    assert.deepEqual(exactOf(attempt), ["claude", "claude-opus-5-5", "xhigh"]);
    // A preference recorded after the pin applies to no pinned work.
    f.c.recordAdaptivePreference(
      "A",
      { mode: "PINNED", workerRouteId: "sol-complex-xhigh-worker", reason: "Changed my mind" },
      owner,
    );
    await review(f, "FAIL");
    await checkpoint(f);
    const again = await work(f);
    assert.deepEqual(exactOf(again.attempt), ["claude", "claude-opus-5-5", "xhigh"]);
    assert.equal(taskPins(f).length, 1);
    assert.throws(
      () => f.c.recordAdaptivePreference("A", { mode: "PINNED", reason: "no route" }, owner),
      /PINNED names a worker route/,
    );
  } finally {
    f.close();
  }
  const refused = project();
  try {
    refused.c.recordAdaptivePreference(
      "A",
      { mode: "PINNED", workerRouteId: "sol-complex-max-worker", reason: "Max for everything" },
      refused.c.localActor(),
    );
    await checkpoint(refused);
    assert.throws(
      () => refused.c.reserve("A", { requestKey: "w", projectRequestId: refused.id }, refused.c.localActor()),
      /ADAPTIVE_PINNED_PREFERENCE_REFUSED/,
    );
    assert.equal(taskPins(refused).length, 0);
  } finally {
    refused.close();
  }
});

/**
 * Two failed reviews at Complex, then two at Expert Max: the task's pins
 * reach the ceiling continuation (revision 3). Returns the revisions.
 */
async function toCeiling(f: Project) {
  for (let i = 0; i < 4; i++) {
    await checkpoint(f);
    await work(f, "SIMULATION: attempt " + (i + 1));
    await review(f, "FAIL");
  }
  await checkpoint(f);
}
const CORRECTED = (n: number) => `SIMULATION: corrected attempt ${n}\nCORRECTIONS:\n1: output — rewrote the greeting\n`;

test("DUR-10/DUR-03: failed reviews append linked revisions on the same providers and models; the old pin and its runs stay", async () => {
  const f = project();
  try {
    await toCeiling(f);
    const [r1, r2] = taskPins(f);
    const reviews = runs(f, "reviewer").map((a) => a.id);
    assert.deepEqual(
      [r2!.revision, r2!.reason, r2!.tier, r2!.worker.routeId, r2!.reviewer.routeId, r2!.previousSelectionId],
      [2, "EFFORT_ESCALATION", "EXPERT", "sol-expert-max-worker", "opus-expert-xhigh-reviewer", r1!.selectionId],
    );
    assert.deepEqual(r2!.trigger!.failedReviewRunIds, reviews.slice(0, 2));
    assert.equal(r1!.revision, 1);
    assert.equal(r1!.worker.routeId, "sol-complex-xhigh-worker");
    // Runs 1 and 2 ran under revision 1, runs 3 and 4 under revision 2.
    const workers = runs(f, "worker");
    assert.deepEqual(
      workers.map((a) => [a.routing.adaptive.revision, a.effort]),
      [
        [1, "xhigh"],
        [1, "xhigh"],
        [2, "max"],
        [2, "max"],
      ],
    );
    assert.deepEqual(runs(f, "reviewer").map((a) => a.effort), ["high", "high", "xhigh", "xhigh"]);
  } finally {
    f.close();
  }
});

test("DUR-12: at Max the next revision is a ceiling continuation, which must make a real correction before any review", async () => {
  const f = project();
  try {
    await toCeiling(f);
    // Without an item-by-item correction the work is never reviewed.
    await work(f, "SIMULATION: attempt 5, unchanged in substance");
    const r3 = taskPins(f)[2]!;
    assert.deepEqual([r3.revision, r3.reason, r3.worker.routeId], [3, "CEILING_CONTINUATION", "sol-expert-max-worker"]);
    assert.deepEqual(r3.ceiling, { worker: true, reviewer: false, continuationsUsed: 1 });
    assert.ok(r3.rationale.some((r) => /must correct every must-fix item/.test(r)));
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "r5" }, f.c.localActor()),
      /ADAPTIVE_CEILING_NO_CORRECTION.*no line in the CORRECTIONS section/,
    );
  } finally {
    f.close();
  }
  // The faulted response repeated, with a correction map added, changes nothing.
  const g = project();
  try {
    await toCeiling(g);
    await work(g, "SIMULATION: attempt 4\nCORRECTIONS:\n1: output — rewrote the greeting\n");
    assert.throws(
      () => g.c.reserve("A", { role: "reviewer", projectRequestId: g.id, requestKey: "r5" }, g.c.localActor()),
      /ADAPTIVE_CEILING_NO_CORRECTION.*the response did not change/,
    );
  } finally {
    g.close();
  }
  // A real correction goes to the pinned independent reviewer.
  const h = project();
  try {
    await toCeiling(h);
    await work(h, CORRECTED(5));
    const reviewer = await review(h, "FAIL");
    assert.deepEqual(exactOf(reviewer), ["claude", "claude-opus-5-5", "xhigh"]);
  } finally {
    h.close();
  }
});

test("DUR-12: continuations are bounded within a task, and a fix task cannot reset the bound", async () => {
  const none = project({ policy: (plans) => adaptive(plans, { continuations: 0 }) });
  try {
    await toCeiling(none);
    assert.throws(
      () =>
        none.c.reserve(
          "A",
          { requestKey: "w5", projectRequestId: none.id, rework: none.c.reworkPending("A")!.reviewRunId },
          none.c.localActor(),
        ),
      /ADAPTIVE_CEILING_EXHAUSTED/,
    );
    assert.equal(taskPins(none).length, 2);
  } finally {
    none.close();
  }
  const f = project();
  try {
    await toCeiling(f);
    await work(f, CORRECTED(5));
    await review(f, "FAIL");
    // A has used its one continuation; B fixes A and inherits its history.
    const actor = f.c.localActor();
    f.c.importTasks(
      [demoTask("B", { simulation: true, fixes: "A", writePaths: ["output/A"], budget: BUDGET })],
      actor,
    );
    f.c.grant(
      "B",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Fix A", sourceRef: "test:owner" },
      actor,
    );
    f.o.attach(f.id, ["B"]);
    await checkpoint(f, undefined, "B");
    assert.throws(
      () => f.c.reserve("B", { requestKey: "wb", projectRequestId: f.id }, actor),
      /ADAPTIVE_CEILING_EXHAUSTED.*sol-expert-max-worker: CEILING_EXHAUSTED/,
    );
    assert.equal(taskPins(f, "B").length, 0);
  } finally {
    f.close();
  }
});

test("CLI: the owner records a routing preference; without --execute nothing is written", async () => {
  const f = project();
  try {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsx = fileURLToPath(import.meta.resolve("tsx"));
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const run = (...args: string[]) =>
      promisify(execFile)(process.execPath, ["--import", tsx, cli, ...args, "--db", join(f.root, "state.sqlite")], {
        cwd: f.root,
        env,
        timeout: 30_000,
      }).then((r) => JSON.parse(r.stdout));
    const file = join(f.root, "preference.json");
    writeFileSync(file, JSON.stringify({ mode: "PINNED", workerRouteId: "opus-complex-xhigh-worker", reason: "Opus for this one" }));
    assert.deepEqual(await run("adaptive", "prefer", "--task", "A", "--file", file), {
      dryRun: true,
      action: "adaptive prefer",
      taskId: "A",
    });
    const recorded = await run("adaptive", "prefer", "--task", "A", "--file", file, "--execute");
    assert.equal(recorded.mode, "PINNED");
    // The contract's flag form records the same kind of preference.
    const flags = await run("adaptive", "prefer", "--task", "A", "--mode", "AUTO", "--reason", "Let the controller choose", "--execute");
    assert.equal(flags.mode, "AUTO");
    writeFileSync(file, JSON.stringify({ mode: "PINNED", reason: "no route named" }));
    await assert.rejects(() => run("adaptive", "prefer", "--task", "A", "--file", file, "--execute"));
    await assert.rejects(() => run("adaptive", "prefer", "--file", file, "--execute"), /ADAPTIVE_PREFER_NEEDS_ONE_TASK/);
    const events = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='ADAPTIVE_PREFERENCE_RECORDED'");
    assert.equal(events.length, 2);
    assert.equal(JSON.parse(events[0]!.body).workerRouteId, "opus-complex-xhigh-worker");
    assert.equal(JSON.parse(events[1]!.body).mode, "AUTO");
  } finally {
    f.close();
  }
});

test("E5 review V1: the scorecard and rollback check write nothing, not even setup", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsx = fileURLToPath(import.meta.resolve("tsx"));
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const run = (db: string, ...args: string[]) =>
      promisify(execFile)(process.execPath, ["--import", tsx, cli, ...args, "--db", db], { cwd: f.root, env, timeout: 30_000 });
    // A database that does not exist is not created.
    const missing = join(f.root, "elsewhere", "state.sqlite");
    await assert.rejects(() => run(missing, "adaptive", "rollback-check"), /DATABASE_NOT_FOUND/);
    assert.equal(existsSync(join(f.root, "elsewhere")), false);
    // An existing one, as the CLI leaves it, is opened read-only under the
    // adaptive policy: its journal and schema stay as they are.
    f.db.run("INSERT INTO settings VALUES(?,?)", "owner_uid", String(process.getuid!()));
    const policy = join(f.root, "policy.json");
    writeFileSync(policy, JSON.stringify(adaptive([f.ref])));
    // The database's files byte for byte (its main file and WAL), and its rows.
    const bytesOf = (path: string) => (existsSync(path) ? digest(readFileSync(path)) : "absent");
    const before = () => [
      bytesOf(join(f.root, "state.sqlite")),
      bytesOf(join(f.root, "state.sqlite-wal")),
      f.db.get<{ n: number }>("SELECT count(*) AS n FROM events")!.n,
      f.db.get<{ n: number }>("SELECT count(*) AS n FROM schema_migrations")!.n,
      f.db.get<{ n: number }>("SELECT count(*) AS n FROM attempts")!.n,
    ];
    const was = before();
    const path = join(f.root, "state.sqlite");
    const check = JSON.parse((await run(path, "adaptive", "rollback-check", "--routing-policy", policy)).stdout);
    assert.equal(check.readOnly, true);
    assert.deepEqual(check.taskPins.map((p: any) => p.taskId), ["A"]);
    const card = JSON.parse((await run(path, "adaptive", "scorecard", "--task", "A", "--routing-policy", policy)).stdout);
    assert.equal(card.worker.routeId, "sol-complex-xhigh-worker");
    assert.equal(JSON.parse((await run(path, "adaptive", "scorecard", "--request-id", f.id, "--routing-policy", policy)).stdout).readOnly, true);
    assert.deepEqual(before(), was);
  } finally {
    f.close();
  }
});

test("E5 review V2 and V8: a paused pinned route is a timed hold, and a pinned task under the other workflow shows its hold", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    // The pinned Claude reviewer meets a usage limit: Claude pauses.
    const a = f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "review-limited" }, f.c.localActor());
    const limit = {
      kind: "USAGE_LIMIT" as const,
      evidence: "test:limit",
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      resetBasis: "STRUCTURED" as const,
      message: "Usage limit reached",
    };
    await f.c.execute(a, new MockProvider({ outcome: "failure", limit }), f.c.localActor());
    const holds = () => f.o.inspect(f.id).tasks.flatMap((t: any) => t.holds as string[]);
    assert.ok(holds().includes("PROVIDER_PAUSED:claude"), canonical(holds()));
    assert.ok(!holds().includes("ADAPTIVE_PINNED_ROUTE_UNAVAILABLE"));
    // Under the two-tier workflow the pinned task holds, and says so (V8).
    f.restart(defaultRoutingPolicy());
    assert.ok(holds().includes("ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW"), canonical(holds()));
  } finally {
    f.close();
  }
});

test("E5 review V4 and V5: an unqualified escalation is asked under GUIDED, and the scorecard shows the reviewer's hold", async () => {
  const noExpert: Evidence = { ...EVIDENCE, pairs: { "general/complex": COMPLEX, "general/complex/bounded": COMPLEX } };
  const f = project({ evidence: noExpert, policy: (plans) => adaptive(plans, { preference: "GUIDED" }) });
  try {
    for (let i = 0; i < 2; i++) {
      await checkpoint(f);
      await work(f);
      await review(f, "FAIL");
    }
    await f.o.drive(f.id, { mock: true });
    const asked = f.db
      .all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r) => JSON.parse(r.body).question)
      .filter((q: any) => String(q.key).startsWith("adaptive-routing:"));
    assert.equal(asked.length, 1, canonical(f.o.inspect(f.id).tasks));
    assert.match(asked[0].text, /can't move up a level/);
  } finally {
    f.close();
  }
  const g = project();
  try {
    await toCeiling(g);
    // The ceiling attempt's work has no CORRECTIONS list: its review holds.
    await work(g, "SIMULATION: no corrections listed");
    const card = g.c.adaptiveScorecard("A");
    assert.ok(
      (card.heldBecause ?? []).some((h: any) => JSON.stringify(h).includes("ADAPTIVE_CEILING_NO_CORRECTION")),
      canonical(card.heldBecause),
    );
  } finally {
    g.close();
  }
});

test("E5 rereview W2: only a pinned route its provider's pause alone holds shows as the pause", async () => {
  // B may only use Claude: no independent reviewer exists for it, whatever pauses.
  const f = project({ tasks: [{ id: "A" }, { id: "B", providers: ["claude"] }] });
  try {
    await checkpoint(f);
    await work(f);
    const a = f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "review-limited" }, f.c.localActor());
    const limit = {
      kind: "USAGE_LIMIT" as const,
      evidence: "test:limit",
      resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      resetBasis: "STRUCTURED" as const,
      message: "Usage limit reached",
    };
    await f.c.execute(a, new MockProvider({ outcome: "failure", limit }), f.c.localActor());
    const holdsOf = (id: string) => f.o.inspect(f.id).tasks.filter((t: any) => t.taskId === id).flatMap((t: any) => t.holds as string[]);
    assert.ok(holdsOf("A").includes("PROVIDER_PAUSED:claude"));
    // B is not pinned: its selection hold stays its own, whatever its reasons mention.
    assert.ok(!holdsOf("B").includes("PROVIDER_PAUSED:claude"), canonical(holdsOf("B")));
    assert.ok(holdsOf("B").some((h) => h.startsWith("ADAPTIVE_")), canonical(holdsOf("B")));
  } finally {
    f.close();
  }
});

test("E5 rereview W3, W5-W8: scorecards say what admission says, and what the pair shown needs", async () => {
  // W3: an open question holds the review; the card says so.
  const f = project({ tasks: [{ id: "A", maxAttempts: 1 }] });
  try {
    await checkpoint(f);
    await work(f);
    // The only worker attempt succeeded; review is still admissible.
    assert.equal(f.c.adaptiveScorecard("A").heldBecause, null);
    assert.equal(f.c.adaptiveScorecard("A").nextStep, "reviewer");
    // W8: under the two-tier workflow the pinned task's card still says why it holds.
    const adaptivePolicyNow = adaptive([f.ref]);
    f.restart(defaultRoutingPolicy());
    assert.match(canonical(f.c.adaptiveScorecard("A").heldBecause), /ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW/);
    f.restart(adaptivePolicyNow);
    f.o.ask(f.id, { key: "greeting", text: "Which greeting?", taskId: "A" });
    assert.match(canonical(f.c.adaptiveScorecard("A").heldBecause), /PROJECT_QUESTION_OPEN/);
  } finally {
    f.close();
  }
  // W6 and W7: a lone qualified Claude-worker pair, before a pin.
  const opusOnly: Pair[] = [["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "strong"]];
  const g = project({ evidence: { ...EVIDENCE, pairs: { ...EVIDENCE.pairs, "general/complex": opusOnly, "general/complex/bounded": opusOnly } } });
  try {
    await checkpoint(g);
    const card = g.c.adaptiveScorecard("A");
    assert.equal(card.worker?.provider, "claude");
    assert.deepEqual(card.floors, {
      worker: floorFor("claude", "worker", card.task.tier as "COMPLEX"),
      reviewer: floorFor("codex", "reviewer", card.task.tier as "COMPLEX"),
    });
    assert.ok(card.why.some((line: string) => /No other pair qualified/.test(line)), canonical(card.why));
  } finally {
    g.close();
  }
  // W5: a substantive default mode holds the checkpoint; the request card recommends nothing.
  const h = project({ policy: (plans) => adaptive(plans, { defaultMode: "SUBSTANTIVE" }) });
  try {
    const card = h.c.checkpointScorecard(h.id);
    assert.equal(card.modeNow?.mode, "SUBSTANTIVE");
    assert.equal(card.labels.recommended, false);
    assert.equal(card.overseerNow, null);
    assert.match(canonical(card.heldBecause), /ADAPTIVE_SUBSTANTIVE_OVERSIGHT_UNAVAILABLE/);
  } finally {
    h.close();
  }
});

test("E5 rereview W4: a lineage conflict and a pinned pair's lapsed evidence are asked under GUIDED", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }], repo: true, policy: (plans) => adaptive(plans, { preference: "GUIDED" }) });
  try {
    await checkpoint(f, undefined, "B");
    await work(f, undefined, "B");
    const claude = await review(f, "PASS", "B");
    const text = String(JSON.parse(f.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", claude.id)!.body).output);
    const commit = f.commit({ "output/A/notes.txt": text });
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: prior.specVersion + 1, repo: { name: "seed", commit } }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    f.c.grant(
      "A",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Seeded work", sourceRef: "test:owner" },
      f.c.localActor(),
    );
    await f.o.drive(f.id, { mock: true });
    const asked = () =>
      f.db
        .all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
        .map((r) => JSON.parse(r.body).question)
        .filter((q: any) => String(q.key).startsWith("adaptive-routing:"));
    assert.ok(asked().some((q: any) => /neither can review it independently/.test(q.text)), canonical(f.o.inspect(f.id).tasks));
  } finally {
    f.close();
  }
  const g = project({ policy: (plans) => adaptive([...plans, { id: "plan-b", digest: planB.ref.digest }], { preference: "GUIDED" }) });
  try {
    await checkpoint(g);
    await work(g);
    // Plan B's contradicting evidence arrives after the pin: the pinned pair no longer qualifies.
    seed(g.db, { pairs: { "general/complex": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]], "general/complex/bounded": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]] }, overseers: {} }, "plan-b");
    await g.o.drive(g.id, { mock: true });
    const asked = g.db
      .all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r) => JSON.parse(r.body).question)
      .filter((q: any) => String(q.key).startsWith("adaptive-routing:"));
    assert.ok(asked.some((q: any) => /no longer have qualifying evaluation evidence/.test(q.text)), canonical(g.o.inspect(g.id).tasks));
    // One answer per line, and the reference sentence on its own (W9).
    assert.match(asked[0].text, /\n1\) Wait for evidence \(Recommended\)/);
  } finally {
    g.close();
  }
});

test("E3 review F1: explicit routing cannot continue a pinned task under another workflow", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    await review(f, "FAIL");
    f.restart(defaultRoutingPolicy());
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "manual", provider: "codex", model: "gpt-6.1-sol", effort: "max", overrideReason: "try max by hand" },
          f.c.localActor(),
        ),
      /ADAPTIVE_PIN_UNDER_OTHER_WORKFLOW/,
    );
    assert.equal(runs(f, "worker").length, 1);
  } finally {
    f.close();
  }
});

test("E3 review F2: a pinned reviewer, an unstarted run and a checkpoint retry each need their evidence to still qualify", async () => {
  const contradicting = (f: Project, id: string, overseer = false) =>
    seed(
      f.db,
      overseer
        ? { pairs: {}, overseers: { BOUNDED: [["opus-xhigh-overseer", "poor"]] } }
        : { pairs: { "general/complex": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]], "general/complex/bounded": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]] }, overseers: {} },
      id,
    );
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    // Another listed plan now fails the pinned pair: the evidence contradicts.
    const b = contradicting(f, "plan-b");
    f.restart(adaptive([f.ref, b.ref]));
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "r" }, f.c.localActor()),
      /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE.*no longer has qualifying evidence/,
    );
    assert.equal(runs(f, "reviewer").length, 0);
  } finally {
    f.close();
  }
  const g = project();
  try {
    await checkpoint(g);
    const a = g.c.reserve("A", { requestKey: "w", projectRequestId: g.id }, g.c.localActor());
    const b = contradicting(g, "plan-b");
    g.restart(adaptive([g.ref, b.ref]));
    const provider = new MockProvider({ output: "never" });
    await g.c.execute(a, provider, g.c.localActor()).catch(() => undefined);
    assert.equal(provider.requests.length, 0, "the run never launched");
    assert.notEqual(runs(g, "worker")[0].state, "SUCCEEDED");
  } finally {
    g.close();
  }
  const h = project();
  try {
    // A first checkpoint attempt is refused; its retry reuses the pin, and
    // the pinned overseer's evidence is contradicted meanwhile.
    await assert.rejects(
      () =>
        checkpoint(h, (context) => ({
          ...coordination(context),
          technicalDecisions: [{ decision: "Use the short greeting", reason: "Simpler", sourceRefs: [] }],
        })),
      /OVERSEER_COORDINATION_SUBSTANTIVE/,
    );
    const b = contradicting(h, "plan-b", true);
    h.restart(adaptive([h.ref, b.ref]));
    await assert.rejects(() => checkpoint(h), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE.*no longer has qualifying BOUNDED checkpoint evidence/);
    assert.equal(checkpointPins(h).length, 1);
  } finally {
    h.close();
  }
});

test("E3 review F3, F5 and F6: a fix task's fresh Max continuation consumes its trigger, is briefed on and checked for its corrections", async () => {
  const f = project();
  try {
    await toCeiling(f);
    const actor = f.c.localActor();
    f.c.importTasks([demoTask("B", { simulation: true, fixes: "A", writePaths: ["output/A"], budget: BUDGET })], actor);
    f.c.grant(
      "B",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Fix A", sourceRef: "test:owner" },
      actor,
    );
    f.o.attach(f.id, ["B"]);
    await checkpoint(f, undefined, "B");
    const { attempt } = await work(f, "SIMULATION: B's fix, without a correction list", "B");
    const [pin] = taskPins(f, "B");
    const reviewsOfA = runs(f, "reviewer").map((a) => a.id);
    assert.deepEqual([pin!.reason, pin!.worker.routeId, pin!.ceiling], [
      "INITIAL",
      "sol-expert-max-worker",
      { worker: true, reviewer: false, continuationsUsed: 1 },
    ]);
    // F6: the two failures at Max that called for it are consumed.
    assert.deepEqual(pin!.trigger!.failedReviewRunIds, reviewsOfA.slice(2, 4));
    // F5: the live brief carries the correction protocol and the items.
    const brief = (f.c as any).briefParts({ ...f.c.task("B"), simulation: false }, { ...attempt, simulation: false }, false)
      .text as string;
    assert.match(brief, /MAX CEILING/);
    assert.match(brief, /CORRECTIONS:/);
    assert.match(brief, /\n1\. Correct the greeting/);
    // F3: without a correction list the work is never reviewed.
    assert.throws(
      () => f.c.reserve("B", { role: "reviewer", projectRequestId: f.id, requestKey: "rb" }, f.c.localActor()),
      /ADAPTIVE_CEILING_NO_CORRECTION.*no line in the CORRECTIONS section/,
    );
  } finally {
    f.close();
  }
});

test("E3 review F4 and G2: a Drive correction is this run's own write, compared with what the faulted artifact left", () => {
  const f = project();
  try {
    const id = "FILE0123456789";
    const record = (workspace: string, run: string, entries: unknown[], files: Record<string, string>) => {
      const dir = join(workspace, "drive-changes", run);
      for (const sub of ["before", "after"]) mkdirSync(join(dir, sub), { recursive: true });
      writeFileSync(join(dir, "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    };
    const update = (before: string, after: string) => ({ op: "update", ok: true, fileId: id, versionBefore: before, versionAfter: after });
    const changed = (current: { id: string; workspace: string }, faulted: { id: string; workspace: string; taskId?: string }) =>
      (f.c as any).driveWriteChanged({ ...current, taskId: "A" }, id, { taskId: "A", ...faulted }) as boolean;
    const faultedSpace = mkdtempSync(join(f.root, "faulted-"));
    // The faulted run left content A.
    record(faultedSpace, "faulted", [update("1", "2")], { [`before/${id}@v1-1.txt`]: "original", [`after/${id}@v2-2.txt`]: "A" });
    const faulted = { id: "faulted", workspace: faultedSpace };
    const space = (run: string, entries: unknown[], files: Record<string, string>) => {
      const workspace = mkdtempSync(join(f.root, run + "-"));
      record(workspace, run, entries, files);
      return { id: run, workspace };
    };
    // Only an inherited record wrote the file: this run's own record is empty.
    const inherited = mkdtempSync(join(f.root, "inherited-"));
    record(inherited, "earlier", [update("2", "3")], { [`before/${id}@v2-1.txt`]: "A", [`after/${id}@v3-2.txt`]: "B" });
    assert.equal(changed({ id: "this", workspace: inherited }, faulted), false);
    // A rework wrote B, then this check rework wrote A back: unchanged against the faulted A.
    assert.equal(changed(space("back", [update("3", "4")], { [`before/${id}@v3-1.txt`]: "B", [`after/${id}@v4-2.txt`]: "A" }), faulted), false);
    // B differs from the faulted A, whatever the immediate pre-image was.
    assert.equal(changed(space("real", [update("3", "4")], { [`before/${id}@v3-1.txt`]: "B", [`after/${id}@v4-2.txt`]: "B" }), faulted), true);
    // A file the faulted artifact did not have is new content.
    assert.equal(
      changed(space("made", [{ at: "2026-10-29T02:00:00Z", completedAt: "2026-10-29T02:00:01Z", op: "create", ok: true, fileId: id, versionAfter: "1" }], { [`after/${id}@v1-1.txt`]: "new" }), { id: "none", workspace: mkdtempSync(join(f.root, "none-")), finishedAt: "2026-10-29T01:00:00Z" } as any),
      true,
    );
  } finally {
    f.close();
  }
});

test("E3 rereview H1 and H2: the faulted content is what the first later write found, by any task, and a first create means there was none", async () => {
  const f = project({ tasks: [{ id: "A", drive: true }, { id: "B", drive: true }] });
  try {
    const id = "FILE0123456789";
    const record = (a: Attempt, entries: unknown[], files: Record<string, string>) => {
      gateway(join(a.workspace, "drive-changes", a.id), entries);
      for (const [path, text] of Object.entries(files)) put(a, `drive-changes/${a.id}/${path}`, text);
    };
    const update = (before: string, after: string) => ({ at: new Date().toISOString(), op: "update", ok: true, fileId: id, versionBefore: before, versionAfter: after });
    const c = f.c as any;
    // A's faulted run never wrote the file, which held "old".
    await checkpoint(f);
    const faulted = await workWith(f, "A", () => {});
    await review(f, "FAIL");
    await checkpoint(f);
    // A's rework wrote "intermediate" over "old".
    await workWith(f, "A", (a) => record(a, [update("1", "2")], { [`before/${id}@v1-1.txt`]: "old", [`after/${id}@v2-2.txt`]: "intermediate" }));
    // B's run writes "old" back: that is the faulted content, not a correction (H1).
    await checkpoint(f, undefined, "B");
    const back = await workWith(f, "B", (a) => record(a, [update("2", "3")], { [`before/${id}@v2-1.txt`]: "intermediate", [`after/${id}@v3-2.txt`]: "old" }));
    assert.equal(c.driveWriteChanged(c.attempt(back.attempt.id), id, c.attempt(faulted.attempt.id)), false);
  } finally {
    f.close();
  }
  const g = project({ tasks: [{ id: "A", drive: true }] });
  try {
    const id = "FILE0123456789";
    const c = g.c as any;
    await checkpoint(g);
    const faulted = await workWith(g, "A", () => {});
    await review(g, "FAIL");
    await checkpoint(g);
    // This run created the file, then wrote the same bytes again: new content (H2).
    const made = await workWith(g, "A", (a) => {
      const now = new Date().toISOString();
      gateway(join(a.workspace, "drive-changes", a.id), [
        { at: now, op: "create", ok: true, fileId: id, versionAfter: "1" },
        { at: now, op: "update", ok: true, fileId: id, versionBefore: "1", versionAfter: "2" },
      ]);
      put(a, `drive-changes/${a.id}/after/${id}@v1-1.txt`, "new");
      put(a, `drive-changes/${a.id}/before/${id}@v1-2.txt`, "new");
      put(a, `drive-changes/${a.id}/after/${id}@v2-3.txt`, "new");
    });
    assert.equal(c.driveWriteChanged(c.attempt(made.attempt.id), id, c.attempt(faulted.attempt.id)), true);
  } finally {
    g.close();
  }
});

test("E3 rereview H3: the last permitted attempt's own reservation does not show it an exhausted budget", async () => {
  const f = project();
  try {
    await toCeiling(f);
    const a = f.c.reserve("A", { requestKey: "w5", projectRequestId: f.id, rework: f.c.reworkPending("A")!.reviewRunId }, f.c.localActor());
    const holds = (except?: string) => f.c.operationalState(["A"], except).tasks.flatMap((t) => t.holds);
    assert.ok(holds().includes("ATTEMPT_BUDGET_EXHAUSTED"), "seen from outside, the budget is used up");
    assert.ok(!holds(a.id).includes("ATTEMPT_BUDGET_EXHAUSTED"), "its own brief does not count it against itself");
  } finally {
    f.close();
  }
});

test("E3 rereview J1 and J2 (unit level): a later write by an earlier-reserved run, and a filing whose record is lost", async () => {
  const f = project({ tasks: [{ id: "A", drive: true }, { id: "C", drive: true }] });
  try {
    const id = "FILEJ0123456789";
    const c = f.c as any;
    const hour = 3_600_000,
      at = (offset: number) => new Date(Date.now() + offset).toISOString();
    const record = (dir: string, entries: unknown[], files: Record<string, string>) => {
      gateway(dir, entries);
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    };
    // C's run, reserved before the faulted one, wrote "intermediate" over "old"
    // after the faulted run had finished.
    await checkpoint(f, undefined, "C");
    await workWith(f, "C", (a) =>
      record(join(a.workspace, "drive-changes", a.id), [{ at: at(0), op: "update", ok: true, fileId: id, versionBefore: "1", versionAfter: "2" }], {
        [`before/${id}@v1-1.txt`]: "old",
        [`after/${id}@v2-2.txt`]: "intermediate",
      }),
    );
    const space = (run: string) => ({ id: run, taskId: "A", workspace: mkdtempSync(join(f.root, run + "-")), state: "SUCCEEDED" });
    const faulted = { ...space("faulted-run"), finishedAt: at(-hour) };
    // M4: establish the named reservation ordering in the journal. Without
    // this row the former guard used Infinity, testing a different failure.
    f.db.event("ATTEMPT_RESERVED", "A", { id: faulted.id });
    const faultedReservation = f.db.get<{ seq: number }>("SELECT seq FROM events WHERE kind='ATTEMPT_RESERVED' AND json_extract(body,'$.id')=?", faulted.id)!.seq;
    assert.ok(f.db.all<{ seq: number }>("SELECT seq FROM events WHERE kind='ATTEMPT_RESERVED' AND task_id='C'").every((row) => row.seq < faultedReservation));
    const fix = space("fix-run");
    record(join(fix.workspace, "drive-changes", fix.id), [{ at: at(hour), op: "update", ok: true, fileId: id, versionBefore: "2", versionAfter: "3" }], {
      [`before/${id}@v2-1.txt`]: "intermediate",
      [`after/${id}@v3-2.txt`]: "old",
    });
    // The fix restores what the faulted artifact left: no correction.
    assert.equal(c.driveWriteChanged(fix, id, faulted), false);
    // J2: a filing of another file after the faulted run, its record lost, changes nothing ...
    const G = "FILEG0123456789";
    const fixG = space("fix-g");
    record(join(fixG.workspace, "drive-changes", fixG.id), [{ at: at(hour), op: "update", ok: true, fileId: G, versionBefore: "5", versionAfter: "6" }], {
      [`before/${G}@v5-1.txt`]: "intermediate",
      [`after/${G}@v6-2.txt`]: "old",
    });
    assert.equal(c.driveWriteChanged(fixG, G, faulted), true);
    // ... but one of this file, whose record is lost, leaves the faulted content unknown.
    f.c.recordFiling(
      "A",
      {
        id: "lost-record",
        complete: true,
        auditDir: join(f.root, "drive-audit", "lost-record"),
        results: [{ op: "update", fileId: G, path: join(f.root, "x.md"), sha256: "e".repeat(64), bytes: 1, versionAfter: "5", readback: "MATCH" }],
      },
      f.c.localActor(),
    );
    assert.equal(c.driveWriteChanged(fixG, G, faulted), false);
  } finally {
    f.close();
  }
});

test("E3 rereview J4: an advisor whose advice would leave no qualified pair is not run", async () => {
  const f = project({ tasks: [{ id: "A", advice: true }] });
  try {
    await checkpoint(f);
    // No pair was measured with this advisor's advice.
    assert.throws(
      () => f.c.reserve("A", { role: "advisor", projectRequestId: f.id, requestKey: "advice" }, f.c.localActor()),
      /ROUTING_HELD:ADAPTIVE_EVIDENCE_MISSING.*advice would force a weaker one/,
    );
    assert.equal(runs(f, "advisor").length, 0);
  } finally {
    f.close();
  }
});

test("E3 review F7: a pinned High worker keeps serving only on its floor exception's own plan", async () => {
  const exception = {
    id: "floor-exception-worker",
    provider: "codex",
    role: "worker",
    effort: "high",
    scope: "BOUNDED_LOW_STAKES",
    approvalRef: "test:separately-approved-floor-rule",
    evaluationPlanId: "test-plan",
  };
  const high: Pair[] = [["sol-complex-high-worker", "opus-complex-high-reviewer", "strong"], COMPLEX[1]!];
  const f = project({
    evidence: { ...EVIDENCE, pairs: { ...EVIDENCE.pairs, "general/complex/bounded": high } },
    policy: (plans) => adaptive(plans, { routes: withHigh, floorExceptions: [exception] }),
  });
  try {
    await checkpoint(f);
    const { attempt } = await work(f);
    assert.deepEqual(exactOf(attempt), ["codex", "gpt-6.1-sol", "high"]);
    await review(f, "FAIL");
    await checkpoint(f);
    // Plan B, listed first, qualifies the same pair; the exception still names test-plan.
    const b = seed(f.db, { pairs: { "general/complex/bounded": high }, overseers: EVIDENCE.overseers }, "plan-b");
    f.restart(adaptive([b.ref, f.ref], { routes: withHigh, floorExceptions: [exception] }));
    assert.throws(
      () =>
        f.c.reserve("A", { requestKey: "w2", projectRequestId: f.id, rework: f.c.reworkPending("A")!.reviewRunId }, f.c.localActor()),
      /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE/,
    );
  } finally {
    f.close();
  }
});

const exposures = (f: Project, runId: string) =>
  f.db
    .all<{ body: string }>("SELECT body FROM events WHERE kind='ADAPTIVE_EXPOSURE_RECORDED'")
    .map((r) => JSON.parse(r.body))
    .filter((e) => e.runId === runId);
/** An advisor run on the task, as the orchestrator runs one. */
async function advise(f: Project, taskId = "A") {
  const a = f.c.reserve(taskId, { role: "advisor", projectRequestId: f.id, requestKey: "advice:" + randomUUID() }, f.c.localActor());
  const t = f.c.task(taskId);
  const output = canonical({ taskId, specDigest: specDigest(t), approach: "Keep it short.", steps: [], risks: [], checks: [], questionsForOwner: [] });
  const receipt = await f.c.execute(a, new MockProvider({ output }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  return a;
}

test("lineage: each adaptive reservation records its exposure, with prior work and review-loop sources", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const first = await work(f);
    const reviewer = await review(f, "FAIL");
    await checkpoint(f);
    const rework = await work(f);
    const kinds = (runId: string) =>
      exposures(f, runId).flatMap((e) => e.sources.map((x: any) => [x.kind, x.producerRunId])).sort();
    assert.equal(exposures(f, first.attempt.id).length, 1);
    // The reviewer starts from the work and sees its output evidence.
    assert.deepEqual(kinds(reviewer.id), [
      ["INPUT", first.attempt.id],
      ["PRIOR_WORK", first.attempt.id],
    ]);
    // The rework also answers the review.
    assert.deepEqual(kinds(rework.attempt.id), [
      ["INPUT", first.attempt.id],
      ["PRIOR_WORK", first.attempt.id],
      ["REVIEW_LOOP", reviewer.id],
    ]);
    // The task's own review loop is not its authorship.
    const authorship = (f.c as any).taskAuthorship(f.c.task("A"));
    assert.deepEqual(authorship.providers, ["codex"]);
    assert.ok(!authorship.runs.includes(reviewer.id));
  } finally {
    f.close();
  }
});

test("IND-04: an advisor's contribution counts in selection and survives a specification revision", async () => {
  // The evidence prefers the Claude worker; Codex advice makes Codex an author.
  const preferOpus: Pair[] = [
    ["opus-complex-xhigh-worker", "sol-complex-xhigh-reviewer", "strong"],
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair"],
    // The Codex advisor's preview needs a pair measured with its advice.
    ["sol-complex-xhigh-worker", "opus-complex-high-reviewer", "fair", "advised"],
  ];
  const f = project({
    evidence: { ...EVIDENCE, pairs: { ...EVIDENCE.pairs, "general/complex": preferOpus, "general/complex/bounded": preferOpus } },
    tasks: [{ id: "A", advice: true }],
  });
  try {
    await checkpoint(f);
    const before = f.c.lineageDigest("A");
    const advisor = await advise(f);
    assert.equal(advisor.provider, "codex");
    // An advisor alone shaped no work yet: authorship is its own run.
    assert.deepEqual((f.c as any).taskAuthorship(f.c.task("A")).providers, ["codex"]);
    assert.notEqual(f.c.lineageDigest("A"), before);
    // The owner revises the specification: the advice still counts.
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: 2, scope: prior.scope + " (revised)" }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    f.c.grant(
      "A",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Revised work", sourceRef: "test:owner" },
      f.c.localActor(),
    );
    await checkpoint(f);
    const { attempt } = await work(f);
    assert.deepEqual(exactOf(attempt), ["codex", "gpt-6.1-sol", "xhigh"]);
    assert.equal(taskPins(f)[0]!.worker.routeId, "sol-complex-xhigh-worker");
  } finally {
    f.close();
  }
});

test("IND-06: an unreadable gateway record or an old listing makes authorship unknown, and the work is not reviewed", async () => {
  for (const record of [
    // A listing recorded by older code, without the IDs it returned.
    JSON.stringify({ at: AT, op: "list", ok: true, fileId: "FOLDER0123456789", results: 3 }) + "\n",
    "{not json\n",
  ]) {
    const f = project({ tasks: [{ id: "A", drive: true }] });
    try {
      await checkpoint(f);
      // The run leaves its gateway record in its workspace, as the gateway does.
      const { receipt } = await workWith(f, "A", (a) => put(a, `drive-changes/${a.id}/log.jsonl`, record));
      assert.equal(receipt.status, "SUCCEEDED");
      assert.equal((f.c as any).taskAuthorship(f.c.task("A")).unknown, true);
      assert.throws(
        () => f.c.reserve("A", { role: "reviewer", projectRequestId: f.id, requestKey: "r" }, f.c.localActor()),
        /ADAPTIVE_AUTHORSHIP_UNKNOWN/,
      );
    } finally {
      f.close();
    }
  }
});

test("GOV-09: bookkeeping never stales a review; its lineage is recorded with it", async () => {
  const f = project();
  try {
    await checkpoint(f);
    await work(f);
    const reviewer = await review(f, "PASS");
    const passed = () => (f.c as any).passedReviews(f.c.task("A")).length as number;
    const lineage = f.db
      .all<{ body: string }>("SELECT body FROM events WHERE kind='ADAPTIVE_REVIEW_LINEAGE' AND task_id='A'")
      .map((r) => JSON.parse(r.body));
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0].reviewRunId, reviewer.id);
    assert.equal(lineage[0].lineageDigest, f.c.lineageDigest("A"));
    assert.equal(passed(), 1);
    // Preferences, pins and exposure records are bookkeeping.
    f.c.recordAdaptivePreference("A", { mode: "AUTO", reason: "No preference" }, f.c.localActor());
    await checkpoint(f);
    assert.equal(passed(), 1);
    // A review whose recorded lineage is not the current one never stands.
    f.db.run("DROP TRIGGER IF EXISTS immutable_events_update");
    f.db.run(
      "UPDATE events SET body=? WHERE kind='ADAPTIVE_REVIEW_LINEAGE' AND task_id='A'",
      canonical({ ...lineage[0], lineageDigest: "0".repeat(64) }),
    );
    assert.equal(passed(), 0);
  } finally {
    f.close();
  }
});

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

test("GOV-09: an input that loses its acceptance after the review is a new contributor, so the review no longer stands (E4 review L17)", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    const actor = f.c.localActor();
    await checkpoint(f, undefined, "B");
    const b = await work(f, undefined, "B");
    f.c.bindAcceptance("B", "receipt", "output-" + b.attempt.id, actor);
    acceptTask(f, "B", (await review(f, "PASS", "B")).id);
    // A's work is given B's accepted work, which adds nothing.
    bind(f, "A", [f.c.evidenceFor("B").find((e) => e.id === "output-" + b.attempt.id)!]);
    await checkpoint(f);
    await work(f);
    const before = f.c.lineageDigest("A");
    assert.ok(!(f.c as any).taskAuthorship(f.c.task("A")).runs.includes(b.attempt.id));
    await review(f, "PASS");
    const passed = () => (f.c as any).passedReviews(f.c.task("A")).length as number;
    assert.equal(passed(), 1);
    // The owner revokes B's acceptance: B's work now counts, A's bytes unchanged.
    f.c.revoke("accept-B", "Reopened", actor);
    assert.notEqual(f.c.lineageDigest("A"), before);
    assert.ok((f.c as any).taskAuthorship(f.c.task("A")).runs.includes(b.attempt.id));
    assert.equal(passed(), 0);
    // B's work is Codex's, so A's Claude reviewer is still independent: the
    // stale review is replaced by a new one (E4 rereview K9).
    assert.equal(f.c.artifactReviews(f.c.task("A")).reviewed, false);
    await review(f, "PASS");
    assert.equal(passed(), 1);
  } finally {
    f.close();
  }
});

test("E4 rereview K10: an accepted adaptive task whose review went stale is not exempt", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    const actor = f.c.localActor();
    await checkpoint(f, undefined, "B");
    const b = await work(f, undefined, "B");
    f.c.bindAcceptance("B", "receipt", "output-" + b.attempt.id, actor);
    acceptTask(f, "B", (await review(f, "PASS", "B")).id);
    bind(f, "A", [f.c.evidenceFor("B").find((e) => e.id === "output-" + b.attempt.id)!]);
    await checkpoint(f);
    const a = await work(f);
    f.c.bindAcceptance("A", "receipt", "output-" + a.attempt.id, actor);
    acceptTask(f, "A", (await review(f, "PASS")).id);
    const c = f.c as any;
    const exempt = () => c.acceptedArtifact(a.attempt.id, Infinity, c.lineageCache()) as boolean;
    assert.equal(exempt(), true);
    // B's acceptance goes: A's review is stale, though A's own criteria are local.
    f.c.revoke("accept-B", "Reopened", actor);
    assert.equal(exempt(), false);
  } finally {
    f.close();
  }
});

test("E4 rereview K1: revising a task's bindings leaves what its earlier runs were given, and what others took from them", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }, { id: "C" }] });
  try {
    await checkpoint(f, undefined, "C");
    const cw = await work(f, undefined, "C");
    const e = note("c-note", "C", cw.attempt.id);
    f.c.addEvidence(e, f.c.localActor());
    bind(f, "B", [e]);
    await checkpoint(f, undefined, "B");
    const bw = await work(f, undefined, "B");
    bind(f, "A", [f.c.evidenceFor("B").find((x) => x.id === "output-" + bw.attempt.id)!]);
    await checkpoint(f);
    await work(f);
    const before = f.c.lineageDigest("A");
    assert.ok((f.c as any).taskAuthorship(f.c.task("A")).runs.includes(cw.attempt.id));
    // B's next specification drops the binding: B's earlier run was still given C's note.
    bind(f, "B", []);
    assert.equal(f.c.lineageDigest("A"), before);
  } finally {
    f.close();
  }
});

test("E4 rereview K2: what a worker's own workspace carries holds it at reservation, and the launch check counts the reserved run", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }], repo: true });
  try {
    await checkpoint(f, undefined, "B");
    await work(f, undefined, "B");
    const claude = await review(f, "PASS", "B");
    const text = String(JSON.parse(f.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", claude.id)!.body).output);
    // A's pinned commit holds a file whose bytes are the Claude review's;
    // nothing else A will be given names it.
    const commit = f.commit({ "output/A/notes.txt": text });
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: prior.specVersion + 1, repo: { name: "seed", commit } }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    f.c.grant(
      "A",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Seeded work", sourceRef: "test:owner" },
      f.c.localActor(),
    );
    await checkpoint(f);
    // Its first worker run is held as it is reserved, before anything is spent.
    assert.throws(
      () => f.c.reserve("A", { requestKey: "w1", projectRequestId: f.id }, f.c.localActor()),
      /ROUTING_HELD:ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED/,
    );
    assert.equal(runs(f, "worker").length, 0);
  } finally {
    f.close();
  }
  const g = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(g, undefined, "B");
    await work(g, undefined, "B");
    const claude = await review(g, "PASS", "B");
    await checkpoint(g);
    const a = g.c.reserve("A", { requestKey: "w1", projectRequestId: g.id }, g.c.localActor());
    // Between reservation and launch, a note naming the Claude review is
    // filed for A. (The launch also refuses it as a changed project context;
    // the route check is asked directly here.)
    g.c.addEvidence(note("late", "A", claude.id), g.c.localActor());
    const selectionId = (a.routing as any).adaptive.selectionId;
    const atLaunch = g.c.route("A", "worker", { adaptiveSelectionId: selectionId, lineageRunId: a.id });
    assert.equal(atLaunch.ok, false);
    assert.match(canonical(atLaunch.reasons), /ADAPTIVE_LINEAGE_CONFLICT/);
    // Without the reserved run, its pin alone still routes.
    assert.equal(g.c.route("A", "worker", { adaptiveSelectionId: selectionId }).ok, true);
  } finally {
    g.close();
  }
});

test("E4 rereview K3, K6, K7 and K8 (unit level): failed runs' Drive bytes, filed copies, unknown outcomes and settled runs", async () => {
  const f = project({ tasks: [{ id: "A", drive: true }, { id: "B" }] });
  try {
    const c = f.c as any;
    await checkpoint(f);
    // K3: a failed worker's uploaded bytes are its output.
    const failed = await workWith(
      f,
      "A",
      (a) => {
        gateway(join(a.workspace, "drive-changes", a.id), [{ at: AT, op: "create", ok: true, fileId: "FILEK0123456789", versionAfter: "1" }]);
        put(a, `drive-changes/${a.id}/uploaded/FILEK0123456789@v1-1.txt`, "uploaded by a failed run");
      },
      new MockProvider({ outcome: "failure" }),
    );
    assert.ok((c.lineageOutputs(c.lineageCache()).get(digest("uploaded by a failed run")) ?? []).includes(failed.attempt.id));
    // K6: a file filed from a reviewer's workspace, where it is the seeded copy of the work, is the worker's.
    f.c.addEvidence({ ...note("owner-text", "B", "nobody", "the owner's words"), metadata: {} }, f.c.localActor());
    await checkpoint(f, undefined, "B");
    const worker = await workWith(f, "B", (a) => {
      put(a, "output/B/doc.md", "the worker's document");
      // A copy of the owner's evidence it was given: no run's output.
      put(a, "output/B/quote.md", "the owner's words");
    });
    const reviewer = await review(f, "PASS", "B");
    const held = (file: string) => join(c.attempt(reviewer.id).workspace, "output", "B", file);
    assert.deepEqual(c.filingProducers({ path: held("doc.md"), sha256: "e".repeat(64) }, Infinity, c.lineageCache()), [worker.attempt.id]);
    // The reviewer only held the copy: it is not credited; nothing recorded made it.
    assert.deepEqual(c.filingProducers({ path: held("quote.md"), sha256: "e".repeat(64) }, Infinity, c.lineageCache()), ["UNKNOWN"]);
    // K7: a run whose outcome is unknown still has an open record.
    const probe = { ...c.attempt(worker.attempt.id), id: "unknown-run", state: "UNKNOWN", workspace: mkdtempSync(join(f.root, "unknown-")) };
    assert.equal(c.gatewayRecord(probe), undefined);
    gateway(join(probe.workspace, "drive-changes", probe.id), [{ at: AT, op: "update", ok: true, fileId: "FILEU0123456789", versionAfter: "2" }]);
    assert.equal(c.gatewayRecord(probe).entries.length, 1);
    // Y10 supersedes K8: settling the outcome does not verify contributor identity.
    const run = (state: string) => ({ a: { ...probe, id: "no-receipt", state }, rowid: 1, receiptValid: false });
    assert.equal(c.contributorProvider(run("UNKNOWN")), "UNKNOWN");
    assert.equal(c.contributorProvider(run("FAILED")), "UNKNOWN");
  } finally {
    f.close();
  }
});

test("E4 rereview K11 and K13 (unit level): a probe reads outputs before its lock, and a cyclic history takes linear time", async () => {
  const f = project();
  try {
    const c = f.c as any;
    await checkpoint(f);
    const calls: string[] = [];
    const warm = c.warmLineage.bind(c),
      rollbackOnly = f.db.rollbackOnly.bind(f.db);
    c.warmLineage = () => (calls.push("warm"), warm());
    (f.db as any).rollbackOnly = (fn: () => unknown) => (calls.push("lock"), rollbackOnly(fn));
    c.admissionRefusal("A", { projectRequestId: f.id });
    assert.deepEqual(calls.slice(0, 2), ["warm", "lock"]);
    c.warmLineage = warm;
    (f.db as any).rollbackOnly = rollbackOnly;
    // A long run X and forty short runs B1..B40, each seeing X and every earlier B; X sees them all.
    const cache = c.lineageCache();
    const base = runs(f, "overseer")[0];
    const ids = ["X", ...Array.from({ length: 40 }, (_, i) => "B" + (i + 1))];
    for (const id of ids) cache.runs.set(id, { a: { ...base, id, role: "worker" }, rowid: 1, receiptValid: true, receiptProvider: base.provider });
    const source = (producerRunId: string) => ({ kind: "DRIVE_READ", producerRunId });
    cache.sources.set("X", ids.slice(1).map(source));
    ids.slice(1).forEach((id, i) => cache.sources.set(id, ["X", ...ids.slice(1, i + 1)].map(source)));
    const started = Date.now();
    const shapers = c.lineageShapers("B40", cache) as Set<string>;
    assert.equal(shapers.size, ids.length);
    assert.ok(Date.now() - started < 2_000, "linear, not exponential");
  } finally {
    f.close();
  }
});

test("E4 review L1: an accepted task with a review criterion and a rework has a lineage; its accepted work adds nothing, its earlier work does", async () => {
  const f = project({ tasks: [{ id: "A", reviewAcceptance: true }, { id: "B" }] });
  try {
    const actor = f.c.localActor();
    await checkpoint(f);
    const first = await work(f);
    await review(f, "FAIL");
    await checkpoint(f);
    const second = await work(f);
    const passing = await review(f, "PASS");
    f.c.bindAcceptance("A", "receipt", "output-" + second.attempt.id, actor);
    f.c.bindAcceptance("A", "review", "review-workflow-review-" + passing.id, actor);
    acceptTask(f, "A", passing.id);
    assert.equal(f.c.task("A").status, "ACCEPTED");
    // Its acceptance reads its review, and so its lineage: that ends.
    assert.match(f.c.lineageDigest("A"), /^[a-f0-9]{64}$/);
    assert.equal((f.c as any).acceptanceCurrent(f.c.task("A")), true);
    // B is given both versions of A's work.
    bind(f, "B", [first.attempt.id, second.attempt.id].map((id) => f.c.evidenceFor("A").find((e) => e.id === "output-" + id)!));
    await checkpoint(f, undefined, "B");
    await work(f, undefined, "B");
    const authorship = (f.c as any).taskAuthorship(f.c.task("B"));
    assert.ok(!authorship.runs.includes(second.attempt.id), "the accepted work adds nothing");
    assert.ok(authorship.runs.includes(first.attempt.id), "the earlier version still counts");
  } finally {
    f.close();
  }
});

test("E4 review L2, L7 and L13: a reviewer's host record traces a failed run's Drive write and a host filing, so the rework that would carry them is held", async (t) => {
  // Legacy listings use the run's finish time, not the entry's `at` field.
  // Keep that boundary between the earlier writes and the later write on any date.
  const reviewFinishedAt = new Date(Date.parse(AT) + 60_000).toISOString();
  const laterWriteAt = new Date(Date.parse(AT) + 120_000).toISOString();
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(reviewFinishedAt) });
  const expert: Evidence = {
    ...EVIDENCE,
    pairs: { ...EVIDENCE.pairs, "general/expert": [["opus-expert-xhigh-worker", "sol-expert-max-reviewer", "strong"]] },
  };
  const f = project({ evidence: expert, tasks: [{ id: "A" }, { id: "C", expert: true, drive: true }] });
  try {
    const F = "FILEF0123456789",
      F2 = "FILEX0123456789",
      G = "FILEG0123456789";
    // C's Claude worker wrote F (to version 2) and F2 (to 8) through the gateway, then failed.
    await checkpoint(f, undefined, "C");
    const writer = await workWith(
      f,
      "C",
      (a) => {
        put(a, "output/C/doc.md", "the failed worker authored this filing source");
        gateway(join(a.workspace, "drive-changes", a.id), [
          { at: AT, op: "update", ok: true, fileId: F, versionBefore: "1", versionAfter: "2" },
          { at: AT, op: "update", ok: true, fileId: F2, versionBefore: "7", versionAfter: "8" },
          // A write after the reviewer's listing of it (K5).
          { at: laterWriteAt, op: "update", ok: true, fileId: "FILEL0123456789", versionBefore: "1", versionAfter: "2" },
        ]);
      },
      new MockProvider({ outcome: "failure" }),
    );
    assert.deepEqual([writer.attempt.provider, writer.receipt.status], ["claude", "FAILED"]);
    // The host filed a document from C's workspace as G (version 4).
    const filing = (id: string, entries: unknown[], results: unknown[]) => {
      const auditDir = join(f.root, "drive-audit", id);
      gateway(auditDir, entries);
      f.c.recordFiling("C", { id, complete: true, results, auditDir }, f.c.localActor());
    };
    const H = "FILEH0123456789",
      J = "FILEJ0123456789";
    const docOf = (a: Attempt) => join(a.workspace, "output", "C", "doc.md");
    filing(
      "filing-1",
      [{ at: AT, op: "update", ok: true, fileId: G, versionBefore: "3", versionAfter: "4" }],
      [{ op: "update", fileId: G, path: docOf(writer.attempt), sha256: digest("the failed worker authored this filing source"), bytes: Buffer.byteLength("the failed worker authored this filing source"), versionAfter: "4", readback: "EXPORTED" }],
    );
    // A refused filing wrote nothing, though it lists a result (E4 rereview K4).
    filing(
      "filing-2",
      [{ at: AT, op: "update", ok: false, fileId: H, error: "VERSION_CHANGED" }],
      [{ op: "update", fileId: H, path: docOf(writer.attempt), sha256: digest("the failed worker authored this filing source"), bytes: Buffer.byteLength("the failed worker authored this filing source"), readback: "NOT_READ", error: "VERSION_CHANGED" }],
    );
    // A's Codex work, and its Claude reviewer, whose Drive record stays on the host.
    await checkpoint(f);
    await work(f);
    const reviewer = await review(f, "FAIL", "A", (a) =>
      gateway(join(f.root, "drive-audit", a.id), [
        { at: AT, op: "read", ok: true, fileId: F, versionBefore: "2", sha256: "a".repeat(64) },
        // A version nobody here wrote.
        { at: AT, op: "read", ok: true, fileId: F2, versionBefore: "9", sha256: "b".repeat(64) },
        { at: AT, op: "read", ok: true, fileId: G, versionBefore: "4", sha256: "c".repeat(64) },
        { at: AT, op: "read", ok: true, fileId: H, versionBefore: "1", sha256: "d".repeat(64) },
        { at: AT, op: "list", ok: true, fileId: "FOLDER0123456789", results: 2, returned: [J, "FILEL0123456789"] },
      ]),
    );
    // After the review, J is filed from C's work: the earlier listing never saw it (K5).
    filing(
      "filing-3",
      [{ op: "update", ok: true, fileId: J, versionBefore: "1", versionAfter: "2" }],
      [{ op: "update", fileId: J, path: docOf(writer.attempt), sha256: digest("the failed worker authored this filing source"), bytes: Buffer.byteLength("the failed worker authored this filing source"), versionAfter: "2", readback: "EXPORTED" }],
    );
    const c = f.c as any;
    assert.equal(c.attempt(reviewer.id).finishedAt, reviewFinishedAt);
    const sources = c.lineageSources(reviewer.id, c.lineageCache()) as any[];
    const drive = sources
      .filter((s) => s.kind === "DRIVE_READ")
      .map((s) => [s.producerRunId, ...(s.fields ?? [])].join(" "))
      .sort();
    assert.deepEqual(drive, [writer.attempt.id + " " + F, writer.attempt.id + " " + G].sort());
    assert.deepEqual(sources.filter((s) => s.kind === "DRIVE_DISCOVERY"), []);
    // The failed writer's receipt does not prove its identity (Y10), so the
    // review's text would carry unknown authorship into the rework.
    await checkpoint(f);
    assert.throws(
      () => f.c.reserve("A", { requestKey: "w2", projectRequestId: f.id, rework: f.c.reworkPending("A")!.reviewRunId }, f.c.localActor()),
      /ADAPTIVE_AUTHORSHIP_UNKNOWN/,
    );
    assert.equal(runs(f, "worker").length, 1);
    // A filing from a folder under the workspace root that no run had is UNKNOWN.
    const stray = c.filingProducers({ path: join(f.root, "workspaces", "stray", "doc.md"), sha256: "f".repeat(64) }, Infinity, c.lineageCache());
    assert.deepEqual(stray, ["UNKNOWN"]);
  } finally {
    f.close();
  }
});

test("E4 review L3, L8 and L13: evidence another task filed, named by this task's sources, holds its first worker before it runs", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(f);
    await work(f);
    const reviewer = await review(f, "PASS");
    // A note filed under A naming A's Claude reviewer, with an ID like a controller command receipt's.
    const filed = note("command-design-note", "A", reviewer.id);
    f.c.addEvidence(filed, f.c.localActor());
    assert.equal((f.c as any).isControllerCommandEvidence(filed), false);
    bind(f, "B", [filed]);
    await checkpoint(f, undefined, "B");
    assert.throws(
      () => f.c.reserve("B", { requestKey: "wb", projectRequestId: f.id }, f.c.localActor()),
      /ADAPTIVE_BOTH_PROVIDERS_CONTRIBUTED/,
    );
    assert.equal(runs(f, "worker", "B").length, 0);
  } finally {
    f.close();
  }
});

test("E4 review L9: evidence filed after a run is not what it was given", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(f, undefined, "B");
    await work(f, undefined, "B");
    const claude = await review(f, "PASS", "B");
    await checkpoint(f);
    await work(f);
    // After A's work, a note naming B's Claude reviewer is filed under A.
    f.c.addEvidence(note("late-note", "A", claude.id), f.c.localActor());
    const authorship = (f.c as any).taskAuthorship(f.c.task("A"));
    assert.deepEqual(authorship.providers, ["codex"]);
    assert.ok(!authorship.runs.includes(claude.id));
    // So Claude still reviews the work.
    await review(f, "PASS");
  } finally {
    f.close();
  }
});

test("E4 self-review: evidence naming one run but carrying another run's output counts both", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(f, undefined, "B");
    await work(f, undefined, "B");
    const claude = await review(f, "PASS", "B");
    await checkpoint(f);
    const { attempt } = await work(f);
    // The Claude review's text, filed under A in the name of A's Codex worker.
    const text = String(JSON.parse(f.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", claude.id)!.body).output);
    f.c.addEvidence({ ...note("copied-review", "A", attempt.id, text) }, f.c.localActor());
    // What A's next worker run would be given includes the Claude review.
    const next = (f.c as any).taskAuthorship(f.c.task("A"), undefined, {});
    assert.ok(next.runs.includes(claude.id), canonical(next));
    assert.deepEqual(next.providers, ["claude", "codex"]);
  } finally {
    f.close();
  }
});

test("E4 review L4, L5 and L6 (unit level): a seeded file, a resumed run, the round's moderator and a proposal question are sources", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const first = await workWith(f, "A", (a) => put(a, "output/A/x.txt", "made by the first run"));
    const reviewer = await review(f, "FAIL");
    const c = f.c as any;
    const cache = c.lineageCache();
    // A moderator of the round, finished before the run.
    const moderator = { ...first.attempt, id: "moderator-run", role: "moderator", proposalRound: reviewer.id, state: "SUCCEEDED" };
    cache.runs.set(moderator.id, { a: moderator, rowid: Number.MAX_SAFE_INTEGER, receiptValid: true, receiptProvider: "codex" });
    c.lineageOrder(cache).received.set(moderator.id, 0);
    c.lineageOrder(cache).reserved.set(moderator.id, 0);
    const t = f.c.task("A");
    const sources = c.viewSources(
      t,
      {
        id: "probe",
        role: "worker",
        specDigest: specDigest(t),
        rowid: Infinity,
        reservedAt: Infinity,
        briefAt: Infinity,
        resumes: "interrupted-run",
        baseline: { "seed/x.txt": "FILE:420:" + digest("made by the first run") },
        projectContext: { snapshot: { questions: [{ key: PROPOSAL_QUESTION_PREFIX + reviewer.id + ":item-1", taskId: "A" }], tasks: [] }, preDesign: [] },
      },
      cache,
    ) as any[];
    const has = (kind: string, producer: string) => sources.some((s) => s.kind === kind && s.producerRunId === producer);
    assert.ok(has("PRIOR_WORK", "interrupted-run"), "L5: the run it resumes");
    assert.ok(has("INPUT", first.attempt.id), "L4: a seeded file equal to a recorded output");
    assert.ok(has("REVIEW_LOOP", moderator.id), "L6: the round's moderator");
    assert.ok(has("QUESTION", reviewer.id) && has("QUESTION", moderator.id), "L6: a proposal question's review and moderator");
  } finally {
    f.close();
  }
});

test("E4 review L10: a historical worker keeps the advice it was given after its task is revised", async () => {
  const f = project({ tasks: [{ id: "A", advice: true }], evidence: ADVISED_EVIDENCE });
  try {
    await checkpoint(f);
    const advisor = await advise(f);
    // The advisor was chosen for the pair it leaves (E3 rereview J4) ...
    assert.match(canonical(runs(f, "advisor")[0].routing.reasons), /Selected advisor astra-advisor-moderator: with its advice, sol-complex-xhigh-worker\|opus-complex-high-reviewer still qualifies/);
    const { attempt } = await work(f);
    // ... and its advice is in the worker's pinned context (J3).
    assert.deepEqual(taskPins(f)[0]!.context.producers.map((p: any) => [p.role, p.provider]), [["advisor", "codex"]]);
    const c = f.c as any;
    const advised = () =>
      (c.lineageSources(attempt.id, c.lineageCache()) as any[]).some((s) => s.kind === "ADVICE" && s.producerRunId === advisor.id);
    assert.ok(advised());
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: 2, scope: prior.scope + " (revised)" }, f.c.localActor());
    assert.ok(advised(), "the revision leaves the run's advice in place");
  } finally {
    f.close();
  }
});

test("E4 review L11: a run's outputs are what it made, not what it was given or copied", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const first = await workWith(f, "A", (a) => put(a, "output/A/a.txt", "alpha"));
    await review(f, "FAIL");
    // Importing the made file as evidence afterwards does not take it from its maker.
    f.c.addEvidence({ ...note("imported-a", "A", "nobody", "alpha"), metadata: {} }, f.c.localActor());
    await checkpoint(f);
    // The rework copies the file it started from, and makes a new one.
    const second = await workWith(f, "A", (a) => {
      put(a, "output/A/b.txt", "alpha");
      put(a, "output/A/c.txt", "gamma");
    });
    f.restart();
    const c = f.c as any;
    assert.ok(c.workerOutputs(first.attempt, c.lineageCache()).includes(digest("alpha")));
    const outputs = c.workerOutputs(second.attempt, c.lineageCache()) as string[];
    assert.ok(!outputs.includes(digest("alpha")), "a copy of a file it started from");
    assert.ok(outputs.includes(digest("gamma")));
  } finally {
    f.close();
  }
});

test("E4 review L12: a contributor whose receipt does not establish who it was makes authorship unknown", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const { attempt } = await work(f);
    const authorship = () => (f.c as any).taskAuthorship(f.c.task("A"));
    assert.equal(authorship().unknown, false);
    f.db.run("DROP TRIGGER IF EXISTS immutable_receipts_update");
    const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", attempt.id)!.body);
    f.db.run("UPDATE receipts SET body=? WHERE attempt_id=?", canonical({ ...body, provider: "claude" }), attempt.id);
    assert.equal(authorship().unknown, true, "a receipt naming another provider than the reservation");
    const { sessionId: _dropped, ...malformed } = body;
    f.db.run("UPDATE receipts SET body=? WHERE attempt_id=?", canonical(malformed), attempt.id);
    assert.equal(authorship().unknown, true, "a receipt without its session");
  } finally {
    f.close();
  }
});

test("E4 review L14 (unit level): a reply keeps its review only while that review's lineage is current", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const { attempt } = await work(f);
    const reviewer = await review(f, "PASS");
    const c = f.c as any;
    const round = () => ({
      stage: "OPEN",
      reviewRunId: reviewer.id,
      reply: { runId: attempt.id },
      items: [{ reply: { reply: "DECLINE" }, settlement: "DECLINED" }],
    });
    // A reply run that declined everything and left the bytes as reviewed.
    const reply = { ...c.attempt(attempt.id), id: "reply-run", state: "SUCCEEDED" };
    assert.equal(c.settle(f.c.task("A"), round(), reply).reply.standsOnReview, reviewer.id);
    f.db.run("DROP TRIGGER IF EXISTS immutable_events_update");
    const lineage = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM events WHERE kind='ADAPTIVE_REVIEW_LINEAGE'")!.body);
    f.db.run("UPDATE events SET body=? WHERE kind='ADAPTIVE_REVIEW_LINEAGE'", canonical({ ...lineage, lineageDigest: "0".repeat(64) }));
    assert.equal(c.settle(f.c.task("A"), round(), reply).reply.standsOnReview, undefined);
  } finally {
    f.close();
  }
});

test("E4 review L16: an assessor's reservation records its exposure too", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const a = f.c.reserve("A", { role: "assessor", projectRequestId: f.id, requestKey: "assess" }, f.c.localActor());
    assert.equal(exposures(f, a.id).length, 1);
  } finally {
    f.close();
  }
});

test("GUIDED: a hold only the owner can resolve becomes one plain owner question for its task; AUTO only explains it", async () => {
  const noPairs = { ...EVIDENCE, pairs: {} };
  const f = project({ evidence: noPairs, policy: (plans) => adaptive(plans, { preference: "GUIDED" }) });
  try {
    await f.o.drive(f.id, { mock: true });
    await f.o.drive(f.id, { mock: true });
    const asked = f.db
      .all<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r) => JSON.parse(r.body).question)
      .filter((q: any) => String(q.key).startsWith("adaptive-routing:"));
    assert.equal(asked.length, 1, canonical(f.o.inspect(f.id).questions));
    const [question] = asked as any[];
    assert.equal(question.taskId, "A");
    assert.equal(question.audience, "OWNER");
    assert.match(question.text, /1\) Wait for evidence \(Recommended\)/);
    assert.match(question.text, /For the records only, so you don't need them to answer: the controller's name for this hold is ADAPTIVE_EVIDENCE_MISSING/);
    assert.equal(runs(f, "worker").length, 0);
    // The question is the controller's own: no caller can seed its key.
    assert.throws(() => f.o.ask(f.id, { key: "adaptive-routing:x", text: "?", taskId: "A" }));
  } finally {
    f.close();
  }
  const g = project({ evidence: noPairs, policy: (plans) => adaptive(plans, { preference: "AUTO" }) });
  try {
    await g.o.drive(g.id, { mock: true });
    assert.equal(g.o.inspect(g.id).questions.length, 0);
    const held = canonical(g.o.inspect(g.id));
    assert.match(held, /ADAPTIVE_EVIDENCE_MISSING/);
    assert.match(held, /No worker and reviewer pair has current, qualifying evaluation evidence/);
  } finally {
    g.close();
  }
});

test("E3 rereview G5, G6 and G7: every must-fix item is listed; a retry needs its overseer's demand approval; a launch rechecks evidence under the same policy", async () => {
  // G5: a failed review with forty-five must-fix items, all in the ceiling brief.
  const f = project();
  try {
    await toCeiling(f);
    const items = Array.from({ length: 45 }, (_, i) => "Fix item " + (i + 1));
    const answered = (f.c as any).answeredReview(f.c.task("A"), { ...runs(f, "worker").at(-1), id: "probe", rework: undefined, taskId: "A" });
    assert.ok(answered, "the latest failed review is found");
    const section = (f.c as any).ceilingBriefSection.call(
      { ...f.c, pinBySelection: () => ({ ceiling: { worker: true } }), answeredReview: () => ({ review: { ...answered.review, remediation: items } }) },
      f.c.task("A"),
      { routing: { adaptive: { selectionId: "x" } } },
    ) as string;
    assert.match(section, /\n45\. Fix item 45$/);
  } finally {
    f.close();
  }
  // G6: the checkpoint's overseer lost its approval for the project's demand.
  const g = project({ tasks: ["A", "B"].map((id) => ({ id, resources: ["shared-greeting"] })) });
  try {
    await assert.rejects(
      () =>
        checkpoint(g, (context) => ({
          ...coordination(context),
          technicalDecisions: [{ decision: "Use the short greeting", reason: "Simpler", sourceRefs: [] }],
        })),
      /OVERSEER_COORDINATION_SUBSTANTIVE/,
    );
    assert.equal(checkpointPins(g)[0]!.overseer.routeId, "sol-max-overseer");
    g.restart(adaptive([g.ref], { routes: routes.map((r) => (r.id === "sol-max-overseer" ? { ...r, demands: ["BOUNDED"] } : r)) }));
    await assert.rejects(() => checkpoint(g), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE/);
  } finally {
    g.close();
  }
  // G7: plan B is listed from the start; its contradicting evidence arrives
  // after the reservation, with the policy unchanged.
  const h = project({
    policy: (plans) => adaptive([...plans, { id: "plan-b", digest: planB.ref.digest }]),
  });
  try {
    await checkpoint(h);
    const a = h.c.reserve("A", { requestKey: "w", projectRequestId: h.id }, h.c.localActor());
    const late = seed(h.db, { pairs: { "general/complex": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]], "general/complex/bounded": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]] }, overseers: {} }, "plan-b");
    assert.equal(late.ref.digest, planB.ref.digest);
    const provider = new MockProvider({ output: "never" });
    await assert.rejects(() => h.c.execute(a, provider, h.c.localActor()), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE/);
    assert.equal(provider.requests.length, 0, "the run never launched");
  } finally {
    h.close();
  }
});
/** Plan B's digest, from a scratch database: its plan is the same wherever it is frozen. */
const planB = (() => {
  const root = mkdtempSync(join(tmpdir(), "plan-b-"));
  const db = new SqliteStore(join(root, "s.sqlite"));
  try {
    return seed(db, { pairs: { "general/complex": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]], "general/complex/bounded": [[COMPLEX[0]![0], COMPLEX[0]![1], "poor"]] }, overseers: {} }, "plan-b");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

test("scorecards and the rollback check are read-only and say what they know", async () => {
  const f = project();
  try {
    const empty = f.c.adaptiveRollbackCheck();
    assert.equal(empty.adaptiveRecords > 0, true, "evidence imports are adaptive records");
    await checkpoint(f);
    const events = () => f.db.get<{ n: number }>("SELECT count(*) AS n FROM events")!.n;
    const before = events();
    const held = f.c.adaptiveScorecard("A");
    // Before a pin, the card shows what selection recommends now (E5 review V6).
    assert.deepEqual([held.worker?.routeId, held.reviewer?.routeId], ["sol-complex-xhigh-worker", "opus-complex-high-reviewer"]);
    assert.deepEqual([held.labels.recommended, held.labels.pinned], [true, false]);
    assert.ok(held.why.length && held.evidence.length && held.uncertainty);
    assert.ok(
      held.candidates.some(
        (c) =>
          c.worker === "sol-complex-xhigh-worker" &&
          c.reviewer === "opus-complex-high-reviewer" &&
          c.evidence === "QUALIFIED" &&
          !!(c as any).uncertainty,
      ),
    );
    assert.equal(held.labels.activated, false);
    assert.equal(events(), before, "a scorecard writes nothing");
    await work(f);
    const card = f.c.adaptiveScorecard("A");
    assert.deepEqual([card.worker?.routeId, card.reviewer?.routeId, card.overseer?.routeId], [
      "sol-complex-xhigh-worker",
      "opus-complex-high-reviewer",
      "opus-xhigh-overseer",
    ]);
    assert.deepEqual(card.independence.authorshipProviders, ["codex"]);
    assert.equal(card.labels.recommended, true);
    assert.match(card.note, /not a measured outcome/);
    assert.equal(card.evidence[0]!.planId, f.ref.id);
    assert.equal((card.uncertainty as any)?.n, 20);
    const project = f.c.checkpointScorecard(f.id);
    assert.equal(project.checkpoints[0]!.demand, "BOUNDED");
    assert.equal(project.checkpoints[0]!.mode, "COORDINATION_ONLY");
    // The request card's labels, prediction note and overseer candidates (V6).
    assert.equal(project.labels.activated, false);
    assert.match(project.note, /not a measured outcome/);
    assert.equal(project.overseerNow, "opus-xhigh-overseer");
    assert.deepEqual(project.overseerCandidates.map((x) => x.routeId).sort(), ["opus-xhigh-overseer", "sol-xhigh-overseer"]);
    const check = f.c.adaptiveRollbackCheck();
    assert.deepEqual(check.taskPins.map((p) => [p.taskId, p.worker]), [["A", "sol-complex-xhigh-worker"]]);
    assert.match(check.binaryRollback, /^UNSAFE/);
    assert.equal(check.readOnly, true);
  } finally {
    f.close();
  }
});

test("remediation Z1: a coordination-only checkpoint stays hidden after switching to two-tier before the first worker", async () => {
  const f = project();
  try {
    const cp = await checkpoint(f, (context) => coordination(context, "NEVER-EXPOSE-THIS-PLAN"));
    assert.equal(taskPins(f).length, 0);
    const twoTier = JSON.parse(readFileSync(new URL("./fixtures/adaptive/two-tier-policy.json", import.meta.url), "utf8"));
    f.restart(RoutingPolicySchema.parse({ ...twoTier, routes: twoTier.routes.map((r: any) => ({ ...r, simulation: true })) }));
    const brief = liveWorkerBrief(f);
    for (const text of ["NEVER-EXPOSE-THIS-PLAN", "OWNER-ONLY-MILESTONE", "OWNER-ONLY-RISK"])
      assert.ok(!brief.includes(text), text + " crossed the workflow switch");
    assert.equal(f.c.checkpointPinOfRun(cp.id)!.mode, "COORDINATION_ONLY");
  } finally { f.close(); }
});

test("remediation Z2: a worker reserved before its reviewer pauses cannot start", async () => {
  const f = project();
  try {
    await checkpoint(f);
    const a = f.c.reserve("A", { requestKey: "reserved-before-pause", projectRequestId: f.id }, f.c.localActor());
    (f.c as any).appendLimit("claude", { kind: "USAGE_LIMIT", evidence: "test:another-request", resetsAt: new Date(Date.now() + 3_600_000).toISOString(), resetBasis: "STRUCTURED", message: "Usage limit" }, { probeId: "other-request-probe" });
    const pin = taskPins(f)[0]!;
    const route = f.c.route("A", "worker", { adaptiveSelectionId: pin.selectionId, lineageRunId: a.id });
    assert.equal(route.ok, false);
    assert.match(canonical(route.reasons), /PROVIDER_PAUSED:claude/);
    assert.match(f.c.launchRefusal(a) ?? "", /PROVIDER_PAUSED:claude/);
    const provider = new MockProvider();
    await assert.rejects(() => f.c.execute(a, provider, f.c.localActor()), /ADAPTIVE_PINNED_ROUTE_UNAVAILABLE.*PROVIDER_PAUSED:claude/);
    assert.equal(provider.requests.length, 0);
  } finally { f.close(); }
});

test("remediation Z3: the actual pre-spawn gate rechecks newly downloaded Drive source-pack lineage", async () => {
  const f = project({ tasks: [{ id: "A" }, { id: "B" }] });
  try {
    await checkpoint(f, undefined, "B");
    const source = await work(f, "SOURCE-PACK-CODEX-PRODUCTION", "B");
    f.c.recordAdaptivePreference("A", { mode: "PINNED", workerRouteId: "opus-complex-xhigh-worker", reason: "Exercise reverse pair" }, f.c.localActor());
    await checkpoint(f);
    const a = f.c.reserve("A", { requestKey: "before-pack", projectRequestId: f.id }, f.c.localActor());
    assert.equal(a.provider, "claude");
    const provider = new MockProvider();
    let refusal: string | undefined;
    provider.execute = async (request) => {
      // This is where LiveRunner downloads its pack: after PROCESS_START_INTENT,
      // before the provider is spawned. Nothing new was in the reservation.
      const dir = join(f.root, "drive-audit", a.id);
      gateway(dir, [{ at: new Date().toISOString(), completedAt: new Date().toISOString(), op: "pack", ok: true, fileId: "PACK0123456789", versionBefore: "1", sha256: digest("SOURCE-PACK-CODEX-PRODUCTION") }]);
      refusal = request.launchGate!();
      assert.match(refusal ?? "", /ADAPTIVE_LINEAGE_CONFLICT/);
      const now = new Date().toISOString();
      return { runId: request.runId, taskId: request.taskId, provider: request.provider, model: request.model, effort: request.effort, sessionId: "not-launched-" + request.runId, exitCode: null, status: "FAILED", startedAt: now, endedAt: now, output: refusal!, tests: [], costUsd: 0, tokens: 0, identityVerified: false, simulation: true, notLaunched: true };
    };
    const receipt = await f.c.execute(a, provider, f.c.localActor());
    assert.equal(receipt.notLaunched, true);
    assert.equal(receipt.tokens, 0);
    assert.equal((f.c as any).attempt(a.id).state, "NOT_STARTED");
    assert.ok(source.attempt.id);
  } finally { f.close(); }
});

test("remediation Z5: a final reservation refusal removes its seeded workspace and owner attachments on every retry", async () => {
  const f = project({ repo: true });
  try {
    const commit = f.commit({ "output/A/seed.txt": "seeded repository bytes" });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, repo: { name: "seed", commit } }, f.c.localActor());
    f.o.rebind(f.id, ["A"]);
    f.c.grant("A", { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "Seeded test", sourceRef: "test:owner" }, f.c.localActor());
    await checkpoint(f);
    const list = (name: string) => existsSync(join(f.root, name)) ? readdirSync(join(f.root, name)).sort() : [];
    const spaces = list("workspaces"), attachments = list("run-attachments");
    const before = f.db.all("SELECT id FROM attempts").length;
    // Force the late guard after all filesystem preparation; earlier selection
    // must remain admissible to exercise cleanup rather than an early refusal.
    (f.c as any).lineageHold = () => ({ code: "ADAPTIVE_LINEAGE_CONFLICT", reason: "late source conflict" });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => f.c.reserve("A", { requestKey: "late-refusal-" + attempt, projectRequestId: f.id }, f.c.localActor()), /late source conflict/);
      assert.deepEqual(list("workspaces"), spaces);
      assert.deepEqual(list("run-attachments"), attachments);
      assert.equal(f.db.all("SELECT id FROM attempts").length, before);
      assert.equal(taskPins(f).length, 0);
    }
  } finally { f.close(); }
});

test("remediation M2: qualification excludes invalid advice and refuses to silently omit qualified notes", async () => {
  for (const invalid of [true, false]) {
    const f = project({ tasks: [{ id: "A", advice: true }], evidence: ADVISED_EVIDENCE });
    try {
      await checkpoint(f);
      if (invalid) {
        const bad = f.c.reserve("A", { role: "advisor", requestKey: "bad-advice", projectRequestId: f.id }, f.c.localActor());
        await f.c.execute(bad, new MockProvider({ output: "not a usable advice response" }), f.c.localActor());
        assert.deepEqual((f.c as any).adaptiveContext(f.c.task("A")).producers, []);
      } else {
        await advise(f);
        const c = f.c as any;
        assert.equal(c.adaptiveContext(f.c.task("A")).producers.length, 1);
        const a = f.c.reserve("A", { requestKey: "advised-worker", projectRequestId: f.id }, f.c.localActor());
        const task = { ...f.c.task("A"), simulation: false };
        const advice = c.advice.bind(c);
        c.advice = () => [];
        const plain = c.liveBrief(task, { ...a, simulation: false }, 100_000, true) as string;
        c.advice = advice;
        assert.throws(() => c.liveBrief(task, { ...a, simulation: false }, plain.length, true), /ADAPTIVE_ADVICE_CONTEXT_UNAVAILABLE/);
        assert.match(c.liveBrief(task, { ...a, simulation: false }, 100_000, true), /ADVISOR NOTES/);
      }
    } finally { f.close(); }
  }
});

test("remediation M1/M3: overlapping Drive writes cannot certify restoration, while irrelevant old corrupt logs do not block a correction", async () => {
  const f = project({ tasks: [{ id: "A", drive: true }, { id: "C", drive: true }] });
  try {
    const id = "OVERLAP0123456789", since = Date.now() - 3_600_000;
    const at = (delta: number) => new Date(since + delta).toISOString();
    await checkpoint(f, undefined, "C");
    const writer = await workWith(f, "C", (a) => {
      gateway(join(a.workspace, "drive-changes", a.id), [{ at: at(-1000), writeStartedAt: at(-500), writeAcknowledgedAt: at(500), completedAt: at(1000), op: "update", ok: true, fileId: id, versionBefore: "1", versionAfter: "2" }]);
      put(a, `drive-changes/${a.id}/before/${id}@v1-1.txt`, "faulted");
      put(a, `drive-changes/${a.id}/after/${id}@v2-2.txt`, "intermediate");
    });
    const fake = (run: string) => ({ id: run, taskId: "A", workspace: mkdtempSync(join(f.root, run)), state: "SUCCEEDED", finishedAt: at(30_000) });
    const faulted = { ...fake("faulted"), finishedAt: at(0) }, fix = fake("fix");
    const dir = join(fix.workspace, "drive-changes", fix.id);
    gateway(dir, [{ at: at(2000), completedAt: at(3000), op: "update", ok: true, fileId: id, versionBefore: "2", versionAfter: "3" }]);
    put(fix as Attempt, `drive-changes/${fix.id}/before/${id}@v2-1.txt`, "intermediate");
    put(fix as Attempt, `drive-changes/${fix.id}/after/${id}@v3-2.txt`, "faulted");
    assert.equal((f.c as any).driveWriteChanged(fix, id, faulted), false, "call start is not the write's linearization point");
    // The completed old writer's unreadable log is immaterial to a later,
    // different file's first create; filter it before attempting to parse.
    const unrelated = (f.c as any).attempt(writer.attempt.id);
    unrelated.finishedAt = at(-2000);
    f.db.run("UPDATE attempts SET body=? WHERE id=?", canonical(unrelated), unrelated.id);
    writeFileSync(join(unrelated.workspace, "drive-changes", unrelated.id, "log.jsonl"), "broken-json");
    (f.c as any).gatewayCache.clear();
    const created = "CREATED0123456789", fresh = fake("fresh");
    gateway(join(fresh.workspace, "drive-changes", fresh.id), [{ at: at(4000), completedAt: at(5000), op: "create", ok: true, fileId: created, versionAfter: "1" }]);
    put(fresh as Attempt, `drive-changes/${fresh.id}/after/${created}@v1-1.txt`, "new corrected artifact");
    assert.equal((f.c as any).driveWriteChanged(fresh, created, faulted), true);
    assert.equal((f.c as any).driveWriteChanged(fresh, created, { ...faulted, finishedAt: undefined }), false, "missing historical boundary stays unknown");
  } finally { f.close(); }
});

test("remediation Z7: absent adaptive-pin lookup uses an index on ordinary journals", () => {
  const f = project();
  try {
    const plan = f.db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT 1 FROM events WHERE kind='ADAPTIVE_TASK_PAIR_PINNED' AND task_id=? LIMIT 1", "no-pin");
    assert.match(plan.map((row) => row.detail).join(" "), /SEARCH events USING COVERING INDEX events_kind_task_seq/);
    const before = f.db.all("SELECT * FROM events");
    for (let i = 0; i < 100; i++) assert.equal(f.c.hasAdaptivePin("no-pin"), false);
    assert.deepEqual(f.db.all("SELECT * FROM events"), before);
  } finally { f.close(); }
});
