import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  connect,
  isIP,
  type Server,
  type Socket,
} from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { codexSessionSignal, type CodexSessionSignal } from "./limits.js";
import {
  DRIVE_CLIENT,
  DRIVE_CLIENT_IN_SANDBOX,
  DriveGateway,
  recordFolders,
  restoreDriveRecords,
  type DriveFetch,
  type PackManifestEntry,
  driveWriteSummary,
} from "./drive.js";
import {
  ClaudeCliProvider,
  CliProvider,
  CodexCliProvider,
  DROPPED_CODEX_EVENTS,
  OWNER_TEXT_IN_SANDBOX,
  probeCli,
  redact,
  skippableCodexEvent,
  type CapabilityAttestation,
  type HarnessIdentityProof,
  type IsolatedProviderRunner,
  type IsolatedRunInput,
  type IsolatedRunnerVerification,
  type IsolatedRunResult,
  type ProcessResult,
  type CodexMessagePhase,
  type ProviderReceipt,
  type RunActivity,
  type BusyRun,
} from "./providers.js";
import {
  isFableModel,
  RoutingPolicySchema,
  type RoutingCapability,
  type RoutingPolicy,
} from "./routing.js";

/**
 * Live provider execution. Everything in this module is trusted operator
 * configuration and controller code; nothing here is reachable from task text,
 * worker output or reviewer output.
 */

const absolute = z.string().refine(isAbsolute, "absolute path required");
const host = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
  );

export const LiveConfigSchema = z
  .object({
    version: z.literal(1),
    /** Runner state: per-run homes, broker sockets, evidence and attestations. */
    stateDir: absolute,
    routingPolicyPath: absolute,
    /** The project's stakes (protected documents, code paths); see routing.ts. */
    projectProfilePath: absolute.optional(),
    bwrapExecutable: absolute.default("/usr/bin/bwrap"),
    nodeExecutable: absolute.default(process.execPath),
    /** Operator classification: task briefs may be sent to the configured providers. */
    sanitizedPublicBrief: z.literal(true),
    providers: z
      .object({
        claude: z
          .object({
            executable: absolute,
            /** File holding a `claude setup-token` subscription token; read only at run time. */
            oauthTokenFile: absolute,
            allowedHosts: z.array(host).min(1).default(["api.anthropic.com"]),
          })
          .strict()
          .optional(),
        codex: z
          .object({
            executable: absolute,
            /** Dedicated CODEX_HOME logged in only for the orchestrator. */
            codexHome: absolute,
            allowedHosts: z
              .array(host)
              .min(1)
              .default(["chatgpt.com", "auth.openai.com", "api.openai.com"]),
          })
          .strict()
          .optional(),
      })
      .strict(),
    /** Owner's own Google OAuth app; the Drive gateway uses it host-side only. */
    drive: z
      .union([
        z.object({ clientFile: absolute, tokenFile: absolute }).strict(),
        z
          .object({
            rcloneRemote: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            rcloneExecutable: absolute.default("/usr/bin/rclone"),
          })
          .strict(),
      ])
      .optional(),
    /**
     * Repositories a task may start from (`repo`), read with `git archive`
     * only.
     */
    repos: z
      .record(
        z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
        z.object({ path: absolute }).strict(),
      )
      .optional(),
    /**
     * Operator-allowlisted verifier and test commands a task may require by
     * name (`requiredTests`). They run without network on the sealed work, or
     * with `copy` on a throwaway writable copy of it.
     */
    commands: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        z
          .object({
            executable: absolute,
            args: z.array(z.string().max(4_096)).max(64).default([]),
            deadlineMs: z.number().int().min(1_000).max(1_800_000).optional(),
            copy: z.boolean().default(false),
            /** Host folders mounted read-only into the copy, such as installed dependencies. */
            binds: z
              .array(
                z
                  .object({
                    from: absolute,
                    to: z
                      .string()
                      .min(1)
                      .max(256)
                      .refine(
                        (p) =>
                          !p.startsWith("/") &&
                          !p.split("/").some((x) => x === ".." || x === "." || x === ""),
                        "relative normalized path required",
                      ),
                  })
                  .strict(),
              )
              .max(16)
              .default([]),
            /** Folders added to PATH, mounted read-only (a Node install, say). */
            path: z.array(absolute).max(8).default([]),
          })
          .strict()
          .refine((c) => c.copy || !c.binds.length, "binds need copy"),
      )
      .optional(),
  })
  .strict();
export type LiveConfig = z.infer<typeof LiveConfigSchema>;

export function loadLiveConfig(path: string): LiveConfig {
  return LiveConfigSchema.parse(
    JSON.parse(readFileSync(resolve(path), "utf8")),
  );
}

const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const fileDigest = (path: string) => sha256(readFileSync(path));

/** Append-only evidence files; the reference carries the content digest. */
function writeEvidence(stateDir: string, name: string, value: unknown): string {
  const dir = join(stateDir, "evidence");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.json`);
  const body = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  return `file:${path}#sha256=${sha256(body)}`;
}
export function evidenceRefValid(ref: string): boolean {
  const match = /^file:(\/[^#]+)#sha256=([a-f0-9]{64})$/.exec(ref);
  if (!match) return false;
  try {
    return fileDigest(match[1]!) === match[2];
  } catch {
    return false;
  }
}

/**
 * Host-side HTTP CONNECT proxy on a Unix socket. The sandbox has no network
 * namespace route; the only egress is this socket, and only to exact
 * allowlisted host names on port 443. TLS stays end-to-end.
 */
export class EgressBroker {
  readonly decisions: { at: string; target: string; allowed: boolean }[] = [];
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(private readonly allowed: ReadonlySet<string>) {}
  listen(socketPath: string): Promise<void> {
    this.server = createServer((client) => this.handle(client));
    return new Promise((resolveListen, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => resolveListen());
    });
  }
  private handle(client: Socket) {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 8192)
          client.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
        return;
      }
      client.off("data", onData);
      const line = head.subarray(0, head.indexOf("\r\n")).toString("latin1");
      const rest = head.subarray(end + 4);
      const match = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      const name = match?.[1]?.toLowerCase() ?? "";
      const allowed =
        !!match &&
        match[2] === "443" &&
        isIP(name) === 0 &&
        this.allowed.has(name);
      this.decisions.push({
        at: new Date().toISOString(),
        target: match ? `${name}:${match[2]}` : "MALFORMED",
        allowed,
      });
      if (!allowed) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect(443, name);
      this.sockets.add(upstream);
      upstream.on("close", () => this.sockets.delete(upstream));
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => {
        if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
      });
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  }
  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((done) =>
      this.server ? this.server.close(() => done()) : done(),
    );
  }
}

const PROXY_PORT = 18080;
const SOCKET_IN_SANDBOX = "/run/longform/egress.sock";

/** Runs inside the sandbox: loopback TCP -> broker socket, then the CLI. */
export const SHIM = `import { createServer, connect } from "node:net";
import { spawn } from "node:child_process";
import { createReadStream, openSync } from "node:fs";
const [socket, port, executable, ...args] = process.argv.slice(2);
const server = createServer((client) => {
  const upstream = connect(socket);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
server.listen(Number(port), "127.0.0.1", () => {
  // The CLI writes to plain files, never a pipe: something in a run can switch
  // a shared pipe to non-blocking mode, and a burst then fails with EAGAIN
  // (Codex panicked "failed printing to stdout"). File writes never do.
  const out = openSync("/tmp/longform-child-stdout", "w+"),
    err = openSync("/tmp/longform-child-stderr", "w+");
  const child = spawn(executable, args, { stdio: ["inherit", out, err] });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => child.kill("SIGKILL"));
  child.on("exit", (code, signal) => {
    const status = code ?? (signal ? 128 : 1);
    const forward = (file, stream, next) => {
      const source = createReadStream(file);
      source.on("error", next);
      source.on("end", next);
      source.pipe(stream, { end: false });
    };
    forward("/tmp/longform-child-stdout", process.stdout, () =>
      forward("/tmp/longform-child-stderr", process.stderr, () =>
        process.stdout.write("", () => process.stderr.write("", () => process.exit(status))),
      ),
    );
  });
  child.on("error", () => process.exit(127));
});
`;

