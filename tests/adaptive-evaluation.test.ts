/**
 * Issue #12, slice E2: the evaluation registry and harness (implementation
 * contract section 5). Scenario IDs refer to the acceptance matrix. The
 * journals here are built with scripted providers: they exercise the
 * checks, and are never quality evidence (Gate 2).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller, type ControllerConfig } from "../src/controller.js";
import { EvidenceIndex, selectPair } from "../src/adaptive.js";
import { canonical, demoTask, digest, specDigest, type Task } from "../src/domain.js";
import {
  ADAPTIVE_PROTOCOL_VERSION,
  arrangementId,
  buildBundle,
  candidateIdentity,
  decide,
  EvaluationPlanSchema,
  freezePlan,
  importEvidence,
  importedEvidence,
  initEvaluationJournal,
  NO_EXPOSURE,
  normalizedFixture,
  pairMetrics,
  runQuestionKeysForTest,
  recordCaseFixture,
  routeDefinitionDigest,
  wilson,
  type Arrangement,
  type EvaluationPlan,
} from "../src/evaluation.js";
import type { ProviderAdapter, ProviderReceipt } from "../src/providers.js";
import { Orchestrator, RESERVED_QUESTION_KEYS } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { ProjectProfileSchema, type ProjectProfile } from "../src/routing.js";
import { adaptivePolicy, example } from "./fixtures/adaptive/evidence.js";

const HEX = (c: string) => c.repeat(64);
const runtime = { cliVersion: "cli 1.0.0", executableDigest: HEX("e") };
const sol = (effort: string, role: "worker" | "reviewer") =>
  candidateIdentity({ provider: "codex", model: "gpt-6.1-sol", effort, simulation: false }, role, runtime);
const opus = (effort: string, role: "worker" | "reviewer") =>
  candidateIdentity({ provider: "claude", model: "claude-opus-5-5", effort, simulation: false }, role, runtime);
const pair = (worker: ReturnType<typeof sol>, reviewer: ReturnType<typeof sol>): Arrangement => ({
  kind: "PAIR",
  worker,
  reviewer,
  protocolVersion: ADAPTIVE_PROTOCOL_VERSION,
  context: NO_EXPOSURE,
});
const A1 = pair(sol("xhigh", "worker"), opus("high", "reviewer"));
const A2 = pair(opus("xhigh", "worker"), sol("xhigh", "reviewer"));

/** One evaluation case's task: its content depends on the case only. */
function caseTask(caseNo: number, id: string, simulation = false, advice = false, extra: Partial<Task> = {}): Task {
  return demoTask(id, {
    ...(advice ? { advice: { rationale: "Advice first", sourceRef: "eval:case" } } : {}),
    sources: simulation
      ? []
      : [{ evidenceId: "src-" + id, revision: "r1", digest: digest("case " + caseNo) }],
    title: "Evaluation case " + caseNo,
    scope: "Write the greeting for case " + caseNo,
    deliverable: "output/case/hello.txt",
    writePaths: ["output/case"],
    simulation,
    createdAt: "2026-10-29T00:00:00.000Z",
    budget: { deadlineMs: 60_000, maxAttempts: 3, maxCostUsd: 10, maxTokens: 100_000 },
    ...extra,
  });
}
let sessions = 0;
function adapter(simulation: boolean): ProviderAdapter {
  return {
    async execute(r) {
      return {
        runId: r.runId,
        taskId: r.taskId,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        sessionId: "s-" + ++sessions,
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        output:
          r.role === "worker"
            ? "Wrote the greeting."
            : r.role === "advisor"
              ? canonical({
                  taskId: r.taskId,
                  specDigest: (r.outputSchema as any).properties.specDigest.enum[0],
                  approach: "Keep it short.",
                  steps: [],
                  risks: [],
                  checks: [],
                  questionsForOwner: [],
                })
              : "Reviewed.",
        tests: [],
        costUsd: 0,
        tokens: 1,
        identityVerified: true,
        simulation,
        ...(simulation
          ? {}
          : {
              provenance: {
                cliVersion: runtime.cliVersion,
                executableDigest: runtime.executableDigest,
                isolationEvidenceRef: "test:isolation",
                capabilityEvidenceRef: "test:capability",
                identityEvidenceRef: "test:identity",
                rawStdoutDigest: HEX("a"),
                rawStdoutBytes: 1,
              },
            }),
      } satisfies ProviderReceipt;
    },
  };
}
const actorOf = (c: Controller) => c.localActor();
function controller(path: string, config: Partial<ControllerConfig> = {}) {
  const db = new SqliteStore(path);
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: path + "-workspaces",
    allowRealLocalTasks: true,
    ...config,
  });
  return { db, c };
}
/** Seed one execution's task and grant, as the harness would. */
function seed(c: Controller, task: Task) {
  c.importTasks([task], actorOf(c));
  // The case's owner source, as the owner's intake records it.
  for (const s of task.sources)
    c.addEvidence(
      {
        id: s.evidenceId,
        taskId: task.id,
        kind: "LOCAL",
        uri: "eval-case:" + task.title,
        revision: s.revision,
        digest: s.digest,
        retrievedAt: "2026-10-29T00:00:00.000Z",
        authorityTier: "PLANNING",
        authentication: "LOCAL_OWNER_REQUEST",
        currentness: "CURRENT_AT_RETRIEVAL",
        claims: ["The evaluation case's owner text"],
        metadata: {},
      },
      actorOf(c),
    );
  c.grant(
    task.id,
    {
      id: "grant-" + task.id,
      operations: [...task.operations, "ACCEPT"],
      paths: task.writePaths,
      decisionText: "Evaluation case",
      sourceRef: "eval:fixture",
    },
    actorOf(c),
  );
}
/** The case input digest a seeded case records (contract section 5.2). */
type SeedExtra = (c: Controller, db: SqliteStore, task: Task) => void;
function caseDigests(n: number, simulation = false, advice = false, seedExtra?: SeedExtra, taskExtra?: (caseNo: number) => Partial<Task>, projectProfile?: ProjectProfile): string[] {
  const root = mkdtempSync(join(tmpdir(), "eval-probe-"));
  const { db, c } = controller(join(root, "probe.sqlite"), { projectProfile });
  try {
    // Input-only probe, never imported as an execution journal.
    db.event("ADAPTIVE_EVALUATION_HARNESS", null, { purpose: "fixture-input-probe" });
    return Array.from({ length: n }, (_, i) => {
      const t = caseTask(i + 1, "probe-" + (i + 1), simulation, advice, taskExtra?.(i + 1));
      seed(c, t);
      seedExtra?.(c, db, t);
      return recordCaseFixture(db, {
        caseId: "C" + (i + 1),
        classKey: "probe",
        arrangementId: HEX("0"),
        taskIds: [t.id],
        requestIds: [],
      }).fixtureDigest;
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function plan(options: { pool: number; purpose?: "PILOT" | "QUALIFICATION"; stages?: number[]; simulation?: boolean; advice?: boolean; finalists?: Arrangement[]; classKeys?: string[]; seedExtra?: SeedExtra; taskExtra?: (caseNo: number) => Partial<Task>; projectProfile?: ProjectProfile }): EvaluationPlan {
  const digests = caseDigests(options.pool, options.simulation, options.advice, options.seedExtra, options.taskExtra, options.projectProfile);
  const purpose = options.purpose ?? "QUALIFICATION";
  return EvaluationPlanSchema.parse({
    version: 1,
    id: "plan-" + digest(canonical(options)).slice(0, 12),
    purpose,
    classes: (options.classKeys ?? ["general/complex"]).map((key) => ({
      key,
      kind: "PAIR",
      important: true,
      datasetDigest: HEX("d"),
      rubricDigest: HEX("b"),
      cases: digests.map((d, i) => ({ caseId: "C" + (i + 1), caseInputDigest: d })),
      finalists: options.finalists ?? [A1, A2],
    })),
    sampling: purpose === "PILOT" ? { pilot: { min: 8, max: 12 } } : { stages: options.stages ?? [20] },
    thresholds: {
      pair: {
        maxSeriousErrorRate: 0.2,
        minFinalCorrectRate: 0.7,
        minSourceFidelityRate: 0.7,
        minTaskFitRate: 0.7,
        minReviewerRecall: 0.5,
        maxFalsePositivesPerCase: 1,
      },
      overseer: { maxSeriousErrorRate: 0.2, minValidCheckpointRate: 0.8, minCoordinationCorrectRate: 0.7 },
    },
    decisionRuleVersion: 1,
    graders: [{ id: "grader-1", kind: "HUMAN", blinded: true }],
    rationale: "Test plan: frozen before any result exists.",
  });
}
const good = {
  firstDraftCorrect: true,
  finalCorrect: true,
  sourceFaithful: true,
  taskFit: true,
  seriousErrors: 0,
  reviewer: { seeded: 2, detected: 2, falsePositives: 0 },
};

/**
 * A journal with one execution per (case, finalist) for the first `cases`
 * cases, each a worker run then a reviewer run with scripted providers.
 */
async function journal(p: EvaluationPlan, cases: number, options: { simulation?: boolean; advice?: boolean; root: string; finalists?: Arrangement[]; seedExtra?: SeedExtra; beforeFixture?: (c: Controller, db: SqliteStore, task: Task, caseNo: number) => Promise<void>; before?: (c: Controller, db: SqliteStore, task: Task, caseNo: number) => void | Promise<void>; afterWorker?: (c: Controller, db: SqliteStore, task: Task, workerRunId: string, caseNo: number) => void | Promise<void>; after?: (c: Controller, db: SqliteStore, task: Task, caseNo: number) => void; workerEffort?: (caseNo: number, k: number) => string | undefined; skipReviewer?: (caseNo: number, k: number) => boolean; taskExtra?: (caseNo: number) => Partial<Task>; projectProfile?: ProjectProfile; provider?: ProviderAdapter; runController?: (c: Controller, task: Task) => Controller } ) {
  const path = join(options.root, "journal-" + Math.random().toString(36).slice(2) + ".sqlite");
  initEvaluationJournal(path, p);
  const { db, c } = controller(path, { projectProfile: options.projectProfile });
  const fixtures: Array<{ caseId: string; arrangementId: string; fixtureId: string; classKey: string }> = [];
  const finalists = options.finalists ?? p.classes[0]!.finalists;
  try {
    for (const [ci, cls] of p.classes.entries())
    for (let i = 0; i < cases; i++)
      for (const [k, f] of finalists.entries()) {
        if (f.kind !== "PAIR") continue;
        const t = caseTask(i + 1, `case-${i + 1}-arr-${k}` + (ci ? "-cls-" + ci : ""), options.simulation, options.advice, options.taskExtra?.(i + 1));
        seed(c, t);
        options.seedExtra?.(c, db, t);
        await options.beforeFixture?.(c, db, t, i + 1);
        const fixture = recordCaseFixture(db, {
          caseId: "C" + (i + 1),
          classKey: cls.key,
          arrangementId: arrangementId(f),
          taskIds: [t.id],
          requestIds: [],
        });
        await options.before?.(c, db, t, i + 1);
        fixtures.push({ caseId: "C" + (i + 1), arrangementId: arrangementId(f), fixtureId: fixture.fixtureId, classKey: cls.key });
        const run = async (role: "worker" | "reviewer", who: typeof f.worker) => {
          const runner = options.runController?.(c, t) ?? c;
          const a = runner.reserve(
            t.id,
            {
              role,
              provider: who.provider,
              model: who.modelId,
              effort: who.effort,
              overrideReason: "evaluation harness run",
              requestKey: `${t.id}-${role}`,
            },
            actorOf(runner),
          );
          const receipt = await runner.execute(a, options.provider ?? adapter(!!options.simulation), actorOf(runner));
          assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
          return a.id;
        };
        const workerRun = await run("worker", { ...f.worker, effort: options.workerEffort?.(i + 1, k) ?? f.worker.effort });
        await options.afterWorker?.(c, db, t, workerRun, i + 1);
        if (!options.skipReviewer?.(i + 1, k)) await run("reviewer", f.reviewer);
        options.after?.(c, db, t, i + 1);
      }
    return { path, fixtures };
  } finally {
    db.close();
  }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "adaptive-eval-"));
  const { db, c } = controller(join(root, "state.sqlite"));
  return {
    root,
    db,
    c,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const graded = (fixtures: Array<{ caseId: string; arrangementId: string; fixtureId: string; classKey?: string }>, grades: (f: { caseId: string; arrangementId: string }) => any = () => good) =>
  fixtures.map((f) => ({
    caseId: f.caseId,
    classKey: f.classKey ?? "general/complex",
    arrangementId: f.arrangementId,
    fixtureId: f.fixtureId,
    graderId: "grader-1",
    grades: grades(f),
  }));

test("plan rules: pilot 8-12, first stage 20-30, fixed step, pool covers the cap", () => {
  const base = plan({ pool: 30, stages: [20, 25, 30] });
  const bad = (change: (p: any) => void, message: RegExp) => {
    const p = structuredClone(base) as any;
    change(p);
    assert.throws(() => EvaluationPlanSchema.parse(p), message);
  };
  bad((p) => (p.sampling = { stages: [19] }), /first qualification stage must be 20 to 30/);
  bad((p) => (p.sampling = { stages: [31] }), /first qualification stage must be 20 to 30/);
  bad((p) => (p.sampling = { stages: [20, 25, 31] }), /one fixed step/);
  bad((p) => (p.sampling = { stages: [20, 40] }), /fewer cases than the sampling cap/);
  bad((p) => ((p.purpose = "PILOT"), (p.sampling = { pilot: { min: 6, max: 12 } })), /within 8 to 12/);
  bad((p) => ((p.purpose = "PILOT"), (p.sampling = { pilot: { min: 8, max: 13 } })), /within 8 to 12/);
  bad((p) => p.classes[0].finalists.push(p.classes[0].finalists[0]), /Duplicate finalist/);
  bad(
    (p) => (p.classes[0].finalists[0] = pair(sol("xhigh", "worker"), sol("max", "reviewer"))),
    /reviewer is from the other provider/,
  );
  bad(
    (p) =>
      (p.classes[0].finalists[0] = pair(
        candidateIdentity({ provider: "codex", model: "gpt-6.1-sol", effort: "low", simulation: false }, "worker", runtime),
        opus("high", "reviewer"),
      )),
    /high, xhigh or max/,
  );
});

test("a plan is frozen once; other bytes under the same ID are refused", () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    assert.equal(freezePlan(f.db, p, "owner").alreadyFrozen, false);
    assert.equal(freezePlan(f.db, p, "owner").alreadyFrozen, true);
    assert.throws(
      () => freezePlan(f.db, { ...p, rationale: "changed after the fact" }, "owner"),
      /EVALUATION_PLAN_ID_REUSED/,
    );
  } finally {
    f.close();
  }
});

test("QAL-06: identity is the definition, never the route ID; changing model, effort, role or tools changes it", () => {
  const base = { provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", simulation: false, role: "worker" };
  const d = routeDefinitionDigest(base);
  assert.notEqual(routeDefinitionDigest({ ...base, model: "gpt-6.2-sol" }), d);
  assert.notEqual(routeDefinitionDigest({ ...base, effort: "max" }), d);
  assert.notEqual(routeDefinitionDigest({ ...base, role: "reviewer" }), d);
  assert.notEqual(routeDefinitionDigest({ ...base, simulation: true }), d);
  // A changed runtime is a different candidate too (contract section 5.1).
  assert.notEqual(
    arrangementId(pair(sol("xhigh", "worker"), opus("high", "reviewer"))),
    arrangementId(
      pair(
        candidateIdentity(base, "worker", { cliVersion: "cli 2.0.0", executableDigest: HEX("f") }),
        opus("high", "reviewer"),
      ),
    ),
  );
});

test("Wilson intervals and the decision rule", () => {
  const w = wilson(18, 20);
  assert.ok(w.low < 0.9 && w.high > 0.9 && w.low > 0.6 && w.high <= 1);
  const p = plan({ pool: 20 });
  const many = (n: number, g: any) => Array.from({ length: n }, () => g);
  assert.equal(decide(p, "PAIR", pairMetrics(many(20, good))).decision, "QUALIFIED");
  // QAL-08 and QAL-03: too few matched cases qualify nothing.
  assert.equal(decide(p, "PAIR", pairMetrics(many(10, good))).decision, "INSUFFICIENT");
  // A point estimate missing a threshold fails.
  assert.equal(
    decide(p, "PAIR", pairMetrics(many(20, { ...good, finalCorrect: false }))).decision,
    "FAILED",
  );
  // Passing points with a bound across a threshold is uncertain: expand.
  const mixed = [...many(15, good), ...many(5, { ...good, finalCorrect: false })];
  const d = decide(p, "PAIR", pairMetrics(mixed));
  assert.equal(d.decision, "UNCERTAIN", d.reasons.join("; "));
  // QAL-02: reviewers are measured on seeded defects, and noisy reviewers
  // are not rewarded for reporting many findings.
  assert.equal(
    decide(p, "PAIR", pairMetrics(many(20, { ...good, reviewer: { seeded: 0, detected: 0, falsePositives: 0 } }))).decision,
    "INSUFFICIENT",
  );
  assert.equal(
    decide(p, "PAIR", pairMetrics(many(20, { ...good, reviewer: { seeded: 2, detected: 2, falsePositives: 4 } }))).decision,
    "FAILED",
  );
  // QAL-08: a pilot qualifies nothing, whatever its results.
  const pilot = plan({ pool: 12, purpose: "PILOT" });
  assert.equal(decide(pilot, "PAIR", pairMetrics(many(12, good))).decision, "CALIBRATION_ONLY");
});

test("QAL-05: an import without a journal is synthetic, and self-attested flags are refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    const imported = importEvidence(f.db, bundle, { actor: "owner" });
    assert.equal(imported.synthetic, true, "no journal: synthetic");
    assert.throws(
      () => importEvidence(f.db, { ...bundle, verified: true, isSynthetic: false }, { actor: "owner" }),
      /Unrecognized key/,
    );
  } finally {
    f.close();
  }
});

test("a live-shaped journal imports as non-synthetic evidence with a decision per arrangement", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    const imported = importEvidence(f.db, bundle, { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, false);
    assert.deepEqual(
      imported.aggregates.map((a) => [a.arrangementId, a.n, a.decision]),
      [
        [arrangementId(A1), 20, "QUALIFIED"],
        [arrangementId(A2), 20, "QUALIFIED"],
      ],
    );
    // Importing the same bundle again changes nothing.
    importEvidence(f.db, bundle, { journalPath: j.path, actor: "owner" });
    assert.equal(importedEvidence(f.db).length, 1);
  } finally {
    f.close();
  }
});

