import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { canonical, TaskSchema, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import type {
  ProviderAdapter,
  ProviderReceipt,
  ProviderRequest,
} from "../src/providers.js";
import {
  ProjectProfileSchema,
  RoutingPolicySchema,
  stakes,
  type ProjectProfile,
  type RoutingCapability,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { redact } from "../src/providers.js";

// Work types . A
// task names its kind; the project profile says what its worker keeps in
// mind, what its reviewer checks and whether it gets proposals, and the
// owner's working rules come from their one file.

const here = dirname(fileURLToPath(import.meta.url));
const RULES = [
  "# Working rules",
  "",
  "## 1. Owner commands",
  "- Do what the owner says.",
  "",
  "## 3. Stay on task",
  "- RULE-THREE: do the task you were given.",
  "",
  "## 9. Project working rules",
  "- RULE-NINE: Separate proposed changes from accepted decisions.",
  "  - Example authorization: 1ExampleRulesFixtureAaBbCcDdEeFf003",
  "",
].join("\n");

function profile(rulesFile: string, sections = ["3", "9"]): ProjectProfile {
  return ProjectProfileSchema.parse({
    version: 1,
    ownerRules: { file: rulesFile, sections },
    kinds: {
      rules: {
        title: "Domain rules",
        expert: true,
        worker: ["MECH-WORKER: write each rule as its own item."],
        reviewer: ["MECH-REVIEWER: look for exploits."],
      },
      records: {
        title: "Records and filing",
        proposals: false,
        worker: ["REC-WORKER: copy exactly."],
        reviewer: ["REC-REVIEWER: compare byte for byte."],
      },
      plain: { title: "Plain work" },
    },
  });
}

test("the example profile parses, with generic work types", () => {
  const example = ProjectProfileSchema.parse(
    JSON.parse(readFileSync(join(here, "..", "docs", "examples", "project-profile.example.json"), "utf8")),
  );
  assert.deepEqual(Object.keys(example.kinds!), [
    "rules",
    "writing",
    "engineering-design",
    "code",
    "owner-brief",
    "records",
  ]);
  assert.equal(example.kinds!.records!.proposals, false);
  assert.equal(example.kinds!.rules!.expert, true);
});

const now = new Date().toISOString();
const route = (id: string, level: string, provider: "claude" | "codex", model: string, roles: string[]) => ({
  id,
  level,
  provider,
  model,
  effort: "medium",
  roles,
  simulation: false,
  enabled: true,
  capability: {
    provider,
    model,
    effort: "medium",
    verifiedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "test:attested",
  },
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "kinds-test",
  routes: [
    route("w-routine", "ROUTINE", "claude", "claude-w", ["worker"]),
    route("w-expert", "EXPERT", "claude", "claude-x", ["worker"]),
    route("r-standard", "STANDARD", "codex", "codex-r", ["reviewer"]),
    route("r-expert", "EXPERT", "codex", "codex-rx", ["reviewer"]),
    route("advisor", "EXPERT", "claude", "claude-a", ["advisor"]),
  ],
});

/** Records every request; reviewers pass, with one proposal when offered. */
function adapter() {
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
      const p = (request.outputSchema as { properties: Record<string, any> } | undefined)?.properties;
      if (request.role === "worker") {
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "x.md"), "work\n");
        return receipt("wrote output/A/x.md");
      }
      if (request.role === "advisor")
        return receipt(canonical({ taskId: p!.taskId.enum[0], approach: "a", steps: [], risks: [], checks: [], questionsForOwner: [] }));
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
          auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "ok",
            limitations: [],
          })),
          ...(p!.proposals
            ? {
                proposals: [
                  {
                    what: "Say it warmer.",
                    why: "output/A/x.md",
                    userImpact: "Feels kinder.",
                    weight: "IDEA",
                    touchesDecision: false,
                  },
                ],
              }
            : {}),
        }),
      );
    },
  };
  return self;
}

