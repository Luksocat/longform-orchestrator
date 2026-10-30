import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { canonical, TaskSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import {
  escalateForFailedReviews,
  RoutingPolicySchema,
  type ComplexityAssessment,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

const now = new Date().toISOString();
const route = (
  id: string,
  level: string,
  provider: "claude" | "codex",
  model: string,
  effort: string,
  role: "worker" | "reviewer",
) => ({
  id,
  level,
  provider,
  model,
  effort,
  roles: [role],
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
  id: "escalation-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-low", "low", "worker"),
    route(
      "claude-standard",
      "STANDARD",
      "claude",
      "claude-mid",
      "medium",
      "worker",
    ),
    route(
      "claude-complex",
      "COMPLEX",
      "claude",
      "claude-high",
      "high",
      "worker",
    ),
    route(
      "codex-standard",
      "STANDARD",
      "codex",
      "codex-r",
      "medium",
      "reviewer",
    ),
  ],
});

/** Live-shaped receipts without a model; the worker leaves a private (700) folder. */
function adapter(verdicts: ("FAIL" | "PASS")[]): ProviderAdapter & {
  requests: ProviderRequest[];
} {
  const self = {
    requests: [] as ProviderRequest[],
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      self.requests.push(request);
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
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A", "private"), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(join(request.cwd, "output", "A", "hello.txt"), "hello\n");
        return receipt("wrote output/A/hello.txt");
      }
      const verdict =
        verdicts[
          self.requests.filter((r) => r.role === "reviewer").length - 1
        ] ?? "PASS";
      const p = (request.outputSchema as { properties: Record<string, any> })
        .properties;
      const ev: string[] = p.availableEvidence.items.enum;
      return receipt(
        canonical({
          taskId: p.taskId.enum[0],
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: p.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings:
            verdict === "FAIL"
              ? [
                  {
                    materiality: "MAJOR",
                    evidenceIds: [],
                    description: "wrong greeting",
                  },
                ]
              : [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation: verdict === "FAIL" ? ["fix the greeting"] : [],
          residualHolds: [],
          verdict,
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

function fixture(verdicts: ("FAIL" | "PASS")[]) {
  const root = mkdtempSync(join(tmpdir(), "longform-escalation-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: () => true,
  });
  const live = adapter(verdicts);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write a greeting",
    context: { cwd: root },
    sourceRef: "test:escalation",
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
          maxAttempts: 5,
          maxCostUsd: 5,
          maxTokens: 10_000,
        },
      }),
    ],
    c.localActor(),
  );
  const grant = () =>
    c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "test",
        sourceRef: "test:escalation",
      },
      c.localActor(),
    );
  grant();
  o.attach(request.request.id, ["A"]);
  /** The usual rework path after a failed review: revise, regrant, rebind. */
  const rework = () => {
    const t = c.task("A");
    c.revise(
      "A",
      { ...t, scope: t.scope + ". Fix it.", specVersion: t.specVersion + 1 },
      c.localActor(),
    );
    grant();
    o.rebind(request.request.id, ["A"]);
  };
  return {
    c,
    o,
    live,
    id: request.request.id,
    rework,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const workerModels = (f: ReturnType<typeof fixture>) =>
  f.live.requests.filter((r) => r.role === "worker").map((r) => r.model);

test("a worker's private folder survives the copy made for its reviewer", async () => {
  const f = fixture(["PASS"]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(f.c.inspect("A").reviews.length, 1);
    assert.equal(f.c.inspect("A").reviews[0].verdict, "PASS");
    assert.notEqual(view.tasks[0]!.status, "BLOCKED");
  } finally {
    f.close();
  }
});

test("two failed reviews at one tier move the next worker run up a tier", async () => {
  const f = fixture(["FAIL", "FAIL", "PASS"]);
  try {
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(f.c.route("A").assessment.level, "ROUTINE");
    f.rework();
    await f.o.drive(f.id, { live: true });
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    const next = f.c.route("A");
    assert.equal(next.assessment.level, "STANDARD");
    assert.ok(
      next.assessment.reasons.some((r) =>
        r.startsWith("ESCALATED ROUTINE -> STANDARD"),
      ),
    );
    f.rework();
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(workerModels(f), [
      "claude-low",
      "claude-low",
      "claude-mid",
    ]);
    assert.deepEqual(
      f.c.inspect("A").reviews.map((r: { verdict: string }) => r.verdict),
      ["FAIL", "FAIL", "PASS"],
    );
    // The reviewer tier is unchanged by worker escalation.
    assert.ok(
      f.live.requests
        .filter((r) => r.role === "reviewer")
        .every((r) => r.model === "codex-r"),
    );
  } finally {
    f.close();
  }
});

test("escalation steps one tier per tier that failed twice, and never past APEX", () => {
  const at = (level: ComplexityAssessment["level"]): ComplexityAssessment => ({
    level,
    confidence: "HEURISTIC",
    reasons: [],
  });
  assert.equal(escalateForFailedReviews(at("ROUTINE"), []).level, "ROUTINE");
  assert.equal(
    escalateForFailedReviews(at("ROUTINE"), ["ROUTINE"]).level,
    "ROUTINE",
  );
  assert.equal(
    escalateForFailedReviews(at("ROUTINE"), [
      "ROUTINE",
      "ROUTINE",
      "STANDARD",
      "STANDARD",
    ]).level,
    "COMPLEX",
  );
  // Failures below the task's own tier don't raise it further.
  assert.equal(
    escalateForFailedReviews(at("COMPLEX"), ["ROUTINE", "ROUTINE"]).level,
    "COMPLEX",
  );
  // Two failed reviews at EXPERT take the step above it; nothing goes past APEX.
  assert.equal(
    escalateForFailedReviews(at("EXPERT"), ["EXPERT"]).level,
    "EXPERT",
  );
  assert.equal(
    escalateForFailedReviews(at("EXPERT"), ["EXPERT", "EXPERT", "EXPERT"])
      .level,
    "APEX",
  );
  assert.equal(
    escalateForFailedReviews(at("APEX"), ["APEX", "APEX", "APEX"]).level,
    "APEX",
  );
  const unchanged = at("STANDARD");
  assert.equal(escalateForFailedReviews(unchanged, []), unchanged);
});
