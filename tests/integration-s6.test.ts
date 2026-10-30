import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { canonical, specDigest, TaskSchema, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { RoutingPolicySchema } from "../src/routing.js";
import { checkpointCurrent, covers, type ProjectContext } from "../src/project.js";
import { OVERSEER_VIEW_HEADING, PROJECT_ARCHIVE_PATH } from "../src/project-view.js";
import {
  MAX_BRIEF_CHARS,
  OWNER_TEXT_IN_SANDBOX,
  type ProviderAdapter,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";
import { driveRequests } from "../src/driver.js";
import { claimsConflict, driveFileClaim } from "../src/claims.js";
import { FilingPlanSchema } from "../src/filing.js";
import { fakeDrive } from "./fake-drive.js";

// S6: the combined integration proof (owner command 2026-10-26, "S6:
// combined integration proof"). One scenario on one disposable database,
// with scripted fake providers and the in-memory Drive. Every phase below
// runs on the same database file; "restart" closes the store and opens a
// fresh SqliteStore, Controller and Orchestrator on that file.

const now = () => new Date().toISOString();
const configured = JSON.parse(
  readFileSync(new URL("./fixtures/adaptive/two-tier-policy.json", import.meta.url), "utf8"),
);
/** The deployed two-tier policy (Sol works, Opus reviews, Astra oversees on Codex). */
function policy() {
  return RoutingPolicySchema.parse({
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
}
/** The pre-switch shape: either provider works or reviews at every tier. */
function legacyPolicy() {
  return RoutingPolicySchema.parse({
    version: 1,
    id: "legacy-s6",
    routes: (["claude", "codex"] as const).flatMap((provider) =>
      (["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"] as const).map((level) => {
        const model = provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol";
        return {
          id: `${provider}-${level.toLowerCase()}`,
          level,
          provider,
          model,
          effort: "high",
          roles: ["worker", "reviewer"],
          simulation: false,
          enabled: true,
          capability: {
            provider,
            model,
            effort: "high",
            verifiedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            evidenceRef: "test:attested",
          },
        };
      }),
    ),
  });
}

/** Two Drive files from the fake Drive: N is shared by B1 and B2; M is B1's alone. */
const N = "notesAAAAAAAAAAA";
const M = "otherAAAAAAAAAAA";
/** Each gamma task's record: long enough that four of them overflow one brief. */
const RECORD_CHARS = 34_000;
/**
 * Space-separated words of about `chars` characters. Long text is made of
 * words: redaction takes seconds on one 65,000-letter run (see the report).
 */
const words = (tag: string, chars: number) => {
  const parts: string[] = [];
  for (let n = 0, i = 0; n < chars; i++) {
    parts.push(tag + i);
    n += tag.length + String(i).length + 1;
  }
  return parts.join(" ").slice(0, chars);
};
const record = (id: string) =>
  `TASK-${id}-RECORD-START ` + words("scope" + id + "w", RECORD_CHARS) + ` TASK-${id}-RECORD-END`;
/** Two owner requests in project gamma, each near the request size limit (65,536). */
const GAMMA_FIRST = "GAMMA-FIRST-OWNER-TEXT " + words("first", 65_000);
const GAMMA_SECOND = "GAMMA-SECOND-OWNER-TEXT " + words("second", 65_000);
const projectOf = (taskId: string) =>
  taskId.startsWith("A") ? "alpha" : taskId.startsWith("B") ? "beta" : taskId.startsWith("G") ? "gamma" : "delta";

test("S6 integration: two projects under the driver, fitted briefs, owner-text files, scoped Astra questions, operator answers, a Codex limit with Claude work going on and Astra waiting, recovery from the retained workspace, filing against a worker, a request pause and a restart, on one database", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-s6-")));
  const dbPath = join(root, "state.sqlite");
  const workspaceRoot = join(root, "workspaces");
  const drive = fakeDrive();
  mkdirSync(join(root, "creds"));
  writeFileSync(join(root, "creds", "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  writeFileSync(join(root, "creds", "token.json"), JSON.stringify({ refresh_token: "r" }));
  const credentials = { clientFile: join(root, "creds", "client.json"), tokenFile: join(root, "creds", "token.json") };
  mkdirSync(join(root, "filing"));
  const notesFile = join(root, "filing", "notes.md");
  const otherFile = join(root, "filing", "other.md");
  writeFileSync(notesFile, "B1 notes, reviewed\n");
  writeFileSync(otherFile, "B1 other file, reviewed\n");
  const stateDir = join(root, "state");

  // ---------------------------------------------------------------------------
  // The fake providers: one scripted adapter for both Codex and Claude. It
  // records every request, which runs are in flight per project, and what
  // the provider pauses were at each launch.
  // ---------------------------------------------------------------------------
  const cur = {} as { db: SqliteStore; c: Controller; o: Orchestrator };
  const requests: ProviderRequest[] = [];
  type Call = { i: number; role: string; provider: string; taskId: string; runId: string; project: string; codex: string; claude: string };
  const calls: Call[] = [];
  const problems: string[] = [];
  const inFlight = new Map<string, string>();
  const overlaps: string[][] = [];
  let sameProjectOverlaps = 0;
  const workerRuns = new Map<string, number>();
  let activeDrives = 0;
  let l1Reviews = 0;
  const ids = { RA: "", RB: "", RC: "", RC2: "", RD: "" };
  const obs: {
    firstGammaOverseer?: { request: ProviderRequest; archive: ProjectContext; manifest: any; files: Record<string, string> };
    questionWhileOpen?: { status: string; question: any; workerA1Calls: number };
    answer?: { at: number; before: any; after: any; questionId: string; a2Run: string };
    filingDuringB1?: { error: string; driveCalls: [number, number]; b1Run: string };
    pause?: { at: number; g1Run: string };
    resumed?: { sawHalf: boolean; runId: string; brief: string };
    duringB2?: { filing: string; projectRun: string; b2Run: string };
  } = {};
  /**
   * Authority as the records hold it: owner decisions, grants and
   * acceptances, as rows and as journal events.
   */
  const count = (sql: string) => cur.db.get<{ n: number }>(sql)!.n;
  const authority = () => ({
    decisions: count("SELECT COUNT(*) AS n FROM decisions"),
    grants: count("SELECT COUNT(*) AS n FROM grants"),
    acceptanceBindings: count("SELECT COUNT(*) AS n FROM acceptance_bindings"),
    events: count(
      "SELECT COUNT(*) AS n FROM events WHERE kind IN ('OWNER_DECISION','GRANT_RECORDED','ACCEPTANCE_EVIDENCE_BOUND','AUTHORIZED_ACCEPTANCE')",
    ),
  });

  /**
   * Astra's plan: assign every open task no unanswered question holds; ask
   * the operator about A1 once. The first time every task of a project has a
   * passing review of its sealed work, Astra claims completion, although no
   * task is verified (verification needs acceptance evidence nobody binds in
   * this scenario): the controller must refuse that checkpoint.
   */
  const proposedComplete = new Set<string>();
  function astraPlan(ctx: ProjectContext) {
    const unanswered = ctx.snapshot.questions.filter((q: any) => !q.answers.length);
    const open = ctx.snapshot.tasks
      .filter((t) => !["VERIFIED", "ACCEPTED"].includes(t.task.status))
      .map((t) => t.task.id);
    const askA1 = open.includes("A1") && !ctx.snapshot.questions.some((q: any) => covers(q, "A1"));
    const assign = open.filter(
      (id) => !(askA1 && id === "A1") && !unanswered.some((q: any) => covers(q, id)),
    );
    const allReviewed = ctx.snapshot.tasks.every(
      (t: any) => t.artifact && t.task.status === "WAITING_REVIEW" && t.reviews.at(-1)?.verdict === "PASS",
    );
    const complete = !open.length || (allReviewed && !unanswered.length && !proposedComplete.has(ctx.snapshot.projectId));
    if (complete) {
      proposedComplete.add(ctx.snapshot.projectId);
      return canonical({
        inputDigest: ctx.snapshot.inputDigest,
        summary: "Every task has a passing review; the project looks complete.",
        outcome: "COMPLETE",
        assignments: [],
        nextTaskIds: [],
        milestones: [],
        technicalDecisions: [],
        risks: [],
        questionsForOwner: [],
        questionsForOperator: [],
      });
    }
    return canonical({
      inputDigest: ctx.snapshot.inputDigest,
      summary: "Keep each project's outputs within their recorded scopes.",
      outcome: "CONTINUE",
      assignments: assign.map((taskId) => ({ taskId, instruction: "Do " + taskId + " within its recorded scope." })),
      nextTaskIds: assign,
      milestones: [],
      technicalDecisions: [],
      risks: [],
      questionsForOwner: [],
      questionsForOperator: askA1
        ? [
            {
              question: "Is task A1's earlier source record still the current one in the controller's records?",
              taskIds: ["A1"],
              projectWide: false,
            },
          ]
        : [],
    });
  }
  const receipt = (r: ProviderRequest, output: string, extra: Partial<ProviderReceipt> = {}): ProviderReceipt => ({
    runId: r.runId,
    taskId: r.taskId,
    provider: r.provider,
    model: r.model,
    effort: r.effort,
    sessionId: randomUUID(),
    exitCode: 0,
    status: "SUCCEEDED",
    startedAt: now(),
    endedAt: now(),
    output,
    tests: [],
    costUsd: 0.01,
    tokens: 10,
    identityVerified: true,
    simulation: false,
    ...extra,
  });
  const adapter: ProviderAdapter = {
    async execute(r) {
      requests.push(r);
      const project = projectOf(r.taskId);
      const call: Call = {
        i: calls.length,
        role: r.role,
        provider: r.provider,
        taskId: r.taskId,
        runId: r.runId,
        project,
        codex: cur.c.providerPause("codex").state,
        claude: cur.c.providerPause("claude").state,
      };
      calls.push(call);
      if ([...inFlight.values()].includes(project)) sameProjectOverlaps++;
      inFlight.set(r.runId, project);
      const projects = [...new Set(inFlight.values())].sort();
      if (projects.length > 1) overlaps.push(projects);
      try {
        // Yield, so the other projects' advances reach their own launches.
        await new Promise((done) => setImmediate(done));
        const p = (r.outputSchema as any)?.properties;
        if (r.role === "assessor")
          return receipt(
            r,
            canonical({
              taskId: r.taskId,
              specDigest: p.specDigest.enum[0],
              touches: { driveDocuments: [], codePaths: [], domainRules: false, canonicalText: false, ownerDecision: false },
              breaksIfWrong: "The task's output is wrong",
              tierHint: "COMPLEX",
              reason: "Bounded local work",
            }),
          );
        if (r.role === "overseer") {
          // The full record is in Astra's workspace; the brief's view is fitted.
          const archive = JSON.parse(readFileSync(join(r.cwd, PROJECT_ARCHIVE_PATH), "utf8")) as ProjectContext;
          try {
            const view = JSON.parse(r.brief.slice(r.brief.indexOf(OVERSEER_VIEW_HEADING) + OVERSEER_VIEW_HEADING.length));
            if (view.snapshot.inputDigest !== archive.snapshot.inputDigest)
              problems.push("overseer view and archive differ for run " + r.runId);
          } catch (error) {
            problems.push("overseer view unreadable for run " + r.runId + ": " + String(error));
          }
          if (project === "gamma" && !obs.firstGammaOverseer) {
            const dir = r.ownerText?.dir;
            const manifest = dir ? JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8")) : undefined;
            const files: Record<string, string> = {};
            for (const f of manifest?.files ?? []) files[f.file] = readFileSync(join(dir!, f.file), "utf8");
            obs.firstGammaOverseer = { request: r, archive, manifest, files };
          }
          return receipt(r, astraPlan(archive));
        }
        if (r.role === "worker") {
          const n = (workerRuns.get(r.taskId) ?? 0) + 1;
          workerRuns.set(r.taskId, n);
          const dir = join(r.cwd, "output", r.taskId);
          mkdirSync(dir, { recursive: true });
          if (r.taskId === "A3" && n === 1) {
            // Partial work, then Codex's usage limit cuts the run off.
            writeFileSync(join(dir, "half.txt"), "half\n");
            return receipt(r, "limit", {
              exitCode: 1,
              status: "FAILED",
              identityVerified: false,
              costUsd: 1.25,
              tokens: 900,
              providerLimit: {
                kind: "USAGE_LIMIT",
                evidence: 'codex session log: task_complete error.codex_error_info "usage_limit_exceeded"',
                resetsAt: new Date(clockNow() + 30 * 60_000).toISOString(),
                resetBasis: "STRUCTURED",
                message: "You've hit your usage limit.",
              },
            });
          }
          if (r.taskId === "A3" && n === 2)
            obs.resumed = {
              sawHalf: existsSync(join(dir, "half.txt")) && readFileSync(join(dir, "half.txt"), "utf8") === "half\n",
              runId: r.runId,
              brief: r.brief,
            };
          if (r.taskId === "A2" && n === 1) {
            // While A2's worker runs, the operator answers Astra's question on A1.
            const view = cur.o.inspect(ids.RA);
            const q = view.questions.find((x: any) => x.status === "OPEN" && x.audience === "OPERATOR");
            obs.questionWhileOpen = {
              status: view.status,
              question: q,
              workerA1Calls: calls.filter((x) => x.role === "worker" && x.taskId === "A1").length,
            };
            if (q) {
              const before = authority();
              cur.o.reply(ids.RA, {
                questionId: q.id,
                replyKey: "operator-a1-source",
                text: "Yes: A1's source record is the owner request's evidence entry, unchanged since it was recorded.",
                sourceRef: "operator:records",
                answeredAs: "OPERATOR",
                evidence: ["evidence " + cur.c.task("A1").sources[0]!.evidenceId, "events: no SOURCE_SUPERSEDED for A1"],
              });
              obs.answer = { at: call.i, before, after: authority(), questionId: q.id, a2Run: r.runId };
            }
          }
          if (r.taskId === "B1" && n === 1) {
            // A filing of the same Drive file while this worker holds it is refused before any Drive call.
            const before = drive.calls.length;
            const error = await cur.c
              .fileTask(
                "B1",
                FilingPlanSchema.parse({ update: [{ fileId: N, path: notesFile }], reason: "File B1 early", sourceRef: "test:owner" }),
                cur.c.localActor(),
                { credentials, stateDir, fetcher: drive.fetcher as never },
              )
              .then(
                () => "FILED",
                (e) => String(e),
              );
            obs.filingDuringB1 = { error, driveCalls: [before, drive.calls.length], b1Run: r.runId };
          }
          if (r.taskId === "B2" && n === 1) {
            let filing = "ACQUIRED";
            try {
              const id = cur.c.acquireFilingClaims("B1", { update: [{ fileId: N }], create: [] }, specDigest(cur.c.task("B1")), cur.c.localActor());
              cur.c.releaseFilingClaims(id);
            } catch (error) {
              filing = String(error);
            }
            let projectRun = "RESERVED";
            try {
              cur.c.reserve("B1", { role: "overseer", projectRequestId: ids.RB, requestKey: "s6-probe:" + randomUUID() }, cur.c.localActor());
            } catch (error) {
              projectRun = String(error);
            }
            obs.duringB2 = { filing, projectRun, b2Run: r.runId };
          }
          if (r.taskId === "G1" && n === 1) {
            cur.o.pauseRequest(ids.RC, { text: "Hold gamma after this run", sourceRef: "test:owner" });
            obs.pause = { at: call.i, g1Run: r.runId };
          }
          if (r.driveWrites) {
            // The run's Drive write, through the controller's intent hooks as the gateway makes it.
            const intent = r.driveWrites.begin({ kind: "update", fileId: N });
            r.driveWrites.end(intent, { applied: true, fileId: N });
          }
          writeFileSync(join(dir, "hello.txt"), "hello from " + r.taskId + "\n");
          return receipt(r, "Created the output for " + r.taskId + ".");
        }
        if (r.role === "reviewer") {
          const fail = r.taskId === "L1" && !l1Reviews++;
          const ev = p.availableEvidence.items.enum;
          return receipt(
            r,
            canonical({
              taskId: r.taskId,
              artifactRevision: p.artifactRevision.enum[0],
              specDigest: p.specDigest.enum[0],
              provider: r.provider,
              authorshipDisclosure: "Independent session",
              availableEvidence: ev,
              findings: fail ? [{ materiality: "MAJOR", evidenceIds: [], description: "The greeting needs correction" }] : [],
              testsExecuted: [],
              testsNotExecuted: ["No executable test configured"],
              conflictingEvidence: [],
              remediation: fail ? ["Correct the greeting"] : [],
              residualHolds: [],
              verdict: fail ? "FAIL" : "PASS",
              scope: "output",
              nextAuthorizedStep: "bind evidence",
              auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({
                kind,
                result: "PASS",
                evidenceIds: ev,
                assessment: "Matches scope",
                limitations: [],
              })),
            }),
          );
        }
        throw new Error("Unexpected role " + r.role);
      } finally {
        inFlight.delete(r.runId);
      }
    },
  };
  const open = (routing: () => ReturnType<typeof policy>) => {
    const db = new SqliteStore(dbPath);
    const c = new Controller(db, {
      ownerUid: process.getuid!(),
      workspaceRoot,
      allowRealLocalTasks: true,
      routingPolicy: routing(),
      verifyRoutingCapability: () => true,
      projectProfile: { version: 1, protectedDocuments: [], protectedFolders: [], codePaths: ["output"] },
      // Provider pauses are judged by the drivers' clock, so a reset comes
      // when the driver's wait for it has passed (no real waiting).
      pauseClock: () => clockNow(),
    });
    const o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
    // Count advances in flight, so the test clock stands still while one runs.
    const real = o.drive.bind(o);
    (o as any).drive = async (id: string, mode: any) => {
      activeDrives++;
      try {
        return await real(id, mode);
      } finally {
        activeDrives--;
      }
    };
    return { db, c, o };
  };
  /** A controller and driver restart: a fresh store, controller and orchestrator on the same database file. */
  const restart = (routing: () => ReturnType<typeof policy>) => {
    cur.db.close();
    Object.assign(cur, open(routing));
  };
  const submit = (projectKey: string, prompt: string) =>
    cur.o.submit({ requestKey: randomUUID(), prompt, context: { cwd: root, projectKey }, sourceRef: "test:owner-" + projectKey }).request.id;
  const makeTask = (requestId: string, id: string, options: { scope?: string; update?: string[] } = {}): Task => {
    const source = cur.o.ownerSource(requestId);
    const driveTask = !!options.update;
    return TaskSchema.parse({
      id,
      programme: "S6",
      lane: "LOCAL",
      title: "Output " + id,
      scope: options.scope ?? "Write the output for " + id,
      deliverable: "output/" + id + "/hello.txt",
      specVersion: 1,
      status: "DISCOVERED",
      artifactRevision: "r1",
      createdAt: now(),
      dimensions: {
        authorization: driveTask ? "EXPLICIT" : "LOCAL_ONLY",
        sourceEffectuation: "CANDIDATE",
        implementation: "NOT_STARTED",
        review: "NONE",
        release: "NOT_AUTHORIZED",
      },
      sources: [{ ...source, evidenceId: source.evidenceId + "-" + id }],
      specificationAuthenticated: true,
      providers: ["claude", "codex"],
      operations: driveTask ? ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"] : ["READ_LOCAL", "WRITE_LOCAL"],
      writePaths: driveTask ? ["output/" + id, "drive-changes"] : ["output/" + id],
      ...(driveTask ? { drive: { read: "ANY", update: options.update, createIn: [] } } : {}),
      risk: "LOW",
      reviewPolicy: { required: true, crossProvider: true, independentAudits: true },
      acceptance: [{ id: "out", description: "The output", evidenceKind: "LOCAL" }],
      simulation: false,
      budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 },
    });
  };
  /** The owner registers the tasks, grants each its own scope, and binds them to the request. */
  const register = (requestId: string, tasks: Task[]) => {
    const actor = cur.c.localActor();
    cur.c.importTasks(tasks, actor);
    for (const t of tasks)
      cur.c.grant(
        t.id,
        { id: randomUUID(), operations: [...t.operations], paths: [...t.writePaths], decisionText: "Do " + t.id, sourceRef: "test:owner" },
        actor,
      );
    cur.o.attach(requestId, tasks.map((t) => t.id));
  };
  const attempt = (runId: string) => {
    const row = cur.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId);
    return row ? JSON.parse(row.body) : undefined;
  };
  const attempts = (taskId: string, role: string) =>
    cur.db
      .all<{ body: string }>("SELECT body FROM attempts WHERE task_id=? AND role=? ORDER BY rowid", taskId, role)
      .map((x) => JSON.parse(x.body));
  const events = (kind: string) =>
    cur.db.all<{ body: string }>("SELECT body FROM events WHERE kind=? ORDER BY seq", kind).map((x) => JSON.parse(x.body));
  const steps = (requestId: string, taskId: string) =>
    (cur.o.inspect(requestId).tasks.find((t: any) => t.taskId === taskId) as any).steps as Array<{ stage: string; outcome: string; detail: string }>;
  // The drivers' clock: real time plus the waits it asked for. A wait passes
  // at once, but only while no advance is in flight (the driver races its
  // sleeps against running advances); otherwise it lasts until the driver
  // ends it, so the test does not depend on machine speed.
  /**
   * A task's sealed work has a passing review, and verification waits only
   * for acceptance evidence (which nobody binds in this scenario).
   */
  const reviewedAwaitingEvidence = (requestId: string, taskId: string) => {
    const worker = attempts(taskId, "worker").filter((a) => a.state === "SUCCEEDED").at(-1);
    const review = cur.db
      .all<{ body: string }>("SELECT body FROM reviews WHERE task_id=? ORDER BY rowid", taskId)
      .map((x) => JSON.parse(x.body))
      .at(-1);
    assert.ok(worker && review, "sealed and reviewed: " + taskId);
    assert.equal(review.verdict, "PASS", taskId);
    assert.equal(review.workspaceDigest, worker.workspaceDigest, "the review is of the current sealed work: " + taskId);
    assert.equal(cur.c.task(taskId).status, "WAITING_REVIEW", taskId);
    assert.ok(
      steps(requestId, taskId).some((x) => x.stage === "VERIFY" && x.outcome === "HELD" && /MISSING_ACCEPTANCE_EVIDENCE/.test(x.detail)),
      JSON.stringify(steps(requestId, taskId)),
    );
  };
  let skew = 0;
  const clockNow = () => Date.now() + skew;
  const testSleep =
    (sleeps: number[], onWait?: (ms: number) => void) =>
    (ms: number, signal?: AbortSignal): Promise<void> => {
      if (activeDrives > 0)
        return new Promise<void>((done) => signal?.addEventListener("abort", () => done(), { once: true }));
      sleeps.push(ms);
      onWait?.(ms);
      skew += ms;
      return Promise.resolve();
    };

  Object.assign(cur, open(legacyPolicy));
  try {
    // =========================================================================
    // Phase 0, before the switch to the two-tier policy: project delta's task
    // L1 gets a Claude draft that a Codex review fails. Its rework stays with
    // Claude (legacy pairing) and needs Astra's checkpoint once two-tier.
    // =========================================================================
    ids.RD = submit("delta", "DELTA: keep the greeting written before the switch.");
    register(ids.RD, [makeTask(ids.RD, "L1")]);
    await cur.o.drive(ids.RD, { live: true });
    assert.deepEqual(
      calls.map((x) => x.role + ":" + x.provider),
      ["worker:claude", "reviewer:codex"],
    );
    assert.equal(cur.c.task("L1").status, "REMEDIATION_REQUIRED");
    restart(policy);
    assert.equal(cur.c.legacyClaudeAuthorship(cur.c.task("L1")), true);
    const legacyCalls = calls.length;

    // =========================================================================
    // Setup under the two-tier policy. Alpha: three small tasks (Astra's
    // operator question, the operator's answer, the provider limit). Beta: a
    // Drive task. Gamma: two owner requests near the size limit and four
    // tasks with 34,000-character records (its request is paused mid-run).
    // =========================================================================
    ids.RA = submit("alpha", "ALPHA: write three outputs.");
    ids.RB = submit("beta", "BETA: write the notes and file them to Drive.");
    ids.RC = submit("gamma", GAMMA_FIRST);
    ids.RC2 = submit("gamma", GAMMA_SECOND);
    register(ids.RA, ["A1", "A2", "A3"].map((id) => makeTask(ids.RA, id)));
    register(ids.RB, [makeTask(ids.RB, "B1", { update: [N, M] })]);
    register(ids.RC, ["G1", "G2", "G3", "G4"].map((id) => makeTask(ids.RC, id, { scope: record(id) })));
    const setupAuthority = authority();
    assert.equal(setupAuthority.decisions, 0);
    assert.equal(setupAuthority.acceptanceBindings, 0);

    // =========================================================================
    // Phase 1: the driver serves alpha, beta and gamma concurrently. Its
    // budget (10 virtual minutes) ends while Codex is paused, so it returns
    // saying what each request waits for. The clock records waits instead
    // of sleeping; the controller judges provider pauses by the same clock
    // (its other leases keep real time).
    // =========================================================================
    const sleeps1: number[] = [];
    const run1 = await driveRequests(cur.o, {
      live: true,
      requestIds: [ids.RA, ids.RB, ids.RC],
      maxMinutes: 10,
      maxAdvances: 40,
      clock: { now: clockNow, sleep: testSleep(sleeps1) },
    });
    assert.deepEqual(problems, []);

    // (1) Concurrency: alpha's and beta's runs were in flight at once; never two of one project.
    assert.ok(
      overlaps.some((p) => p.includes("alpha") && p.includes("beta")),
      "alpha and beta ran at the same time: " + JSON.stringify(overlaps.slice(0, 5)),
    );
    assert.equal(sameProjectOverlaps, 0, "one run per project at a time");
    for (const project of ["alpha", "beta"])
      assert.ok(calls.slice(legacyCalls).some((x) => x.project === project), project + " was served");

    // (4) Astra's operator question holds only A1; A2 went on while it was open.
    const asked = obs.questionWhileOpen!;
    assert.ok(asked?.question, "the question was open during A2's run");
    assert.equal(asked.question.audience, "OPERATOR");
    assert.deepEqual(asked.question.taskIds, ["A1"]);
    assert.equal(asked.question.projectWide, false);
    assert.ok(asked.question.key.startsWith("overseer-operator-question:"));
    assert.notEqual(asked.status, "WAITING_INPUT", "the request was not stopped");
    assert.equal(asked.workerA1Calls, 0, "no A1 work while its question was open");
    assert.ok(
      steps(ids.RA, "A1").some((s) => s.outcome === "HELD" && /REQUEST_HAS_OPEN_QUESTIONS|PROJECT_TASK_NOT_ASSIGNED|PROJECT_OWNER_QUESTION_OPEN/.test(s.detail)),
      JSON.stringify(steps(ids.RA, "A1")),
    );

    // (5) The operator's factual answer, recorded during A2's run, left A2's run valid.
    const answer = obs.answer!;
    assert.ok(answer, "answered during A2's run");
    const reply = events("WORKFLOW_REPLY").map((e) => e.reply).find((x) => x.questionId === answer.questionId);
    assert.equal(reply.answeredAs, "OPERATOR");
    assert.equal(reply.grantsAuthority, false);
    assert.ok(reply.evidence.length >= 1);
    assert.deepEqual(answer.after, answer.before, "the operator's answer created no decision, grant or acceptance");
    assert.equal(attempt(answer.a2Run).state, "SUCCEEDED");
    reviewedAwaitingEvidence(ids.RA, "A2");
    assert.ok(!events("RUN_STOPPED_BY_CONTROLLER").some((e) => e.runId === answer.a2Run));

    // (6) Codex's usage limit cut A3's worker off after partial work: Codex is
    // paused, nothing launched on Codex after it, and Claude reviews went on.
    const a3First = attempts("A3", "worker")[0];
    assert.equal(a3First.state, "FAILED");
    assert.equal(a3First.interruption.cause, "PROVIDER_LIMIT");
    assert.equal(a3First.interruption.snapshot.resumable, true);
    const limit = events("PROVIDER_LIMIT_OBSERVED").find((e) => e.runId === a3First.id);
    assert.ok(limit && limit.provider === "codex" && limit.validResetAt, JSON.stringify(limit));
    const pauseNow = cur.c.providerPause("codex");
    assert.equal(pauseNow.state, "PAUSED");
    const limitCall = calls.findIndex((x) => x.runId === a3First.id);
    const afterLimit = calls.slice(limitCall + 1);
    assert.deepEqual(afterLimit.filter((x) => x.provider === "codex"), [], "no Codex launch while paused");
    assert.ok(
      afterLimit.some((x) => x.role === "reviewer" && x.provider === "claude" && x.codex === "PAUSED"),
      "Claude review work went on: " + afterLimit.map((x) => x.role + ":" + x.provider + ":" + x.taskId).join(","),
    );
    const a3Receipt = JSON.parse(cur.db.get<{ body: string }>("SELECT body FROM receipts WHERE attempt_id=?", a3First.id)!.body);
    assert.deepEqual([a3Receipt.costUsd, a3Receipt.tokens], [1.25, 900], "the interrupted run's usage stays recorded");
    // The driver's budget ended before the reset: it reports the wait rather than giving up or looping.
    assert.ok(sleeps1.length >= 1 && sleeps1.reduce((a, b) => a + b, 0) <= 10 * 60_000, JSON.stringify(sleeps1));
    const r1 =(id: string) => run1.results.find((x) => x.requestId === id)!;
    assert.equal(r1(ids.RA).outcome, "WAITING_UNTIL", JSON.stringify(r1(ids.RA)));
    assert.equal(r1(ids.RA).until, pauseNow.until);

    // (7) Alpha's closing checkpoint waits for Codex; Astra is never moved to Claude.
    assert.ok(
      steps(ids.RA, "A1").some((s) => s.stage === "PROJECT_OVERSIGHT" && /PROVIDER_PAUSED:codex/.test(s.detail)),
      JSON.stringify(steps(ids.RA, "A1")),
    );
    assert.ok(requests.filter((x) => x.role === "overseer").every((x) => x.provider === "codex"));

    // =========================================================================
    // Phase 2 (11): a controller and driver restart while the pause is
    // recorded. The fresh driver honours it, runs no Codex work and no Claude
    // work that needs Astra (delta's legacy rework), and waits for the reset.
    // The controller judges pauses by the same clock, so when the driver's
    // wait has passed the reset the pause turns to RECHECK by itself: one
    // Codex run tests the provider, and its success clears the pause. No
    // operator clears anything.
    // =========================================================================
    restart(policy);
    assert.equal(cur.c.providerPause("codex").state, "PAUSED", "the pause survives the restart");
    assert.equal((cur.o.inspect(ids.RA) as any).providerPauses[0].provider, "codex");
    const restartCalls = calls.length;
    const pausedUntil = Date.parse(cur.c.providerPause("codex").until!);
    const authorityBeforeReset = authority();
    const sleeps2: number[] = [];
    const run2 = await driveRequests(cur.o, {
      live: true,
      requestIds: [ids.RA, ids.RB, ids.RC, ids.RD],
      maxMinutes: 120,
      maxAdvances: 60,
      clock: { now: clockNow, sleep: testSleep(sleeps2) },
    });
    assert.deepEqual(problems, []);
    const afterRestart = calls.slice(restartCalls);
    const firstCodex = afterRestart.findIndex((x) => x.provider === "codex");
    assert.ok(firstCodex >= 0, "Codex work ran after the reset: " + JSON.stringify(sleeps2));
    const clearedAt = restartCalls + firstCodex;
    assert.ok(sleeps2.length >= 1, "the restarted driver waited for the reset");
    // Before the reset nothing ran on Codex; the first Codex run came when the
    // pause had turned to RECHECK, and it held the recheck.
    assert.deepEqual(afterRestart.slice(0, firstCodex).filter((x) => x.provider === "codex"), []);
    assert.equal(afterRestart[firstCodex]!.codex, "RECHECK", JSON.stringify(afterRestart[firstCodex]));
    const tester = cur.db
      .all<{ body: string }>("SELECT body FROM attempts")
      .map((x) => JSON.parse(x.body))
      .find((a) => a.id === afterRestart[firstCodex]!.runId);
    assert.ok(tester.recheckOf !== undefined, "the first Codex run after the reset was the recheck");
    // The pause was cleared by that run's success, never by an operator.
    const clears = events("PROVIDER_PAUSE_CLEARED");
    assert.ok(clears.some((e) => e.provider === "codex" && e.by?.runId === tester.id), JSON.stringify(clears));
    assert.deepEqual(clears.filter((e) => e.by?.operator), [], "no operator cleared a pause");
    assert.equal(cur.c.providerPause("codex").state, "CLEAR");
    assert.ok(clockNow() >= pausedUntil, "the reset had come");
    assert.deepEqual(authority(), authorityBeforeReset, "the automatic recovery created no authority");
    const beforeClear = calls.slice(restartCalls, clearedAt);
    assert.deepEqual(beforeClear.filter((x) => x.taskId === "L1"), [], "delta's Claude rework waited for Astra");
    assert.ok(
      steps(ids.RD, "L1").some((s) => s.stage === "PROJECT_OVERSIGHT" && /PROVIDER_PAUSED:codex/.test(s.detail)),
      JSON.stringify(steps(ids.RD, "L1")),
    );
    // After the reset: Astra on Codex first, then the Claude rework, reviewed by Codex.
    const l1After = calls.slice(clearedAt).filter((x) => x.taskId === "L1").map((x) => x.role + ":" + x.provider);
    assert.deepEqual(l1After.slice(0, 2), ["overseer:codex", "worker:claude"], l1After.join(","));
    assert.ok(l1After.includes("reviewer:codex"));
    reviewedAwaitingEvidence(ids.RD, "L1");

    // (8) Recovery: A3's next attempt at the same step resumed the retained workspace.
    const a3Workers = attempts("A3", "worker");
    assert.equal(a3Workers.length, 2);
    assert.equal(a3Workers[1].resumes, a3First.id);
    assert.equal(a3Workers[1].step, a3First.step);
    assert.equal(a3Workers[1].state, "SUCCEEDED");
    assert.equal(obs.resumed?.runId, a3Workers[1].id);
    assert.equal(obs.resumed?.sawHalf, true, "the partial work was there when it started");
    assert.match(obs.resumed!.brief, /cut off by the provider's usage limit/);
    assert.ok(calls.findIndex((x) => x.runId === a3Workers[1].id) >= clearedAt, "only after the reset");
    for (const id of ["A1", "A2", "A3"]) reviewedAwaitingEvidence(ids.RA, id);
    const r2 = (id: string) => run2.results.find((x) => x.requestId === id)!;
    // The driver returns saying what each waits for, instead of looping.
    for (const id of [ids.RA, ids.RD]) {
      assert.equal(r2(id).outcome, "HELD", JSON.stringify(r2(id)));
      assert.match(r2(id).detail, /MISSING_ACCEPTANCE_EVIDENCE/);
    }

    // (10) Gamma was paused during G1's run: the run finished and was recorded,
    // nothing more started for gamma, and the other requests went on.
    const paused = obs.pause!;
    assert.ok(paused, "gamma's pause was recorded during G1's run");
    assert.equal(attempt(paused.g1Run).state, "SUCCEEDED");
    assert.deepEqual(calls.slice(paused.at + 1).filter((x) => x.project === "gamma"), [], "nothing new for gamma");
    assert.ok(calls.slice(paused.at + 1).some((x) => x.project !== "gamma"), "other requests went on");
    assert.equal(r2(ids.RC).outcome, "PAUSED");
    if (paused.at < restartCalls) assert.equal(r2(ids.RC).advances, 0, "a paused request is not advanced after a restart");
    assert.ok(!events("RUN_STOPPED_BY_CONTROLLER").some((e) => e.runId === paused.g1Run));
    assert.deepEqual(
      cur.db.all("SELECT id FROM attempts WHERE task_id IN ('G2','G3','G4')"),
      [],
      "gamma's other tasks never had a run",
    );

    // (2) Old overseer briefs inlined every open task's full record: gamma's
    // records alone, and with the owner's text, exceed one brief. The brief
    // Astra actually got fits (every brief is checked again at the end).
    const first = obs.firstGammaOverseer!;
    assert.ok(first, "Astra ran for gamma");
    const openEntries = first.archive.snapshot.tasks.filter((t) => !["VERIFIED", "ACCEPTED"].includes(t.task.status));
    assert.equal(openEntries.length, 4);
    const recordsChars = openEntries.reduce((n, e) => n + canonical(e).length, 0);
    assert.ok(recordsChars > MAX_BRIEF_CHARS, `open records ${recordsChars} > ${MAX_BRIEF_CHARS}`);
    assert.ok(recordsChars + GAMMA_FIRST.length + GAMMA_SECOND.length > MAX_BRIEF_CHARS);
    assert.ok(first.request.brief.length <= MAX_BRIEF_CHARS, String(first.request.brief.length));
    // The anchored task's record is whole; the other open tasks' records are left out (indexed).
    assert.ok(first.request.brief.includes(record(first.request.taskId)));
    const wholeRecords = openEntries.filter((e) => first.request.brief.includes(record(e.task.id))).length;
    assert.ok(wholeRecords < openEntries.length, "records whole in Astra's brief: " + wholeRecords);

    // (3) Owner-text fallback: the owner's words reach Astra byte for byte in
    // files bound to the request, its version and the run, and the brief
    // says to read them first.
    const ownerRun = first.request;
    for (const text of [GAMMA_FIRST, GAMMA_SECOND])
      for (const at of [1_000, 30_000, 64_000])
        assert.ok(!ownerRun.brief.includes(text.slice(at, at + 300)), "the owner's words are not inlined");
    assert.match(ownerRun.brief, /OWNER'S REQUEST TEXT: .*Read each whole file before you act/);
    assert.equal(ownerRun.ownerText?.required, true);
    assert.equal(first.manifest.runId, ownerRun.runId);
    for (const [requestId, text] of [
      [ids.RC, GAMMA_FIRST],
      [ids.RC2, GAMMA_SECOND],
    ] as const) {
      const file = "request-" + requestId + ".txt";
      assert.equal(first.files[file], text, "byte for byte: " + file);
      const entry = first.manifest.files.find((x: any) => x.requestId === requestId);
      assert.equal(entry.file, file);
      assert.equal(entry.sha256, cur.o.ownerSource(requestId).digest);
      assert.equal(entry.requestInputDigest, (cur.o.inspect(requestId) as any).request.inputDigest);
      assert.ok(ownerRun.brief.includes(OWNER_TEXT_IN_SANDBOX + "/" + file));
      assert.ok(ownerRun.brief.includes(entry.sha256));
      assert.ok(ownerRun.ownerText!.files.some((f) => f.file === file && f.sha256 === entry.sha256));
    }
    assert.ok(!ownerRun.ownerText!.dir.startsWith(workspaceRoot), "outside every workspace");
    assert.ok(ownerRun.ownerText!.dir.includes(ownerRun.runId), "the run's own folder");

    // =========================================================================
    // Phase 3 (9): filing and a worker contend for Drive file N. The owner
    // adds B2 (which also updates N) while B1's reviewed notes are filed. The
    // filing holds N, so B2's worker is refused during it; after it, B2's
    // worker holds N and a filing is refused. The filing's second write (M)
    // gets no answer from Drive: its intent stays uncertain, on purpose.
    // =========================================================================
    // During B1's worker run (phase 1 or 2), filing N was refused before any Drive call.
    const early = obs.filingDuringB1!;
    assert.ok(early, "B1's worker ran");
    assert.match(early.error, new RegExp("FILING_CLAIM_CONFLICT:" + driveFileClaim(N) + " held by run " + early.b1Run + " \\(RUN, attempt STARTED\\)"));
    assert.equal(early.driveCalls[1], early.driveCalls[0], "no Drive call was made");
    reviewedAwaitingEvidence(ids.RB, "B1");
    register(ids.RB, [makeTask(ids.RB, "B2", { update: [N] })]);
    const ownerAuthority = authority();
    let duringFiling: { claims: ReturnType<Controller["unresolvedClaims"]>; b2Workers: number } | undefined;
    const filingFetcher = async (raw: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      if (method === "PATCH" && raw.includes(N) && !duringFiling) {
        // The filing holds N now: advance beta, whose B2 wants N.
        duringFiling = { claims: cur.c.unresolvedClaims(), b2Workers: 0 };
        await cur.o.drive(ids.RB, { live: true });
        duringFiling.b2Workers = calls.filter((x) => x.taskId === "B2" && x.role === "worker").length;
      }
      if (method === "PATCH" && raw.includes(M)) {
        // Drive applies the write, and its answer is lost.
        await drive.fetcher(raw, init);
        throw new Error("socket hang up");
      }
      return drive.fetcher(raw, init);
    };
    const filed = await cur.c.fileTask(
      "B1",
      FilingPlanSchema.parse({
        update: [
          { fileId: N, path: notesFile },
          { fileId: M, path: otherFile },
        ],
        reason: "File B1's reviewed notes",
        sourceRef: "test:owner",
      }),
      cur.c.localActor(),
      { credentials, stateDir, fetcher: filingFetcher as never },
    );
    assert.deepEqual(problems, []);
    assert.ok(duringFiling, "the filing reached its update of N");
    const filingHolder = duringFiling!.claims.find((h) => h.holderKind === "filing")!.holderId;
    // At its write of N the filing held both files, and its intent for N was open.
    assert.deepEqual(
      duringFiling!.claims
        .filter((h) => h.holderKind === "filing")
        .map((h) => [h.kind, h.state, h.resource])
        .sort(),
      [
        ["CLAIM", "HELD", driveFileClaim(N)],
        ["CLAIM", "HELD", driveFileClaim(M)],
        ["INTENT", "OPEN", driveFileClaim(N)],
      ].sort(),
    );
    assert.equal(duringFiling!.b2Workers, 0, "B2's worker was not admitted while the filing held N");
    assert.ok(
      steps(ids.RB, "B2").some(
        (s) => s.stage === "WORKER_RESERVATION" && s.outcome === "HELD" && s.detail.includes("CLAIM_CONFLICT:" + driveFileClaim(N) + " held by filing " + filingHolder),
      ),
      JSON.stringify(steps(ids.RB, "B2")),
    );
    assert.equal(filed.complete, false);
    assert.equal(filed.results[0]!.fileId, N);
    assert.equal(filed.results[0]!.error, undefined);
    assert.equal(filed.results[0]!.readback, "MATCH");
    assert.match(String(filed.results[1]!.error), /DRIVE_WRITE_AMBIGUOUS/);
    const uncertain = cur.c.unresolvedClaims();
    assert.deepEqual(
      uncertain.map((h) => [h.kind, h.state, h.holderKind, h.holderId, h.resource, h.taskId]),
      [["INTENT", "UNCERTAIN", "filing", filingHolder, driveFileClaim(M), "B1"]],
      "the filing released its claims; only its uncertain write stays",
    );
    const sleeps3: number[] = [];
    const run3Calls = calls.length;
    const run3 = await driveRequests(cur.o, {
      live: true,
      requestIds: [ids.RB, ids.RC],
      maxMinutes: 120,
      maxAdvances: 30,
      clock: { now: clockNow, sleep: testSleep(sleeps3) },
    });
    assert.deepEqual(problems, []);
    const during = obs.duringB2!;
    assert.ok(during, "B2's worker was admitted once the filing let go of N");
    assert.match(during.filing, new RegExp("FILING_CLAIM_CONFLICT:" + driveFileClaim(N) + " held by run " + during.b2Run + " \\(RUN, attempt STARTED\\)"));
    // (1) One run per project: the controller refuses a second beta run while B2's runs.
    assert.match(during.projectRun, new RegExp("PROJECT_RUN_ACTIVE_OR_UNKNOWN: run " + during.b2Run + " is STARTED"));
    reviewedAwaitingEvidence(ids.RB, "B2");
    const r3 = (id: string) => run3.results.find((x) => x.requestId === id)!;
    assert.deepEqual(
      [...new Set(calls.slice(run3Calls).map((x) => x.project))],
      ["beta"],
      "only beta's work ran; paused gamma started nothing",
    );
    assert.equal(r3(ids.RC).outcome, "PAUSED");

    // =========================================================================
    // End of scenario.
    // =========================================================================
    // The event chain is valid.
    assert.equal(cur.db.verifyEvents(), true);

    // Every brief sent fits, and every request matches the run it was made for.
    assert.ok(requests.length >= 30, String(requests.length));
    for (const r of requests) {
      assert.ok(r.brief.length <= MAX_BRIEF_CHARS, `${r.role} ${r.taskId} ${r.brief.length}`);
      const a = attempt(r.runId);
      assert.ok(a, "a recorded attempt for " + r.runId);
      assert.deepEqual([a.taskId, a.role, a.provider, a.model, a.effort], [r.taskId, r.role, r.provider, r.model, r.effort]);
      const p = (r.outputSchema as any)?.properties;
      if (p?.specDigest) assert.equal(p.specDigest.enum[0], a.specDigest, r.role + " " + r.taskId);
      if (r.role === "overseer") assert.equal(p.inputDigest.enum[0], a.projectContext.snapshot.inputDigest);
    }
    // Receipts are bound to their attempts' runs and tasks.
    const receiptRows = cur.db.all<{ attempt_id: string; body: string; task_id: string; a: string }>(
      "SELECT r.attempt_id, r.body, a.task_id, a.body AS a FROM receipts r JOIN attempts a ON a.id=r.attempt_id",
    );
    assert.equal(receiptRows.length, cur.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM receipts")!.n);
    for (const row of receiptRows) {
      const rc = JSON.parse(row.body),
        a = JSON.parse(row.a);
      assert.deepEqual([rc.runId, rc.taskId, rc.provider, rc.model], [row.attempt_id, row.task_id, a.provider, a.model]);
    }
    // Artifacts: each sealed worker run's output evidence is its task's and its run's.
    const workers = cur.db
      .all<{ body: string }>("SELECT body FROM attempts WHERE role='worker' AND state='SUCCEEDED' ORDER BY rowid")
      .map((x) => JSON.parse(x.body));
    // L1's draft and rework, A1, A2, A3's resumed run, B1, B2 and G1.
    assert.deepEqual(workers.map((w) => w.taskId).sort(), ["A1", "A2", "A3", "B1", "B2", "G1", "L1", "L1"]);
    for (const w of workers) {
      const row = cur.db.get<{ task_id: string; body: string }>("SELECT task_id, body FROM evidence WHERE id=?", "output-" + w.id)!;
      assert.ok(row, "output evidence for " + w.id);
      const e = JSON.parse(row.body);
      assert.deepEqual([row.task_id, e.metadata.runId, e.metadata.workspaceDigest], [w.taskId, w.id, w.workspaceDigest]);
    }
    // Reviews: each is its reviewer run's, for that run's task and specification,
    // of a sealed worker artifact of the same task by the other provider.
    const reviews = cur.db.all<{ task_id: string; body: string }>("SELECT task_id, body FROM reviews ORDER BY rowid").map((x) => ({ task: x.task_id, ...JSON.parse(x.body) }));
    // L1's failed draft and its rework, A1, A2, A3, B1 and B2.
    assert.deepEqual(reviews.map((r) => r.task).sort(), ["A1", "A2", "A3", "B1", "B2", "L1", "L1"]);
    for (const review of reviews) {
      const a = attempt(review.runId);
      assert.deepEqual([a.role, a.taskId, a.state, a.specDigest, a.provider], ["reviewer", review.task, "SUCCEEDED", review.specDigest, review.provider]);
      assert.equal(review.taskId, review.task);
      const reviewed = workers.find((w) => w.taskId === review.task && w.workspaceDigest === review.workspaceDigest);
      assert.ok(reviewed, "the reviewed artifact is a sealed worker run of " + review.task);
      assert.equal(reviewed.specDigest, review.specDigest);
      assert.notEqual(reviewed.provider, review.provider, "cross-provider review");
    }
    // Disjoint writes: no claim any alpha run held conflicts with one any beta run held.
    const runClaims = cur.db
      .all<{ resource: string; task_id: string }>("SELECT resource, task_id FROM resource_claims WHERE holder_kind='run' AND kind='CLAIM'")
      .map((x) => ({ resource: x.resource, project: projectOf(x.task_id) }));
    const alphaClaims = runClaims.filter((x) => x.project === "alpha");
    const betaClaims = runClaims.filter((x) => x.project === "beta");
    assert.ok(alphaClaims.length > 0 && betaClaims.length > 0);
    for (const a of alphaClaims)
      for (const b of betaClaims) assert.equal(claimsConflict(a.resource as never, b.resource as never), false, a.resource + " / " + b.resource);

    // No claim or permit leaks: nothing reserved or started, nothing unknown,
    // no slot taken, no recheck token; only the intended uncertain write is held.
    assert.deepEqual(cur.db.all("SELECT id, state FROM attempts WHERE state IN ('RESERVED','STARTED','UNKNOWN')"), []);
    assert.equal(cur.c.plan().active, 0);
    assert.deepEqual(cur.c.providerPauses(), []);
    assert.deepEqual(
      cur.c.unresolvedClaims().map((h) => [h.kind, h.state, h.holderId, h.resource]),
      [["INTENT", "UNCERTAIN", filingHolder, driveFileClaim(M)]],
    );

    // Intentionally unresolved outcomes keep their custody and are reported.
    const intent = cur.c.unresolvedClaims()[0]!;
    assert.throws(
      () => cur.c.acquireFilingClaims("B1", { update: [{ fileId: M }], create: [] }, specDigest(cur.c.task("B1")), cur.c.localActor()),
      /FILING_CLAIM_CONFLICT:drive:file:otherA+ held by filing .* \(write intent UNCERTAIN\)/,
    );
    const betaView = cur.o.inspect(ids.RB);
    assert.ok(betaView.tasks.find((t: any) => t.taskId === "B1")!.holds.includes("DRIVE_WRITE_UNCERTAIN:" + intent.id), JSON.stringify(betaView.tasks.map((t: any) => t.holds)));
    const betaCompact = cur.o.compact(ids.RB) as any;
    assert.ok(betaCompact.holds.some((h: any) => h.taskId === "B1" && JSON.stringify(h.holds).includes("DRIVE_WRITE_UNCERTAIN")), JSON.stringify(betaCompact.holds));
    assert.ok(
      (r3(ids.RB).detail + r3(ids.RB).nextActions.join("\n")).includes("DRIVE_WRITE_UNCERTAIN"),
      JSON.stringify(r3(ids.RB)),
    );
    const gammaCompact = cur.o.compact(ids.RC) as any;
    assert.equal(gammaCompact.status, "PAUSED");
    assert.match(gammaCompact.pause.text, /Hold gamma after this run/);

    // Operators created no owner decisions, grants or acceptances: the only
    // authority recorded is the owner's setup grants and B2's grant.
    const end = authority();
    assert.deepEqual(end, ownerAuthority, "nothing after the owner's last grant");
    assert.equal(end.grants, setupAuthority.grants + 1);
    assert.deepEqual([end.decisions, end.acceptanceBindings], [0, 0]);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE kind IN ('OWNER_DECISION','ACCEPTANCE_EVIDENCE_BOUND','AUTHORIZED_ACCEPTANCE')"), 0);

    // Required overseer checkpoints are intact: each recorded checkpoint is a
    // Codex Astra run's, revisions run in order per project, none claims
    // completion (no task was accepted), every premature completion was
    // refused, and every two-tier worker run was reserved under a current
    // checkpoint that assigned its task.
    const checkpoints = events("PROJECT_CHECKPOINT");
    assert.ok(checkpoints.length >= 8, String(checkpoints.length));
    const byProject = new Map<string, number[]>();
    for (const cp of checkpoints) {
      const a = attempt(cp.runId);
      assert.deepEqual([a.role, a.state, a.provider, a.model], ["overseer", "SUCCEEDED", "codex", "gpt-6-astra"]);
      assert.equal(a.projectContext.snapshot.projectId, cp.projectId);
      assert.notEqual(cp.plan.outcome, "COMPLETE");
      byProject.set(cp.projectId, [...(byProject.get(cp.projectId) ?? []), cp.revision]);
    }
    for (const [projectId, revisions] of byProject)
      assert.deepEqual(revisions, revisions.map((_, i) => i + 1), projectId);
    const rejected = events("PROJECT_CHECKPOINT_REJECTED");
    for (const x of rejected) assert.match(x.reason, /PROJECT_NOT_COMPLETE/, JSON.stringify(x));
    assert.deepEqual(
      [...proposedComplete].sort(),
      ["project:alpha", "project:beta", "project:delta"],
      "Astra claimed completion in each project whose tasks all passed review",
    );
    assert.equal(rejected.length, proposedComplete.size, "each premature completion was refused");
    assert.ok(
      cur.db.all<{ body: string }>("SELECT body FROM tasks").every((x) => !["VERIFIED", "ACCEPTED"].includes(JSON.parse(x.body).status)),
      "no task is verified: no checkpoint could complete",
    );
    assert.ok(cur.db.all<{ body: string }>("SELECT body FROM attempts WHERE role='overseer'").every((x) => JSON.parse(x.body).provider === "codex"), "no Astra run on Claude");
    // Every worker run but L1's draft from before the switch.
    const legacyDraft = attempts("L1", "worker")[0].id;
    const twoTierWorkers = cur.db
      .all<{ body: string }>("SELECT body FROM attempts WHERE role='worker' AND state!='NOT_STARTED' ORDER BY rowid")
      .map((x) => JSON.parse(x.body))
      .filter((w) => w.id !== legacyDraft);
    assert.equal(twoTierWorkers.length, 8, "A1, A2, A3 twice, B1, B2, G1 and L1's rework");
    for (const w of twoTierWorkers) {
      const ctx = w.projectContext as ProjectContext;
      assert.ok(ctx?.previous, "checkpoint for " + w.id);
      assert.ok(checkpointCurrent(ctx.snapshot, ctx.previous), "current checkpoint for " + w.taskId);
      assert.ok(ctx.previous!.plan.nextTaskIds.includes(w.taskId), "assigned: " + w.taskId);
      assert.ok(checkpoints.some((cp) => cp.runId === ctx.previous!.runId));
    }
    assert.deepEqual(problems, []);
    assert.ok(!cur.db.all<{ body: string }>("SELECT body FROM events").some((x) => x.body.includes("PROJECT_CONTEXT_CHANGED")), "no run was stopped as stale");
    assert.deepEqual(events("RUN_STOPPED_BY_CONTROLLER"), []);
  } finally {
    cur.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
