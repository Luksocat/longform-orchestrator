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
import { canonical, TaskSchema, specDigest } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { RoutingPolicySchema, resolveRoute } from "../src/routing.js";
import {
  projectContext,
  projectSnapshot,
  recordCheckpoint,
  assertProjectCurrent,
  type ProjectContext,
} from "../src/project.js";
import {
  MAX_BRIEF_CHARS,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderReceipt,
} from "../src/providers.js";
import { PROJECT_ARCHIVE_PATH } from "../src/project-view.js";
import { driveRequests } from "../src/driver.js";

const configured = JSON.parse(
  readFileSync(
    new URL(
      "../docs/examples/live-routing-policy.example.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// The distributed template is deliberately disabled and has model placeholders.
// These tests use deterministic fake providers and explicit synthetic identities.
for (const route of configured.routes) {
  route.enabled = true;
  route.model = route.provider === "claude"
    ? "test-claude-reviewer"
    : route.roles.includes("overseer") ? "test-codex-overseer" : "test-codex-worker";
}
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
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        evidenceRef: "test:attested",
      },
    })),
  });
}
function plan(
  context: ProjectContext,
  outcome?: "CONTINUE" | "COMPLETE" | "ASK_OWNER",
) {
  const tasks = context.snapshot.tasks;
  return {
    inputDigest: context.snapshot.inputDigest,
    summary: "Preserve the greeting project and its agreed scope.",
    outcome:
      outcome ??
      (tasks.every((t) => ["VERIFIED", "ACCEPTED"].includes(t.task.status))
        ? "COMPLETE"
        : "CONTINUE"),
    assignments: tasks.map((t) => ({
      taskId: t.task.id,
      instruction:
        "Write the agreed greeting; preserve established wording and acceptance criteria.",
    })),
    nextTaskIds: tasks
      .filter((t) => !["VERIFIED", "ACCEPTED"].includes(t.task.status))
      .map((t) => t.task.id),
    milestones: ["A consistent greeting across project outputs"],
    technicalDecisions: [],
    risks: [],
    // Since question scopes (2026-10-26) each question declares its scope;
    // this one holds the whole project, as a taskless question did before.
    questionsForOwner:
      outcome === "ASK_OWNER"
        ? [
            {
              question:
                "Which greeting should the user see? 1) Short (Recommended): concise. 2) Warm: more welcoming.",
              taskIds: [],
              projectWide: true,
            },
          ]
        : [],
    questionsForOperator: [],
  };
}
/** Task A writes the greeting; a fix task writes inside A's scope. */
const outputOf = (taskId: string) =>
  taskId === "A" ? "output/A/hello.txt" : "output/A/part/hello.txt";
