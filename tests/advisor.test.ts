import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { canonical, demoTask, specDigest, TaskSchema } from "../src/domain.js";
import { driveRequests } from "../src/driver.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  buildCliArguments,
  type ProviderAdapter,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";
import {
  resolveRoute,
  RoutingPolicySchema,
  type RoutingCapability,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { BusyStore } from "./busy-store.js";

const now = new Date().toISOString();
const capability = (
  provider: "claude" | "codex",
  model: string,
  effort: string,
) => ({
  provider,
  model,
  effort,
  verifiedAt: now,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  evidenceRef: "test:attested",
});
const route = (
  id: string,
  level: string,
  provider: "claude" | "codex",
  model: string,
  effort: string,
  roles: string[],
) => ({
  id,
  level,
  provider,
  model,
  effort,
  roles,
  simulation: false,
  enabled: true,
  capability: capability(provider, model, effort),
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "advisor-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-w", "low", ["worker"]),
    route("codex-routine", "ROUTINE", "codex", "codex-w", "low", ["worker"]),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", [
      "reviewer",
    ]),
    route("claude-standard", "STANDARD", "claude", "claude-r", "medium", [
      "reviewer",
    ]),
    // Owner preference order: the top model first, then the fallback.
    route("advisor-1", "EXPERT", "claude", "claude-top", "max", ["advisor"]),
    route("advisor-2", "EXPERT", "claude", "claude-next", "max", ["advisor"]),
  ],
});

type AdvisorOutcome = "ADVICE" | "FAIL" | "WRONG_SPEC";
/** Scripted live-shaped adapter: records every request it receives. */
function adapter(advisor: AdvisorOutcome) {
  const requests: ProviderRequest[] = [];
  const self: ProviderAdapter & { requests: ProviderRequest[] } = {
    requests,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      requests.push(request);
      const receipt = (
        status: ProviderReceipt["status"],
        output: string,
      ): ProviderReceipt => ({
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: status === "SUCCEEDED" ? 0 : 1,
        status,
        startedAt: now,
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: status === "SUCCEEDED",
        simulation: false,
      });
      if (request.role === "advisor") {
        if (advisor === "FAIL") return receipt("FAILED", "PROCESS_DIED");
        const p = (request.outputSchema as { properties: Record<string, any> })
          .properties;
        return receipt(
          "SUCCEEDED",
          canonical({
            taskId: p.taskId.enum[0],
            specDigest:
              advisor === "WRONG_SPEC" ? "0".repeat(64) : p.specDigest.enum[0],
            approach: "Write one friendly line.",
            steps: ["Create output/A/hello.txt"],
            risks: ["Writing outside output/A fails the run"],
            checks: ["The file ends with a newline"],
            questionsForOwner: ["Formal or casual tone?"],
          }),
        );
      }
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt("SUCCEEDED", "wrote output/A/hello.txt");
      }
      const p = (request.outputSchema as { properties: Record<string, any> })
        .properties;
      const ev: string[] = p.availableEvidence.items.enum;
      return receipt(
        "SUCCEEDED",
        canonical({
          taskId: p.taskId.enum[0],
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: p.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings: [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation: [],
          residualHolds: [],
          verdict: "PASS",
          scope: "test",
          nextAuthorizedStep: "bind",
          auditAssessments: [
            "ACCURACY",
            "LOCAL_ANTI_DRIFT",
            "MACRO_ANTI_DRIFT",
          ].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "ok",
            limitations: [],
          })),
        }),
      );
    },
  };
  return self;
}

