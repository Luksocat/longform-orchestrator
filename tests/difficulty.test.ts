import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { attestTiers, preflightNeeds } from "../src/cli.js";
import { Controller } from "../src/controller.js";
import { canonical, demoTask, TaskSchema, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import {
  ProjectProfileSchema,
  RoutingPolicySchema,
  type DifficultyAssessment,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

// A model assesses a real task's difficulty before its first worker run; the
// engine decides the tier from fixed rules on top .
// Also: what a real task record must carry, and fix tasks.

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
const tiers = ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT", "APEX"] as const;
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "difficulty-test",
  routes: [
    ...tiers.map((level) =>
      route(
        "claude-" + level.toLowerCase(),
        level,
        "claude",
        "claude-" + level.toLowerCase(),
        "high",
        ["worker"],
      ),
    ),
    ...tiers.map((level) =>
      route(
        "codex-" + level.toLowerCase(),
        level,
        "codex",
        "codex-" + level.toLowerCase(),
        "high",
        ["reviewer"],
      ),
    ),
    // Assessors in owner preference order.
    route("assessor-1", "STANDARD", "claude", "claude-assess", "high", ["assessor"]),
    route("assessor-2", "STANDARD", "codex", "codex-assess", "high", ["assessor"]),
  ],
});
const withoutAssessor = RoutingPolicySchema.parse({
  ...policy,
  id: "no-assessor",
  routes: policy.routes.filter((r) => !r.roles.includes("assessor")),
});
// Work waits for an assessment or the owner's word .
const requiredPolicy = RoutingPolicySchema.parse({
  ...policy,
  id: "difficulty-test-required",
  assessmentRequired: true,
});

type Reading = Partial<DifficultyAssessment["touches"]> & {
  tierHint?: DifficultyAssessment["tierHint"];
};
type AssessorOutcome =
  | Reading
  | "FAIL"
  | "GARBAGE"
  | "WRONG_SPEC"
  /** Refused before launch (a pending credential recovery, say): nothing ran. */
  | "NOT_LAUNCHED";
/** One outcome for every assessor, or one per provider; changeable mid-test. */
type AssessorScript =
  | AssessorOutcome
  | ((provider: string) => AssessorOutcome);

/** Scripted live-shaped adapter: records every request it receives. */
function adapter(script: AssessorScript) {
  const requests: ProviderRequest[] = [];
  const self: ProviderAdapter & {
    requests: ProviderRequest[];
    script: AssessorScript;
  } = {
    requests,
    script,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      requests.push(request);
      const assessor =
        typeof self.script === "function"
          ? self.script(request.provider)
          : self.script;
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
      const p = (request.outputSchema as { properties: Record<string, any> })
        ?.properties;
      if (request.role === "assessor") {
        if (assessor === "FAIL") return receipt("FAILED", "PROCESS_DIED");
        if (assessor === "NOT_LAUNCHED")
          return {
            ...receipt("FAILED", "CODEX_CREDENTIAL_RECOVERY_PENDING: test refusal"),
            costUsd: 0,
            tokens: 0,
            notLaunched: true as const,
          };
        if (assessor === "GARBAGE") return receipt("SUCCEEDED", "not json");
        const reading: Reading = assessor === "WRONG_SPEC" ? {} : assessor;
        return receipt(
          "SUCCEEDED",
          canonical({
            taskId: p.taskId.enum[0],
            specDigest:
              assessor === "WRONG_SPEC" ? "0".repeat(64) : p.specDigest.enum[0],
            touches: {
              driveDocuments: reading.driveDocuments ?? [],
              codePaths: reading.codePaths ?? [],
              domainRules: reading.domainRules ?? false,
              canonicalText: reading.canonicalText ?? false,
              ownerDecision: reading.ownerDecision ?? false,
            },
            breaksIfWrong: "The player reads a wrong greeting.",
            tierHint: reading.tierHint ?? "ROUTINE",
            reason: "A short greeting in one file.",
          }),
        );
      }
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt("SUCCEEDED", "wrote output/A/hello.txt");
      }
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
          ...(p.proposals ? { proposals: [] } : {}),
        }),
      );
    },
  };
  return self;
}

