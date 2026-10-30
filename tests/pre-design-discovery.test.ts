import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { canonical, TaskSchema, specDigest, type Task } from "../src/domain.js";
import { Orchestrator, RESERVED_QUESTION_KEYS } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { RoutingPolicySchema } from "../src/routing.js";
import {
  covers,
  oversightCurrent,
  oversightInputDigest,
  preDesignState,
  ProjectPlanSchema,
  screenCurrency,
  screeningRecords,
  type ScreeningRecord,
} from "../src/project.js";
import {
  OVERSEER_VIEW_HEADING,
  TASK_VIEW_HEADING,
} from "../src/project-view.js";
import { explainHold } from "../src/holds.js";
import {
  candidateQuestionKey,
  candidateQuestionText,
  PRE_DESIGN_QUESTION_PREFIX,
  screeningEligibility,
  staleReasons,
  type Candidate,
  type Screening,
} from "../src/screening.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";

/**
 * Pre-design decision discovery (proposal #17): the D01 to D19 scenarios of
 * docs/proposals/pre-design-decision-discovery-implementation-plan.md, on a
 * disposable SQLite database with scripted provider receipts. Every
 * assertion is about reservations, the event journal and the views, never
 * about the quality of Astra's prose: a scripted receipt proves gating and
 * provenance mechanics, not model recall.
 */
const configured = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/adaptive/two-tier-policy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const policy = () =>
  RoutingPolicySchema.parse({
    ...configured,
    routes: configured.routes.map((r: any) => ({
      ...r,
      capability: {
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        evidenceRef: "test:attested",
      },
    })),
  });

type View = any;
type Scoped = { question: string; taskIds: string[]; projectWide: boolean };
type PlanOptions = {
  outcome?: "CONTINUE" | "ASK_OWNER" | "ASK_OPERATOR" | "COMPLETE";
  assign?: string[];
  owner?: Scoped[];
  operator?: Scoped[];
  /** The screenings to return; by default a clear screening of every task that needs one. */
  screenings?: Screening[] | ((view: View) => Screening[]);
  noScreen?: boolean;
};
const SETTLED = ["VERIFIED", "ACCEPTED", "CANCELLED", "SUPERSEDED"];
const entry = (view: View, id: string) =>
  view.snapshot.tasks.find((t: any) => t.task.id === id);
const isOpen = (q: any) => !(q.answers ?? []).length && !q.deferred;
/** A clear screening of the task, as Astra would return it. */
function clear(
  view: View,
  taskId: string,
  over: Partial<Screening> = {},
): Screening {
  return {
    taskId,
    specDigest: entry(view, taskId).specDigest,
    disposition: "SCREENED_CLEAR",
    reason:
      "The owner's request and the sources settle the design; no owner choice is open.",
    sourceRefs: ["test:owner"],
    candidates: [],
    ...over,
  };
}
/** A screening with open owner choices. */
function requiresOwner(
  view: View,
  taskId: string,
  candidates: Candidate[],
): Screening {
  return clear(view, taskId, {
    disposition: "REQUIRES_OWNER",
    reason:
      "The result's visibility and failure handling are the owner's to choose.",
    candidates,
  });
}
/** An owner choice about task A, S02-style, with overrides. */
function candidate(key: string, over: Partial<Candidate> = {}): Candidate {
  return {
    key,
    type: "OWNER_REQUIRED",
    choice:
      "May the user see a mission's result before every closeout stage finishes? It decides what the first screen after a mission shows.",
    basis: "EVIDENCE",
    sourceRefs: ["doc:S02-rules#stage-11"],
    affectedTaskIds: ["A"],
    options: [
      {
        label: "Wait for closeout",
        consequences:
          "The player waits a moment longer and nothing shown can be contradicted later.",
      },
      {
        label: "Guarded early view",
        consequences:
          "The player sees a provisional result at once; later stages may add detail but never reverse it.",
      },
    ],
    recommendation:
      "Wait for closeout: simpler, and no risk of showing something the closeout then changes.",
    uncertainty: "Medium: no source says how long players will accept waiting.",
    ifPostponed: "A's design would assume one behaviour and may need rework.",
    reopenWhen:
      "A source states a different player experience for mission results.",
    decidedBy: null,
    revisesDecision: null,
    ...over,
  };
}
/** Astra's plan from its view: assign what may run, screen what needs it. */
function plan(view: View, p: PlanOptions = {}): string {
  const snap = view.snapshot;
  const settled = (t: any) => SETTLED.includes(t.task.status);
  const screenings: Screening[] =
    typeof p.screenings === "function"
      ? p.screenings(view)
      : (p.screenings ??
        (p.noScreen
          ? []
          : (view.preDesign ?? [])
              .filter(
                (s: any) =>
                  s.eligibility.required &&
                  !s.current &&
                  !settled(entry(view, s.taskId)),
              )
              .map((s: any) => clear(view, s.taskId))));
  const heldByScreen = new Set(
    screenings.flatMap((s) =>
      s.disposition === "SCREENED_CLEAR"
        ? []
        : [
            s.taskId,
            ...s.candidates
              .filter((c) => c.type === "OWNER_REQUIRED")
              .flatMap((c) => c.affectedTaskIds),
          ],
    ),
  );
  const heldByState = new Set(
    (view.preDesign ?? [])
      .filter(
        (s: any) => s.hold && !screenings.some((x) => x.taskId === s.taskId),
      )
      .map((s: any) => s.taskId),
  );
  const explicitHeld = new Set(
    [...(p.owner ?? []), ...(p.operator ?? [])].flatMap((q) => q.taskIds),
  );
  const assign =
    p.assign ??
    snap.tasks
      .filter((t: any) => !settled(t))
      .map((t: any) => t.task.id)
      .filter(
        (id: string) =>
          !snap.questions.some((q: any) => isOpen(q) && covers(q, id)) &&
          !heldByScreen.has(id) &&
          !heldByState.has(id) &&
          !explicitHeld.has(id) &&
          (entry(view, id).task.dependencies ?? []).every((d: string) =>
            ["VERIFIED", "ACCEPTED"].includes(entry(view, d)?.task.status),
          ),
      );
  const anyOpen = snap.tasks.some((t: any) => !settled(t));
  const outcome =
    p.outcome ??
    (assign.length
      ? "CONTINUE"
      : anyOpen
        ? p.operator?.length && !p.owner?.length
          ? "ASK_OPERATOR"
          : "ASK_OWNER"
        : "COMPLETE");
  return canonical({
    inputDigest: snap.inputDigest,
    summary: "Keep the modules consistent with the owner's request.",
    outcome,
    assignments: assign.map((taskId: string) => ({
      taskId,
      instruction: "Design module " + taskId + " within the recorded scope.",
    })),
    nextTaskIds: assign,
    milestones: [],
    technicalDecisions: [],
    risks: [],
    questionsForOwner: p.owner ?? [],
    questionsForOperator: p.operator ?? [],
    screenings,
  });
}
const opted = (
  policyName: "REQUIRED" | "AUTO" | "EXEMPT",
  over: Partial<Task> = {},
): Partial<Task> => ({
  preDesignDiscovery: {
    policy: policyName,
    rationale: "A substantial, interconnected module",
    sourceRef: "test:owner",
  },
  ...over,
});
type TaskSpec = Partial<Task> & { id: string };
/**
 * A two-tier project. By default: A (opted in, REQUIRED), B (not opted in)
 * and C (depends on A, not opted in). `extraTasks` are registered and
 * granted but not attached to the request (outside the project).
 */