/** Runs inside the same sandbox recipe to check the controls actually hold. */
const SELF_TEST = `import { createServer, connect } from "node:net";
import { lookup } from "node:dns/promises";
import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
const [socket, port, workspace, writable, allowedHost, ...forbidden] = process.argv.slice(2);
const result = {};
const server = createServer((client) => {
  const upstream = connect(socket);
  client.pipe(upstream); upstream.pipe(client);
  client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy());
});
await new Promise((r) => server.listen(Number(port), "127.0.0.1", r));
const direct = () => new Promise((r) => {
  const s = connect({ host: "1.1.1.1", port: 443, timeout: 2000 });
  s.on("connect", () => { s.destroy(); r("CONNECTED"); });
  s.on("timeout", () => { s.destroy(); r("TIMEOUT"); });
  s.on("error", (e) => r(e.code ?? "ERROR"));
});
const proxied = (target) => new Promise((r) => {
  const s = connect(Number(port), "127.0.0.1");
  let data = "";
  s.on("connect", () => s.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n"));
  s.on("data", (d) => { data += d; if (data.includes("\\r\\n")) { s.destroy(); r(data.split("\\r\\n")[0]); } });
  s.on("error", (e) => r("ERROR " + (e.code ?? "")));
  setTimeout(() => { s.destroy(); r("TIMEOUT"); }, 10000).unref();
});
result.directEgress = await direct();
result.dns = await lookup("example.com").then(() => "RESOLVED", (e) => e.code ?? "ERROR");
result.deniedTarget = await proxied("example.com:443");
result.allowedTarget = await proxied(allowedHost + ":443");
result.forbiddenVisible = forbidden.filter((p) => existsSync(p));
result.processCount = readdirSync("/proc").filter((n) => /^\\d+$/.test(n)).length;
const probe = workspace + "/.longform-runner-probe-" + process.pid;
try { writeFileSync(probe, "x"); unlinkSync(probe); result.workspaceWrite = "WRITABLE"; }
catch (e) { result.workspaceWrite = e.code ?? "ERROR"; }
result.expectWritable = writable === "1";
server.close();
process.stdout.write(JSON.stringify(result), () => process.exit(0));
`;

type Active = {
  child: ReturnType<typeof spawn>;
  innerPid?: number;
  exited: Promise<void>;
};
/** The process is gone, or an unreaped zombie: the namespace init may linger briefly as one. */
function processStopped(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z"
    );
  } catch {
    return true;
  }
}
/** Every process of a launched run has stopped: the sandbox and what it ran. */
function launchedStopped(entry: Active): boolean {
  const outerExited =
    entry.child.exitCode !== null || entry.child.signalCode !== null;
  return outerExited && (!entry.innerPid || processStopped(entry.innerPid));
}
const aliveDetail = (entry: Active) =>
  "its sandbox process is alive (pid " +
  entry.child.pid +
  (entry.innerPid ? ", inner pid " + entry.innerPid : "") +
  ")";

/**
 * Bubblewrap runner. Each run gets fresh user/PID/network/IPC/UTS namespaces,
 * a read-only system, an empty per-run HOME, the task workspace and nothing
 * else from the host. Killing the outer bwrap kills the PID namespace, so
 * cancellation is confirmed only once the namespace init has exited.
 */
const STAND_IN = Buffer.from(DROPPED_CODEX_EVENTS);
/**
 * A run's stdout kept within a byte budget without changing what the CLI
 * parsers decide. For a Codex event stream, past the
 * budget it drops only lines the parsers skip (skippableCodexEvent), keeping
 * one skipped line in place of each run of them (a stand-in, or the first
 * event if it's shorter), and keeps every other line in order; nothing else is
 * ever dropped, and the kept output is never longer than the whole. If what must be kept
 * outgrows four budgets, the output is marked incomplete and the run can't
 * succeed on it.
 */
export class EventCapture {
  private readonly lines: Buffer[] = [];
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private kept = 0;
  private standingIn = false;
  dropped = 0;
  incomplete = false;
  constructor(
    private readonly budget: number,
    private readonly codexEvents = false,
  ) {}
  add(chunk: Buffer) {
    let start = 0;
    while (!this.incomplete) {
      const end = chunk.indexOf(10, start);
      if (end === -1) break;
      this.pending.push(chunk.subarray(start, end + 1));
      const line = Buffer.concat(this.pending);
      this.pending = [];
      this.pendingBytes = 0;
      start = end + 1;
      this.line(line);
    }
    const rest = chunk.subarray(start);
    if (this.incomplete) {
      this.dropped += rest.length;
      return;
    }
    if (!rest.length) return;
    this.pending.push(rest);
    this.pendingBytes += rest.length;
    if (this.kept + this.pendingBytes > 4 * this.budget) this.giveUp();
  }
  private line(line: Buffer) {
    if (
      this.codexEvents &&
      this.kept + line.length > this.budget &&
      skippableCodexEvent(line.toString("utf8"))
    ) {
      // One line stands in for each run: the event itself when it's no longer
      // than the stand-in, so the kept output is never longer than the whole.
      if (this.standingIn) this.dropped += line.length;
      else if (line.length <= STAND_IN.length) this.keep(line);
      else {
        this.dropped += line.length;
        this.keep(STAND_IN);
      }
      this.standingIn = true;
      return;
    }
    this.standingIn = false;
    this.keep(line);
  }
  private keep(line: Buffer) {
    if (this.kept + line.length > 4 * this.budget) {
      this.dropped += line.length;
      this.giveUp();
      return;
    }
    this.lines.push(line);
    this.kept += line.length;
  }
  private giveUp() {
    this.incomplete = true;
    this.dropped += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
  }
  text(): string {
    return Buffer.concat([...this.lines, ...this.pending]).toString("utf8");
  }
}

/**
 * Diagnostic output (stderr) kept within a byte budget: its start and its end,
 * with the middle dropped. The cut falls on line ends.
 */
export class Capture {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  dropped = 0;
  constructor(private readonly budget: number) {}
  add(chunk: Buffer) {
    const headRoom = Math.floor(this.budget / 2) - this.headBytes;
    if (headRoom > 0) {
      const part = chunk.subarray(0, headRoom);
      this.head.push(part);
      this.headBytes += part.length;
      chunk = chunk.subarray(part.length);
    }
    if (!chunk.length) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    const tailRoom = this.budget - Math.floor(this.budget / 2);
    while (this.tailBytes > tailRoom) {
      const first = this.tail[0]!,
        excess = this.tailBytes - tailRoom;
      if (first.length <= excess) this.tail.shift();
      else this.tail[0] = first.subarray(excess);
      const removed = Math.min(first.length, excess);
      this.tailBytes -= removed;
      this.dropped += removed;
    }
  }
  text(): string {
    const head = Buffer.concat(this.head),
      tail = Buffer.concat(this.tail);
    if (!this.dropped) return Buffer.concat([head, tail]).toString("utf8");
    const headEnd = head.lastIndexOf(10),
      tailStart = tail.indexOf(10);
    return Buffer.concat([
      headEnd >= 0 ? head.subarray(0, headEnd + 1) : Buffer.alloc(0),
      tailStart >= 0 ? tail.subarray(tailStart + 1) : Buffer.alloc(0),
    ]).toString("utf8");
  }
}