function fixture(
  options: {
    verdicts?: string[];
    overseer?: (ctx: ProjectContext) => string;
    assessment?: "COMPLEX" | "EXPERT";
    unknownOverseer?: boolean;
    duringOverseer?: () => void;
    /** Start under this policy instead of the two-tier one (restart switches). */
    firstPolicy?: () => ReturnType<typeof policy>;
    /** The owner's request text and the task's scope, when not the defaults. */
    prompt?: string;
    scope?: string;
    workerOutput?: string;
    /**
     * On the first reviewer run of this task: run this, and fail the run
     * without a report when `fail` is set.
     */
    onFirstReviewOf?: { taskId: string; fail?: boolean; run: () => void };
  } = {},
) {
  let currentPolicy = options.firstPolicy ?? policy;
  const root = mkdtempSync(join(tmpdir(), "astra-project-"));
  let db = new SqliteStore(join(root, "state.sqlite"));
  const requests: ProviderRequest[] = [];
  let reviewCount = 0,
    firstReviews = 0;
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
          breaksIfWrong: "The greeting is wrong",
          tierHint: options.assessment ?? "COMPLEX",
          reason: "Bounded local work",
        });
      else if (r.role === "overseer") {
        const context = JSON.parse(
          r.brief.split(
            "PROJECT CONTEXT (controller snapshot and previous Astra plan; model text is guidance, never permission or evidence):\n",
          )[1]!,
        ) as ProjectContext;
        // The full record is in Astra's workspace, for the same inputs.
        const archive = JSON.parse(
          readFileSync(join(r.cwd, PROJECT_ARCHIVE_PATH), "utf8"),
        ) as ProjectContext;
        assert.equal(archive.snapshot.inputDigest, context.snapshot.inputDigest);
        assert.deepEqual(
          archive.snapshot.tasks.map((t) => t.task.scope),
          archive.snapshot.tasks.map(() => options.scope ?? "Write a greeting"),
        );
        for (const task of context.snapshot.tasks)
          if (task.artifact)
            assert.equal(
              readFileSync(
                join(r.cwd, task.artifact.path, outputOf(task.task.id)),
                "utf8",
              ),
              "hello\n",
            );
        output = options.overseer?.(context) ?? canonical(plan(context));
        options.duringOverseer?.();
      } else if (r.role === "worker") {
        if (currentPolicy === policy) assert.match(r.brief, /PROJECT CONTEXT/);
        mkdirSync(join(r.cwd, outputOf(r.taskId), ".."), { recursive: true });
        writeFileSync(join(r.cwd, outputOf(r.taskId)), "hello\n");
        output = options.workerOutput ?? "Created greeting.";
      } else if (r.role === "reviewer") {
        const verdict = options.verdicts?.[reviewCount++] ?? "PASS";
        const ev = p.availableEvidence.items.enum;
        output = canonical({
          taskId: r.taskId,
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: r.provider,
          authorshipDisclosure: "Independent session",
          availableEvidence: ev,
          findings:
            verdict === "FAIL"
              ? [
                  {
                    materiality: "MAJOR",
                    evidenceIds: [],
                    description: "Greeting needs correction",
                  },
                ]
              : [],
          testsExecuted: [],
          testsNotExecuted: ["No executable test configured"],
          conflictingEvidence: [],
          remediation:
            verdict === "FAIL"
              ? [r.taskId === "A" ? "Correct the greeting" : "Correct the fix"]
              : [],
          residualHolds: [],
          verdict,
          scope: "greeting",
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
      const first =
        r.role === "reviewer" &&
        r.taskId === options.onFirstReviewOf?.taskId &&
        !firstReviews++;
      if (first) options.onFirstReviewOf!.run();
      const failNow = first && !!options.onFirstReviewOf!.fail;
      return {
        runId: r.runId,
        taskId: r.taskId,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        sessionId: randomUUID(),
        exitCode: failNow ? 1 : 0,
        status: failNow
          ? "FAILED"
          : r.role === "overseer" && options.unknownOverseer
            ? "UNKNOWN"
            : "SUCCEEDED",
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
      routingPolicy: currentPolicy(),
      verifyRoutingCapability: () => true,
      projectProfile: {
        version: 1,
        protectedDocuments: [],
        protectedFolders: [],
        codePaths: ["output"],
      },
    });
  let c = make(),
    o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
  const submitted = o.submit({
    requestKey: randomUUID(),
    prompt: options.prompt ?? "Write a cohesive greeting project",
    context: { cwd: root, projectKey: "greeting" },
    sourceRef: "test:owner",
  });
  const id = submitted.request.id,
    source = o.ownerSource(id);
  const task = TaskSchema.parse({
    id: "A",
    programme: "TEST",
    lane: "LOCAL",
    title: "Greeting",
    scope: options.scope ?? "Write a greeting",
    deliverable: "output/A/hello.txt",
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
    sources: [{ ...source, evidenceId: source.evidenceId + "-A" }],
    specificationAuthenticated: true,
    providers: ["claude", "codex"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/A"],
    risk: "LOW",
    reviewPolicy: {
      required: true,
      crossProvider: true,
      independentAudits: true,
    },
    acceptance: [
      { id: "greeting", description: "A greeting", evidenceKind: "LOCAL" },
    ],
    simulation: false,
    budget: {
      deadlineMs: 60000,
      maxAttempts: 5,
      maxCostUsd: 10,
      maxTokens: 100000,
    },
  });
  c.importTasks([task], c.localActor());
  c.grant(
    "A",
    {
      id: randomUUID(),
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      paths: ["output/A"],
      decisionText: "Write greeting",
      sourceRef: "test:owner",
    },
    c.localActor(),
  );
  o.attach(id, ["A"]);
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
    requests,
    restart(next?: () => ReturnType<typeof policy>) {
      if (next) currentPolicy = next;
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
}

test("two-tier routing fixes provider roles, preserves code review, and caps both tiers at Expert", () => {
  const f = fixture();
  try {
    const t = f.c.task("A"),
      p = policy();
    assert.equal(f.c.route("A").assessment.level, "COMPLEX");
    assert.equal(f.c.reviewPolicyInForce("A").independentAudits, true);
    for (const [failures, level, effort] of [
      [[], "COMPLEX", "xhigh"],
      [["COMPLEX", "COMPLEX"], "EXPERT", "max"],
      [["COMPLEX", "COMPLEX", "EXPERT", "EXPERT"], "EXPERT", "max"],
    ] as const) {
      const r = resolveRoute(t, "worker", p, {
        failedReviewLevels: [...failures],
        verifyLiveCapability: () => true,
      });
      assert.ok(r.ok);
      assert.equal(r.provider, "codex");
      assert.equal(r.assessment.level, level);
      assert.equal(r.effort, effort);
    }
    assert.throws(
      () =>
        RoutingPolicySchema.parse({
          ...p,
          routes: [{ ...p.routes[0], level: "ROUTINE" }],
        }),
      /Two-tier/,
    );
    assert.throws(
      () => f.c.reserve("A", { requestKey: "bypass" }, f.c.localActor()),
      /PROJECT_OVERSIGHT_REQUIRED/,
    );
  } finally {
    f.close();
  }
});

test("live-shaped workflow escalates Sol and Opus together, and restarts retain Astra's project map", async () => {
  const f = fixture({ verdicts: ["FAIL", "FAIL", "PASS"] });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(
      f.c.inspect("A").reviews.length,
      1,
      canonical(f.o.inspect(f.id)),
    );
    const first = f.o.project(f.id);
    assert.ok(first.previous);
    f.restart();
    assert.equal(f.o.project(f.id).previous?.revision, first.previous.revision);
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.equal(
      f.requests.filter((r) => r.role === "worker").length,
      3,
      canonical(f.o.inspect(f.id)),
    );
    assert.deepEqual(
      f.requests
        .filter((r) => r.role === "worker")
        .map((r) => [r.model, r.effort]),
      [
        ["test-codex-worker", "xhigh"],
        ["test-codex-worker", "xhigh"],
        ["test-codex-worker", "max"],
      ],
    );
    assert.deepEqual(
      f.requests
        .filter((r) => r.role === "reviewer")
        .map((r) => [r.model, r.effort]),
      [
        ["test-claude-reviewer", "high"],
        ["test-claude-reviewer", "high"],
        ["test-claude-reviewer", "xhigh"],
      ],
    );
    assert.deepEqual(
      f.requests
        .filter((r) => r.role === "assessor")
        .map((r) => [r.model, r.effort]),
      [["test-codex-worker", "high"]],
    );
    assert.ok(
      f.requests
        .filter((r) => r.role === "overseer")
        .every((r) => r.model === "test-codex-overseer" && r.effort === "xhigh"),
    );
    const worker = f.c
      .inspect("A")
      .attempts.filter((a) => a.role === "worker")
      .at(-1)!;
    f.c.bindAcceptance(
      "A",
      "greeting",
      "output-" + worker.id,
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(
      f.o.project(f.id).previous?.plan.outcome,
      "COMPLETE",
      canonical(f.o.inspect(f.id)),
    );
  } finally {
    f.close();
  }
});

test("invalid or premature Astra completion cannot start work or award acceptance", async () => {
  for (const output of ["not JSON", "premature"]) {
    const f = fixture({
      overseer: (ctx) =>
        output === "premature" ? canonical(plan(ctx, "COMPLETE")) : output,
    });
    try {
      await f.o.drive(f.id, { live: true });
      await f.o.drive(f.id, { live: true });
      assert.equal(f.requests.filter((r) => r.role === "overseer").length, 2);
      assert.equal(f.o.inspect(f.id).status, "HELD");
      assert.equal(f.requests.filter((r) => r.role === "worker").length, 0);
      assert.equal(f.o.project(f.id).previous, undefined);
      assert.ok(
        f.o
          .inspect(f.id)
          .tasks[0]!.steps.some(
            (s) => s.stage === "PROJECT_OVERSIGHT" && s.outcome === "HELD",
          ),
      );
    } finally {
      f.close();
    }
  }
});

test("Astra owner questions remain durable and prevent worker execution", async () => {
  const f = fixture({ overseer: (ctx) => canonical(plan(ctx, "ASK_OWNER")) });
  try {
    await f.o.drive(f.id, { live: true });
    f.restart();
    assert.equal(f.o.inspect(f.id).status, "WAITING_INPUT");
    assert.equal(
      f.o.inspect(f.id).questions.filter((q) => q.status === "OPEN").length,
      1,
    );
    assert.equal(f.requests.filter((r) => r.role === "worker").length, 0);
  } finally {
    f.close();
  }
});

test("explicit project membership persists across requests, isolates other projects and forbids cross-host leakage", () => {
  const f = fixture();
  try {
    const other = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Unrelated",
      context: { cwd: f.root, projectKey: "other" },
      sourceRef: "test:other",
    });
    assert.equal(f.o.project(other.request.id).snapshot.tasks.length, 0);
    const same = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Continue greeting",
      context: { cwd: f.root, projectKey: "greeting" },
      sourceRef: "test:continue",
    });
    assert.equal(f.o.project(same.request.id).snapshot.tasks.length, 1);
    const before = projectContext(f.db, f.id);
    f.o.ask(f.id, { key: "constraint", text: "Which wording?", projectWide: true });
    assert.throws(
      () => assertProjectCurrent(f.db, before),
      /PROJECT_CONTEXT_CHANGED/,
    );
    assert.throws(
      () => recordCheckpoint(f.db, before, "stale", canonical(plan(before))),
      /PROJECT_CONTEXT_CHANGED/,
    );
    const foreign = new Orchestrator(f.c, {}, "codex");
    assert.throws(
      () =>
        foreign.submit({
          requestKey: randomUUID(),
          prompt: "Foreign",
          context: { cwd: f.root, projectKey: "greeting" },
          sourceRef: "test:foreign",
        }),
      /PROJECT_OWNED_BY_OTHER_HOST/,
    );
    assert.equal(f.o.project(f.id).snapshot.tasks.length, 1);
  } finally {
    f.close();
  }
});