const taskA = (source: { evidenceId: string; revision: string; digest: string }, overrides: Record<string, unknown> = {}) =>
  TaskSchema.parse({
    id: "A",
    programme: "TEST",
    lane: "LOCAL",
    title: "Greeting",
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
    providers: ["claude", "codex"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/A"],
    risk: "LOW",
    reviewPolicy: { required: true, crossProvider: true, independentAudits: false },
    acceptance: [{ id: "greeting", description: "greeting", evidenceKind: "LOCAL" }],
    simulation: false,
    budget: { deadlineMs: 60_000, maxAttempts: 3, maxCostUsd: 5, maxTokens: 10_000 },
    ...overrides,
  });

function fixture(
  assessor: AssessorScript = {},
  options: {
    policy?: typeof policy;
    /** A policy read afresh on every routing decision (it may change mid-test). */
    policyLoader?: () => typeof policy;
    profile?: unknown;
    reviewPolicy?: Task["reviewPolicy"];
    /** Models whose attestation is current; others are unavailable. */
    attested?: (model: string) => boolean;
    /** The live hook that re-attests a route by id. */
    attest?: (routeId: string) => Promise<void>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-difficulty-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: options.policy ?? policy,
    ...(options.policyLoader
      ? { routingPolicyLoader: options.policyLoader }
      : {}),
    verifyRoutingCapability: (cap) => options.attested?.(cap.model) ?? true,
    ...(options.profile
      ? { projectProfile: ProjectProfileSchema.parse(options.profile) }
      : {}),
  });
  const live = adapter(assessor);
  const o = new Orchestrator(
    c,
    { claude: live, codex: live },
    "claude",
    options.attest ? { attest: options.attest } : {},
  );
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:difficulty",
  });
  const source = o.ownerSource(request.request.id);
  const actor = c.localActor();
  c.importTasks(
    [taskA(source, options.reviewPolicy ? { reviewPolicy: options.reviewPolicy } : {})],
    actor,
  );
  c.grant(
    "A",
    {
      id: randomUUID(),
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      paths: ["output/A"],
      decisionText: "test",
      sourceRef: "test:difficulty",
    },
    actor,
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    actor,
    source,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
type Fixture = ReturnType<typeof fixture>;
const roles = (f: Fixture) =>
  f.live.requests.map((r) => `${r.role}:${r.model}`);
const steps = (f: Fixture) =>
  f.o.inspect(f.id).tasks[0]!.steps.map((s) => `${s.stage}:${s.outcome}`);

test("a real task is assessed before its first run; the assessment raises the tier for the worker and its reviewer alike", async () => {
  const f = fixture({ tierHint: "COMPLEX" });
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "assessor:claude-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    const assess = f.live.requests[0]!;
    assert.match(assess.brief, /You are an assessor/);
    assert.match(assess.brief, /your hint can only raise the tier/);
    assert.deepEqual((assess.outputSchema as any).properties.tierHint.enum, [
      "ROUTINE",
      "STANDARD",
      "COMPLEX",
      "EXPERT",
    ]);
    assert.deepEqual(assess.filesystemPolicy, { writablePaths: [] });
    assert.equal(assess.drivePolicy, undefined);
    // It judges stakes, so it sees the record's facts.
    assert.match(assess.brief, /"operations":\["READ_LOCAL","WRITE_LOCAL"\]/);
    assert.match(assess.brief, /"drive":null/);
    assert.match(assess.brief, /"decisionRequired":false/);
    const attempts = f.c.inspect("A").attempts;
    const assessor = attempts.find((a: any) => a.role === "assessor");
    const worker = attempts.find((a: any) => a.role === "worker");
    assert.equal(worker.routing.assessmentRunId, assessor.id);
    assert.match(
      worker.routing.assessment.reasons.join(" "),
      /Assessor claude-assess rated it COMPLEX: A short greeting/,
    );
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
    assert.equal((view.tasks[0]!.difficulty as any).tierHint, "COMPLEX");
    assert.equal(f.c.difficulty("A")[0]!.assessment!.tierHint, "COMPLEX");
    // The assessor is not an author: Claude assessed and worked, Codex reviewed.
    assert.equal(f.c.inspect("A").reviews.length, 1);
  } finally {
    f.close();
  }
});

test("an assessment that finds nothing demanding changes nothing, and what it says the work touches goes through the stakes rules", async () => {
  const plain = fixture({ tierHint: "ROUTINE" });
  try {
    await plain.o.drive(plain.id, { live: true });
    assert.deepEqual(roles(plain), [
      "assessor:claude-assess",
      "worker:claude-routine",
      "reviewer:codex-standard",
    ]);
  } finally {
    plain.close();
  }
  const mechanics = fixture({ tierHint: "STANDARD", domainRules: true });
  try {
    await mechanics.o.drive(mechanics.id, { live: true });
    assert.deepEqual(roles(mechanics), [
      "assessor:claude-assess",
      "worker:claude-expert",
      "reviewer:codex-expert",
    ]);
    const worker = mechanics.c
      .inspect("A")
      .attempts.find((a: any) => a.role === "worker");
    assert.match(
      worker.routing.assessment.reasons.join(" "),
      /touches domain rules \(assessor\)/,
    );
  } finally {
    mechanics.close();
  }
  const master = fixture(
    { tierHint: "ROUTINE", driveDocuments: ["docMASTERxxxxxxx"] },
    {
      profile: {
        version: 1,
        protectedDocuments: [{ id: "docMASTERxxxxxxx", name: "Master plan" }],
      },
    },
  );
  try {
    await master.o.drive(master.id, { live: true });
    assert.equal(roles(master)[1], "worker:claude-expert");
  } finally {
    master.close();
  }
});