export class BubblewrapRunner implements IsolatedProviderRunner {
  private readonly active = new Map<string, Active>();
  /**
   * Runs not launched yet. While the host prepares one (Drive login, source
   * pack), `stop` aborts that work and `preparing` settles once it has stopped.
   */
  private readonly pending = new Map<
    string,
    { cancelled: boolean; stop?: () => void; preparing?: Promise<unknown> }
  >();
  constructor(
    private readonly config: LiveConfig,
    /** Tests only: a fake Drive API for the gateway. */
    private readonly options: { driveFetcher?: DriveFetch } = {},
  ) {
    mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(config.stateDir, "shim.mjs"), SHIM, { mode: 0o600 });
    writeFileSync(join(config.stateDir, "self-test.mjs"), SELF_TEST, {
      mode: 0o600,
    });
    writeFileSync(join(config.stateDir, "drive-client.mjs"), DRIVE_CLIENT, {
      mode: 0o600,
    });
    writeFileSync(
      join(config.stateDir, "longform-drive"),
      `#!/bin/sh\nexec ${realpathSync(config.nodeExecutable)} /run/longform-shim/drive-client.mjs "$@"\n`,
      { mode: 0o700 },
    );
    chmodSync(join(config.stateDir, "longform-drive"), 0o700);
  }
  private providerConfig(provider: "codex" | "claude") {
    const value = this.config.providers[provider];
    if (!value) throw new Error("LIVE_PROVIDER_NOT_CONFIGURED:" + provider);
    return value;
  }
  /** Host paths a sandboxed process must never see. */
  private forbiddenPaths(): string[] {
    const home = homedir();
    // Provider binaries can live under ~/.codex or ~/.claude, so mounting one
    // materialises those directories; check the secrets inside them instead.
    const codexSecrets = (dir: string) => [
      join(dir, "auth.json"),
      join(dir, "sessions"),
      join(dir, "config.toml"),
    ];
    return [
      join(home, ".ssh"),
      join(home, ".claude", ".credentials.json"),
      join(home, ".claude", "projects"),
      ...codexSecrets(join(home, ".codex")),
      join(home, ".config"),
      this.config.stateDir,
      ...(this.config.providers.claude
        ? [this.config.providers.claude.oauthTokenFile]
        : []),
      ...(this.config.providers.codex
        ? codexSecrets(this.config.providers.codex.codexHome)
        : []),
      ...(this.config.drive && "clientFile" in this.config.drive
        ? [this.config.drive.clientFile, this.config.drive.tokenFile]
        : []),
    ];
  }
  private sandboxArgs(options: {
    home: string;
    socketDir: string;
    workspace: string;
    writableWorkspace: boolean;
    executable?: string;
    /** The run's owner-text folder, mounted read-only at OWNER_TEXT_IN_SANDBOX. */
    ownerText?: string;
  }): string[] {
    const node = realpathSync(this.config.nodeExecutable);
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind-try",
      "/lib64",
      "/lib64",
      "--ro-bind-try",
      "/etc/ssl",
      "/etc/ssl",
      "--ro-bind-try",
      "/etc/ca-certificates",
      "/etc/ca-certificates",
      "--ro-bind-try",
      "/etc/hosts",
      "/etc/hosts",
      "--ro-bind-try",
      "/etc/localtime",
      "/etc/localtime",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      dirname(node),
      dirname(node),
      "--ro-bind",
      join(this.config.stateDir, "shim.mjs"),
      "/run/longform-shim/shim.mjs",
      "--ro-bind",
      join(this.config.stateDir, "self-test.mjs"),
      "/run/longform-shim/self-test.mjs",
      "--ro-bind",
      join(this.config.stateDir, "drive-client.mjs"),
      "/run/longform-shim/drive-client.mjs",
      "--ro-bind",
      join(this.config.stateDir, "longform-drive"),
      DRIVE_CLIENT_IN_SANDBOX,
      "--bind",
      options.socketDir,
      "/run/longform",
      "--bind",
      options.home,
      "/home/worker",
      options.writableWorkspace ? "--bind" : "--ro-bind",
      options.workspace,
      options.workspace,
      "--chdir",
      options.workspace,
    ];
    if (options.executable)
      args.push(
        "--ro-bind",
        dirname(options.executable),
        dirname(options.executable),
      );
    if (options.ownerText)
      args.push("--ro-bind", options.ownerText, OWNER_TEXT_IN_SANDBOX);
    return args;
  }
  private sandboxEnv(
    base: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const proxy = `http://127.0.0.1:${PROXY_PORT}`;
    return {
      ...base,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      ALL_PROXY: proxy,
      NO_PROXY: "",
      no_proxy: "",
    };
  }
  private runDir(id: string) {
    const dir = join(this.config.stateDir, "runs", id);
    // Run IDs are unique; an existing directory is an artifact and is never replaced.
    mkdirSync(join(this.config.stateDir, "runs"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(dir, { mode: 0o700 });
    mkdirSync(join(dir, "home"), { mode: 0o700 });
    // Unix socket paths are limited to 108 bytes; keep the broker socket short.
    const base =
      process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR)
        ? process.env.XDG_RUNTIME_DIR
        : tmpdir();
    const sockets = mkdtempSync(join(base, "longform-"));
    chmodSync(sockets, 0o700);
    return { dir, home: join(dir, "home"), sockets };
  }
  /** Run directories are kept as artifacts; only login copies and sockets go. */
  private removeRun(run: { dir: string; sockets: string }) {
    for (const secret of [
      join(run.dir, "home", ".codex", "auth.json"),
      join(run.dir, "home", ".claude", ".credentials.json"),
    ])
      rmSync(secret, { force: true });
    rmSync(run.sockets, { recursive: true, force: true });
  }
  private launch(
    id: string,
    bwrapArgs: string[],
    command: string[],
    env: Record<string, string>,
    stdin: string,
    maxOutputBytes: number,
    /** stdout is a Codex `--json` event stream (see EventCapture). */
    codexEvents = false,
  ): Promise<ProcessResult> {
    const child = spawn(
      this.config.bwrapExecutable,
      [...bwrapArgs, "--info-fd", "3", "--", ...command],
      {
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    // Output past the limit never stops a run: a
    // Codex event stream drops only what the parsers skip, other stdout drops
    // nothing, and stderr, a diagnostic, keeps its start and its end. Most of
    // the room is stdout's.
    const stdoutBudget = Math.floor((maxOutputBytes * 3) / 4);
    const stdout = new EventCapture(stdoutBudget, codexEvents),
      stderr = new Capture(maxOutputBytes - stdoutBudget);
    let info = "";
    const entry: Active = { child, exited: Promise.resolve() };
    const result = new Promise<ProcessResult>((resolveResult) => {
      child.stdout!.on("data", (d: Buffer) => stdout.add(d));
      child.stderr!.on("data", (d: Buffer) => stderr.add(d));
      (child.stdio[3] as NodeJS.ReadableStream).on("data", (d: Buffer) => {
        info += d.toString();
        const pid = /"child-pid":\s*(\d+)/.exec(info)?.[1];
        if (pid) entry.innerPid = Number(pid);
      });
      child.once("error", (error) =>
        resolveResult({
          exitCode: null,
          status: "FAILED",
          stdout: "",
          stderr: error.message,
        }),
      );
      child.once("close", (code) =>
        resolveResult({
          exitCode: code,
          status:
            code === 0 ? "SUCCEEDED" : code === null ? "UNKNOWN" : "FAILED",
          stdout: stdout.text(),
          stderr: stderr.text(),
          ...(stdout.dropped || stderr.dropped
            ? { droppedBytes: stdout.dropped + stderr.dropped }
            : {}),
          ...(stdout.incomplete ? { outputIncomplete: true } : {}),
        }),
      );
    });
    entry.exited = result.then(() => undefined);
    this.active.set(id, entry);
    child.stdin!.on("error", () => {});
    child.stdin!.end(stdin);
    return result.finally(() => this.active.delete(id));
  }
  private killGroup(pid: number | undefined) {
    try {
      if (pid) process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  async verify(input: {
    provider: "codex" | "claude";
    executable: string;
    executableDigest: string;
    workspace: string;
    writableWorkspace: boolean;
    writablePaths: readonly string[];
  }): Promise<IsolatedRunnerVerification> {
    const settings = this.providerConfig(input.provider);
    const executable = realpathSync(input.executable);
    if (executable !== realpathSync(settings.executable))
      throw new Error("RUNNER_EXECUTABLE_NOT_CONFIGURED");
    const executableDigest = fileDigest(executable);
    // Missing or loosely permissioned credentials fail preflight, before any launch.
    const credential =
      input.provider === "claude"
        ? (settings as NonNullable<LiveConfig["providers"]["claude"]>)
            .oauthTokenFile
        : join(
            (settings as NonNullable<LiveConfig["providers"]["codex"]>)
              .codexHome,
            "auth.json",
          );
    const info = statSync(credential);
    if (!info.isFile() || info.size === 0 || (info.mode & 0o077) !== 0)
      throw new Error("RUNNER_CREDENTIAL_MISSING_OR_NOT_OWNER_ONLY");
    const recovery =
      input.provider === "codex" ? this.codexRecoveryPending() : undefined;
    if (recovery)
      throw new Error("CODEX_CREDENTIAL_RECOVERY_PENDING: " + recovery);
    const id = "verify-" + randomUUID();
    const run = this.runDir(id);
    const broker = new EgressBroker(new Set(settings.allowedHosts));
    try {
      await broker.listen(join(run.sockets, "egress.sock"));
      const outcome = await this.launch(
        id,
        this.sandboxArgs({
          home: run.home,
          socketDir: run.sockets,
          workspace: input.workspace,
          writableWorkspace: input.writableWorkspace,
          executable,
        }),
        [
          realpathSync(this.config.nodeExecutable),
          "/run/longform-shim/self-test.mjs",
          SOCKET_IN_SANDBOX,
          String(PROXY_PORT),
          input.workspace,
          input.writableWorkspace ? "1" : "0",
          settings.allowedHosts[0]!,
          ...this.forbiddenPaths(),
        ],
        { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/home/worker" },
        "",
        65_536,
      );
      let probe: Record<string, unknown> = {};
      try {
        probe = JSON.parse(outcome.stdout);
      } catch {
        /* failed self-test is reported below */
      }
      const networkAllowlisted =
        outcome.status === "SUCCEEDED" &&
        probe.directEgress !== "CONNECTED" &&
        probe.dns !== "RESOLVED" &&
        String(probe.deniedTarget).includes(" 403 ") &&
        typeof probe.allowedTarget === "string" &&
        /^HTTP\/1\.1 (200|502) /.test(probe.allowedTarget);
      const filesystemAllowlisted =
        Array.isArray(probe.forbiddenVisible) &&
        probe.forbiddenVisible.length === 0 &&
        (input.writableWorkspace
          ? probe.workspaceWrite === "WRITABLE"
          : probe.workspaceWrite === "EROFS");
      const osIsolated =
        typeof probe.processCount === "number" && probe.processCount < 16;
      const verifiedAt = new Date().toISOString();
      const evidenceRef = writeEvidence(this.config.stateDir, id, {
        kind: "ISOLATED_RUNNER_SELF_TEST",
        at: verifiedAt,
        provider: input.provider,
        executable,
        executableDigest,
        workspace: input.workspace,
        writableWorkspace: input.writableWorkspace,
        writablePathsEnforcedBy:
          "workspace mount is read-only unless writable; path-level scope inside the workspace is enforced by the controller's post-run snapshot check",
        bwrap: {
          exit: outcome.exitCode,
          stderr: outcome.stderr.slice(0, 2000),
        },
        probe,
        brokerDecisions: broker.decisions,
        nestedDelegationBasis:
          "CLI argv: Claude has no Agent tool; Codex runs with features.multi_agent=false",
      });
      return {
        osIsolated,
        filesystemAllowlisted,
        networkAllowlisted,
        credentialsScoped: true,
        nestedDelegationDisabled: true,
        supportsWritableWorkspace: true,
        executableDigest,
        verifiedAt,
        evidenceRef,
      };
    } finally {
      await broker.close();
      this.removeRun(run);
    }
  }
  /** One Codex run at a time per credential source: its refresh token rotates in place. */
  private codexCredentialKey(codexHome: string) {
    return codexCredentialKey(codexHome);
  }
  private codexLockPath(codexHome: string) {
    const { dir, key } = codexCredentialKey(codexHome);
    return join(dir, key + ".lock");
  }
  /** Set only when no durable recovery record could be written at all. */
  private recoveryBlocked: string | undefined;
  private codexRecoveryPending() {
    // The in-process barrier names the kept credentials; once the owner has
    // restored and deleted them, it clears.
    if (this.recoveryBlocked && !existsSync(this.recoveryBlocked))
      this.recoveryBlocked = undefined;
    return this.recoveryBlocked ?? codexRecoveryPending(this.config);
  }
  async execute(input: IsolatedRunInput): Promise<IsolatedRunResult> {
    const settings = this.providerConfig(input.provider);
    if (realpathSync(input.executable) !== realpathSync(settings.executable))
      throw new Error("RUNNER_EXECUTABLE_NOT_CONFIGURED");
    if (fileDigest(input.executable) !== input.executableDigest)
      throw new Error("RUNNER_EXECUTABLE_CHANGED");
    // Registered before any wait, so a cancel that arrives while this run is
    // queued for the credential lock is final: the run will never launch.
    const pending: {
      cancelled: boolean;
      stop?: () => void;
      preparing?: Promise<unknown>;
    } = { cancelled: false };
    this.pending.set(input.runId, pending);
    // The records the workspace holds now came with the sealed work the
    // controller copied in; only these and this run's own are restored later.
    const inheritedRecords = input.policy.writableWorkspace
      ? recordFolders(input.cwd)
      : [];
    // `notLaunched` is runner metadata; the stderr text is only a diagnostic.
    const notStarted = (): ProcessResult & { notLaunched: true } => ({
      exitCode: null,
      status: "CANCELLED",
      stdout: "",
      stderr: "CANCELLED_BEFORE_LAUNCH",
      notLaunched: true,
    });
    let release: () => Promise<void> = async () => {};
    try {
      if (input.provider === "codex")
        release = await kernelLock(
          this.codexLockPath(
            (
              this.config.providers.codex as NonNullable<
                LiveConfig["providers"]["codex"]
              >
            ).codexHome,
          ),
          { deadlineMs: input.deadlineMs, signal: input.signal },
        );
    } catch (error) {
      this.pending.delete(input.runId);
      if (pending.cancelled || input.signal?.aborted) return notStarted();
      throw error;
    }
    if (pending.cancelled || input.signal?.aborted) {
      this.pending.delete(input.runId);
      await release();
      return notStarted();
    }
    // From here until release() everything is protected: no setup or cleanup
    // failure can leave the credential lock held.
    let run: { dir: string; home: string; sockets: string } | undefined;
    const broker = new EgressBroker(new Set(settings.allowedHosts));
    let gateway: DriveGateway | undefined;
    let pack: PackManifestEntry[] = [];
    const secrets: string[] = [];
    const env = this.sandboxEnv(input.env);
    let codexAuth: string | undefined, codexAuthBefore: Buffer | undefined;
    let credentialFailure: string | undefined;
    let keepRunDirectory = false;
    let result: IsolatedRunResult | undefined;
    try {
      result = await (async () => {
        run = this.runDir(input.runId);
        const home = run.home;
        if (input.provider === "claude") {
          const raw = readFileSync(
            (settings as NonNullable<LiveConfig["providers"]["claude"]>)
              .oauthTokenFile,
            "utf8",
          );
          // Pasted copies are often labelled and wrapped; tokens contain no whitespace.
          const joined = raw.replace(/\s+/g, "");
          const token =
            /sk-ant-oat\d+-[A-Za-z0-9_-]+/.exec(joined)?.[0] ?? joined;
          if (!token) throw new Error("CLAUDE_SUBSCRIPTION_TOKEN_EMPTY");
          env.CLAUDE_CODE_OAUTH_TOKEN = token;
          secrets.push(token);
        } else {
          const codexHome = (
            settings as NonNullable<LiveConfig["providers"]["codex"]>
          ).codexHome;
          // Checked under the credential lock, so no run starts from a stale
          // source while a newer login is waiting to be restored.
          const recovery = this.codexRecoveryPending();
          if (recovery)
            return {
              exitCode: null,
              status: "FAILED" as const,
              stdout: "",
              stderr: "CODEX_CREDENTIAL_RECOVERY_PENDING: " + recovery,
              notLaunched: true,
            };
          const source = join(codexHome, "auth.json");
          mkdirSync(join(home, ".codex"), { mode: 0o700 });
          codexAuth = source;
          codexAuthBefore = readFileSync(source);
          writeFileSync(join(home, ".codex", "auth.json"), codexAuthBefore, {
            mode: 0o600,
          });
          collectSecrets(JSON.parse(codexAuthBefore.toString("utf8")), secrets);
        }
        if (input.outputSchema)
          writeFileSync(
            join(home, "output-schema.json"),
            JSON.stringify(input.outputSchema),
            {
              mode: 0o600,
            },
          );
        await broker.listen(join(run.sockets, "egress.sock"));
        if (input.policy.drive) {
          const failed = (why: string) => ({
            exitCode: null,
            status: "FAILED" as const,
            stdout: "",
            stderr: why,
            notLaunched: true,
          });
          if (!this.config.drive) return failed("DRIVE_NOT_CONFIGURED");
          // A read-only run (reviewer, advisor) may only read: its record
          // stays on the host, since its workspace cannot change.
          const { update, createIn, pack: listed } = input.policy.drive;
          if (
            !input.policy.writableWorkspace &&
            (update.length || createIn.length || listed?.length)
          )
            return failed("DRIVE_WRITE_REQUIRES_WRITABLE_WORKER");
          // A cancel confirmed while the run was being set up (the egress
          // broker, the login copy) stops it here, before any Drive call;
          // from here on a cancel stops the preparation itself (review r2).
          if (pending.cancelled || input.signal?.aborted) return notStarted();
          gateway = new DriveGateway({
            credentials: this.config.drive,
            policy: input.policy.drive,
            workspace: realpathSync(input.cwd),
            auditDir: join(this.config.stateDir, "drive-audit", input.runId),
            runId: input.runId,
            ...(this.options.driveFetcher
              ? { fetcher: this.options.driveFetcher }
              : {}),
            ...(input.driveWrites ? { writes: input.driveWrites } : {}),
          });
          // Cancelling the run, or its deadline, stops the preparation; a
          // cancel waits for it to stop, so nothing reaches the workspace after
          // the run is confirmed cancelled (review r1 finding R2).
          const preparation = new AbortController();
          const stop = () => preparation.abort(new Error("RUN_CANCELLED"));
          input.signal?.addEventListener("abort", stop, { once: true });
          pending.stop = stop;
          const ready = gateway;
          const prepared = (async () => {
            try {
              await ready.prepare(preparation.signal);
            } catch (error) {
              return "DRIVE_LOGIN_FAILED: " + String(error);
            }
            try {
              pack = await ready.preparePack(preparation.signal);
            } catch (error) {
              return "DRIVE_PACK_FAILED: " + String(error);
            }
            return undefined;
          })();
          pending.preparing = prepared;
          const why = await prepared.finally(() => {
            input.signal?.removeEventListener("abort", stop);
            pending.stop = undefined;
          });
          if (pending.cancelled || input.signal?.aborted) return notStarted();
          if (why) return failed(why);
          await gateway.listen(join(run.sockets, "drive.sock"));
        }
        // The owner's words the brief relies on, checked again just before
        // launch: a missing, linked or changed file means no launch.
        if (input.ownerText) {
          const problem = ownerTextProblem(input.ownerText);
          if (problem)
            return {
              exitCode: null,
              status: "FAILED" as const,
              stdout: "",
              stderr: problem,
              notLaunched: true,
            };
        }
        // The controller's launch gate, after every wait (queue, credential
        // lock, Drive preparation): a provider paused for its usage limit
        // meanwhile is not launched into .
        const gate = input.launchGate?.();
        if (gate)
          return {
            exitCode: null,
            status: "FAILED" as const,
            stdout: "",
            stderr: gate,
            notLaunched: true,
          };
        // Last check before launch; launch() registers the process synchronously.
        if (pending.cancelled || input.signal?.aborted) return notStarted();
        this.pending.delete(input.runId);
        const onAbort = () => void this.cancel(input.runId);
        input.signal?.addEventListener("abort", onAbort, { once: true });
        let outcome: ProcessResult;
        try {
          outcome = await this.launch(
            input.runId,
            this.sandboxArgs({
              home,
              socketDir: run.sockets,
              workspace: input.cwd,
              writableWorkspace: input.policy.writableWorkspace,
              executable: realpathSync(input.executable),
              ...(input.ownerText
                ? { ownerText: realpathSync(input.ownerText.dir) }
                : {}),
            }),
            [
              realpathSync(this.config.nodeExecutable),
              "/run/longform-shim/shim.mjs",
              SOCKET_IN_SANDBOX,
              String(PROXY_PORT),
              realpathSync(input.executable),
              ...input.args,
            ],
            env,
            input.stdin,
            input.maxOutputBytes,
            input.provider === "codex",
          );
        } finally {
          input.signal?.removeEventListener("abort", onAbort);
        }
        // The run has exited: stop the gateway and hand a worker's record to
        // its reviewers. A read-only run's record stays on the host.
        let drive: Record<string, unknown> | undefined;
        if (gateway) {
          await gateway.close();
          const copy = input.policy.writableWorkspace
            ? gateway.finalize()
            : undefined;
          drive = {
            auditDir: join(this.config.stateDir, "drive-audit", input.runId),
            ...(copy ? { workspaceCopy: copy } : { readOnly: true }),
            calls: gateway.log.length,
            ...(pack.length
              ? {
                  pack: pack.map((f) => ({
                    id: f.id,
                    version: f.version,
                    sha256: f.sha256,
                  })),
                }
              : {}),
            ...driveWriteSummary(gateway.log),
          };
          if (copy && !copy.copied)
            outcome = {
              ...outcome,
              status: "FAILED",
              stderr:
                outcome.stderr +
                "\nDRIVE_RECORD_NOT_COPIED_TO_WORKSPACE: " +
                copy.error,
            };
        }
        // Every run's Drive record in a worker's workspace, earlier runs'
        // included, is put back to the host's copy (review r2 finding R6).
        if (input.policy.writableWorkspace) {
          const records = restoreDriveRecords(
            realpathSync(input.cwd),
            join(this.config.stateDir, "drive-audit"),
            new Set([...inheritedRecords, input.runId]),
          );
          if (records.error)
            outcome = {
              ...outcome,
              status: "FAILED",
              stderr:
                outcome.stderr +
                "\nDRIVE_RECORD_RESTORE_FAILED: " +
                records.error,
            };
          else if (drive && records.restored.length > 1)
            drive.restored = records.restored;
        }
        const clean = {
          ...outcome,
          stdout: redact(outcome.stdout, secrets),
          stderr: redact(outcome.stderr, secrets),
        };
        const observed =
          outcome.status === "SUCCEEDED"
            ? input.provider === "claude"
              ? claudeIdentity(clean.stdout, input.args)
              : codexIdentity(clean.stdout, home)
            : null;
        // Compared on the raw stream, before redaction, so a secret-like
        // pattern can't make identical messages differ (review r1 finding 1).
        const messagePhases =
          input.provider === "codex" && observed?.ok && observed.messages
            ? codexStreamPhases(outcome.stdout, observed.messages)
            : undefined;
        // How a Codex run that did not succeed ended, from its own session
        // log (a usage limit, and its usage), when that log is unambiguous.
        const codexSession =
          input.provider === "codex" && outcome.status !== "SUCCEEDED"
            ? codexRunSignal(clean.stdout, home)
            : undefined;
        const evidenceRef = writeEvidence(
          this.config.stateDir,
          "run-" + input.runId,
          {
            kind: "ISOLATED_RUN",
            at: new Date().toISOString(),
            runId: input.runId,
            taskId: input.taskId,
            provider: input.provider,
            executableDigest: input.executableDigest,
            exitCode: outcome.exitCode,
            status: outcome.status,
            stdoutDigest: sha256(clean.stdout),
            stderrTail: clean.stderr.slice(-4000),
            ...(outcome.droppedBytes
              ? { outputDroppedBytes: outcome.droppedBytes }
              : {}),
            ...(outcome.outputIncomplete ? { outputIncomplete: true } : {}),
            brokerDecisions: broker.decisions,
            ...(drive ? { drive } : {}),
            ...(codexSession
              ? {
                  codexSession: {
                    errorInfo: codexSession.errorInfo,
                    rateLimits: codexSession.rateLimits,
                    tokenUsageRecorded: codexSession.totalTokenUsage !== null,
                  },
                }
              : {}),
            identity: observed
              ? observed.ok
                ? {
                    ok: true,
                    model: observed.model,
                    effort: observed.effort,
                    sessionId: observed.sessionId,
                    basis: observed.basis,
                    // Labels only; the message text stays out of evidence.
                    ...(observed.messages
                      ? {
                          sessionMessagePhases: observed.messages.map(
                            (message) => message.phase,
                          ),
                          streamPhasesMatched: messagePhases !== undefined,
                        }
                      : {}),
                  }
                : observed
              : observed,
          },
        );
        if (!observed?.ok)
          return { ...clean, ...(codexSession ? { codexSession } : {}) };
        return {
          ...clean,
          identity: {
            runId: input.runId,
            taskId: input.taskId,
            provider: input.provider,
            model: observed.model,
            effort: observed.effort,
            sessionId: observed.sessionId,
            executableDigest: input.executableDigest,
            source: "AUTHENTICATED_HARNESS",
            evidenceRef,
          },
          ...(messagePhases ? { messagePhases } : {}),
        };
      })();
    } finally {
      const step = async (action: () => unknown) => {
        try {
          await action();
        } catch {
          /* each cleanup step is independent; release always runs */
        }
      };
      await step(() => broker.close());
      await step(() => gateway?.close());
      // Persist a refreshed Codex token back to its source home only. A failure
      // is never silent: it is recorded before anything else is attempted, and
      // the newest login is kept where every runner of it checks before launch.
      await step(() => {
        if (!codexAuth || !codexAuthBefore || !run) return;
        const runAuth = join(run.home, ".codex", "auth.json");
        let after: Buffer | undefined;
        let cause: unknown;
        try {
          after = readFileSync(runAuth);
        } catch (error) {
          cause = error;
        }
        if (after?.equals(codexAuthBefore)) return;
        let leftover = "";
        if (after) {
          const temporary = codexAuth + ".longform-" + randomUUID();
          try {
            writeFileSync(temporary, after, { mode: 0o600 });
            renameSync(temporary, codexAuth);
            return;
          } catch (error) {
            cause = error;
          }
          try {
            rmSync(temporary, { force: true });
          } catch {
            leftover = `; a partial copy may remain at ${temporary}`;
          }
        }
        keepRunDirectory = true;
        const failed = (kept: string, restore: string) =>
          `CODEX_CREDENTIAL_PERSISTENCE_FAILED: ${String(cause)}; newest credentials kept at ${kept}${leftover}; copy ${restore} to ${codexAuth}, then delete ${kept} before the next Codex run`;
        // Unreadable credentials can only be recovered from the run directory.
        const keptHere = after ? runAuth : run.dir;
        credentialFailure = failed(keptHere, runAuth);
        // This runner refuses Codex runs until something durable replaces this,
        // or the owner restores and deletes what it names.
        this.recoveryBlocked = keptHere;
        const codexHome = (
          this.config.providers.codex as NonNullable<
            LiveConfig["providers"]["codex"]
          >
        ).codexHome;
        const { dir, key } = codexCredentialKey(codexHome);
        const recovery = join(dir, key + ".recovery-" + input.runId);
        const keeps: Array<[string, string, () => void]> = [];
        if (after) {
          const copy = after;
          keeps.push(
            [
              recovery + ".json",
              recovery + ".json",
              () =>
                writeFileSync(recovery + ".json", copy, {
                  mode: 0o600,
                  flag: "wx",
                }),
            ],
            // A rename needs no free space on the same filesystem.
            [
              recovery + ".json",
              recovery + ".json",
              () => renameSync(runAuth, recovery + ".json"),
            ],
          );
        }
        keeps.push([
          recovery + ".dir",
          join(recovery + ".dir", "home", ".codex", "auth.json"),
          () => renameSync(run!.dir, recovery + ".dir"),
        ]);
        for (const [kept, restore, keep] of keeps) {
          try {
            keep();
          } catch {
            continue;
          }
          credentialFailure = failed(kept, restore);
          this.recoveryBlocked = undefined;
          break;
        }
      });
      this.pending.delete(input.runId);
      await step(
        () =>
          run &&
          (keepRunDirectory
            ? rmSync(run.sockets, { recursive: true, force: true })
            : this.removeRun(run)),
      );
      await release();
    }
    if (!credentialFailure) return result;
    // The work may be fine, but the login is now at risk: report the run as
    // failed (usage still parsed from stdout) and drop the identity proof.
    return {
      exitCode: result.exitCode,
      status: "FAILED",
      stdout: result.stdout,
      stderr: (result.stderr + "\n" + credentialFailure).slice(-8000),
    };
  }
  async cancel(runId: string): Promise<boolean> {
    const queued = this.pending.get(runId);
    if (queued) {
      // Not launched yet; execute() checks this flag before launching. Any
      // preparation in progress is stopped, and confirmed only once stopped.
      queued.cancelled = true;
      queued.stop?.();
      await queued.preparing;
      return true;
    }
    const entry = this.active.get(runId);
    if (!entry) return true;
    this.killGroup(entry.child.pid);
    await Promise.race([
      entry.exited,
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    for (
      let waited = 0;
      entry.innerPid && !processStopped(entry.innerPid) && waited < 2_000;
      waited += 20
    )
      await new Promise((r) => setTimeout(r, 20));
    return launchedStopped(entry);
  }
  /**
   * Whether any process of a run is alive, from the runner's own records: a
   * run not launched yet has none (a cancel while it waits is final), a
   * launched one is checked like a cancel checks it, and one the runner
   * does not hold has ended here.
   */
  activity(runId: string): RunActivity {
    if (this.pending.has(runId))
      return {
        processStopped: true,
        detail:
          "not launched: no sandbox process (a credential lock it holds goes with this process)",
      };
    const entry = this.active.get(runId);
    if (!entry)
      return { processStopped: true, detail: "no sandbox process of it is held" };
    return launchedStopped(entry)
      ? { processStopped: true, detail: "its sandbox process has stopped" }
      : { processStopped: false, detail: aliveDetail(entry) };
  }
  /**
   * Runs with a sandbox process alive, whether or not their execute() has
   * returned (a cancellation's confirmation is bounded; the process may
   * still be stopping). A run not launched has none.
   */
  busy(): BusyRun[] {
    return [...this.active]
      .filter(([, entry]) => !launchedStopped(entry))
      .map(([runId, entry]) => ({ runId, detail: aliveDetail(entry) }));
  }
}

/**
 * Kernel advisory lock held only by a helper `flock --close` process, for as long
 * as its stdin stays open (killing the helper also releases it). Only one holder can exist; if this process dies the pipe closes
 * and the kernel releases the lock, so there is no stale-lock recovery to race.
 */
/** Why a run's owner-text folder cannot be mounted as it was prepared, if so. */
function ownerTextProblem(ownerText: {
  dir: string;
  files: ReadonlyArray<{ file: string; sha256: string }>;
}): string | undefined {
  try {
    if (!lstatSync(ownerText.dir).isDirectory())
      return "OWNER_TEXT_UNAVAILABLE: not a folder";
    for (const f of ownerText.files) {
      if (!/^request-[A-Za-z0-9-]{1,80}\.txt$/.test(f.file))
        return "OWNER_TEXT_UNAVAILABLE: unexpected file name";
      const path = join(ownerText.dir, f.file);
      if (!lstatSync(path).isFile())
        return "OWNER_TEXT_UNAVAILABLE: not a regular file: " + f.file;
      if (sha256(readFileSync(path)) !== f.sha256)
        return "OWNER_TEXT_UNAVAILABLE: changed: " + f.file;
    }
  } catch (error) {
    return "OWNER_TEXT_UNAVAILABLE: " + String(error).slice(0, 200);
  }
  return undefined;
}
export function kernelLock(
  path: string,
  options: { deadlineMs: number; signal?: AbortSignal },
): Promise<() => Promise<void>> {
  return new Promise((resolveLock, reject) => {
    const helper = spawn(
      "/usr/bin/flock",
      [
        "--exclusive",
        "--close",
        path,
        "/bin/sh",
        "-c",
        "echo LOCKED; exec cat >/dev/null",
      ],
      { stdio: ["pipe", "pipe", "ignore"], shell: false },
    );
    let held = false;
    const exited = new Promise<void>((done) =>
      helper.once("close", () => done()),
    );
    const fail = (error: Error) => {
      if (held) return;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      helper.stdin!.end();
      helper.kill("SIGKILL");
      reject(error);
    };
    const onAbort = () => fail(new Error("LOCK_WAIT_CANCELLED"));
    const timer = setTimeout(
      () => fail(new Error("CREDENTIAL_LOCK_TIMEOUT")),
      options.deadlineMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    helper.once("error", (error) => fail(error));
    helper.once("close", () =>
      fail(new Error("CREDENTIAL_LOCK_HELPER_EXITED")),
    );
    helper.stdout!.on("data", (chunk: Buffer) => {
      if (held || !chunk.toString().includes("LOCKED")) return;
      held = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolveLock(async () => {
        helper.stdin!.end();
        await exited;
      });
    });
  });
}

function collectSecrets(value: unknown, out: string[]) {
  if (typeof value === "string" && value.length >= 20) out.push(value);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) collectSecrets(item, out);
}

type ObservedIdentity =
  | {
      ok: true;
      model: string;
      effort: string;
      sessionId: string;
      basis: Record<string, string>;
      /** Codex only: the session log's assistant messages, in order (raw). */
      messages?: SessionLogMessage[];
    }
  | { ok: false; reason: string };

/** Claude's result envelope `modelUsage` is written by the harness, not the model. */
function claudeIdentity(
  stdout: string,
  args: readonly string[],
): ObservedIdentity {
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>;
    const usage = envelope.modelUsage as Record<string, unknown> | undefined;
    const models = usage && typeof usage === "object" ? Object.keys(usage) : [];
    const effort = args[args.indexOf("--effort") + 1];
    if (
      models.length !== 1 ||
      typeof envelope.session_id !== "string" ||
      !effort
    )
      return { ok: false, reason: "CLAUDE_HARNESS_MODEL_USAGE_NOT_SINGULAR" };
    return {
      ok: true,
      model: models[0]!,
      effort,
      sessionId: envelope.session_id,
      basis: {
        model: "result envelope modelUsage (harness metadata)",
        effort:
          "runner argv --effort; Claude's envelope does not report effort",
      },
    };
  } catch {
    return { ok: false, reason: "CLAUDE_ENVELOPE_MALFORMED" };
  }
}

/** One assistant message from a Codex session log, with its recorded phase. */
export interface SessionLogMessage {
  phase: string | null;
  text: string;
}

/**
 * The phase for each agent message in a Codex run's raw `--json` stream,
 * taken from its session log, or undefined unless the two match one for one:
 * the same number of messages, the same text in the same order, every one
 * but the last labelled "commentary" and the last "final_answer". Raw text
 * on both sides: this runs before redaction and returns labels only.
 */
export function codexStreamPhases(
  rawStdout: string,
  session: readonly SessionLogMessage[],
): CodexMessagePhase[] | undefined {
  const streamed: string[] = [];
  for (const line of rawStdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return undefined;
    }
    const item =
      event &&
      typeof event === "object" &&
      (event as { type?: unknown }).type === "item.completed"
        ? (event as { item?: unknown }).item
        : undefined;
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "agent_message"
    ) {
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") return undefined;
      streamed.push(text);
    }
  }
  if (!streamed.length || streamed.length !== session.length) return undefined;
  const phases: CodexMessagePhase[] = [];
  for (let index = 0; index < session.length; index++) {
    const expected: CodexMessagePhase =
      index === session.length - 1 ? "final_answer" : "commentary";
    if (
      session[index]!.phase !== expected ||
      session[index]!.text !== streamed[index]
    )
      return undefined;
    phases.push(expected);
  }
  return phases;
}

/**
 * Codex writes model and effort into the session log's turn_context, and the
 * phase of each assistant message ("commentary" or "final_answer") into its
 * response items. The messages stay inside the runner (see codexStreamPhases).
 */
export function codexIdentity(stdout: string, home: string): ObservedIdentity {
  try {
    const thread = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === "thread.started")?.thread_id;
    if (typeof thread !== "string")
      return { ok: false, reason: "CODEX_THREAD_MISSING" };
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(path);
      }
    };
    walk(join(home, ".codex", "sessions"));
    const models = new Set<string>(),
      efforts = new Set<string>();
    const messages: SessionLogMessage[] = [];
    let matched = false;
    for (const file of files)
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as {
          type?: string;
          payload?: Record<string, unknown>;
        };
        if (record.type === "session_meta" && record.payload?.id === thread)
          matched = true;
        if (record.type === "turn_context") {
          if (typeof record.payload?.model === "string")
            models.add(record.payload.model);
          if (typeof record.payload?.effort === "string")
            efforts.add(record.payload.effort);
        }
        const payload = record.payload;
        if (
          record.type === "response_item" &&
          payload?.type === "message" &&
          payload.role === "assistant" &&
          Array.isArray(payload.content)
        )
          messages.push({
            phase: typeof payload.phase === "string" ? payload.phase : null,
            text: payload.content
              .map((part: unknown) =>
                part &&
                typeof part === "object" &&
                (part as { type?: unknown }).type === "output_text" &&
                typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join(""),
          });
      }
    if (
      !matched ||
      files.length !== 1 ||
      models.size !== 1 ||
      efforts.size !== 1
    )
      return { ok: false, reason: "CODEX_SESSION_LOG_IDENTITY_AMBIGUOUS" };
    return {
      ok: true,
      model: [...models][0]!,
      effort: [...efforts][0]!,
      sessionId: thread,
      basis: {
        model: "session log turn_context.model (harness metadata)",
        effort: "session log turn_context.effort (harness metadata)",
      },
      messages,
    };
  } catch {
    return { ok: false, reason: "CODEX_SESSION_LOG_UNREADABLE" };
  }
}

/**
 * A Codex run's session-log signal, only when the log is unambiguous: one
 * session file, of the stream's thread (as the identity proof requires).
 */
export function codexRunSignal(
  stdout: string,
  home: string,
): CodexSessionSignal | undefined {
  try {
    let thread: unknown;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.type === "thread.started") thread = event.thread_id;
      } catch {
        /* not an event line */
      }
    }
    if (typeof thread !== "string") return undefined;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl"))
          files.push(path);
      }
    };
    walk(join(home, ".codex", "sessions"));
    if (files.length !== 1) return undefined;
    return codexSessionSignal(readFileSync(files[0]!, "utf8"), thread);
  } catch {
    return undefined;
  }
}