test("unknown Astra runs survive restart without replay or dependent execution", async () => {
  const f = fixture({ unknownOverseer: true });
  try {
    await f.o.drive(f.id, { live: true });
    f.restart();
    await f.o.drive(f.id, { live: true });
    assert.equal(f.requests.filter((r) => r.role === "overseer").length, 1);
    assert.equal(f.requests.filter((r) => r.role === "worker").length, 0);
    assert.equal(f.o.inspect(f.id).status, "HELD_RECONCILIATION");
  } finally {
    f.close();
  }
});

test("concurrent project input changes reject Astra's result and preserve an unresolved run", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    duringOverseer: () => {
      f.o.submit({
        requestKey: randomUUID(),
        prompt: "New requirement during checkpoint",
        context: { cwd: f.root, projectKey: "greeting" },
        sourceRef: "test:concurrent",
      });
    },
  });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.o.project(f.id).previous, undefined);
    assert.equal(f.requests.filter((r) => r.role === "worker").length, 0);
    assert.equal(f.o.inspect(f.id).status, "HELD_RECONCILIATION");
  } finally {
    f.close();
  }
});

test("a continued request can explicitly rebind a new specification without rewriting history", () => {
  const f = fixture();
  try {
    const next = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Continue and refine greeting",
      context: { cwd: f.root, projectKey: "greeting" },
      sourceRef: "test:continue",
      taskIds: ["A"],
    });
    const old = f.c.task("A"),
      oldDigest = specDigest(old);
    f.c.revise(
      "A",
      { ...old, scope: old.scope + " with a period", specVersion: 2 },
      f.c.localActor(),
    );
    f.o.rebind(next.request.id, ["A"]);
    assert.equal(
      f.o.project(next.request.id).snapshot.tasks[0]!.specDigest,
      specDigest(f.c.task("A")),
    );
    assert.ok(
      f.o
        .project(next.request.id)
        .snapshot.taskBindings.some((b) => b.specDigest === oldDigest),
    );
    assert.equal(f.o.inspect(f.id).status, "HELD_SPEC_CHANGED");
  } finally {
    f.close();
  }
});

test("reserved workers reject changed context before the provider starts", async () => {
  const f = fixture({ verdicts: ["FAIL"] });
  try {
    await f.o.drive(f.id, { live: true });
    const a = f.c.reserve(
      "A",
      { requestKey: "reserved-for-stale-test", projectRequestId: f.id },
      f.c.localActor(),
    );
    f.o.ask(f.id, { key: "new-owner-question", text: "Which wording?", projectWide: true });
    let called = false;
    await assert.rejects(
      f.c.execute(
        a,
        {
          async execute() {
            called = true;
            throw new Error("must not start");
          },
        },
        f.c.localActor(),
      ),
      /PROJECT_CONTEXT_CHANGED/,
    );
    assert.equal(called, false);
  } finally {
    f.close();
  }
});