test("a failed, unreadable or misaddressed assessment is retried on the other provider; when every provider fails, the worker proceeds on the stakes rules and the view says why", async () => {
  for (const [outcome, reason] of [
    ["FAIL", /ASSESSOR_RUN_FAILED\[codex\]/],
    ["GARBAGE", /ASSESSMENT_UNUSABLE\[codex\]/],
    ["WRONG_SPEC", /ASSESSMENT_UNUSABLE\[codex\]/],
  ] as const) {
    const f = fixture(outcome);
    try {
      const view = await f.o.drive(f.id, { live: true });
      assert.deepEqual(roles(f), [
        "assessor:claude-assess",
        "assessor:codex-assess",
        "worker:claude-routine",
        "reviewer:codex-standard",
      ]);
      assert.equal(
        steps(f).filter((s) => s === "ASSESSMENT_NOT_OBTAINED:HELD").length,
        2,
        outcome,
      );
      assert.equal(view.tasks[0]!.difficulty?.status, "NOT_OBTAINED");
      assert.match((view.tasks[0]!.difficulty as any).reason, reason);
      // Without `assessmentRequired`, no assessment is never a hold.
      assert.ok(
        !view.tasks[0]!.holds.some((h) => /ASSESS/.test(h)),
        view.tasks[0]!.holds.join(","),
      );
      const worker = f.c.inspect("A").attempts.find((a: any) => a.role === "worker");
      assert.equal(worker.routing.assessmentRunId, undefined);
      // Each provider's assessor ran once; then the work started.
      assert.equal(f.c.assessorRunAllowed("A", "claude"), false);
      assert.equal(f.c.assessorRunAllowed("A", "codex"), false);
      assert.equal(f.c.inspect("A").assessmentPending, false);
    } finally {
      f.close();
    }
  }
  // A failure on the first provider is made good by the second in the same advance.
  const second = fixture((provider) =>
    provider === "claude" ? "FAIL" : { tierHint: "COMPLEX" },
  );
  try {
    const view = await second.o.drive(second.id, { live: true });
    assert.deepEqual(roles(second), [
      "assessor:claude-assess",
      "assessor:codex-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
    assert.equal((view.tasks[0]!.difficulty as any).provider, "codex");
    const attempts = second.c.inspect("A").attempts;
    const codex = attempts.find(
      (a: any) => a.role === "assessor" && a.provider === "codex",
    );
    assert.equal(
      attempts.find((a: any) => a.role === "worker").routing.assessmentRunId,
      codex.id,
    );
  } finally {
    second.close();
  }
});

test("with assessmentRequired, a task whose assessors all fail is held and says why; the owner's AGAIN runs them again and PROCEED waives", async () => {
  const f = fixture("FAIL", { policy: requiredPolicy });
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["assessor:claude-assess", "assessor:codex-assess"]);
    const hold = "ASSESSMENT_REQUIRED: claude=FAILED,codex=FAILED";
    assert.equal(view.status, "HELD");
    assert.deepEqual(
      view.tasks[0]!.holds.filter((h) => h.startsWith("ASSESSMENT")),
      [hold],
    );
    assert.equal(view.tasks[0]!.difficulty?.status, "HELD");
    assert.equal((view.tasks[0]!.difficulty as any).reason, hold);
    assert.equal((view.tasks[0]!.difficulty as any).misses.length, 2);
    assert.ok(steps(f).includes("ASSESSMENT_REQUIRED:HELD"));
    assert.equal(f.c.inspect("A").assessmentHold, hold);
    assert.equal(f.c.inspect("A").assessmentPending, false);
    // No worker run, however it is asked for; no third assessor either.
    assert.throws(
      () => f.c.reserve("A", { requestKey: randomUUID() }, f.actor),
      /ASSESSMENT_REQUIRED: claude=FAILED,codex=FAILED/,
    );
    assert.throws(
      () => f.c.reserve("A", { role: "assessor", requestKey: randomUUID() }, f.actor),
      /ROUTING_HELD:ASSESSOR_ALREADY_RUN: assessor-1\|ASSESSOR_ALREADY_RUN: assessor-2/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          {
            role: "assessor",
            provider: "claude",
            model: "claude-assess",
            effort: "high",
            overrideReason: "test",
            requestKey: randomUUID(),
          },
          f.actor,
        ),
      /ASSESSMENT_ALREADY_RUN_FOR_SPEC: claude/,
    );
    // Another advance runs nothing new.
    await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 2);
    // The owner's word needs their words and source, and a known action.
    assert.throws(
      () => f.c.assessmentDecision("A", { action: "AGAIN", text: " ", sourceRef: "s" }, f.actor),
      /MISSING_OWNER_EVIDENCE/,
    );
    assert.throws(
      () => f.c.assessmentDecision("A", { action: "LATER", text: "t", sourceRef: "s" }, f.actor),
      /INVALID_ASSESSMENT_ACTION/,
    );
    // AGAIN: every provider's assessor may run once more; the first usable answer is used.
    f.live.script = { tierHint: "COMPLEX" };
    const again = f.c.assessmentDecision(
      "A",
      { action: "AGAIN", text: "Try the assessment again", sourceRef: "test:owner" },
      f.actor,
    );
    assert.equal(again.pending, true);
    assert.equal(again.hold, "ASSESSMENT_REQUIRED: claude=PENDING,codex=PENDING");
    view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f).slice(2), [
      "assessor:claude-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
    assert.ok(!view.tasks[0]!.holds.some((h) => h.startsWith("ASSESSMENT")));
    const attempts = f.c.inspect("A").attempts;
    assert.equal(
      attempts.find((a: any) => a.role === "worker").routing.assessmentRunId,
      attempts.filter((a: any) => a.role === "assessor").at(-1).id,
    );
  } finally {
    f.close();
  }
  // PROCEED: the stakes rules alone route the work, and the view says so.
  const p = fixture("GARBAGE", { policy: requiredPolicy });
  try {
    await p.o.drive(p.id, { live: true });
    assert.equal(
      p.c.inspect("A").assessmentHold,
      "ASSESSMENT_REQUIRED: claude=UNUSABLE,codex=UNUSABLE",
    );
    const waived = p.c.assessmentDecision(
      "A",
      { action: "PROCEED", text: "Proceed on the rules", sourceRef: "test:owner" },
      p.actor,
    );
    assert.equal(waived.hold, null);
    assert.equal(waived.pending, false);
    assert.throws(
      () => p.c.assessmentDecision("A", { action: "AGAIN", text: "t", sourceRef: "s" }, p.actor),
      /ASSESSMENT_ALREADY_WAIVED_FOR_SPEC/,
    );
    const view = await p.o.drive(p.id, { live: true });
    assert.deepEqual(roles(p).slice(2), ["worker:claude-routine", "reviewer:codex-standard"]);
    assert.equal(view.tasks[0]!.difficulty?.status, "WAIVED");
    assert.equal((view.tasks[0]!.difficulty as any).reason, "Proceed on the rules");
    assert.equal(
      p.c.inspect("A").attempts.find((a: any) => a.role === "worker").routing.assessmentRunId,
      undefined,
    );
    assert.throws(
      () => p.c.assessmentDecision("A", { action: "PROCEED", text: "t", sourceRef: "s" }, p.actor),
      /ASSESSMENT_AFTER_WORK_STARTED/,
    );
  } finally {
    p.close();
  }
});

test("with assessmentRequired, a task no assessor has tried yet is ready to advance live, not held", async () => {
  const f = fixture({ tierHint: "ROUTINE" }, { policy: requiredPolicy });
  try {
    // The controller still refuses the worker until the assessment arrives.
    assert.equal(f.c.inspect("A").assessmentHold, "ASSESSMENT_REQUIRED: claude=PENDING,codex=PENDING");
    assert.equal(f.c.inspect("A").assessmentPending, true);
    const before = f.o.inspect(f.id);
    assert.deepEqual(before.tasks[0]!.holds, []);
    assert.equal(before.tasks[0]!.difficulty, undefined);
    assert.equal(before.status, "READY_TO_ADVANCE");
    assert.match(before.nextSteps.join(" "), /--advance --live --execute/);
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "assessor:claude-assess",
      "worker:claude-routine",
      "reviewer:codex-standard",
    ]);
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
  } finally {
    f.close();
  }
});