function fixture(
  options: {
    tasks?: TaskSpec[];
    extraTasks?: TaskSpec[];
    attach?: string[];
    overseer?: (view: View, call: number) => string;
    onWorker?: (r: ProviderRequest) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pre-design-"));
  let db = new SqliteStore(join(root, "state.sqlite"));
  const requests: ProviderRequest[] = [];
  const briefs: Record<string, string> = {};
  let overseerCalls = 0;
  const adapter: ProviderAdapter = {
    async execute(r) {
      requests.push(r);
      const p = (r.outputSchema as any)?.properties;
      let output = "";
      if (r.role === "assessor")
        output = canonical({
          taskId: r.taskId,
          specDigest: p.specDigest.enum[0],
          touches: {
            driveDocuments: [],
            codePaths: [],
            domainRules: false,
            canonicalText: false,
            ownerDecision: false,
          },
          breaksIfWrong: "The module's design is wrong",
          tierHint: "COMPLEX",
          reason: "Bounded local work",
        });
      else if (r.role === "overseer") {
        const view = JSON.parse(
          r.brief.slice(
            r.brief.indexOf(OVERSEER_VIEW_HEADING) +
              OVERSEER_VIEW_HEADING.length,
          ),
        );
        output = options.overseer?.(view, overseerCalls++) ?? plan(view);
      } else if (r.role === "worker") {
        briefs[r.taskId] = r.brief;
        mkdirSync(join(r.cwd, "output", r.taskId), { recursive: true });
        writeFileSync(join(r.cwd, "output", r.taskId, "hello.txt"), "hello\n");
        options.onWorker?.(r);
        output = "Designed module " + r.taskId + ".";
      } else if (r.role === "reviewer") {
        briefs["review:" + r.taskId] = r.brief;
        const ev = p.availableEvidence.items.enum;
        output = canonical({
          taskId: r.taskId,
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: r.provider,
          authorshipDisclosure: "Independent session",
          availableEvidence: ev,
          findings: [],
          testsExecuted: [],
          testsNotExecuted: ["No executable test configured"],
          conflictingEvidence: [],
          remediation: [],
          residualHolds: [],
          verdict: "PASS",
          scope: "module design",
          nextAuthorizedStep: "bind evidence",
          auditAssessments: [
            "ACCURACY",
            "LOCAL_ANTI_DRIFT",
            "MACRO_ANTI_DRIFT",
          ].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "Matches scope",
            limitations: [],
          })),
        });
      } else throw new Error("Unexpected role " + r.role);
      return {
        runId: r.runId,
        taskId: r.taskId,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        sessionId: randomUUID(),
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: true,
        simulation: false,
      } satisfies ProviderReceipt;
    },
  };
  const make = () =>
    new Controller(db, {
      ownerUid: process.getuid!(),
      workspaceRoot: join(root, "workspaces"),
      allowRealLocalTasks: true,
      routingPolicy: policy(),
      verifyRoutingCapability: () => true,
      projectProfile: {
        version: 1,
        protectedDocuments: [],
        protectedFolders: [],
        codePaths: ["output"],
        kinds: Object.fromEntries(
          [
            "records",
            "owner-brief",
            "code",
            "mechanics",
            "engineering-design",
            "narrative",
          ].map((kind) => [
            kind,
            {
              title: kind,
              worker: ["Do the " + kind + " work within scope."],
              reviewer: ["Check the " + kind + " work against scope."],
              proposals: kind !== "records",
              expert: kind === "code" || kind === "mechanics",
            },
          ]),
        ),
      },
    });
  let c = make(),
    o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
  const id = o.submit({
    requestKey: randomUUID(),
    prompt: "Design the mission-result modules of the game",
    context: { cwd: root, projectKey: "modules" },
    sourceRef: "test:owner",
  }).request.id;
  const source = o.ownerSource(id);
  const record = (spec: TaskSpec) =>
    TaskSchema.parse({
      programme: "TEST",
      lane: "LOCAL",
      title: "Design " + spec.id,
      scope: "Design module " + spec.id,
      deliverable: "output/" + spec.id + "/hello.txt",
      specVersion: 1,
      status: "DISCOVERED",
      artifactRevision: "r1",
      createdAt: new Date().toISOString(),
      dimensions: {
        authorization: "LOCAL_ONLY",
        sourceEffectuation: "CANDIDATE",
        implementation: "NOT_STARTED",
        review: "NONE",
        release: "NOT_AUTHORIZED",
      },
      sources: [{ ...source, evidenceId: source.evidenceId + "-" + spec.id }],
      specificationAuthenticated: true,
      providers: ["claude", "codex"],
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      writePaths: ["output/" + spec.id],
      dependencies: [],
      risk: "LOW",
      reviewPolicy: {
        required: true,
        crossProvider: true,
        independentAudits: true,
      },
      acceptance: [
        { id: "design", description: "A design", evidenceKind: "LOCAL" },
      ],
      simulation: false,
      budget: {
        deadlineMs: 60_000,
        maxAttempts: 5,
        maxCostUsd: 10,
        maxTokens: 100_000,
      },
      ...spec,
    });
  const specs: TaskSpec[] = options.tasks ?? [
    { id: "A", ...opted("REQUIRED") },
    { id: "B" },
    { id: "C", dependencies: ["A"] },
  ];
  const all = [...specs, ...(options.extraTasks ?? [])].map(record);
  c.importTasks(all, c.localActor());
  const grant = (t: Task) =>
    c.grant(
      t.id,
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: t.writePaths,
        decisionText: "Design it",
        sourceRef: "test:owner",
      },
      c.localActor(),
    );
  all.forEach(grant);
  o.attach(id, options.attach ?? specs.map((s) => s.id));
  const f = {
    get c() {
      return c;
    },
    get o() {
      return o;
    },
    get db() {
      return db;
    },
    adapter,
    root,
    id,
    requests,
    briefs,
    grant,
    roles: () => requests.map((r) => r.role + ":" + r.taskId),
    overseerCalls: () => overseerCalls,
    plans: () =>
      f.db
        .all<{
          body: string;
        }>("SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT' ORDER BY seq")
        .map((r) => JSON.parse(r.body)),
    records: (taskId: string) => screeningRecords(db, taskId),
    rejected: () =>
      f.db
        .all<{
          body: string;
        }>("SELECT body FROM events WHERE kind='PROJECT_CHECKPOINT_REJECTED' ORDER BY seq")
        .map((r) => JSON.parse(r.body)),
    open: () => o.inspect(id).questions.filter((q: any) => q.status === "OPEN"),
    preDesign: (taskId: string) =>
      f.o.project(id).preDesign?.find((s) => s.taskId === taskId),
    /** Another request of the same project, binding these tasks. */
    second: (taskIds: string[]) => {
      const r2 = o.submit({
        requestKey: randomUUID(),
        prompt: "Continue the modules",
        context: { cwd: root, projectKey: "modules" },
        sourceRef: "test:owner-2",
      }).request.id;
      o.attach(r2, taskIds);
      return r2;
    },
    /** Revise a task's scope (a new specification), grant it and rebind it here. */
    revise: (taskId: string, requestId = id) => {
      const old = c.task(taskId);
      c.revise(
        taskId,
        {
          ...old,
          scope: old.scope + " (revised)",
          specVersion: old.specVersion + 1,
        },
        c.localActor(),
      );
      grant(c.task(taskId));
      o.rebind(requestId, [taskId]);
    },
    restart() {
      db.close();
      db = new SqliteStore(join(root, "state.sqlite"));
      c = make();
      o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return f;
}
const ownerReply = (questionId: string, text: string, key = randomUUID()) => ({
  questionId,
  replyKey: key,
  text,
  sourceRef: "test:owner",
});
const operatorReply = (questionId: string, key = randomUUID()) => ({
  questionId,
  replyKey: key,
  text: "The gateway log for run X is at runs/X/drive-gateway.log, sha256 ab12.",
  sourceRef: "operator:records",
  answeredAs: "OPERATOR" as const,
  evidence: ["run X", "runs/X/drive-gateway.log sha256:ab12"],
});
const seqOf = (f: ReturnType<typeof fixture>, kind: string, taskId: string) =>
  f.db.get<{ seq: number }>(
    "SELECT seq FROM events WHERE kind=? AND task_id=? ORDER BY seq LIMIT 1",
    kind,
    taskId,
  )?.seq;
/** The journal position of the task's first worker reservation. */
const workerReservedSeq = (f: ReturnType<typeof fixture>, taskId: string) =>
  f.db
    .all<{
      seq: number;
      body: string;
    }>("SELECT seq, body FROM events WHERE kind='ATTEMPT_RESERVED' AND task_id=? ORDER BY seq", taskId)
    .find((e) => JSON.parse(e.body).role === "worker")?.seq;

test("eligibility: the deterministic classifier, from the task record alone", () => {
  const base = (over: Partial<Task> = {}) =>
    TaskSchema.parse({
      ...fixtureTask("T"),
      ...over,
    });
  const cases: Array<[Partial<Task>, boolean, string[]]> = [
    [{}, false, ["NOT_CONFIGURED"]],
    [opted("EXEMPT"), false, ["POLICY_EXEMPT"]],
    [opted("REQUIRED"), true, ["POLICY_REQUIRED"]],
    // AUTO: continuing reviewed work or filing is exempt, whatever else it is.
    [
      opted("AUTO", { fixes: "A", risk: "HIGH" }),
      false,
      ["FIXES_REVIEWED_WORK"],
    ],
    [
      opted("AUTO", { kind: "records", risk: "HIGH" }),
      false,
      ["ROUTINE_FILING_OR_OWNER_PRESENTATION"],
    ],
    [
      opted("AUTO", { kind: "owner-brief" }),
      false,
      ["ROUTINE_FILING_OR_OWNER_PRESENTATION"],
    ],
    // AUTO: an unknown work type is screened rather than skipped.
    [opted("AUTO"), true, ["WORK_TYPE_UNKNOWN"]],
    [opted("AUTO", { kind: "code" }), false, ["NO_DESIGN_SIGNAL"]],
    [opted("AUTO", { kind: "mechanics" }), true, ["DESIGN_WORK_TYPE"]],
    [opted("AUTO", { kind: "engineering-design" }), true, ["DESIGN_WORK_TYPE"]],
    [opted("AUTO", { kind: "narrative" }), true, ["DESIGN_WORK_TYPE"]],
    [opted("AUTO", { kind: "code", risk: "HIGH" }), true, ["HIGH_RISK"]],
    [
      opted("AUTO", { kind: "code", decisionRequired: true }),
      true,
      ["OWNER_DECISION_REQUIRED"],
    ],
    [
      opted("AUTO", { kind: "code", dependencies: ["A"] }),
      true,
      ["CROSS_TASK_DEPENDENCY"],
    ],
    [
      opted("AUTO", { kind: "code", resources: ["ledger"] }),
      true,
      ["SHARED_RESOURCE"],
    ],
    [
      opted("AUTO", {
        kind: "code",
        complexity: {
          level: "EXPERT",
          rationale: "hard",
          sourceRef: "test:owner",
        },
      }),
      true,
      ["EXPERT_COMPLEXITY"],
    ],
    [
      opted("AUTO", {
        kind: "code",
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
        writePaths: ["output/T", "drive-changes"],
        drive: { read: "ANY", update: ["1234567890abcdef"], createIn: [] },
      }),
      true,
      ["CHANGES_EXISTING_DOCUMENTS"],
    ],
    [
      opted("AUTO", { kind: "mechanics", risk: "HIGH", dependencies: ["A"] }),
      true,
      ["DESIGN_WORK_TYPE", "HIGH_RISK", "CROSS_TASK_DEPENDENCY"],
    ],
  ];
  for (const [over, required, reasons] of cases) {
    const task = base(
      over.risk === "HIGH"
        ? {
            ...over,
            reviewPolicy: {
              required: true,
              crossProvider: true,
              independentAudits: true,
            },
          }
        : over,
    );
    const e = screeningEligibility(task);
    assert.equal(e.required, required, canonical(over));
    assert.deepEqual(e.reasons, reasons, canonical(over));
    assert.equal(e.policy, task.preDesignDiscovery?.policy ?? null);
  }
  // The opt-in is optional and changes no legacy specification digest.
  const legacy = base();
  assert.ok(!("preDesignDiscovery" in legacy));
  const { preDesignDiscovery: _p, ...stripped } = base(opted("REQUIRED"));
  assert.equal(specDigest(TaskSchema.parse(stripped)), specDigest(legacy));
  assert.notEqual(specDigest(base(opted("REQUIRED"))), specDigest(legacy));
});
function fixtureTask(id: string) {
  return {
    id,
    programme: "TEST",
    lane: "LOCAL",
    title: "Design " + id,
    scope: "Design module " + id,
    deliverable: "output/" + id + "/hello.txt",
    specVersion: 1,
    status: "DISCOVERED",
    artifactRevision: "r1",
    createdAt: "2026-10-28T00:00:00.000Z",
    dimensions: {
      authorization: "LOCAL_ONLY",
      sourceEffectuation: "CANDIDATE",
      implementation: "NOT_STARTED",
      review: "NONE",
      release: "NOT_AUTHORIZED",
    },
    sources: [],
    specificationAuthenticated: true,
    providers: ["claude", "codex"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/" + id],
    dependencies: [],
    risk: "LOW",
    reviewPolicy: {
      required: true,
      crossProvider: true,
      independentAudits: true,
    },
    acceptance: [
      { id: "design", description: "A design", evidenceKind: "LOCAL" },
    ],
    simulation: false,
    budget: {
      deadlineMs: 60_000,
      maxAttempts: 5,
      maxCostUsd: 10,
      maxTokens: 100_000,
    },
  };
}

test("question keys are stable across wording, scoped by tasks, their specifications and sources; stale reasons name what changed", () => {
  const a = candidate("result-visibility");
  const specs = { A: "s1", C: "s3" };
  const keyOf = (c: Parameters<typeof candidateQuestionKey>[0]) =>
    candidateQuestionKey(c, specs);
  // A revision of an affected task is a new question (review round 3).
  assert.notEqual(keyOf(a), candidateQuestionKey(a, { A: "s2" }));
  assert.equal(keyOf(a), candidateQuestionKey(a, { A: "s1", B: "x" }));
  assert.equal(
    keyOf(a),
    keyOf(
      candidate("result-visibility", { choice: "Reworded" }),
    ),
  );
  assert.ok(
    keyOf(a).startsWith(
      PRE_DESIGN_QUESTION_PREFIX + "result-visibility:",
    ),
  );
  assert.notEqual(
    keyOf(a),
    keyOf({ ...a, affectedTaskIds: ["A", "C"] }),
  );
  assert.notEqual(
    keyOf(a),
    keyOf({ ...a, sourceRefs: ["doc:other"] }),
  );
  assert.equal(
    keyOf({ ...a, affectedTaskIds: ["C", "A", "A"] }),
    keyOf({ ...a, affectedTaskIds: ["A", "C"] }),
  );
  const text = candidateQuestionText("A", a);
  assert.ok(
    text.startsWith("Pre-design choice for task A (result-visibility): "),
  );
  assert.ok(
    text.indexOf("Recommended:") <
      text.indexOf("Options: 1) Wait for closeout"),
  );
  assert.match(text, /2\) Guarded early view/);
  assert.match(text, /Affects: A \(these tasks wait/);
  assert.match(text, /not a grant, an acceptance or a change of scope/);
  assert.match(
    candidateQuestionText("A", { ...a, revisesDecision: "d1" }),
    /would change recorded decision d1/,
  );
  // The decision a choice would change is part of the question's identity.
  assert.notEqual(
    keyOf(a),
    keyOf({ ...a, revisesDecision: "d1" }),
  );
  assert.notEqual(
    keyOf({ ...a, revisesDecision: "d1" }),
    keyOf({ ...a, revisesDecision: "d2" }),
  );
  const now = {
    version: 1 as const,
    taskId: "A",
    spec: "s1",
    peers: [{ id: "P", why: ["SHARED_RESOURCE"], spec: "p1" }],
    decisions: [{ id: "d1", revoked: false }],
  };
  assert.deepEqual(staleReasons(now, now), []);
  assert.deepEqual(staleReasons(now, { ...now, spec: "s2" }), [
    "OWN_SPEC_CHANGED",
  ]);
  assert.deepEqual(
    staleReasons(now, { ...now, peers: [{ ...now.peers[0]!, spec: "p2" }] }),
    ["PEER_SPEC_CHANGED:P"],
  );
  assert.deepEqual(staleReasons(now, { ...now, peers: [] }), [
    "PEER_REMOVED:P",
  ]);
  assert.deepEqual(staleReasons({ ...now, peers: [] }, now), ["PEER_ADDED:P"]);
  assert.deepEqual(
    staleReasons(now, { ...now, decisions: [{ id: "d1", revoked: true }] }),
    ["OWN_DECISIONS_CHANGED"],
  );
  assert.ok(RESERVED_QUESTION_KEYS.includes(PRE_DESIGN_QUESTION_PREFIX));
  for (const code of [
    "PRE_DESIGN_SCREEN_REQUIRED:A",
    "PRE_DESIGN_SCREEN_STALE:A:PEER_SPEC_CHANGED:P",
    "PRE_DESIGN_OWNER_CHOICE_OPEN:q",
    "PRE_DESIGN_QUESTION_NOT_RECORDED:k",
    "PRE_DESIGN_EVIDENCE_REQUIRED:A",
  ])
    assert.notEqual(
      explainHold(code).means,
      explainHold("UNKNOWN_CODE").means,
      code,
    );
  assert.equal(
    explainHold("PRE_DESIGN_OWNER_CHOICE_OPEN:q").authority,
    "the owner",
  );
});

test("D01: two open owner choices on A hold A (no worker reservation) as two scoped questions while unrelated B runs and is reviewed", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility"),
                candidate("failure-handling", {
                  choice:
                    "What does the user see when a mission's closeout fails halfway?",
                  options: [
                    {
                      label: "Retry silently",
                      consequences:
                        "The player sees nothing until it succeeds.",
                    },
                    {
                      label: "Show the failure",
                      consequences:
                        "The player sees a notice and a retry button.",
                    },
                    {
                      label: "Roll back",
                      consequences: "The mission is shown as not played.",
                    },
                  ],
                  recommendation: "Show the failure: honest and recoverable.",
                }),
              ]),
            ],
          })
        : plan(view),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const roles = f.roles();
    assert.ok(!roles.includes("worker:A"), roles.join(","));
    assert.ok(!roles.includes("worker:C"), roles.join(","));
    assert.ok(
      roles.includes("worker:B") && roles.includes("reviewer:B"),
      roles.join(","),
    );
    assert.equal(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").length,
      0,
    );
    // Two distinct, durable, scoped owner questions with the controller's text.
    const open = view.questions.filter((q: any) => q.status === "OPEN");
    assert.equal(open.length, 2);
    for (const q of open) {
      assert.equal(q.audience, "OWNER");
      assert.equal(q.kind, "OWNER_DECISION");
      assert.deepEqual(q.taskIds, ["A"]);
      assert.ok(q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX), q.key);
      assert.match(
        q.text,
        /^Pre-design choice for task A \((result-visibility|failure-handling)\)/,
      );
      assert.ok(q.text.indexOf("Recommended:") < q.text.indexOf("Options:"));
    }
    assert.notEqual(open[0]!.key, open[1]!.key);
    // The screening record, in the journal before any worker on A could be reserved.
    const records = f.records("A");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.disposition, "REQUIRES_OWNER");
    assert.equal(records[0]!.by, "overseer");
    assert.equal(records[0]!.candidates.length, 2);
    assert.deepEqual(
      records[0]!.questions.map((q) => q.key).sort(),
      open.map((q: any) => q.key).sort(),
    );
    assert.equal(records[0]!.checkpointRunId, f.plans()[0]!.runId);
    // The hold, explained, and the project summary.
    const a = view.tasks.find((t: any) => t.taskId === "A")!;
    assert.ok(
      a.holds.some((h: string) =>
        h.startsWith("PRE_DESIGN_OWNER_CHOICE_OPEN:"),
      ),
      a.holds.join(","),
    );
    assert.ok(
      a.holdsExplained.some(
        (h: any) =>
          h.hold.startsWith("PRE_DESIGN_OWNER_CHOICE_OPEN") &&
          h.authority === "the owner",
      ),
    );
    assert.ok(
      view.nextSteps.some((s: string) =>
        s.includes("Pre-design decision discovery"),
      ),
    );
    const summary = (view as any).project.tasks.find(
      (t: any) => t.id === "A",
    ).preDesign;
    assert.equal(summary.disposition, "REQUIRES_OWNER");
    assert.equal(summary.current, true);
    assert.equal(
      summary.questions.filter((q: any) => q.status === "OPEN").length,
      2,
    );
    assert.equal(
      (view as any).project.tasks.find((t: any) => t.id === "B").preDesign,
      undefined,
    );
    // No decision, grant or acceptance came out of it.
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.db.all("SELECT * FROM grants").length, 3);
    // The controller refuses a direct reservation of A too, on the question.
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "bypass", projectRequestId: f.id },
          f.c.localActor(),
        ),
      /PROJECT_TASK_NOT_ASSIGNED:A|PROJECT_OWNER_QUESTION_OPEN|PRE_DESIGN_OWNER_CHOICE_OPEN/,
    );
    assert.equal(
      f.c.screeningHold("A")?.split(":")[0],
      "PRE_DESIGN_OWNER_CHOICE_OPEN",
    );
    assert.equal(f.c.screeningHold("B"), null);
  } finally {
    f.close();
  }
});

test("D02: a substantial task with no open fork gets a SCREENED_CLEAR record before its worker reservation, with no question and no extra Astra run", async () => {
  const f = fixture();
  try {
    await f.o.drive(f.id, { live: true });
    const roles = f.roles();
    assert.ok(
      roles.includes("worker:A") && roles.includes("reviewer:A"),
      roles.join(","),
    );
    assert.equal(f.o.inspect(f.id).questions.length, 0);
    const [record, ...rest] = f.records("A");
    assert.equal(rest.length, 0);
    assert.equal(record!.disposition, "SCREENED_CLEAR");
    assert.equal(record!.specDigest, specDigest(f.c.task("A")));
    assert.equal(
      record!.currency!.digest,
      screenCurrency(f.db, f.c.task("A")).digest,
    );
    assert.ok(
      seqOf(f, "PRE_DESIGN_SCREENING", "A")! < workerReservedSeq(f, "A")!,
    );
    // The same checkpoint screened and assigned: one Astra run before A's worker.
    const beforeWorker = roles.slice(0, roles.indexOf("worker:A"));
    assert.equal(
      beforeWorker.filter((r) => r.startsWith("overseer")).length,
      1,
      roles.join(","),
    );
    assert.equal(f.preDesign("A")!.current, true);
    assert.equal(f.preDesign("A")!.hold, null);
    // The worker's and reviewer's briefs carry the screening.
    const view = JSON.parse(
      f.briefs["A"]!.slice(
        f.briefs["A"]!.indexOf(TASK_VIEW_HEADING) + TASK_VIEW_HEADING.length,
      ),
    );
    assert.equal(view.preDesign.latest.disposition, "SCREENED_CLEAR");
    assert.ok(f.briefs["review:A"]!.includes('"preDesign"'));
    // B, not opted in, has no screening state anywhere.
    assert.equal(f.records("B").length, 0);
    assert.equal(f.preDesign("B"), undefined);
  } finally {
    f.close();
  }
});

