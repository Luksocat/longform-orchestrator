import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller, type ControllerConfig } from "../src/controller.js";
import {
  canonical,
  demoTask,
  digest,
  specDigest,
  type Task,
} from "../src/domain.js";
import { MockProvider, type ProviderAdapter } from "../src/providers.js";
import {
  defaultRoutingPolicy,
  type ComplexityLevel,
  type RoutingPolicy,
} from "../src/routing.js";
import { openRuntime } from "../src/runtime.js";
import { SqliteStore } from "../src/store.js";

const run = promisify(execFile);
const uid = process.getuid!();
const sourceCli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const compiledCli = fileURLToPath(
  new URL("../bin/longform-orchestrator", import.meta.url),
);
const tsxHook = fileURLToPath(import.meta.resolve("tsx"));
function fixture(
  tasks: Task[] = [demoTask("A")],
  config: Partial<ControllerConfig> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-routing-workflow-"));
  const database = join(root, "state.sqlite");
  let db = new SqliteStore(database);
  let c = new Controller(db, {
    ownerUid: uid,
    workspaceRoot: join(root, "workspaces"),
    ...config,
  });
  let actor = c.localActor();
  c.importTasks(tasks, actor);
  function grant(t: Task, id = "grant-" + t.id) {
    c.grant(
      t.id,
      {
        id,
        operations: [...t.operations, "ACCEPT"],
        paths: t.writePaths,
        decisionText: "Disposable local routing regression",
        sourceRef: "test:local-owner-command",
      },
      actor,
    );
  }
  tasks.forEach((t) => grant(t));
  return {
    root,
    database,
    grant,
    get db() {
      return db;
    },
    get c() {
      return c;
    },
    get actor() {
      return actor;
    },
    reopen(nextConfig = config) {
      db.close();
      db = new SqliteStore(database);
      c = new Controller(db, {
        ownerUid: uid,
        workspaceRoot: join(root, "workspaces"),
        ...nextConfig,
      });
      actor = c.localActor();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function taskAt(
  level: Exclude<ComplexityLevel, "APEX">,
  id: string = level,
): Task {
  return demoTask(id, {
    complexity: {
      level,
      rationale: "Authenticated test estimate",
      sourceRef: "test:owner-spec",
    },
  });
}
function auto(role: "worker" | "reviewer" = "worker") {
  return { requestKey: randomUUID(), role };
}
function attempts(f: ReturnType<typeof fixture>) {
  return f.db
    .all<{ body: string }>("SELECT body FROM attempts ORDER BY rowid")
    .map((r) => JSON.parse(r.body));
}
async function child(
  f: ReturnType<typeof fixture>,
  args: string[],
  compiled = false,
) {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LONGFORM_DRIVE_READ_TOKEN",
    "LONGFORM_GITHUB_READ_TOKEN",
  ])
    delete env[key];
  const argv = compiled ? [compiledCli] : ["--import", tsxHook, sourceCli];
  return run(process.execPath, [...argv, ...args, "--db", f.database], {
    cwd: f.root,
    env,
    timeout: 15_000,
    maxBuffer: 2_097_152,
  });
}

test("automatic reservations choose all four complexity tiers and independent reviewer identity", async () => {
  for (const level of ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"] as const) {
    const f = fixture([taskAt(level)]);
    try {
      const worker = f.c.reserve(level, auto(), f.actor);
      assert.equal(worker.model, "synthetic-codex-" + level.toLowerCase());
      assert.equal(worker.routing!.mode, "AUTOMATIC");
      assert.equal(worker.routing!.assessment.level, level);
      await f.c.execute(worker, new MockProvider(), f.actor);
      const reviewer = f.c.reserve(level, auto("reviewer"), f.actor);
      assert.equal(reviewer.provider, "claude");
      assert.equal(
        reviewer.routing!.assessment.level,
        level === "ROUTINE" ? "STANDARD" : level,
      );
      assert.equal(
        reviewer.model,
        "synthetic-claude-" +
          (level === "ROUTINE" ? "standard" : level.toLowerCase()),
      );
      assert.notEqual(reviewer.workspace, worker.workspace);
    } finally {
      f.close();
    }
  }
});

test("routing decisions are durable and append-only before the adapter sees its request", async () => {
  const f = fixture();
  try {
    const a = f.c.reserve("A", auto(), f.actor);
    f.reopen();
    let calls = 0;
    const adapter: ProviderAdapter = {
      async execute(request) {
        calls++;
        const persisted = attempts(f)[0]!;
        const event = f.db.get<{ body: string }>(
          "SELECT body FROM events WHERE kind='ROUTING_DECISION' AND task_id='A'",
        )!;
        const seal = JSON.parse(event.body);
        assert.equal(persisted.model, request.model);
        assert.equal(persisted.routing.actor, f.actor.id);
        assert.equal(seal.decisionDigest, persisted.routing.decisionDigest);
        const { decisionDigest: recorded, ...payload } = seal;
        assert.equal(digest(payload), recorded);
        assert.throws(
          () =>
            f.db.run(
              "UPDATE events SET body=? WHERE kind='ROUTING_DECISION'",
              "{}",
            ),
          /APPEND_ONLY/,
        );
        assert.throws(
          () => f.db.run("DELETE FROM events WHERE kind='ROUTING_DECISION'"),
          /APPEND_ONLY/,
        );
        assert.equal(f.db.verifyEvents(), true);
        return new MockProvider().execute(request);
      },
    };
    await f.c.execute(a, adapter, f.actor);
    assert.equal(calls, 1);
    assert.equal(
      attempts(f)[0]!.routing.decisionDigest,
      a.routing!.decisionDigest,
    );
  } finally {
    f.close();
  }
});

test("a reopened runtime reloads trusted policy and never silently reselects a reserved route", async () => {
  const f = fixture();
  let runtime: ReturnType<typeof openRuntime> | undefined;
  try {
    const policy = defaultRoutingPolicy();
    const path = join(f.root, "routing.json");
    writeFileSync(path, JSON.stringify(policy));
    runtime = openRuntime(f.database, { routingPolicyPath: path });
    const a = runtime.c.reserve("A", auto(), runtime.actor);
    runtime.db.close();
    runtime = undefined;
    policy.id = "changed-trusted-policy";
    writeFileSync(path, JSON.stringify(policy));
    runtime = openRuntime(f.database, { routingPolicyPath: path });
    let calls = 0;
    await assert.rejects(
      runtime.c.execute(
        a,
        {
          async execute(r) {
            calls++;
            return new MockProvider().execute(r);
          },
        },
        runtime.actor,
      ),
      /ROUTING_POLICY_CHANGED_REPLAN_REQUIRED/,
    );
    assert.equal(calls, 0);
    assert.equal(attempts(f)[0]!.state, "RESERVED");
    assert.equal(attempts(f)[0]!.model, a.model);
  } finally {
    runtime?.db.close();
    f.close();
  }
});

test("expired or unauthenticated live capability blocks a persisted route before any invocation", async () => {
  for (const change of ["expired", "authentication-withdrawn"] as const) {
    const policy = defaultRoutingPolicy();
    const selected = policy.routes.find(
      (r) => r.id === "synthetic-codex-routine",
    )!;
    selected.simulation = false;
    selected.model = "explicit-codex-test-model";
    selected.capability = {
      provider: "codex",
      model: selected.model,
      effort: selected.effort,
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      evidenceRef: "test:trusted-local-capability-probe",
    };
    let authenticated = true;
    const config: Partial<ControllerConfig> = {
      allowRealLocalTasks: true,
      routingPolicy: policy,
      verifyRoutingCapability: () => authenticated,
    };
    const sourceDigest = digest("Disposable simulated authenticated source");
    const f = fixture(
      [
        demoTask("A", {
          simulation: false,
          sources: [
            {
              evidenceId: "fixture-source",
              revision: "test-r1",
              digest: sourceDigest,
            },
          ],
        }),
      ],
      config,
    );
    try {
      // This is a synthetic source-custody fixture, never a real connector claim.
      // No provider is invoked: the capability guards must reject beforehand.
      f.c.addEvidence(
        {
          id: "fixture-source",
          taskId: "A",
          kind: "LOCAL",
          uri: "test:synthetic-authenticated-source",
          revision: "test-r1",
          digest: sourceDigest,
          retrievedAt: new Date().toISOString(),
          authorityTier: "PLANNING",
          authentication: "AUTHENTICATED_API",
          currentness: "CURRENT_AT_RETRIEVAL",
          claims: ["Synthetic custody fixture only; no external retrieval"],
          metadata: {},
        },
        f.actor,
      );
      const a = f.c.reserve("A", auto(), f.actor);
      if (change === "expired")
        selected.capability.expiresAt = new Date(Date.now() - 1).toISOString();
      else authenticated = false;
      f.reopen(config);
      let calls = 0;
      await assert.rejects(
        f.c.execute(
          a,
          {
            async execute(r) {
              calls++;
              return new MockProvider().execute(r);
            },
          },
          f.actor,
        ),
        /ROUTING_NO_LONGER_AVAILABLE/,
      );
      assert.equal(calls, 0);
      assert.equal(attempts(f)[0]!.state, "RESERVED");
    } finally {
      f.close();
    }
  }
});

test("editing or deleting mutable routing fields cannot evade the immutable decision seal", async () => {
  for (const mutation of [
    "model",
    "assessment",
    "remove-routing",
    "forge-digest",
  ] as const) {
    const f = fixture();
    try {
      const a = f.c.reserve("A", auto(), f.actor);
      const stored = attempts(f)[0]!;
      if (mutation === "model") stored.model = "synthetic-attacker-model";
      if (mutation === "assessment") stored.routing.assessment.level = "EXPERT";
      if (mutation === "remove-routing") delete stored.routing;
      if (mutation === "forge-digest") {
        stored.model = "synthetic-forged-model";
        const { decisionDigest: _, ...record } = stored.routing;
        stored.routing.decisionDigest = digest({
          runId: stored.id,
          taskId: stored.taskId,
          role: stored.role,
          specDigest: stored.specDigest,
          simulation: stored.simulation,
          provider: stored.provider,
          model: stored.model,
          effort: stored.effort,
          routing: record,
        });
      }
      f.db.run(
        "UPDATE attempts SET body=? WHERE id=?",
        canonical(stored),
        a.id,
      );
      f.reopen();
      let calls = 0;
      await assert.rejects(
        f.c.execute(
          a,
          {
            async execute(r) {
              calls++;
              return new MockProvider().execute(r);
            },
          },
          f.actor,
        ),
        /PERSISTED_ROUTING_DECISION_(MISSING|MISMATCH)/,
      );
      assert.equal(calls, 0);
      assert.equal(f.db.verifyEvents(), true);
    } finally {
      f.close();
    }
  }
});

test("planning reports exact-tier holds and partial manual overrides cannot create attempts", () => {
  const policy = defaultRoutingPolicy();
  policy.routes = policy.routes.filter(
    (r) => r.id !== "synthetic-codex-complex",
  );
  const f = fixture([taskAt("COMPLEX", "A"), taskAt("ROUTINE", "B")], {
    routingPolicy: policy,
  });
  try {
    const plan = f.c.plan();
    assert.equal(plan.allocation.length, 1);
    assert.equal(plan.allocation[0]!.taskId, "B");
    assert.equal(plan.allocation[0]!.model, "synthetic-codex-routine");
    assert.match(
      plan.blocked.find((b) => b.taskId === "A")!.reasons.join("|"),
      /ROUTE_UNAVAILABLE.*COMPLEX/,
    );
    assert.throws(() => f.c.reserve("A", auto(), f.actor), /ROUTING_HELD/);
    for (const partial of [
      { provider: "codex" as const },
      { model: "synthetic-specified" },
      { provider: "claude" as const, effort: "high" },
    ])
      assert.throws(
        () => f.c.reserve("B", { ...auto(), ...partial }, f.actor),
        /PARTIAL_PROVIDER_SELECTION_NOT_ALLOWED/,
      );
    assert.equal(attempts(f).length, 0);
  } finally {
    f.close();
  }
});

test("explicit full selections stay visibly manual and a substituted receipt never succeeds", async () => {
  const f = fixture();
  try {
    const a = f.c.reserve(
      "A",
      {
        ...auto(),
        provider: "claude",
        model: "operator-explicit-model",
        effort: "high",
        overrideReason: "Operator-selected local compatibility control",
      },
      f.actor,
    );
    assert.equal(a.routing!.mode, "MANUAL");
    assert.match(
      a.routing!.reasons.join(" "),
      /Operator-selected local compatibility control/,
    );
    assert.equal(a.routing!.policyId, undefined);
    await assert.rejects(
      f.c.execute(
        a,
        {
          async execute(r) {
            assert.equal(r.provider, "claude");
            assert.equal(r.model, "operator-explicit-model");
            assert.equal(r.effort, "high");
            return {
              ...(await new MockProvider().execute(r)),
              model: "synthetic-substituted-model",
            };
          },
        },
        f.actor,
      ),
      /IDENTITY|MISMATCH/,
    );
    assert.equal(attempts(f)[0]!.state, "UNKNOWN");
    assert.equal(
      f.db.get("SELECT id FROM receipts WHERE attempt_id=?", a.id),
      undefined,
    );
    assert.equal(f.c.task("A").status, "BLOCKED");
  } finally {
    f.close();
  }
});

test("the CLI refuses a real task registered without a stated risk, before the schema can default it", async () => {
  const f = fixture();
  try {
    const { risk: _risk, ...unstated } = JSON.parse(
      JSON.stringify(demoTask("R", { simulation: false })),
    );
    const path = join(f.root, "tasks.json");
    writeFileSync(path, JSON.stringify([unstated]));
    await assert.rejects(
      child(f, ["register", "--file", path, "--execute"]),
      (error: { stdout?: string; stderr?: string; message: string }) =>
        /RISK_REQUIRED/.test(
          String(error.stdout) + String(error.stderr) + error.message,
        ),
    );
    assert.ok(!f.c.tasks().some((t) => t.id === "R"));
    // Stated, the same record registers.
    writeFileSync(path, JSON.stringify([{ ...unstated, risk: "LOW" }]));
    await child(f, ["register", "--file", path, "--execute"]);
    assert.ok(f.c.tasks().some((t) => t.id === "R"));
  } finally {
    f.close();
  }
});

test("legacy task specification digests survive loading without a complexity hint", async () => {
  // A legacy schema implementation and synthetic planning records exercise
  // compatibility when the optional complexity field is absent.
  const archive = new URL("./fixtures/legacy-format/", import.meta.url);
  const oldDomain = await import(new URL("domain.ts", archive).href);
  const snapshot = JSON.parse(
    readFileSync(new URL("programme-snapshot.json", archive), "utf8"),
  );
  const f = fixture([]);
  try {
    f.c.importTasks(snapshot.tasks, f.actor);
    for (const raw of snapshot.tasks) {
      const old = oldDomain.TaskSchema.parse(raw);
      const current = f.c.task(raw.id);
      assert.equal(Object.hasOwn(current, "complexity"), false);
      assert.equal(specDigest(current), oldDomain.specDigest(old));
    }
  } finally {
    f.close();
  }
  assert.ok(snapshot.tasks.length >= 21);
});

test("raising structured complexity invalidates old grants before automatic dispatch", () => {
  const f = fixture();
  try {
    const originalDigest = specDigest(f.c.task("A"));
    const replacement = {
      ...f.c.task("A"),
      specVersion: 2,
      complexity: {
        level: "EXPERT" as const,
        rationale: "New authenticated scope assessment",
        sourceRef: "test:owner-revision",
      },
    };
    f.c.revise("A", replacement, f.actor);
    assert.notEqual(specDigest(f.c.task("A")), originalDigest);
    const route = f.c.route("A");
    assert.equal(route.ok, true);
    if (route.ok) assert.equal(route.model, "synthetic-codex-expert");
    assert.throws(() => f.c.reserve("A", auto(), f.actor), /TASK_BLOCKED/);
    f.grant(f.c.task("A"), "revised-spec-grant");
    assert.equal(
      f.c.reserve("A", auto(), f.actor).model,
      "synthetic-codex-expert",
    );
  } finally {
    f.close();
  }
});

for (const compiled of [false, true])
  test(`${compiled ? "compiled" : "source"} CLI defaults to automatic routing with a trusted policy, dry-run and inspect provenance`, async () => {
    const f = fixture([taskAt("COMPLEX", "A")]);
    try {
      const policy: RoutingPolicy = defaultRoutingPolicy();
      policy.id = "operator-test-complexity-policy";
      const target = policy.routes.find(
        (r) => r.id === "synthetic-codex-complex",
      )!;
      target.model = "synthetic-operator-complex-model";
      const path = join(f.root, "policy.json");
      writeFileSync(path, JSON.stringify(policy));
      const options = ["--routing-policy", path];
      const preview = JSON.parse(
        (await child(f, ["route", "A", ...options], compiled)).stdout,
      );
      assert.equal(preview.routing.model, target.model);
      assert.equal(preview.routingDoesNotAuthorizeDispatch, true);
      const dry = JSON.parse(
        (await child(f, ["dispatch", "A", "--mock", ...options], compiled))
          .stdout,
      );
      assert.equal(dry.dryRun, true);
      assert.equal(attempts(f).length, 0);
      const receipt = JSON.parse(
        (
          await child(
            f,
            [
              "dispatch",
              "A",
              "--mock",
              "--request-key",
              randomUUID(),
              "--execute",
              ...options,
            ],
            compiled,
          )
        ).stdout,
      );
      assert.equal(receipt.status, "SUCCEEDED");
      assert.equal(receipt.model, target.model);
      assert.equal(receipt.effort, "high");
      assert.equal(receipt.simulation, true);
      const inspected = JSON.parse(
        (await child(f, ["inspect", "A", ...options], compiled)).stdout,
      );
      assert.equal(inspected.attempts[0].routing.mode, "AUTOMATIC");
      assert.equal(inspected.attempts[0].routing.policyDigest, digest(policy));
      const bogus = join(f.root, "bogus-reconcile.json");
      writeFileSync(
        bogus,
        JSON.stringify({ outcome: "SUCCEEDED", evidenceId: "nonexistent" }),
      );
      await assert.rejects(
        child(
          f,
          [
            "reconcile",
            "--run-id",
            receipt.runId,
            "--file",
            bogus,
            "--execute",
            ...options,
          ],
          compiled,
        ),
        /INVALID_RECONCILIATION_OUTCOME/,
      );
      assert.equal(f.db.verifyEvents(), true);
      assert.equal(f.c.report().releaseAuthorized, false);
    } finally {
      f.close();
    }
  });

test("policy withdrawal during execution aborts heartbeats and rejects otherwise successful completion", async () => {
  const policy = defaultRoutingPolicy();
  const f = fixture([demoTask("A")], { routingPolicy: policy, leaseMs: 90 });
  try {
    const a = f.c.reserve("A", auto(), f.actor);
    let aborted = false;
    await assert.rejects(
      f.c.execute(
        a,
        {
          async execute(r) {
            policy.id = "withdrawn-during-execution";
            await new Promise<void>((resolve) => {
              if (r.signal!.aborted) {
                aborted = true;
                resolve();
                return;
              }
              r.signal!.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  resolve();
                },
                { once: true },
              );
            });
            const receipt = await new MockProvider().execute({
              ...r,
              signal: undefined,
            });
            return receipt;
          },
        },
        f.actor,
      ),
      /ROUTING_POLICY_CHANGED_REPLAN_REQUIRED/,
    );
    assert.equal(aborted, true);
    assert.equal(attempts(f)[0]!.state, "UNKNOWN");
    assert.equal(
      f.db.get("SELECT id FROM receipts WHERE attempt_id=?", a.id),
      undefined,
    );
    assert.equal(f.c.task("A").status, "BLOCKED");
  } finally {
    f.close();
  }
});