function fixture(
  options: {
    advisor?: AdvisorOutcome;
    advice?: boolean;
    providers?: ("claude" | "codex")[];
    /** Models whose attestation is current; others are unavailable. */
    attested?: (model: string) => boolean;
    /** Run leases (the heartbeat is a third of one). */
    leaseMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-advisor-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  // The controller's view of the store, which a test can make busy.
  const busy = new BusyStore(db);
  const c = new Controller(busy, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: (cap: RoutingCapability) =>
      options.attested?.(cap.model) ?? true,
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
  });
  const live = adapter(options.advisor ?? "ADVICE");
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:advisor",
  });
  const source = o.ownerSource(request.request.id);
  c.importTasks(
    [
      TaskSchema.parse({
        id: "A",
        programme: "TEST",
        lane: "LOCAL",
        title: "t",
        scope: "greeting",
        deliverable: "output/A/hello.txt",
        specVersion: 1,
        status: "DISCOVERED",
        artifactRevision: "r1",
        createdAt: now,
        dimensions: {
          authorization: "LOCAL_ONLY",
          sourceEffectuation: "CANDIDATE",
          implementation: "NOT_STARTED",
          review: "NONE",
          release: "NOT_AUTHORIZED",
        },
        sources: [{ ...source, evidenceId: source.evidenceId + "-A" }],
        specificationAuthenticated: true,
        providers: options.providers ?? ["claude", "codex"],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        writePaths: ["output/A"],
        risk: "LOW",
        ...(options.advice === false
          ? {}
          : {
              advice: {
                rationale: "Owner marked this task for advice",
                sourceRef: "test:advisor",
              },
            }),
        reviewPolicy: {
          required: true,
          crossProvider: true,
          independentAudits: false,
        },
        acceptance: [
          { id: "greeting", description: "greeting", evidenceKind: "LOCAL" },
        ],
        simulation: false,
        budget: {
          deadlineMs: 60_000,
          maxAttempts: 2,
          maxCostUsd: 5,
          maxTokens: 10_000,
        },
      }),
    ],
    c.localActor(),
  );
  c.grant(
    "A",
    {
      id: randomUUID(),
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      paths: ["output/A"],
      decisionText: "test",
      sourceRef: "test:advisor",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    busy,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const roles = (f: ReturnType<typeof fixture>) =>
  f.live.requests.map((r) => `${r.role}:${r.provider}:${r.model}`);

test("advisor routing takes the first usable advisor in policy order, else holds", () => {
  const task = TaskSchema.parse({
    ...demoTask("A", { providers: ["claude", "codex"], simulation: false }),
    advice: { rationale: "r", sourceRef: "s" },
  });
  const pick = (available: string[]) =>
    resolveRoute(task, "advisor", policy, {
      verifyLiveCapability: (cap) => available.includes(cap.model),
    });
  const top = pick(["claude-top", "claude-next"]);
  assert.ok(top.ok && top.model === "claude-top" && top.effort === "max");
  const next = pick(["claude-next"]);
  assert.ok(next.ok && next.model === "claude-next");
  const none = pick([]);
  assert.equal(none.ok, false);
  assert.match(
    none.reasons.join(),
    /LIVE_CAPABILITY_UNAUTHENTICATED: advisor-1/,
  );
  // Advisors are limited to the task's providers.
  const codexOnly = resolveRoute(
    { ...task, providers: ["codex"] },
    "advisor",
    policy,
    { verifyLiveCapability: () => true },
  );
  assert.equal(codexOnly.ok, false);
  // Advisor-only routes never serve workers or reviewers.
  const worker = resolveRoute(task, "worker", policy, {
    verifyLiveCapability: () => true,
  });
  assert.ok(worker.ok && worker.routeId === "claude-routine");
});

test("a marked task gets advice first, and the worker receives it as labelled data", async () => {
  const f = fixture();
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    const [advisor, worker] = f.live.requests;
    // The advisor is read-only and returns structured advice.
    assert.deepEqual(advisor!.filesystemPolicy?.writablePaths, []);
    assert.ok(advisor!.outputSchema);
    assert.match(advisor!.brief, /You are an advisor/);
    assert.match(worker!.brief, /ADVISOR NOTES/);
    assert.match(worker!.brief, /grant no permission/);
    assert.match(worker!.brief, /Write one friendly line\./);
    const task = view.tasks[0]!;
    assert.equal(task.status, "WAITING_REVIEW");
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
    assert.deepEqual(
      (task as { advice?: { status: string; model: string } }).advice && [
        (task as any).advice.status,
        (task as any).advice.model,
        (task as any).advice.questionsForOwner,
      ],
      ["OBTAINED", "claude-top", ["Formal or casual tone?"]],
    );
    // Advice is asked once per specification.
    await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.filter((r) => r.role === "advisor").length, 1);
  } finally {
    f.close();
  }
});