test("QAL-05: simulated receipts make the evidence synthetic", async () => {
  const f = setup();
  try {
    const simA1 = pair(
      candidateIdentity({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", simulation: true }, "worker", runtime),
      candidateIdentity({ provider: "claude", model: "claude-opus-5-5", effort: "high", simulation: true }, "reviewer", runtime),
    );
    const p = plan({ pool: 20, simulation: true, finalists: [simA1] });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root, simulation: true });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), {
      journalPath: j.path,
      actor: "owner",
    });
    assert.equal(imported.synthetic, true);
  } finally {
    f.close();
  }
});

test("evidence age: notes, result order and class composition cannot refresh an expired stage", async (t) => {
  const day = 86_400_000;
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = setup();
  try {
    const p = plan({ pool: 25, stages: [20, 25], finalists: [A1], classKeys: ["general/complex", "other/complex"] });
    const frozen = freezePlan(f.db, p, "owner");
    const j = await journal(p, 25, { root: f.root });
    const all = graded(j.fixtures);
    const first20 = all.filter((r) => Number(r.caseId.slice(1)) <= 20);
    const bundle = buildBundle(j.path, p, first20.filter((r) => r.classKey === "general/complex"));
    const options = { journalPath: j.path, actor: "owner" };
    const first = importEvidence(f.db, bundle, options);
    assert.equal(first.synthetic, false);
    const policy = adaptivePolicy([{ id: p.id, digest: frozen.planDigest }], { routes: example().routes });
    const index = () => new EvidenceIndex(f.db, policy.adaptive!, Date.now());
    const lookup = (key = "general/complex") => index().lookup(key, A1, false);
    const select = () => selectPair({
      taskId: "age-check", providers: ["codex", "claude"], simulation: false,
      tier: "COMPLEX", boundedLowStakes: false, classKey: "general/complex",
      authorship: { providers: [], unknown: false }, context: NO_EXPOSURE,
      history: [], ceiling: { used: 0, allowed: 1 }, preference: { mode: "AUTO" },
    }, policy, policy.adaptive!, () => undefined, () => runtime, index());
    assert.equal(select().ok, true);
    t.mock.timers.tick(90 * day);
    assert.equal(lookup().decision, "QUALIFIED", "the configured age limit is inclusive");
    t.mock.timers.tick(day);
    assert.equal(lookup().decision, "STALE");
    assert.equal(importEvidence(f.db, bundle, options).evidenceId, first.evidenceId);
    assert.equal(importedEvidence(f.db).length, 1, "exact replay remains idempotent");
    for (const changed of [
      { ...bundle, limitations: ["An administrative note, with no new evaluation."] },
      { ...bundle, results: [...bundle.results].reverse() },
    ]) {
      const repeated = importEvidence(f.db, changed, options);
      assert.notEqual(repeated.evidenceId, first.evidenceId);
      assert.deepEqual(repeated.aggregates, first.aggregates);
      assert.equal(lookup().decision, "STALE", "unchanged measured results retain their first import date");
      const held = select();
      assert.ok(!held.ok && held.code === "ADAPTIVE_EVIDENCE_MISSING");
    }
    // The newly imported class has its own clock; bundling it with the old
    // class cannot refresh the old class, and removing it cannot either.
    importEvidence(f.db, buildBundle(j.path, p, first20), options);
    assert.equal(lookup().decision, "STALE");
    assert.equal(lookup("other/complex").decision, "QUALIFIED");
    importEvidence(f.db, { ...bundle, limitations: ["Only the original class."] }, options);
    assert.equal(lookup().decision, "STALE");
    const expanded = buildBundle(j.path, p, all.filter((r) => r.classKey === "general/complex"));
    const larger = importEvidence(f.db, expanded, options);
    assert.equal(lookup().decision, "QUALIFIED", "a larger stage has its own first import date");
    assert.equal(lookup().metrics?.n, 25);
    assert.equal(lookup().evidenceId, larger.evidenceId);
    t.mock.timers.tick(91 * day);
    importEvidence(f.db, { ...expanded, limitations: ["Same larger stage."] }, options);
    importEvidence(f.db, { ...bundle, limitations: ["Later replay of the smaller stage."] }, options);
    assert.equal(lookup().decision, "STALE", "neither stage can refresh the expired largest stage");
    assert.ok(f.db.verifyEvents());
  } finally { f.close(); }
});

