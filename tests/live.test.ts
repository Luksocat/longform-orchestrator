import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import {
  attest,
  BubblewrapRunner,
  EgressBroker,
  liveProvider,
  LiveConfigSchema,
  type LiveConfig,
} from "../src/live.js";
import {
  buildCliArguments,
  inspectCliOutput,
  OWNER_TEXT_IN_SANDBOX,
} from "../src/providers.js";
import { kernelLock, readAttestations } from "../src/live.js";
import { resolveRoute, RoutingPolicySchema } from "../src/routing.js";
import { openRuntime } from "../src/runtime.js";
import { demoTask } from "../src/domain.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { sandboxed as live } from "./sandbox-support.js";

// Fake CLIs: behaviour is keyed on brief text so tests can drive edge cases.
const FAKE_CLAUDE = `#!${process.execPath}
const a = process.argv.slice(2), fs = require("fs");
if (a[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (a[0] === "--help") { console.log("--model --effort --print --output-format --no-session-persistence --tools --strict-mcp-config --bare --restricted --allowedTools"); process.exit(0); }
if (a.includes("--bare") || !process.env.CLAUDE_CODE_OAUTH_TOKEN) process.exit(3);
const brief = fs.readFileSync(0, "utf8");
if (brief.includes("TOKENSHAPE") && !/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(process.env.CLAUDE_CODE_OAUTH_TOKEN)) process.exit(6);
if (brief.includes("ESCAPE")) { require("child_process").spawn("/bin/sh", ["-c", "sleep 600"], { detached: true, stdio: "ignore" }); setTimeout(() => {}, 600000); return; }
const model = brief.includes("WRONGMODEL") ? "claude-substituted" : a[a.indexOf("--model") + 1];
const out = { type: "result", is_error: false, session_id: require("crypto").randomUUID(), modelUsage: { [model]: {} }, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 }, result: "OK token=" + process.env.CLAUDE_CODE_OAUTH_TOKEN };
if (brief.includes("PRETTY")) { console.log(JSON.stringify({ ...out, result: "OK " + "p".repeat(1400) }).slice(0, -1) + ',\\n"evidence":[\\n' + JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "required evidence" } }) + '\\n]}'); return; }
if (a.includes("--json-schema")) {
  const s = JSON.parse(a[a.indexOf("--json-schema") + 1]).properties, ev = s.availableEvidence.items.enum ?? [];
  out.structured_output = { taskId: s.taskId.enum[0], artifactRevision: s.artifactRevision.enum[0], specDigest: s.specDigest.enum[0], provider: s.provider.enum[0],
    authorshipDisclosure: "Separate fake session", availableEvidence: ev, findings: [], testsExecuted: [], testsNotExecuted: ["none"], conflictingEvidence: [], remediation: [], residualHolds: [],
    verdict: "PASS", scope: "fake", nextAuthorizedStep: "bind", auditAssessments: ["ACCURACY","LOCAL_ANTI_DRIFT","MACRO_ANTI_DRIFT"].map((kind) => ({ kind, result: "PASS", evidenceIds: ev, assessment: "fake", limitations: [] })) };
} else if (a[a.indexOf("--tools") + 1] === "Read,Edit,Write") {
  const dir = brief.includes("OUTSIDE") ? "elsewhere" : "output/A";
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + "/hello.txt", "hello\\n");
}
console.log(JSON.stringify(out));
`;
const FAKE_CODEX = `#!${process.execPath}
const a = process.argv.slice(2), fs = require("fs");
if (a[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (a[0] === "exec" && a[1] === "--help") { console.log("--model --json --ephemeral --sandbox --ignore-user-config --ignore-rules"); process.exit(0); }
const brief = fs.readFileSync(0, "utf8"), home = process.env.CODEX_HOME;
if (brief.includes("SLOW")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
if (a.includes("--ephemeral")) process.exit(3);
const auth = JSON.parse(fs.readFileSync(home + "/auth.json", "utf8"));
if (brief.includes("REFRESH")) fs.writeFileSync(home + "/auth.json", JSON.stringify({ ...auth, refreshed: true }));
const model = a[a.indexOf("--model") + 1], effort = JSON.parse(a.find((x) => x.startsWith("model_reasoning_effort=")).split("=")[1]);
const id = require("crypto").randomUUID(); fs.mkdirSync(home + "/sessions/x", { recursive: true });
fs.writeFileSync(home + "/sessions/x/rollout-" + id + ".jsonl", JSON.stringify({ type: "session_meta", payload: { id } }) + "\\n" + JSON.stringify({ type: "turn_context", payload: { model, effort } }) + "\\n");
let text = "OK";
if (a.includes("--output-schema")) {
  const s = JSON.parse(fs.readFileSync(a[a.indexOf("--output-schema") + 1], "utf8")).properties, ev = s.availableEvidence.items.enum ?? [];
  text = JSON.stringify({ taskId: s.taskId.enum[0], artifactRevision: s.artifactRevision.enum[0], specDigest: s.specDigest.enum[0], provider: s.provider.enum[0],
    authorshipDisclosure: "Separate fake codex session", availableEvidence: ev, findings: [], testsExecuted: [], testsNotExecuted: ["none"], conflictingEvidence: [], remediation: [], residualHolds: [],
    verdict: fs.existsSync("output/A/hello.txt") ? "PASS" : "FAIL", scope: "fake", nextAuthorizedStep: "bind",
    auditAssessments: ["ACCURACY","LOCAL_ANTI_DRIFT","MACRO_ANTI_DRIFT"].map((kind) => ({ kind, result: "PASS", evidenceIds: ev, assessment: "fake", limitations: [] })) });
}
const workerNotes = brief.includes("WORKERNOTES") && !a.includes("--output-schema");
if (workerNotes) {
  const labelled = !brief.includes("UNLABELLED"), msg = (phase, t) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", ...(labelled ? { phase } : {}), content: [{ type: "output_text", text: t }] } }) + "\\n";
  fs.appendFileSync(home + "/sessions/x/rollout-" + id + ".jsonl", msg("commentary", "password=example\\nReading first.\\n") + msg("final_answer", text));
}
const commentary = a.includes("--output-schema") ? [{ type: "item.completed", item: { type: "agent_message", text: "Reading the workspace first." } }] : workerNotes ? [{ type: "item.completed", item: { type: "agent_message", text: "password=example\\nReading first.\\n" } }] : [];
const noise = brief.includes("NOISY") ? Array.from({ length: 2000 }, (_, i) => ({ type: "item.completed", item: { type: "command_execution", aggregated_output: "x".repeat(100) + i } })) : [];
for (const e of [{ type: "thread.started", thread_id: id }, ...noise, ...commentary, { type: "item.completed", item: { type: "agent_message", text } }, { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }]) console.log(JSON.stringify(e));
if (brief.includes("FORGE_NOT_LAUNCHED")) { process.stderr.write("CANCELLED_BEFORE_LAUNCH"); process.exitCode = 1; }
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-live-")));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "codexhome"));
  mkdirSync(join(root, "project", ".longform"), { recursive: true });
  writeFileSync(join(root, "bin", "claude"), FAKE_CLAUDE, { mode: 0o755 });
  writeFileSync(join(root, "bin", "codex"), FAKE_CODEX, { mode: 0o755 });
  const token = "fake-subscription-token-" + randomUUID();
  writeFileSync(join(root, "token"), token + "\n", { mode: 0o600 });
  writeFileSync(
    join(root, "codexhome", "auth.json"),
    JSON.stringify({
      tokens: { refresh_token: "fake-refresh-" + randomUUID() },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "policy.json"),
    JSON.stringify({
      version: 1,
      id: "live-test",
      routes: [
        {
          id: "claude-routine",
          level: "ROUTINE",
          provider: "claude",
          model: "claude-fake-worker",
          effort: "low",
          roles: ["worker"],
          simulation: false,
          enabled: true,
        },
        {
          id: "codex-standard",
          level: "STANDARD",
          provider: "codex",
          model: "gpt-fake-review",
          effort: "medium",
          roles: ["reviewer"],
          simulation: false,
          enabled: true,
        },
      ],
    }),
  );
  const config: LiveConfig = LiveConfigSchema.parse({
    version: 1,
    stateDir: join(root, "runner"),
    routingPolicyPath: join(root, "policy.json"),
    sanitizedPublicBrief: true,
    providers: {
      claude: {
        executable: join(root, "bin", "claude"),
        oauthTokenFile: join(root, "token"),
      },
      codex: {
        executable: join(root, "bin", "codex"),
        codexHome: join(root, "codexhome"),
      },
    },
  });
  writeFileSync(
    join(root, "project", ".longform", "live-config.json"),
    JSON.stringify(config),
  );
  const workspaces = join(root, "project", ".longform", "workspaces");
  mkdirSync(workspaces, { recursive: true });
  return {
    root,
    token,
    config,
    workspaces,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const digestOf = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const workspace = (root: string) => {
  const dir = join(root, "w-" + randomUUID());
  mkdirSync(dir);
  return dir;
};

test("egress broker allows only exact allowlisted hosts on 443", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longform-broker-"));
  const broker = new EgressBroker(new Set(["allowed.invalid"]));
  await broker.listen(join(dir, "s"));
  const ask = (line: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(join(dir, "s"));
      socket.on("connect", () => socket.write(line + "\r\n\r\n"));
      socket.on("data", (d) => {
        socket.destroy();
        resolve(d.toString().split("\r\n")[0]!);
      });
      socket.on("error", () => resolve("ERROR"));
    });
  try {
    assert.match(await ask("CONNECT example.com:443 HTTP/1.1"), / 403 /);
    assert.match(await ask("CONNECT allowed.invalid:80 HTTP/1.1"), / 403 /);
    assert.match(await ask("CONNECT 1.1.1.1:443 HTTP/1.1"), / 403 /);
    assert.match(await ask("GET http://allowed.invalid/ HTTP/1.1"), / 403 /);
    // Allowed name passes policy; the unresolvable upstream yields 502, not 403.
    assert.match(await ask("CONNECT allowed.invalid:443 HTTP/1.1"), / 502 /);
    assert.deepEqual(
      broker.decisions.map((d) => d.allowed),
      [false, false, false, false, true],
    );
  } finally {
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "runner self-test proves network, filesystem and process isolation",
  live,
  async () => {
    const f = setup();
    try {
      const runner = new BubblewrapRunner(f.config);
      const exe = f.config.providers.claude!.executable;
      for (const writable of [false, true]) {
        const v = await runner.verify({
          provider: "claude",
          executable: exe,
          executableDigest: digestOf(exe),
          workspace: workspace(f.workspaces),
          writableWorkspace: writable,
          writablePaths: [],
        });
        assert.equal(v.osIsolated, true);
        assert.equal(v.filesystemAllowlisted, true);
        // Network allowlisting needs host DNS for the allowed name; offline hosts report false.
        const probe = JSON.parse(
          readFileSync(v.evidenceRef.slice(5).split("#")[0]!, "utf8"),
        ).probe;
        assert.notEqual(probe.directEgress, "CONNECTED");
        assert.notEqual(probe.dns, "RESOLVED");
        assert.match(probe.deniedTarget, / 403 /);
        assert.deepEqual(probe.forbiddenVisible, []);
        assert.equal(probe.workspaceWrite, writable ? "WRITABLE" : "EROFS");
      }
      await assert.rejects(
        runner.verify({
          provider: "claude",
          executable: "/bin/true",
          executableDigest: digestOf("/bin/true"),
          workspace: f.workspaces,
          writableWorkspace: false,
          writablePaths: [],
        }),
        /RUNNER_EXECUTABLE_NOT_CONFIGURED/,
      );
    } finally {
      f.close();
    }
  },
);

// Source packs and read-only Drive , through the real sandbox.
test(
  "a Drive worker starts with its pack; a Drive reviewer reads without changing its workspace",
  live,
  async () => {
    const f = setup();
    try {
      writeFileSync(
        join(f.root, "client.json"),
        JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }),
      );
      writeFileSync(join(f.root, "drive-token.json"), JSON.stringify({ refresh_token: "r" }));
      const config = LiveConfigSchema.parse({
        ...f.config,
        drive: { clientFile: join(f.root, "client.json"), tokenFile: join(f.root, "drive-token.json") },
      });
      const doc = {
        id: "docAAAAAAAAAAAAA",
        name: "Packet",
        mimeType: "application/vnd.google-apps.document",
        parents: ["folderAAAAAAAAAA"],
        version: "5",
      };
      const calls: string[] = [];
      // When set, the pack's export waits until the run is cancelled.
      let slow: (() => void) | undefined;
      const driveFetcher = async (raw: string, init: RequestInit) => {
        const url = new URL(raw);
        calls.push(url.pathname);
        if (slow && url.pathname.endsWith("/export")) {
          slow();
          await new Promise((_, reject) =>
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
          );
        }
        const json = (v: unknown) =>
          new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "ya29.test" });
        if (url.pathname === "/drive/v3/files/" + doc.id) return json(doc);
        if (url.pathname === "/drive/v3/files/" + doc.id + "/export")
          return new Response("# Packet v1\n", { status: 200 });
        return new Response("unexpected", { status: 400 });
      };
      const runner = new BubblewrapRunner(config, { driveFetcher });
      assert.equal(
        (await attest(config, "claude", "claude-fake-worker", "low", f.workspaces)).attested,
        true,
      );
      const adapter = liveProvider(config, "claude", f.workspaces, runner);
      const base = {
        taskId: "T",
        provider: "claude" as const,
        model: "claude-fake-worker",
        effort: "low",
        brief: "work",
        deadlineMs: 30_000,
        maxTokens: 1000,
        maxCostUsd: 1,
      };
      const evidence = (runId: string) =>
        JSON.parse(readFileSync(join(config.stateDir, "evidence", "run-" + runId + ".json"), "utf8"));
      // The worker: its pack is fetched by the host and lands in its workspace.
      const workerRun = "w-" + randomUUID();
      const workerDir = workspace(f.workspaces);
      const worked = await adapter.execute({
        ...base,
        runId: workerRun,
        role: "worker",
        cwd: workerDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
        drivePolicy: { read: ["folderAAAAAAAAAA"], update: [], createIn: [], pack: [doc.id] },
      });
      assert.equal(worked.status, "SUCCEEDED", worked.output);
      const pack = join(workerDir, "drive-changes", workerRun, "pack");
      assert.equal(readFileSync(join(pack, doc.id + ".md"), "utf8"), "# Packet v1\n");
      assert.equal(JSON.parse(readFileSync(join(pack, "MANIFEST.json"), "utf8"))[0].version, "5");
      assert.deepEqual(
        evidence(workerRun).drive.pack.map((p: { id: string }) => p.id),
        [doc.id],
      );
      // A later run on a copy of that work (a rework, say) that alters the
      // earlier run's pack gets the host's bytes back (review r2 R6), and one
      // that plants a file in the record fails.
      const reworkDir = workspace(f.workspaces);
      cpSync(workerDir, reworkDir, { recursive: true });
      const earlierPack = join(reworkDir, "drive-changes", workerRun, "pack", doc.id + ".md");
      writeFileSync(earlierPack, "# Invented\n");
      const reworked = await adapter.execute({
        ...base,
        runId: "w-" + randomUUID(),
        role: "worker",
        cwd: reworkDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
        drivePolicy: { read: ["folderAAAAAAAAAA"], update: [], createIn: [] },
      });
      assert.equal(reworked.status, "SUCCEEDED", reworked.output);
      assert.equal(readFileSync(earlierPack, "utf8"), "# Packet v1\n");
      writeFileSync(join(reworkDir, "drive-changes", workerRun, "pack", "planted.md"), "x\n");
      const planted = await adapter.execute({
        ...base,
        runId: "w-" + randomUUID(),
        role: "worker",
        cwd: reworkDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
      });
      assert.equal(planted.status, "FAILED");
      // The reviewer: read-only Drive, record on the host, workspace untouched.
      const reviewRun = "r-" + randomUUID();
      const reviewDir = workspace(f.workspaces);
      writeFileSync(join(reviewDir, "artifact.txt"), "work\n");
      const reviewed = await adapter.execute({
        ...base,
        runId: reviewRun,
        role: "reviewer",
        cwd: reviewDir,
        filesystemPolicy: { writablePaths: [] },
        drivePolicy: { read: ["folderAAAAAAAAAA"], update: [], createIn: [] },
      });
      assert.equal(reviewed.status, "SUCCEEDED", reviewed.output);
      assert.deepEqual(readdirSync(reviewDir), ["artifact.txt"]);
      const record = evidence(reviewRun).drive;
      assert.equal(record.readOnly, true);
      assert.equal(record.workspaceCopy, undefined);
      assert.ok(existsSync(join(record.auditDir, "log.jsonl")) || record.calls === 0);
      // A reviewer that asks to write is refused before anything starts.
      const refused = await adapter.execute({
        ...base,
        runId: "r-" + randomUUID(),
        role: "reviewer",
        cwd: reviewDir,
        filesystemPolicy: { writablePaths: [] },
        drivePolicy: { read: "ANY", update: [doc.id], createIn: [] },
      });
      assert.equal(refused.output, "DRIVE_WRITE_REQUIRES_WRITABLE_WORKER");
      // A pack file the host cannot read stops the worker before it launches.
      const failedRun = "w-" + randomUUID();
      const failedDir = workspace(f.workspaces);
      const failed = await adapter.execute({
        ...base,
        runId: failedRun,
        role: "worker",
        cwd: failedDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
        drivePolicy: { read: "ANY", update: [], createIn: [], pack: [doc.id, "missingAAAAAAAAA"] },
      });
      assert.equal(failed.status, "FAILED");
      assert.deepEqual([failed.costUsd, failed.tokens], [0, 0]);
      assert.equal(failed.notLaunched, true);
      assert.match(failed.output, /DRIVE_PACK_FAILED: .*DRIVE_HTTP_400/);
      assert.deepEqual(readdirSync(failedDir), []);
      // Cancelled while the pack is fetched: the run never launches, reports
      // no usage, and nothing reaches its workspace (review r1 finding R2).
      const atSlow = new Promise<void>((r) => (slow = r));
      const cancel = new AbortController();
      const slowDir = workspace(f.workspaces);
      const running = adapter.execute({
        ...base,
        runId: "w-" + randomUUID(),
        role: "worker",
        cwd: slowDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
        drivePolicy: { read: "ANY", update: [], createIn: [], pack: [doc.id] },
        signal: cancel.signal,
      });
      await atSlow;
      cancel.abort();
      const cancelled = await running;
      assert.equal(cancelled.status, "CANCELLED");
      // A known non-launch: truthful zero usage, not an unknown outcome.
      assert.match(cancelled.output, /CANCELLED_BEFORE_LAUNCH/);
      assert.equal(cancelled.notLaunched, true);
      assert.deepEqual([cancelled.costUsd, cancelled.tokens], [0, 0]);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(readdirSync(slowDir), []);
      // A cancel through the runner alone also stops the fetch, and confirms
      // only once it has stopped.
      const atSlowAgain = new Promise<void>((r) => (slow = r));
      const directRun = "w-" + randomUUID();
      const directDir = workspace(f.workspaces);
      const direct = adapter.execute({
        ...base,
        runId: directRun,
        role: "worker",
        cwd: directDir,
        filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
        drivePolicy: { read: "ANY", update: [], createIn: [], pack: [doc.id] },
      });
      await atSlowAgain;
      const cancelledAt = Date.now();
      assert.equal(await runner.cancel(directRun), true);
      const ended = await direct;
      // Cancelled promptly, not stopped later by the run's deadline.
      assert.equal(ended.status, "CANCELLED");
      assert.ok(Date.now() - cancelledAt < 5_000);
      assert.match(ended.output, /CANCELLED_BEFORE_LAUNCH/);
      assert.deepEqual([ended.costUsd, ended.tokens], [0, 0]);
      assert.deepEqual(readdirSync(directDir), []);
      slow = undefined;
      // A cancel confirmed while the run is still being set up (here, while
      // its egress broker starts) stops it before any Drive call (review r2).
      const listen = EgressBroker.prototype.listen;
      let atSetup!: () => void;
      let resume!: () => void;
      const setupReached = new Promise<void>((r) => (atSetup = r));
      const setupGate = new Promise<void>((r) => (resume = r));
      const earlyRun = "w-" + randomUUID();
      // Only this run's own broker waits (the runner's self-test starts one
      // too, before the run is registered).
      const registered = () =>
        (runner as unknown as { pending: Map<string, unknown> }).pending.has(earlyRun);
      EgressBroker.prototype.listen = async function (this: EgressBroker, path: string) {
        if (registered()) {
          atSetup();
          await setupGate;
        }
        return listen.call(this, path);
      };
      try {
        const earlyDir = workspace(f.workspaces);
        const before = calls.length;
        const early = adapter.execute({
          ...base,
          runId: earlyRun,
          role: "worker",
          cwd: earlyDir,
          filesystemPolicy: { writablePaths: ["output/A", "drive-changes"] },
          drivePolicy: { read: "ANY", update: [], createIn: [], pack: [doc.id] },
        });
        await setupReached;
        assert.equal(await runner.cancel(earlyRun), true);
        resume();
        const stopped = await early;
        assert.equal(stopped.status, "CANCELLED");
        assert.match(stopped.output, /CANCELLED_BEFORE_LAUNCH/);
        assert.equal(calls.length, before);
        assert.deepEqual(readdirSync(earlyDir), []);
      } finally {
        EgressBroker.prototype.listen = listen;
      }
    } finally {
      f.close();
    }
  },
);

test("subscription arguments drop --bare/--ephemeral and pass output schemas", () => {
  const request = {
    runId: "r",
    taskId: "T",
    model: "m",
    effort: "low",
    role: "reviewer" as const,
    cwd: "/x",
    brief: "b",
    deadlineMs: 1000,
    outputSchema: { type: "object" },
  };
  const claude = buildCliArguments(
    "claude",
    { ...request, provider: "claude" },
    false,
    { subscriptionAuth: true },
  );
  assert.ok(!claude.includes("--bare") && claude.includes("--restricted"));
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Glob,Grep");
  assert.equal(
    claude[claude.indexOf("--json-schema") + 1],
    '{"type":"object"}',
  );
  const codex = buildCliArguments(
    "codex",
    { ...request, provider: "codex" },
    false,
    {
      subscriptionAuth: true,
      outputSchemaPath: "/home/worker/output-schema.json",
    },
  );
  assert.ok(!codex.includes("--ephemeral"));
  assert.equal(
    codex[codex.indexOf("--output-schema") + 1],
    "/home/worker/output-schema.json",
  );
  // API-key mode keeps the original hardened arguments.
  const legacy = buildCliArguments("claude", {
    ...request,
    provider: "claude",
    outputSchema: undefined,
  });
  assert.ok(legacy.includes("--bare"));
  assert.equal(legacy[legacy.indexOf("--tools") + 1], "");
});

test(
  "live adapter needs attestation, redacts the token and rejects substituted models",
  live,
  async () => {
    const f = setup();
    try {
      const runner = new BubblewrapRunner(f.config);
      const request = (brief: string, model = "claude-fake-worker") => ({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "claude" as const,
        model,
        effort: "low",
        role: "worker" as const,
        cwd: workspace(f.workspaces),
        brief,
        deadlineMs: 30_000,
        maxTokens: 1000,
        maxCostUsd: 1,
        filesystemPolicy: { writablePaths: ["output/A"] },
      });
      // One adapter throughout: it reads the proofs at each run, so a route
      // attested after it was built counts .
      const adapter = liveProvider(f.config, "claude", f.workspaces, runner);
      const before = await adapter.execute(request("work"));
      assert.equal(before.output, "CURRENT_MODEL_CAPABILITY_UNVERIFIED");
      // Nothing launched: usage is a truthful zero, so the controller records a
      // clean failure rather than an unknown outcome (review F5).
      assert.deepEqual([before.costUsd, before.tokens], [0, 0]);
      assert.equal(
        (
          await attest(
            f.config,
            "claude",
            "claude-fake-worker",
            "low",
            f.workspaces,
          )
        ).attested,
        true,
      );
      const ok = await adapter.execute(request("work"));
      assert.equal(ok.status, "SUCCEEDED");
      assert.equal(ok.identityVerified, true);
      assert.ok(
        !ok.output.includes(f.token) && ok.output.includes("[REDACTED]"),
      );
      assert.equal(ok.tokens, 15);
      const substituted = await adapter.execute(request("WRONGMODEL"));
      assert.equal(substituted.status, "FAILED");
      assert.equal(substituted.output, "PROVIDER_MODEL_IDENTITY_MISMATCH");
      assert.equal(
        (await adapter.execute(request("work", "claude-unattested"))).output,
        "CURRENT_MODEL_CAPABILITY_UNVERIFIED",
      );
    } finally {
      f.close();
    }
  },
);

test(
  "cancellation is confirmed only after the whole PID namespace stops",
  live,
  async () => {
    const f = setup();
    try {
      await attest(
        f.config,
        "claude",
        "claude-fake-worker",
        "low",
        f.workspaces,
      );
      const adapter = liveProvider(
        f.config,
        "claude",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 1_500);
      const receipt = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "claude",
        model: "claude-fake-worker",
        effort: "low",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "ESCAPE",
        deadlineMs: 30_000,
        signal: abort.signal,
      });
      assert.equal(receipt.status, "CANCELLED");
      const survivors = execFileSync("ps", ["-eo", "args"])
        .toString()
        .split("\n")
        .filter((l) => l.trim() === "sleep 600");
      assert.deepEqual(survivors, []);
    } finally {
      f.close();
    }
  },
);

test(
  "codex refreshes persist to the dedicated home and runs are serialized",
  live,
  async () => {
    const f = setup();
    try {
      assert.equal(
        (
          await attest(
            f.config,
            "codex",
            "gpt-fake-review",
            "medium",
            f.workspaces,
          )
        ).attested,
        true,
      );
      const adapter = liveProvider(
        f.config,
        "codex",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const request = (brief: string) => ({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex" as const,
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer" as const,
        cwd: workspace(f.workspaces),
        brief,
        deadlineMs: 30_000,
      });
      const [one, two] = await Promise.all([
        adapter.execute(request("REFRESH")),
        adapter.execute(request("plain")),
      ]);
      assert.equal(one.status, "SUCCEEDED");
      assert.equal(two.status, "SUCCEEDED");
      assert.equal(
        JSON.parse(readFileSync(join(f.root, "codexhome", "auth.json"), "utf8"))
          .refreshed,
        true,
      );
      assert.equal(one.costUsd, 0);
      assert.ok(!existsSync(join(f.config.stateDir, "codex.lock")));
    } finally {
      f.close();
    }
  },
);

const runCli = promisify(execFile);
const cliSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));
async function cli(args: string[]) {
  const result = await runCli(
    process.execPath,
    ["--import", tsx, cliSource, ...args],
    {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  return JSON.parse(result.stdout);
}

function liveTask(
  source: { evidenceId: string; revision: string; digest: string } | null,
  brief = "Write a greeting",
) {
  return {
    id: "A",
    programme: "LOCAL_LIVE_TEST",
    lane: "LOCAL",
    title: "hello",
    scope: brief,
    deliverable: "output/A/hello.txt",
    specVersion: 1,
    status: "DISCOVERED",
    artifactRevision: "r1",
    createdAt: "2026-10-20T00:00:00.000Z",
    dimensions: {
      authorization: "LOCAL_ONLY",
      sourceEffectuation: "CANDIDATE",
      implementation: "NOT_STARTED",
      review: "NONE",
      release: "NOT_AUTHORIZED",
    },
    dependencies: [],
    blockers: [],
    sources: source
      ? [{ ...source, evidenceId: source.evidenceId + "-A" }]
      : [],
    specificationAuthenticated: true,
    providers: ["claude", "codex"],
    operations: ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: ["output/A"],
    resources: [],
    risk: "LOW",
    reviewPolicy: {
      required: true,
      crossProvider: true,
      independentAudits: false,
    },
    acceptance: [
      {
        id: "greeting",
        description: "File contains a greeting",
        evidenceKind: "LOCAL",
      },
    ],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    simulation: false,
    budget: {
      maxAttempts: 2,
      maxCostUsd: 5,
      maxTokens: 100000,
      deadlineMs: 120000,
    },
  };
}

test(
  "CLI live advance: owner source, cross-provider review, owner binding gate",
  live,
  async () => {
    const f = setup();
    const db = ["--db", join(f.root, "project", ".longform", "state.sqlite")];
    try {
      const prompt = join(f.root, "prompt.txt");
      writeFileSync(prompt, "Write output/A/hello.txt containing a greeting.");
      const submitted = await cli([
        "orchestrate",
        "--prompt-file",
        prompt,
        "--request-key",
        "live-1",
        "--source-ref",
        "test:live",
        "--execute",
        ...db,
      ]);
      assert.equal(submitted.liveExecutionHeld, false);
      writeFileSync(
        join(f.root, "tasks.json"),
        JSON.stringify([liveTask(submitted.ownerSource)]),
      );
      await cli([
        "register",
        "--file",
        join(f.root, "tasks.json"),
        "--execute",
        ...db,
      ]);
      writeFileSync(
        join(f.root, "grant.json"),
        JSON.stringify({
          id: "g1",
          operations: ["READ_LOCAL", "WRITE_LOCAL"],
          paths: ["output/A"],
          decisionText: "test",
          sourceRef: "test:live",
        }),
      );
      await cli([
        "grant",
        "A",
        "--file",
        join(f.root, "grant.json"),
        "--execute",
        ...db,
      ]);
      const id = submitted.request.id;
      const attached = await cli([
        "orchestrate",
        "--request-id",
        id,
        "--task",
        "A",
        "--execute",
        ...db,
      ]);
      assert.deepEqual(attached.tasks[0].holds, []);
      const advanced = await cli([
        "orchestrate",
        "--request-id",
        id,
        "--advance",
        "--live",
        "--execute",
        ...db,
      ]);
      assert.ok(
        advanced.attestations.every((a: { attested: boolean }) => a.attested),
      );
      assert.equal(advanced.tasks[0].status, "WAITING_REVIEW");
      assert.match(
        advanced.tasks[0].holds.join(),
        /MISSING_ACCEPTANCE_EVIDENCE:greeting/,
      );
      const inspected = await cli(["inspect", "A", ...db]);
      const [worker, reviewer] = inspected.attempts;
      assert.deepEqual(
        [worker.role, worker.provider, worker.state],
        ["worker", "claude", "SUCCEEDED"],
      );
      assert.deepEqual(
        [reviewer.role, reviewer.provider, reviewer.state],
        ["reviewer", "codex", "SUCCEEDED"],
      );
      assert.equal(inspected.reviews[0].verdict, "PASS");
      assert.ok(
        inspected.audits.every(
          (a: { simulation: boolean }) => a.simulation === false,
        ),
      );
      await cli([
        "bind",
        "A",
        "--criterion",
        "greeting",
        "--evidence-id",
        "output-" + worker.id,
        "--execute",
        ...db,
      ]);
      const verified = await cli([
        "orchestrate",
        "--request-id",
        id,
        "--advance",
        "--live",
        "--execute",
        ...db,
      ]);
      assert.equal(verified.tasks[0].status, "VERIFIED");
      // Verification-only pass: no worker or reviewer needed, so no provider calls.
      assert.deepEqual(verified.attestations, []);
      assert.equal(verified.tasks[0].acceptanceCurrent, false);
    } finally {
      f.close();
    }
  },
);

test(
  "live tasks without an owner or connector source, or writing out of scope, stay held",
  live,
  async () => {
    const f = setup();
    const db = ["--db", join(f.root, "project", ".longform", "state.sqlite")];
    try {
      writeFileSync(
        join(f.root, "tasks.json"),
        JSON.stringify([liveTask(null)]),
      );
      await cli([
        "register",
        "--file",
        join(f.root, "tasks.json"),
        "--execute",
        ...db,
      ]);
      assert.ok(
        (await cli(["route", "A", ...db])).taskBlockers.includes(
          "NO_AUTHENTICATED_SPECIFICATION_SOURCE",
        ),
      );
    } finally {
      f.close();
    }
    const g = setup();
    const db2 = ["--db", join(g.root, "project", ".longform", "state.sqlite")];
    try {
      const prompt = join(g.root, "prompt.txt");
      writeFileSync(prompt, "Write outside the allowed path.");
      const submitted = await cli([
        "orchestrate",
        "--prompt-file",
        prompt,
        "--request-key",
        "live-2",
        "--source-ref",
        "test:live",
        "--execute",
        ...db2,
      ]);
      writeFileSync(
        join(g.root, "tasks.json"),
        JSON.stringify([liveTask(submitted.ownerSource, "OUTSIDE")]),
      );
      await cli([
        "register",
        "--file",
        join(g.root, "tasks.json"),
        "--execute",
        ...db2,
      ]);
      writeFileSync(
        join(g.root, "grant.json"),
        JSON.stringify({
          id: "g1",
          operations: ["READ_LOCAL", "WRITE_LOCAL"],
          paths: ["output/A"],
          decisionText: "test",
          sourceRef: "test:live",
        }),
      );
      await cli([
        "grant",
        "A",
        "--file",
        join(g.root, "grant.json"),
        "--execute",
        ...db2,
      ]);
      await cli([
        "orchestrate",
        "--request-id",
        submitted.request.id,
        "--task",
        "A",
        "--execute",
        ...db2,
      ]);
      const advanced = await cli([
        "orchestrate",
        "--request-id",
        submitted.request.id,
        "--advance",
        "--live",
        "--execute",
        ...db2,
      ]);
      assert.notEqual(advanced.tasks[0].status, "WAITING_REVIEW");
      const step = advanced.tasks[0].steps.find(
        (s: { stage: string }) => s.stage === "WORKER_EXECUTION",
      );
      assert.match(step.detail, /WORKSPACE_WRITE_SCOPE_VIOLATION/);
    } finally {
      g.close();
    }
  },
);

test(
  "a labelled, wrapped subscription token file yields the bare token",
  live,
  async () => {
    const f = setup();
    try {
      writeFileSync(
        f.config.providers.claude!.oauthTokenFile,
        "My Claude token\n\nsk-ant-oat01-abcdefghijklmnop\n qrstuvwxyz0123456789\n",
        { mode: 0o600 },
      );
      await attest(
        f.config,
        "claude",
        "claude-fake-worker",
        "low",
        f.workspaces,
      );
      const adapter = liveProvider(
        f.config,
        "claude",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const receipt = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "claude",
        model: "claude-fake-worker",
        effort: "low",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "TOKENSHAPE",
        deadlineMs: 30_000,
      });
      assert.equal(receipt.status, "SUCCEEDED");
      assert.ok(
        !receipt.output.includes(
          "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789",
        ),
      );
    } finally {
      f.close();
    }
  },
);

// Regressions for independent review findings.

test(
  "F1: a run cancelled while queued for the credential lock never launches",
  live,
  async () => {
    const f = setup();
    try {
      await attest(
        f.config,
        "codex",
        "gpt-fake-review",
        "medium",
        f.workspaces,
      );
      const adapter = liveProvider(
        f.config,
        "codex",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const request = (brief: string, signal?: AbortSignal) => ({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex" as const,
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer" as const,
        cwd: workspace(f.workspaces),
        brief,
        deadlineMs: 30_000,
        signal,
      });
      const abort = new AbortController();
      const slow = adapter.execute(request("SLOW"));
      await new Promise((r) => setTimeout(r, 800)); // first run holds the lock
      const queuedRequest = request("plain", abort.signal);
      const queued = adapter.execute(queuedRequest);
      await new Promise((r) => setTimeout(r, 200));
      abort.abort();
      const queuedReceipt = await queued;
      assert.equal(queuedReceipt.status, "CANCELLED");
      // Never launched: truthful zero usage, not an unknown (review F5 residual).
      assert.deepEqual([queuedReceipt.costUsd, queuedReceipt.tokens], [0, 0]);
      assert.equal((await slow).status, "SUCCEEDED");
      await new Promise((r) => setTimeout(r, 500)); // the queued execute() has returned by now
      const evidence = readdirSync(join(f.config.stateDir, "evidence"));
      assert.ok(
        !evidence.some((name) => name.includes(queuedRequest.runId)),
        "cancelled run must not launch",
      );
    } finally {
      f.close();
    }
  },
);

test(
  "an unstructured Codex run's progress notes are read as notes when its session log labels them, and still conflict when it doesn't",
  live,
  async () => {
    const f = setup();
    try {
      await attest(f.config, "codex", "gpt-fake-review", "medium", f.workspaces);
      const adapter = liveProvider(
        f.config,
        "codex",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const request = (brief: string) => ({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex" as const,
        model: "gpt-fake-review",
        effort: "medium",
        // Read-only and without an output schema: the same unstructured
        // parsing a worker's summary gets (the fake CLI's probe has no
        // writable-workspace flags).
        role: "reviewer" as const,
        cwd: workspace(f.workspaces),
        brief,
        deadlineMs: 30_000,
      });
      const labelled = await adapter.execute(request("WORKERNOTES"));
      assert.equal(labelled.status, "SUCCEEDED");
      assert.equal(labelled.identityVerified, true);
      assert.equal(labelled.output, "OK");
      const run = JSON.parse(
        readFileSync(
          join(f.config.stateDir, "evidence", "run-" + labelled.runId + ".json"),
          "utf8",
        ),
      );
      // Evidence keeps the labels, not the message text.
      assert.deepEqual(run.identity.sessionMessagePhases, [
        "commentary",
        "final_answer",
      ]);
      // The note holds a secret-like pattern the redactor rewrites; matching
      // happens on the raw stream, so the labels still line up (review r1).
      assert.equal(run.identity.streamPhasesMatched, true);
      assert.ok(!JSON.stringify(run).includes("Reading first."));
      const unlabelled = await adapter.execute(
        request("WORKERNOTES UNLABELLED"),
      );
      assert.equal(unlabelled.status, "UNKNOWN");
      assert.match(unlabelled.output, /CONFLICTING_PROVIDER_FINAL_MESSAGES/);
      const unmatched = JSON.parse(
        readFileSync(
          join(
            f.config.stateDir,
            "evidence",
            "run-" + unlabelled.runId + ".json",
          ),
          "utf8",
        ),
      );
      assert.equal(unmatched.identity.streamPhasesMatched, false);
    } finally {
      f.close();
    }
  },
);

test("F2: the credential lock has one holder and is released when its holder dies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longform-lock-"));
  const path = join(dir, "lock");
  try {
    const first = await kernelLock(path, { deadlineMs: 5_000 });
    let second = false;
    const waiting = kernelLock(path, { deadlineMs: 5_000 }).then(
      (release) => ((second = true), release),
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(second, false, "second holder must wait");
    await first();
    await (
      await waiting
    )();
    assert.equal(second, true);
    // A holder that dies without releasing frees the lock (no stale state to race on).
    const holder = spawn("/usr/bin/flock", [
      "--exclusive",
      "--close",
      path,
      "/bin/sleep",
      "30",
    ]);
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(
      kernelLock(path, { deadlineMs: 300 }),
      /CREDENTIAL_LOCK_TIMEOUT/,
    );
    holder.kill("SIGKILL");
    await (
      await kernelLock(path, { deadlineMs: 5_000 })
    )();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run stopped while it waits for the credential lock stops waiting at once, and holds nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "longform-lock-"));
  const path = join(dir, "lock");
  try {
    const first = await kernelLock(path, { deadlineMs: 5_000 });
    const abort = new AbortController();
    const waiting = kernelLock(path, { deadlineMs: 5_000, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 200));
    const asked = Date.now();
    abort.abort();
    await assert.rejects(waiting, /LOCK_WAIT_CANCELLED/);
    assert.ok(Date.now() - asked < 1_000);
    await first();
    // The stopped waiter left no holder behind.
    await (
      await kernelLock(path, { deadlineMs: 1_000 })
    )();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #21: a run's processes killed from outside (an operator, the kernel) end
// its run; while they are alive the runner says so, and nothing is assumed.
test(
  "a sandbox process killed from outside ends its run, and the runner knows while it is alive",
  live,
  async () => {
    const f = setup();
    try {
      await attest(f.config, "claude", "claude-fake-worker", "low", f.workspaces);
      const runner = new BubblewrapRunner(f.config);
      const adapter = liveProvider(f.config, "claude", f.workspaces, runner);
      const runId = "r-" + randomUUID();
      const running = adapter.execute({
        runId,
        taskId: "T",
        provider: "claude",
        model: "claude-fake-worker",
        effort: "low",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "ESCAPE",
        deadlineMs: 30_000,
      });
      // Before the launch the adapter claims nothing about its processes;
      // once launched, the runner names the live sandbox process.
      let activity = adapter.activity!(runId);
      for (let waited = 0; activity.processStopped || !/pid \d+/.test(activity.detail); waited += 50) {
        if (waited > 20_000) throw new Error("not launched: " + activity.detail);
        await new Promise((r) => setTimeout(r, 50));
        activity = adapter.activity!(runId);
      }
      const pid = Number(/pid (\d+)/.exec(activity.detail)![1]);
      assert.deepEqual(runner.busy().map((b) => b.runId), [runId]);
      assert.deepEqual(adapter.busy!().map((b) => b.runId), [runId]);
      process.kill(-pid, "SIGKILL");
      const receipt = await running;
      assert.notEqual(receipt.status, "SUCCEEDED");
      assert.equal(runner.activity(runId).processStopped, true);
      assert.equal(adapter.activity!(runId).processStopped, true);
      assert.deepEqual(runner.busy(), []);
      assert.deepEqual(adapter.busy!(), []);
      const survivors = execFileSync("ps", ["-eo", "args"])
        .toString()
        .split("\n")
        .filter((l) => l.trim() === "sleep 600");
      assert.deepEqual(survivors, []);
    } finally {
      f.close();
    }
  },
);

// Cache tokens count toward usage (F6), with cached reads at their price share
// .
test("F6: Claude cache tokens count toward usage, cached reads at their price share; Codex cached input is not double counted", () => {
  const claude = (model: string) =>
    inspectCliOutput(
      "claude",
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "s",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 20_000,
        },
      }),
      model,
    );
  // Unlisted model: reads at 0.1.
  assert.equal(claude("m").tokens, 1 + 1 + 10_000 + 2_000);
  assert.deepEqual(claude("m").usageDetail, {
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 10_000,
    cacheReadTokens: 20_000,
    cacheReadWeight: 0.1,
  });
  // Opus 5.5 and Sonnet 5.5 read at 0.05, Fable 5.1 at 0.025, Haiku 5.5 at 0.1.
  assert.equal(claude("claude-opus-5-5").tokens, 1 + 1 + 10_000 + 1_000);
  assert.equal(claude("claude-sonnet-5-5").tokens, 1 + 1 + 10_000 + 1_000);
  assert.equal(claude("claude-fable-5-1").tokens, 1 + 1 + 10_000 + 500);
  assert.equal(claude("claude-haiku-5-5").tokens, 1 + 1 + 10_000 + 2_000);
  const codex = (usage: Record<string, unknown>) =>
    inspectCliOutput(
      "codex",
      [
        { type: "thread.started", thread_id: "t" },
        { type: "turn.completed", usage },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
      "m",
    );
  // 10 fresh + 5 output + 90 cached at 0.1.
  assert.equal(
    codex({ input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 })
      .tokens,
    10 + 5 + 9,
  );
  // An implausible cached count is ignored: all input counts in full.
  assert.equal(
    codex({ input_tokens: 100, cached_input_tokens: 900, output_tokens: 5 })
      .tokens,
    105,
  );
});

test(
  "F7: re-attesting changes no route identity, and concurrent attestations are all kept",
  live,
  async () => {
    const route = (verifiedAt: string, evidenceRef: string) => ({
      id: "r",
      level: "ROUTINE",
      provider: "claude",
      model: "claude-m",
      effort: "low",
      roles: ["worker"],
      simulation: false,
      enabled: true,
      capability: {
        provider: "claude",
        model: "claude-m",
        effort: "low",
        verifiedAt,
        expiresAt: new Date(Date.parse(verifiedAt) + 3_600_000).toISOString(),
        evidenceRef,
      },
    });
    const resolve = (verifiedAt: string, ref: string) =>
      resolveRoute(
        demoTask("A", { providers: ["claude"], simulation: false }),
        "worker",
        RoutingPolicySchema.parse({
          version: 1,
          id: "p",
          routes: [route(verifiedAt, ref)],
        }),
        { verifyLiveCapability: () => true },
      );
    const a = resolve(new Date(Date.now() - 60_000).toISOString(), "e1"),
      b = resolve(new Date().toISOString(), "e2");
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok)
      assert.deepEqual(
        [a.policyDigest, a.routeDigest],
        [b.policyDigest, b.routeDigest],
      );
    const f = setup();
    try {
      await Promise.all([
        attest(f.config, "claude", "claude-fake-worker", "low", f.workspaces),
        attest(f.config, "codex", "gpt-fake-review", "medium", f.workspaces),
      ]);
      assert.deepEqual(
        readAttestations(f.config)
          .map((x) => x.provider)
          .sort(),
        ["claude", "codex"],
      );
    } finally {
      f.close();
    }
  },
);

test(
  "N4/N5: a setup failure releases the credential lock, whose path ignores the runtime directory",
  live,
  async () => {
    const f = setup();
    try {
      const runner = new BubblewrapRunner(f.config);
      const lockPath = (env: string | undefined) => {
        const saved = process.env.XDG_RUNTIME_DIR;
        if (env === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = env;
        try {
          return (
            runner as unknown as { codexLockPath(home: string): string }
          ).codexLockPath(f.config.providers.codex!.codexHome);
        } finally {
          if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
          else process.env.XDG_RUNTIME_DIR = saved;
        }
      };
      assert.equal(lockPath(tmpdir()), lockPath(undefined));
      // Inject a workspace-setup failure after the lock is acquired.
      (runner as unknown as { runDir: () => never }).runDir = () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      };
      const exe = f.config.providers.codex!.executable;
      await assert.rejects(
        runner.execute({
          runId: "r-" + randomUUID(),
          taskId: "T",
          provider: "codex",
          executable: exe,
          executableDigest: digestOf(exe),
          args: [],
          cwd: workspace(f.workspaces),
          stdin: "",
          env: {},
          policy: {
            workspace: f.workspaces,
            writableWorkspace: false,
            writablePaths: [],
            nestedDelegation: false,
            networkProvider: "codex",
          },
          deadlineMs: 5_000,
          maxOutputBytes: 1_000,
        }),
        /ENOSPC/,
      );
      // The lock is free again immediately.
      await (
        await kernelLock(lockPath(undefined), { deadlineMs: 1_000 })
      )();
    } finally {
      f.close();
    }
  },
);

test("F5 residual: a Claude error envelope keeps its reported usage", () => {
  const error = JSON.stringify({
    type: "result",
    is_error: true,
    session_id: "s",
    total_cost_usd: 0.3,
    usage: { input_tokens: 2, output_tokens: 1 },
  });
  const parsed = inspectCliOutput("claude", error, "m");
  assert.deepEqual(
    [parsed.costUsd, parsed.tokens, parsed.complete],
    [0.3, 3, false],
  );
});

test(
  "R3-3: a failed credential write-back is reported and the refreshed login kept",
  live,
  async () => {
    const f = setup();
    const runner = new BubblewrapRunner(f.config);
    const codexHome = join(f.root, "codexhome");
    const { dir, key } = (
      runner as unknown as {
        codexCredentialKey(home: string): { dir: string; key: string };
      }
    ).codexCredentialKey(codexHome);
    const recoveries = () =>
      readdirSync(dir).filter((name) => name.startsWith(key + ".recovery-"));
    try {
      assert.equal(
        (
          await attest(
            f.config,
            "codex",
            "gpt-fake-review",
            "medium",
            f.workspaces,
          )
        ).attested,
        true,
      );
      const before = readFileSync(join(codexHome, "auth.json"), "utf8");
      // The source home refuses the write-back (like a full or read-only disk).
      chmodSync(codexHome, 0o500);
      const adapter = liveProvider(f.config, "codex", f.workspaces, runner);
      const receipt = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex",
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "REFRESH",
        deadlineMs: 30_000,
      });
      chmodSync(codexHome, 0o700);
      assert.notEqual(receipt.status, "SUCCEEDED");
      assert.equal(receipt.tokens, 10);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), before);
      assert.deepEqual(
        readdirSync(codexHome).filter((name) => name.includes(".longform-")),
        [],
      );
      const [recovery] = recoveries();
      assert.ok(recovery);
      assert.equal(
        JSON.parse(readFileSync(join(dir, recovery), "utf8")).refreshed,
        true,
      );
      // No further Codex run starts from the stale source until it is restored,
      // and a refused run is a known non-launch: zero usage, actionable reason.
      const refused = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex",
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "plain",
        deadlineMs: 30_000,
      });
      assert.equal(refused.status, "FAILED");
      assert.deepEqual([refused.costUsd, refused.tokens], [0, 0]);
      assert.match(refused.output, /CODEX_CREDENTIAL_RECOVERY_PENDING/);
      const exe = f.config.providers.codex!.executable;
      const direct = await runner.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex",
        executable: exe,
        executableDigest: digestOf(exe),
        args: [],
        cwd: workspace(f.workspaces),
        stdin: "",
        env: {},
        policy: {
          workspace: f.workspaces,
          writableWorkspace: false,
          writablePaths: [],
          nestedDelegation: false,
          networkProvider: "codex",
        },
        deadlineMs: 5_000,
        maxOutputBytes: 1_000,
      });
      assert.equal(direct.notLaunched, true);
      assert.match(direct.stderr, /CODEX_CREDENTIAL_RECOVERY_PENDING/);
      // The lock was still released.
      await (
        await kernelLock(join(dir, key + ".lock"), { deadlineMs: 1_000 })
      )();
    } finally {
      chmodSync(codexHome, 0o700);
      for (const name of recoveries()) rmSync(join(dir, name), { force: true });
      f.close();
    }
  },
);

test(
  "R4-1/R4-2: when no recovery copy can be written, the run is reported and the runner refuses",
  live,
  async () => {
    const f = setup();
    const savedHome = process.env.HOME;
    // An isolated lock namespace this test can make unwritable.
    process.env.HOME = join(f.root, "home");
    const runner = new BubblewrapRunner(f.config);
    const codexHome = join(f.root, "codexhome");
    const { dir } = (
      runner as unknown as {
        codexCredentialKey(home: string): { dir: string; key: string };
      }
    ).codexCredentialKey(codexHome);
    const exe = f.config.providers.codex!.executable;
    const input = (stdin: string) => ({
      runId: "r-" + randomUUID(),
      taskId: "T",
      provider: "codex" as const,
      executable: exe,
      executableDigest: digestOf(exe),
      args: [
        "exec",
        "--model",
        "gpt-fake-review",
        "-c",
        'model_reasoning_effort="medium"',
      ],
      cwd: workspace(f.workspaces),
      stdin,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/home/worker",
        CODEX_HOME: "/home/worker/.codex",
      },
      policy: {
        workspace: f.workspaces,
        writableWorkspace: false,
        writablePaths: [],
        nestedDelegation: false as const,
        networkProvider: "codex" as const,
      },
      deadlineMs: 30_000,
      maxOutputBytes: 100_000,
    });
    try {
      const before = readFileSync(join(codexHome, "auth.json"), "utf8");
      // Once the run has started, the source home and the lock namespace both
      // refuse writes, so neither write-back nor any recovery record can land.
      const running = runner.execute(input("REFRESH SLOW"));
      await new Promise((r) => setTimeout(r, 1_000));
      chmodSync(codexHome, 0o500);
      chmodSync(dir, 0o500);
      const result = await running;
      chmodSync(codexHome, 0o700);
      chmodSync(dir, 0o700);
      assert.equal(result.status, "FAILED");
      assert.equal(result.identity, undefined);
      assert.match(result.stderr, /CODEX_CREDENTIAL_PERSISTENCE_FAILED/);
      const kept = /newest credentials kept at (\S+?auth\.json)/.exec(
        result.stderr,
      )?.[1];
      assert.ok(kept && existsSync(kept), result.stderr);
      assert.equal(JSON.parse(readFileSync(kept, "utf8")).refreshed, true);
      assert.equal(readFileSync(join(codexHome, "auth.json"), "utf8"), before);
      // With nothing durable written, this runner itself refuses further runs.
      const next = await runner.execute(input("plain"));
      assert.equal(next.notLaunched, true);
      assert.match(next.stderr, /CODEX_CREDENTIAL_RECOVERY_PENDING/);
      // R5-2: restoring and deleting the named copy clears it for this runner.
      writeFileSync(join(codexHome, "auth.json"), readFileSync(kept), {
        mode: 0o600,
      });
      rmSync(kept);
      const resumed = await runner.execute(input("plain"));
      assert.equal(resumed.status, "SUCCEEDED", resumed.stderr);
    } finally {
      try {
        chmodSync(codexHome, 0o700);
        chmodSync(dir, 0o700);
      } catch {
        /* already restored */
      }
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      f.close();
    }
  },
);

test(
  "R4-3: live advance refuses before reserving anything while a Codex login recovery is pending",
  live,
  async () => {
    const f = setup();
    const savedHome = process.env.HOME;
    process.env.HOME = join(f.root, "home");
    const db = ["--db", join(f.root, "project", ".longform", "state.sqlite")];
    try {
      const prompt = join(f.root, "prompt.txt");
      writeFileSync(prompt, "Write output/A/hello.txt containing a greeting.");
      const submitted = await cli([
        "orchestrate",
        "--prompt-file",
        prompt,
        "--request-key",
        "live-recovery",
        "--source-ref",
        "test:live",
        "--execute",
        ...db,
      ]);
      writeFileSync(
        join(f.root, "tasks.json"),
        JSON.stringify([liveTask(submitted.ownerSource)]),
      );
      await cli([
        "register",
        "--file",
        join(f.root, "tasks.json"),
        "--execute",
        ...db,
      ]);
      const id = submitted.request.id;
      await cli([
        "orchestrate",
        "--request-id",
        id,
        "--task",
        "A",
        "--execute",
        ...db,
      ]);
      const { dir, key } = (
        new BubblewrapRunner(f.config) as unknown as {
          codexCredentialKey(home: string): { dir: string; key: string };
        }
      ).codexCredentialKey(join(f.root, "codexhome"));
      writeFileSync(join(dir, key + ".recovery-r-old.json"), "{}", {
        mode: 0o600,
      });
      await assert.rejects(
        cli([
          "orchestrate",
          "--request-id",
          id,
          "--advance",
          "--live",
          "--execute",
          ...db,
        ]),
        /CODEX_CREDENTIAL_RECOVERY_PENDING/,
      );
      assert.deepEqual((await cli(["inspect", "A", ...db])).attempts, []);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      f.close();
    }
  },
);

test(
  "R5-3: a pending Codex recovery does not block Claude-only work beside finished Codex-eligible tasks",
  live,
  async () => {
    const f = setup();
    const savedHome = process.env.HOME;
    process.env.HOME = join(f.root, "home");
    const db = ["--db", join(f.root, "project", ".longform", "state.sqlite")];
    try {
      const prompt = join(f.root, "prompt.txt");
      writeFileSync(prompt, "Write the greeting files.");
      const submitted = await cli([
        "orchestrate",
        "--prompt-file",
        prompt,
        "--request-key",
        "live-mixed",
        "--source-ref",
        "test:live",
        "--execute",
        ...db,
      ]);
      const source = submitted.ownerSource;
      const b = {
        ...liveTask(source),
        id: "B",
        // The fake Claude always writes output/A (in B's own workspace).
        writePaths: ["output/A"],
        providers: ["claude"],
        sources: [{ ...source, evidenceId: source.evidenceId + "-B" }],
        reviewPolicy: {
          required: false,
          crossProvider: false,
          independentAudits: false,
        },
      };
      writeFileSync(
        join(f.root, "tasks.json"),
        JSON.stringify([liveTask(source), b]),
      );
      await cli([
        "register",
        "--file",
        join(f.root, "tasks.json"),
        "--execute",
        ...db,
      ]);
      for (const task of ["A", "B"]) {
        const path = "output/A";
        writeFileSync(
          join(f.root, "grant.json"),
          JSON.stringify({
            id: "g-" + task,
            operations: ["READ_LOCAL", "WRITE_LOCAL"],
            paths: [path],
            decisionText: "test",
            sourceRef: "test:live",
          }),
        );
        await cli([
          "grant",
          task,
          "--file",
          join(f.root, "grant.json"),
          "--execute",
          ...db,
        ]);
      }
      const id = submitted.request.id;
      const advance = () =>
        cli([
          "orchestrate",
          "--request-id",
          id,
          "--advance",
          "--live",
          "--execute",
          ...db,
        ]);
      // A runs to a recorded review: its model work is finished.
      await cli([
        "orchestrate",
        "--request-id",
        id,
        "--task",
        "A",
        "--execute",
        ...db,
      ]);
      await advance();
      assert.equal((await cli(["inspect", "A", ...db])).reviews.length, 1);
      // Then a Codex login recovery is pending, and Claude-only B is attached.
      const { dir, key } = (
        new BubblewrapRunner(f.config) as unknown as {
          codexCredentialKey(home: string): { dir: string; key: string };
        }
      ).codexCredentialKey(join(f.root, "codexhome"));
      writeFileSync(join(dir, key + ".recovery-r-old.json"), "{}", {
        mode: 0o600,
      });
      await cli([
        "orchestrate",
        "--request-id",
        id,
        "--task",
        "B",
        "--execute",
        ...db,
      ]);
      await advance();
      const [worker] = (await cli(["inspect", "B", ...db])).attempts;
      assert.deepEqual(
        [worker.provider, worker.state],
        ["claude", "SUCCEEDED"],
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      f.close();
    }
  },
);

test(
  "R6-1: a launched process printing the not-launched marker keeps its usage",
  live,
  async () => {
    const f = setup();
    try {
      assert.equal(
        (
          await attest(
            f.config,
            "codex",
            "gpt-fake-review",
            "medium",
            f.workspaces,
          )
        ).attested,
        true,
      );
      const adapter = liveProvider(
        f.config,
        "codex",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const receipt = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex",
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        brief: "FORGE_NOT_LAUNCHED",
        deadlineMs: 30_000,
      });
      assert.equal(receipt.status, "FAILED");
      assert.equal(receipt.notLaunched, undefined);
      assert.equal(receipt.tokens, 10);
    } finally {
      f.close();
    }
  },
);

test("the sandbox shim keeps a CLI's output when the CLI makes its stdout non-blocking", async () => {
  const { SHIM } = await import("../src/live.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  writeFileSync(join(dir, "shim.mjs"), SHIM.replaceAll("/tmp/longform-child-", join(dir, "child-")));
  // A writer that switches its stdout to non-blocking, as something in a Codex
  // run did, and treats every write as blocking (EAGAIN aborts it).
  writeFileSync(
    join(dir, "big.py"),
    "import os, fcntl\nfcntl.fcntl(1, fcntl.F_SETFL, fcntl.fcntl(1, fcntl.F_GETFL) | os.O_NONBLOCK)\ndata = b'x' * (4 * 1024 * 1024)\noff = 0\nwhile off < len(data): off += os.write(1, data[off:])\n",
  );
  const child = spawn(process.execPath, [join(dir, "shim.mjs"), join(dir, "none.sock"), "18998", "/usr/bin/python3", join(dir, "big.py")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bytes = 0;
  child.stdout.on("data", (d: Buffer) => {
    bytes += d.length;
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 1);
  });
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0);
  assert.equal(bytes, 4 * 1024 * 1024);
});

// Design choice: output past the limit no longer stops a run. The
// runner keeps each stream's start and end, in whole lines.
test(
  "F17: a Codex run whose event stream passes the output limit still finishes, keeping its first and final events",
  live,
  async () => {
    const f = setup();
    try {
      assert.equal(
        (
          await attest(
            f.config,
            "codex",
            "gpt-fake-review",
            "medium",
            f.workspaces,
          )
        ).attested,
        true,
      );
      const adapter = liveProvider(
        f.config,
        "codex",
        f.workspaces,
        new BubblewrapRunner(f.config),
      );
      const receipt = await adapter.execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "codex",
        model: "gpt-fake-review",
        effort: "medium",
        role: "reviewer",
        cwd: workspace(f.workspaces),
        // About 230 KB of command output events against an 8 KB limit.
        brief: "NOISY",
        deadlineMs: 30_000,
        maxOutputBytes: 8_000,
      });
      assert.equal(receipt.status, "SUCCEEDED", receipt.output);
      assert.equal(receipt.output, "OK");
      assert.equal(receipt.tokens, 10);
      const ref = receipt.provenance!.identityEvidenceRef;
      const run = JSON.parse(
        readFileSync(/^file:([^#]+)/.exec(ref)![1]!, "utf8"),
      );
      assert.ok(run.outputDroppedBytes > 200_000, String(run.outputDroppedBytes));
    } finally {
      f.close();
    }
  },
);

test("F6: a live runtime queues Codex runs, and only Codex runs", () => {
  const f = setup();
  try {
    const path = join(f.root, "live-config.json");
    writeFileSync(path, JSON.stringify(f.config), { mode: 0o600 });
    const runtime = openRuntime(join(f.root, "project", ".longform", "state.sqlite"), {
      liveConfigPath: path,
    });
    try {
      assert.deepEqual(
        (runtime.c as unknown as { config: { serialProviders?: string[] } })
          .config.serialProviders,
        ["codex"],
      );
    } finally {
      runtime.db.close();
    }
  } finally {
    f.close();
  }
});

test(
  "R5: the runner filters only Codex event streams: a Claude result split across lines is kept whole past the budget",
  live,
  async () => {
    const f = setup();
    try {
      const exe = f.config.providers.claude!.executable;
      const result = await new BubblewrapRunner(f.config).execute({
        runId: "r-" + randomUUID(),
        taskId: "T",
        provider: "claude",
        executable: exe,
        executableDigest: digestOf(exe),
        args: [],
        cwd: workspace(f.workspaces),
        stdin: "PRETTY",
        env: {},
        policy: {
          workspace: f.workspaces,
          writableWorkspace: false,
          writablePaths: [],
          nestedDelegation: false,
          networkProvider: "claude",
        },
        deadlineMs: 30_000,
        // stdout gets 1,500 bytes; the result is about 1,700.
        maxOutputBytes: 2_000,
      });
      assert.equal(result.status, "SUCCEEDED", result.stderr);
      assert.ok(Buffer.byteLength(result.stdout) > 1_500);
      assert.ok(result.stdout.includes('"text":"required evidence"'));
      assert.equal(JSON.parse(result.stdout).evidence.length, 1);
      assert.equal(result.droppedBytes, undefined);
    } finally {
      f.close();
    }
  },
);

test(
  "the owner-text folder is mounted read-only at one path for every kind of run, and a file changed after preparation stops the launch",
  live,
  async () => {
    const f = setup();
    try {
      const dir = join(f.root, "owner-text");
      mkdirSync(dir);
      const text = "OWNER WORDS ✓ é " + "x".repeat(5_000);
      writeFileSync(join(dir, "request-r1.txt"), text);
      const reader = join(f.root, "bin", "reader");
      writeFileSync(
        reader,
        `#!${process.execPath}