test("with assessmentRequired, unattested assessors or a policy without an assessor route hold the task and name the gap", async () => {
  let attested = (model: string) => !model.endsWith("-assess");
  const cold = fixture(
    { tierHint: "EXPERT" },
    { policy: requiredPolicy, attested: (model) => attested(model) },
  );
  try {
    const view = await cold.o.drive(cold.id, { live: true });
    assert.deepEqual(roles(cold), []);
    assert.ok(
      view.tasks[0]!.holds.includes("ASSESSMENT_REQUIRED: claude=PENDING,codex=PENDING"),
      view.tasks[0]!.holds.join(","),
    );
    assert.equal(view.tasks[0]!.difficulty?.status, "HELD");
    assert.match((view.tasks[0]!.difficulty as any).misses.join(" "), /ASSESSOR_UNAVAILABLE/);
    // Attested later, the next advance assesses and works without any owner action.
    attested = () => true;
    const after = await cold.o.drive(cold.id, { live: true });
    assert.deepEqual(roles(cold), [
      "assessor:claude-assess",
      "worker:claude-expert",
      "reviewer:codex-expert",
    ]);
    assert.equal(after.tasks[0]!.difficulty?.status, "OBTAINED");
  } finally {
    cold.close();
  }
  const none = fixture(
    { tierHint: "EXPERT" },
    { policy: RoutingPolicySchema.parse({ ...withoutAssessor, assessmentRequired: true }) },
  );
  try {
    const view = await none.o.drive(none.id, { live: true });
    assert.deepEqual(roles(none), []);
    const gap = "ASSESSMENT_REQUIRED: no enabled assessor route for providers claude,codex";
    assert.ok(view.tasks[0]!.holds.includes(gap), view.tasks[0]!.holds.join(","));
    assert.throws(
      () => none.c.reserve("A", { requestKey: randomUUID() }, none.actor),
      /ASSESSMENT_REQUIRED: no enabled assessor route/,
    );
  } finally {
    none.close();
  }
});

test("work already started on a specification is never held for an assessment: a rework after a failed review goes ahead", async () => {
  let current = policy;
  const f = fixture("FAIL", { policyLoader: () => current });
  try {
    const original = f.live.execute.bind(f.live);
    let failReviews = true;
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await original(request);
      if (request.role !== "reviewer" || !failReviews) return receipt;
      const report = JSON.parse(receipt.output);
      return {
        ...receipt,
        output: canonical({
          ...report,
          findings: [{ materiality: "MAJOR", evidenceIds: [], description: "wrong" }],
          remediation: ["fix it"],
          verdict: "FAIL",
        }),
      };
    };
    // Without the requirement, both assessors failed and the work went ahead; its review failed.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL"]);
    assert.ok(f.c.reworkPending("A"));
    // The policy now requires assessments; the rework continues work already started.
    current = requiredPolicy;
    assert.equal(f.c.assessmentHold("A"), undefined);
    assert.equal(f.c.inspect("A").assessmentPending, false);
    failReviews = false;
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f).slice(4), ["worker:claude-routine", "reviewer:codex-standard"]);
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL", "PASS"]);
    assert.ok(!view.tasks[0]!.holds.some((h) => h.startsWith("ASSESSMENT")));
  } finally {
    f.close();
  }
});

test("an assessor refused before launch moves to the other provider in the same advance and stays retryable later", async () => {
  // Review finding: a refusal before launch leaves the run NOT_STARTED,
  // which is not "tried"; the same provider was asked again instead of the other.
  const f = fixture((provider) =>
    provider === "claude" ? "NOT_LAUNCHED" : { tierHint: "COMPLEX" },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "assessor:claude-assess",
      "assessor:codex-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    const attempts = f.c.inspect("A").attempts;
    assert.equal(
      attempts.find((a: any) => a.role === "assessor" && a.provider === "claude").state,
      "NOT_STARTED",
    );
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
    assert.ok(
      f.o
        .inspect(f.id)
        .tasks[0]!.steps.some((s) => s.detail.startsWith("ASSESSOR_NOT_LAUNCHED[claude]")),
    );
  } finally {
    f.close();
  }
  // Both refused: the hold shows both still pending, and the next advance asks again.
  const both = fixture("NOT_LAUNCHED", { policy: requiredPolicy });
  try {
    await both.o.drive(both.id, { live: true });
    assert.deepEqual(roles(both), ["assessor:claude-assess", "assessor:codex-assess"]);
    assert.equal(
      both.c.inspect("A").assessmentHold,
      "ASSESSMENT_REQUIRED: claude=PENDING,codex=PENDING",
    );
    assert.equal(both.c.inspect("A").assessmentPending, true);
    both.live.script = { tierHint: "COMPLEX" };
    const view = await both.o.drive(both.id, { live: true });
    assert.deepEqual(roles(both).slice(2), [
      "assessor:claude-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    assert.equal(view.tasks[0]!.difficulty?.status, "OBTAINED");
  } finally {
    both.close();
  }
});

test("an unreadable routing policy holds routing without breaking task inspection or the advance", async () => {
  // Review finding: the assessment view read the policy through the
  // loader without catching its failure, so inspecting a task could throw.
  let broken = false;
  const f = fixture(
    { tierHint: "COMPLEX" },
    {
      policyLoader: () => {
        if (broken) throw new Error("EACCES: policy file unreadable");
        return requiredPolicy;
      },
    },
  );
  try {
    broken = true;
    const inspected = f.c.inspect("A");
    assert.equal(inspected.assessmentHold, null);
    assert.equal(inspected.assessmentPending, false);
    assert.equal(inspected.routing.ok, false);
    assert.match(inspected.routing.reasons.join("|"), /ROUTING_POLICY_UNAVAILABLE/);
    assert.deepEqual(f.c.assessorProviders("A"), []);
    assert.equal(f.c.assessmentRequired(), false);
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), []);
    assert.ok(steps(f).includes("WORKER_RESERVATION:HELD"), steps(f).join(","));
    assert.match(
      view.tasks[0]!.steps.map((s) => s.detail).join("|"),
      /ROUTING_HELD:ROUTING_POLICY_UNAVAILABLE/,
    );
    // Readable again: the assessment runs and the work proceeds.
    broken = false;
    const after = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "assessor:claude-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    assert.equal(after.tasks[0]!.difficulty?.status, "OBTAINED");
  } finally {
    f.close();
  }
});