for (const scenario of [
  { name: "removing a synthetic companion class", pool: 20, tail: false },
  { name: "taking a smaller prefix without a synthetic companion class", pool: 25, tail: false },
  { name: "taking a smaller prefix without its unverified tail case", pool: 25, tail: true },
]) test("evidence age: " + scenario.name + " cannot refresh a live class", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = setup();
  try {
    const p = plan({
      pool: scenario.pool, stages: scenario.pool === 20 ? [20] : [20, 25], finalists: [A1],
      classKeys: scenario.tail ? ["general/complex"] : ["general/complex", "other/complex"],
    });
    const frozen = freezePlan(f.db, p, "owner");
    const j = await journal(p, scenario.pool, {
      root: f.root,
      afterWorker: async (c, _db, task, _worker, caseNo) => {
        const unverified = scenario.tail ? caseNo === 25 : caseNo === 1 && task.id.endsWith("-cls-1");
        if (!unverified) return;
        const a = c.reserve(task.id, {
          role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high",
          overrideReason: "evaluation harness run", requestKey: task.id + "-unverified-runtime",
        }, c.localActor());
        const failed: ProviderAdapter = { async execute(r) {
          const { provenance: _none, ...receipt } = await adapter(false).execute(r);
          return { ...receipt, status: "FAILED", exitCode: 1 };
        } };
        assert.equal((await c.execute(a, failed, c.localActor())).status, "FAILED");
      },
    });
    const all = graded(j.fixtures), options = { journalPath: j.path, actor: "owner" };
    const mixed = importEvidence(f.db, buildBundle(j.path, p, all), options);
    assert.equal(mixed.synthetic, true, "one unverified run makes the entire bundle synthetic");
    const policy = adaptivePolicy([{ id: p.id, digest: frozen.planDigest }]);
    const lookup = (simulation: boolean) => new EvidenceIndex(f.db, policy.adaptive!, Date.now())
      .lookup("general/complex", A1, simulation);
    assert.equal(lookup(false).decision, "MISSING", "synthetic records cannot qualify live work");
    assert.equal(lookup(true).decision, "QUALIFIED");
    t.mock.timers.tick(91 * 86_400_000);
    const prefix = all.filter((r) => r.classKey === "general/complex" && Number(r.caseId.slice(1)) <= 20);
    const live = importEvidence(f.db, buildBundle(j.path, p, prefix), options);
    assert.equal(live.synthetic, false);
    assert.deepEqual(live.aggregates[0]!.executions, mixed.aggregates[0]!.executions.slice(0, 20));
    assert.equal(lookup(false).decision, "STALE", "eligibility changes do not change the measured stage's age");
    assert.equal(lookup(true).decision, "STALE");
  } finally { f.close(); }
});

test("evidence age: replaying an expired failed stage cannot restore a contradiction", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = setup();
  try {
    const passedPlan = plan({ pool: 20, finalists: [A1] });
    const failedPlan = { ...passedPlan, id: passedPlan.id + "-failed" };
    const failedRef = freezePlan(f.db, failedPlan, "owner");
    const failedJournal = await journal(failedPlan, 20, { root: f.root });
    const failedBundle = buildBundle(failedJournal.path, failedPlan,
      graded(failedJournal.fixtures, () => ({ ...good, finalCorrect: false })));
    assert.equal(importEvidence(f.db, failedBundle, { journalPath: failedJournal.path, actor: "owner" }).aggregates[0]!.decision, "FAILED");
    t.mock.timers.tick(2 * 86_400_000);
    const passedRef = freezePlan(f.db, passedPlan, "owner");
    const passedJournal = await journal(passedPlan, 20, { root: f.root });
    importEvidence(f.db, buildBundle(passedJournal.path, passedPlan, graded(passedJournal.fixtures)),
      { journalPath: passedJournal.path, actor: "owner" });
    const policy = adaptivePolicy([
      { id: passedPlan.id, digest: passedRef.planDigest }, { id: failedPlan.id, digest: failedRef.planDigest },
    ]);
    const lookup = () => new EvidenceIndex(f.db, policy.adaptive!, Date.now()).lookup("general/complex", A1, false);
    assert.equal(lookup().decision, "CONTRADICTORY", "a current failed plan still blocks qualification");
    t.mock.timers.tick(89 * 86_400_000);
    assert.equal(lookup().decision, "QUALIFIED", "only the failed plan has expired");
    importEvidence(f.db, { ...failedBundle, limitations: ["Reimported failure; no new runs."] },
      { journalPath: failedJournal.path, actor: "owner" });
    assert.equal(lookup().decision, "QUALIFIED", "the expired failed stage must stay expired");
  } finally { f.close(); }
});

test("QAL-04: tampered journals, receipts and identities are refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    // A receipt digest that does not match the journal.
    const wrongReceipt = structuredClone(bundle);
    wrongReceipt.results[0]!.runs.worker[0]!.receiptDigest = HEX("1");
    assert.throws(
      () => importEvidence(f.db, wrongReceipt, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUNS_INCOMPLETE:C1/,
    );
    // A different head than the journal's.
    assert.throws(
      () => importEvidence(f.db, { ...bundle, journalHead: HEX("2") }, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_JOURNAL_HEAD_MISMATCH/,
    );
    // Runs of another execution cited for this one.
    const swapped = structuredClone(bundle);
    const other = swapped.results.find((r) => r.arrangementId !== swapped.results[0]!.arrangementId)!;
    [swapped.results[0]!.runs, other.runs] = [other.runs, swapped.results[0]!.runs];
    assert.throws(
      () => importEvidence(f.db, swapped, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUNS_INCOMPLETE/,
    );
    // An edited journal no longer verifies.
    const raw = new SqliteStore(j.path);
    raw.run("DROP TRIGGER immutable_events_update");
    raw.run("UPDATE events SET body=? WHERE seq=2", canonical({ tampered: true }));
    raw.close();
    assert.throws(
      () => importEvidence(f.db, bundle, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_JOURNAL_CHAIN_BROKEN/,
    );
  } finally {
    f.close();
  }
});

test("QAL-08 (matching): finalists must share the same staged prefix of the case pool", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    const missing = { ...bundle, results: bundle.results.filter((r, i) => !(i === 1)) };
    assert.throws(() => importEvidence(f.db, missing, { journalPath: j.path, actor: "owner" }), /UNMATCHED_CASES/);
  } finally {
    f.close();
  }
});

test("F3 of round 1: one execution can never stand for several cases", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    // Case 2 keeps its own fixture but cites case 1's genuine runs.
    const reused = structuredClone(bundle);
    const ofA1 = reused.results.filter((r) => r.arrangementId === arrangementId(A1));
    ofA1[1]!.runs = ofA1[0]!.runs;
    assert.throws(
      () => importEvidence(f.db, reused, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUNS_INCOMPLETE:C2/,
    );
    // Or case 2 cites case 1's whole execution: its fixture is case 1's.
    const both = structuredClone(bundle);
    const again = both.results.filter((r) => r.arrangementId === arrangementId(A1));
    again[1]!.fixtureId = again[0]!.fixtureId;
    again[1]!.runs = again[0]!.runs;
    assert.throws(
      () => importEvidence(f.db, both, { journalPath: j.path, actor: "owner" }),
      /CASE_INPUT_MISMATCH:C2/,
    );
  } finally {
    f.close();
  }
});

test("round 10: an owner record added to an execution after its fixture makes it unmatched", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      before: (c, _db, t, caseNo) => {
        if (caseNo !== 3) return;
        c.decide(
          t.id,
          {
            id: "help-" + t.id,
            text: "Decisive solution guidance for this execution only",
            sourceRef: "owner:extra",
            alternatives: [],
            limits: [],
            operations: t.operations,
            artifactRevision: t.artifactRevision,
          },
          c.localActor(),
        );
      },
    });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    assert.throws(
      () => importEvidence(f.db, bundle, { journalPath: j.path, actor: "owner" }),
      /CASE_INPUT_CHANGED:C3:OWNER_DECISION|CASE_INPUT_MISMATCH:C3/,
    );
  } finally {
    f.close();
  }
});

test("a fixture that does not match the frozen case is refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    // Freeze a plan whose case 1 expects other input.
    const altered = structuredClone(p);
    altered.classes[0]!.cases[0]!.caseInputDigest = HEX("3");
    const q = EvaluationPlanSchema.parse({ ...altered, id: p.id + "-x" });
    freezePlan(f.db, q, "owner");
    const j = await journal(q, 20, { root: f.root });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, q, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /CASE_INPUT_MISMATCH:C1/,
    );
  } finally {
    f.close();
  }
});

test("results produced before the plan was frozen here are refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    const j = await journal(p, 20, { root: f.root });
    freezePlan(f.db, p, "owner");
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RESULT_BEFORE_FREEZE/,
    );
  } finally {
    f.close();
  }
});

test("expansion: an uncertain stage grows to the next with the same earlier executions", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 25, stages: [20, 25] });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 25, { root: f.root });
    const all = graded(j.fixtures, (x) =>
      ["C1", "C2", "C3", "C4", "C5"].includes(x.caseId) ? { ...good, finalCorrect: false } : good,
    );
    const first20 = all.filter((r) => Number(r.caseId.slice(1)) <= 20);
    const stage1 = importEvidence(f.db, buildBundle(j.path, p, first20), { journalPath: j.path, actor: "owner" });
    assert.ok(stage1.aggregates.every((a) => a.decision === "UNCERTAIN" && a.n === 20));
    // The expansion keeps the stage-1 executions and adds five more cases.
    const stage2 = importEvidence(f.db, buildBundle(j.path, p, all), { journalPath: j.path, actor: "owner" });
    assert.ok(stage2.aggregates.every((a) => a.n === 25));
    // A later stage that regrades the earlier stage's cases is refused
    // (review E2 F3): the five wrong answers stay wrong.
    const regraded = buildBundle(j.path, p, graded(j.fixtures));
    assert.throws(
      () => importEvidence(f.db, regraded, { journalPath: j.path, actor: "owner" }),
      /STAGE_REWRITES_CASES:C1/,
    );
  } finally {
    f.close();
  }
});

test("QAL-08 (pilot): pilot bundles are calibration only", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 12, purpose: "PILOT" });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 10, { root: f.root });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), {
      journalPath: j.path,
      actor: "owner",
    });
    assert.ok(imported.aggregates.every((a) => a.decision === "CALIBRATION_ONLY"));
  } finally {
    f.close();
  }
});

test("QAL-04: a run whose model or effort differs from its arrangement is refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    // Case 4's first finalist actually ran its worker at max, not xhigh.
    const j = await journal(p, 20, {
      root: f.root,
      workerEffort: (caseNo, k) => (caseNo === 4 && k === 0 ? "max" : undefined),
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUN_IDENTITY_MISMATCH/,
    );
  } finally {
    f.close();
  }
});

test("round 10: an owner or operator record that leaves the fixture intact still makes the execution unmatched", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      before: (c, _db, t, caseNo) => {
        if (caseNo === 5)
          c.extendBudget(
            t.id,
            { maxAttempts: 5, reason: "More tries for this execution only", sourceRef: "operator:extra" },
            c.localActor(),
          );
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /CASE_INPUT_CHANGED:C5:BUDGET_EXTENDED/,
    );
  } finally {
    f.close();
  }
});