test("final oversight becomes stale when project inputs change and revoked grants prevent completion", async () => {
  const f = fixture();
  try {
    await f.o.drive(f.id, { live: true });
    const worker = f.c.inspect("A").attempts.find((a) => a.role === "worker")!;
    f.c.bindAcceptance(
      "A",
      "greeting",
      "output-" + worker.id,
      f.c.localActor(),
    );
    await f.o.drive(f.id, { live: true });
    assert.equal(f.o.project(f.id).previous?.plan.outcome, "COMPLETE");
    f.o.submit({
      requestKey: randomUUID(),
      prompt: "Check the result in the next milestone",
      context: { cwd: f.root, projectKey: "greeting" },
      sourceRef: "test:milestone",
    });
    assert.equal(f.o.project(f.id).current, false);
    assert.equal(f.o.inspect(f.id).status, "WAITING_PROJECT_OVERSIGHT");
    const grant = JSON.parse(
      f.db.get<{ body: string }>("SELECT body FROM grants WHERE task_id='A'")!
        .body,
    );
    f.c.revokeGrant(grant.id, "Authorization withdrawn", f.c.localActor());
    const context = f.c.projectContextFor(f.id);
    assert.equal(context.snapshot.tasks[0]!.gate?.completionCurrent, false);
    assert.throws(
      () =>
        recordCheckpoint(
          f.db,
          context,
          "pretend-complete",
          canonical(plan(context, "COMPLETE")),
          (id) => context.snapshot.tasks.find((t) => t.task.id === id)!.gate!,
        ),
      /PROJECT_NOT_COMPLETE/,
    );
  } finally {
    f.close();
  }
});

/** The pre-switch shape: either provider works or reviews at every tier. */
function legacyPolicy() {
  return RoutingPolicySchema.parse({
    version: 1,
    id: "legacy-test",
    routes: (["claude", "codex"] as const).flatMap((provider) =>
      (["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"] as const).map((level) => {
        const model = provider === "claude" ? "test-claude-reviewer" : "test-codex-worker";
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
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            evidenceRef: "test:attested",
          },
        };
      }),
    ),
  });
}

test("legacy-pairing routes are confined to two-tier Claude-worker and Codex-reviewer roles", () => {
  const p = policy();
  const legacy = p.routes.find((r) => r.legacyPairing && r.roles[0] === "worker")!;
  assert.throws(
    () =>
      RoutingPolicySchema.parse({
        ...p,
        routes: [{ ...legacy, provider: "codex" }],
      }),
    /Legacy-pairing workers use Claude/,
  );
  assert.throws(
    () =>
      RoutingPolicySchema.parse({
        ...p,
        routes: [{ ...legacy, roles: ["worker", "advisor"] }],
      }),
    /one worker or reviewer role/,
  );
  assert.throws(
    () =>
      RoutingPolicySchema.parse({
        ...legacyPolicy(),
        routes: [{ ...legacyPolicy().routes[0]!, legacyPairing: true }],
      }),
    /only in the two-tier workflow/,
  );
  const f = fixture();
  try {
    const t = f.c.task("A");
    for (const [legacyClaudeAuthorship, role, id] of [
      [false, "worker", "codex-complex-worker"],
      [false, "reviewer", "claude-complex-reviewer"],
      [true, "worker", "claude-complex-legacy-worker"],
      [true, "reviewer", "codex-complex-legacy-reviewer"],
    ] as const) {
      const r = resolveRoute(t, role, p, {
        legacyClaudeAuthorship,
        authors: role === "reviewer" ? [legacyClaudeAuthorship ? "claude" : "codex"] : [],
        verifyLiveCapability: () => true,
      });
      assert.ok(r.ok, canonical(r));
      assert.equal(r.routeId, id);
    }
    // Astra (Codex) advice does not pull a legacy task's worker off Claude.
    const advised = resolveRoute(t, "worker", p, {
      legacyClaudeAuthorship: true,
      advisors: ["codex"],
      verifyLiveCapability: () => true,
    });
    assert.ok(advised.ok, canonical(advised));
    assert.equal(advised.routeId, "claude-complex-legacy-worker");
    assert.throws(
      () =>
        RoutingPolicySchema.parse({
          ...p,
          routes: [
            {
              ...p.routes.find((r) => r.legacyPairing && r.roles[0] === "reviewer")!,
              provider: "claude",
            },
          ],
        }),
      /their reviewers use Codex/,
    );
    assert.equal(f.c.legacyClaudeAuthorship(t), false);
  } finally {
    f.close();
  }
});

test("a Claude draft from before the switch is reworked by Claude and reviewed by Sol, despite Astra's oversight", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS"], firstPolicy: legacyPolicy });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED", canonical(f.o.inspect(f.id)));
    assert.deepEqual(
      f.requests.map((r) => [r.role, r.provider]),
      [
        ["worker", "claude"],
        ["reviewer", "codex"],
      ],
    );
    const before = f.requests.length;
    f.restart(policy);
    assert.equal(f.c.legacyClaudeAuthorship(f.c.task("A")), true);
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const after = f.requests.slice(before);
    assert.ok(
      after.some((r) => r.role === "overseer"),
      canonical(f.o.inspect(f.id)),
    );
    assert.deepEqual(
      after
        .filter((r) => r.role === "worker" || r.role === "reviewer")
        .map((r) => [r.role, r.model, r.effort]),
      [
        ["worker", "test-claude-reviewer", "high"],
        ["reviewer", "test-codex-worker", "xhigh"],
      ],
      canonical(f.o.inspect(f.id)),
    );
    const worker = f.c
      .inspect("A")
      .attempts.filter((a) => a.role === "worker")
      .at(-1)!;
    f.c.bindAcceptance("A", "greeting", "output-" + worker.id, f.c.localActor());
    await f.o.drive(f.id, { live: true });
    assert.equal(
      f.o.project(f.id).previous?.plan.outcome,
      "COMPLETE",
      canonical(f.o.inspect(f.id)),
    );
  } finally {
    f.close();
  }
});