// Design choice: an advisor may read Drive within the task's read scope.
test("an advisor reads Drive, read-only, within a Drive task's read scope", async () => {
  const f = fixture();
  try {
    const actor = f.c.localActor();
    const base = f.c.inspect("A").task;
    const driveTask = TaskSchema.parse({
      ...base,
      specVersion: 2,
      dimensions: { ...base.dimensions, authorization: "EXPLICIT" },
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
      writePaths: ["output/A", "drive-changes"],
      drive: {
        read: ["folderAAAAAAAAAA"],
        update: [],
        createIn: [],
        pack: ["docAAAAAAAAAAAAA"],
      },
    });
    f.c.revise("A", driveTask, actor);
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: driveTask.operations,
        paths: ["output/A", "drive-changes"],
        decisionText: "test",
        sourceRef: "test:advisor",
      },
      actor,
    );
    f.o.rebind(f.id, ["A"]);
    await f.o.drive(f.id, { live: true });
    const advisor = f.live.requests.find((r) => r.role === "advisor")!;
    assert.deepEqual(advisor.drivePolicy, {
      read: ["folderAAAAAAAAAA"],
      update: [],
      createIn: [],
    });
    assert.match(advisor.brief, /You can also read Google Drive, read-only/);
    assert.match(advisor.brief, /before you advise/);
    // The pack is the worker's; the advisor's scope has none.
    assert.doesNotMatch(advisor.brief, /SOURCE PACK/);
  } finally {
    f.close();
  }
});

test("before the top model is available, the next advisor in order is used", async () => {
  const f = fixture({ attested: (model) => model !== "claude-top" });
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(roles(f)[0], "advisor:claude:claude-next");
  } finally {
    f.close();
  }
});

test("with no usable advisor the worker proceeds and the reason is visible", async () => {
  const f = fixture({
    attested: (model) =>
      !model.startsWith("claude-t") && !model.startsWith("claude-n"),
  });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    const task = view.tasks[0] as any;
    assert.equal(task.advice.status, "NOT_OBTAINED");
    assert.match(task.advice.reason, /ADVISOR_UNAVAILABLE/);
    // Not a hold: the task still reached review.
    assert.equal(task.status, "WAITING_REVIEW");
    assert.ok(!task.holds.some((h: string) => /ADVICE/.test(h)));
  } finally {
    f.close();
  }
});

test("a failed advisor run is not retried, and the worker proceeds without advice", async () => {
  const f = fixture({ advisor: "FAIL" });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    assert.doesNotMatch(f.live.requests[1]!.brief, /ADVISOR NOTES/);
    assert.match((view.tasks[0] as any).advice.reason, /ADVISOR_RUN_FAILED/);
    // The failed advisor gave no advice, so it is not a co-author.
    assert.equal(f.c.advice("A").length, 0);
  } finally {
    f.close();
  }
});