test("review E2 F1: an execution lists every run of its tasks, including the arrangement's own roles", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const bundle = buildBundle(j.path, p, graded(j.fixtures));
    // Leaving out the runs never makes an execution unverifiable evidence.
    const empty = structuredClone(bundle);
    for (const r of empty.results) r.runs = { worker: [], reviewer: [], rework: [], overseer: [] };
    assert.throws(
      () => importEvidence(f.db, empty, { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUNS_INCOMPLETE:C1/,
    );
    // An execution whose reviewer never ran measures no pair.
    const unreviewed = await journal(p, 20, { root: f.root, skipReviewer: (caseNo, k) => caseNo === 2 && k === 1 });
    assert.throws(
      () => importEvidence(f.db, buildBundle(unreviewed.path, p, graded(unreviewed.fixtures)), { journalPath: unreviewed.path, actor: "owner" }),
      /EVALUATION_EXECUTION_EMPTY:C2/,
    );
  } finally {
    f.close();
  }
});

test("review E2 F2: an attempt or receipt edited after the run cannot change what ran", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    // Case 4's first finalist really ran its worker at max...
    const j = await journal(p, 20, {
      root: f.root,
      workerEffort: (caseNo, k) => (caseNo === 4 && k === 0 ? "max" : undefined),
    });
    // ...and its attempt and receipt rows are edited to say xhigh.
    const raw = new SqliteStore(j.path);
    raw.run("DROP TRIGGER immutable_receipts_update");
    const row = raw.get<{ id: string; body: string }>("SELECT id, body FROM attempts WHERE task_id='case-4-arr-0' AND role='worker'")!;
    raw.run("UPDATE attempts SET body=? WHERE id=?", canonical({ ...JSON.parse(row.body), effort: "xhigh" }), row.id);
    const receipt = raw.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", row.id)!;
    raw.run("UPDATE receipts SET body=? WHERE attempt_id=?", canonical({ ...JSON.parse(receipt.body), effort: "xhigh" }), row.id);
    raw.close();
    // The hash-chained routing decision still says max.
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      new RegExp("EVALUATION_RUN_IDENTITY_MISMATCH:" + row.id),
    );
  } finally {
    f.close();
  }
});

test("review E2 F4 and F6: attaching tasks, or owner evidence under a controller-style name, after the fixture changes the input", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const attached = await journal(p, 20, {
      root: f.root,
      before: (_c, db, t, caseNo) => {
        if (caseNo === 6)
          db.event("WORKFLOW_TASKS_ATTACHED", null, {
            requestId: "another-request",
            bindings: [{ taskId: t.id, specDigest: HEX("5") }],
          });
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(attached.path, p, graded(attached.fixtures)), { journalPath: attached.path, actor: "owner" }),
      /CASE_INPUT_CHANGED:C6:WORKFLOW_TASKS_ATTACHED/,
    );
    const named = await journal(p, 20, {
      root: f.root,
      before: (c, _db, t, caseNo) => {
        if (caseNo === 7)
          c.addEvidence(
            {
              id: "output-extra-" + t.id,
              taskId: t.id,
              kind: "LOCAL",
              uri: "owner:guidance",
              revision: "r1",
              digest: HEX("6"),
              retrievedAt: "2026-10-29T00:00:00.000Z",
              authorityTier: "PLANNING",
              authentication: "LOCAL_OWNER_REQUEST",
              currentness: "CURRENT_AT_RETRIEVAL",
              claims: ["Guidance for this execution only"],
              metadata: {},
            },
            c.localActor(),
          );
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(named.path, p, graded(named.fixtures)), { journalPath: named.path, actor: "owner" }),
      /CASE_INPUT_CHANGED:C7:EVIDENCE_APPENDED|CASE_INPUT_MISMATCH:C7/,
    );
  } finally {
    f.close();
  }
});

test("review E2 F5: advice the worker could have seen, with no exposure record, is refused rather than read as no exposure", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, advice: true });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      advice: true,
      before: async (c, _db, t, caseNo) => {
        // Codex advises case 1's Codex worker; its reviewer is Claude.
        if (caseNo !== 1 || !t.id.endsWith("-arr-0")) return;
        const a = c.reserve(
          t.id,
          { role: "advisor", provider: "codex", model: "gpt-6-astra", effort: "xhigh", overrideReason: "evaluation harness run", requestKey: t.id + "-advisor" },
          c.localActor(),
        );
        const receipt = await c.execute(a, adapter(false), c.localActor());
        assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
        assert.ok(c.advice(t.id)[0]?.advice, "the advice is usable, so the worker saw it");
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_EXPOSURE_UNRECORDED/,
    );
  } finally {
    f.close();
  }
});

test("review E2 F7 to F9: normalization keeps each record's task and the text, and never depends on generated IDs", () => {
  const two = (ids: [string, string], options: { decisionOn?: 0 | 1; scope?: (id: string) => string } = {}) => {
    const [first, second] = ids.map((id, i) =>
      demoTask(id, {
        title: "Case task " + (i + 1),
        scope: options.scope?.(id) ?? "Write part " + (i + 1),
        writePaths: ["output/case"],
        dependencies: i === 1 ? [ids[0]] : [],
        createdAt: "2026-10-29T00:00:00.000Z",
      }),
    );
    return digest(
      normalizedFixture({
        requests: [],
        tasks: [first!, second!],
        grants: [],
        decisions:
          options.decisionOn === undefined
            ? []
            : [{ id: "d-1", taskId: ids[options.decisionOn], text: "Use the short greeting", sourceRef: "owner" }],
        evidence: [],
        scriptedAnswers: [],
      }),
    );
  };
  // F9: the same case under IDs that sort the other way normalizes equally.
  assert.equal(two(["z-first", "a-second"]), two(["a-first", "z-second"]));
  // F7: a decision on the first task is not a decision on the second.
  assert.notEqual(two(["x-1", "x-2"], { decisionOn: 0 }), two(["x-1", "x-2"], { decisionOn: 1 }));
  assert.equal(two(["x-1", "x-2"], { decisionOn: 0 }), two(["y-1", "y-2"], { decisionOn: 0 }));
  // F8: text that names a task is text, never an identity.
  assert.notEqual(
    two(["alpha", "omega"], { scope: (id) => "Return " + id }),
    two(["beta", "omega"], { scope: (id) => "Return " + id }),
  );
});

test("review E2 F10: two classes may share case IDs and an arrangement without sharing executions", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, classKeys: ["general/complex", "general/expert"] });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    const fixturesOf = (classKey: string) =>
      new Set(imported.aggregates.filter((a) => a.classKey === classKey).flatMap((a) => a.executions.map((x) => x.fixtureId)));
    const complex = fixturesOf("general/complex"),
      expert = fixturesOf("general/expert");
    assert.equal(complex.size, 40);
    assert.equal(expert.size, 40);
    assert.ok([...complex].every((id) => !expert.has(id)));
  } finally {
    f.close();
  }
});

test("review E2 F11 and F12: evidence qualifies only the protocol that ran, and each identity's own role", async () => {
  const f = setup();
  try {
    const v2 = [A1, A2].map((a) => ({ ...a, protocolVersion: ADAPTIVE_PROTOCOL_VERSION + 1 }) as Arrangement);
    const p = plan({ pool: 20, finalists: v2 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_PROTOCOL_MISMATCH:C1/,
    );
    // A worker identity labelled as a reviewer is never a finalist.
    const base = plan({ pool: 20 });
    const mislabelled = structuredClone(base) as any;
    mislabelled.classes[0].finalists[0].worker = sol("xhigh", "reviewer");
    assert.throws(() => EvaluationPlanSchema.parse(mislabelled), /identities are a worker's and a reviewer's/);
  } finally {
    f.close();
  }
});

test("review E2 r2 N1: runs routed on another specification than the fixture's are refused", async () => {
  const f = setup();
  try {
    // Both specifications are authorized before the fixture...
    const variant = (t: Task) => ({ ...t, scope: t.scope + " (variant B)" });
    const twoSpecs: SeedExtra = (c, db, t) => {
      db.run("UPDATE tasks SET body=? WHERE id=?", canonical(variant(t)), t.id);
      c.grant(
        t.id,
        { id: "grant-b-" + t.id, operations: [...t.operations, "ACCEPT"], paths: t.writePaths, decisionText: "Evaluation case B", sourceRef: "eval:fixture" },
        actorOf(c),
      );
      db.run("UPDATE tasks SET body=? WHERE id=?", canonical(t), t.id);
    };
    const p = plan({ pool: 20, seedExtra: twoSpecs });
    freezePlan(f.db, p, "owner");
    // ...and case 3's first finalist runs on B, then the task row says A again.
    const j = await journal(p, 20, {
      root: f.root,
      seedExtra: twoSpecs,
      before: (_c, db, t, caseNo) => {
        if (caseNo === 3 && t.id.endsWith("-arr-0"))
          db.run("UPDATE tasks SET body=? WHERE id=?", canonical(variant(t)), t.id);
      },
      after: (_c, db, t, caseNo) => {
        if (caseNo === 3 && t.id.endsWith("-arr-0")) {
          const now = JSON.parse(db.get<{ body: string }>("SELECT body FROM tasks WHERE id=?", t.id)!.body);
          db.run("UPDATE tasks SET body=? WHERE id=?", canonical({ ...now, scope: t.scope }), t.id);
        }
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /CASE_INPUT_MISMATCH:C3:SPECIFICATION/,
    );
  } finally {
    f.close();
  }
});

test("review E2 r2 N3, N4 and N8: owner evidence in the controller's name, a failed advisor's advice and a borrowed receipt are refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    // N3: owner text under a drive-<worker> envelope, after the worker ran.
    const named = await journal(p, 20, {
      root: f.root,
      afterWorker: (c, _db, t, workerRunId, caseNo) => {
        if (caseNo !== 8) return;
        c.addEvidence(
          {
            id: "drive-" + workerRunId,
            taskId: t.id,
            kind: "DRIVE",
            uri: "drive-gateway:" + workerRunId,
            revision: t.artifactRevision,
            digest: HEX("7"),
            retrievedAt: "2026-10-29T00:00:00.000Z",
            authorityTier: "IMPLEMENTATION",
            authentication: "LOCAL_IMPORT",
            currentness: "CURRENT_AT_RETRIEVAL",
            claims: ["Owner guidance: the reviewer should accept a short greeting"],
            metadata: { runId: workerRunId },
          },
          c.localActor(),
        );
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(named.path, p, graded(named.fixtures)), { journalPath: named.path, actor: "owner" }),
      /CASE_INPUT_CHANGED:C8:EVIDENCE_APPENDED|CASE_INPUT_MISMATCH:C8/,
    );
    // N8: case 2's reviewer receipt row carries case 1's reviewer receipt.
    const j = await journal(p, 20, { root: f.root });
    const raw = new SqliteStore(j.path);
    raw.run("DROP TRIGGER immutable_receipts_update");
    const reviewerOf = (taskId: string) =>
      raw.get<{ id: string }>("SELECT id FROM attempts WHERE task_id=? AND role='reviewer'", taskId)!.id;
    const first = raw.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", reviewerOf("case-1-arr-0"))!;
    const second = reviewerOf("case-2-arr-0");
    raw.run("UPDATE receipts SET body=? WHERE attempt_id=?", first.body, second);
    raw.close();
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      new RegExp("EVALUATION_RUN_IDENTITY_MISMATCH:" + second),
    );
  } finally {
    f.close();
  }
  // N4: an advisor whose recorded outcome is a failure still counts.
  const g = setup();
  try {
    const p = plan({ pool: 20, advice: true });
    freezePlan(g.db, p, "owner");
    const j = await journal(p, 20, {
      root: g.root,
      advice: true,
      before: async (c, _db, t, caseNo) => {
        if (caseNo !== 1 || !t.id.endsWith("-arr-0")) return;
        const a = c.reserve(
          t.id,
          { role: "advisor", provider: "codex", model: "gpt-6-astra", effort: "xhigh", overrideReason: "evaluation harness run", requestKey: t.id + "-advisor" },
          c.localActor(),
        );
        const failing: ProviderAdapter = {
          async execute(r) {
            const receipt = await adapter(false).execute(r);
            return { ...receipt, status: "FAILED", exitCode: 1 };
          },
        };
        const receipt = await c.execute(a, failing, c.localActor());
        assert.equal(receipt.status, "FAILED");
      },
    });
    assert.throws(
      () => importEvidence(g.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_EXPOSURE_UNRECORDED/,
    );
  } finally {
    g.close();
  }
});

test("review E2 r2 N2 and N7: a fixture keeps its questions and answers, and a request's generated identities are normalized", () => {
  const request = (n: number) => ({ id: "req-" + n, prompt: "Write the greeting", inputDigest: HEX(String(n)) });
  const fixture = (n: number, answer = "Short") => {
    const r = request(n);
    const t = demoTask("t-" + n, {
      title: "Case task",
      sources: [{ evidenceId: "owner-request-" + r.id + "-t-" + n, revision: r.inputDigest, digest: HEX("c") }],
      writePaths: ["output/case"],
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    return digest(
      normalizedFixture({
        requests: [r],
        tasks: [t],
        grants: [],
        decisions: [],
        evidence: [
          {
            id: "owner-request-" + r.id + "-t-" + n,
            taskId: t.id,
            kind: "LOCAL",
            uri: "orchestrator-request:" + r.id,
            revision: r.inputDigest,
            digest: HEX("c"),
            metadata: { requestId: r.id, sourceRef: "test:owner" },
          },
        ],
        questions: [
          {
            question: { id: "q-" + n, key: "tone", text: "Which tone?", audience: "OWNER", kind: "OWNER_DECISION", taskId: t.id, specDigest: HEX("e") },
            answers: [{ text: answer, sourceRef: "test:owner", answeredAs: "OWNER", questionId: "q-" + n, createdAt: "2026-10-29T00:00:00.000Z" }],
            deferrals: [],
          },
        ],
        scriptedAnswers: [],
      }),
    );
  };
  // N7: the same case under another request's generated identities.
  assert.equal(fixture(1), fixture(2));
  // N2: another answer to the same question is another input.
  assert.notEqual(fixture(1), fixture(1, "Warm"));
});

test("review E2 r3 M1: a run that ended early at another effort is still part of the execution, and is refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      afterWorker: async (c, _db, t, _worker, caseNo) => {
        if (caseNo !== 5 || !t.id.endsWith("-arr-0")) return;
        // A Max reviewer that failed before its report; the arrangement's is High.
        const a = c.reserve(
          t.id,
          { role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "max", overrideReason: "evaluation harness run", requestKey: t.id + "-cut-off" },
          c.localActor(),
        );
        const cutOff: ProviderAdapter = {
          async execute(r) {
            return { ...(await adapter(false).execute(r)), status: "FAILED", exitCode: 1 };
          },
        };
        assert.equal((await c.execute(a, cutOff, c.localActor())).status, "FAILED");
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUN_IDENTITY_MISMATCH/,
    );
  } finally {
    f.close();
  }
});

test("review E2 r3 M5: advice on an earlier specification never reached the measured run", async () => {
  const f = setup();
  try {
    const advisedThenRevised: SeedExtra = (c, _db, t) => {
      const a = c.reserve(
        t.id,
        { role: "advisor", provider: "codex", model: "gpt-6-astra", effort: "xhigh", overrideReason: "evaluation harness run", requestKey: t.id + "-old-advice" },
        c.localActor(),
      );
      // The advice run is recorded as never started: no advice reached anyone.
      c.recover(c.localActor(), Date.now() + 3_600_000);
      void a;
      const now = c.task(t.id);
      c.revise(t.id, { ...now, specVersion: now.specVersion + 1, status: "DISCOVERED" }, c.localActor());
      c.grant(
        t.id,
        { id: "grant-v2-" + t.id, operations: [...t.operations, "ACCEPT"], paths: t.writePaths, decisionText: "Evaluation case", sourceRef: "eval:fixture" },
        c.localActor(),
      );
    };
    const p = plan({ pool: 20, advice: true, seedExtra: advisedThenRevised });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root, advice: true, seedExtra: advisedThenRevised });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, false);
  } finally {
    f.close();
  }
});