test("while an assessor run is in flight, nothing else assesses and the owner cannot decide yet", () => {
  const f = fixture({ tierHint: "COMPLEX" }, { policy: requiredPolicy });
  try {
    const run = f.c.reserve("A", { role: "assessor", requestKey: randomUUID() }, f.actor);
    assert.equal(run.provider, "claude");
    assert.equal(f.c.assessorRunAllowed("A", "claude"), false);
    assert.equal(f.c.assessorRunAllowed("A", "codex"), false);
    assert.throws(
      () => f.c.reserve("A", { role: "assessor", requestKey: randomUUID() }, f.actor),
      /ASSESSMENT_IN_PROGRESS|DUPLICATE_ACTIVE_DISPATCH/,
    );
    assert.throws(
      () => f.c.assessmentDecision("A", { action: "AGAIN", text: "t", sourceRef: "s" }, f.actor),
      /ASSESSMENT_IN_PROGRESS/,
    );
    // The run in flight keeps its own provider routable, and the hold shows it.
    const route = f.c.route("A", "assessor");
    assert.ok(route.ok && route.provider === "claude", route.reasons.join("|"));
    assert.match(f.c.assessmentHold("A")!, /claude=RESERVED,codex=PENDING/);
  } finally {
    f.close();
  }
});

test("live preflight trusts the controller's view of a pending assessment", () => {
  const base = {
    specDigest: "v1",
    attempts: [{ role: "assessor", state: "FAILED", specDigest: "v1" }],
    reviews: [],
  };
  // Without the controller's view, one failed assessor run ends the matter.
  assert.equal(
    preflightNeeds({ status: "READY", simulation: false }, base).needsAssessment,
    false,
  );
  // With it, another provider may still assess, or none may.
  assert.equal(
    preflightNeeds({ status: "READY", simulation: false }, { ...base, assessmentPending: true })
      .needsAssessment,
    true,
  );
  assert.equal(
    preflightNeeds(
      { status: "READY", simulation: false },
      { ...base, attempts: [], assessmentPending: false },
    ).needsAssessment,
    false,
  );
});

test("without an assessor route, a simulation, or an unattested assessor the work proceeds as before", async () => {
  const none = fixture({ tierHint: "EXPERT" }, { policy: withoutAssessor });
  try {
    const view = await none.o.drive(none.id, { live: true });
    assert.deepEqual(roles(none), ["worker:claude-routine", "reviewer:codex-standard"]);
    assert.ok(!steps(none).some((s) => s.startsWith("ASSESSMENT")));
    assert.equal(view.tasks[0]!.difficulty, undefined);
  } finally {
    none.close();
  }
  // Both assessors unattested: the miss is recorded and the worker proceeds.
  const cold = fixture(
    { tierHint: "EXPERT" },
    { attested: (model) => !model.endsWith("-assess") },
  );
  try {
    const view = await cold.o.drive(cold.id, { live: true });
    assert.deepEqual(roles(cold), ["worker:claude-routine", "reviewer:codex-standard"]);
    assert.equal(view.tasks[0]!.difficulty?.status, "NOT_OBTAINED");
    assert.match((view.tasks[0]!.difficulty as any).reason, /ASSESSOR_UNAVAILABLE/);
  } finally {
    cold.close();
  }
  const f = fixture({ tierHint: "EXPERT" });
  try {
    // A simulation task in the same policy is never assessed by a model.
    f.c.importTasks([demoTask("S")], f.actor);
    f.o.attach(f.id, ["S"]);
    await f.o.drive(f.id, { mock: true });
    assert.equal(
      f.c.inspect("S").attempts.some((a: any) => a.role === "assessor"),
      false,
    );
    assert.equal(f.o.inspect(f.id).tasks.find((t) => t.taskId === "S")!.difficulty, undefined);
  } finally {
    f.close();
  }
});

test("the assessor runs once per specification and only before work; a reserved run keeps the assessment it was routed with", async () => {
  const f = fixture({ tierHint: "COMPLEX" });
  try {
    await f.o.drive(f.id, { live: true });
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { role: "assessor", requestKey: randomUUID() },
          f.actor,
        ),
      /ASSESSMENT_AFTER_WORK_STARTED|TASK_NOT_DISPATCHABLE/,
    );
    const assessor = f.c
      .inspect("A")
      .attempts.find((a: any) => a.role === "assessor");
    // The latest usable assessment routes new runs; a run pinned to none ignores it.
    assert.equal(f.c.route("A", "worker").assessment.level, "COMPLEX");
    assert.equal(
      f.c.route("A", "worker", { assessmentRunId: null }).assessment.level,
      "ROUTINE",
    );
    assert.equal(
      f.c.route("A", "worker", { assessmentRunId: assessor.id }).assessment
        .level,
      "COMPLEX",
    );
    // A revised specification is assessed afresh.
    const t = f.c.task("A");
    f.c.revise("A", { ...t, scope: "greeting, warmer", specVersion: 2 }, f.actor);
    assert.deepEqual(f.c.difficulty("A"), []);
    assert.equal(f.c.route("A", "worker").assessment.level, "ROUTINE");
  } finally {
    f.close();
  }
});