test("D03: exempt work (explicit, routine filing, no design signal) runs with a durable reason, no question and no model call beyond the baseline", async () => {
  const baseline = fixture({
    tasks: [{ id: "D" }, { id: "E", kind: undefined }, { id: "F" }],
  });
  let expected: number;
  try {
    await baseline.o.drive(baseline.id, { live: true });
    expected = baseline.overseerCalls();
    assert.ok(baseline.roles().includes("worker:F"));
  } finally {
    baseline.close();
  }
  const f = fixture({
    tasks: [
      { id: "D", ...opted("EXEMPT") },
      { id: "E", ...opted("AUTO", { kind: "records" }) },
      { id: "F", ...opted("AUTO", { kind: "code" }) },
    ],
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.overseerCalls(), expected);
    assert.equal(f.o.inspect(f.id).questions.length, 0);
    for (const [id, reason] of [
      ["D", "POLICY_EXEMPT"],
      ["E", "ROUTINE_FILING_OR_OWNER_PRESENTATION"],
      ["F", "NO_DESIGN_SIGNAL"],
    ] as const) {
      assert.ok(f.roles().includes("worker:" + id), id);
      const records = f.records(id);
      assert.equal(records.length, 1, id);
      assert.equal(records[0]!.disposition, "EXEMPT");
      assert.equal(records[0]!.by, "controller");
      assert.deepEqual(records[0]!.eligibility.reasons, [reason]);
      assert.ok(
        seqOf(f, "PRE_DESIGN_SCREENING", id)! < workerReservedSeq(f, id)!,
      );
      assert.equal(f.preDesign(id)!.hold, null);
    }
    assert.ok(f.plans().every((p) => p.plan.screenings.length === 0));
  } finally {
    f.close();
  }
  // Astra cannot screen an exempt task: the checkpoint is rejected.
  const g = fixture({
    tasks: [{ id: "D", ...opted("EXEMPT") }],
    overseer: (view) => plan(view, { screenings: [clear(view, "D")] }),
  });
  try {
    await g.o.drive(g.id, { live: true });
    assert.ok(!g.roles().includes("worker:D"));
    assert.match(g.rejected()[0]!.reason, /OVERSEER_SCREENING_NOT_REQUIRED:D/);
    assert.equal(g.records("D").length, 0);
  } finally {
    g.close();
  }
});

test("D04: a recorded decision is reused as ALREADY_DECIDED with its provenance; a choice that would change it says so, and an invented reference is rejected", async () => {
  const f = fixture({
    overseer: (view, call) =>
      plan(view, {
        screenings:
          call === 0
            ? [
                clear(view, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: "d-visibility",
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ]
            : undefined,
      }),
  });
  try {
    f.c.decide(
      "A",
      {
        id: "d-visibility",
        text: "The player waits for closeout",
        sourceRef: "test:owner",
        alternatives: ["guarded early view"],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"));
    assert.equal(f.o.inspect(f.id).questions.length, 0);
    const record = f.records("A")[0]!;
    assert.equal(record.disposition, "SCREENED_CLEAR");
    assert.equal(record.candidates[0]!.decidedBy, "d-visibility");
    // The worker sees the settled choice and its provenance.
    assert.ok(f.briefs["A"]!.includes("d-visibility"));
  } finally {
    f.close();
  }
  // A choice that would revise the decision: the question says so; the
  // answer changes neither the decision record nor the specification.
  const g = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", {
                  revisesDecision: "d-visibility",
                }),
              ]),
            ],
          })
        : plan(view),
  });
  try {
    g.c.decide(
      "A",
      {
        id: "d-visibility",
        text: "The player waits for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      g.c.localActor(),
    );
    const view = await g.o.drive(g.id, { live: true });
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    assert.match(q.text, /would change recorded decision d-visibility/);
    const spec = specDigest(g.c.task("A"));
    g.o.reply(g.id, ownerReply(q.id, "Guarded early view"));
    assert.equal(g.db.all("SELECT * FROM decisions").length, 1);
    assert.equal(g.db.all("SELECT * FROM decision_revocations").length, 0);
    assert.equal(specDigest(g.c.task("A")), spec);
  } finally {
    g.close();
  }
  for (const [name, decidedBy] of [
    ["an invented decision", "d-never-recorded"],
    ["no reference at all", null],
  ] as const) {
    const h = fixture({
      overseer: (view) =>
        plan(view, {
          screenings: [
            clear(view, "A", {
              candidates: [
                candidate("result-visibility", {
                  type: "ALREADY_DECIDED",
                  decidedBy,
                  options: [],
                  recommendation: null,
                }),
              ],
            }),
          ],
        }),
    });
    try {
      await h.o.drive(h.id, { live: true });
      assert.ok(!h.roles().includes("worker:A"), name);
      assert.equal(h.records("A").length, 0, name);
      assert.match(
        h.rejected()[0]!.reason,
        /OVERSEER_CANDIDATE_DECISION_UNKNOWN:result-visibility/,
        name,
      );
    } finally {
      h.close();
    }
  }
});

test("D05: the operator cannot answer an owner choice; a factual operator answer grants nothing and the worker still waits for the owner", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
            operator: [
              {
                question: "Is A's earlier run still held?",
                taskIds: ["A"],
                projectWide: false,
              },
            ],
          })
        : plan(view),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const owner = view.questions.find((q: any) => q.audience === "OWNER")!,
      operator = view.questions.find((q: any) => q.audience === "OPERATOR")!;
    assert.throws(
      () => f.o.reply(f.id, operatorReply(owner.id)),
      /OPERATOR_CANNOT_ANSWER_OWNER_QUESTION/,
    );
    f.o.reply(f.id, operatorReply(operator.id));
    view = await f.o.drive(f.id, { live: true });
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(
      view.tasks
        .find((t: any) => t.taskId === "A")!
        .holds.some((h: string) =>
          h.startsWith("PRE_DESIGN_OWNER_CHOICE_OPEN"),
        ),
    );
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.db.all("SELECT * FROM grants").length, 3);
    // The owner's answer settles it: the next checkpoint assigns A on the
    // same screening (the answer stales nothing), and the worker's brief
    // carries the answer whole beside the screening's candidates.
    f.o.reply(f.id, ownerReply(owner.id, "Wait for closeout"));
    assert.equal(f.preDesign("A")!.hold, null);
    assert.equal(f.preDesign("A")!.current, true);
    view = await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.equal(f.records("A").length, 1, "no screening again for an answer");
    const brief = JSON.parse(
      f.briefs["A"]!.slice(
        f.briefs["A"]!.indexOf(TASK_VIEW_HEADING) + TASK_VIEW_HEADING.length,
      ),
    );
    assert.equal(brief.ownerQuestions[0].answers[0].text, "Wait for closeout");
    assert.equal(brief.preDesign.latest.candidates[0].key, "result-visibility");
    assert.equal(brief.preDesign.questions[0].status, "ANSWERED");
  } finally {
    f.close();
  }
});

test("D06: a choice scoped to A and its dependent C holds both, B advances, and another request binding C cannot run it either", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "C"] }),
              ]),
            ],
          })
        : plan(view),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    assert.deepEqual(q.taskIds, ["A", "C"]);
    assert.ok(
      f.roles().includes("reviewer:B") &&
        !f.roles().includes("worker:A") &&
        !f.roles().includes("worker:C"),
    );
    for (const id of ["A", "C"])
      assert.throws(
        () =>
          f.c.reserve(
            id,
            { requestKey: "bypass-" + id, projectRequestId: f.id },
            f.c.localActor(),
          ),
        /PROJECT_TASK_NOT_ASSIGNED|PROJECT_OWNER_QUESTION_OPEN|TASK_BLOCKED/,
      );
    const r2 = f.second(["C"]);
    const before = f.requests.length;
    const other = await f.o.drive(r2, { live: true });
    assert.ok(!f.roles().includes("worker:C"));
    assert.ok(
      other.tasks[0]!.holds.some((h: string) =>
        h.startsWith("PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST:" + q.id),
      ),
      other.tasks[0]!.holds.join(","),
    );
    assert.ok(
      f.requests.length - before <= 1,
      "at most Astra's own checkpoint for the new request",
    );
  } finally {
    f.close();
  }
});

test("D07/D17: an invalid screening, or an assignment without one, rejects the whole checkpoint: no record, no question, no worker, and a hold that says why", async () => {
  const cases: Array<[string, (view: View) => string, RegExp]> = [
    [
      "unknown task",
      (v) => plan(v, { screenings: [clear(v, "A", { taskId: "Z" })] }),
      /OVERSEER_UNKNOWN_TASK/,
    ],
    [
      "duplicate candidate key",
      (v) =>
        plan(v, {
          screenings: [requiresOwner(v, "A", [candidate("k"), candidate("k")])],
        }),
      /OVERSEER_DUPLICATE_CANDIDATE:k/,
    ],
    [
      "an owner choice with one option",
      (v) =>
        plan(v, {
          screenings: [
            requiresOwner(v, "A", [
              candidate("k", { options: [candidate("k").options[0]!] }),
            ]),
          ],
        }),
      /OVERSEER_CANDIDATE_OPTIONS_REQUIRED:k/,
    ],
    [
      "an owner choice without a recommendation",
      (v) =>
        plan(v, {
          screenings: [
            requiresOwner(v, "A", [candidate("k", { recommendation: null })]),
          ],
        }),
      /OVERSEER_CANDIDATE_OPTIONS_REQUIRED:k/,
    ],
    [
      "a stale specification digest",
      (v) =>
        plan(v, {
          screenings: [clear(v, "A", { specDigest: "0".repeat(64) })],
        }),
      /OVERSEER_SCREENING_SPEC_MISMATCH:A/,
    ],
    [
      "a disposition that contradicts the candidates",
      (v) =>
        plan(v, {
          screenings: [clear(v, "A", { candidates: [candidate("k")] })],
        }),
      /OVERSEER_SCREENING_DISPOSITION_MISMATCH:A:REQUIRES_OWNER/,
    ],
    [
      "a candidate whose scope leaves out the screened task",
      (v) =>
        plan(v, {
          screenings: [
            requiresOwner(v, "A", [candidate("k", { affectedTaskIds: ["B"] })]),
          ],
        }),
      /OVERSEER_CANDIDATE_SCOPE_EXCLUDES_TASK:k/,
    ],
    [
      "a screening of a task not opted in",
      (v) => plan(v, { screenings: [clear(v, "A"), clear(v, "B")] }),
      /OVERSEER_SCREENING_NOT_REQUIRED:B/,
    ],
    [
      "two screenings of one task",
      (v) => plan(v, { screenings: [clear(v, "A"), clear(v, "A")] }),
      /OVERSEER_DUPLICATE_SCREENING:A/,
    ],
    [
      "an assignment of A without its screening",
      (v) => plan(v, { noScreen: true, assign: ["A", "B"] }),
      /OVERSEER_SCREEN_REQUIRED:A/,
    ],
    [
      "an assignment of A beside its open owner choice",
      (v) =>
        plan(v, {
          screenings: [requiresOwner(v, "A", [candidate("k")])],
          assign: ["A", "B"],
        }),
      /OVERSEER_ASSIGNED_TASK_HAS_QUESTION/,
    ],
    [
      "an evidence hold with nobody asked for the evidence",
      (v) =>
        plan(v, {
          screenings: [
            clear(v, "A", {
              disposition: "BLOCKED_ON_EVIDENCE",
              candidates: [
                candidate("k", {
                  type: "EVIDENCE_BLOCKED",
                  options: [],
                  recommendation: null,
                }),
              ],
            }),
          ],
        }),
      /OVERSEER_EVIDENCE_HOLD_REQUIRES_QUESTION:A/,
    ],
    [
      "a decision reference on a candidate that is not ALREADY_DECIDED",
      (v) =>
        plan(v, {
          screenings: [
            requiresOwner(v, "A", [candidate("k", { decidedBy: "x" })]),
          ],
        }),
      /OVERSEER_CANDIDATE_DECIDED_BY_MISPLACED:k/,
    ],
    [
      "a screening that is not valid JSON for the schema",
      (v) =>
        plan(v, {
          screenings: [{ ...clear(v, "A"), disposition: "EXEMPT" as any }],
        }),
      /ZodError|invalid|Invalid/i,
    ],
  ];
  for (const [name, overseer, reason] of cases) {
    const f = fixture({ overseer });
    try {
      const view = await f.o.drive(f.id, { live: true });
      assert.ok(
        !f.roles().some((r) => r.startsWith("worker")),
        name + ": " + f.roles().join(","),
      );
      assert.equal(f.plans().length, 0, name);
      assert.equal(f.records("A").length, 0, name);
      assert.equal(view.questions.length, 0, name);
      assert.match(f.rejected()[0]!.reason, reason, name);
      const a = view.tasks.find((t: any) => t.taskId === "A")!;
      assert.ok(
        a.holds.some((h: string) => h.startsWith("PROJECT_OVERSIGHT_HELD:")),
        name + ": " + a.holds.join(","),
      );
      assert.ok(
        a.holds.some((h: string) =>
          h.startsWith("PRE_DESIGN_SCREEN_REQUIRED:A"),
        ),
        name + ": " + a.holds.join(","),
      );
    } finally {
      f.close();
    }
  }
});

test("D08: a checkpoint delivered after a crash between receipt and persistence, or advanced twice, records one screening and one question set", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    const actor = f.c.localActor();
    // The assessment first (the snapshot includes it), then Astra's run,
    // whose receipt commits; the process dies before the checkpoint.
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "manual-assess" },
      actor,
    );
    assert.equal(
      (await f.c.execute(assessor, f.adapter, actor)).status,
      "SUCCEEDED",
    );
    const overseer = f.c.reserve(
      "A",
      {
        role: "overseer",
        projectRequestId: f.id,
        requestKey: "manual-oversight",
      },
      actor,
    );
    assert.equal(
      (await f.c.execute(overseer, f.adapter, actor)).status,
      "SUCCEEDED",
    );
    assert.equal(f.o.project(f.id).previous, undefined);
    assert.equal(f.records("A").length, 0);
    f.restart();
    await f.o.drive(f.id, { live: true });
    // The first checkpoint came from the saved receipt; no second Astra run
    // was made for the same input (later checkpoints follow B's assessment
    // and work, new inputs).
    assert.equal(f.plans()[0]!.runId, overseer.id, canonical(f.rejected()));
    assert.equal(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "overseer")
        .length,
      1,
    );
    assert.equal(f.records("A").length, 1);
    assert.equal(f.open().length, 1);
    const calls = f.overseerCalls(),
      events = f.db.all("SELECT seq FROM events").length;
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.open().length, 1);
    assert.equal(f.overseerCalls(), calls, "nothing to plan again");
    assert.equal(
      f.db.all("SELECT seq FROM events").length,
      events,
      "nothing recorded again",
    );
    assert.ok(!f.roles().includes("worker:A"));
    // The recorded checkpoint is not recorded twice from its receipt.
    const context = f.o.project(f.id);
    assert.throws(
      () =>
        f.c.recordProjectCheckpoint(
          context,
          overseer.id,
          JSON.parse(
            f.db.get<{ body: string }>(
              "SELECT body FROM receipts WHERE attempt_id=?",
              overseer.id,
            )!.body,
          ).output,
        ),
      /OVERSEER_RECEIPT_REQUIRED|PROJECT_CHECKPOINT_CHANGED|PROJECT_CONTEXT_CHANGED/,
    );
  } finally {
    f.close();
  }
});