test("advice the controller stopped because the database stayed busy is asked again, and the worker waits for it", async () => {
  const f = fixture({ leaseMs: 3_000 });
  try {
    // The first advisor run is held up by another session's writes until the
    // controller stops it; its receipt reports its usage.
    const execute = f.live.execute.bind(f.live);
    let first = true;
    f.live.execute = async (request) => {
      if (!(first && request.role === "advisor")) return execute(request);
      first = false;
      f.live.requests.push(request);
      f.busy.held = true;
      await new Promise<void>((resolve) =>
        request.signal?.aborted
          ? resolve()
          : request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
      );
      f.busy.held = false;
      return {
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: null,
        status: "CANCELLED",
        startedAt: now,
        endedAt: new Date().toISOString(),
        output: "CANCELLED",
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: false,
        simulation: false,
      };
    };
    // The worker waits for the advice and the driver asks for it again
    // (the stopped run changes the request, so it advances again at once;
    // a refusal that persists is retried with backoff).
    let virtual = Date.now();
    const clock = {
      now: () => virtual,
      sleep: async (ms: number) => {
        virtual += ms;
      },
    };
    await driveRequests(f.o, { live: true, requestIds: [f.id], clock });
    const waiting = f.o
      .inspect(f.id)
      .tasks[0]!.steps.filter(
        (s: any) => s.stage === "ADVICE_WAITING_PROVIDER",
      );
    assert.match(waiting.at(-1)!.detail, /database is locked/);
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    const advisors = f.c
      .inspect("A")
      .attempts.filter((a: any) => a.role === "advisor");
    assert.equal(advisors[0].interruption.cause, "DATABASE_BUSY");
    assert.equal(advisors[1].state, "SUCCEEDED");
    // The worker had the advice, asked again, not a run without it.
    assert.match(f.live.requests[2]!.brief, /ADVISOR NOTES/);
  } finally {
    f.close();
  }
});

// Review R2-2: a refusal of the advice's reservation itself, with nothing
// else changing, is retried by the driver with backoff, not held.
test("a busy refusal of the advice's reservation is retried by the driver with backoff until the advice is obtained; the worker waits for it", async () => {
  const f = fixture();
  try {
    // The reservation is refused twice, as SQLite refuses a write while
    // another session holds the database; the third goes through.
    const reserve = f.c.reserve.bind(f.c);
    let refusals = 2;
    (f.c as any).reserve = (taskId: string, options: any, actor: any) => {
      if (options.role === "advisor" && refusals > 0) {
        refusals--;
        throw Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
          errstr: "database is locked",
        });
      }
      return reserve(taskId, options, actor);
    };
    let virtual = Date.now();
    const sleeps: number[] = [];
    const clock = {
      now: () => virtual,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        virtual += ms;
      },
    };
    const run = await driveRequests(f.o, { live: true, requestIds: [f.id], clock });
    assert.equal(refusals, 0, "both refusals were met");
    // The first refusal is new to the request, so it is advanced again at
    // once; the second changes nothing, so the driver backs off and retries.
    assert.ok(sleeps.includes(30_000), "a backoff sleep: " + JSON.stringify(sleeps));
    assert.ok(run.results[0]!.advances >= 3, JSON.stringify(run));
    // The drive ends where this fixture always does (verification wants
    // evidence), not held for the advice.
    assert.doesNotMatch(run.results[0]!.detail, /ADVI[CS]/, JSON.stringify(run));
    const task = f.o.inspect(f.id).tasks[0]! as any;
    const waiting = task.steps.filter((s: any) => s.stage === "ADVICE_WAITING_PROVIDER");
    assert.ok(waiting.length >= 1);
    assert.match(waiting.at(-1)!.detail, /ADVISOR_RESERVATION: database is locked/);
    assert.equal(task.steps.filter((s: any) => s.stage === "ADVICE_NOT_OBTAINED").length, 0, "the worker never went on without the advice");
    // One advisor run, once the reservation went through; the worker had its advice.
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    assert.match(f.live.requests[1]!.brief, /ADVISOR NOTES/);
  } finally {
    f.close();
  }
});