test("a real task must state its risk, and stakes that demand EXPERT work demand independent review", () => {
  const f = fixture();
  try {
    const base = taskA(f.source);
    const raw = (overrides: Record<string, unknown>) => ({
      ...JSON.parse(canonical({ ...base, id: "B" })),
      ...overrides,
    });
    const { risk: _risk, ...unstated } = raw({});
    assert.throws(() => f.c.importTasks([unstated], f.actor), /RISK_REQUIRED/);
    // A simulation keeps the schema default.
    const { risk: _r2, ...simulated } = raw({
      id: "S",
      simulation: true,
      sources: [],
      specificationAuthenticated: true,
      // The default HIGH risk demands the full review policy.
      reviewPolicy: { required: true, crossProvider: true, independentAudits: true },
    });
    f.c.importTasks([simulated], f.actor);
    assert.equal(f.c.task("S").risk, "HIGH");
    // Code changes without independent review are refused; with it, accepted.
    const code = raw({
      id: "C",
      operations: ["READ_LOCAL", "WRITE_LOCAL", "COMMIT"],
      reviewPolicy: { required: true, crossProvider: false, independentAudits: false },
    });
    assert.throws(
      () => f.c.importTasks([code], f.actor),
      /STAKES_REQUIRE_INDEPENDENT_REVIEW: EXPERT: changes code, source law or production \(COMMIT\)/,
    );
    f.c.importTasks(
      [{ ...code, reviewPolicy: { required: true, crossProvider: true, independentAudits: true } }],
      f.actor,
    );
    // A revision is held to the same rules.
    const c = f.c.task("C");
    assert.throws(
      () =>
        f.c.revise(
          "C",
          { ...c, specVersion: 2, reviewPolicy: { ...c.reviewPolicy, independentAudits: false } },
          f.actor,
        ),
      /STAKES_REQUIRE_INDEPENDENT_REVIEW/,
    );
  } finally {
    f.close();
  }
});

test("a protected document in the project profile makes a Drive change EXPERT work that needs independent review", () => {
  const f = fixture(
    {},
    {
      profile: {
        version: 1,
        protectedDocuments: [{ id: "docMASTERxxxxxxx", name: "Master plan" }],
        codePaths: ["src"],
      },
    },
  );
  try {
    const drive = (update: string[], review: boolean) =>
      JSON.parse(
        canonical({
          ...taskA(f.source),
          id: "D" + update.length,
          operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
          writePaths: ["output/A", "drive-changes"],
          drive: { read: "ANY", update, createIn: [] },
          reviewPolicy: { required: true, crossProvider: review, independentAudits: review },
        }),
      );
    assert.throws(
      () => f.c.importTasks([drive(["docMASTERxxxxxxx"], false)], f.actor),
      /STAKES_REQUIRE_INDEPENDENT_REVIEW: EXPERT: touches protected documents: Master plan/,
    );
    f.c.importTasks([drive(["docMASTERxxxxxxx"], true)], f.actor);
    assert.equal(f.c.route("D1", "worker").assessment.level, "EXPERT");
    // An unlisted document is COMPLEX work and may keep a lighter review policy.
    f.c.importTasks([{ ...drive(["docOTHERxxxxxxxx"], false), id: "D2" }], f.actor);
    assert.equal(f.c.route("D2", "worker").assessment.level, "COMPLEX");
    // A code path from the profile is EXPERT work.
    assert.throws(
      () =>
        f.c.importTasks(
          [JSON.parse(canonical({ ...taskA(f.source), id: "K", writePaths: ["src/engine"] }))],
          f.actor,
        ),
      /STAKES_REQUIRE_INDEPENDENT_REVIEW: EXPERT: writes code: src\/engine/,
    );
  } finally {
    f.close();
  }
});

