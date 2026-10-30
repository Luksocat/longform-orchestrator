import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { demoTask } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import {
  acquireLiveHostLock,
  LiveConfigSchema,
  resolveHost,
} from "../src/live.js";
// The bridge is plain JavaScript shipped in the plugin; type its two exports here.
const { bridgeArguments, bridgeHost } = (await import(
  "../plugins/longform-orchestrator/skills/longform-orchestrator/scripts/bridge.mjs" as string
)) as {
  bridgeArguments: (
    args: string[],
    config: { cli: string; databasePath: string },
    host?: string,
  ) => string[];
  bridgeHost: (path?: string) => string | undefined;
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "longform-host-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
  });
  c.importTasks([demoTask("A"), demoTask("B")], c.localActor());
  return {
    c,
    db,
    as: (host: "claude" | "codex" | "operator") =>
      new Orchestrator(c, {}, host),
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const submit = (
  o: Orchestrator,
  requestKey: string = randomUUID(),
  taskIds = ["A"],
) =>
  o.submit({
    requestKey,
    prompt: "Bounded synthetic task",
    context: { cwd: "/tmp" },
    sourceRef: "test:host",
    taskIds,
  });

test("a host cannot change, drive or resume another host's request", async () => {
  const f = fixture();
  try {
    const claude = f.as("claude"),
      codex = f.as("codex");
    const view = submit(claude, "shared-key");
    const id = view.request.id;
    assert.equal(view.request.host, "claude");
    // Reading is shared state; acting is not.
    assert.equal(codex.inspect(id).request.id, id);
    assert.throws(
      () => codex.attach(id, ["B"]),
      /REQUEST_OWNED_BY_OTHER_HOST:claude/,
    );
    assert.throws(
      () => codex.ask(id, { key: "q1", text: "Which scope?" }),
      /REQUEST_OWNED_BY_OTHER_HOST/,
    );
    await assert.rejects(
      codex.drive(id, { mock: true }),
      /REQUEST_OWNED_BY_OTHER_HOST/,
    );
    assert.throws(
      () => submit(codex, "shared-key"),
      /REQUEST_OWNED_BY_OTHER_HOST:claude/,
    );
    // The owner's terminal is neutral and may act on either host's request.
    assert.doesNotThrow(() => f.as("operator").assertHost(id));
    assert.doesNotThrow(() => f.as("operator").assertTaskHost("A"));
    // The owning host keeps full control.
    assert.equal(claude.attach(id, ["B"]).tasks.length, 2);
  } finally {
    f.close();
  }
});

test("runs inherit their request's host for cancel and reconcile", async () => {
  const f = fixture();
  try {
    const claude = f.as("claude");
    const id = submit(claude).request.id;
    f.c.grant(
      "A",
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: ["output/A"],
        decisionText: "synthetic",
        sourceRef: "test:host",
      },
      f.c.localActor(),
    );
    await claude.drive(id, { mock: true });
    const run = f.c.inspect("A").attempts[0]!;
    assert.doesNotThrow(() => claude.assertRunHost(run.id));
    assert.throws(
      () => f.as("codex").assertRunHost(run.id),
      /RUN_OWNED_BY_OTHER_HOST:claude/,
    );
    // Runs dispatched outside any request have no host owner.
    assert.doesNotThrow(() => f.as("codex").assertRunHost("not-linked"));
  } finally {
    f.close();
  }
});

test("requests from before host tagging stay usable by every host", () => {
  const f = fixture();
  try {
    const legacy = submit(f.as("claude")).request.id;
    // Strip the tag as an untagged legacy event would have it.
    const row = f.db.get<{ seq: number; body: string }>(
      "SELECT seq,body FROM events WHERE kind='WORKFLOW_SUBMITTED'",
    )!;
    const body = JSON.parse(row.body);
    delete body.request.host;
    // Test-only: lift append-only protection to recreate a pre-tagging event.
    f.db.run("DROP TRIGGER immutable_events_update");
    f.db.run(
      "UPDATE events SET body=? WHERE seq=?",
      JSON.stringify(body),
      row.seq,
    );
    assert.equal(f.as("codex").inspect(legacy).request.host, undefined);
    assert.equal(f.as("codex").attach(legacy, ["B"]).tasks.length, 2);
  } finally {
    f.close();
  }
});

test("host resolution prefers the bridge, then the host environment", () => {
  assert.equal(resolveHost("codex", { CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(resolveHost("claude", {}), "claude");
  // A label that contradicts the running host is refused (review F8).
  assert.throws(
    () => resolveHost("codex", { CLAUDECODE: "1" }),
    /HOST_CONFLICT/,
  );
  assert.throws(
    () => resolveHost("operator", { CODEX_THREAD_ID: "t" }),
    /HOST_CONFLICT/,
  );
  assert.equal(resolveHost(undefined, { CLAUDECODE: "1" }), "claude");
  assert.equal(resolveHost(undefined, { CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(resolveHost(undefined, {}), "operator");
  assert.throws(
    () => resolveHost(undefined, { CLAUDECODE: "1", CODEX_THREAD_ID: "t" }),
    /HOST_AMBIGUOUS/,
  );
  assert.throws(() => resolveHost("gemini", {}), /INVALID_HOST/);
  assert.equal(
    bridgeHost("/home/u/.claude/skills/longform-orchestrator/scripts/bridge.mjs"),
    "claude",
  );
  assert.equal(
    bridgeHost(
      "/home/u/.codex/plugins/longform-orchestrator/skills/longform-orchestrator/scripts/bridge.mjs",
    ),
    "codex",
  );
  const config = {
    cli: "/p/dist/src/cli.js",
    databasePath: "/p/.longform/state.sqlite",
  };
  assert.deepEqual(bridgeArguments(["status"], config, "codex").slice(-2), [
    "--host",
    "codex",
  ]);
  assert.throws(
    () => bridgeArguments(["status", "--host", "claude"], config, "codex"),
    /HOST_OVERRIDE_DENIED/,
  );
});

test("a live run refuses while the other host has a live process", async () => {
  const root = mkdtempSync(join(tmpdir(), "longform-hostlock-"));
  const config = LiveConfigSchema.parse({
    version: 1,
    stateDir: join(root, "runner"),
    routingPolicyPath: join(root, "policy.json"),
    sanitizedPublicBrief: true,
    providers: {},
  });
  const other = spawn("/bin/sleep", ["30"]);
  try {
    const release = acquireLiveHostLock(config, "claude");
    // Same host may overlap; the controller handles same-host concurrency.
    acquireLiveHostLock(config, "claude")();
    // Record the other process as a live Codex orchestrator.
    const stat = readFileSync(`/proc/${other.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    writeFileSync(
      join(config.stateDir, "active", `codex-${other.pid}.json`),
      JSON.stringify({ host: "codex", pid: other.pid, start }),
    );
    assert.throws(
      () => acquireLiveHostLock(config, "claude"),
      new RegExp(`OTHER_HOST_LIVE_PROCESS_ACTIVE:codex:pid=${other.pid}`),
    );
    release();
    // And Codex is refused while Claude holds a lock.
    const claudeAgain = (() => {
      other.kill("SIGKILL");
      return new Promise((r) => other.once("exit", r));
    })();
    await claudeAgain;
    // A dead owner is stale and cleared.
    const relock = acquireLiveHostLock(config, "claude");
    assert.throws(
      () => acquireLiveHostLock(config, "codex"),
      /OTHER_HOST_LIVE_PROCESS_ACTIVE:claude/,
    );
    relock();
    acquireLiveHostLock(config, "codex")();
  } finally {
    other.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