test("D09: restart and a fresh request keep the screening, its questions, the owner's answer and the task bindings; another project is isolated", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    await f.o.drive(f.id, { live: true });
    f.restart();
    let view = f.o.inspect(f.id);
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    assert.ok(q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX));
    assert.equal(
      f.preDesign("A")!.latest!.candidates[0]!.key,
      "result-visibility",
    );
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_OWNER_CHOICE_OPEN:" + q.id,
    );
    // A fresh request of the same project sees the same state.
    const r2 = f.second(["A"]);
    const other = f.o.inspect(r2);
    assert.ok(
      other.tasks[0]!.holds.some(
        (h: string) => h === "PRE_DESIGN_OWNER_CHOICE_OPEN:" + q.id,
      ),
    );
    assert.equal(
      f.o.project(r2).preDesign?.find((s) => s.taskId === "A")?.latest
        ?.candidates[0]?.key,
      "result-visibility",
    );
    // An unrelated project has none of it.
    const unrelated = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Unrelated",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:other",
    }).request.id;
    assert.equal(f.o.project(unrelated).preDesign, undefined);
    assert.equal(f.o.inspect(unrelated).questions.length, 0);
    // The answer survives a restart too, and the work then runs.
    f.o.reply(f.id, ownerReply(q.id, "Wait for closeout"));
    f.restart();
    assert.equal(f.preDesign("A")!.questions[0]!.status, "ANSWERED");
    view = await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.equal(f.records("A").length, 1);
  } finally {
    f.close();
  }
});

test("D10: a revision stales only the revised task's screening; a decision revocation stales the screening that rested on it; history stays intact", async () => {
  // Astra assigns B first, so A is screened but not yet worked when it is revised.
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "B", ...opted("REQUIRED") },
    ],
    overseer: (view, call) =>
      call === 0 ? plan(view, { assign: ["B"] }) : plan(view),
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("B").length, 1);
    const events = f.db.all("SELECT seq FROM events").length;
    f.revise("A");
    assert.equal(f.preDesign("A")!.hold, "PRE_DESIGN_SCREEN_REQUIRED:A");
    assert.deepEqual(f.preDesign("A")!.stale, [
      "NO_SCREENING_FOR_SPECIFICATION",
    ]);
    assert.equal(f.preDesign("B")!.current, true, "B's screening is untouched");
    assert.equal(
      f.records("A").length,
      1,
      "the old record is history, not rewritten",
    );
    assert.ok(f.db.all("SELECT seq FROM events").length > events);
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "stale", projectRequestId: f.id },
          f.c.localActor(),
        ),
      /PROJECT_OVERSIGHT_REQUIRED|PROJECT_TASK_NOT_ASSIGNED|PRE_DESIGN_SCREEN_REQUIRED:A/,
    );
    const calls = f.overseerCalls();
    await f.o.drive(f.id, { live: true });
    assert.ok(f.overseerCalls() > calls);
    assert.equal(f.records("A").length, 2);
    assert.equal(f.records("A")[1]!.specDigest, specDigest(f.c.task("A")));
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
  const g = fixture({
    overseer: (view, call) =>
      plan(view, {
        assign: call === 0 ? ["B"] : undefined,
        screenings:
          call === 0
            ? [
                clear(view, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: "d1",
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ]
            : undefined,
      }),
  });
  try {
    g.c.decide(
      "A",
      {
        id: "d1",
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      g.c.localActor(),
    );
    await g.o.drive(g.id, { live: true });
    assert.equal(g.preDesign("A")!.current, true);
    g.c.revoke("d1", "withdrawn", g.c.localActor());
    assert.equal(
      g.preDesign("A")!.hold,
      "PRE_DESIGN_SCREEN_STALE:A:OWN_DECISIONS_CHANGED,CITED_DECISION_REVOKED:d1",
    );
    assert.equal(oversightCurrent(g.o.project(g.id)), false);
    assert.throws(
      () =>
        g.c.reserve(
          "A",
          { requestKey: "stale", projectRequestId: g.id },
          g.c.localActor(),
        ),
      /PRE_DESIGN_SCREEN_STALE:A:OWN_DECISIONS_CHANGED|PROJECT_OVERSIGHT_REQUIRED|PROJECT_TASK_NOT_ASSIGNED/,
    );
    await g.o.drive(g.id, { live: true });
    assert.equal(g.records("A").length, 2);
    assert.equal(g.records("A")[1]!.disposition, "SCREENED_CLEAR");
    assert.ok(g.roles().includes("worker:A"), g.roles().join(","));
  } finally {
    g.close();
  }
});

test("D11: a later checkpoint can raise a new owner choice on a task not yet designed, without touching the earlier screening or its work", async () => {
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "C", dependencies: ["A"], ...opted("REQUIRED") },
    ],
    overseer: (view, call) =>
      call === 0
        ? plan(view, { screenings: [clear(view, "A")] })
        : plan(view, {
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "C")?.current
                ? []
                : [
                    requiresOwner(v, "C", [
                      candidate("retry-policy", {
                        affectedTaskIds: ["C"],
                        choice:
                          "May a failed closeout be retried automatically?",
                      }),
                    ]),
                  ],
          }),
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("reviewer:A"));
    await f.o.drive(f.id, { live: true });
    const q = f.open().find((x: any) => x.taskIds?.includes("C"));
    assert.ok(q, canonical(f.o.inspect(f.id).questions));
    assert.match(q!.text, /retry-policy/);
    assert.equal(
      f.records("A").length,
      1,
      "A's screening is history, untouched",
    );
    assert.equal(f.records("C").length, 1);
    assert.ok(!f.roles().includes("worker:C"));
    assert.equal(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").length,
      1,
    );
  } finally {
    f.close();
  }
});

test("D12: a malformed screening on both allowed Astra runs leaves an explicit hold, bounded attempts, no record and no worker", async () => {
  // One task, so no later assessment changes the project input the bound
  // of two Astra runs is counted against.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }],
    overseer: (view) =>
      plan(view, {
        screenings: [clear(view, "A", { specDigest: "0".repeat(64) })],
      }),
  });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.equal(f.overseerCalls(), 2);
    assert.equal(f.rejected().length, 2);
    assert.equal(f.records("A").length, 0);
    assert.ok(!f.roles().some((r) => r.startsWith("worker")));
    const view = f.o.inspect(f.id);
    assert.equal(view.status, "HELD");
    assert.ok(
      view.tasks[0]!.holds.some((h: string) =>
        /PROJECT_OVERSIGHT_HELD:.*(ATTEMPTS_EXHAUSTED|SPEC_MISMATCH)/.test(h),
      ),
      view.tasks[0]!.holds.join(","),
    );
  } finally {
    f.close();
  }
});

test("D13: the same choice listed identically on two tasks is one question; a different key, or a different scope, is another; a repeated screening asks nothing twice", async () => {
  const shared = (over: Partial<Candidate> = {}) =>
    candidate("result-visibility", { affectedTaskIds: ["A", "E"], ...over });
  const current = (v: View, id: string) =>
    v.preDesign.find((s: any) => s.taskId === id).current;
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "E", ...opted("REQUIRED") },
      { id: "G", ...opted("REQUIRED") },
    ],
    overseer: (view) =>
      plan(view, {
        screenings: (v) => [
          ...(current(v, "A") ? [] : [requiresOwner(v, "A", [shared()])]),
          ...(current(v, "E")
            ? []
            : [
                requiresOwner(v, "E", [
                  // An identical copy of A's choice; a copy with other
                  // content is another choice and is rejected (review P1).
                  shared(),
                  candidate("result-visibility-of-failures", {
                    affectedTaskIds: ["E"],
                    choice:
                      "May the user see the result of a failed mission early?",
                  }),
                ]),
              ]),
          // The same key as A's and E's choice, but another scope and other sources.
          ...(current(v, "G")
            ? []
            : [
                requiresOwner(v, "G", [
                  candidate("result-visibility", {
                    affectedTaskIds: ["G"],
                    sourceRefs: ["doc:G-rules"],
                  }),
                ]),
              ]),
        ],
      }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const open = view.questions.filter((q: any) => q.status === "OPEN");
    assert.equal(open.length, 3, canonical(open.map((q: any) => q.key)));
    const same = open.find((q: any) => q.taskIds?.length === 2)!;
    assert.deepEqual(same.taskIds, ["A", "E"]);
    assert.equal(f.records("A")[0]!.questions[0]!.key, same.key);
    assert.equal(f.records("E")[0]!.questions[0]!.key, same.key);
    assert.notEqual(
      f.records("G")[0]!.questions[0]!.key,
      same.key,
      "same key, different scope and sources",
    );
    assert.ok(
      open.every((q: any) =>
        q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX + "result-visibility"),
      ),
    );
    // The owner answers the shared choice: A's screening is settled, E and G
    // still wait on their own choices; Astra's re-plan repeats nothing.
    f.o.reply(f.id, ownerReply(same.id, "Wait for closeout"));
    view = await f.o.drive(f.id, { live: true });
    assert.equal(
      view.questions.filter((q: any) => q.status === "OPEN").length,
      2,
    );
    assert.equal(view.questions.length, 3, "no question asked twice");
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(
      !f.roles().includes("worker:E") && !f.roles().includes("worker:G"),
      f.roles().join(","),
    );
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("E").length, 1);
  } finally {
    f.close();
  }
});

test("D14: the owner's answer alone starts no altered work: the recorded specification runs with the answer as context; a revision needs its grant and rebind, then a fresh screening that may cite the answer", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view, {
            screenings: (v) => {
              const state = v.preDesign.find((s: any) => s.taskId === "A");
              if (state.current) return [];
              const answered = v.snapshot.questions.find(
                (q: any) =>
                  q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX) && !isOpen(q),
              );
              return [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: answered.id,
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ];
            },
          }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    const spec = specDigest(f.c.task("A"));
    f.o.reply(f.id, ownerReply(q.id, "Guarded early view"));
    assert.equal(specDigest(f.c.task("A")), spec);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.db.all("SELECT * FROM grants").length, 3);
    // The host decides the answer changes the work: revise, grant, rebind.
    assert.throws(() => f.o.rebind(f.id, ["A"]), /REBIND_NOT_NEEDED/);
    f.revise("A");
    assert.equal(f.preDesign("A")!.hold, "PRE_DESIGN_SCREEN_REQUIRED:A");
    view = await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    const records = f.records("A");
    assert.equal(records.length, 2);
    assert.equal(records[1]!.specDigest, specDigest(f.c.task("A")));
    assert.equal(records[1]!.candidates[0]!.decidedBy, q.id);
    assert.equal(
      f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").length,
      1,
    );
    assert.equal(
      f.c.inspect("A").attempts.find((a: any) => a.role === "worker")
        .specDigest,
      specDigest(f.c.task("A")),
    );
  } finally {
    f.close();
  }
});

test("D15: legacy records: a plan without screenings parses, a project without opted-in tasks records nothing new, and old holds and questions keep their meaning", async () => {
  const legacy = ProjectPlanSchema.parse({
    inputDigest: "x",
    summary: "old",
    outcome: "CONTINUE",
    assignments: [{ taskId: "A", instruction: "do" }],
    nextTaskIds: ["A"],
    milestones: [],
    technicalDecisions: [],
    risks: [],
    questionsForOwner: [],
    questionsForOperator: [],
  });
  assert.deepEqual(legacy.screenings, []);
  const f = fixture({
    tasks: [{ id: "A" }, { id: "B" }],
    overseer: (view) => {
      const p = JSON.parse(plan(view));
      delete p.screenings;
      return canonical(p);
    },
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.ok(
      f.roles().includes("reviewer:A") && f.roles().includes("reviewer:B"),
    );
    assert.equal(
      f.db.all("SELECT seq FROM events WHERE kind='PRE_DESIGN_SCREENING'")
        .length,
      0,
    );
    assert.equal(f.o.project(f.id).preDesign, undefined);
    assert.ok(
      view.tasks.every(
        (t: any) => !t.holds.some((h: string) => h.startsWith("PRE_DESIGN_")),
      ),
    );
    assert.ok(view.tasks.every((t: any) => !("preDesign" in t)));
    assert.ok(!f.briefs["A"]!.includes('"preDesign"'));
    assert.ok(
      !f.requests
        .find((r) => r.role === "overseer")!
        .brief.includes("PRE-DESIGN DECISION DISCOVERY"),
    );
  } finally {
    f.close();
  }
});

test("D16: a pre-design question cannot be deferred, and a deferred optional question on the task clears no owner choice", async () => {
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    assert.throws(
      () =>
        f.o.deferQuestion(f.id, {
          questionId: q.id,
          questionText: q.text,
          ownerInstruction: "skip it",
          reason: "optional",
          sourceRef: "test:owner",
        }),
      /QUESTION_DEFERRAL_NOT_OPTIONAL_INFORMATION/,
    );
    const info = f.o.ask(f.id, {
      key: "nice-to-have",
      text: "Any colour preference for the result screen?",
      kind: "INFORMATION",
      taskIds: ["A"],
    });
    f.o.deferQuestion(f.id, {
      questionId: info.id,
      questionText: info.text,
      ownerInstruction: "not needed now",
      reason: "optional follow-up",
      sourceRef: "test:owner",
    });
    await f.o.drive(f.id, { live: true });
    assert.ok(!f.roles().includes("worker:A"));
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_OWNER_CHOICE_OPEN:" + q.id,
    );
  } finally {
    f.close();
  }
});

test("D17/D18/D19: a related task outside the project changing after the screening stales it in the admission transaction and brings Astra back; unrelated changes and journaled questions stale nothing", async () => {
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) },
      { id: "B" },
    ],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
    overseer: (view, call) =>
      call === 0 ? plan(view, { assign: ["B"] }) : plan(view),
  });
  try {
    await f.o.drive(f.id, { live: true });
    const record = f.records("A")[0]!;
    assert.deepEqual(
      record.currency!.inputs.peers.map((p) => [p.id, p.why]),
      [["P", ["SHARED_RESOURCE"]]],
    );
    assert.equal(f.preDesign("A")!.current, true);
    // D19: a question journaled, B finished (its status changed) and a
    // decision on B: none of it stales A's screening.
    const op = f.o.ask(f.id, {
      key: "where-is-b",
      text: "Where is B's file?",
      kind: "INFORMATION",
      audience: "OPERATOR",
      taskIds: ["B"],
    });
    f.o.reply(f.id, operatorReply(op.id));
    assert.equal(f.preDesign("A")!.current, true);
    assert.equal(f.preDesign("A")!.currency.digest, record.currency!.digest);
    // D18: a peer outside the project is revised between the screening and
    // the reservation; the snapshot is unchanged, so only the task-scoped
    // currency can catch it, and it does, inside the reservation.
    const p = f.c.task("P");
    f.c.revise(
      "P",
      { ...p, scope: p.scope + " (revised)", specVersion: 2 },
      f.c.localActor(),
    );
    const state = f.preDesign("A")!;
    assert.equal(state.hold, "PRE_DESIGN_SCREEN_STALE:A:PEER_SPEC_CHANGED:P");
    assert.equal(oversightCurrent(f.o.project(f.id)), false);
    const calls = f.overseerCalls();
    const before = f.plans().length;
    await f.o.drive(f.id, { live: true });
    // D17: Astra ran again rather than its recorded receipt being replayed
    // (the closing checkpoint after A's work is another run), screened A
    // anew, and only then was A's worker admitted.
    assert.ok(f.overseerCalls() > calls);
    assert.ok(f.plans().length > before);
    assert.equal(f.plans()[before]!.plan.screenings[0]?.taskId, "A");
    assert.equal(f.records("A").length, 2);
    assert.equal(
      f.records("A")[1]!.currency!.inputs.peers[0]!.spec,
      specDigest(f.c.task("P")),
    );
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(
      workerReservedSeq(f, "A")! >
        f.db.get<{ seq: number }>(
          "SELECT seq FROM events WHERE kind='PRE_DESIGN_SCREENING' AND task_id='A' ORDER BY seq DESC LIMIT 1",
        )!.seq,
    );
  } finally {
    f.close();
  }
  // The reservation itself refuses a stale screening, whatever the caller.
  const g = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) }],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
    overseer: (view) =>
      plan(view, {
        assign: [],
        outcome: "ASK_OWNER",
        owner: [
          {
            question: "Which theme? 1) Dark (Recommended). 2) Light.",
            taskIds: ["A"],
            projectWide: false,
          },
        ],
      }),
  });
  try {
    await g.o.drive(g.id, { live: true });
    assert.equal(g.records("A").length, 1);
    const p = g.c.task("P");
    g.c.revise(
      "P",
      { ...p, scope: p.scope + " (revised)", specVersion: 2 },
      g.c.localActor(),
    );
    assert.throws(
      () =>
        g.c.reserve(
          "A",
          { requestKey: "direct", projectRequestId: g.id },
          g.c.localActor(),
        ),
      /PRE_DESIGN_SCREEN_STALE:A:PEER_SPEC_CHANGED:P|PROJECT_OVERSIGHT_REQUIRED|PROJECT_TASK_NOT_ASSIGNED|PROJECT_OWNER_QUESTION_OPEN/,
    );
    // A direct state check, with and without the project's questions.
    assert.equal(
      preDesignState(g.db, g.c.task("A"), g.o.project(g.id).snapshot.questions)
        .hold,
      "PRE_DESIGN_SCREEN_STALE:A:PEER_SPEC_CHANGED:P",
    );
  } finally {
    g.close();
  }
});