/** Attestations expire for adapter use after one hour (CliProvider's own check). */
const ATTESTATION_REFRESH_MS = 20 * 60 * 1000;
const ROUTE_CAPABILITY_LIFETIME_MS = 2 * 60 * 60 * 1000;

type StoredAttestation = CapabilityAttestation & {
  effort: string;
  /** The probed executable's digest (issue #12, contract 5.1); absent on older records. */
  executableDigest?: string;
};
function attestationPath(config: LiveConfig) {
  return join(config.stateDir, "attestations.json");
}
export function readAttestations(config: LiveConfig): StoredAttestation[] {
  try {
    return JSON.parse(
      readFileSync(attestationPath(config), "utf8"),
    ) as StoredAttestation[];
  } catch {
    return [];
  }
}
function currentAttestation(
  config: LiveConfig,
  provider: "codex" | "claude",
  model: string,
  effort: string,
  maxAgeMs = 3_600_000,
  cliVersion?: string,
) {
  return readAttestations(config)
    .filter(
      (a) =>
        a.provider === provider &&
        a.model === model &&
        a.effort === effort &&
        (cliVersion === undefined || a.cliVersion === cliVersion) &&
        Date.now() - Date.parse(a.verifiedAt) < maxAgeMs &&
        evidenceRefValid(a.evidenceRef),
    )
    .sort((a, b) => Date.parse(b.verifiedAt) - Date.parse(a.verifiedAt))[0];
}

