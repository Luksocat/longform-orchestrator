import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { canonical, digest, TaskSchema } from "../src/domain.js";
import { Orchestrator, RESERVED_QUESTION_KEYS } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { RoutingPolicySchema } from "../src/routing.js";
import {
  checkpointCurrent,
  covers,
  planQuestions,
  projectSnapshot,
  runInputDigest,
  type ProjectContext,
  type ProjectPlan,
} from "../src/project.js";
import { OVERSEER_VIEW_HEADING, TASK_VIEW_HEADING, projectView } from "../src/project-view.js";
import { explainHold } from "../src/holds.js";
import type { ProviderAdapter, ProviderReceipt, ProviderRequest } from "../src/providers.js";

const configured = JSON.parse(
  readFileSync(new URL("./fixtures/adaptive/two-tier-policy.json", import.meta.url), "utf8"),
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

type Scoped = { question: string; taskIds: string[]; projectWide: boolean };
type Plan = {
  outcome?: ProjectPlan["outcome"];
  assign?: string[];
  owner?: Scoped[];
  operator?: Scoped[];
};
const onA = (question: string): Scoped => ({ question, taskIds: ["A"], projectWide: false });
const projectWide = (question: string): Scoped => ({ question, taskIds: [], projectWide: true });

function plan(ctx: ProjectContext, p: Plan = {}) {
  const open = ctx.snapshot.tasks.filter((t) => !["VERIFIED", "ACCEPTED"].includes(t.task.status));
  const assign =
    p.assign ??
    open
      .map((t) => t.task.id)
      .filter((id) => !ctx.snapshot.questions.some((q) => !q.answers.length && covers(q, id)));
  return canonical({
    inputDigest: ctx.snapshot.inputDigest,
    summary: "Keep the three greetings consistent.",
    outcome: p.outcome ?? (open.length ? "CONTINUE" : "COMPLETE"),
    assignments: assign.map((taskId) => ({ taskId, instruction: "Write the greeting for " + taskId })),
    nextTaskIds: assign,
    milestones: [],
    technicalDecisions: [],
    risks: [],
    questionsForOwner: p.owner ?? [],
    questionsForOperator: p.operator ?? [],
  });
}

/**
 * A two-tier project of three tasks: A, B (unrelated) and C (depends on A).
 * Astra answers with `overseer(context, call)`; a worker can act mid-run.
 */
function fixture(
  options: {
    overseer?: (ctx: ProjectContext, call: number) => string;
    onWorker?: (taskId: string, f: any) => void;
    workerOutput?: (taskId: string) => string;
    /** The tasks the first request binds (default all three). */
    attach?: string[];
    /** Whether a reviewer run fails without a report (default never). */
    reviewerFails?: () => boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "question-routing-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const requests: ProviderRequest[] = [];
  let overseerCalls = 0;
  const f: any = { root, db, requests };
  const adapter: ProviderAdapter = {
    async execute(r) {
      requests.push(r);
      const p = (r.outputSchema as any)?.properties;
      let output = "";
      if (r.role === "assessor")
        output = canonical({
          taskId: r.taskId,
          specDigest: p.specDigest.enum[0],
          touches: { driveDocuments: [], codePaths: [], domainRules: false, canonicalText: false, ownerDecision: false },
          breaksIfWrong: "The greeting is wrong",
          tierHint: "COMPLEX",
          reason: "Bounded local work",
        });
      else if (r.role === "overseer") {
        const context = JSON.parse(
          r.brief.slice(r.brief.indexOf(OVERSEER_VIEW_HEADING) + OVERSEER_VIEW_HEADING.length),
        ) as ProjectContext;
        output = options.overseer?.(context, overseerCalls++) ?? plan(context);
      } else if (r.role === "worker") {
        mkdirSync(join(r.cwd, "output", r.taskId), { recursive: true });
        writeFileSync(join(r.cwd, "output", r.taskId, "hello.txt"), "hello\n");
        options.onWorker?.(r.taskId, f);
        output = options.workerOutput?.(r.taskId) ?? "Created greeting.";
      } else if (r.role === "reviewer" && options.reviewerFails?.()) {
        return {
          runId: r.runId,
          taskId: r.taskId,
          provider: r.provider,
          model: r.model,
          effort: r.effort,
          sessionId: randomUUID(),
          exitCode: 1,
          status: "FAILED",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          output: "reviewer failed in this test",
          tests: [],
          costUsd: 0.01,
          tokens: 10,
          identityVerified: false,
          simulation: false,
        } satisfies ProviderReceipt;
      } else if (r.role === "reviewer") {
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
          scope: "greeting",
          nextAuthorizedStep: "bind evidence",
          auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({
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
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy(),
    verifyRoutingCapability: () => true,
    projectProfile: { version: 1, protectedDocuments: [], protectedFolders: [], codePaths: ["output"] },
  });
  const o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
  const id = o.submit({
    requestKey: randomUUID(),
    prompt: "Write three greetings",
    context: { cwd: root, projectKey: "greetings" },
    sourceRef: "test:owner",
  }).request.id;
  const source = o.ownerSource(id);
  const tasks = (["A", "B", "C"] as const).map((tid) =>
    TaskSchema.parse({
      id: tid,
      programme: "TEST",
      lane: "LOCAL",
      title: "Greeting " + tid,
      scope: "Write greeting " + tid,
      deliverable: "output/" + tid + "/hello.txt",
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
      sources: [{ ...source, evidenceId: source.evidenceId + "-" + tid }],
      specificationAuthenticated: true,
      providers: ["claude", "codex"],
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      writePaths: ["output/" + tid],
      dependencies: tid === "C" ? ["A"] : [],
      risk: "LOW",
      reviewPolicy: { required: true, crossProvider: true, independentAudits: true },
      acceptance: [{ id: "greeting", description: "A greeting", evidenceKind: "LOCAL" }],
      simulation: false,
      budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 },
    }),
  );
  c.importTasks(tasks, c.localActor());
  const grants: Record<string, string> = {};
  for (const t of tasks) {
    grants[t.id] = randomUUID();
    c.grant(
      t.id,
      { id: grants[t.id]!, operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: t.writePaths, decisionText: "Write it", sourceRef: "test:owner" },
      c.localActor(),
    );
  }
  o.attach(id, options.attach ?? ["A", "B", "C"]);
  Object.assign(f, {
    c,
    o,
    id,
    grants,
    roles: () => requests.map((r) => r.role + ":" + r.taskId),
    /** Another request in the same project, binding these tasks. */
    second: (taskIds: string[]) => {
      const r2 = o.submit({
        requestKey: randomUUID(),
        prompt: "More greetings",
        context: { cwd: root, projectKey: "greetings" },
        sourceRef: "test:owner-2",
      }).request.id;
      o.attach(r2, taskIds);
      return r2;
    },
    overseerCalls: () => overseerCalls,
    attempt: (taskId: string, role = "worker") =>
      c.inspect(taskId).attempts.filter((a: any) => a.role === role).at(-1),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  return f;
}
const operatorReply = (questionId: string, key: string) => ({
  questionId,
  replyKey: key,
  text: "The gateway log for run X is at runs/X/drive-gateway.log, sha256 ab12.",
  sourceRef: "operator:records",
  answeredAs: "OPERATOR" as const,
  evidence: ["run X", "runs/X/drive-gateway.log sha256:ab12"],
});

test("Astra can ask the operator about A and assign B in one checkpoint: B runs and is reviewed, C waits on its dependency, and asking costs no extra Astra run", async () => {
  // The same advance without the question, for the count of Astra runs (an
  // assessment recorded after a checkpoint is a new input, as before).
  const plain = fixture({ overseer: (ctx, call) => (call === 0 ? plan(ctx, { assign: ["B", "C"] }) : plan(ctx)) });
  let expected: number;
  try {
    await plain.o.drive(plain.id, { live: true });
    const roles: string[] = plain.roles();
    expected = roles.slice(0, roles.indexOf("worker:B")).filter((r) => r.startsWith("overseer")).length;
  } finally {
    plain.close();
  }
  const f = fixture({
    overseer: (ctx, call) =>
      call === 0 ? plan(ctx, { assign: ["B", "C"], operator: [onA("Is A's earlier run still held?")] }) : plan(ctx),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    const roles: string[] = f.roles();
    const firstWorkerB = roles.indexOf("worker:B");
    assert.ok(firstWorkerB > 0, roles.join(","));
    assert.equal(roles.slice(0, firstWorkerB).filter((r) => r.startsWith("overseer")).length, expected, roles.join(","));
    assert.ok(roles.includes("reviewer:B"));
    assert.ok(!roles.includes("worker:A") && !roles.includes("worker:C"), roles.join(","));
    const question = view.questions.find((q: any) => q.status === "OPEN")!;
    assert.equal(question.audience, "OPERATOR");
    assert.deepEqual(question.taskIds, ["A"]);
    assert.equal(question.projectWide, false);
    assert.equal(question.key.startsWith("overseer-operator-question:"), true);
    assert.notEqual(view.status, "WAITING_INPUT");
    // C is held by the normal dependency gate, not by the question.
    assert.ok(f.c.reasons("C").some((r: string) => r.startsWith("DEPENDENCY_NOT_CURRENT_ACCEPTED:A")));
    // No owner decision or grant came from the operator question.
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.db.all("SELECT * FROM grants").length, 3);
  } finally {
    f.close();
  }
});

test("a project-wide question stops the request; nothing runs until it is answered", async () => {
  const f = fixture({
    overseer: (ctx, call) =>
      call === 0
        ? plan(ctx, { outcome: "ASK_OWNER", assign: [], owner: [projectWide("Should the greetings rhyme? 1) No (Recommended): simpler. 2) Yes: playful.")] })
        : plan(ctx),
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.equal(view.status, "WAITING_INPUT");
    assert.ok(!f.roles().some((r: string) => r.startsWith("worker")));
    const before = f.requests.length;
    view = await f.o.drive(f.id, { live: true });
    assert.equal(f.requests.length, before, "a second advance runs nothing");
    const q = view.questions[0]!;
    assert.equal(q.projectWide, true);
    // The operator cannot answer an owner question.
    assert.throws(() => f.o.reply(f.id, operatorReply(q.id, "op-1")), /OPERATOR_CANNOT_ANSWER_OWNER_QUESTION/);
    f.o.reply(f.id, { questionId: q.id, replyKey: "owner-1", text: "No", sourceRef: "test:owner" });
    await f.o.drive(f.id, { live: true });
    assert.ok(f.roles().includes("worker:A"));
  } finally {
    f.close();
  }
});

test("after a task-scoped ASK checkpoint Astra plans once more and can assign uncovered work; an identical question is not recorded twice and nothing loops", async () => {
  // Astra asks about A, then assigns B with the question still open.
  const g = fixture({
    overseer: (ctx, call) =>
      call === 0 ? plan(ctx, { outcome: "ASK_OPERATOR", assign: [], operator: [onA("Where is A's source file?")] }) : plan(ctx),
  });
  try {
    await g.o.drive(g.id, { live: true });
    assert.ok(g.roles().includes("worker:B"), g.roles().join(","));
    assert.ok(!g.roles().includes("worker:A"));
    assert.equal(g.o.inspect(g.id).questions.length, 1);
  } finally {
    g.close();
  }
  // Astra asks the same question again: it is not recorded again, and the
  // next advance does not run Astra again for nothing.
  const f = fixture({
    overseer: (ctx) => plan(ctx, { outcome: "ASK_OPERATOR", assign: [], operator: [onA("Where is A's source file?")] }),
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.o.inspect(f.id).questions.length, 1);
    const calls = f.overseerCalls();
    assert.equal(calls, 2);
    await f.o.drive(f.id, { live: true });
    assert.equal(f.overseerCalls(), calls, "no new Astra run without new inputs");
    assert.ok(!f.roles().some((r: string) => r.startsWith("worker")));
  } finally {
    f.close();
  }
});

test("recording and answering A's operator question while B runs does not stop B", async () => {
  const f = fixture({
    overseer: (ctx) => plan(ctx, { assign: ["B"] }),
    onWorker: (taskId, f) => {
      if (taskId !== "B") return;
      const q = f.o.ask(f.id, { key: "op-a", text: "Is A's earlier run reconciled?", audience: "OPERATOR", taskIds: ["A"] });
      f.o.reply(f.id, operatorReply(q.id, "op-a-1"));
    },
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.attempt("B").state, "SUCCEEDED");
    assert.ok(f.roles().includes("reviewer:B"));
    const q = f.o.inspect(f.id).questions[0]!;
    assert.equal(q.status, "ANSWERED");
    const reply = f.db
      .all("SELECT body FROM events WHERE kind='WORKFLOW_REPLY'")
      .map((r: any) => JSON.parse(r.body).reply)[0];
    assert.equal(reply.answeredAs, "OPERATOR");
    assert.equal(reply.grantsAuthority, false);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
  } finally {
    f.close();
  }
});

for (const change of ["owner answer", "grant revocation"] as const)
  test(`${change === "owner answer" ? "an" : "a"} ${change} during B's run still stops B`, async () => {
    let question = "";
    const f = fixture({
      overseer: (ctx) => plan(ctx, { assign: ["B"] }),
      onWorker: (taskId, f) => {
        if (taskId !== "B") return;
        if (change === "owner answer")
          f.o.reply(f.id, { questionId: question, replyKey: "owner-a", text: "Formal", sourceRef: "test:owner" });
        else f.c.revokeGrant(f.grants.A, "test: owner withdrew A's grant", f.c.localActor());
      },
    });
    try {
      question = f.o.ask(f.id, { key: "owner-a", text: "Formal or casual for A?", taskId: "A" }).id;
      await f.o.drive(f.id, { live: true });
      assert.notEqual(f.attempt("B").state, "SUCCEEDED");
      assert.ok(!f.roles().includes("reviewer:B"));
    } finally {
      f.close();
    }
  });

test("a worker's operator questions hold its review until the operator answers from the records", async () => {
  const f = fixture({
    overseer: (ctx) => plan(ctx, { assign: ["B"] }),
    workerOutput: (taskId) =>
      taskId === "B" ? "Created greeting.\n\nQUESTIONS FOR THE OPERATOR:\nWhich checksum did the gateway log record for the source file?" : "Created greeting.",
  });
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.ok(!f.roles().includes("reviewer:B"));
    const q = view.questions.find((x: any) => x.key.startsWith("worker-operator-question:"))!;
    assert.equal(q.audience, "OPERATOR");
    assert.deepEqual(q.taskIds, ["B"]);
    assert.equal(q.kind, "INFORMATION");
    assert.throws(
      () => f.o.reply(f.id, { questionId: q.id, replyKey: "no-evidence", text: "It is ab12", sourceRef: "operator", answeredAs: "OPERATOR" }),
      /OPERATOR_ANSWER_REQUIRES_EVIDENCE/,
    );
    f.o.reply(f.id, operatorReply(q.id, "op-b"));
    view = await f.o.drive(f.id, { live: true });
    const review = f.requests.find((r: ProviderRequest) => r.role === "reviewer" && r.taskId === "B")!;
    assert.ok(review, f.roles().join(","));
    assert.match(review.brief, /OPERATOR ANSWERS \(factual; no owner authority\)/);
    assert.doesNotMatch(review.brief, /OWNER ANSWERS \(from/);
  } finally {
    f.close();
  }
});

test("questions must declare a scope, controller keys are reserved, and replies cannot carry authority", () => {
  const f = fixture();
  try {
    assert.throws(() => f.o.ask(f.id, { key: "q", text: "Which?" }), /QUESTION_SCOPE_REQUIRED/);
    assert.throws(() => f.o.ask(f.id, { key: "q", text: "Which?", taskId: "A", projectWide: true }), /QUESTION_SCOPE_AMBIGUOUS/);
    for (const prefix of RESERVED_QUESTION_KEYS)
      for (const audience of ["OWNER", "OPERATOR"] as const)
        assert.throws(
          () => f.o.ask(f.id, { key: prefix + "x", text: "Which?", taskId: "A", audience }),
          /QUESTION_KEY_RESERVED/,
          prefix,
        );
    const q = f.o.ask(f.id, { key: "op", text: "Where is the file?", audience: "OPERATOR", taskIds: ["A", "B"] });
    assert.deepEqual(q.taskIds, ["A", "B"]);
    assert.equal(q.taskId, undefined, "several tasks: code that predates scopes reads it as request-wide");
    for (const extra of [
      { grant: { operations: ["WRITE_LOCAL"] } },
      { decision: "approve" },
      { acceptance: true },
      { operations: ["MERGE"] },
    ])
      assert.throws(() => f.o.reply(f.id, { ...operatorReply(q.id, "r-" + Object.keys(extra)[0]), ...extra } as any), /Unrecognized key/);
    f.o.reply(f.id, operatorReply(q.id, "r-ok"));
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.db.all("SELECT * FROM grants").length, 3);
  } finally {
    f.close();
  }
});

test("operational exchanges about other tasks leave a run's inputs unchanged; owner answers and project-wide questions change them", () => {
  const f = fixture();
  try {
    const at = () => projectSnapshot(f.db, f.id);
    const before = at();
    const op = f.o.ask(f.id, { key: "op", text: "Where?", audience: "OPERATOR", taskId: "A" });
    f.o.reply(f.id, operatorReply(op.id, "op-1"));
    const owner = f.o.ask(f.id, { key: "own", text: "Formal?", taskId: "A" });
    let now = at();
    assert.notEqual(now.inputDigest, before.inputDigest, "the project fingerprint is not narrowed");
    assert.equal(runInputDigest(now, "worker", "B"), runInputDigest(before, "worker", "B"));
    assert.notEqual(runInputDigest(now, "worker", "A"), runInputDigest(before, "worker", "A"));
    assert.equal(runInputDigest(now, "overseer", "B"), now.inputDigest);
    f.o.reply(f.id, { questionId: owner.id, replyKey: "own-1", text: "Formal", sourceRef: "test:owner" });
    now = at();
    assert.notEqual(runInputDigest(now, "worker", "B"), runInputDigest(before, "worker", "B"), "an owner answer counts");
    const mid = at();
    f.o.ask(f.id, { key: "wide", text: "Pause?", audience: "OPERATOR", projectWide: true });
    assert.notEqual(runInputDigest(at(), "worker", "B"), runInputDigest(mid, "worker", "B"), "a project-wide question counts");
  } finally {
    f.close();
  }
});

test("a CONTINUE checkpoint stays current despite its own unanswered questions; an ASK checkpoint does not", () => {
  const f = fixture();
  try {
    const snap = projectSnapshot(f.db, f.id);
    const checkpoint = (outcome: "CONTINUE" | "ASK_OPERATOR") => ({
      projectId: snap.projectId,
      requestId: f.id,
      runId: "astra-run",
      inputDigest: snap.inputDigest,
      revision: 1,
      plan: JSON.parse(plan({ requestId: f.id, snapshot: snap, decisionHistory: [] } as any, { outcome, assign: outcome === "CONTINUE" ? ["B"] : [], operator: [onA("Where?")] })),
    });
    (f.o as any).askScoped(
      f.id,
      { key: "overseer-operator-question:astra-run:0", text: "Where?", audience: "OPERATOR", taskIds: ["A"] },
      { reserved: true, askedBy: "astra-run" },
    );
    const after = projectSnapshot(f.db, f.id);
    assert.equal(checkpointCurrent(after, checkpoint("CONTINUE") as any), true);
    assert.equal(checkpointCurrent(after, checkpoint("ASK_OPERATOR") as any), false);
    // Once answered, Astra re-checks.
    const q = f.o.inspect(f.id).questions[0]!;
    f.o.reply(f.id, operatorReply(q.id, "op-1"));
    assert.equal(checkpointCurrent(projectSnapshot(f.db, f.id), checkpoint("CONTINUE") as any), false);
  } finally {
    f.close();
  }
});

test("views show each question's audience and scope, and an operational section with what clears each hold", () => {
  const f = fixture();
  try {
    f.o.ask(f.id, { key: "op", text: "Where is A's file?", audience: "OPERATOR", taskId: "A" });
    f.o.ask(f.id, { key: "own", text: "Formal for A?", taskId: "A" });
    const context = f.c.projectContextFor(f.id);
    const a = { id: "preview-run", taskId: "A", role: "worker", projectContext: context } as any;
    const brief = (f.c as any).briefParts(f.c.task("A"), { ...a, provider: "claude", model: "m", effort: "e", specDigest: "", artifactRevision: "r1", workspace: "", state: "RESERVED", leaseOwner: "", leaseUntil: 0, started: false, simulation: false, baseline: {}, macroBaseline: "", condition: "", requestKey: "" }, true).text as string;
    const view = JSON.parse(brief.slice(brief.indexOf(TASK_VIEW_HEADING) + TASK_VIEW_HEADING.length));
    assert.deepEqual(view.ownerQuestions.map((q: any) => [q.audience, q.taskIds]), [["OWNER", ["A"]]]);
    assert.deepEqual(view.operatorQuestions.map((q: any) => [q.audience, q.taskIds]), [["OPERATOR", ["A"]]]);
    // C waits on A: its hold and what clears it are in its operational view.
    const operational = f.c.operationalState(["C"]);
    assert.ok(operational.tasks[0]!.holds.some((h: string) => h.startsWith("DEPENDENCY_NOT_CURRENT_ACCEPTED:A")));
    const why = operational.explanations.find((x: any) => x.hold === "DEPENDENCY_NOT_CURRENT_ACCEPTED")!;
    assert.match(why.clearedBy, /accepted/);
    assert.equal(why.authority, "the owner");
    assert.match(operational.note, /grants nothing/);
    // Legacy plans: string questions are read as project-wide owner questions.
    assert.deepEqual(planQuestions({ questionsForOwner: ["Old?"] }), {
      owner: [{ question: "Old?", taskIds: [], projectWide: true }],
      operator: [],
    });
  } finally {
    f.close();
  }
});

test("a question recorded before scopes existed is replayed by key, with or without the projectWide flag", () => {
  const f = fixture();
  try {
    const legacyInput = { key: "legacy", text: "Which wording?", kind: "INFORMATION" };
    (f.o as any).append(f.id, "WORKFLOW_QUESTION", {
      question: { id: randomUUID(), ...legacyInput, actor: "owner", createdAt: new Date().toISOString() },
      inputDigest: digest(legacyInput),
    });
    const first = f.o.ask(f.id, { key: "legacy", text: "Which wording?" });
    assert.equal(f.o.ask(f.id, { key: "legacy", text: "Which wording?", projectWide: true }).id, first.id);
    assert.throws(() => f.o.ask(f.id, { key: "legacy", text: "Other?", projectWide: true }), /REPLAY_MISMATCH/);
    // Read as a project-wide owner question, as before.
    const view = f.o.inspect(f.id);
    assert.equal(view.status, "WAITING_INPUT");
    assert.equal(view.questions[0]!.projectWide, true);
  } finally {
    f.close();
  }
});

test("an owner's answer to an operator question about A still changes B's inputs (review S2-1)", () => {
  const f = fixture();
  try {
    const before = projectSnapshot(f.db, f.id);
    const q = f.o.ask(f.id, { key: "op", text: "Where?", audience: "OPERATOR", taskId: "A" });
    assert.equal(runInputDigest(projectSnapshot(f.db, f.id), "worker", "B"), runInputDigest(before, "worker", "B"));
    f.o.reply(f.id, { questionId: q.id, replyKey: "own", text: "Here, and keep it formal", sourceRef: "test:owner", answeredAs: "OWNER" });
    assert.notEqual(runInputDigest(projectSnapshot(f.db, f.id), "worker", "B"), runInputDigest(before, "worker", "B"));
  } finally {
    f.close();
  }
});

test("an Astra question on A in one request holds A's review when another request advances it (review S2-2)", async () => {
  let failing = true;
  const f = fixture({ overseer: (ctx) => plan(ctx, { assign: ["A"] }), reviewerFails: () => failing });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "WAITING_REVIEW", f.roles().join(","));
    (f.o as any).recordAstraQuestions(f.id, {
      runId: "astra-run",
      plan: { questionsForOwner: [], questionsForOperator: [onA("Is A's source the current one?")] },
    });
    const r2 = f.second(["A"]);
    failing = false;
    const reviews = () => f.roles().filter((r: string) => r === "reviewer:A").length;
    const before = reviews();
    const view = await f.o.drive(r2, { live: true });
    assert.equal(reviews(), before, "no review while the question is open");
    assert.ok(view.tasks[0]!.holds.some((h: string) => h.startsWith("PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST:")));
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", requestKey: randomUUID(), projectRequestId: r2 }, f.c.localActor()),
      /PROJECT_QUESTION_OPEN/,
    );
  } finally {
    f.close();
  }
});

test("Astra may ask about a task another request binds, and assign its own (review S2-3)", async () => {
  const f = fixture({
    attach: ["A"],
    overseer: (ctx, call) =>
      call === 0 ? plan(ctx, { assign: ["B"], operator: [onA("Is A's earlier run settled?")] }) : plan(ctx),
  });
  try {
    // B's specification source is the first request's text (as fixture()
    // binds it); record that evidence without binding B to that request.
    (f.o as any).recordOwnerSources(f.id, ["B"]);
    const r2 = f.second(["B"]);
    const view = await f.o.drive(r2, { live: true });
    assert.ok(f.roles().includes("worker:B"), f.roles().join(","));
    const q = view.questions.find((x: any) => x.key.startsWith("overseer-operator-question:"))!;
    assert.deepEqual(q.taskIds, ["A"]);
    assert.ok(f.o.inspect(f.id).tasks[0]!.holds.some((h: string) => h === "PROJECT_QUESTION_OPEN_IN_OTHER_REQUEST:" + q.id));
  } finally {
    f.close();
  }
});

test("identical questions in one checkpoint, or one checkpoint seen through two requests, are recorded once (review S2-4)", async () => {
  const f = fixture({
    overseer: (ctx) =>
      plan(ctx, { outcome: "ASK_OPERATOR", assign: [], operator: [onA("Where is A's file?"), onA("Where is A's file?")] }),
  });
  try {
    await f.o.drive(f.id, { live: true });
    const r2 = f.second(["B"]);
    await f.o.drive(r2, { live: true });
    const all = f.db
      .all("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'")
      .map((r: any) => JSON.parse(r.body).question);
    assert.equal(all.length, 1, JSON.stringify(all.map((q: any) => q.key)));
  } finally {
    f.close();
  }
});

test("fitting never drops a hold's code or command from the operational section (review S2-5)", () => {
  const f = fixture();
  try {
    const context = f.c.projectContextFor(f.id);
    const operational = {
      note: "state",
      tasks: [{ taskId: "A", holds: ["ATTEMPT_BUDGET_EXHAUSTED"], unresolvedRuns: [{ runId: "r1", role: "worker", state: "UNKNOWN", since: "x", reason: "y".repeat(300) }] }],
      explanations: [explainHold("ATTEMPT_BUDGET_EXHAUSTED"), explainHold("UNKNOWN_RUN")],
    };
    for (const role of ["worker", "overseer"]) {
      const view = projectView(context, role, "A", { operational });
      const smallest = view.fit(view.smallest)!.text;
      assert.match(smallest, /ATTEMPT_BUDGET_EXHAUSTED/, role);
      assert.match(smallest, /budget-extend/, role);
      assert.match(smallest, /UNKNOWN_RUN/, role);
      assert.match(smallest, /"r1"/, role);
    }
  } finally {
    f.close();
  }
});

test("source holds name only commands that can clear them (review S2-6)", () => {
  for (const code of ["MISSING_SOURCE:x", "STALE_SOURCE:x", "SUPERSEDED_SOURCE:x", "UNAUTHENTICATED_SOURCE:x", "NO_AUTHENTICATED_SPECIFICATION_SOURCE"]) {
    const x = explainHold(code);
    assert.doesNotMatch(String(x.command), /drive-evidence|bind/, code);
  }
  assert.equal(explainHold("MISSING_SOURCE:x").command, null);
  assert.match(String(explainHold("STALE_SOURCE:x").command), /revise/);
});

test("an Astra question already in another of the project's requests, by key or as an open equal, is not recorded again at insertion (review S2-7)", () => {
  const f = fixture();
  try {
    const r2 = f.second(["A"]);
    (f.o as any).recordAstraQuestions(f.id, {
      runId: "astra-run",
      plan: { questionsForOwner: [], questionsForOperator: [onA("Where is A's file?")] },
    });
    const first = f.o.inspect(f.id).questions[0]!;
    // As a second process would, after reading before the first one wrote.
    for (const key of ["overseer-operator-question:astra-run:0", "overseer-operator-question:astra-other:0"]) {
      const again = (f.o as any).askScoped(
        r2,
        { key, text: "Where is A's file?", kind: "INFORMATION", audience: "OPERATOR", taskIds: ["A"] },
        { reserved: true, askedBy: key.split(":")[1] },
      );
      assert.equal(again.id, first.id, key);
    }
    assert.equal(f.db.all("SELECT body FROM events WHERE kind='WORKFLOW_QUESTION'").length, 1);
  } finally {
    f.close();
  }
});

test("a request whose open work waits only on another request's question waits for input and says where to answer (review S2-8)", () => {
  const f = fixture();
  try {
    const r2 = f.second(["A"]);
    const q = f.o.ask(f.id, { key: "op-a", text: "Is A's source current?", audience: "OPERATOR", taskId: "A" });
    let view = f.o.inspect(r2) as any;
    assert.equal(view.status, "WAITING_INPUT");
    assert.deepEqual(view.otherRequestQuestions.map((x: any) => [x.id, x.requestId]), [[q.id, f.id]]);
    assert.ok(view.nextSteps.some((s: string) => s.includes("another request of the same project")));
    f.o.reply(f.id, operatorReply(q.id, "op-a-1"));
    view = f.o.inspect(r2);
    assert.notEqual(view.status, "WAITING_INPUT");
    assert.equal(view.otherRequestQuestions, undefined);
  } finally {
    f.close();
  }
});