test("each run sees its role's part of the project, so a long owner request and task record fit and appear once", async () => {
  // A long run once overflowed its reviewer's brief: the
  // whole project record, task record included, followed the review brief.
  const prompt = "OWNER-REQUEST-MARK " + "p".repeat(60_000);
  const scope = "TASK-SCOPE-MARK " + "s".repeat(40_000);
  const f = fixture({ prompt, scope });
  try {
    await f.o.drive(f.id, { live: true });
    const roles = f.requests.map((r) => r.role);
    for (const role of ["assessor", "overseer", "worker", "reviewer"])
      assert.ok(roles.includes(role as never), roles.join());
    for (const r of f.requests) {
      const count = (mark: string) => r.brief.split(mark).length - 1;
      assert.ok(r.brief.length <= MAX_BRIEF_CHARS, `${r.role} ${r.brief.length}`);
      assert.equal(count("OWNER-REQUEST-MARK"), 1, r.role);
      assert.equal(count("TASK-SCOPE-MARK"), 1, r.role);
    }
    assert.match(
      f.requests.find((r) => r.role === "reviewer")!.brief,
      /PROJECT CONTEXT FOR THIS TASK/,
    );
  } finally {
    f.close();
  }
});

test("a project too large for Astra's brief stops before any run starts, leaves nothing waiting and says why", async () => {
  // The anchored task's own entry is never shortened, so an entry too large
  // for any brief cannot be fitted by summarizing, indexing or owner-text files.
  const f = fixture();
  try {
    f.c.addEvidence(
      {
        id: "huge-a",
        taskId: "A",
        kind: "LOCAL",
        uri: "local:huge",
        revision: "r1",
        digest: "d".repeat(64),
        retrievedAt: new Date().toISOString(),
        authorityTier: "UNVERIFIED",
        authentication: "LOCAL_IMPORT",
        currentness: "UNKNOWN",
        claims: ["HUGE " + "h".repeat(130_000)],
        metadata: {},
      },
      f.c.localActor(),
    );
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      f.requests.filter((r) => r.role === "overseer" || r.role === "worker"),
      [],
    );
    assert.deepEqual(
      f.c
        .inspect("A")
        .attempts.filter((a) => ["RESERVED", "STARTED", "UNKNOWN"].includes(a.state)),
      [],
    );
    assert.notEqual(view.status, "RUNNING_OR_RECOVERY_REQUIRED");
    const held = view.tasks[0]!.steps.find(
      (s) =>
        s.stage === "PROJECT_OVERSIGHT" &&
        /PROJECT_CONTEXT_TOO_LARGE/.test(s.detail ?? ""),
    );
    assert.ok(held, JSON.stringify(view.tasks[0]!.steps));
    assert.match(held!.detail!, /nothing was spent/);
    assert.match(held!.detail!, /new project key/);
    const inspected = f.o.inspect(f.id) as any;
    assert.equal(inspected.project.briefSize.nearLimit, true);
    assert.ok(
      inspected.nextSteps.some((s: string) => /nearly too large/.test(s)),
      JSON.stringify(inspected.nextSteps),
    );
  } finally {
    f.close();
  }
});

test("owner requests too long to inline reach Astra byte for byte in owner-text files bound to the run, with the instruction to read them", async () => {
  const first = "FIRST " + "a".repeat(65_000),
    second = "SECOND " + "b".repeat(65_000);
  const f = fixture({ prompt: first });
  try {
    const later = f.o.submit({
      requestKey: randomUUID(),
      prompt: second,
      context: { cwd: f.root, projectKey: "greeting" },
      sourceRef: "test:second",
    });
    await f.o.drive(f.id, { live: true });
    const overseer = f.requests.find((r) => r.role === "overseer");
    assert.ok(overseer, f.requests.map((r) => r.role).join());
    assert.ok(overseer!.brief.length <= MAX_BRIEF_CHARS);
    // The words are not in the brief, and not summarized either.
    assert.doesNotMatch(overseer!.brief, /a{1000}/);
    assert.match(overseer!.brief, /OWNER'S REQUEST TEXT: .*Read each whole file before you act/);
    assert.equal(overseer!.ownerText?.required, true);
    const dir = overseer!.ownerText!.dir;
    const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.runId, overseer!.runId);
    for (const [request, text] of [
      [f.id, first],
      [later.request.id, second],
    ] as const) {
      const file = "request-" + request + ".txt";
      assert.equal(readFileSync(join(dir, file), "utf8"), text);
      const entry = manifest.files.find((x: any) => x.requestId === request);
      assert.equal(entry.file, file);
      assert.equal(entry.sha256, f.o.ownerSource(request).digest);
      assert.equal(entry.requestInputDigest, (f.o.inspect(request) as any).request.inputDigest);
      assert.match(overseer!.brief, new RegExp("/run/longform-owner-text/" + file));
      assert.ok(overseer!.brief.includes(entry.sha256));
    }
    // The folder is the run's own, outside every workspace.
    assert.ok(!dir.startsWith(join(f.root, "workspaces")));
    assert.ok(dir.includes(overseer!.runId));
  } finally {
    f.close();
  }
});

test("the request view shows a compact project summary and how to continue in a new chat; the full record stays available", async () => {
  const f = fixture();
  try {
    await f.o.drive(f.id, { live: true });
    const v = f.o.inspect(f.id) as any;
    assert.equal(v.project.snapshot, undefined);
    assert.deepEqual(
      v.project.tasks.map((t: any) => t.id),
      ["A"],
    );
    assert.equal(v.project.briefSize.limit, MAX_BRIEF_CHARS);
    assert.equal(v.project.briefSize.nearLimit, false);
    assert.ok(v.project.astraPlan.revision >= 1);
    assert.match(v.project.fullRecord, /--project-full/);
    assert.ok(v.resume.includes(f.id));
    assert.match(v.resume, /project key greeting/);
    assert.equal(
      f.o.project(f.id).snapshot.tasks[0]!.task.scope,
      "Write a greeting",
    );
  } finally {
    f.close();
  }
});