export function liveProvider(
  config: LiveConfig,
  provider: "codex" | "claude",
  workspaceRoot: string,
  runner: BubblewrapRunner,
): CliProvider {
  const settings = config.providers[provider];
  if (!settings) throw new Error("LIVE_PROVIDER_NOT_CONFIGURED:" + provider);
  const options = {
    enabled: true,
    executable: settings.executable,
    allowedCwdRoot: workspaceRoot,
    credentialMode: "runner-brokered" as const,
    // Read at each run, so a route attested during the advance counts.
    capabilities: () => readAttestations(config),
    bwrapExecutable: config.bwrapExecutable,
    writableWorkspace: true,
    writePaths: "controller" as const,
    sanitizedPublicBrief: config.sanitizedPublicBrief,
    subscriptionAuth: true,
    budgetEnforcement: "controller-post-hoc" as const,
    costAccounting: "subscription" as const,
    runner,
  };
  return provider === "codex"
    ? new CodexCliProvider(options)
    : new ClaudeCliProvider(options);
}

/**
 * Run one trivial request through the full isolated path and record the
 * capability only when the harness proves the exact model and effort ran.
 */
/**
 * What the attestation probe asks. Plain and small: it must only prove that
 * the exact model answers through the sandbox. Fable 5.1's safety system
 * declines both this and a terse "reply with exactly: OK" inside the sandbox
 *, so the wording is not what it objects to.
 */