test("outside a two-tier project an opted-in task that needs a screening is held, and a reply cannot carry authority anywhere", () => {
  const root = mkdtempSync(join(tmpdir(), "pre-design-plain-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  try {
    const c = new Controller(db, {
      ownerUid: process.getuid!(),
      workspaceRoot: join(root, "workspaces"),
      allowRealLocalTasks: true,
    });
    const task = TaskSchema.parse({
      ...fixtureTask("A"),
      ...opted("REQUIRED"),
      providers: ["mock"],
      simulation: true,
    });
    c.importTasks([task], c.localActor());
    c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "Design it",
        sourceRef: "test:owner",
      },
      c.localActor(),
    );
    assert.equal(
      c.screeningHold("A"),
      "PRE_DESIGN_SCREEN_REQUIRED:A:NO_PROJECT_OVERSIGHT",
    );
    assert.throws(
      () =>
        c.reserve(
          "A",
          {
            requestKey: "plain",
            provider: "mock",
            model: "synthetic",
            effort: "low",
          },
          c.localActor(),
        ),
      /PRE_DESIGN_SCREEN_REQUIRED:A:NO_PROJECT_OVERSIGHT/,
    );
    const exempt = TaskSchema.parse({
      ...fixtureTask("E"),
      ...opted("EXEMPT"),
      providers: ["mock"],
      simulation: true,
    });
    c.importTasks([exempt], c.localActor());
    c.grant(
      "E",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/E"],
        decisionText: "File it",
        sourceRef: "test:owner",
      },
      c.localActor(),
    );
    assert.equal(c.screeningHold("E"), null);
    c.reserve(
      "E",
      {
        requestKey: "plain-e",
        provider: "mock",
        model: "synthetic",
        effort: "low",
      },
      c.localActor(),
    );
    const [record] = screeningRecords(db, "E") as ScreeningRecord[];
    assert.equal(record!.disposition, "EXEMPT");
    assert.equal(record!.projectId, null);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review P1: a key reused for another choice is rejected, within a checkpoint and against the project's records", async () => {
  // Within one checkpoint: E reuses A's key, scope and sources for another choice.
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "E", ...opted("REQUIRED") },
    ],
    overseer: (view) =>
      plan(view, {
        screenings: [
          requiresOwner(view, "A", [
            candidate("result-visibility", { affectedTaskIds: ["A", "E"] }),
          ]),
          requiresOwner(view, "E", [
            candidate("result-visibility", {
              affectedTaskIds: ["A", "E"],
              choice: "May a failed closeout be retried automatically?",
              options: [
                {
                  label: "Retry silently",
                  consequences: "The player sees nothing until it succeeds.",
                },
                {
                  label: "Show the failure",
                  consequences: "The player sees a notice and a retry button.",
                },
              ],
              recommendation: "Show the failure: honest and recoverable.",
            }),
          ]),
        ],
      }),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.match(
      f.rejected()[0]!.reason,
      /OVERSEER_CANDIDATE_KEY_CONFLICT:result-visibility/,
    );
    assert.equal(view.questions.length, 0);
    assert.equal(f.records("A").length, 0);
    assert.equal(f.records("E").length, 0);
    assert.ok(!f.roles().some((r) => r.startsWith("worker")));
  } finally {
    f.close();
  }
  // Against the record: a later checkpoint reuses the answered key with
  // another recommendation; the owner is not taken to have chosen it.
  const g = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "E", ...opted("REQUIRED") },
    ],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "E"] }),
              ]),
            ],
          })
        : plan(view, {
            screenings: [
              requiresOwner(view, "E", [
                candidate("result-visibility", {
                  affectedTaskIds: ["A", "E"],
                  recommendation: "Guarded early view: faster feedback.",
                }),
              ]),
            ],
          }),
  });
  try {
    let view = await g.o.drive(g.id, { live: true });
    const q = view.questions.find((x: any) => x.status === "OPEN")!;
    assert.deepEqual(q.taskIds, ["A", "E"]);
    g.o.reply(g.id, ownerReply(q.id, "Wait for closeout"));
    const before = g.rejected().length;
    view = await g.o.drive(g.id, { live: true });
    assert.ok(
      g
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_KEY_CONFLICT:result-visibility/.test(r.reason),
        ),
      canonical(g.rejected()),
    );
    assert.equal(g.records("E").length, 0);
    assert.equal(view.questions.length, 1);
    assert.ok(!g.roles().includes("worker:E"), g.roles().join(","));
  } finally {
    g.close();
  }
});

test("review P1: a revoked decision settles nothing: a screening citing it is rejected and the task stays held", async () => {
  const f = fixture({
    overseer: (view, call) =>
      plan(view, {
        assign: call === 0 ? ["B"] : undefined,
        screenings: (v) =>
          v.preDesign.find((s: any) => s.taskId === "A").current
            ? []
            : [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: "d1",
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ],
      }),
  });
  try {
    f.c.decide(
      "A",
      {
        id: "d1",
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    f.c.revoke("d1", "withdrawn", f.c.localActor());
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_SCREEN_STALE:A:OWN_DECISIONS_CHANGED,CITED_DECISION_REVOKED:d1",
    );
    const before = f.rejected().length;
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_DECISION_REVOKED:result-visibility/.test(
            r.reason,
          ),
        ),
      canonical(f.rejected()),
    );
    assert.equal(
      f.records("A").length,
      1,
      "no screening rests on the revoked decision",
    );
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(
      f.o
        .inspect(f.id)
        .tasks.find((t: any) => t.taskId === "A")!
        .holds.some((h: string) => h.startsWith("PRE_DESIGN_SCREEN_STALE:A")),
    );
  } finally {
    f.close();
  }
});

test("review P2: Astra's attempt bound counts per project input and screening currency, so a related task outside the project changing again is a new input", async () => {
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) }],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
  });
  try {
    const actor = f.c.localActor();
    const run = async (key: string) => {
      const a = f.c.reserve(
        "A",
        { role: "overseer", projectRequestId: f.id, requestKey: key },
        actor,
      );
      assert.equal((await f.c.execute(a, f.adapter, actor)).status, "SUCCEEDED");
      return a;
    };
    const bump = () => {
      const p = f.c.task("P");
      f.c.revise(
        "P",
        { ...p, scope: p.scope + " +", specVersion: p.specVersion + 1 },
        actor,
      );
    };
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const first = await run("o1");
    bump();
    const second = await run("o2");
    assert.equal(
      second.projectContext!.snapshot.inputDigest,
      first.projectContext!.snapshot.inputDigest,
      "the project's inputs are unchanged by a task outside it",
    );
    assert.notEqual(
      oversightInputDigest(second.projectContext!),
      oversightInputDigest(first.projectContext!),
      "the screening currency makes it a new input",
    );
    bump();
    await run("o3");
    // Without a change, two attempts per input remain the bound.
    await run("o4");
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "overseer", projectRequestId: f.id, requestKey: "o5" },
          actor,
        ),
      /PROJECT_OVERSIGHT_ATTEMPTS_EXHAUSTED/,
    );
  } finally {
    f.close();
  }
});

test("review P2: a screening that went stale before its questions were recorded: the questions are recorded first when they still bind their tasks, otherwise Astra comes back and the checkpoint must screen the task again", async () => {
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) }],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    const actor = f.c.localActor();
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    // The checkpoint commits; the advance stops before its questions are recorded.
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    assert.equal(f.records("A").length, 1);
    assert.equal(f.open().length, 0);
    assert.equal(f.preDesign("A")!.questions[0]!.status, "NOT_RECORDED");
    // A related task outside the project changes before the next advance.
    const p = f.c.task("P");
    f.c.revise("P", { ...p, scope: p.scope + " +", specVersion: 2 }, actor);
    assert.equal(oversightCurrent(f.o.project(f.id)), false);
    const calls = f.overseerCalls();
    await f.o.drive(f.id, { live: true });
    // The question the stopped advance owed is recorded first (the task's
    // own specification is unchanged) and holds the task; no Astra run is
    // spent while the owner is asked (review round 3).
    assert.equal(f.open().length, 1, "the owner is asked once");
    assert.equal(f.open()[0]!.askedBy, overseer.id, "for the stopped advance");
    assert.equal(f.overseerCalls(), calls, "no Astra run while the owner is asked");
    assert.equal(f.records("A").length, 1);
    assert.ok(!f.roles().includes("worker:A"));
    // The owner's answer brings Astra back to the stale screening; the fresh
    // screening admits the task with the answer on record.
    f.o.reply(f.id, ownerReply(f.open()[0]!.id, "Wait for closeout"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.overseerCalls() > calls, "Astra ran again");
    assert.equal(f.records("A").length, 2);
    assert.equal(f.open().length, 0);
    assert.equal(f.preDesign("A")!.current, true);
    assert.ok(f.roles().includes("worker:A"));
  } finally {
    f.close();
  }
  // When a task the questions hold was revised before they were recorded,
  // they cannot be recorded any more (an answer binds the specification it
  // was asked on), and a checkpoint that leaves the task unscreened is
  // rejected.
  const g = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", {
                  affectedTaskIds: ["A", "B"],
                }),
              ]),
            ],
          })
        : plan(view, {
            noScreen: true,
            outcome: "ASK_OWNER",
            assign: [],
            owner: [
              {
                question: "Which theme? 1) Dark (Recommended). 2) Light.",
                taskIds: ["A"],
                projectWide: false,
              },
            ],
          }),
  });
  try {
    const actor = g.c.localActor();
    const assessor = g.c.reserve(
      "A",
      { role: "assessor", projectRequestId: g.id, requestKey: "assess" },
      actor,
    );
    await g.c.execute(assessor, g.adapter, actor);
    const overseer = g.c.reserve(
      "A",
      { role: "overseer", projectRequestId: g.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await g.c.execute(overseer, g.adapter, actor);
    g.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    assert.equal(g.preDesign("A")!.questions[0]!.status, "NOT_RECORDED");
    g.revise("B");
    assert.match(g.preDesign("A")!.hold!, /AFFECTED_TASK_SPEC_CHANGED:B/);
    await g.o.drive(g.id, { live: true });
    assert.match(g.rejected()[0]!.reason, /OVERSEER_SCREEN_REQUIRED:A/);
    assert.equal(g.records("A").length, 1);
    assert.equal(
      g.open().length,
      0,
      "the stale screening's question is not recorded against a revised task",
    );
  } finally {
    g.close();
  }
});

test("review round 2: revoking a decision the screening cites on another affected task stales it; the old clearance admits nothing", async () => {
  // A's screening cites a decision recorded on B (affected by the choice);
  // Astra assigns B first, so A is screened but not yet worked.
  const f = fixture({
    overseer: (view, call) =>
      plan(view, {
        assign: call === 0 ? ["B"] : ["A"],
        screenings: (v) =>
          call === 0
            ? [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: "dB",
                      affectedTaskIds: ["A", "B"],
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ]
            : [],
      }),
  });
  try {
    f.c.decide(
      "B",
      {
        id: "dB",
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.preDesign("A")!.current, true);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    f.c.revoke("dB", "withdrawn", f.c.localActor());
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_SCREEN_STALE:A:CITED_DECISION_REVOKED:dB",
    );
    assert.equal(
      preDesignState(f.db, f.c.task("A"), f.o.project(f.id).snapshot.questions)
        .hold,
      "PRE_DESIGN_SCREEN_STALE:A:CITED_DECISION_REVOKED:dB",
    );
    // Astra's next checkpoint assigns A on the old clearance without
    // screening it again: rejected, and no worker runs.
    const before = f.rejected().length;
    await f.o.drive(f.id, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) => /OVERSEER_SCREEN_REQUIRED:A/.test(r.reason)),
      canonical(f.rejected()),
    );
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "stale-cited", projectRequestId: f.id },
          f.c.localActor(),
        ),
      /PRE_DESIGN_SCREEN_STALE:A:CITED_DECISION_REVOKED:dB|PROJECT_OVERSIGHT_REQUIRED|PROJECT_TASK_NOT_ASSIGNED/,
    );
  } finally {
    f.close();
  }
});