test("review E2 r3 M6 / X5: an execution one import cited cannot be cited again for another class", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, finalists: [A1], classKeys: ["general/complex", "general/expert"] });
    freezePlan(f.db, p, "owner");
    const shared: Array<{ caseId: string; arrangementId: string; fixtureId: string; classKey: string }> = [];
    const j = await journal(p, 20, {
      root: f.root,
      beforeFixture: async (_c, db, task, caseNo) => {
        if (task.id.endsWith("-cls-1")) return;
        // Both fixtures are legitimately recorded before these tasks run,
        // with each one's correct class binding and frozen case input.
        const extra = recordCaseFixture(db, {
          caseId: "C" + caseNo, classKey: "general/expert", arrangementId: arrangementId(A1),
          taskIds: [task.id], requestIds: [],
        });
        shared.push({ caseId: "C" + caseNo, classKey: "general/expert", arrangementId: arrangementId(A1), fixtureId: extra.fixtureId });
      },
    });
    const ofClass = (key: string) => j.fixtures.filter((x) => x.classKey === key);
    const secondClass = buildBundle(j.path, p, graded(shared));
    // Positive control: these exact class-B fixtures and runs qualify in a
    // registry without prior ownership. Roll back only the evidence append.
    const independent = f.db.rollbackOnly(() => importEvidence(f.db, secondClass, { journalPath: j.path, actor: "owner" }));
    assert.equal(independent.synthetic, false);
    assert.ok(independent.aggregates.every((a) => a.decision === "QUALIFIED"));
    assert.equal(importedEvidence(f.db).length, 0);
    importEvidence(f.db, buildBundle(j.path, p, graded(ofClass("general/complex"))), { journalPath: j.path, actor: "owner" });
    // Class B has correctly bound fixtures; only earlier ownership of their
    // shared executions can reject them (review X5's coverage gap).
    assert.throws(
      () => importEvidence(f.db, secondClass, { journalPath: j.path, actor: "owner" }),
      /^Error: CASE_EXECUTION_REUSED:case-1-arr-0$/,
    );
    assert.equal(importedEvidence(f.db).length, 1);
  } finally {
    f.close();
  }
});

test("review E2 r3 M2 and M4: text that equals a request ID is text, and an answer's other fields are input", () => {
  const fixture = (n: number, options: { scopeIsRequestId?: boolean; answeredAs?: string; sourceRef?: string } = {}) => {
    const r = { id: "req-" + n, prompt: "Write the greeting", inputDigest: HEX(String(n)) };
    const t = demoTask("t-" + n, {
      title: "Case task",
      ...(options.scopeIsRequestId ? { scope: r.id } : {}),
      writePaths: ["output/case"],
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    return digest(
      normalizedFixture({
        requests: [r],
        tasks: [t],
        grants: [],
        decisions: [],
        evidence: [],
        questions: [
          {
            question: { id: "q-" + n, key: "tone", text: "Which tone?", audience: "OWNER", kind: "OWNER_DECISION", taskId: t.id },
            answers: [{ text: "Short", sourceRef: options.sourceRef ?? "test:owner", answeredAs: options.answeredAs ?? "OWNER", questionId: "q-" + n }],
            deferrals: [],
          },
        ],
        scriptedAnswers: [],
      }),
    );
  };
  // M2: a scope that happens to equal the request's ID stays itself.
  assert.notEqual(fixture(1, { scopeIsRequestId: true }), fixture(2, { scopeIsRequestId: true }));
  assert.equal(fixture(1), fixture(2));
  // M4: the same answer text from another answerer, or citing another source, differs.
  assert.notEqual(fixture(1), fixture(1, { answeredAs: "OPERATOR" }));
  assert.notEqual(fixture(1), fixture(1, { sourceRef: "operator:evidence" }));
});

const advisorRun = async (c: Controller, t: Task, run: boolean) => {
  const a = c.reserve(
    t.id,
    { role: "advisor", provider: "codex", model: "gpt-6-astra", effort: "xhigh", overrideReason: "evaluation harness run", requestKey: t.id + "-advisor-" + run },
    c.localActor(),
  );
  if (run) assert.equal((await c.execute(a, adapter(false), c.localActor())).status, "SUCCEEDED");
  else c.recover(c.localActor(), Date.now() + 3_600_000);
};

test("review E2 r4 Q1: a case whose task ran before its fixture is refused", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, advice: true });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      advice: true,
      beforeFixture: async (c, _db, t, caseNo) => {
        if (caseNo === 3 && t.id.endsWith("-arr-0")) await advisorRun(c, t, true);
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /CASE_TASK_RAN_BEFORE_FIXTURE:C3/,
    );
  } finally {
    f.close();
  }
});

test("review E2 r4 Q2 and Q8: runs that never launched, or were cancelled before start, and an advisor that never started, are not part of the execution", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, advice: true });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, {
      root: f.root,
      advice: true,
      before: async (c, _db, t, caseNo) => {
        if (caseNo === 4 && t.id.endsWith("-arr-0")) await advisorRun(c, t, false);
      },
      afterWorker: async (c, db, t, _worker, caseNo) => {
        if (caseNo !== 4 || !t.id.endsWith("-arr-0")) return;
        const reviewer = (key: string) =>
          c.reserve(
            t.id,
            { role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "max", overrideReason: "evaluation harness run", requestKey: t.id + key },
            c.localActor(),
          );
        const notLaunched: ProviderAdapter = {
          async execute(r) {
            return { ...(await adapter(false).execute(r)), status: "FAILED", exitCode: 1, notLaunched: true, costUsd: 0, tokens: 0 };
          },
        };
        const refused = reviewer("-never");
        await c.execute(refused, notLaunched, c.localActor());
        assert.ok(db.get("SELECT seq FROM events WHERE kind='PROCESS_START_INTENT' AND json_extract(body,'$.runId')=?", refused.id),
          "A verified pre-launch refusal legitimately follows a launch intent");
        c.cancel(reviewer("-cancelled").id, c.localActor());
        const expired = reviewer("-expired-unstarted");
        assert.equal(c.recover(c.localActor(), expired.leaseUntil + 1).find((r) => r.runId === expired.id)?.outcome,
          "DEFINITELY_NOT_STARTED");
        assert.equal(db.get("SELECT seq FROM events WHERE kind='PROCESS_START_INTENT' AND json_extract(body,'$.runId')=?", expired.id), undefined,
          "A recovered reservation that never launched has no start intent");
      },
    });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, false);
    assert.ok(imported.aggregates.every((a) => a.decision === "QUALIFIED"));
  } finally {
    f.close();
  }
});