test("a run's own optional context gives way to the project view: a long worker summary is shortened, not the owner's request", async () => {
  const f = fixture({
    prompt: "OWNER-REQUEST-MARK " + "p".repeat(65_000),
    scope: "TASK-SCOPE-MARK " + "s".repeat(30_000),
    workerOutput: "SUMMARY-START " + "w".repeat(40_000) + " SUMMARY-END",
  });
  try {
    await f.o.drive(f.id, { live: true });
    const review = f.requests.find((r) => r.role === "reviewer");
    assert.ok(review, f.requests.map((r) => r.role).join());
    assert.ok(review!.brief.length <= MAX_BRIEF_CHARS, String(review!.brief.length));
    assert.match(review!.brief, /OWNER-REQUEST-MARK/);
    assert.match(review!.brief, /SUMMARY-START/);
    assert.doesNotMatch(review!.brief, /SUMMARY-END/);
  } finally {
    f.close();
  }
});

test("a fix task's reviewer sees the review the fix answers, as its worker does", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS", "PASS"] });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      f.c.inspect("A").reviews.map((r: any) => r.verdict),
      ["FAIL", "PASS"],
    );
    const a = f.c.task("A"),
      source = f.o.ownerSource(f.id);
    f.c.importTasks(
      [
        TaskSchema.parse({
          ...JSON.parse(canonical(a)),
          id: "F",
          title: "Fix greeting",
          fixes: "A",
          status: "DISCOVERED",
          artifactRevision: "r1",
          specVersion: 1,
          writePaths: ["output/A/part"],
          deliverable: "output/A/part/hello.txt",
          sources: [{ ...source, evidenceId: source.evidenceId + "-F" }],
        }),
      ],
      f.c.localActor(),
    );
    f.c.grant(
      "F",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A/part"],
        decisionText: "Fix greeting",
        sourceRef: "test:owner",
      },
      f.c.localActor(),
    );
    f.o.attach(f.id, ["F"]);
    await f.o.drive(f.id, { live: true });
    const worker = f.requests.find((r) => r.role === "worker" && r.taskId === "F");
    const reviewer = f.requests.find((r) => r.role === "reviewer" && r.taskId === "F");
    assert.ok(worker && reviewer, f.requests.map((r) => r.role + ":" + r.taskId).join());
    assert.match(worker!.brief, /EARLIER REVIEW of task A/);
    for (const brief of [worker!.brief, reviewer!.brief])
      assert.match(brief, /Correct the greeting/);
    assert.match(reviewer!.brief, /"fixes":\{"review":\{/);
  } finally {
    f.close();
  }
});

/** Registers task F, which fixes A within A's scope, and attaches it. */
function addFixTask(f: ReturnType<typeof fixture>) {
  const a = f.c.task("A"),
    source = f.o.ownerSource(f.id);
  f.c.importTasks(
    [
      TaskSchema.parse({
        ...JSON.parse(canonical(a)),
        id: "F",
        title: "Fix greeting",
        fixes: "A",
        status: "DISCOVERED",
        artifactRevision: "r1",
        specVersion: 1,
        writePaths: ["output/A/part"],
        deliverable: "output/A/part/hello.txt",
        sources: [{ ...source, evidenceId: source.evidenceId + "-F" }],
      }),
    ],
    f.c.localActor(),
  );
  f.c.grant(
    "F",
    {
      id: randomUUID(),
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      paths: ["output/A/part"],
      decisionText: "Fix greeting",
      sourceRef: "test:owner",
    },
    f.c.localActor(),
  );
  f.o.attach(f.id, ["F"]);
}
/** Records a newer failed review of A, as if A had been reviewed again. */
function newerReviewOfA(db: { all: Function; run: Function }) {
  const first = db.all(
    "SELECT id, body FROM reviews WHERE task_id='A' ORDER BY rowid",
  )[0] as { body: string };
  const newer = {
    ...JSON.parse(first.body),
    id: randomUUID(),
    runId: randomUUID(),
    remediation: ["SECOND-REVIEW-FIX"],
  };
  db.run("INSERT INTO reviews VALUES(?,?,?)", newer.id, "A", canonical(newer));
}

test("a fix task's reviewer gets the review its worker was given, even after a newer review of the fixed task", async () => {
  // The newer review of A lands while F's first review run fails, so F's
  // next review run is built after it.
  let db: { all: Function; run: Function } | undefined;
  const f = fixture({
    verdicts: ["FAIL", "PASS", "PASS", "PASS"],
    onFirstReviewOf: { taskId: "F", fail: true, run: () => newerReviewOfA(db!) },
  });
  try {
    db = f.db as never;
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    addFixTask(f);
    const reviewersOfF = () =>
      f.requests.filter((r) => r.role === "reviewer" && r.taskId === "F");
    for (let i = 0; i < 3 && reviewersOfF().length < 2; i++)
      await f.o.drive(f.id, { live: true });
    assert.equal(reviewersOfF().length, 2, f.requests.map((r) => r.role + ":" + r.taskId).join());
    const worker = f.requests.find((r) => r.role === "worker" && r.taskId === "F")!;
    const reviewer = reviewersOfF().at(-1)!;
    assert.match(worker.brief, /Correct the greeting/);
    assert.match(reviewer.brief, /Correct the greeting/);
    assert.doesNotMatch(reviewer.brief, /SECOND-REVIEW-FIX/);
  } finally {
    f.close();
  }
});