test("advice for another specification is unusable and never reaches the worker", async () => {
  const f = fixture({ advisor: "WRONG_SPEC" });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.doesNotMatch(f.live.requests[1]!.brief, /ADVISOR NOTES/);
    assert.match((view.tasks[0] as any).advice.reason, /ADVICE_UNUSABLE/);
  } finally {
    f.close();
  }
});

test("an advisor is a co-author: the worker follows the advisor's provider and the reviewer is the other", async () => {
  // Codex is listed first, so without advice the worker would be Codex.
  const f = fixture({ providers: ["codex", "claude"] });
  try {
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "advisor:claude:claude-top",
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
  } finally {
    f.close();
  }
  const g = fixture({ providers: ["codex", "claude"], advice: false });
  try {
    await g.o.drive(g.id, { live: true });
    assert.equal(roles(g)[0], "worker:codex:codex-w");
  } finally {
    g.close();
  }
});

test("with Claude advising and Codex working, no provider is left to review independently", async () => {
  const f = fixture();
  try {
    const actor = f.c.localActor();
    const advisor = f.c.reserve(
      "A",
      { role: "advisor", requestKey: randomUUID() },
      actor,
    );
    await f.c.execute(advisor, f.live, actor);
    assert.equal(f.c.advice("A")[0]?.provider, "claude");
    // An explicit operator selection puts Codex on the work anyway.
    const worker = f.c.reserve(
      "A",
      {
        provider: "codex",
        model: "codex-w",
        effort: "low",
        requestKey: randomUUID(),
      },
      actor,
    );
    await f.c.execute(worker, f.live, actor);
    const reviewer = f.c.route("A", "reviewer");
    assert.equal(reviewer.ok, false);
    assert.match(reviewer.reasons.join(), /NO_ELIGIBLE_PROVIDER/);
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          {
            role: "reviewer",
            provider: "claude",
            model: "claude-r",
            effort: "medium",
            requestKey: randomUUID(),
          },
          actor,
        ),
      /REVIEWER_AUTHORED_SCOPE/,
    );
  } finally {
    f.close();
  }
});

test("unmarked tasks never consult the advisor, and keep their specification hash", async () => {
  const f = fixture({ advice: false });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.ok(!roles(f).some((r) => r.startsWith("advisor")));
    assert.equal((view.tasks[0] as any).advice, undefined);
    const task = f.c.task("A");
    assert.equal("advice" in task, false);
    assert.equal(specDigest(task), specDigest(TaskSchema.parse(task)));
  } finally {
    f.close();
  }
  // An advisor cannot be reserved for an unmarked task, or after work started.
  const g = fixture({ advice: false });
  try {
    assert.throws(
      () =>
        g.c.reserve(
          "A",
          { role: "advisor", requestKey: randomUUID() },
          g.c.localActor(),
        ),
      /ADVICE_NOT_REQUESTED/,
    );
  } finally {
    g.close();
  }
  const h = fixture({
    attested: (model) => model !== "claude-top" && model !== "claude-next",
  });
  try {
    await h.o.drive(h.id, { live: true });
    assert.throws(
      () =>
        h.c.reserve(
          "A",
          {
            role: "advisor",
            provider: "claude",
            model: "claude-top",
            effort: "max",
            requestKey: randomUUID(),
          },
          h.c.localActor(),
        ),
      /ADVICE_AFTER_WORK_STARTED|TASK_NOT_DISPATCHABLE/,
    );
  } finally {
    h.close();
  }
});

test("a Claude advisor gets read-only tools under subscription auth", () => {
  const request = {
    runId: "r",
    taskId: "A",
    provider: "claude" as const,
    model: "claude-top",
    effort: "max",
    role: "advisor" as const,
    cwd: "/tmp",
    brief: "advise",
    deadlineMs: 1_000,
    filesystemPolicy: { writablePaths: ["output/A"] },
  };
  const args = buildCliArguments("claude", request, true, {
    subscriptionAuth: true,
  });
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(args[args.indexOf("--effort") + 1], "max");
});