test("review E2 r4 Q4 to Q6: request identities never order evidence, answers cite evidence by ordinal, and historical applicability is kept", () => {
  const fixture = (ids: [string, string], options: { history?: string[]; historicalFor?: string } = {}) => {
    const requests = ids.map((id, i) => ({ id, prompt: "Write the greeting", inputDigest: HEX(String(i + 1)) }));
    const source = (r: { id: string; inputDigest: string }) => "owner-request-" + r.id + "-t";
    const t = demoTask("t", {
      title: "Case task",
      writePaths: ["output/case"],
      createdAt: "2026-10-29T00:00:00.000Z",
      sources: requests.map((r) => ({ evidenceId: source(r), revision: r.inputDigest, digest: HEX("c") })),
    });
    return digest(
      normalizedFixture({
        requests,
        tasks: [t],
        grants: [],
        decisions: [],
        evidence: requests.map((r) => ({
          id: source(r),
          taskId: "t",
          kind: "LOCAL",
          uri: "orchestrator-request:" + r.id,
          revision: r.inputDigest,
          digest: HEX("c"),
          metadata: { requestId: r.id, sourceRef: "test:owner" },
        })),
        specHistory: { t: options.history ?? ["s1", "s2"] },
        questions: [
          {
            question: { id: "q", key: "tone", text: "Which tone?", audience: "OPERATOR", kind: "INFORMATION", taskId: "t", specDigest: "s1" },
            answers: [
              {
                text: "See the owner's request",
                sourceRef: "operator:records",
                answeredAs: "OPERATOR",
                evidence: [source(requests[0]!)],
                ...(options.historicalFor ? { historicalOnly: true, historicalForSpec: { t: options.historicalFor } } : {}),
              },
            ],
            deferrals: [],
          },
        ],
        scriptedAnswers: [],
      }),
    );
  };
  // Q4 and Q5: other request IDs, sorting the other way, are the same case.
  assert.equal(fixture(["a-request", "z-request"]), fixture(["y-request", "b-request"]));
  // Q6: an answer historical for the first specification differs from one for the second.
  assert.notEqual(fixture(["a", "b"], { historicalFor: "s1" }), fixture(["a", "b"], { historicalFor: "s2" }));
  assert.equal(fixture(["a", "b"], { historicalFor: "s1" }), fixture(["c", "d"], { historicalFor: "s1" }));
});

const notLaunched: ProviderAdapter = {
  async execute(r) {
    return { ...(await adapter(false).execute(r)), status: "FAILED", exitCode: 1, notLaunched: true, costUsd: 0, tokens: 0 };
  },
};

test("review E2 r5 S1: a run whose receipt says it never launched did nothing, before the fixture or after it", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, advice: true });
    freezePlan(f.db, p, "owner");
    const w = (p.classes[0]!.finalists[0] as any).worker;
    const j = await journal(p, 20, {
      root: f.root,
      advice: true,
      // A worker refused before launch, before the case's fixture.
      beforeFixture: async (c, _db, t, caseNo) => {
        if (caseNo !== 3 || !t.id.endsWith("-arr-0")) return;
        const a = c.reserve(
          t.id,
          { provider: w.provider, model: w.modelId, effort: w.effort, overrideReason: "evaluation harness run", requestKey: t.id + "-early" },
          c.localActor(),
        );
        assert.equal((await c.execute(a, notLaunched, c.localActor())).status, "FAILED");
      },
      // An advisor refused before launch, after it.
      before: async (c, _db, t, caseNo) => {
        if (caseNo !== 4 || !t.id.endsWith("-arr-0")) return;
        const a = c.reserve(
          t.id,
          { role: "advisor", provider: "codex", model: "gpt-6-astra", effort: "xhigh", overrideReason: "evaluation harness run", requestKey: t.id + "-advisor-never" },
          c.localActor(),
        );
        await c.execute(a, notLaunched, c.localActor());
      },
    });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, false);
    assert.ok(imported.aggregates.every((a) => a.decision === "QUALIFIED"));
  } finally {
    f.close();
  }
});

test("review E2 r5 S2: a failed run's recorded runtime is its own, and must be the arrangement's", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const rv = (p.classes[0]!.finalists[0] as any).reviewer;
    const j = await journal(p, 20, {
      root: f.root,
      afterWorker: async (c, _db, t, _worker, caseNo) => {
        if (caseNo !== 5 || !t.id.endsWith("-arr-0")) return;
        // The arrangement's reviewer identity, under another CLI, failed.
        const a = c.reserve(
          t.id,
          { role: "reviewer", provider: rv.provider, model: rv.modelId, effort: rv.effort, overrideReason: "evaluation harness run", requestKey: t.id + "-other-cli" },
          c.localActor(),
        );
        const otherCli: ProviderAdapter = {
          async execute(r) {
            const ok = await adapter(false).execute(r);
            return { ...ok, status: "FAILED", exitCode: 1, provenance: { ...ok.provenance!, cliVersion: "cli 9.9.9" } };
          },
        };
        assert.equal((await c.execute(a, otherCli, c.localActor())).status, "FAILED");
      },
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_RUN_IDENTITY_MISMATCH/,
    );
  } finally {
    f.close();
  }
});

test("review E2 r5 S3 and S4: history no record refers to leaves no trace, and a question's tasks are a set", () => {
  const task = (id: string) =>
    demoTask(id, { title: "Case task", scope: "Write the greeting", writePaths: ["output/case"], createdAt: "2026-10-29T00:00:00.000Z" });
  const base = { requests: [], grants: [], decisions: [], evidence: [], scriptedAnswers: [] };
  const asked = (taskId: string, d: string) => ({
    question: { id: "q", key: "tone", text: "Which tone?", audience: "OPERATOR", kind: "INFORMATION", taskId, specDigest: d },
    answers: [],
    deferrals: [],
  });
  const of = (history: string[], on: string) =>
    digest(normalizedFixture({ ...base, tasks: [task("t")], specHistory: { t: history }, questions: [asked("t", on)] }));
  // S3: seeded at the second version, or seeded at the first and revised to it.
  assert.equal(of(["v2"], "v2"), of(["v1", "v2"], "v2"));
  // A question on the version before the current one, with or without an
  // earlier version nothing refers to.
  assert.equal(of(["v0", "v1", "v2"], "v1"), of(["v1", "v2"], "v1"));
  // An earlier specification a question was asked on still differs from the current one.
  assert.notEqual(of(["v1", "v2"], "v1"), of(["v1", "v2"], "v2"));
  // Without a history, the task's own specification is its current one.
  const t = task("t");
  assert.equal(
    digest(normalizedFixture({ ...base, tasks: [t], questions: [asked("t", specDigest(t))] })),
    of([specDigest(t)], specDigest(t)),
  );
  // S4: the same two tasks under IDs that sort the other way.
  const scoped = (ids: [string, string]) =>
    digest(
      normalizedFixture({
        ...base,
        tasks: ids.map(task),
        specHistory: Object.fromEntries(ids.map((id) => [id, ["v-" + id]])),
        questions: [
          {
            question: {
              id: "q",
              key: "both",
              text: "Both?",
              audience: "OWNER",
              kind: "INFORMATION",
              taskIds: [...ids].sort(),
              specDigests: Object.fromEntries(ids.map((id) => [id, "v-" + id])),
            },
            answers: [],
            deferrals: [],
          },
        ],
      }),
    );
  assert.equal(scoped(["z-first", "a-second"]), scoped(["a-first", "z-second"]));
});

test("review E2 r6 U1: a failed run that recorded no runtime makes the evidence synthetic", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20 });
    freezePlan(f.db, p, "owner");
    const rv = (p.classes[0]!.finalists[0] as any).reviewer;
    const j = await journal(p, 20, {
      root: f.root,
      afterWorker: async (c, _db, t, _worker, caseNo) => {
        if (caseNo !== 5 || !t.id.endsWith("-arr-0")) return;
        const a = c.reserve(
          t.id,
          { role: "reviewer", provider: rv.provider, model: rv.modelId, effort: rv.effort, overrideReason: "evaluation harness run", requestKey: t.id + "-no-runtime" },
          c.localActor(),
        );
        const noRuntime: ProviderAdapter = {
          async execute(r) {
            const { provenance: _none, ...ok } = await adapter(false).execute(r);
            return { ...ok, status: "FAILED", exitCode: 1 };
          },
        };
        assert.equal((await c.execute(a, noRuntime, c.localActor())).status, "FAILED");
      },
    });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, true);
  } finally {
    f.close();
  }
});

test("review E2 r6 U2: a case task with Drive access is refused, its Drive content being outside its fixture", async () => {
  const f = setup();
  try {
    const taskExtra = (caseNo: number): Partial<Task> =>
      caseNo === 2
        ? {
            drive: { read: ["FOLDER0123456789"], update: [], createIn: [] },
            operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
            writePaths: ["output/case", "drive-changes"],
            dimensions: { ...demoTask("x").dimensions, authorization: "EXPLICIT" },
          }
        : {};
    // The plan's case input is the same task, so only the Drive rule refuses it.
    const p = plan({ pool: 20, taskExtra });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root, taskExtra });
    assert.throws(
      () => importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" }),
      /EVALUATION_CASE_DRIVE_UNSUPPORTED:C2/,
    );
  } finally {
    f.close();
  }
});

test("review E2 r6 U3: equal evidence records are numbered by what refers to them, not by insertion order", () => {
  const envelope = (id: string) => ({
    id,
    taskId: "t",
    kind: "LOCAL",
    uri: "local:same",
    revision: "r1",
    digest: HEX("c"),
    retrievedAt: "2026-10-29T00:00:00.000Z",
    metadata: {},
  });
  const fixture = (ids: [string, string], bound: string) =>
    digest(
      normalizedFixture({
        requests: [],
        tasks: [
          demoTask("t", {
            title: "Case task",
            writePaths: ["output/case"],
            createdAt: "2026-10-29T00:00:00.000Z",
            sources: [{ evidenceId: bound, revision: "r1", digest: HEX("c") }],
          }),
        ],
        grants: [],
        decisions: [],
        evidence: ids.map(envelope),
        scriptedAnswers: [],
      }),
    );
  // The bound record was inserted first in one case and second in the other.
  assert.equal(fixture(["e-1", "e-2"], "e-1"), fixture(["e-3", "e-4"], "e-4"));
});

test("review X1: positions distinguish equal envelopes bound by the same task and answer", () => {
  const fixture = (ids: [string, string], order: [number, number], changeSecond = false) => {
    const task = demoTask("t", {
      sources: ids.map((id) => ({ evidenceId: id, revision: "r1", digest: HEX("c") })),
      createdAt: "2026-10-29T00:00:00.000Z",
    });
    return digest(normalizedFixture({
      requests: [], tasks: [task], grants: [], decisions: [], scriptedAnswers: [],
      evidence: order.map((i) => ({
        id: ids[i], taskId: "t", kind: "LOCAL", uri: "local:same", revision: "r1",
        digest: changeSecond && i === 1 ? HEX("d") : HEX("c"), retrievedAt: String(i), metadata: {},
      })),
      questions: [{ question: { key: "sources" }, answers: [{ evidence: [...ids] }], deferrals: [] }],
    }));
  };
  assert.equal(fixture(["a", "b"], [0, 1]), fixture(["y", "z"], [1, 0]));
  assert.equal(fixture(["a", "b"], [1, 0]), fixture(["y", "z"], [0, 1]));
  assert.notEqual(fixture(["a", "b"], [0, 1]), fixture(["a", "b"], [0, 1], true));
});