export const CAPABILITY_PROBE_BRIEF =
  "Connectivity check for a local tool. No task follows. Please reply with one short sentence confirming that you can read this.";
export async function attest(
  config: LiveConfig,
  provider: "codex" | "claude",
  model: string,
  effort: string,
  workspaceRoot: string,
  brief = CAPABILITY_PROBE_BRIEF,
  /** The controller's last check before the probe is spawned (ProbeGate.launch). */
  launchGate?: () => string | undefined,
): Promise<{
  attested: boolean;
  receipt: ProviderReceipt;
  attestation?: StoredAttestation;
}> {
  const runner = new BubblewrapRunner(config);
  const adapter = liveProvider(config, provider, workspaceRoot, runner);
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const cwd = join(realpathSync(workspaceRoot), "attest-" + randomUUID());
  mkdirSync(cwd, { mode: 0o700 });
  try {
    const receipt = await adapter.probeCapability({
      runId: "attest-" + randomUUID(),
      taskId: "CAPABILITY-PROBE",
      provider,
      model,
      effort,
      role: "reviewer",
      cwd,
      brief,
      deadlineMs: 300_000,
      ...(launchGate ? { launchGate } : {}),
    });
    if (
      receipt.status !== "SUCCEEDED" ||
      !receipt.identityVerified ||
      !receipt.provenance
    )
      return { attested: false, receipt };
    const probe = await probeCli(
      provider,
      config.providers[provider]!.executable,
    );
    const verifiedAt = new Date().toISOString();
    const evidenceRef = writeEvidence(
      config.stateDir,
      "attestation-" + receipt.runId,
      {
        kind: "CAPABILITY_ATTESTATION",
        provider,
        model,
        effort,
        cliVersion: probe.version,
        verifiedAt,
        receiptRunId: receipt.runId,
        sessionId: receipt.sessionId,
        provenance: receipt.provenance,
      },
    );
    const attestation: StoredAttestation = {
      provider,
      cliVersion: probe.version!,
      model,
      efforts: [effort],
      effort,
      verifiedAt,
      authenticated: true,
      evidenceRef,
      ...(receipt.provenance?.executableDigest
        ? { executableDigest: receipt.provenance.executableDigest }
        : {}),
    };
    // Read-modify-write under a kernel lock so concurrent refreshes never drop
    // each other's attestations.
    const release = await kernelLock(
      join(config.stateDir, "attestations.lock"),
      {
        deadlineMs: 30_000,
      },
    );
    try {
      const all = [...readAttestations(config), attestation].filter(
        (a) => Date.now() - Date.parse(a.verifiedAt) < 24 * 3_600_000,
      );
      const temporary = attestationPath(config) + "." + randomUUID();
      writeFileSync(temporary, JSON.stringify(all, null, 2) + "\n", {
        mode: 0o600,
      });
      renameSync(temporary, attestationPath(config));
    } finally {
      await release();
    }
    return { attested: true, receipt, attestation };
  } finally {
    // The probe workspace is kept with the run's other artifacts.
  }
}