test("a fix task names the task it fixes, stays within its scope, inherits its failed reviews and is told what they found", async () => {
  const f = fixture({ tierHint: "ROUTINE" });
  try {
    const fix = (overrides: Record<string, unknown>) =>
      JSON.parse(
        canonical({
          ...taskA(f.source),
          id: "B",
          fixes: "A",
          sources: [{ ...f.source, evidenceId: f.source.evidenceId + "-B" }],
          ...overrides,
        }),
      );
    assert.throws(
      () => f.c.importTasks([fix({ fixes: "nowhere" })], f.actor),
      /FIX_TARGET_NOT_FOUND: nowhere/,
    );
    assert.throws(
      () => f.c.importTasks([fix({ fixes: "B" })], f.actor),
      /FIX_TARGET_IS_ITSELF/,
    );
    assert.throws(
      () => f.c.importTasks([fix({ writePaths: ["output/B"] })], f.actor),
      /FIX_SCOPE_EXCEEDS_ORIGINAL: path output\/B/,
    );
    assert.throws(
      () =>
        f.c.importTasks(
          [fix({ operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"], drive: { read: "ANY", update: [], createIn: [] }, writePaths: ["output/A", "drive-changes"] })],
          f.actor,
        ),
      /FIX_SCOPE_EXCEEDS_ORIGINAL: path drive-changes, operation READ_DRIVE, drive/,
    );
    // Within scope: a sub-path of the original's write scope.
    f.c.importTasks([fix({ writePaths: ["output/A/part"] })], f.actor);
    assert.equal(f.c.task("B").fixes, "A");

    // Two failed reviews of A at ROUTINE carry into B's tier, and B's worker
    // is told what A's latest review found.
    const original = f.live.execute.bind(f.live);
    let reviews = 0;
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await original(request);
      if (request.role !== "reviewer" || request.taskId !== "A") return receipt;
      const report = JSON.parse(receipt.output);
      reviews++;
      return {
        ...receipt,
        output: canonical({
          ...report,
          findings: [{ materiality: "MAJOR", evidenceIds: [], description: "wrong greeting" }],
          remediation: ["fix the greeting"],
          verdict: "FAIL",
        }),
      };
    };
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.equal(reviews, 2, JSON.stringify(f.o.inspect(f.id).tasks[0]!.steps));
    const routed = f.c.route("B", "worker");
    assert.equal(routed.assessment.level, "STANDARD");
    assert.ok(
      routed.assessment.reasons.some((r) => r.startsWith("ESCALATED ROUTINE -> STANDARD")),
      routed.assessment.reasons.join("; "),
    );
    // A's own rework (now at STANDARD) passes and A waits for acceptance, so
    // B's overlapping write scope is free.
    f.live.execute = original;
    await f.o.drive(f.id, { live: true });
    assert.equal(
      f.c.inspect("A").reviews.map((r: any) => r.verdict).at(-1),
      "PASS",
    );
    f.c.grant(
      "B",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A/part"],
        decisionText: "test",
        sourceRef: "test:difficulty",
      },
      f.actor,
    );
    f.o.attach(f.id, ["B"]);
    const view = await f.o.drive(f.id, { live: true });
    const workerB = f.live.requests.find((r) => r.role === "worker" && r.taskId === "B");
    assert.ok(workerB, JSON.stringify(view.tasks.find((t) => t.taskId === "B")));
    assert.equal(workerB.model, "claude-standard");
    assert.match(workerB.brief, /EARLIER REVIEW of task A, whose work this task fixes/);
    assert.match(workerB.brief, /fix the greeting/);
  } finally {
    f.close();
  }
});

test("stakes the assessor finds require independent review even when the record made review optional", async () => {
  const optional = { required: false, crossProvider: false, independentAudits: false };
  const f = fixture({ tierHint: "STANDARD", domainRules: true }, { reviewPolicy: optional });
  try {
    const actor = f.actor;
    const assessor = f.c.reserve("A", { role: "assessor", requestKey: randomUUID() }, actor);
    await f.c.execute(assessor, f.live, actor);
    assert.equal(f.c.difficulty("A")[0]!.assessment!.touches.domainRules, true);
    // The record is unchanged; the policy in force is not.
    assert.deepEqual(f.c.task("A").reviewPolicy, optional);
    const worker = f.c.reserve("A", { requestKey: randomUUID() }, actor);
    assert.equal(worker.routing!.assessment.level, "EXPERT");
    await f.c.execute(worker, f.live, actor);
    f.c.bindAcceptance("A", "greeting", "output-" + worker.id, actor);
    assert.throws(() => f.c.verify("A", actor), /INDEPENDENT_REVIEW_REQUIRED/);
    // Cross-provider review is in force too: Claude did the work, so Codex reviews.
    const reviewer = f.c.route("A", "reviewer");
    assert.ok(reviewer.ok && reviewer.provider === "codex" && reviewer.model === "codex-expert");
  } finally {
    f.close();
  }
  // Without such stakes the optional policy stands: verification is held on audits, not review.
  const plain = fixture({ tierHint: "STANDARD" }, { reviewPolicy: optional });
  try {
    const actor = plain.actor;
    const assessor = plain.c.reserve("A", { role: "assessor", requestKey: randomUUID() }, actor);
    await plain.c.execute(assessor, plain.live, actor);
    const worker = plain.c.reserve("A", { requestKey: randomUUID() }, actor);
    await plain.c.execute(worker, plain.live, actor);
    plain.c.bindAcceptance("A", "greeting", "output-" + worker.id, actor);
    assert.throws(() => plain.c.verify("A", actor), /MANDATORY_AUDIT_NOT_CURRENT_PASS/);
  } finally {
    plain.close();
  }
});

test("live preflight attests every tier a pending assessment could move a task to, escalation included", async () => {
  assert.deepEqual(attestTiers("ROUTINE", []), ["ROUTINE"]);
  assert.deepEqual(
    attestTiers("ROUTINE", ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"]),
    ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"],
  );
  assert.deepEqual(attestTiers("EXPERT", ["EXPERT", "APEX"]), ["EXPERT", "APEX"]);
  // A fix task whose original failed twice at EXPERT can reach APEX once its
  // assessment raises it to EXPERT .
  const full = { required: true, crossProvider: true, independentAudits: true };
  const f = fixture({ tierHint: "ROUTINE" }, { reviewPolicy: full });
  try {
    const t = f.c.task("A");
    f.c.revise("A", { ...t, specVersion: 2, risk: "HIGH" }, f.actor);
    f.c.grant(
      "A",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "test", sourceRef: "test:difficulty" },
      f.actor,
    );
    f.o.rebind(f.id, ["A"]);
    // A is EXPERT by risk; with no failures yet, nothing reaches APEX.
    assert.deepEqual(
      f.c.reachableWorkerTiers("A", { assessmentPending: true, reviewPending: true }),
      ["EXPERT"],
    );
    const original = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await original(request);
      if (request.role !== "reviewer") return receipt;
      const report = JSON.parse(receipt.output);
      return {
        ...receipt,
        output: canonical({
          ...report,
          findings: [{ materiality: "MAJOR", evidenceIds: [], description: "wrong" }],
          remediation: ["fix it"],
          verdict: "FAIL",
        }),
      };
    };
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL"]);
    // One failed review at EXPERT: a review recorded in the next advance can
    // make two, so a reply or rework in that advance may reach APEX (R13).
    assert.deepEqual(f.c.reachableWorkerTiers("A", { reviewPending: false }), ["EXPERT"]);
    assert.deepEqual(f.c.reachableWorkerTiers("A", { reviewPending: true }), ["EXPERT", "APEX"]);
    f.c.importTasks(
      [JSON.parse(canonical({ ...taskA(f.source), id: "B", fixes: "A", sources: [{ ...f.source, evidenceId: f.source.evidenceId + "-B" }] }))],
      f.actor,
    );
    // B inherits that one failure: before its assessment it routes ROUTINE; an
    // EXPERT assessment plus a failed review in the same advance reaches APEX.
    assert.equal(f.c.route("B", "worker").assessment.level, "ROUTINE");
    assert.deepEqual(
      f.c.reachableWorkerTiers("B", { assessmentPending: true, reviewPending: false }),
      ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"],
    );
    assert.deepEqual(
      f.c.reachableWorkerTiers("B", { assessmentPending: true, reviewPending: true }),
      ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT", "APEX"],
    );
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(
      f.c.inspect("A").reviews.map((r: any) => r.verdict),
      ["FAIL", "FAIL"],
    );
    assert.ok(f.live.requests.filter((r) => r.role === "worker").every((r) => r.model === "claude-expert"));
    // Two inherited EXPERT failures: an EXPERT assessment alone reaches APEX.
    assert.deepEqual(
      f.c.reachableWorkerTiers("B", { assessmentPending: true }),
      ["ROUTINE", "STANDARD", "COMPLEX", "APEX"],
    );
    assert.deepEqual(f.c.reachableWorkerTiers("A"), ["APEX"]);
  } finally {
    f.close();
  }
});