test("a fix task's rework, and the review of it, keep the review the fix first answered", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS", "FAIL", "PASS"] });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    addFixTask(f);
    const runsOfF = (role: string) =>
      f.requests.filter((r) => r.role === role && r.taskId === "F");
    for (let i = 0; i < 3 && !runsOfF("reviewer").length; i++)
      await f.o.drive(f.id, { live: true });
    // F's first review failed it and its rework has not started; a newer
    // review of A lands now, before the rework is reserved.
    assert.equal(runsOfF("reviewer").length, 1);
    assert.equal(runsOfF("worker").length, 1, f.requests.map((r) => r.role + ":" + r.taskId).join());
    newerReviewOfA(f.db as never);
    for (let i = 0; i < 4 && runsOfF("reviewer").length < 2; i++)
      await f.o.drive(f.id, { live: true });
    const [fresh, rework] = runsOfF("worker");
    assert.ok(fresh && rework, f.requests.map((r) => r.role + ":" + r.taskId).join());
    assert.match(rework!.brief, /Fix your work in place/);
    assert.equal(runsOfF("reviewer").length, 2);
    for (const brief of [rework!.brief, runsOfF("reviewer")[1]!.brief]) {
      assert.match(brief, /Correct the greeting/);
      assert.doesNotMatch(brief, /SECOND-REVIEW-FIX/);
    }
  } finally {
    f.close();
  }
});

test("a fix task's work from before the review record still gives its rework and review the earlier review", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS", "FAIL", "PASS"] });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    addFixTask(f);
    const runsOfF = (role: string) =>
      f.requests.filter((r) => r.role === role && r.taskId === "F");
    for (let i = 0; i < 3 && !runsOfF("reviewer").length; i++)
      await f.o.drive(f.id, { live: true });
    assert.equal(runsOfF("worker").length, 1);
    // Make F's sealed work look like work from before the record.
    const row = f.db.get<{ id: string; body: string }>(
      "SELECT id, body FROM attempts WHERE task_id='F' AND role='worker'",
    )!;
    const legacy = JSON.parse(row.body);
    assert.ok("fixesReview" in legacy);
    delete legacy.fixesReview;
    f.db.run("UPDATE attempts SET body=? WHERE id=?", canonical(legacy), row.id);
    for (let i = 0; i < 4 && runsOfF("reviewer").length < 2; i++)
      await f.o.drive(f.id, { live: true });
    const rework = runsOfF("worker")[1];
    assert.ok(rework, f.requests.map((r) => r.role + ":" + r.taskId).join());
    assert.equal(runsOfF("reviewer").length, 2);
    for (const brief of [rework!.brief, runsOfF("reviewer")[1]!.brief])
      assert.match(brief, /Correct the greeting/);
  } finally {
    f.close();
  }
});

/** Codex paused for its usage limit, as an observed limit records it. */
const pauseCodex = (f: { db: SqliteStore }) =>
  f.db.event("PROVIDER_LIMIT_OBSERVED", null, {
    provider: "codex",
    kind: "USAGE_LIMIT",
    until: new Date(Date.now() + 600_000).toISOString(),
    validResetAt: new Date(Date.now() + 540_000).toISOString(),
    observedAt: new Date().toISOString(),
  });

test("while Codex is paused for its usage limit, Claude work that needs Astra's checkpoint waits, and nothing reroutes Astra", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS"], firstPolicy: legacyPolicy });
  try {
    await f.o.drive(f.id, { live: true });
    f.restart(policy);
    pauseCodex(f);
    const before = f.requests.length;
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      f.requests.slice(before).map((r) => r.role + ":" + r.provider),
      [],
      "no run: the Claude rework waits for Astra, and Astra is not moved to Claude",
    );
    assert.ok(
      view.tasks[0]!.steps.some((s) => s.stage === "PROJECT_OVERSIGHT" && /PROVIDER_PAUSED:codex/.test(s.detail)),
      canonical(view.tasks[0]!.steps),
    );
    assert.equal((view as any).providerPauses[0].provider, "codex");
    f.c.clearProviderPause("codex", { reason: "usage reset", evidence: ["usage page"], sourceRef: "test:operator" }, f.c.localActor());
    await f.o.drive(f.id, { live: true });
    const after = f.requests.slice(before).map((r) => r.role + ":" + r.provider);
    assert.deepEqual(after.slice(0, 2), ["overseer:codex", "worker:claude"], after.join(","));
  } finally {
    f.close();
  }
});

test("while Codex is paused, a Claude review of sealed Codex work goes ahead and the closing checkpoint waits", async () => {
  // Codex's limit is observed while the Claude review of Codex's work runs.
  const holder: { f?: ReturnType<typeof fixture> } = {};
  const f = fixture({
    onFirstReviewOf: { taskId: "A", run: () => pauseCodex(holder.f!) },
  });
  holder.f = f;
  try {
    const view = await f.o.drive(f.id, { live: true });
    const roles = f.requests.map((r) => r.role + ":" + r.provider);
    const review = roles.indexOf("reviewer:claude");
    assert.ok(review > 0, roles.join(","));
    assert.ok(f.c.inspect("A").reviews.length >= 1, "the review was recorded");
    assert.deepEqual(
      roles.slice(review + 1).filter((r) => r.endsWith(":codex")),
      [],
      "no Codex run after the pause: the closing checkpoint waits",
    );
    assert.ok(
      view.tasks[0]!.steps.some((s) => s.stage === "PROJECT_OVERSIGHT" && /PROVIDER_PAUSED:codex/.test(s.detail)),
      canonical(view.tasks[0]!.steps),
    );
    assert.notEqual(f.o.project(f.id).previous?.plan.outcome, "COMPLETE");
  } finally {
    f.close();
  }
});