test("review X1: supersession forest numbering is invariant under envelope insertion order", () => {
  const fixture = (order: number[], prefix: string, changeLeaf = false) => {
    const ids = Array.from({ length: 6 }, (_, i) => prefix + i);
    const parents = [undefined, undefined, ids[0], ids[1], ids[2], ids[3]];
    const evidence = order.map((i) => ({
      id: ids[i], taskId: "t", kind: "LOCAL", uri: "local:source", revision: "r1", digest: HEX("c"),
      ...(parents[i] ? { supersedes: parents[i] } : {}),
      ...(i === 4 || i === 5 ? { claims: [changeLeaf && i === 5 ? "Different" : "Same"] } : {}),
    }));
    return digest(normalizedFixture({
      requests: [], tasks: [demoTask("t", {
        createdAt: "2026-10-29T00:00:00.000Z",
        sources: [ids[4], ids[5]].map((id) => ({ evidenceId: id!, revision: "r1", digest: HEX("c") })),
      })], evidence, grants: [], decisions: [], scriptedAnswers: [],
    }));
  };
  const expected = fixture([0, 1, 2, 3, 4, 5], "first-");
  for (const order of [[1, 0, 2, 3, 4, 5], [5, 4, 3, 2, 1, 0], [3, 0, 5, 1, 4, 2], [2, 4, 0, 5, 3, 1]])
    assert.equal(fixture(order, "renamed-"), expected);
  assert.notEqual(fixture([0, 1, 2, 3, 4, 5], "first-", true), expected);
  assert.throws(() => normalizedFixture({
    requests: [], tasks: [], grants: [], decisions: [], scriptedAnswers: [],
    evidence: [{ id: "a", supersedes: "b" }, { id: "b", supersedes: "a" }],
  }), /EVALUATION_EVIDENCE_SUPERSESSION_CYCLE/);
});

test("review X2: frozen work-type guidance includes owner rules and matches the exact executed brief", async () => {
  const f = setup();
  try {
    const rulesFile = join(f.root, "owner-rules.md");
    writeFileSync(rulesFile, "## 1. Working rules\nPreserve the source.\n");
    const projectProfile = ProjectProfileSchema.parse({
      version: 1,
      ownerRules: { file: rulesFile, sections: ["1"] },
      kinds: { records: { title: "Records", worker: ["Copy exactly."], reviewer: ["Check every word."], proposals: false } },
    });
    const taskExtra = (): Partial<Task> => ({ kind: "records" });
    const p = plan({ pool: 20, finalists: [A1], taskExtra, projectProfile });
    freezePlan(f.db, p, "owner");
    const seen: string[] = [];
    const provider: ProviderAdapter = {
      async execute(r) {
        seen.push(r.brief);
        return adapter(false).execute(r);
      },
    };
    const unchanged = await journal(p, 20, { root: f.root, taskExtra, projectProfile, provider });
    const imported = importEvidence(f.db, buildBundle(unchanged.path, p, graded(unchanged.fixtures)), { journalPath: unchanged.path, actor: "owner" });
    assert.equal(imported.synthetic, false);
    assert.equal(imported.aggregates[0]!.decision, "QUALIFIED");
    const raw = new SqliteStore(unchanged.path);
    try {
      const guidance = raw.all<{ body: string }>("SELECT body FROM events WHERE kind='EVALUATION_RUN_GUIDANCE' ORDER BY seq");
      assert.equal(guidance.length, seen.length);
      guidance.forEach((e, i) => assert.ok(seen[i]!.includes(JSON.parse(e.body).guidance)));
    } finally { raw.close(); }
    // Fresh controllers use changed configuration, while the seeded fixture
    // and task specifications remain identical to the frozen case.
    const changed = structuredClone(projectProfile);
    changed.kinds!.records!.worker = ["Rewrite freely."];
    const different = await journal(p, 20, {
      root: f.root, taskExtra, projectProfile,
      runController: (c, t) => new Controller(c.db, { ...c.config, projectProfile: t.id.startsWith("case-1-arr") ? changed : projectProfile }),
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(different.path, p, graded(different.fixtures)), { journalPath: different.path, actor: "owner" }),
      /CASE_INPUT_MISMATCH:C1:WORK_KIND_GUIDANCE/,
    );
    // Owner-rule edits are also substantive input, not only profile text.
    const ownerChanged = await journal(p, 20, {
      root: f.root, taskExtra, projectProfile,
      before: (_c, _db, t) => { if (t.id.startsWith("case-1-arr")) writeFileSync(rulesFile, "## 1. Working rules\nInvent a source.\n"); },
      after: () => writeFileSync(rulesFile, "## 1. Working rules\nPreserve the source.\n"),
    });
    assert.throws(
      () => importEvidence(f.db, buildBundle(ownerChanged.path, p, graded(ownerChanged.fixtures)), { journalPath: ownerChanged.path, actor: "owner" }),
      /CASE_INPUT_MISMATCH:C1:WORK_KIND_GUIDANCE/,
    );
  } finally { f.close(); }
});

test("review X3: successful receipts without runtime provenance cannot qualify an unidentified live runtime", async () => {
  const f = setup();
  try {
    const unknown = { cliVersion: "unrecorded", executableDigest: null };
    const arrangement = pair(
      candidateIdentity({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh", simulation: false }, "worker", unknown),
      candidateIdentity({ provider: "claude", model: "claude-opus-5-5", effort: "high", simulation: false }, "reviewer", unknown),
    );
    const p = plan({ pool: 20, finalists: [arrangement] });
    freezePlan(f.db, p, "owner");
    const provider: ProviderAdapter = {
      async execute(r) {
        const { provenance: _unrecorded, ...receipt } = await adapter(false).execute(r);
        return receipt;
      },
    };
    const j = await journal(p, 20, { root: f.root, provider });
    const imported = importEvidence(f.db, buildBundle(j.path, p, graded(j.fixtures)), { journalPath: j.path, actor: "owner" });
    assert.equal(imported.synthetic, true);
    assert.ok(imported.aggregates[0]!.reasons.includes("SYNTHETIC: qualifies simulation tasks only"));
  } finally { f.close(); }
});

test("review Z4: simultaneous imports from independent SQLite connections cannot regrade the same executions", { timeout: 60_000 }, async () => {
  const f = setup();
  const workers: Worker[] = [];
  try {
    const p = plan({ pool: 20, finalists: [A1] });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const goodBundle = buildBundle(j.path, p, graded(j.fixtures));
    const badBundle = buildBundle(j.path, p, graded(j.fixtures, () => ({ ...good, finalCorrect: false })));
    const gate = new SharedArrayBuffer(4);
    const script = join(f.root, "concurrent-import.mjs");
    writeFileSync(script, `
      import { parentPort, workerData } from 'node:worker_threads';
      import { SqliteStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
      import { importEvidence } from ${JSON.stringify(new URL("../src/evaluation.ts", import.meta.url).href)};
      const db = new SqliteStore(workerData.db);
      const transaction = db.transaction.bind(db);
      db.transaction = (callback) => {
        db.transaction = transaction;
        parentPort.postMessage({ type: 'ready' });
        if (Atomics.wait(new Int32Array(workerData.gate), 0, 0, 15000) === 'timed-out') throw new Error('barrier timed out');
        return transaction(callback);
      };
      try {
        const result = importEvidence(db, workerData.bundle, { journalPath: workerData.journal, actor: workerData.actor });
        parentPort.postMessage({ type: 'result', evidenceId: result.evidenceId });
      } catch (error) {
        parentPort.postMessage({ type: 'result', error: String(error.message) });
      } finally { db.close(); parentPort.close(); }
    `);
    const runs = [goodBundle, badBundle].map((bundle, i) => {
      const worker = new Worker(script, {
        workerData: { db: join(f.root, "state.sqlite"), journal: j.path, bundle, gate, actor: "importer-" + i },
        execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))],
      });
      workers.push(worker);
      let readyResolve!: () => void, readyReject!: (error: Error) => void;
      let doneResolve!: (value: { evidenceId?: string; error?: string }) => void, doneReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const done = new Promise<{ evidenceId?: string; error?: string }>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
      worker.on("error", (error) => { readyReject(error); doneReject(error); });
      worker.on("message", (message) => {
        if (message.type === "ready") readyResolve();
        else if (message.type === "result") doneResolve(message);
      });
      return { ready, done };
    });
    await Promise.all(runs.map((r) => r.ready));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0, 2);
    const results = await Promise.all(runs.map((r) => r.done));
    assert.equal(results.filter((r) => r.evidenceId).length, 1, canonical(results));
    assert.equal(results.filter((r) => /^STAGE_REWRITES_CASES:C1/.test(r.error ?? "")).length, 1, canonical(results));
    const stored = importedEvidence(f.db);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.evidenceId, results.find((r) => r.evidenceId)!.evidenceId);
    assert.ok(f.db.verifyEvents());
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    f.close();
  }
});

test("review X4: a no-start marker cannot erase an already successful receipt", async () => {
  const f = setup();
  try {
    const p = plan({ pool: 20, finalists: [A1] });
    freezePlan(f.db, p, "owner");
    const j = await journal(p, 20, { root: f.root });
    const raw = new SqliteStore(j.path);
    try {
      const row = raw.get<{ id: string; task_id: string }>("SELECT id, task_id FROM attempts WHERE role='reviewer' LIMIT 1")!;
      raw.event("CANCELLED_BEFORE_START", row.task_id, { runId: row.id });
    } finally { raw.close(); }
    assert.throws(() => buildBundle(j.path, p, graded(j.fixtures)), /EVALUATION_RUN_START_CONTRADICTION/);
  } finally { f.close(); }
});