test("a route whose proof aged out is re-attested just before the run that needs it", async () => {
  // Preflight could not foresee the COMPLEX worker and reviewer routes (the
  // assessment picks that tier during the advance); their proof is cold.
  const cold = new Set(["claude-complex", "codex-complex"]);
  const attested: string[] = [];
  const f = fixture(
    { tierHint: "COMPLEX" },
    {
      attested: (model) => !cold.has(model),
      attest: async (routeId) => {
        attested.push(routeId);
        const model = policy.routes.find((r) => r.id === routeId)!.model;
        cold.delete(model);
      },
    },
  );
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(attested, ["claude-complex", "codex-complex"]);
    assert.deepEqual(roles(f), [
      "assessor:claude-assess",
      "worker:claude-complex",
      "reviewer:codex-complex",
    ]);
    assert.ok(!view.tasks[0]!.steps.some((s) => s.stage === "WORKER_RESERVATION" && s.outcome === "HELD"));
  } finally {
    f.close();
  }
  // Without the hook the same advance stalls on the cold route, as before.
  const stalled = fixture({ tierHint: "COMPLEX" }, { attested: (model) => model !== "claude-complex" });
  try {
    const view = await stalled.o.drive(stalled.id, { live: true });
    assert.deepEqual(roles(stalled), ["assessor:claude-assess"]);
    assert.ok(
      view.tasks[0]!.steps.some(
        (s) => s.stage === "WORKER_RESERVATION" && s.outcome === "HELD" && /LIVE_CAPABILITY_UNAUTHENTICATED/.test(s.detail),
      ),
      JSON.stringify(view.tasks[0]!.steps),
    );
  } finally {
    stalled.close();
  }
});

test("a running fix worker keeps its route when its original fails another review meanwhile", async () => {
  const full = { required: true, crossProvider: true, independentAudits: true };
  const f = fixture({ tierHint: "ROUTINE" }, { reviewPolicy: full });
  try {
    // A is EXPERT by risk and fails its first review.
    const t = f.c.task("A");
    f.c.revise("A", { ...t, specVersion: 2, risk: "HIGH" }, f.actor);
    f.c.grant(
      "A",
      { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "test", sourceRef: "test:difficulty" },
      f.actor,
    );
    f.o.rebind(f.id, ["A"]);
    const original = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await original(request);
      if (request.role !== "reviewer" || request.taskId !== "A") return receipt;
      const report = JSON.parse(receipt.output);
      return {
        ...receipt,
        output: canonical({
          ...report,
          findings: [{ materiality: "MAJOR", evidenceIds: [], description: "wrong" }],
          remediation: ["fix it"],
          verdict: "FAIL",
        }),
      };
    };
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL"]);
    // B fixes A and is EXPERT by its own risk. It reads only, so its
    // reservation and A's runs do not contend for a write scope.
    f.c.importTasks(
      [JSON.parse(canonical({ ...taskA(f.source), id: "B", fixes: "A", risk: "HIGH", reviewPolicy: full, operations: ["READ_LOCAL"], writePaths: [], sources: [{ ...f.source, evidenceId: f.source.evidenceId + "-B" }] }))],
      f.actor,
    );
    f.c.grant(
      "B",
      { id: randomUUID(), operations: ["READ_LOCAL"], paths: [], decisionText: "test", sourceRef: "test:difficulty" },
      f.actor,
    );
    f.o.attach(f.id, ["B"]);
    const b = f.c.reserve("B", { requestKey: randomUUID() }, f.actor);
    assert.equal(b.routing!.assessment.level, "EXPERT");
    assert.deepEqual(b.routing!.failedReviewLevels, ["EXPERT"]);
    // While B holds its reservation, A's rework fails its review too.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL", "FAIL"]);
    // B's run keeps the route it was reserved with ...
    f.c.heartbeat(b.id, b.leaseOwner);
    assert.equal(
      f.c.inspect("B").attempts.find((a: any) => a.id === b.id).state,
      "RESERVED",
    );
    // ...while a fresh reservation would escalate on the new history.
    assert.equal(f.c.route("B", "worker").assessment.level, "APEX");
    assert.equal(
      f.c.route("B", "worker", { failedReviewLevels: ["EXPERT"] }).assessment.level,
      "EXPERT",
    );
  } finally {
    f.close();
  }
});

test("a fix chain never loops", () => {
  const f = fixture();
  try {
    const t = f.c.task("A");
    // A pointing at itself is refused; a two-task loop is broken by the visited set.
    assert.throws(
      () => f.c.revise("A", { ...t, specVersion: 2, fixes: "A" } as Task, f.actor),
      /FIX_TARGET_IS_ITSELF/,
    );
    f.c.importTasks(
      [JSON.parse(canonical({ ...taskA(f.source), id: "B", fixes: "A", sources: [{ ...f.source, evidenceId: f.source.evidenceId + "-B" }] }))],
      f.actor,
    );
    f.c.revise("A", { ...t, specVersion: 2, fixes: "B" } as Task, f.actor);
    assert.equal(f.c.route("A", "worker").ok, true);
    assert.equal(f.c.route("B", "worker").ok, true);
  } finally {
    f.close();
  }
});