test("under the driver, Claude work that needs Astra's checkpoint waits for Codex's reset; nothing is run past the checkpoint", async () => {
  const f = fixture({ verdicts: ["FAIL", "PASS"], firstPolicy: legacyPolicy });
  try {
    await f.o.drive(f.id, { live: true });
    f.restart(policy);
    pauseCodex(f);
    const before = f.requests.length;
    const run = await driveRequests(f.o, {
      live: true,
      requestIds: [f.id],
      maxMinutes: 1,
      // The reset is ten minutes away: the driver would sleep; the test stops it there.
      clock: { now: () => Date.now(), sleep: async () => { throw new Error("SLEPT"); } },
    }).catch((error) => error);
    assert.equal(f.requests.length, before, "no run before Codex's reset");
    assert.match(String(run), /SLEPT/, "it waits for the reset rather than giving up or looping");
  } finally {
    f.close();
  }
});


test("explicit optional deferral remains visible to Astra and changes the project fingerprint without forging an answer", () => {
  const f = fixture();
  try {
    const q = f.o.ask(f.id, {
      key: "optional-note",
      taskId: "A",
      kind: "INFORMATION",
      text: "Would an optional navigation note help?",
    });
    const before = f.o.project(f.id).snapshot;
    assert.ok(before.questions.some((x) => x.id === q.id && !x.answers.length));
    const change = f.o.deferQuestion(f.id, {
      questionId: q.id,
      questionText: q.text,
      ownerInstruction: "Defer that note. The accepted scope does not depend on it.",
      reason: "Informational follow-up only, owner selected deferral",
      sourceRef: "test:owner-direction",
    });
    assert.equal(change.questions.find((x) => x.id === q.id)?.status, "DEFERRED");
    const after = f.o.project(f.id).snapshot;
    assert.notEqual(before.inputDigest, after.inputDigest, "Astra must notice the owner's disposition");
    const saved = after.questions.find((x) => x.id === q.id)!;
    assert.equal(saved.answers.length, 0, "no fabricated owner answer");
    assert.equal(saved.deferred.ownerInstruction, "Defer that note. The accepted scope does not depend on it.");
    assert.equal(saved.deferred.grantsAuthority, false);
    assert.ok(!f.o.inspect(f.id).questions.some((x) => x.status === "OPEN"));
    // The request view's project summary says so too (review M3).
    assert.equal(
      (f.o.inspect(f.id) as any).project.questions.find((x: any) => x.id === q.id)?.status,
      "DEFERRED",
    );
  } finally {
    f.close();
  }
});

test("a binding question in another project request prevents rebind even with a stale spec snapshot", () => {
  const f = fixture();
  try {
    const next = f.o.submit({
      requestKey: randomUUID(),
      prompt: "Continue same project task",
      context: { cwd: f.root, projectKey: "greeting" },
      sourceRef: "test:continue",
      taskIds: ["A"],
    });
    const original = f.o.ask(f.id, {
      key: "binding-before-revision",
      taskId: "A",
      kind: "OWNER_DECISION",
      text: "Which critical ending must be authored?",
    });
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: 2, title: "Revised project task" }, f.c.localActor());
    assert.throws(
      () => f.o.rebind(next.request.id, ["A"]),
      /REBIND_HAS_OPEN_QUESTIONS/,
    );
    assert.equal(f.o.inspect(f.id).questions[0]!.id, original.id);
    assert.equal(f.o.inspect(f.id).questions[0]!.status, "OPEN");
  } finally {
    f.close();
  }
});


test("a deferred informational question no longer blocks two-tier worker or independent reviewer admission", async () => {
  const f = fixture();
  try {
    const q = f.o.ask(f.id, {
      key: "optional-reader-note",
      taskId: "A",
      kind: "INFORMATION",
      text: "Would you like an optional summary after review?",
    });
    f.o.deferQuestion(f.id, {
      questionId: q.id,
      questionText: q.text,
      ownerInstruction: "Defer the optional note; the approved work can proceed.",
      reason: "It changes neither gameplay nor acceptance criteria.",
      sourceRef: "test:owner",
    });
    for (let i = 0; i < 4 && !f.c.inspect("A").reviews.length; i++)
      await f.o.drive(f.id, { live: true });
    const reviews = f.c.inspect("A").reviews;
    assert.ok(reviews.length > 0, "reviewer reservation must not see a deferred note as an unanswered decision");
    assert.ok(!f.o.inspect(f.id).questions.some((x) => x.status === "OPEN"));
    assert.ok(f.o.inspect(f.id).questions.some((x) => x.status === "DEFERRED"));
  } finally {
    f.close();
  }
});

test("under two tiers the other agent host can still read and list a request, but not defer or rebind on it", () => {
  const f = fixture();
  try {
    const codex = new Orchestrator(f.c, {}, "codex");
    // Codex's own request in another project shares the database.
    const own = codex.submit({
      requestKey: randomUUID(),
      prompt: "Codex's own project",
      context: { cwd: f.root, projectKey: "codex-project" },
      sourceRef: "test:codex",
    });
    // Reading is shared state: neither host's listing breaks on the other's work.
    assert.equal(codex.inspect(f.id).request.id, f.id);
    assert.equal(f.o.inspect(own.request.id).request.id, own.request.id);
    const both = [f.id, own.request.id].sort();
    assert.deepEqual(codex.list().map((v) => v.request.id).sort(), both);
    assert.deepEqual(f.o.list().map((v) => v.request.id).sort(), both);
    // Acting is not.
    const q = f.o.ask(f.id, {
      key: "optional-note",
      taskId: "A",
      kind: "INFORMATION",
      text: "Would an optional navigation note help?",
    });
    assert.throws(
      () =>
        codex.deferQuestion(f.id, {
          questionId: q.id,
          questionText: q.text,
          ownerInstruction: "Defer that note.",
          reason: "Informational follow-up only",
          sourceRef: "test:owner-direction",
        }),
      /REQUEST_OWNED_BY_OTHER_HOST/,
    );
    const prior = f.c.task("A");
    f.c.revise("A", { ...prior, specVersion: 2, title: "Revised" }, f.c.localActor());
    assert.throws(() => codex.rebind(f.id, ["A"]), /REQUEST_OWNED_BY_OTHER_HOST/);
  } finally {
    f.close();
  }
});