const fs = require("fs"), path = ${JSON.stringify(OWNER_TEXT_IN_SANDBOX + "/request-r1.txt")};
let write = "WRITABLE";
try { fs.writeFileSync(path, "changed"); } catch (e) { write = e.code; }
console.log(JSON.stringify({ sha: require("crypto").createHash("sha256").update(fs.readFileSync(path)).digest("hex"), write }));
`,
        { mode: 0o755 },
      );
      const config = {
        ...f.config,
        providers: {
          claude: { ...f.config.providers.claude!, executable: reader },
          codex: { ...f.config.providers.codex!, executable: reader },
        },
      };
      const runner = new BubblewrapRunner(config);
      const sha = (s: string) => createHash("sha256").update(s).digest("hex");
      const input = (provider: "codex" | "claude", writable: boolean) => {
        const cwd = workspace(f.workspaces);
        return {
          runId: "r-" + randomUUID(),
          taskId: "T",
          provider,
          executable: reader,
          executableDigest: digestOf(reader),
          args: [],
          cwd,
          stdin: "",
          env: {},
          policy: {
            workspace: cwd,
            writableWorkspace: writable,
            writablePaths: writable ? ["output"] : [],
            nestedDelegation: false as const,
            networkProvider: provider,
          },
          deadlineMs: 20_000,
          maxOutputBytes: 100_000,
          ownerText: { dir, files: [{ file: "request-r1.txt", sha256: sha(text) }] },
        };
      };
      // Writable (workers) and read-only (every other role) runs, both providers.
      for (const provider of ["codex", "claude"] as const)
        for (const writable of [false, true]) {
          const result = await runner.execute(input(provider, writable));
          assert.equal(result.exitCode, 0, provider + " " + writable + ": " + result.stderr);
          const seen = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
          assert.equal(seen.sha, sha(text), provider + " " + writable);
          assert.equal(seen.write, "EROFS", provider + " " + writable);
        }
      assert.equal(readFileSync(join(dir, "request-r1.txt"), "utf8"), text);
      // Changed after the controller prepared it: never launched.
      writeFileSync(join(dir, "request-r1.txt"), text + "!");
      const refused = await runner.execute(input("codex", false));
      assert.equal(refused.notLaunched, true);
      assert.match(refused.stderr, /OWNER_TEXT_UNAVAILABLE/);
    } finally {
      f.close();
    }
  },
);