test("review round 2: a choice that would change another decision is a new question; the earlier answer is not reused", async () => {
  // The same choice, first against decision d1, then against its successor
  // d2 after the owner's answer led to a new decision record.
  const f = fixture({
    overseer: (view) =>
      plan(view, {
        screenings: (v) => {
          const state = v.preDesign.find((s: any) => s.taskId === "A");
          if (state.current) return [];
          const standing = v.snapshot.tasks
            .find((t: any) => t.task.id === "A")
            .decisions.map((d: any) => d.id)
            .filter(
              (id: string) =>
                !v.snapshot.tasks
                  .find((t: any) => t.task.id === "A")
                  .revocations.length || id === "d2",
            );
          return [
            requiresOwner(v, "A", [
              candidate("result-visibility", {
                revisesDecision: standing.includes("d2") ? "d2" : "d1",
              }),
            ]),
          ];
        },
      }),
  });
  try {
    const decide = (id: string, supersedes?: string) =>
      f.c.decide(
        "A",
        {
          id,
          text: "Wait for closeout",
          sourceRef: "test:owner",
          alternatives: [],
          limits: [],
          operations: ["READ_LOCAL", "WRITE_LOCAL"],
          artifactRevision: "r1",
          ...(supersedes ? { supersedes } : {}),
        },
        f.c.localActor(),
      );
    decide("d1");
    let view = await f.o.drive(f.id, { live: true });
    const first = view.questions.find((q: any) => q.status === "OPEN")!;
    assert.match(first.text, /would change recorded decision d1/);
    f.o.reply(f.id, ownerReply(first.id, "Change it: guarded early view"));
    // The host records the new decision (superseding d1) rather than
    // starting the work on the answer alone.
    decide("d2", "d1");
    assert.ok(
      f.preDesign("A")!.stale.includes("CITED_DECISION_REVOKED:d1"),
      canonical(f.preDesign("A")!.stale),
    );
    view = await f.o.drive(f.id, { live: true });
    const open = view.questions.filter((q: any) => q.status === "OPEN");
    assert.equal(open.length, 1, canonical(view.questions));
    assert.notEqual(open[0]!.key, first.key);
    assert.match(open[0]!.text, /would change recorded decision d2/);
    assert.equal(view.questions.length, 2);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    f.o.reply(f.id, ownerReply(open[0]!.id, "Keep it"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 3: an operator's answer settles no owner choice: citing it as decidedBy is rejected, and only an answer the owner gave can be cited", async () => {
  // Astra first asks the operator a factual question about A, then screens
  // A clear citing whichever answered question `cite` names.
  let cite: string | null = null;
  const f = fixture({
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            noScreen: true,
            outcome: "ASK_OPERATOR",
            assign: [],
            operator: [
              {
                question: "Is A's earlier run still held?",
                taskIds: ["A"],
                projectWide: false,
              },
            ],
          })
        : plan(view, {
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "A").current
                ? []
                : [
                    clear(v, "A", {
                      candidates: [
                        candidate("result-visibility", {
                          type: "ALREADY_DECIDED",
                          decidedBy: cite,
                          options: [],
                          recommendation: null,
                        }),
                      ],
                    }),
                  ],
          }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const operator = view.questions.find(
      (q: any) => q.audience === "OPERATOR",
    )!;
    f.o.reply(f.id, operatorReply(operator.id));
    // The operator's factual answer cited as settling the owner's choice:
    // the whole checkpoint is refused, nothing is recorded, nothing runs.
    cite = operator.id;
    const before = f.rejected().length;
    await f.o.drive(f.id, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_ANSWER_NOT_APPLICABLE:result-visibility/.test(
            r.reason,
          ),
        ),
      canonical(f.rejected()),
    );
    assert.equal(f.records("A").length, 0, "no screening rests on it");
    assert.equal(f.preDesign("A")!.hold, "PRE_DESIGN_SCREEN_REQUIRED:A");
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    // An owner question on A, answered by the owner, can be cited.
    const owner = f.o.ask(f.id, {
      key: "visibility-choice",
      text: "May the user see a mission's result early? 1) Wait for closeout (Recommended): nothing shown is contradicted later. 2) Guarded early view: faster, provisional.",
      kind: "OWNER_DECISION",
      taskIds: ["A"],
    });
    f.o.reply(f.id, ownerReply(owner.id, "Wait for closeout"));
    cite = owner.id;
    view = await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("A")[0]!.candidates[0]!.decidedBy, owner.id);
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 3: an answer the owner closed as historical for a revised task settles nothing for it: citing it is rejected, and the choice screened again is a new question", async () => {
  // Astra asks the choice on A. After A's revision it cites the question
  // `cite` names once (that run), and on its next run screens the same
  // choice again.
  let cite: string | null = null;
  const f = fixture({
    overseer: (view) =>
      plan(view, {
        screenings: (v) => {
          if (v.preDesign.find((s: any) => s.taskId === "A").current) return [];
          const cited = cite;
          cite = null;
          return cited
            ? [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: cited,
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ]
            : [requiresOwner(v, "A", [candidate("result-visibility")])];
        },
      }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const first = view.questions.find((q: any) => q.status === "OPEN")!;
    assert.ok(first.key.startsWith(PRE_DESIGN_QUESTION_PREFIX), first.key);
    // A is revised while its choice is open: the owner closes the old
    // question as historical for A, leaving the new specification unanswered.
    const old = f.c.task("A");
    f.c.revise(
      "A",
      { ...old, scope: old.scope + " (revised)", specVersion: 2 },
      f.c.localActor(),
    );
    f.grant(f.c.task("A"));
    assert.throws(
      () => f.o.reply(f.id, ownerReply(first.id, "Wait for closeout")),
      /QUESTION_TASK_SPEC_CHANGED/,
    );
    f.o.reply(f.id, {
      ...ownerReply(first.id, "Wait for closeout"),
      historicalOnly: true,
      answeredAs: "OWNER",
    });
    f.o.rebind(f.id, ["A"]);
    // Astra cites the historical answer as settling revised A's choice:
    // the checkpoint is refused. Its next run (the second allowed on this
    // input) screens the same choice again, and that is a new question;
    // the historical answer stays history and holds nothing open.
    cite = first.id;
    const before = f.rejected().length;
    view = await f.o.drive(f.id, { live: true });
    assert.equal(cite, null, "Astra cited the historical answer");
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_ANSWER_NOT_APPLICABLE:result-visibility/.test(
            r.reason,
          ),
        ),
      canonical(f.rejected()),
    );
    assert.equal(f.records("A").length, 2);
    assert.ok(
      f
        .records("A")
        .every((r) => r.candidates.every((c) => c.decidedBy !== first.id)),
      "no screening rests on the historical answer",
    );
    const open = view.questions.filter((q: any) => q.status === "OPEN");
    assert.equal(open.length, 1, canonical(view.questions));
    assert.notEqual(open[0]!.key, first.key);
    assert.equal(view.questions.length, 2);
    assert.equal(f.preDesign("A")!.questions[0]!.status, "OPEN");
    assert.match(f.preDesign("A")!.hold!, /^PRE_DESIGN_OWNER_CHOICE_OPEN/);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    f.o.reply(f.id, ownerReply(open[0]!.id, "Wait for closeout"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 3: a checkpoint and the owner questions its screenings raise are recorded together, and a question a recorded checkpoint still owes survives a later clear screening", async () => {
  // All or none: the advance stops while the derived question is written.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }],
    overseer: (view) =>
      plan(view, {
        screenings: (v) =>
          v.preDesign.find((s: any) => s.taskId === "A").current
            ? []
            : [requiresOwner(v, "A", [candidate("result-visibility")])],
      }),
  });
  try {
    const db = f.db,
      event = db.event.bind(db);
    let stop = true;
    db.event = (kind: string, taskId: string | null, data: unknown) => {
      if (stop && kind === "WORKFLOW_QUESTION") {
        stop = false;
        throw new Error("TEST_STOPPED_WRITING_THE_QUESTION");
      }
      event(kind, taskId, data);
    };
    await f.o.drive(f.id, { live: true });
    assert.equal(stop, false, "the question's write was reached");
    db.event = event;
    // The stopped run left nothing of its own: no checkpoint, no screening
    // and no question.
    const stopped = f
      .rejected()
      .find((r: any) => /TEST_STOPPED_WRITING_THE_QUESTION/.test(r.reason))!;
    assert.ok(stopped, canonical(f.rejected()));
    assert.ok(f.plans().every((p: any) => p.runId !== stopped.runId));
    assert.ok(
      f.records("A").every((r) => r.checkpointRunId !== stopped.runId),
      "no screening without its question",
    );
    assert.ok(
      f.o
        .inspect(f.id)
        .questions.every((q: any) => q.askedBy !== stopped.runId),
    );
    // Astra's next run (the second allowed on this input; this drive
    // started it) recorded all three together, and A waits for the owner.
    if (!f.plans().length) await f.o.drive(f.id, { live: true });
    assert.equal(f.plans().length, 1);
    const run = f.plans()[0]!.runId;
    assert.deepEqual(
      f.records("A").map((r) => r.checkpointRunId),
      [run],
    );
    assert.equal(f.open().length, 1);
    assert.equal(f.open()[0]!.askedBy, run);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
  // A checkpoint already recorded without its question (an earlier version,
  // or a stop between them): a related task outside the project changes
  // and B is revised, so Astra plans again and screens A clear with no
  // candidates. The owed question is recorded first, survives the clear
  // screening and holds A until the owner answers it.
  const g = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) },
      { id: "B" },
    ],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    const actor = g.c.localActor();
    const assessor = g.c.reserve(
      "A",
      { role: "assessor", projectRequestId: g.id, requestKey: "assess" },
      actor,
    );
    await g.c.execute(assessor, g.adapter, actor);
    const overseer = g.c.reserve(
      "A",
      { role: "overseer", projectRequestId: g.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await g.c.execute(overseer, g.adapter, actor);
    g.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    assert.equal(g.preDesign("A")!.questions[0]!.status, "NOT_RECORDED");
    const p = g.c.task("P");
    g.c.revise("P", { ...p, scope: p.scope + " +", specVersion: 2 }, actor);
    g.revise("B");
    const calls = g.overseerCalls();
    await g.o.drive(g.id, { live: true });
    assert.ok(g.overseerCalls() > calls, "Astra planned again");
    const latest = g.records("A").at(-1)!;
    assert.equal(g.records("A").length, 2);
    assert.equal(latest.disposition, "SCREENED_CLEAR");
    assert.deepEqual(latest.candidates, []);
    const open = g.open();
    assert.equal(open.length, 1, "the owed question is recorded and open");
    assert.equal(open[0]!.askedBy, overseer.id);
    assert.ok(!g.roles().includes("worker:A"), g.roles().join(","));
    assert.ok(g.roles().includes("worker:B"), g.roles().join(","));
    g.o.reply(g.id, ownerReply(open[0]!.id, "Wait for closeout"));
    await g.o.drive(g.id, { live: true });
    assert.ok(g.roles().includes("worker:A"), g.roles().join(","));
  } finally {
    g.close();
  }
});

test("review round 4: a failure while recording a question a recorded checkpoint still owes holds the project; a later clear screening cannot replace the choice", async () => {
  // A checkpoint recorded without its question; a related task outside the
  // project changes and B is revised, so Astra would plan again and screen
  // A clear with no candidates.
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED", { resources: ["ledger"] }) },
      { id: "B" },
    ],
    extraTasks: [{ id: "P", resources: ["ledger"] }],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [candidate("result-visibility")]),
            ],
          })
        : plan(view),
  });
  try {
    const actor = f.c.localActor();
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    const p = f.c.task("P");
    f.c.revise("P", { ...p, scope: p.scope + " +", specVersion: 2 }, actor);
    f.revise("B");
    // Recording the owed question fails throughout this advance.
    const db = f.db,
      event = db.event.bind(db);
    db.event = (kind: string, taskId: string | null, data: unknown) => {
      if (kind === "WORKFLOW_QUESTION")
        throw new Error("TEST_QUESTION_RECORDING_FAILED");
      event(kind, taskId, data);
    };
    const calls = f.overseerCalls();
    let view = await f.o.drive(f.id, { live: true });
    db.event = event;
    assert.equal(f.overseerCalls(), calls, "no Astra run past the failure");
    assert.equal(f.records("A").length, 1, "no replacement screening");
    assert.equal(f.open().length, 0);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(
      view.tasks
        .find((t: any) => t.taskId === "A")!
        .holds.some((h: string) =>
          /PROJECT_OVERSIGHT_HELD:.*TEST_QUESTION_RECORDING_FAILED/.test(h),
        ),
      canonical(view.tasks.find((t: any) => t.taskId === "A")!.holds),
    );
    // Once recording works, the owed question is recorded first; Astra's
    // clear screening does not replace it, and A waits for the owner.
    view = await f.o.drive(f.id, { live: true });
    assert.ok(f.overseerCalls() > calls, "Astra planned again");
    assert.equal(f.records("A").at(-1)!.disposition, "SCREENED_CLEAR");
    assert.equal(f.open().length, 1);
    assert.equal(f.open()[0]!.askedBy, overseer.id);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(f.roles().includes("worker:B"), f.roles().join(","));
    f.o.reply(f.id, ownerReply(f.open()[0]!.id, "Wait for closeout"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 4: a historical answer settles nothing for a task revised after it was answered", async () => {
  // A choice affects A and B, both opted in. A is revised and the owner
  // closes the question as historical for A; it stays an ordinary answer
  // for B until B too is revised. Astra then cites it once as settling B's
  // choice, and on its next run screens B's choice again.
  let cite: string | null = null;
  const f = fixture({
    tasks: [
      { id: "A", ...opted("REQUIRED") },
      { id: "B", ...opted("REQUIRED") },
    ],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "B"] }),
              ]),
            ],
          })
        : plan(view, {
            screenings: (v) => {
              const cited = cite;
              cite = null;
              const due = (id: string) =>
                !v.preDesign.find((s: any) => s.taskId === id).current;
              return [
                ...(due("A") ? [clear(v, "A")] : []),
                ...(due("B")
                  ? [
                      cited
                        ? clear(v, "B", {
                            candidates: [
                              candidate("result-visibility", {
                                type: "ALREADY_DECIDED",
                                decidedBy: cited,
                                affectedTaskIds: ["B"],
                                options: [],
                                recommendation: null,
                              }),
                            ],
                          })
                        : requiresOwner(v, "B", [
                            candidate("result-visibility", {
                              affectedTaskIds: ["B"],
                            }),
                          ]),
                    ]
                  : []),
              ];
            },
          }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const first = view.questions.find((q: any) => q.status === "OPEN")!;
    assert.deepEqual([...first.taskIds].sort(), ["A", "B"]);
    const old = f.c.task("A");
    f.c.revise(
      "A",
      { ...old, scope: old.scope + " (revised)", specVersion: 2 },
      f.c.localActor(),
    );
    f.grant(f.c.task("A"));
    f.o.reply(f.id, {
      ...ownerReply(first.id, "Wait for closeout"),
      historicalOnly: true,
      answeredAs: "OWNER",
    });
    f.o.rebind(f.id, ["A"]);
    // B is revised after the answer: the answer was given on B's earlier
    // specification.
    f.revise("B");
    cite = first.id;
    const before = f.rejected().length;
    view = await f.o.drive(f.id, { live: true });
    assert.equal(cite, null, "Astra cited the historical answer for B");
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_ANSWER_NOT_APPLICABLE:result-visibility/.test(
            r.reason,
          ),
        ),
      canonical(f.rejected()),
    );
    assert.ok(
      f
        .records("B")
        .every((r) => r.candidates.every((c) => c.decidedBy !== first.id)),
      "no screening of B rests on the historical answer",
    );
    // B's choice screened again is a new question that holds B.
    const open = view.questions.filter((q: any) => q.status === "OPEN");
    assert.equal(open.length, 1, canonical(view.questions));
    assert.deepEqual(open[0]!.taskIds, ["B"]);
    assert.ok(!f.roles().includes("worker:B"), f.roles().join(","));
    f.o.reply(f.id, ownerReply(open[0]!.id, "Wait for closeout"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:B"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 5: an answered question that does not cover the task cannot be cited as settling its choice", async () => {
  // Astra screens A clear citing whichever answered owner question `cite`
  // names.
  let cite: string | null = null;
  const f = fixture({
    overseer: (view) =>
      plan(view, {
        screenings: (v) =>
          v.preDesign.find((s: any) => s.taskId === "A").current
            ? []
            : [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: cite,
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ],
      }),
  });
  try {
    const ask = (key: string, taskIds: string[]) => {
      const q = f.o.ask(f.id, {
        key,
        text: "May the user see a mission's result early? 1) Wait for closeout (Recommended): nothing shown is contradicted later. 2) Guarded early view: faster, provisional.",
        kind: "OWNER_DECISION",
        taskIds,
      });
      f.o.reply(f.id, ownerReply(q.id, "Wait for closeout"));
      return q.id;
    };
    // An owner's answer to a question about B only, cited for A's choice.
    cite = ask("visibility-on-b", ["B"]);
    const before = f.rejected().length;
    await f.o.drive(f.id, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_ANSWER_NOT_APPLICABLE:result-visibility/.test(
            r.reason,
          ),
        ),
      canonical(f.rejected()),
    );
    assert.equal(f.records("A").length, 0, "no screening rests on it");
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    // A question that covers A (and B) can be cited.
    cite = ask("visibility-on-a-and-b", ["A", "B"]);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("A")[0]!.candidates[0]!.decidedBy, cite);
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    // With the project's questions the citation stands; without them it
    // cannot be shown to apply, as an owner question then counts as open.
    const questions = f.o.project(f.id).snapshot.questions;
    assert.deepEqual(preDesignState(f.db, f.c.task("A"), questions).stale, []);
    assert.deepEqual(preDesignState(f.db, f.c.task("A"), undefined).stale, [
      "CITED_ANSWER_NOT_APPLICABLE:" + cite,
    ]);
  } finally {
    f.close();
  }
});