function fixture(kind: string | undefined, options: { sections?: string[]; advice?: boolean; rules?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "longform-kinds-"));
  const rulesFile = join(root, "AGENTS.md");
  writeFileSync(rulesFile, options.rules ?? RULES);
  const db = new SqliteStore(join(root, "state.sqlite"));
  const projectProfile = profile(rulesFile, options.sections);
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    projectProfile: projectProfile,
    verifyRoutingCapability: (_cap: RoutingCapability) => true,
  });
  const live = adapter();
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Do the work",
    context: { cwd: root },
    sourceRef: "test:kinds",
  });
  const source = o.ownerSource(request.request.id);
  const task = (overrides: Partial<Task> = {}) =>
    TaskSchema.parse({
      id: "A",
      programme: "TEST",
      lane: "LOCAL",
      title: "Work",
      scope: "work",
      deliverable: "output/A/x.md",
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
      reviewPolicy: { required: true, crossProvider: true, independentAudits: true },
      acceptance: [{ id: "x", description: "x", evidenceKind: "LOCAL" }],
      simulation: false,
      ...(kind ? { kind } : {}),
      ...(options.advice ? { advice: { rationale: "owner asked", sourceRef: "test:kinds" } } : {}),
      budget: { deadlineMs: 60_000, maxAttempts: 3, maxCostUsd: 5, maxTokens: 10_000 },
      ...overrides,
    });
  return {
    c,
    o,
    live,
    id: request.request.id,
    task,
    register() {
      c.importTasks([task()], c.localActor());
      c.grant(
        "A",
        { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/A"], decisionText: "test", sourceRef: "test:kinds" },
        c.localActor(),
      );
      o.attach(request.request.id, ["A"]);
    },
    rulesFile,
    /** The controller's profile, which a test may edit as the operator would. */
    projectProfile,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}

test("a task's kind must be one the profile defines", () => {
  const f = fixture("nonsense");
  try {
    assert.throws(() => f.c.importTasks([f.task()], f.c.localActor()), /UNKNOWN_WORK_KIND:nonsense/);
  } finally {
    f.close();
  }
});

test("an expert kind is EXPERT work that needs independent review", () => {
  const f = fixture("rules");
  try {
    const p = profile(f.rulesFile);
    const t = f.task();
    assert.equal(stakes(t, p).level, "EXPERT");
    assert.ok(stakes(t, p).reasons.includes("EXPERT: is Domain rules work"));
    assert.equal(stakes(f.task({ kind: "plain" }), p).level, "ROUTINE");
    assert.throws(
      () =>
        f.c.importTasks(
          [f.task({ reviewPolicy: { required: true, crossProvider: true, independentAudits: false } })],
          f.c.localActor(),
        ),
      /STAKES_REQUIRE_INDEPENDENT_REVIEW: .*Domain rules/,
    );
  } finally {
    f.close();
  }
});

test("the worker, advisor and reviewer briefs carry the work type and the owner's rules; a task without a kind gets neither", async () => {
  const f = fixture("rules", { advice: true });
  try {
    f.register();
    await f.o.drive(f.id, { live: true });
    const brief = (role: string) => f.live.requests.find((r) => r.role === role)!.brief;
    assert.match(brief("worker"), /WORK TYPE: Domain rules\. Keep in mind:\n- MECH-WORKER/);
    assert.match(brief("advisor"), /WORK TYPE: Domain rules\. The worker will keep in mind:\n- MECH-WORKER/);
    assert.match(brief("reviewer"), /WORK TYPE: Domain rules\. Beyond the task's acceptance, check:\n- MECH-REVIEWER/);
    assert.doesNotMatch(brief("reviewer"), /MECH-WORKER/);
    for (const role of ["worker", "advisor", "reviewer"]) {
      assert.match(brief(role), /THE OWNER'S WORKING RULES \(sections 3, 9 of AGENTS\.md/);
      assert.match(brief(role), /RULE-THREE/);
      assert.match(brief(role), /RULE-NINE/);
      // Only the configured sections.
      assert.doesNotMatch(brief(role), /Do what the owner says/);
      // Credential-like text is masked, so the provider's secret check passes
      // Secret-like authorization labels are redacted in inherited rules.
      assert.match(brief(role), /Example authorization: \[REDACTED\]/);
      assert.match(brief(role), /text that looks like a credential is masked/);
      assert.equal(redact(brief(role)), brief(role));
    }
  } finally {
    f.close();
  }
  const g = fixture(undefined);
  try {
    g.register();
    await g.o.drive(g.id, { live: true });
    for (const r of g.live.requests) {
      assert.doesNotMatch(r.brief, /WORK TYPE/);
      assert.doesNotMatch(r.brief, /OWNER'S WORKING RULES/);
    }
  } finally {
    g.close();
  }
});

test("a work type without proposals asks for none and opens no round", async () => {
  const f = fixture("records");
  try {
    f.register();
    await f.o.drive(f.id, { live: true });
    const reviewer = f.live.requests.find((r) => r.role === "reviewer")!;
    assert.doesNotMatch(reviewer.brief, /proposals:/);
    assert.equal((reviewer.outputSchema as any).properties.proposals, undefined);
    assert.equal(f.c.proposalRound("A"), undefined);
    assert.ok(!f.live.requests.some((r) => r.role === "worker" && r.outputSchema));
  } finally {
    f.close();
  }
  const g = fixture("plain");
  try {
    g.register();
    await g.o.drive(g.id, { live: true });
    // A work type with proposals keeps them.
    assert.ok(g.c.proposalRound("A"));
  } finally {
    g.close();
  }
});

test("a missing rules section stops the brief before anything is reserved", async () => {
  const f = fixture("plain", { sections: ["3", "4"] });
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(f.live.requests.length, 0);
    assert.deepEqual(f.c.inspect("A").attempts, []);
    assert.ok(
      view.tasks[0]!.steps.some((s) => /OWNER_RULES_SECTION_MISSING: 4/.test(s.detail)),
      JSON.stringify(view.tasks[0]!.steps),
    );
  } finally {
    f.close();
  }
});

test("a kind's behaviour is bound to the specification; editing the profile changes only later ones (review K5)", async () => {
  const f = fixture("plain");
  try {
    f.register();
    await f.o.drive(f.id, { live: true });
    assert.ok(f.c.proposalRound("A"));
    // The operator turns proposals off and makes the kind EXPERT.
    f.projectProfile.kinds!.plain = { ...f.projectProfile.kinds!.plain!, proposals: false, expert: true };
    // The open round and the routing of this specification are unchanged.
    assert.ok(f.c.proposalRound("A"));
    assert.ok(!f.c.route("A", "worker").assessment.reasons.some((r) => /Plain work/.test(r)));
    // A revision binds the profile's settings now.
    const actor = f.c.localActor();
    f.c.revise("A", { ...f.c.task("A"), specVersion: 2, reviewPolicy: { required: true, crossProvider: true, independentAudits: true } }, actor);
    assert.ok(f.c.route("A", "worker").assessment.reasons.some((r) => /EXPERT: is Plain work work/.test(r)));
    assert.equal(f.c.proposalRound("A"), undefined);
  } finally {
    f.close();
  }
});

test("a kind name that is only an inherited object property is unknown (review K7)", () => {
  const f = fixture("constructor");
  try {
    assert.throws(() => f.c.importTasks([f.task()], f.c.localActor()), /UNKNOWN_WORK_KIND:constructor/);
  } finally {
    f.close();
  }
});

test("a kinded specification saved without its settings is held until a revision records them (review K12)", async () => {
  const f = fixture("plain");
  try {
    // As a build from before kinds were bound saved it: the task names its
    // kind, but no settings were recorded for this specification.
    registerUnbound(f);
    const actor = f.c.localActor();
    assert.throws(
      () => f.c.reserve("A", { role: "worker", requestKey: "early", projectRequestId: f.id }, actor),
      /KIND_NOT_BOUND:A/,
    );
    // Meanwhile it is treated strictly: EXPERT.
    assert.ok(f.c.route("A", "worker").assessment.reasons.some((r) => /EXPERT: is Plain work work/.test(r)));
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.live.requests.length, 0);
    assert.ok(JSON.stringify(view).includes("KIND_NOT_BOUND"), JSON.stringify(view.tasks[0]));
    // Work saved before the upgrade cannot be verified either.
    const c = f.c as any,
      hold = c.assertKindBound;
    c.assertKindBound = () => {};
    try {
      await (f.o as any).worker(f.id, "A", true);
    } finally {
      c.assertKindBound = hold;
    }
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.throws(() => f.c.verify("A", actor), /KIND_NOT_BOUND:A/);
    // A revision records the profile's settings: no longer held, and no
    // longer EXPERT, since this kind is not.
    f.c.revise("A", { ...f.c.task("A"), specVersion: 2 }, actor);
    assert.doesNotThrow(() => (f.c as any).assertKindBound(f.c.task("A")));
    assert.ok(!f.c.route("A", "worker").assessment.reasons.some((r) => /Plain work/.test(r)));
  } finally {
    f.close();
  }
});

/** Register the task as a build from before kinds were bound did: recording no settings. */
function registerUnbound(f: ReturnType<typeof fixture>) {
  const c = f.c as any;
  const bind = c.bindKind;
  c.bindKind = () => {};
  try {
    f.register();
  } finally {
    c.bindKind = bind;
  }
}