/**
 * The controller's say over an attestation probe while a provider is paused
 * for its usage limit (Controller.probeGate): a paused provider is not
 * probed; a rechecked one is probed only by the holder of its recheck token;
 * and the probe's receipt records a limit, or clears the pause.
 */
export interface ProbeGate {
  before(
    provider: "codex" | "claude",
  ): { go: true; probeId?: string } | { go: false; reason: string };
  after(
    provider: "codex" | "claude",
    probeId: string | undefined,
    receipt: ProviderReceipt | undefined,
  ): void;
  /**
   * The last check just before the probe process is spawned, after every
   * wait: a reason not to launch it (the provider paused meanwhile, or the
   * probe no longer holds the recheck token), or undefined.
   */
  launch(provider: "codex" | "claude", probeId: string | undefined): string | undefined;
}
/** One attestation probe under the gate. */
async function gatedAttest(
  config: LiveConfig,
  route: { provider: "codex" | "claude"; model: string; effort: string },
  workspaceRoot: string,
  gate: ProbeGate | undefined,
): Promise<{ attested: boolean; reason?: string }> {
  const allowed = gate?.before(route.provider);
  if (allowed && !allowed.go) return { attested: false, reason: allowed.reason };
  let outcome: Awaited<ReturnType<typeof attest>> | undefined;
  try {
    outcome = await attest(
      config,
      route.provider,
      route.model,
      route.effort,
      workspaceRoot,
      undefined,
      gate ? () => gate.launch(route.provider, allowed?.probeId) : undefined,
    );
  } finally {
    gate?.after(route.provider, allowed?.probeId, outcome?.receipt);
  }
  return outcome.attested
    ? { attested: true }
    : { attested: false, reason: outcome.receipt.output.slice(0, 500) };
}
/**
 * One probe per provider whose pause has run out (or, for the operator, one
 * that is held), before any task run tests it: a tiny call, no task attempt
 * . Success clears the pause.
 */
export async function recheckProviders(
  config: LiveConfig,
  workspaceRoot: string,
  gate: ProbeGate,
  providers: Array<"codex" | "claude">,
) {
  const policy = RoutingPolicySchema.parse(
    JSON.parse(readFileSync(config.routingPolicyPath, "utf8")),
  );
  const results: Array<{ provider: string; attested: boolean; reason?: string }> =
    [];
  for (const provider of providers) {
    const route = policy.routes.find(
      (r) =>
        r.enabled &&
        !r.simulation &&
        r.provider === provider &&
        !fableQuarantined(policy, r) &&
        config.providers[provider],
    );
    if (!route) continue;
    results.push({
      provider,
      ...(await gatedAttest(
        config,
        { provider, model: route.model, effort: route.effort },
        workspaceRoot,
        gate,
      )),
    });
  }
  return results;
}

/**
 * Under the adaptive workflow a Fable route is never attested, by any path:
 * preflight, the attest command, a provider recheck or a just-in-time
 * renewal (issue #12, contract section 13; DUR-07).
 */