test("review round 5: a screening that cites an answer which has stopped applying is stale; the old clearance admits nothing", async () => {
  // A question covers A, B and C; C is revised and the owner closes it as
  // historical for C. A's screening cites it for A and B. The first drive
  // ends with A screened but not yet worked (its checkpoints assign B, then
  // A, but no worker has started). B is then revised: the historical answer
  // no longer applies to it, although B is not one of A's related tasks.
  let qid = "";
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }, { id: "C" }],
    overseer: (view, call) =>
      plan(view, {
        assign: call === 0 ? ["B"] : ["A"],
        screenings: (v) =>
          call === 0
            ? [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: qid,
                      affectedTaskIds: ["A", "B"],
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ]
            : [],
      }),
  });
  try {
    qid = f.o.ask(f.id, {
      key: "visibility-on-a-b-c",
      text: "May the user see a mission's result early? 1) Wait for closeout (Recommended): nothing shown is contradicted later. 2) Guarded early view: faster, provisional.",
      kind: "OWNER_DECISION",
      taskIds: ["A", "B", "C"],
    }).id;
    const old = f.c.task("C");
    f.c.revise(
      "C",
      { ...old, scope: old.scope + " (revised)", specVersion: 2 },
      f.c.localActor(),
    );
    f.grant(f.c.task("C"));
    f.o.reply(f.id, {
      ...ownerReply(qid, "Wait for closeout"),
      historicalOnly: true,
      answeredAs: "OWNER",
    });
    f.o.rebind(f.id, ["C"]);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("A")[0]!.candidates[0]!.decidedBy, qid);
    assert.equal(f.preDesign("A")!.current, true);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    f.revise("B");
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_SCREEN_STALE:A:CITED_ANSWER_NOT_APPLICABLE:" + qid,
    );
    // Astra's next checkpoint assigns A on the old clearance without
    // screening it again: rejected, and no worker runs.
    const before = f.rejected().length;
    await f.o.drive(f.id, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) => /OVERSEER_SCREEN_REQUIRED:A/.test(r.reason)),
      canonical(f.rejected()),
    );
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "stale-cited-answer", projectRequestId: f.id },
          f.c.localActor(),
        ),
      /PRE_DESIGN_SCREEN_STALE:A:CITED_ANSWER_NOT_APPLICABLE|PROJECT_OVERSIGHT_REQUIRED|PROJECT_TASK_NOT_ASSIGNED/,
    );
  } finally {
    f.close();
  }
});

test("review round 6: a screening reused in another project cannot rest on an answer that project does not hold", async () => {
  // In the first project a question covers A, B and C; C is revised and
  // the owner closes it as historical for C; A's screening cites it for A
  // and B, and Astra there only ever assigns B. A is then attached to a
  // request of another project, and B (outside that project, not one of
  // A's related tasks) is revised.
  let qid = "";
  let elsewhere = false,
    elsewhereCalls = 0;
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }, { id: "C" }],
    overseer: (view, call) =>
      elsewhere
        ? elsewhereCalls++ === 0
          ? plan(view, { assign: ["A"], screenings: [] })
          : plan(view)
        : plan(view, {
            assign: ["B"],
            screenings: (v) =>
              call === 0
                ? [
                    clear(v, "A", {
                      candidates: [
                        candidate("result-visibility", {
                          type: "ALREADY_DECIDED",
                          decidedBy: qid,
                          affectedTaskIds: ["A", "B"],
                          options: [],
                          recommendation: null,
                        }),
                      ],
                    }),
                  ]
                : [],
          }),
  });
  try {
    qid = f.o.ask(f.id, {
      key: "visibility-on-a-b-c",
      text: "May the user see a mission's result early? 1) Wait for closeout (Recommended): nothing shown is contradicted later. 2) Guarded early view: faster, provisional.",
      kind: "OWNER_DECISION",
      taskIds: ["A", "B", "C"],
    }).id;
    const old = f.c.task("C");
    f.c.revise(
      "C",
      { ...old, scope: old.scope + " (revised)", specVersion: 2 },
      f.c.localActor(),
    );
    f.grant(f.c.task("C"));
    f.o.reply(f.id, {
      ...ownerReply(qid, "Wait for closeout"),
      historicalOnly: true,
      answeredAs: "OWNER",
    });
    f.o.rebind(f.id, ["C"]);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.preDesign("A")!.current, true);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A"]);
    f.revise("B");
    // That project holds no record of the cited answer, so the screening
    // cannot be shown to rest on a current owner answer there.
    const there = f.o.project(r3).preDesign!.find((s) => s.taskId === "A")!;
    assert.equal(
      there.hold,
      "PRE_DESIGN_SCREEN_STALE:A:CITED_ANSWER_NOT_APPLICABLE:" + qid,
    );
    // Its Astra assigns A on the reused clearance: rejected. Its next run
    // screens A afresh, and only then does A's worker start (the driver may
    // need another pass to reach it).
    elsewhere = true;
    const before = f.rejected().length;
    await f.o.drive(r3, { live: true });
    for (let pass = 0; pass < 2 && !f.roles().includes("worker:A"); pass++)
      await f.o.drive(r3, { live: true });
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) => /OVERSEER_SCREEN_REQUIRED:A/.test(r.reason)),
      canonical(f.rejected()),
    );
    const screened = f.db
      .all<{
        seq: number;
      }>("SELECT seq FROM events WHERE kind='PRE_DESIGN_SCREENING' AND task_id='A' ORDER BY seq")
      .map((r) => r.seq);
    assert.equal(screened.length, 2);
    assert.equal(f.records("A")[1]!.candidates.length, 0);
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.ok(workerReservedSeq(f, "A")! > screened[1]!);
  } finally {
    f.close();
  }
});

test("review round 6: a decision cited by its ID clears the task even when a question shares that ID", async () => {
  // An operator question on A shares its ID with a decision recorded on A;
  // checkpoint validation reads the citation as the decision, and so must
  // the screening's currency.
  let cite = "";
  const f = fixture({
    overseer: (view) =>
      plan(view, {
        screenings: (v) =>
          v.preDesign.find((s: any) => s.taskId === "A").current
            ? []
            : [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: cite,
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ],
      }),
  });
  try {
    const q = f.o.ask(f.id, {
      key: "gateway-log",
      text: "Where is run X's gateway log?",
      kind: "INFORMATION",
      audience: "OPERATOR",
      taskIds: ["A"],
    });
    f.o.reply(f.id, operatorReply(q.id));
    f.c.decide(
      "A",
      {
        id: q.id,
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      f.c.localActor(),
    );
    cite = q.id;
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.equal(f.records("A")[0]!.candidates[0]!.decidedBy, q.id);
    assert.deepEqual(f.preDesign("A")!.stale, []);
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 7: an owner choice found in one project holds the task in another, whatever screening follows there, and its answer reaches that project", async () => {
  // Project "modules" finds an owner choice on A (and only ever assigns B).
  // A and D are then attached to a request of project "elsewhere", whose
  // Astra (run for D) replaces A's screening with a clear one and assigns A
  // with D.
  let elsewhere = false;
  const elsewherePlan = (view: View) =>
    plan(view, {
      assign: ["A", "D"],
      screenings: (v) =>
        v.preDesign.find((s: any) => s.taskId === "A").latest?.projectId ===
        "project:elsewhere"
          ? []
          : [clear(v, "A")],
    });
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }, { id: "D" }],
    overseer: (view, call) =>
      elsewhere
        ? elsewherePlan(view)
        : plan(view, {
            assign: ["B"],
            screenings:
              call === 0
                ? [requiresOwner(view, "A", [candidate("result-visibility")])]
                : [],
          }),
  });
  const drive = async (requestId: string, done: () => boolean) => {
    for (let pass = 0; pass < 3 && !done(); pass++)
      await f.o.drive(requestId, { live: true });
  };
  const replaced = (x: typeof f) =>
    x.records("A").at(-1)?.projectId === "project:elsewhere";
  const questionEvents = () =>
    f.db.all<{ body: string }>(
      "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
    );
  try {
    await f.o.drive(f.id, { live: true });
    const choice = f.open().find((q: any) =>
      q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX),
    )!;
    assert.ok(choice, canonical(f.open()));
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A", "D"]);
    elsewhere = true;
    await drive(r3, () => replaced(f) && f.roles().includes("worker:D"));
    // There, A is held by the open choice although its latest screening is
    // that project's clear one, which assigns A; D runs.
    assert.ok(f.roles().includes("worker:D"), f.roles().join(","));
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    const latest = f.records("A").at(-1)!;
    assert.equal(latest.projectId, "project:elsewhere");
    assert.equal(latest.disposition, "SCREENED_CLEAR");
    assert.ok(
      f.o
        .project(r3)
        .snapshot.questions.some(
          (q: any) => q.id === choice.id && !q.answers.length,
        ),
    );
    // The hold is shown there, on A, naming the question, and the question
    // is listed with the request where it is answered (review round 8).
    const there = f.o.inspect(r3);
    const listed = (there as any).otherRequestQuestions?.find(
      (q: any) => q.id === choice.id,
    );
    assert.equal(listed?.requestId, f.id, canonical(there));
    assert.ok(
      there.tasks
        .find((t: any) => t.taskId === "A")!
        .holds.includes("PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST:" + choice.id),
    );
    assert.equal(
      (f.o.compact(r3) as any).otherRequestQuestions?.find(
        (q: any) => q.id === choice.id,
      )?.requestId,
      f.id,
    );
    assert.equal(
      (there as any).project.questions.find((q: any) => q.id === choice.id)
        ?.requestId,
      f.id,
    );
    assert.throws(
      () => f.o.reply(r3, ownerReply(choice.id, "Wait for closeout")),
      /QUESTION_NOT_IN_REQUEST/,
    );
    const held = "PRE_DESIGN_OWNER_CHOICE_OPEN:" + choice.id;
    assert.equal(
      f.o.project(r3).preDesign!.find((s) => s.taskId === "A")!.hold,
      held,
    );
    assert.ok(
      f.o
        .inspect(r3)
        .tasks.find((t: any) => t.taskId === "A")!
        .holds.includes(held),
      canonical(f.o.inspect(r3).tasks),
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "held-elsewhere", projectRequestId: r3 },
          f.c.localActor(),
        ),
      /PROJECT_OWNER_QUESTION_OPEN|PRE_DESIGN_OWNER_CHOICE_OPEN/,
    );
    // The choice is asked once, where it was found.
    assert.equal(questionEvents().length, 1);
    // The owner's answer there reaches this project: Astra plans again and
    // A runs, with nothing asked twice.
    f.o.reply(f.id, ownerReply(choice.id, "Wait for closeout"));
    await drive(r3, () => f.roles().includes("worker:A"));
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
    assert.equal(questionEvents().length, 1);
  } finally {
    f.close();
  }
  // A checkpoint of the first project recorded without its question: the
  // receiving project records the owed question before its first
  // checkpoint, and it holds A there; no Astra run there can drop it with a
  // clear screening while the owner is asked.
  let there = false;
  const g = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }],
    overseer: (view, call) =>
      there
        ? elsewherePlan(view)
        : call === 0
          ? plan(view, {
              screenings: [
                requiresOwner(view, "A", [candidate("result-visibility")]),
              ],
            })
          : plan(view),
  });
  try {
    const actor = g.c.localActor();
    const assessor = g.c.reserve(
      "A",
      { role: "assessor", projectRequestId: g.id, requestKey: "assess" },
      actor,
    );
    await g.c.execute(assessor, g.adapter, actor);
    const overseer = g.c.reserve(
      "A",
      { role: "overseer", projectRequestId: g.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await g.c.execute(overseer, g.adapter, actor);
    g.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    const r3 = g.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: g.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    g.o.attach(r3, ["A"]);
    there = true;
    const calls = g.overseerCalls();
    await g.o.drive(r3, { live: true });
    await g.o.drive(r3, { live: true });
    assert.ok(!g.roles().includes("worker:A"), g.roles().join(","));
    assert.equal(g.overseerCalls(), calls, "no Astra run while the owner is asked");
    assert.ok(!replaced(g), "no screening there replaced the first project's");
    assert.equal(g.records("A").length, 1);
    const recorded = g.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
      )
      .map((r) => JSON.parse(r.body));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.requestId, r3);
    assert.equal(recorded[0]!.question.askedBy, overseer.id);
    assert.ok(recorded[0]!.question.key.startsWith(PRE_DESIGN_QUESTION_PREFIX));
  } finally {
    g.close();
  }
});

test("review round 7: a question key keeps one choice across projects; another project cannot put a different choice under an answered key", async () => {
  // Project "modules" asks choice X on A and the owner answers it. Project
  // "elsewhere" screens the same specification with the same candidate
  // key, affected tasks and sources, but a different choice Y.
  let elsewhere = false;
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }],
    overseer: (view) =>
      elsewhere
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", {
                  choice:
                    "Should a mission's result be shown on the map instead of a results screen? It decides where the user learns the outcome.",
                  options: [
                    {
                      label: "On the map",
                      consequences: "The player stays in the world.",
                    },
                    {
                      label: "Results screen",
                      consequences: "The player sees everything at once.",
                    },
                  ],
                  recommendation: "On the map: fewer screens.",
                }),
              ]),
            ],
          })
        : plan(view, {
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "A").latest
                ? []
                : [requiresOwner(v, "A", [candidate("result-visibility")])],
          }),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    const x = view.questions.find((q: any) => q.status === "OPEN")!;
    f.o.reply(f.id, ownerReply(x.id, "Wait for closeout"));
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A"]);
    elsewhere = true;
    const before = f.rejected().length;
    await f.o.drive(r3, { live: true });
    // The different choice under the same key is refused outright: it is
    // never taken as answered by the owner's answer to X, here or there.
    assert.equal(f.records("A").length, 1, "no screening of Y is recorded");
    assert.ok(
      f
        .rejected()
        .slice(before)
        .some((r: any) =>
          /OVERSEER_CANDIDATE_KEY_CONFLICT:result-visibility/.test(r.reason),
        ),
      canonical(f.rejected()),
    );
    assert.equal(
      f.records("A")[0]!.candidates[0]!.choice,
      candidate("result-visibility").choice,
    );
    assert.equal(f.preDesign("A")!.questions[0]!.status, "ANSWERED");
  } finally {
    f.close();
  }
});

test("review round 8: a question owed for tasks a receiving project does not all hold is recorded where they all are, and that project still advances", async () => {
  // Project "modules" records a checkpoint without its question: a choice
  // affecting A and B. Project "elsewhere" holds A and D, not B; its Astra
  // (run for D) replaces A's screening with a clear one and assigns A and D.
  let elsewhere = false;
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }, { id: "D" }],
    overseer: (view) =>
      elsewhere
        ? plan(view, {
            assign: ["A", "D"],
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "A").latest
                ?.projectId === "project:elsewhere"
                ? []
                : [clear(v, "A")],
          })
        : plan(view, {
            assign: [],
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "B"] }),
              ]),
            ],
          }),
  });
  try {
    const actor = f.c.localActor();
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    assert.equal(f.preDesign("A")!.questions[0]!.status, "NOT_RECORDED");
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A", "D"]);
    elsewhere = true;
    for (let pass = 0; pass < 3 && !f.roles().includes("worker:D"); pass++)
      await f.o.drive(r3, { live: true });
    // That project advances: D runs, A waits.
    assert.ok(f.roles().includes("worker:D"), f.roles().join(","));
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    // The owed question was recorded once, whole, in the project that
    // holds both its tasks, and is shared from there.
    const recorded = f.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
      )
      .map((r) => JSON.parse(r.body));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.requestId, f.id);
    assert.deepEqual(recorded[0]!.question.taskIds, ["A", "B"]);
    assert.equal(recorded[0]!.question.askedBy, overseer.id);
    assert.equal(
      (f.o.inspect(r3) as any).otherRequestQuestions?.find(
        (q: any) => q.id === recorded[0]!.question.id,
      )?.requestId,
      f.id,
    );
    assert.ok(
      !f.db
        .all<{ body: string }>(
          "SELECT body FROM events WHERE kind='WORKFLOW_STEP' ORDER BY seq",
        )
        .some((r) =>
          /QUESTION_TASK_OUTSIDE_PROJECT/.test(
            String(JSON.parse(r.body).step?.detail ?? ""),
          ),
        ),
      "no advance failed on the question's scope",
    );
  } finally {
    f.close();
  }
});

