/**
 * Issue #12, slice E1: the CAPABILITY_BIDIRECTIONAL_V1 workflow value, its
 * policy schema, and the split of project governance from fixed pairing.
 * Scenario IDs identify synthetic regression cases.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { canonical, demoTask, digest } from "../src/domain.js";
import {
  RoutingPolicySchema,
  defaultRoutingPolicy,
  floorFor,
  isFableModel,
  projectGovernedWorkflow,
  resolveRoute,
  type RoutingPolicy,
} from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { MockProvider } from "../src/providers.js";
import { fableQuarantined } from "../src/live.js";
import { runBase01 } from "./fixtures/adaptive/base01-fixture.js";

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const adaptiveExample = () =>
  read("../docs/examples/adaptive-routing-policy.example.json");
const twoTierExample = () =>
  read("./fixtures/adaptive/two-tier-policy.json");
const withoutCapabilities = (p: RoutingPolicy) => ({
  ...p,
  routes: p.routes.map(({ capability: _c, ...r }) => r),
});

function controller(policy: () => RoutingPolicy) {
  const root = mkdtempSync(join(tmpdir(), "adaptive-workflow-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    routingPolicyLoader: policy,
    verifyRoutingCapability: () => true,
  });
  return {
    c,
    db,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("BASE-01: a two-tier project's normalized journal is identical to the two-tier compatibility baseline", async () => {
  const golden = read("./fixtures/adaptive/base01-two-tier.golden.json");
  const events = await runBase01();
  assert.equal(canonical(events), canonical(golden));
});

test("BASE-01: the two-tier policy parses to the digest it had in the two-tier compatibility baseline", () => {
  const parsed = RoutingPolicySchema.parse(twoTierExample());
  assert.equal(parsed.workflow, "ASTRA_TWO_TIER");
  assert.equal(parsed.adaptive, undefined);
  assert.equal(
    digest(withoutCapabilities(parsed)),
    "59f9dbe75abbe62bbc24ef085c7d674bc228b009a7e576109064eb03b798e823",
  );
});

test("BASE-02: legacy pairing stays a two-tier exemption", () => {
  const p = adaptiveExample();
  assert.throws(
    () =>
      RoutingPolicySchema.parse({
        ...p,
        routes: [
          ...p.routes,
          {
            ...p.routes.find((r: any) => r.id === "opus-complex-high-worker"),
            id: "legacy-claude-worker",
            legacyPairing: true,
          },
        ],
      }),
    /Legacy-pairing routes exist only in the two-tier workflow/,
  );
  const f = controller(() => RoutingPolicySchema.parse(adaptiveExample()));
  try {
    f.c.importTasks([demoTask("A", { simulation: false, risk: "LOW" })], f.c.localActor());
    assert.equal(f.c.twoTier(), false);
    assert.equal(f.c.legacyClaudeAuthorship(f.c.task("A")), false);
  } finally {
    f.close();
  }
});

test("BASE-03: a run reserved before the adaptive workflow appears keeps its identity and is never re-routed", () => {
  let policy: RoutingPolicy = defaultRoutingPolicy();
  const f = controller(() => policy);
  try {
    const actor = f.c.localActor();
    const t = demoTask("A");
    f.c.importTasks([t], actor);
    f.c.grant(
      "A",
      {
        id: "g",
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Disposable local test",
        sourceRef: "test:owner",
      },
      actor,
    );
    const reserved = f.c.reserve("A", { requestKey: "k1" }, actor);
    const before = f.db.get<{ body: string }>(
      "SELECT body FROM attempts WHERE id=?",
      reserved.id,
    )!.body;
    const claimsBefore = canonical(f.c.unresolvedClaims());
    policy = RoutingPolicySchema.parse({
      ...adaptiveExample(),
      routes: adaptiveExample().routes.map((r: any) => ({ ...r, simulation: true })),
    });
    assert.equal(f.c.adaptive(), true);
    // The stored run is untouched: same provider, model, effort, routing
    // record, lease and claims; nothing selected anew.
    assert.equal(
      f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", reserved.id)!.body,
      before,
    );
    assert.equal(canonical(f.c.unresolvedClaims()), claimsBefore);
    assert.equal(
      f.db.all("SELECT * FROM attempts").length,
      1,
      "no second run was reserved",
    );
    assert.equal(
      f.db.all("SELECT * FROM events WHERE kind LIKE 'ADAPTIVE_%'").length,
      0,
    );
  } finally {
    f.close();
  }
});

test("BASE-03: a run started before the adaptive workflow appears keeps its identity through the switch", async () => {
  let policy: RoutingPolicy = defaultRoutingPolicy();
  const f = controller(() => policy);
  try {
    const actor = f.c.localActor();
    const t = demoTask("A");
    f.c.importTasks([t], actor);
    f.c.grant(
      "A",
      {
        id: "g",
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Disposable local test",
        sourceRef: "test:owner",
      },
      actor,
    );
    const reserved = f.c.reserve("A", { requestKey: "k1" }, actor);
    const identity = (row: any) => {
      const a = JSON.parse(row.body);
      return canonical({ provider: a.provider, model: a.model, effort: a.effort, routing: a.routing, specDigest: a.specDigest });
    };
    const before = identity(f.db.get("SELECT body FROM attempts WHERE id=?", reserved.id));
    let sawStarted = false;
    const adapter = {
      async execute(r: any) {
        // The owner switches the workflow while this run is STARTED.
        sawStarted =
          JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", r.runId)!.body)
            .state === "STARTED";
        policy = RoutingPolicySchema.parse({
          ...adaptiveExample(),
          routes: adaptiveExample().routes.map((x: any) => ({ ...x, simulation: true })),
        });
        return new MockProvider({}).execute(r);
      },
    };
    // The existing rule for a policy changed under a running run applies
    // unchanged: its return is refused and the run is held for
    // reconciliation, keeping its claim.
    await assert.rejects(
      () => f.c.execute(reserved, adapter as any, actor),
      /ROUTING_NO_LONGER_AVAILABLE:ADAPTIVE_INTAKE_DISABLED/,
    );
    assert.ok(sawStarted, "the switch happened while the run was STARTED");
    const row = f.db.get<{ state: string; body: string }>("SELECT state, body FROM attempts WHERE id=?", reserved.id)!;
    assert.equal(row.state, "UNKNOWN");
    assert.deepEqual(
      f.db.all<{ holder_id: string; state: string }>("SELECT holder_id, state FROM resource_claims").map((c) => [c.holder_id, c.state]),
      [[reserved.id, "RUN"]],
    );
    // Its identity is unchanged, and nothing was selected or reserved anew.
    assert.equal(identity(row), before);
    assert.equal(f.db.all("SELECT * FROM attempts").length, 1);
    assert.equal(f.db.all("SELECT * FROM events WHERE kind LIKE 'ADAPTIVE_%'").length, 0);
  } finally {
    f.close();
  }
});

test("the adaptive example policy parses and is disabled for intake", () => {
  const p = RoutingPolicySchema.parse(adaptiveExample());
  assert.equal(p.workflow, "CAPABILITY_BIDIRECTIONAL_V1");
  assert.equal(p.adaptive?.intake, "DISABLED");
  assert.ok(p.routes.every((r) => !isFableModel(r.model)));
  assert.ok(projectGovernedWorkflow(p.workflow));
  assert.ok(projectGovernedWorkflow("ASTRA_TWO_TIER"));
  assert.ok(!projectGovernedWorkflow(undefined));
});

test("adaptive policy schema rules", () => {
  const base = adaptiveExample();
  const route = (id: string) => base.routes.find((r: any) => r.id === id);
  const bad = (change: (p: any) => void, message: RegExp) => {
    const p = structuredClone(base);
    change(p);
    assert.throws(() => RoutingPolicySchema.parse(p), message);
  };
  bad((p) => delete p.adaptive, /requires its adaptive section/);
  bad((p) => (p.workflow = "ASTRA_TWO_TIER"), /adaptive section belongs only/);
  assert.throws(
    () =>
      RoutingPolicySchema.parse({
        ...twoTierExample(),
        routes: twoTierExample().routes.map((r: any) =>
          r.roles.includes("overseer") ? { ...r, demands: ["BOUNDED"] } : r,
        ),
      }),
    /demands belong only to the adaptive workflow/,
  );
  bad(
    (p) => delete p.routes.find((r: any) => r.id === "sol-max-overseer").demands,
    /names the demands it serves/,
  );
  bad(
    (p) => (p.routes.find((r: any) => r.id === "sol-assessor").demands = ["BOUNDED"]),
    /Only overseer routes name oversight demands/,
  );
  bad(
    (p) =>
      p.routes.push({
        ...route("sol-complex-xhigh-worker"),
        id: "both",
        roles: ["worker", "reviewer"],
      }),
    /exactly one role/,
  );
  bad(
    (p) =>
      p.routes.push({ ...route("sol-complex-xhigh-worker"), id: "low", effort: "low" }),
    /use high, xhigh or max/,
  );
  bad(
    (p) =>
      p.routes.push({ ...route("sol-complex-xhigh-worker"), id: "r", level: "ROUTINE" }),
    /COMPLEX or EXPERT/,
  );
  bad(
    (p) => p.adaptive.evaluationPlans.push({ ...p.adaptive.evaluationPlans[0] }),
    /Duplicate evaluation plan IDs/,
  );
  bad(
    (p) =>
      p.adaptive.floorExceptions.push({
        id: "x",
        provider: "codex",
        role: "worker",
        effort: "high",
        scope: "BOUNDED_OVERSIGHT",
        approvalRef: "test",
        evaluationPlanId: "unfrozen-example-plan",
      }),
    /BOUNDED_OVERSIGHT exceptions are for overseers/,
  );
  bad((p) => (p.adaptive.ceiling.continuations = 3), /Too big|less than or equal|<=/);
});

test("inherited floors are fixed constants", () => {
  assert.equal(floorFor("codex", "worker", "COMPLEX"), "xhigh");
  assert.equal(floorFor("codex", "reviewer", "EXPERT"), "max");
  assert.equal(floorFor("claude", "worker", "COMPLEX"), "high");
  assert.equal(floorFor("claude", "reviewer", "EXPERT"), "xhigh");
  assert.equal(floorFor("codex", "overseer", "COMPLEX"), "xhigh");
  assert.equal(floorFor("claude", "overseer", "EXPERT"), "xhigh");
  assert.ok(isFableModel("claude-fable-5-1"));
  assert.ok(!isFableModel("claude-opus-5-5"));
  assert.ok(!isFableModel("fabled-model"));
});

test("OVS-07 (governance half): the adaptive workflow keeps every project gate on and never uses the fixed pairing", () => {
  const policy = RoutingPolicySchema.parse({
    ...adaptiveExample(),
    routes: adaptiveExample().routes.map((r: any) => ({ ...r, simulation: true })),
  });
  const f = controller(() => policy);
  try {
    const actor = f.c.localActor();
    const t = demoTask("A", {
      reviewPolicy: { required: true, crossProvider: false, independentAudits: false },
    });
    f.c.importTasks([t], actor);
    assert.equal(f.c.projectGoverned(), true);
    assert.equal(f.c.twoTier(), false);
    assert.equal(f.c.adaptive(), true);
    // Forced independent cross-provider review, as under two-tier.
    assert.deepEqual(f.c.reviewPolicyInForce("A"), {
      required: true,
      crossProvider: true,
      independentAudits: true,
    });
    assert.deepEqual(f.c.reachableWorkerTiers("A"), ["COMPLEX", "EXPERT"]);
    // The fixed resolver never picks an adaptive worker, reviewer or overseer;
    // the controller selects them adaptively instead (here intake is off).
    for (const role of ["worker", "reviewer", "overseer"] as const) {
      const fixed = resolveRoute(f.c.task("A"), role, policy);
      assert.equal(fixed.ok, false);
      assert.match(fixed.reasons.join("|"), /ADAPTIVE_SELECTION_REQUIRED/);
      const r = f.c.route("A", role);
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.reasons.join("|"), /ADAPTIVE_SELECTION_REQUIRED/);
    }
    assert.match(f.c.route("A", "worker").reasons.join("|"), /ADAPTIVE_INTAKE_DISABLED/);
    // Every run needs a project request, and routing stays automatic.
    assert.throws(
      () => f.c.reserve("A", { requestKey: "k" }, actor),
      /PROJECT_REQUEST_REQUIRED/,
    );
    assert.throws(
      () =>
        f.c.reserve(
          "A",
          { requestKey: "k2", provider: "codex", model: "m", effort: "max" },
          actor,
        ),
      /TWO_TIER_REQUIRES_AUTOMATIC_ROUTING/,
    );
  } finally {
    f.close();
  }
});

test("DUR-07 (listed roles): a Fable route is quarantined in every adaptive role, whatever its attestation", () => {
  const p = adaptiveExample();
  const policy = RoutingPolicySchema.parse({
    ...p,
    routes: [
      {
        ...p.routes.find((r: any) => r.id === "sol-assessor"),
        id: "fable-assessor",
        provider: "claude",
        model: "claude-fable-5-1",
      },
      ...p.routes,
    ].map((r: any) => ({
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
  const task = demoTask("A", { simulation: false, risk: "LOW" });
  const r = resolveRoute(task, "assessor", policy, {
    verifyLiveCapability: () => true,
  });
  assert.ok(r.ok);
  assert.equal(r.routeId, "sol-assessor");
  assert.match(r.reasons.join("|"), /FABLE_QUARANTINED: fable-assessor/);
});

test("DUR-07 (attestation): no live attestation path attests a Fable route for adaptive use", () => {
  const adaptive = RoutingPolicySchema.parse(adaptiveExample());
  const twoTier = RoutingPolicySchema.parse(twoTierExample());
  const fable = { ...adaptive.routes[0]!, id: "fable", provider: "claude" as const, model: "claude-fable-5-1" };
  // preflight, the attest command, provider rechecks and just-in-time
  // renewals all go through refreshAttestations or recheckProviders, which
  // skip a route this predicate quarantines.
  assert.equal(fableQuarantined(adaptive, fable), true);
  assert.equal(fableQuarantined(adaptive, adaptive.routes[0]!), false);
  // The fixed workflow's attestation behaviour is unchanged.
  assert.equal(fableQuarantined(twoTier, fable), false);
});
