import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { canonical, TaskSchema } from "../src/domain.js";
import { Orchestrator, workerQuestions } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import { RoutingPolicySchema } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

const now = new Date().toISOString();
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
  capability: {
    provider,
    model,
    effort,
    verifiedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "test:attested",
  },
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "worker-questions-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-w", "low", ["worker"]),
    route("codex-routine", "ROUTINE", "codex", "codex-w", "low", ["worker"]),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", [
      "reviewer",
    ]),
    route("claude-standard", "STANDARD", "claude", "claude-r", "medium", [
      "reviewer",
    ]),
    route("advisor-1", "EXPERT", "claude", "claude-top", "max", ["advisor"]),
  ],
});

const ASKING = [
  "wrote output/A/hello.txt with a placeholder greeting",
  "",
  "QUESTIONS FOR THE OWNER:",
  "1. Should the greeting be formal or casual?",
  "   - Casual (Recommended): it matches the rest of the app.",
  "   - Formal: it reads more polished but stands out.",
].join("\n");

/** Scripted live-shaped adapter: the worker returns the given summary. */
function adapter(workerOutput: string) {
  const requests: ProviderRequest[] = [];
  const self: ProviderAdapter & { requests: ProviderRequest[] } = {
    requests,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      requests.push(request);
      const receipt = (output: string): ProviderReceipt => ({
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: now,
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: true,
        simulation: false,
      });
      const p = (request.outputSchema as { properties: Record<string, any> })
        ?.properties;
      if (request.role === "advisor")
        return receipt(
          canonical({
            taskId: p!.taskId.enum[0],
            specDigest: p!.specDigest.enum[0],
            approach: "Write one friendly line.",
            steps: ["Create output/A/hello.txt"],
            risks: [],
            checks: [],
            questionsForOwner: [],
          }),
        );
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt(workerOutput);
      }
      const ev: string[] = p!.availableEvidence.items.enum;
      return receipt(
        canonical({
          taskId: p!.taskId.enum[0],
          artifactRevision: p!.artifactRevision.enum[0],
          specDigest: p!.specDigest.enum[0],
          provider: p!.provider.enum[0],
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

function fixture(workerOutput: string, options: { advice?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "longform-worker-questions-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: () => true,
  });
  const live = adapter(workerOutput);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:worker-questions",
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
        providers: ["claude", "codex"],
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        writePaths: ["output/A"],
        risk: "LOW",
        ...(options.advice
          ? {
              advice: {
                rationale: "Owner marked this task for advice",
                sourceRef: "test:worker-questions",
              },
            }
          : {}),
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
      sourceRef: "test:worker-questions",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const roles = (f: ReturnType<typeof fixture>) =>
  f.live.requests.map((r) => `${r.role}:${r.provider}:${r.model}`);

test("worker questions are read only from a closing questions section", () => {
  assert.equal(workerQuestions("wrote output/A/hello.txt"), undefined);
  assert.equal(workerQuestions("done\nQUESTIONS FOR THE OWNER: none"), undefined);
  assert.equal(
    workerQuestions("done\n\n**Questions for the owner:**\nNone."),
    undefined,
  );
  assert.equal(
    workerQuestions("Questions for the owner were not needed."),
    undefined,
  );
  assert.equal(
    workerQuestions("QUESTIONS FOR THE OWNER: Formal or casual?"),
    "Formal or casual?",
  );
  assert.equal(
    workerQuestions(
      "done\n\n## Questions for the owner\n1. Formal or casual?\n   - Casual (Recommended): matches the app.",
    ),
    "1. Formal or casual?\n   - Casual (Recommended): matches the app.",
  );
  // The last section wins when a summary repeats the heading.
  assert.equal(
    workerQuestions(
      "QUESTIONS FOR THE OWNER: draft\nmore work\nQUESTIONS FOR THE OWNER:\nFinal?",
    ),
    "Final?",
  );
});

test("an unsure worker's question pauses its task before review until the owner answers", async () => {
  const f = fixture(ASKING);
  try {
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    const brief = f.live.requests[0]!.brief;
    assert.match(brief, /do not guess/);
    assert.match(brief, /QUESTIONS FOR THE OWNER:/);
    assert.match(brief, /plain, everyday words/);
    assert.match(brief, /\(Recommended\)/);
    assert.equal(view.status, "WAITING_INPUT");
    assert.match(view.nextSteps.join(" "), /plain words/);
    assert.equal(view.questions.length, 1);
    const question = view.questions[0]!;
    assert.equal(question.taskId, "A");
    assert.equal(question.kind, "OWNER_DECISION");
    assert.equal(question.status, "OPEN");
    assert.match(question.text, /^The worker on task A left part of the work undone/);
    assert.match(question.text, /Should the greeting be formal or casual\?/);
    assert.ok(!view.tasks[0]!.steps.some((s) => s.stage === "REVIEW_GATE"));

    // While the question is open the task neither reviews nor asks again.
    view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker:claude:claude-w"]);
    assert.equal(view.questions.length, 1);

    view = f.o.reply(f.id, {
      questionId: question.id,
      replyKey: "owner-reply-1",
      text: "Casual",
      sourceRef: "test:owner",
    });
    assert.notEqual(view.status, "WAITING_INPUT");
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
  } finally {
    f.close();
  }
});

test("a worker with no questions goes straight to review", async () => {
  const f = fixture("wrote output/A/hello.txt\n\nQUESTIONS FOR THE OWNER: none");
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), [
      "worker:claude:claude-w",
      "reviewer:codex:codex-r",
    ]);
    assert.equal(view.questions.length, 0);
  } finally {
    f.close();
  }
});

test("the advisor is asked for plain-language questions with a recommendation", async () => {
  const f = fixture("wrote output/A/hello.txt", { advice: true });
  try {
    await f.o.drive(f.id, { live: true });
    const advisor = f.live.requests.find((r) => r.role === "advisor")!;
    assert.match(advisor.brief, /questionsForOwner/);
    assert.match(advisor.brief, /plain, everyday words/);
    assert.match(advisor.brief, /\(Recommended\)/);
  } finally {
    f.close();
  }
});