export function fableQuarantined(
  policy: RoutingPolicy,
  route: RoutingPolicy["routes"][number],
) {
  return (
    policy.workflow === "CAPABILITY_BIDIRECTIONAL_V1" && isFableModel(route.model)
  );
}
/** Re-attest every enabled live route whose attestation is older than 20 minutes. */
export async function refreshAttestations(
  config: LiveConfig,
  workspaceRoot: string,
  needed: (route: RoutingPolicy["routes"][number]) => boolean = () => true,
  gate?: ProbeGate,
) {
  const policy = RoutingPolicySchema.parse(
    JSON.parse(readFileSync(config.routingPolicyPath, "utf8")),
  );
  const results: {
    provider: string;
    model: string;
    effort: string;
    attested: boolean;
    reason?: string;
  }[] = [];
  const seen = new Set<string>();
  // An auto-updated CLI invalidates attestations for its previous version.
  const versions: Partial<Record<"codex" | "claude", string | null>> = {};
  for (const provider of ["codex", "claude"] as const)
    if (config.providers[provider])
      versions[provider] = (
        await probeCli(provider, config.providers[provider]!.executable)
      ).version;
  for (const route of policy.routes) {
    if (
      route.simulation ||
      !route.enabled ||
      route.provider === "mock" ||
      fableQuarantined(policy, route) ||
      !needed(route)
    )
      continue;
    const key = `${route.provider}/${route.model}/${route.effort}`;
    if (seen.has(key) || !config.providers[route.provider]) continue;
    seen.add(key);
    if (
      currentAttestation(
        config,
        route.provider,
        route.model,
        route.effort,
        ATTESTATION_REFRESH_MS,
        versions[route.provider] ?? undefined,
      )
    )
      continue;
    const outcome = await gatedAttest(
      config,
      {
        provider: route.provider as "codex" | "claude",
        model: route.model,
        effort: route.effort,
      },
      workspaceRoot,
      gate,
    );
    results.push({
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      ...outcome,
    });
  }
  return results;
}

/** Live routes carry the current attestation as their routing capability. */
export function liveRoutingPolicyLoader(
  config: LiveConfig,
): () => RoutingPolicy {
  return () => {
    const policy = RoutingPolicySchema.parse(
      JSON.parse(readFileSync(config.routingPolicyPath, "utf8")),
    );
    return RoutingPolicySchema.parse({
      ...policy,
      routes: policy.routes.map((route) => {
        if (route.simulation || route.provider === "mock") return route;
        const { capability: _ignored, ...rest } = route;
        const found = currentAttestation(
          config,
          route.provider,
          route.model,
          route.effort,
        );
        if (!found) return rest;
        return {
          ...rest,
          capability: {
            provider: route.provider,
            model: route.model,
            effort: route.effort,
            verifiedAt: found.verifiedAt,
            expiresAt: new Date(
              Date.parse(found.verifiedAt) + ROUTE_CAPABILITY_LIFETIME_MS,
            ).toISOString(),
            evidenceRef: found.evidenceRef,
            // The toolchain that evidence must match (issue #12, contract 5.1).
            ...(found.cliVersion ? { cliVersion: found.cliVersion } : {}),
            ...(found.executableDigest
              ? { executableDigest: found.executableDigest }
              : {}),
          },
        };
      }),
    });
  };
}
export function liveCapabilityVerifier(config: LiveConfig) {
  return (capability: RoutingCapability) =>
    capability.provider !== "mock" &&
    readAttestations(config).some(
      (a) =>
        a.provider === capability.provider &&
        a.model === capability.model &&
        a.effort === capability.effort &&
        a.verifiedAt === capability.verifiedAt &&
        a.evidenceRef === capability.evidenceRef &&
        evidenceRefValid(a.evidenceRef),
    );
}

/** Operator-visible readiness without contacting a model. */
function codexCredentialKey(codexHome: string) {
  // One stable per-user namespace keyed by the credential source, not by a
  // runner's stateDir or the process's runtime directory, so every runner of
  // this code sharing a login takes the same kernel lock and sees the same
  // pending credential recoveries. Other applications do not share this lock;
  // use a dedicated credential home instead of sharing another app's login.
  const dir = join(homedir(), ".local", "state", "longform-locks");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return {
    dir,
    key: "codex-auth-" + sha256(realpathSync(codexHome)).slice(0, 24),
  };
}
/**
 * A refreshed Codex login that could not be written back is newer than its
 * source; launching from the stale source would lose it. Returns the kept copy
 * (a `.json` file or a kept run `.dir`) while one exists.
 */
export function codexRecoveryPending(config: LiveConfig): string | undefined {
  const codex = config.providers.codex;
  if (!codex) return undefined;
  const { dir, key } = codexCredentialKey(codex.codexHome);
  const found = readdirSync(dir).find((name) =>
    name.startsWith(key + ".recovery-"),
  );
  return found && join(dir, found);
}
export function liveDoctor(config: LiveConfig) {
  const providers = Object.fromEntries(
    (["claude", "codex"] as const).map((provider) => {
      const settings = config.providers[provider];
      if (!settings) return [provider, { configured: false }];
      const credential =
        provider === "claude"
          ? (settings as NonNullable<LiveConfig["providers"]["claude"]>)
              .oauthTokenFile
          : join(
              (settings as NonNullable<LiveConfig["providers"]["codex"]>)
                .codexHome,
              "auth.json",
            );
      let credentialPresent = false;
      try {
        const info = statSync(credential);
        credentialPresent =
          info.isFile() && info.size > 0 && (info.mode & 0o077) === 0;
      } catch {
        /* absent */
      }
      return [
        provider,
        {
          configured: true,
          executable: settings.executable,
          credentialFile: credential,
          credentialPresentWithOwnerOnlyMode: credentialPresent,
          ...(provider === "codex"
            ? {
                credentialRecoveryPending: codexRecoveryPending(config) ?? null,
              }
            : {}),
          allowedHosts: settings.allowedHosts,
          attestations: readAttestations(config)
            .filter((a) => a.provider === provider)
            .map(({ model, effort, verifiedAt }) => ({
              model,
              effort,
              verifiedAt,
            })),
        },
      ];
    }),
  );
  return {
    bwrap: existsSync(config.bwrapExecutable),
    node: existsSync(config.nodeExecutable),
    routingPolicyPath: config.routingPolicyPath,
    providers,
    driveGateway: config.drive
      ? {
          configured: true,
          ...("clientFile" in config.drive
            ? {
                clientFilePresent: existsSync(config.drive.clientFile),
                tokenFilePresent: existsSync(config.drive.tokenFile),
              }
            : {
                rcloneRemote: config.drive.rcloneRemote,
                rcloneExecutablePresent: existsSync(config.drive.rcloneExecutable),
              }),
          operations: "meta, read, list, search, update, create; no delete, trash, move or rename",
        }
      : { configured: false },
  };
}

export type LiveHost = "claude" | "codex" | "operator";

/** Which host CLI is invoking us; an explicit `--host` (from the bridge) wins. */
export function resolveHost(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LiveHost {
  const claude = env.CLAUDECODE === "1",
    codex = !!env.CODEX_THREAD_ID;
  const detected: LiveHost | undefined =
    claude && codex
      ? undefined
      : claude
        ? "claude"
        : codex
          ? "codex"
          : "operator";
  if (explicit !== undefined) {
    if (
      explicit !== "claude" &&
      explicit !== "codex" &&
      explicit !== "operator"
    )
      throw new Error("INVALID_HOST:" + explicit);
    // A label contradicting the running host is refused. This guards
    // cooperating hosts against mistakes; it is not an authentication boundary,
    // since both run as the same trusted UID.
    if (detected && detected !== "operator" && detected !== explicit)
      throw new Error(
        "HOST_CONFLICT:" + explicit + "_IN_" + detected + "_ENVIRONMENT",
      );
    return explicit;
  }
  if (!detected) throw new Error("HOST_AMBIGUOUS_PASS_--host");
  return detected;
}

/** Kernel start time distinguishes a live owner from a reused PID. */
function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" ? null : (fields[19] ?? null);
  } catch {
    return null;
  }
}

/**
 * Live runs from different host CLIs never overlap: they share the owner's
 * subscriptions and the Codex login. Same-host concurrency is left to the
 * controller. Register first, then scan, so a simultaneous start by both hosts
 * makes both refuse rather than both run.
 */
export function acquireLiveHostLock(config: LiveConfig, host: LiveHost) {
  const dir = join(config.stateDir, "active");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const own = join(dir, `${host}-${process.pid}.json`);
  writeFileSync(
    own,
    JSON.stringify({
      host,
      pid: process.pid,
      start: processStart(process.pid),
      at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const release = () => rmSync(own, { force: true });
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path === own) continue;
    let other: { host?: string; pid?: number; start?: string | null };
    try {
      other = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const alive =
      typeof other.pid === "number" &&
      other.start !== undefined &&
      processStart(other.pid) === other.start;
    if (!alive) {
      rmSync(path, { force: true });
      continue;
    }
    // Only Claude Code and Codex exclude each other; the owner's terminal is neutral.
    if (
      other.host !== host &&
      other.host !== "operator" &&
      host !== "operator"
    ) {
      release();
      throw new Error(
        `OTHER_HOST_LIVE_PROCESS_ACTIVE:${other.host}:pid=${other.pid}`,
      );
    }
  }
  return release;
}