test("review round 9: a revision of one owed question's task does not stop another owed question of the same screening from being recorded", async () => {
  // A checkpoint recorded without its questions: A's screening owes X
  // (affecting A and B) and Y (affecting A only). B is then revised, so X
  // can no longer be recorded; Y still can, and must survive Astra's clear
  // replacement screening of A.
  const y = candidate("result-detail", {
    choice:
      "May the user see a mission's full breakdown, or only the outcome? It decides how much the results screen shows.",
    recommendation: "Outcome first: less to read, and the breakdown stays one step away.",
  });
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
    overseer: (view, call) =>
      call === 0
        ? plan(view, {
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "B"] }),
                y,
              ]),
            ],
          })
        : plan(view),
  });
  try {
    const actor = f.c.localActor();
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    assert.deepEqual(
      f.preDesign("A")!.questions.map((q) => q.status),
      ["NOT_RECORDED", "NOT_RECORDED"],
    );
    f.revise("B");
    await f.o.drive(f.id, { live: true });
    // Y was recorded first (asked by the original run) and holds A after
    // Astra's clear screening replaced the one it came from; X, whose task
    // B was revised, was not recorded.
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    const open = f.open();
    assert.equal(open.length, 1, canonical(open));
    assert.ok(open[0]!.key.startsWith(PRE_DESIGN_QUESTION_PREFIX + "result-detail:"));
    assert.equal(open[0]!.askedBy, overseer.id);
    assert.equal(f.records("A").at(-1)!.disposition, "SCREENED_CLEAR");
    assert.equal(
      f.preDesign("A")!.hold,
      "PRE_DESIGN_OWNER_CHOICE_OPEN:" + open[0]!.id,
    );
    f.o.reply(f.id, ownerReply(open[0]!.id, "Outcome first"));
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"), f.roles().join(","));
  } finally {
    f.close();
  }
});

test("review round 10: a question owed by another task's screening is found through the affected task, recorded where its tasks are, and holds that task's worker", async () => {
  // Project "modules" records a checkpoint without its question: A's
  // screening owes a choice affecting A and B. Project "elsewhere" holds
  // only B, which is not opted in.
  const owing = () => {
    const f = fixture({
      tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
      overseer: (view) =>
        view.snapshot.projectId === "project:elsewhere"
          ? plan(view)
          : plan(view, {
              assign: [],
              screenings: [
                requiresOwner(view, "A", [
                  candidate("result-visibility", {
                    affectedTaskIds: ["A", "B"],
                  }),
                ]),
              ],
            }),
    });
    const record = async () => {
      const actor = f.c.localActor();
      const assessor = f.c.reserve(
        "A",
        { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
        actor,
      );
      await f.c.execute(assessor, f.adapter, actor);
      const overseer = f.c.reserve(
        "A",
        { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
        actor,
      );
      const receipt = await f.c.execute(overseer, f.adapter, actor);
      f.c.recordProjectCheckpoint(
        overseer.projectContext!,
        overseer.id,
        receipt.output,
      );
      return overseer.id;
    };
    const elsewhereRequest = () => {
      const r3 = f.o.submit({
        requestKey: randomUUID(),
        prompt: "Reuse module B elsewhere",
        context: { cwd: f.root, projectKey: "elsewhere" },
        sourceRef: "test:owner-3",
      }).request.id;
      f.o.attach(r3, ["B"]);
      return r3;
    };
    return { f, record, elsewhereRequest };
  };
  const questionEvents = (f: ReturnType<typeof fixture>) =>
    f.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
      )
      .map((r) => JSON.parse(r.body));
  // Advancing the receiving project records the owed question in the first
  // project (it covers A, which the receiving project lacks) and B waits.
  {
    const { f, record, elsewhereRequest } = owing();
    try {
      const owedBy = await record();
      const r3 = elsewhereRequest();
      for (let pass = 0; pass < 2; pass++) await f.o.drive(r3, { live: true });
      assert.ok(!f.roles().includes("worker:B"), f.roles().join(","));
      const recorded = questionEvents(f);
      assert.equal(recorded.length, 1, canonical(recorded));
      assert.equal(recorded[0]!.requestId, f.id);
      assert.deepEqual(recorded[0]!.question.taskIds, ["A", "B"]);
      assert.equal(recorded[0]!.question.askedBy, owedBy);
      assert.equal(
        (f.o.inspect(r3) as any).otherRequestQuestions?.find(
          (q: any) => q.id === recorded[0]!.question.id,
        )?.requestId,
        f.id,
      );
      // The owner's answer there lets B run here.
      f.o.reply(
        f.id,
        ownerReply(recorded[0]!.question.id, "Wait for closeout"),
      );
      for (let pass = 0; pass < 3 && !f.roles().includes("worker:B"); pass++)
        await f.o.drive(r3, { live: true });
      assert.ok(f.roles().includes("worker:B"), f.roles().join(","));
    } finally {
      f.close();
    }
  }
  // A worker run on B is refused while the question is recorded nowhere,
  // even under a current checkpoint of the receiving project that assigns B.
  {
    const { f, record, elsewhereRequest } = owing();
    try {
      const actor = f.c.localActor();
      await record();
      const r3 = elsewhereRequest();
      const assessor = f.c.reserve(
        "B",
        { role: "assessor", projectRequestId: r3, requestKey: "assess-b" },
        actor,
      );
      await f.c.execute(assessor, f.adapter, actor);
      const overseer = f.c.reserve(
        "B",
        { role: "overseer", projectRequestId: r3, requestKey: "oversight-b" },
        actor,
      );
      const receipt = await f.c.execute(overseer, f.adapter, actor);
      f.c.recordProjectCheckpoint(
        overseer.projectContext!,
        overseer.id,
        receipt.output,
      );
      assert.equal(questionEvents(f).length, 0);
      assert.throws(
        () =>
          f.c.reserve(
            "B",
            { requestKey: "owed-b", projectRequestId: r3 },
            actor,
          ),
        /PRE_DESIGN_QUESTION_NOT_RECORDED:pre-design-question:result-visibility:/,
      );
    } finally {
      f.close();
    }
  }
});

test("review round 10: a screening's stale reasons are part of Astra's bounded input, so a re-screen it needs is not refused as exhausted", async () => {
  // Project "modules" screens A clear on a decision recorded on B (outside
  // the receiving project). Project "elsewhere" holds A and inherits that
  // screening; its Astra uses up both attempts on that input. Revoking B's
  // decision stales the screening without changing that project's record or
  // A's currency.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
    overseer: (view) =>
      plan(view, {
        screenings: (v) =>
          v.preDesign.find((s: any) => s.taskId === "A").current
            ? []
            : [
                clear(v, "A", {
                  candidates: [
                    candidate("result-visibility", {
                      type: "ALREADY_DECIDED",
                      decidedBy: "dB",
                      affectedTaskIds: ["A", "B"],
                      options: [],
                      recommendation: null,
                    }),
                  ],
                }),
              ],
      }),
  });
  try {
    const actor = f.c.localActor();
    f.c.decide(
      "B",
      {
        id: "dB",
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      actor,
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A"]);
    const run = async (key: string) => {
      const a = f.c.reserve(
        "A",
        { role: "overseer", projectRequestId: r3, requestKey: key },
        actor,
      );
      assert.equal((await f.c.execute(a, f.adapter, actor)).status, "SUCCEEDED");
      return a;
    };
    const first = await run("e1");
    await run("e2");
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "overseer", projectRequestId: r3, requestKey: "e3" },
          actor,
        ),
      /PROJECT_OVERSIGHT_ATTEMPTS_EXHAUSTED/,
    );
    f.c.revoke("dB", "withdrawn", actor);
    const there = f.o.project(r3).preDesign!.find((s) => s.taskId === "A")!;
    assert.equal(
      there.hold,
      "PRE_DESIGN_SCREEN_STALE:A:CITED_DECISION_REVOKED:dB",
    );
    // That project's record and A's currency are unchanged; the stale
    // reason alone makes it a new input, with its own attempts.
    assert.equal(
      f.o.project(r3).snapshot.inputDigest,
      first.projectContext!.snapshot.inputDigest,
    );
    const after = await run("e4");
    assert.notEqual(
      oversightInputDigest(after.projectContext!),
      oversightInputDigest(first.projectContext!),
    );
  } finally {
    f.close();
  }
});

test("review round 11: a worker run reserved on a screening is refused at launch when the decision the screening cites is revoked in between", async () => {
  // Project "modules" screens A clear on a decision recorded on B. Project
  // "elsewhere" holds A only and inherits that screening; its checkpoint
  // assigns A, and A's worker is reserved. B's decision is then revoked
  // before the run starts: nothing in that project's record changes.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
    overseer: (view) =>
      view.snapshot.projectId === "project:elsewhere"
        ? plan(view)
        : plan(view, {
            assign: ["B"],
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "A").current
                ? []
                : [
                    clear(v, "A", {
                      candidates: [
                        candidate("result-visibility", {
                          type: "ALREADY_DECIDED",
                          decidedBy: "dB",
                          affectedTaskIds: ["A", "B"],
                          options: [],
                          recommendation: null,
                        }),
                      ],
                    }),
                  ],
          }),
  });
  try {
    const actor = f.c.localActor();
    f.c.decide(
      "B",
      {
        id: "dB",
        text: "Wait for closeout",
        sourceRef: "test:owner",
        alternatives: [],
        limits: [],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        artifactRevision: "r1",
      },
      actor,
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.records("A").length, 1);
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module A elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["A"]);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: r3, requestKey: "oversight-a" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    const worker = f.c.reserve(
      "A",
      { requestKey: "worker-a", projectRequestId: r3 },
      actor,
    );
    f.c.revoke("dB", "withdrawn", actor);
    await assert.rejects(
      f.c.execute(worker, f.adapter, actor),
      /PRE_DESIGN_SCREEN_STALE:A:CITED_DECISION_REVOKED:dB/,
    );
    assert.ok(!f.roles().includes("worker:A"), f.roles().join(","));
    assert.notEqual(
      f.c.inspect("A").attempts.find((a: any) => a.id === worker.id)?.state,
      "STARTED",
    );
  } finally {
    f.close();
  }
});

test("review round 11: a question owed in another project is recorded there on its own tasks' specifications, though an unrelated task there waits to be rebound", async () => {
  // Project "modules" records a checkpoint without its question: A's
  // screening owes a choice affecting A and B. Its unrelated task C is then
  // revised and not rebound, so that project's record cannot be read.
  // Project "elsewhere" holds only B.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }, { id: "C" }],
    overseer: (view) =>
      view.snapshot.projectId === "project:elsewhere"
        ? plan(view)
        : plan(view, {
            assign: [],
            screenings: [
              requiresOwner(view, "A", [
                candidate("result-visibility", { affectedTaskIds: ["A", "B"] }),
              ]),
            ],
          }),
  });
  try {
    const actor = f.c.localActor();
    const assessor = f.c.reserve(
      "A",
      { role: "assessor", projectRequestId: f.id, requestKey: "assess" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "A",
      { role: "overseer", projectRequestId: f.id, requestKey: "oversight" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    const c = f.c.task("C");
    f.c.revise(
      "C",
      { ...c, scope: c.scope + " (revised)", specVersion: 2 },
      actor,
    );
    assert.throws(() => f.o.project(f.id), /PROJECT_SPEC_CHANGED:C/);
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module B elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["B"]);
    for (let pass = 0; pass < 2; pass++) await f.o.drive(r3, { live: true });
    // The question is recorded once, in the first project, and holds B.
    const recorded = f.db
      .all<{ body: string }>(
        "SELECT body FROM events WHERE kind='WORKFLOW_QUESTION' ORDER BY seq",
      )
      .map((r) => JSON.parse(r.body));
    assert.equal(recorded.length, 1, canonical(recorded));
    assert.equal(recorded[0]!.requestId, f.id);
    assert.deepEqual(recorded[0]!.question.taskIds, ["A", "B"]);
    assert.equal(recorded[0]!.question.askedBy, overseer.id);
    assert.ok(!f.roles().includes("worker:B"), f.roles().join(","));
    assert.ok(
      !f.db
        .all<{ body: string }>(
          "SELECT body FROM events WHERE kind='WORKFLOW_STEP' ORDER BY seq",
        )
        .some((r) =>
          /PROJECT_SPEC_CHANGED:C/.test(
            String(JSON.parse(r.body).step?.detail ?? ""),
          ),
        ),
      "the unrelated revision blocked nothing in the receiving project",
    );
  } finally {
    f.close();
  }
});

test("review round 12: a worker run on a task without the opt-in is refused at launch once an owner choice covering it is recorded after its reservation", async () => {
  // B (not opted in) belongs to projects "modules" and "elsewhere".
  // "elsewhere" assigns B and B's worker is reserved there. Then "modules"
  // screens A and records a choice affecting A and B, while B's run is
  // still waiting to be spawned. One run per project at a time means only
  // another project can record it then.
  const f = fixture({
    tasks: [{ id: "A", ...opted("REQUIRED") }, { id: "B" }],
    overseer: (view) =>
      view.snapshot.projectId === "project:elsewhere"
        ? plan(view)
        : plan(view, {
            assign: [],
            screenings: (v) =>
              v.preDesign.find((s: any) => s.taskId === "A").latest
                ? []
                : [
                    requiresOwner(v, "A", [
                      candidate("result-visibility", {
                        affectedTaskIds: ["A", "B"],
                      }),
                    ]),
                  ],
          }),
  });
  try {
    const actor = f.c.localActor();
    const r3 = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Reuse module B elsewhere",
      context: { cwd: f.root, projectKey: "elsewhere" },
      sourceRef: "test:owner-3",
    }).request.id;
    f.o.attach(r3, ["B"]);
    const assessor = f.c.reserve(
      "B",
      { role: "assessor", projectRequestId: r3, requestKey: "assess-b" },
      actor,
    );
    await f.c.execute(assessor, f.adapter, actor);
    const overseer = f.c.reserve(
      "B",
      { role: "overseer", projectRequestId: r3, requestKey: "oversight-b" },
      actor,
    );
    const receipt = await f.c.execute(overseer, f.adapter, actor);
    f.c.recordProjectCheckpoint(
      overseer.projectContext!,
      overseer.id,
      receipt.output,
    );
    const worker = f.c.reserve(
      "B",
      { requestKey: "worker-b", projectRequestId: r3 },
      actor,
    );
    assert.equal(f.c.launchRefusal(worker), undefined, "admitted when reserved");
    // "modules" advances: its Astra screens A and the choice is recorded.
    await f.o.drive(f.id, { live: true });
    const choice = f
      .open()
      .find((q: any) => q.key.startsWith(PRE_DESIGN_QUESTION_PREFIX))!;
    assert.ok(choice, canonical(f.open()));
    assert.deepEqual([...choice.taskIds].sort(), ["A", "B"]);
    // The launch gate, as the runner asks it just before spawning, refuses
    // B's waiting run.
    assert.equal(
      f.c.launchRefusal(worker),
      "PRE_DESIGN_OWNER_CHOICE_OPEN:" + choice.id,
    );
    assert.ok(!f.roles().includes("worker:B"), f.roles().join(","));
  } finally {
    f.close();
  }
});