test("review X4: no-start records cannot hide launched failures or their synthetic provenance", async (context) => {
  const scenarios = [
    { marker: "CANCELLED_BEFORE_START", status: "FAILED" },
    { marker: "ATTEMPT_NOT_STARTED", status: "CANCELLED" },
    { marker: "LEASE_RECOVERED", status: "TIMED_OUT" },
    { marker: "invalid receipt notLaunched", status: "FAILED" },
  ] as const;
  for (const scenario of scenarios) await context.test(scenario.marker, async () => {
    const f = setup();
    try {
      const p = plan({ pool: 20, finalists: [A1] });
      freezePlan(f.db, p, "owner");
      let failedRunId = "";
      const j = await journal(p, 20, {
        root: f.root,
        afterWorker: async (c, _db, task, _worker, caseNo) => {
          if (caseNo !== 1) return;
          const a = c.reserve(task.id, {
            role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high",
            overrideReason: "evaluation harness run", requestKey: task.id + "-failed-without-runtime",
          }, c.localActor());
          failedRunId = a.id;
          const failed: ProviderAdapter = { async execute(r) {
            const { provenance: _none, ...receipt } = await adapter(false).execute(r);
            return { ...receipt, status: scenario.status, exitCode: 1 };
          } };
          assert.equal((await c.execute(a, failed, c.localActor())).status, scenario.status);
        },
      });
      const complete = buildBundle(j.path, p, graded(j.fixtures));
      assert.ok(complete.results[0]!.runs.reviewer.some((r) => r.runId === failedRunId));
      const recorded = f.db.rollbackOnly(() => importEvidence(f.db, complete, { journalPath: j.path, actor: "owner" }));
      assert.equal(recorded.synthetic, true, "The launched failure's missing runtime must count");
      assert.equal(importedEvidence(f.db).length, 0);
      const forged = structuredClone(complete);
      const { db, c } = controller(j.path);
      try {
        const a = JSON.parse(db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", failedRunId)!.body);
        if (scenario.marker === "CANCELLED_BEFORE_START") {
          // The original reported path: fabricate a mutable reservation,
          // then use the ordinary cancel API to append a valid-chain marker.
          db.run("UPDATE attempts SET state=?,body=? WHERE id=?", "RESERVED", canonical({ ...a, state: "RESERVED" }), a.id);
          c.cancel(a.id, c.localActor());
        } else if (scenario.marker === "invalid receipt notLaunched") {
          const row = db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", a.id)!;
          const receipt = JSON.parse(row.body);
          assert.equal(receipt.tokens, 1);
          // Deliberately fabricated owner journal, as in the other receipt
          // tampering tests: ordinary controller writes cannot do this.
          db.run("DROP TRIGGER immutable_receipts_update");
          db.run("UPDATE receipts SET body=? WHERE attempt_id=?", canonical({ ...receipt, notLaunched: true }), a.id);
        } else {
          db.event(scenario.marker, a.taskId, {
            runId: a.id,
            ...(scenario.marker === "LEASE_RECOVERED" ? { outcome: "DEFINITELY_NOT_STARTED" } : {}),
          });
        }
        assert.ok(db.verifyEvents(), "The contradiction must pass journal-chain verification");
        forged.journalHead = db.get<{ hash: string }>("SELECT hash FROM events ORDER BY seq DESC LIMIT 1")!.hash;
      } finally { db.close(); }
      for (const result of forged.results)
        result.runs.reviewer = result.runs.reviewer.filter((r) => r.runId !== failedRunId);
      const contradiction = new RegExp("^Error: EVALUATION_RUN_START_CONTRADICTION:" + failedRunId + "$");
      assert.throws(() => buildBundle(j.path, p, graded(j.fixtures)), contradiction);
      // Exercise import directly too, so harness refusal cannot hide an
      // importer that would accept the fabricated omission as live evidence.
      assert.throws(() => importEvidence(f.db, forged, { journalPath: j.path, actor: "owner" }), contradiction);
      assert.equal(importedEvidence(f.db).length, 0);
    } finally { f.close(); }
  });
});

test("review R6 X4: no-start markers cannot erase a launch intent without a receipt", async (context) => {
  for (const marker of ["CANCELLED_BEFORE_START", "ATTEMPT_NOT_STARTED", "LEASE_RECOVERED"] as const)
    for (const reconciled of [false, true]) await context.test(marker + (reconciled ? " after reconciliation" : " while UNKNOWN"), async () => {
      const f = setup();
      try {
        const p = plan({ pool: 20, finalists: [A1] });
        freezePlan(f.db, p, "owner");
        const j = await journal(p, 20, { root: f.root, provider: { async execute(r) {
          const receipt = await adapter(false).execute(r);
          // A first clean-PASS report with an invalid schema can be rejected
          // through the public API and retried on the same sealed artifact.
          return r.role === "reviewer"
            ? { ...receipt, output: canonical({ verdict: "PASS", residualHolds: [], findings: [] }) }
            : receipt;
        } } });
        const complete = buildBundle(j.path, p, graded(j.fixtures));
        const baseline = f.db.rollbackOnly(() => importEvidence(f.db, complete, { journalPath: j.path, actor: "owner" }));
        assert.equal(baseline.synthetic, false);
        assert.ok(baseline.aggregates.every((a) => a.decision === "QUALIFIED"), "The unmodified case set must qualify first");
        const forged = structuredClone(complete);
        const { db, c } = controller(j.path);
        try {
          const prior = db.get<{ id: string; task_id: string }>("SELECT id,task_id FROM attempts WHERE role='reviewer' ORDER BY rowid LIMIT 1")!;
          const taskId = prior.task_id;
          assert.equal(c.rejectReview(prior.id, c.localActor()).cleanPass, true);
          const attempt = c.reserve(taskId, {
            role: "reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high",
            overrideReason: "evaluation harness run", requestKey: taskId + "-crashed-without-receipt",
          }, c.localActor());
          const crashed: ProviderAdapter = { async execute() { throw new Error("scripted host lost provider outcome"); } };
          await assert.rejects(c.execute(attempt, crashed, c.localActor()), /scripted host lost provider outcome/);
          assert.equal(db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", attempt.id)!.state, "UNKNOWN");
          assert.ok(db.get("SELECT seq FROM events WHERE kind='PROCESS_START_INTENT' AND json_extract(body,'$.runId')=?", attempt.id));
          assert.equal(db.get("SELECT body FROM receipts WHERE attempt_id=?", attempt.id), undefined);
          if (reconciled) {
            const evidenceId = "stopped-" + attempt.id;
            c.addEvidence({
              id: evidenceId, taskId, kind: "LOCAL", uri: "local-assessment:" + attempt.id,
              revision: attempt.artifactRevision, digest: digest("Stopped with no observed provider result"),
              retrievedAt: new Date().toISOString(), authorityTier: "UNVERIFIED", authentication: "LOCAL_IMPORT",
              currentness: "CURRENT_AT_RETRIEVAL", claims: ["Reviewer stopped"],
              metadata: { runId: attempt.id, reconciliation: {
                processStopped: true, externalEffects: "NONE", assessment: "Read-only invocation stopped; its provider result was lost",
                usage: { costUsd: 0, tokens: 0 },
              } },
            }, c.localActor());
            c.reconcile(attempt.id, "FAILED", evidenceId, c.localActor());
            assert.equal(db.get<{ state: string }>("SELECT state FROM attempts WHERE id=?", attempt.id)!.state, "FAILED");
          }
          const unresolved = new RegExp("^Error: EVALUATION_RUN_UNRESOLVED:" + attempt.id + "$");
          assert.throws(() => buildBundle(j.path, p, graded(j.fixtures)), unresolved,
            "The real launched invocation without a receipt is unresolved before fabrication");
          forged.journalHead = db.get<{ hash: string }>("SELECT hash FROM events ORDER BY seq DESC LIMIT 1")!.hash;
          // An ordinary reconciliation also adds owner evidence, which the
          // case-input gate independently refuses. The UNKNOWN case reaches
          // the missing-receipt gate in both builder and importer.
          assert.throws(() => importEvidence(f.db, forged, { journalPath: j.path, actor: "owner" }),
            reconciled ? /^Error: CASE_INPUT_MISMATCH:C1$/ : unresolved);
          // An owner-fabricated but valid-chain event must not erase the
          // launch recorded by the real controller execution above.
          db.event(marker, taskId, {
            runId: attempt.id,
            ...(marker === "LEASE_RECOVERED" ? { outcome: "DEFINITELY_NOT_STARTED" } : {}),
          });
          assert.ok(db.verifyEvents());
          forged.journalHead = db.get<{ hash: string }>("SELECT hash FROM events ORDER BY seq DESC LIMIT 1")!.hash;
          const contradiction = new RegExp("^Error: EVALUATION_RUN_START_CONTRADICTION:" + attempt.id + "$");
          assert.throws(() => buildBundle(j.path, p, graded(j.fixtures)), contradiction);
          assert.throws(() => importEvidence(f.db, forged, { journalPath: j.path, actor: "owner" }), contradiction);
          assert.equal(importedEvidence(f.db).length, 0);
        } finally { db.close(); }
      } finally { f.close(); }
    });
});

test("review X5: a real historical reply across two tasks retains its different later applicability", () => {
  const fixture = (reviseABeforeQuestion: boolean) => {
    const f = setup();
    try {
      const tasks = ["A", "B"].map((id) => demoTask(id, {
        title: "Task " + id, scope: "Write greeting " + id, writePaths: ["output/" + id],
        createdAt: "2026-10-29T00:00:00.000Z",
      }));
      f.c.importTasks(tasks, f.c.localActor());
      const revise = (id: string) => {
        const t = f.c.task(id);
        f.c.revise(id, { ...t, specVersion: 2, scope: "Revised greeting " + id }, f.c.localActor());
      };
      if (reviseABeforeQuestion) revise("A");
      const o = new Orchestrator(f.c);
      const request = o.submit({
        requestKey: "matched-case", prompt: "Write both greetings", context: { cwd: f.root },
        sourceRef: "test:owner", taskIds: ["A", "B"],
      });
      const q = o.ask(request.request.id, { key: "tone", text: "Which tone?", kind: "INFORMATION", taskIds: ["A", "B"] });
      const bOriginal = specDigest(f.c.task("B"));
      revise("B");
      o.reply(request.request.id, {
        questionId: q.id, replyKey: "historical-tone", text: "Formal", sourceRef: "test:owner",
        historicalOnly: true, answeredAs: "OWNER",
      });
      if (!reviseABeforeQuestion) revise("A");
      const reply = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM events WHERE kind='WORKFLOW_REPLY'")!.body).reply;
      assert.deepEqual(reply.historicalForSpec, { B: bOriginal });
      const recorded = recordCaseFixture(f.db, {
        caseId: "C1", classKey: "general/complex", arrangementId: arrangementId(A1),
        taskIds: ["A", "B"], requestIds: [request.request.id],
      });
      const question = recorded.fixture.questions[0]!;
      assert.deepEqual(question.askedOn, [
        ["<T1>", reviseABeforeQuestion ? "<T1>.current" : "<T1>.earlier1"],
        ["<T2>", "<T2>.earlier1"],
      ]);
      assert.deepEqual(question.answers[0]!.historicalFor, [["<T2>", "<T2>.earlier1"]]);
      return recorded;
    } finally { f.close(); }
  };
  const oldA = fixture(false), currentA = fixture(true);
  assert.notEqual(oldA.fixtureDigest, currentA.fixtureDigest);
  const withoutAskedOn = (recorded: typeof oldA) => ({
    ...recorded.fixture,
    questions: recorded.fixture.questions.map(({ askedOn: _scope, ...question }) => question),
  });
  // The different binding of this ordinary multi-task reply is the only
  // normalized input difference; generated identities contribute none.
  assert.deepEqual(withoutAskedOn(oldA), withoutAskedOn(currentA));
  assert.equal(oldA.fixtureDigest, fixture(false).fixtureDigest);
  assert.equal(currentA.fixtureDigest, fixture(true).fixtureDigest);
});

test("the importer's run question keys are the orchestrator's reserved keys", () => {
  assert.deepEqual([...runQuestionKeysForTest].sort(), [...RESERVED_QUESTION_KEYS].sort());
});

test("CLI: the owner freezes a plan and lists evidence; without --execute nothing is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "adaptive-cli-"));
  try {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsx = fileURLToPath(import.meta.resolve("tsx"));
    const db = join(root, "state.sqlite");
    const planFile = join(root, "plan.json");
    const p = plan({ pool: 20 });
    writeFileSync(planFile, JSON.stringify(p));
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const run = (...args: string[]) =>
      promisify(execFile)(process.execPath, ["--import", tsx, cli, ...args, "--db", db], {
        cwd: root,
        env,
        timeout: 30_000,
      }).then((r) => JSON.parse(r.stdout));
    assert.deepEqual(await run("adaptive", "freeze-plan", "--file", planFile), {
      dryRun: true,
      action: "adaptive freeze-plan",
    });
    assert.equal((await run("adaptive", "evidence")).plans.length, 0);
    const frozen = await run("adaptive", "freeze-plan", "--file", planFile, "--execute");
    assert.equal(frozen.planId, p.id);
    const listed = await run("adaptive", "evidence");
    assert.deepEqual(
      listed.plans.map((x: any) => [x.planId, x.purpose]),
      [[p.id, "QUALIFICATION"]],
    );
    assert.equal(listed.readOnly, true);
    // A harness journal has no recorded owner; the read-only rollback check
    // still reads it, and records nothing (E5 rereview W1).
    const journalPath = join(root, "journal.sqlite");
    await run("adaptive", "harness-init", "--file", planFile, "--journal", journalPath, "--execute");
    const runOn = (path: string, ...args: string[]) =>
      promisify(execFile)(process.execPath, ["--import", tsx, cli, ...args, "--db", path], { cwd: root, env, timeout: 30_000 }).then((r) =>
        JSON.parse(r.stdout),
      );
    const check = await runOn(journalPath, "adaptive", "rollback-check");
    assert.equal(check.readOnly, true);
    assert.ok(check.adaptiveRecords > 0);
    const journal = new SqliteStore(journalPath);
    try {
      assert.equal(journal.get("SELECT value FROM settings WHERE key='owner_uid'"), undefined);
    } finally {
      journal.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
