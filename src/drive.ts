import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { DrivePolicy } from "./domain.js";

/**
 * Host-side Google Drive gateway for live workers. The OAuth token never
 * enters the sandbox: a worker reaches Drive only through this Unix socket,
 * which offers read, list, search, content update and create. There is no
 * delete, trash, move, rename or sharing operation, and every call is logged
 * with the exact bytes read, replaced and uploaded.
 */

export const DRIVE_CHANGES_DIR = "drive-changes";
export const DRIVE_SOCKET_IN_SANDBOX = "/run/longform/drive.sock";
export const DRIVE_CLIENT_IN_SANDBOX = "/run/longform-shim/longform-drive";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A source pack's whole size; the workspace is hashed after every run. */
export const MAX_PACK_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const FIELDS =
  "id,name,mimeType,parents,modifiedTime,version,trashed,size,md5Checksum,headRevisionId,webViewLink";
const FOLDER = "application/vnd.google-apps.folder";
const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";
const EXPORTS: Record<string, { type: string; ext: string }> = {
  [DOC]: { type: "text/markdown", ext: ".md" },
  [SHEET]: { type: "text/csv", ext: ".csv" },
  [SLIDES]: { type: "text/plain", ext: ".txt" },
};
// Native files accept content replacement only through an import type.
const IMPORTS: Record<string, string> = {
  [DOC]: "text/markdown; charset=UTF-8",
  [SHEET]: "text/csv; charset=UTF-8",
};
const UPLOAD_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
};

export type DriveCredentials =
  | {
      /** OAuth Desktop client JSON downloaded from Google Cloud console. */
      clientFile: string;
      /** Refresh token written by `bin/drive-login.mjs`. */
      tokenFile: string;
    }
  | {
      /** An existing rclone Drive remote; rclone refreshes its own token. */
      rcloneRemote: string;
      rcloneExecutable: string;
    };
type Token = { value: string; expiresAt: number };
type Meta = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  version?: string;
  trashed?: boolean;
  size?: string;
  md5Checksum?: string;
  headRevisionId?: string;
  webViewLink?: string;
};
export type DriveLogEntry = {
  at: string;
  /** Operation start is not its observation or write time. */
  completedAt?: string;
  writeStartedAt?: string;
  writeAcknowledgedAt?: string;
  /** Durable custody intent created before this call was sent. */
  intentId?: string;
  op: string;
  ok: boolean;
  fileId?: string;
  name?: string;
  versionBefore?: string;
  versionAfter?: string;
  sha256?: string;
  record?: string;
  /** The content was replaced, even if the entry reports an error. */
  written?: boolean;
  error?: string;
  /** Drive's metadata response (after the change, for update and create). */
  meta?: LoggedMeta;
  metaBefore?: LoggedMeta;
  /** Number of files a list or search returned. */
  results?: number;
  /**
   * The IDs a list or search returned (issue #12, contract section 10.1): a
   * run that saw another file's name or details has that file's writer as a
   * source. Additive; older records lack it.
   */
  returned?: string[];
  /** Downloads a change during the download made stale, kept in the record. */
  superseded?: { version?: string; sha256: string; record: string }[];
  /** A download kept in the record whose version check then failed. */
  unverified?: { version?: string; sha256: string; record: string };
};
/**
 * A run's Drive writes for its evidence: every update or create that replaced
 * or made content, including one that then reported an error (such as
 * CONCURRENT_EDIT), which keeps that error. Refused calls changed nothing.
 */
export function driveWriteSummary(log: DriveLogEntry[]) {
  const wrote = (e: DriveLogEntry) =>
    (e.ok || !!e.written) && (e.op === "update" || e.op === "create");
  return {
    writes: log.filter(wrote).map((e) => ({
      op: e.op,
      fileId: e.fileId,
      name: e.name,
      versionBefore: e.versionBefore,
      versionAfter: e.versionAfter,
      sha256: e.sha256,
      ...(e.ok ? {} : { error: e.error }),
    })),
    refused: log.filter((e) => !e.ok && !e.written).length,
  };
}
/** One file of a run's source pack, as MANIFEST.json lists it. */
export type PackManifestEntry = {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  /** Docs as Markdown, Sheets as CSV, Slides as text; stored bytes otherwise. */
  exportedAs: string;
  bytes: number;
  sha256: string;
  fetchedAt: string;
  /** File name inside the pack folder. */
  path: string;
};
type LoggedMeta = Pick<
  Meta,
  "id" | "name" | "mimeType" | "parents" | "modifiedTime" | "version" | "trashed"
>;
const logged = (m: Meta): LoggedMeta => ({
  id: m.id,
  name: m.name,
  mimeType: m.mimeType,
  parents: m.parents,
  modifiedTime: m.modifiedTime,
  version: m.version,
  trashed: m.trashed,
});
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** The Drive API transport; tests substitute a fake. */
export type DriveFetch = Fetch;

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const isText = (type: string) =>
  type.startsWith("text/") || /json|xml|markdown|csv/.test(type);
const safeName = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_");

const run = (file: string, args: string[], signal?: AbortSignal) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { maxBuffer: 1 << 20, timeout: 120_000, ...(signal ? { signal } : {}) }, (error, stdout) =>
      error ? reject(new Error("RCLONE_FAILED: " + error.message.split("\n")[0])) : resolve(stdout),
    ),
  );
/** A wait that ends early, with an error, when `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
/** rclone (golang oauth2) refreshes only within 10 s of expiry, so wait that out. */
async function rcloneToken(remote: string, executable: string, signal?: AbortSignal): Promise<Token> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await run(executable, ["about", remote + ":", "--json"], signal);
    const dump = JSON.parse(await run(executable, ["config", "dump"], signal));
    const token = JSON.parse(dump?.[remote]?.token ?? "null");
    if (!token?.access_token) throw new Error("RCLONE_TOKEN_MISSING");
    const expiresAt = Date.parse(token.expiry);
    if (expiresAt - Date.now() > 15_000) return { value: token.access_token, expiresAt };
    await sleep(6_000, signal);
  }
  throw new Error("RCLONE_TOKEN_NOT_REFRESHED");
}
export async function driveAccessToken(
  credentials: DriveCredentials,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<Token> {
  if ("rcloneRemote" in credentials)
    return rcloneToken(credentials.rcloneRemote, credentials.rcloneExecutable, signal);
  const client = JSON.parse(readFileSync(credentials.clientFile, "utf8"));
  const key = client.installed ?? client.web;
  const token = JSON.parse(readFileSync(credentials.tokenFile, "utf8"));
  if (!key?.client_id || !token?.refresh_token)
    throw new Error("DRIVE_CREDENTIALS_INCOMPLETE");
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    ...(signal ? { signal } : {}),
    method: "POST",
    body: new URLSearchParams({
      client_id: key.client_id,
      client_secret: key.client_secret ?? "",
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok)
    throw new Error("DRIVE_TOKEN_REFRESH_FAILED:" + response.status);
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("DRIVE_TOKEN_REFRESH_FAILED");
  return { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
}

/**
 * Write one file of a host record into a workspace. Each file is written to a
 * fresh file and renamed into place, so a hard link or symlink the worker
 * planted at the destination keeps its own bytes and never receives these
 * (review r1 finding R1); then it is read back.
 */
function writeRecordFile(workspace: string, parts: string[], bytes: Buffer) {
  let dir = workspace;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!lstatSync(dir).isDirectory())
      throw new Error("DRIVE_CHANGES_PATH_NOT_A_DIRECTORY:" + dir);
  }
  const target = join(dir, parts.at(-1)!);
  const temp = join(dir, `.longform-copy-${randomUUID()}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (!readFileSync(target).equals(bytes))
    throw new Error("DRIVE_CHANGES_READBACK_MISMATCH:" + target);
}
/** A record folder's files, as paths relative to it; never followed through a link. */
function recordFiles(root: string, at: string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, ...at), { withFileTypes: true })) {
    const parts = [...at, entry.name];
    if (entry.isDirectory()) out.push(...recordFiles(root, parts));
    else if (entry.isFile()) out.push(parts.join("/"));
    else throw new Error("DRIVE_RECORD_NOT_A_FILE:" + parts.join("/"));
  }
  return out;
}
/**
 * After a worker run, put every run's Drive record in its workspace back to
 * the host's copy (review r2 finding R6): a reply or rework carries earlier
 * runs' records, and a worker could otherwise change an earlier run's pack
 * or log for its reviewer. A record folder with no host record, or a file the
 * host record does not have, fails the run; nothing is deleted.
 */
export function restoreDriveRecords(
  workspace: string,
  auditRoot: string,
  /**
   * The run IDs whose records the workspace may hold: those it held when the
   * run started (copied from sealed work by the controller) and the run's own.
   * A folder the worker named itself is never filled from the host (review
   * r3 R7: it could import another run's record).
   */
  allowed: ReadonlySet<string>,
): { restored: string[]; error?: string } {
  const restored: string[] = [];
  const records = join(workspace, DRIVE_CHANGES_DIR);
  try {
    if (existsSync(records)) {
      if (!lstatSync(records).isDirectory())
        throw new Error("DRIVE_CHANGES_PATH_NOT_A_DIRECTORY:" + records);
      for (const entry of readdirSync(records, { withFileTypes: true })) {
        if (!entry.isDirectory() || !allowed.has(entry.name))
          throw new Error("DRIVE_RECORD_UNKNOWN:" + entry.name);
        const host = join(auditRoot, entry.name);
        if (!existsSync(host)) throw new Error("DRIVE_RECORD_UNKNOWN:" + entry.name);
        const hostFiles = new Set(recordFiles(host));
        for (const file of recordFiles(join(records, entry.name)))
          if (!hostFiles.has(file))
            throw new Error("DRIVE_RECORD_ALTERED:" + entry.name + "/" + file);
      }
    }
    // Every allowed record the host has is written back, including one the
    // worker removed.
    for (const id of [...allowed].sort()) {
      const host = join(auditRoot, id);
      if (!existsSync(host)) continue;
      for (const file of recordFiles(host))
        writeRecordFile(
          workspace,
          [DRIVE_CHANGES_DIR, id, ...file.split("/")],
          readFileSync(join(host, file)),
        );
      restored.push(id);
    }
    return { restored };
  } catch (error) {
    return { restored, error: String(error) };
  }
}
/** The record folders a workspace holds, by run ID (none when it has no record folder). */
export function recordFolders(workspace: string): string[] {
  const records = join(workspace, DRIVE_CHANGES_DIR);
  if (!existsSync(records) || !lstatSync(records).isDirectory()) return [];
  return readdirSync(records, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
/**
 * Whether a sealed copy of a run's Drive record holds exactly the host's
 * files and bytes; the first difference, else undefined.
 */
export function recordDifference(host: string, copy: string): string | undefined {
  if (!existsSync(copy)) return "missing";
  const hostFiles = recordFiles(host),
    copyFiles = recordFiles(copy);
  for (const file of copyFiles)
    if (!hostFiles.includes(file)) return "extra " + file;
  for (const file of hostFiles)
    if (!existsSync(join(copy, file)) || !readFileSync(join(host, file)).equals(readFileSync(join(copy, file))))
      return "changed " + file;
  return undefined;
}

class GatewayError extends Error {}
/**
 * A Drive write whose outcome is unknown: it may have been processed (a
 * server error, a timeout, a lost response). It is never sent again.
 */
class AmbiguousWrite extends GatewayError {}
/**
 * The controller's hooks around each Drive write (S4): `begin` before the
 * request is sent (throws, and nothing is sent, when the operation lacks
 * custody of the target or another holds it); `end` with the outcome, which
 * for an applied create makes the new file the operation's claim before the
 * result is returned.
 */
export interface DriveWriteHooks {
  begin(
    write: { kind: "update"; fileId: string } | { kind: "create"; folderId: string },
    staged?: { sha256: string; record: string },
  ): string;
  end(
    intentId: string,
    outcome:
      | { applied: true; fileId: string }
      | { applied: false }
      | { ambiguous: true; error: string },
  ): void;
}

export class DriveGateway {
  readonly log: DriveLogEntry[] = [];
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private token?: Token;
  /** Version each file had when this run last read or wrote it. */
  private readonly seen = new Map<string, string>();
  private readonly created = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private counter = 0;
  private finalized = false;
  /**
   * Set after a write whose outcome is unknown, or whose outcome could not
   * be recorded: every later write is refused, reads continue.
   */
  private uncertain?: string;
  /**
   * Set only while the host prepares the run (login, source pack), before the
   * socket listens: cancelling the run stops that work. A worker's own calls
   * are never cut off midway, so their log stays true.
   */
  private preparing?: AbortSignal;
  constructor(
    private readonly options: {
      credentials: DriveCredentials;
      policy: DrivePolicy;
      /** Real path of the worker's workspace. */
      workspace: string;
      /** Host-only record directory; the authoritative copy of everything logged. */
      auditDir: string;
      runId: string;
      fetcher?: Fetch;
      /** Largest source pack in bytes; default MAX_PACK_BYTES. */
      maxPackBytes?: number;
      /** The controller's write-intent hooks (S4); absent, writes are not bracketed. */
      writes?: DriveWriteHooks;
    },
  ) {
    for (const sub of ["reads", "before", "after", "uploaded"])
      mkdirSync(join(options.auditDir, sub), { recursive: true, mode: 0o700 });
  }
  /** Mint the first token before launch, so a broken login fails the run early. */
  async prepare(signal?: AbortSignal) {
    this.preparing = signal;
    try {
      await this.accessToken();
    } finally {
      this.preparing = undefined;
    }
  }
  /**
   * Before launch, read the task's source pack on the worker's behalf: each
   * file is checked against the read scope, logged as a "pack" entry, kept in
   * the host record under pack/ with a MANIFEST.json, and copied into the
   * workspace at drive-changes/<runId>/pack/. A pack file counts as read in
   * this run at the version fetched, so an update in scope needs no second
   * read. finalize() later rewrites the copy from the host record. Any failure
   * throws, and the run must not start.
   */
  async preparePack(signal?: AbortSignal): Promise<PackManifestEntry[]> {
    const ids = this.options.policy.pack ?? [];
    if (!ids.length) return [];
    this.preparing = signal;
    try {
      return await this.fetchPack(ids);
    } finally {
      this.preparing = undefined;
    }
  }
  private async fetchPack(ids: string[]): Promise<PackManifestEntry[]> {
    const dir = join(this.options.auditDir, "pack");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest: PackManifestEntry[] = [];
    let total = 0;
    for (const rawId of ids) {
      this.preparing?.throwIfAborted();
      const entry: DriveLogEntry = { at: new Date().toISOString(), op: "pack", ok: false };
      try {
        const first = await this.meta(rawId, entry);
        entry.ok = false;
        // Each download is kept under pack-downloads/; the one that holds
        // is also the pack's file.
        const { meta, current } = await this.stableContent(first, "pack-downloads", entry);
        // Every byte read is kept in the host record, even past the limit.
        const file = meta.id + current.ext;
        const fd = openSync(
          join(dir, file),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        try {
          writeSync(fd, current.bytes);
        } finally {
          closeSync(fd);
        }
        entry.versionBefore = meta.version;
        entry.sha256 = sha256(current.bytes);
        entry.record = "pack/" + file;
        total += current.bytes.length;
        const limit = this.options.maxPackBytes ?? MAX_PACK_BYTES;
        if (total > limit)
          throw new GatewayError(
            `PACK_TOO_LARGE: the pack passes ${limit} bytes at ${meta.id}`,
          );
        if (meta.version) this.seen.set(meta.id, meta.version);
        entry.ok = true;
        manifest.push({
          id: meta.id,
          name: meta.name,
          mimeType: meta.mimeType,
          ...(meta.version ? { version: meta.version } : {}),
          ...(meta.modifiedTime ? { modifiedTime: meta.modifiedTime } : {}),
          ...(meta.md5Checksum ? { md5Checksum: meta.md5Checksum } : {}),
          exportedAs: current.type,
          bytes: current.bytes.length,
          sha256: entry.sha256,
          fetchedAt: entry.at,
          path: file,
        });
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.record(entry);
      }
    }
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    // Nothing reaches the workspace once the run is cancelled. The copy below
    // has no await, so a cancellation cannot land halfway through it.
    this.preparing?.throwIfAborted();
    const target = [DRIVE_CHANGES_DIR, safeName(this.options.runId), "pack"];
    for (const name of readdirSync(dir))
      this.writeWorkspace([...target, name], readFileSync(join(dir, name)));
    return manifest;
  }
  listen(socketPath: string): Promise<void> {
    this.server = createServer((client) => this.handle(client));
    return new Promise((done, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => done());
    });
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) =>
      this.server ? this.server.close(() => done()) : done(),
    );
    await this.queue.catch(() => {});
  }
  /**
   * After the worker has exited, copy the host record into the workspace so
   * reviewers see it. Anything the worker put in that folder is overwritten
   * from the host copy; a symlink anywhere on the path stops the copy.
   */
  finalize(): { copied: boolean; error?: string; target: string } {
    const target = join(DRIVE_CHANGES_DIR, safeName(this.options.runId));
    if (this.finalized) return { copied: true, target };
    this.finalized = true;
    try {
      const copy = (from: string, to: string[]) => {
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          const parts = [...to, entry.name];
          if (entry.isDirectory()) copy(join(from, entry.name), parts);
          else if (entry.isFile())
            this.writeWorkspace(parts, readFileSync(join(from, entry.name)));
        }
      };
      copy(this.options.auditDir, [DRIVE_CHANGES_DIR, safeName(this.options.runId)]);
      return { copied: true, target };
    } catch (error) {
      return { copied: false, error: String(error), target };
    }
  }
  private writeWorkspace(parts: string[], bytes: Buffer) {
    writeRecordFile(this.options.workspace, parts, bytes);
  }
  private handle(client: Socket) {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => client.destroy());
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_REQUEST_BYTES) {
        client.off("data", onData);
        client.end(JSON.stringify({ ok: false, error: "REQUEST_TOO_LARGE" }) + "\n");
        return;
      }
      const end = data.indexOf("\n");
      if (end < 0) return;
      client.off("data", onData);
      let request: { op?: unknown; args?: unknown };
      try {
        request = JSON.parse(data.subarray(0, end).toString("utf8"));
      } catch {
        client.end(JSON.stringify({ ok: false, error: "MALFORMED_REQUEST" }) + "\n");
        return;
      }
      // One operation at a time keeps the log and version checks in order.
      const run = this.queue.then(() => this.dispatch(request));
      this.queue = run.catch(() => {});
      run.then(
        (result) => client.end(JSON.stringify({ ok: true, result }) + "\n"),
        (error) =>
          client.end(
            JSON.stringify({
              ok: false,
              error: error instanceof GatewayError ? error.message : "DRIVE_GATEWAY_ERROR: " + String(error),
            }) + "\n",
          ),
      );
    };
    client.on("data", onData);
  }
  /**
   * One call made by the host itself (filing by a tool), with the same checks and record as a worker's call.
   */
  operate(op: "meta" | "read" | "update" | "create", args: string[]) {
    return this.dispatch({ op, args });
  }
  private async dispatch(request: { op?: unknown; args?: unknown }) {
    const op = typeof request.op === "string" ? request.op : "";
    const args = Array.isArray(request.args)
      ? request.args.map((a) => (typeof a === "string" ? a : ""))
      : [];
    const entry: DriveLogEntry = { at: new Date().toISOString(), op, ok: false };
    try {
      switch (op) {
        case "meta":
          return await this.meta(args[0]!, entry);
        case "read":
          return await this.read(args[0]!, entry);
        case "list":
          return await this.list(args[0]!, entry);
        case "search":
          return await this.search(args[0]!, entry);
        case "update":
          return await this.update(args[0]!, args[1]!, entry);
        case "create":
          return await this.create(args[0]!, args[1]!, args[2]!, args[3] === "doc", entry);
        default:
          throw new GatewayError(
            "UNSUPPORTED_OPERATION: only meta, read, list, search, update and create exist; nothing can be deleted, trashed, moved or renamed",
          );
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.record(entry);
    }
  }
  private record(entry: DriveLogEntry) {
    entry.completedAt = new Date().toISOString();
    this.log.push(entry);
    appendFileSync(join(this.options.auditDir, "log.jsonl"), JSON.stringify(entry) + "\n", {
      mode: 0o600,
    });
  }
  private id(value: string | undefined) {
    if (!value || !/^[A-Za-z0-9_-]{10,128}$/.test(value))
      throw new GatewayError("INVALID_DRIVE_ID");
    return value;
  }
  private readable(meta: Meta) {
    const { read, update } = this.options.policy;
    return (
      read === "ANY" ||
      read.includes(meta.id) ||
      (meta.parents ?? []).some((p) => read.includes(p)) ||
      update.includes(meta.id) ||
      this.created.has(meta.id)
    );
  }
  private async accessToken() {
    if (!this.token || this.token.expiresAt - Date.now() < 15_000)
      this.token = await driveAccessToken(
        this.options.credentials,
        this.options.fetcher,
        this.preparing,
      );
    return this.token.value;
  }
  private async api(
    path: string,
    init: { method?: string; query?: Record<string, string>; body?: Uint8Array; type?: string; upload?: boolean } = {},
  ): Promise<{ bytes: Buffer; type: string }> {
    const url = new URL(
      `https://www.googleapis.com${init.upload ? "/upload" : ""}/drive/v3${path}`,
    );
    for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...init.query }))
      url.searchParams.set(k, v);
    const fetcher = this.options.fetcher ?? fetch;
    const signal = this.preparing;
    // A write is sent again only when Drive says it was not processed (rate
    // limiting). A server error, a timeout or a lost response may mean it
    // was, so it is reported as ambiguous and never replayed (S4, D13).
    const mutation = (init.method ?? "GET") !== "GET";
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const token = await this.accessToken();
      let response: Response, bytes: Buffer;
      try {
        response = await fetcher(url.toString(), {
          ...(signal ? { signal } : {}),
          method: init.method ?? "GET",
          headers: {
            authorization: "Bearer " + token,
            ...(init.type ? { "content-type": init.type } : {}),
          },
          body: init.body as unknown as BodyInit | undefined,
        });
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (mutation)
          throw new AmbiguousWrite(
            "DRIVE_WRITE_AMBIGUOUS: " + String(error).slice(0, 300),
          );
        throw error;
      }
      if (response.ok)
        return { bytes, type: response.headers.get("content-type") ?? "" };
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(bytes.toString()));
      const failure = `DRIVE_HTTP_${response.status}: ${bytes.toString("utf8").slice(0, 300)}`;
      if (mutation && !rateLimited) {
        if (response.status >= 500 || response.status === 408)
          throw new AmbiguousWrite("DRIVE_WRITE_AMBIGUOUS: " + failure);
        throw new GatewayError(failure);
      }
      const retry = rateLimited || response.status >= 500;
      if (!retry || attempt >= 7) throw new GatewayError(failure);
      await sleep(Math.min(60_000, 2_000 * 2 ** attempt), signal);
    }
  }
  /**
   * Send one Drive write under the controller's write intent: refused before
   * it is sent when the operation lacks custody or a required source changed;
   * after it, its outcome recorded. An ambiguous outcome, or one that could
   * not be recorded, stops every later write in this run or filing.
   */
  private async guardedWrite<T>(
    write: { kind: "update"; fileId: string } | { kind: "create"; folderId: string },
    send: () => Promise<T>,
    fileIdOf: (result: T) => string,
    entry?: DriveLogEntry,
  ): Promise<T> {
    if (this.uncertain)
      throw new GatewayError("DRIVE_CUSTODY_UNCERTAIN: " + this.uncertain);
    await this.checkRequiredSources();
    const hooks = this.options.writes;
    let intent: string | undefined;
    try {
      intent = hooks?.begin(write, entry?.sha256 && entry.record
        ? { sha256: entry.sha256, record: entry.record } : undefined);
      if (entry && intent) entry.intentId = intent;
    } catch (error) {
      throw new GatewayError(error instanceof Error ? error.message : String(error));
    }
    const finish = (
      outcome: Parameters<DriveWriteHooks["end"]>[1],
      latch?: string,
    ) => {
      if (latch) this.uncertain = latch;
      if (hooks && intent)
        try {
          hooks.end(intent, outcome);
        } catch (error) {
          this.uncertain =
            "the outcome of a write could not be recorded: " +
            (error instanceof Error ? error.message : String(error));
        }
    };
    let result: T;
    try {
      if (entry) entry.writeStartedAt = new Date().toISOString();
      result = await send();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AmbiguousWrite)
        finish({ ambiguous: true, error: message }, message);
      else finish({ applied: false });
      throw error;
    }
    let fileId: string;
    try {
      fileId = fileIdOf(result);
    } catch (error) {
      const message = "DRIVE_WRITE_AMBIGUOUS: applied, but its file ID could not be read";
      finish({ ambiguous: true, error: message }, message);
      throw new GatewayError(message);
    }
    if (entry) {
      entry.fileId = fileId;
      entry.written = true;
      entry.writeAcknowledgedAt = new Date().toISOString();
    }
    finish({ applied: true, fileId });
    if (this.uncertain)
      throw new GatewayError(
        "DRIVE_CUSTODY_UNCERTAIN: the write was applied, but " + this.uncertain,
      );
    return result;
  }
  /**
   * Governing sources the task declares must be current at publication
   * (`requireLatest`): before every write each must have been read in this
   * run, at the version Drive has now.
   */
  private async checkRequiredSources() {
    for (const id of this.options.policy.requireLatest ?? []) {
      const read = this.seen.get(id);
      if (read === undefined)
        throw new GatewayError(
          `REQUIRED_SOURCE_NOT_READ: ${id} must be read in this run before any write`,
        );
      const now = (await this.getMeta(id)).version;
      if (now !== read)
        throw new GatewayError(
          `REQUIRED_SOURCE_CHANGED: ${id} is now version ${now}; version ${read} was read. Read it again and rework before writing`,
        );
    }
  }
  /** A file's revision IDs, oldest first. */
  private async revisionIds(id: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const { bytes } = await this.api(`/files/${id}/revisions`, {
        query: {
          fields: "nextPageToken,revisions(id)",
          pageSize: "1000",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const page = JSON.parse(bytes.toString("utf8"));
      ids.push(...(page.revisions ?? []).map((r: { id: string }) => r.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return ids;
  }
  private async getMeta(id: string): Promise<Meta> {
    const { bytes } = await this.api(`/files/${id}`, { query: { fields: FIELDS } });
    return JSON.parse(bytes.toString("utf8"));
  }
  /** Current content: an export for native files, the stored bytes otherwise. */
  private async content(meta: Meta): Promise<{ bytes: Buffer; type: string; ext: string }> {
    const exported = EXPORTS[meta.mimeType];
    if (exported) {
      const { bytes } = await this.api(`/files/${meta.id}/export`, {
        query: { mimeType: exported.type },
      });
      return { bytes, type: exported.type, ext: exported.ext };
    }
    if (meta.mimeType.startsWith("application/vnd.google-apps."))
      throw new GatewayError("UNSUPPORTED_NATIVE_TYPE:" + meta.mimeType);
    if (Number(meta.size ?? 0) > MAX_FILE_BYTES) throw new GatewayError("FILE_TOO_LARGE");
    const { bytes } = await this.api(`/files/${meta.id}`, { query: { alt: "media" } });
    return { bytes, type: meta.mimeType, ext: extname(meta.name) || ".bin" };
  }
  private save(dir: string, meta: Meta, bytes: Buffer, ext: string) {
    const name = `${meta.id}@v${meta.version ?? "unknown"}-${++this.counter}${ext}`;
    const fd = openSync(
      join(this.options.auditDir, dir, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    return `${dir}/${name}`;
  }
  private async meta(rawId: string, entry: DriveLogEntry) {
    const meta = await this.getMeta(this.id(rawId));
    entry.fileId = meta.id;
    entry.name = meta.name;
    entry.meta = logged(meta);
    if (!this.readable(meta)) throw new GatewayError("OUTSIDE_TASK_DRIVE_SCOPE");
    entry.ok = true;
    return meta;
  }
  /**
   * Content that belongs to the version it is attributed to (review r4 R9):
   * the metadata is read again after the download, and a change in between
   * downloads again, up to three times. Each download is saved in the host
   * record under `dir` before that check (review r5 R10), so bytes are never
   * lost: a download a change made stale is listed in `superseded`, and one
   * whose check then failed in `unverified`.
   */
  private async stableContent(first: Meta, dir: string, entry: DriveLogEntry) {
    let meta = first;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.content(meta);
      mkdirSync(join(this.options.auditDir, dir), { recursive: true, mode: 0o700 });
      const saved = {
        version: meta.version,
        sha256: sha256(current.bytes),
        record: this.save(dir, meta, current.bytes, current.ext),
      };
      let after: Meta;
      try {
        after = await this.getMeta(meta.id);
      } catch (error) {
        entry.unverified = saved;
        throw error;
      }
      if (
        after.version === meta.version &&
        after.headRevisionId === meta.headRevisionId
      )
        return { meta, current, record: saved.record };
      entry.superseded = [...(entry.superseded ?? []), saved];
      meta = after;
      entry.meta = logged(after);
      if (!this.readable(after)) throw new GatewayError("OUTSIDE_TASK_DRIVE_SCOPE");
    }
    throw new GatewayError(
      "SOURCE_CHANGING: " + meta.id + " changed during each of three downloads",
    );
  }
  private async read(rawId: string, entry: DriveLogEntry) {
    const first = await this.meta(rawId, entry);
    entry.ok = false;
    const { meta, current, record } = await this.stableContent(first, "reads", entry);
    entry.versionBefore = meta.version;
    entry.sha256 = sha256(current.bytes);
    entry.record = record;
    if (meta.version) this.seen.set(meta.id, meta.version);
    entry.ok = true;
    // Text in another encoding goes as base64, so the bytes stay exact (review K20).
    const text = isText(current.type) && isUtf8(current.bytes);
    return {
      meta,
      exportedAs: current.type,
      encoding: text ? "utf8" : "base64",
      content: current.bytes.toString(text ? "utf8" : "base64"),
    };
  }
  private async list(rawId: string, entry: DriveLogEntry) {
    const folder = this.id(rawId);
    entry.fileId = folder;
    const { read } = this.options.policy;
    if (read !== "ANY" && !read.includes(folder))
      throw new GatewayError("OUTSIDE_TASK_DRIVE_SCOPE");
    const files: Meta[] = [];
    let pageToken: string | undefined;
    do {
      const { bytes } = await this.api("/files", {
        query: {
          q: `'${folder}' in parents and trashed = false`,
          fields: `nextPageToken,files(${FIELDS})`,
          pageSize: "200",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      const page = JSON.parse(bytes.toString("utf8"));
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken && files.length < 2_000);
    entry.results = files.length;
    entry.returned = files.map((f) => f.id);
    entry.ok = true;
    return files;
  }
  private async search(text: string, entry: DriveLogEntry) {
    if (this.options.policy.read !== "ANY")
      throw new GatewayError("SEARCH_REQUIRES_READ_ANY");
    if (!text || text.length > 200) throw new GatewayError("INVALID_SEARCH_TEXT");
    entry.name = text;
    const quoted = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const { bytes } = await this.api("/files", {
      query: {
        q: `(name contains '${quoted}' or fullText contains '${quoted}') and trashed = false`,
        fields: `files(${FIELDS})`,
        pageSize: "100",
        includeItemsFromAllDrives: "true",
      },
    });
    const files = JSON.parse(bytes.toString("utf8")).files;
    entry.results = files.length;
    entry.returned = files.map((f: Meta) => f.id);
    entry.ok = true;
    return files;
  }
  /** Content of a regular file inside the workspace; never follows a link out. */
  private upload(path: string) {
    if (!path || !isAbsolute(path)) throw new GatewayError("UPLOAD_PATH_REQUIRED");
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new GatewayError("UPLOAD_FILE_NOT_FOUND");
    }
    const rel = relative(this.options.workspace, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === DRIVE_CHANGES_DIR)
      throw new GatewayError("UPLOAD_FILE_OUTSIDE_WORKSPACE");
    const info = lstatSync(real);
    if (!info.isFile()) throw new GatewayError("UPLOAD_NOT_A_FILE");
    if (info.size > MAX_FILE_BYTES) throw new GatewayError("FILE_TOO_LARGE");
    return { bytes: readFileSync(real), ext: extname(real) };
  }
  private async update(rawId: string, path: string, entry: DriveLogEntry) {
    const id = this.id(rawId);
    entry.fileId = id;
    if (!this.options.policy.update.includes(id) && !this.created.has(id))
      throw new GatewayError("UPDATE_OUTSIDE_TASK_DRIVE_SCOPE");
    const before = await this.getMeta(id);
    entry.name = before.name;
    entry.versionBefore = before.version;
    entry.metaBefore = logged(before);
    if (before.trashed) throw new GatewayError("FILE_IS_TRASHED");
    if (!this.seen.has(id)) throw new GatewayError("READ_BEFORE_UPDATE_REQUIRED");
    if (this.seen.get(id) !== before.version)
      throw new GatewayError(
        `CHANGED_SINCE_READ: version ${this.seen.get(id)} was read, Drive now has ${before.version}; read it again`,
      );
    const native = before.mimeType.startsWith("application/vnd.google-apps.");
    const type = native ? IMPORTS[before.mimeType] : before.mimeType;
    if (!type) throw new GatewayError("UNSUPPORTED_NATIVE_TYPE:" + before.mimeType);
    const file = this.upload(path);
    // The pre-image is taken immediately before the write; Drive also keeps the revision.
    const old = await this.content(before);
    // Drive's upload cannot be made conditional, so the version is checked
    // once more right before writing: an edit made while the pre-image was
    // fetched is refused, not overwritten.
    const latest = await this.getMeta(id);
    if (latest.version !== before.version || latest.headRevisionId !== before.headRevisionId)
      throw new GatewayError(
        `CHANGED_SINCE_READ: version ${before.version} was read, Drive now has ${latest.version}; read it again`,
      );
    this.save("before", before, old.bytes, old.ext);
    entry.sha256 = sha256(file.bytes);
    entry.record = this.save("uploaded", before, file.bytes, file.ext);
    const { bytes: written } = await this.guardedWrite(
      { kind: "update", fileId: id },
      () =>
        this.api(`/files/${id}`, {
          method: "PATCH",
          upload: true,
          type,
          body: file.bytes,
          query: {
            uploadType: "media",
            fields: FIELDS,
            ...(native ? {} : { keepRevisionForever: "true" }),
          },
        }),
      () => id,
      entry,
    );
    entry.written = true;
    const after = await this.getMeta(id);
    entry.versionAfter = after.version;
    entry.meta = logged(after);
    const now = await this.content(after);
    this.save("after", after, now.bytes, now.ext);
    if (
      after.trashed ||
      after.name !== before.name ||
      JSON.stringify(after.parents ?? []) !== JSON.stringify(before.parents ?? [])
    )
      throw new GatewayError("READBACK_MISMATCH: name, folder or trash state changed");
    // A stored file's revisions are discrete: the one before ours must be the
    // one checked above, or another edit reached Drive in the moment between.
    // (Native files merge revisions, so this cannot be told for them.)
    const ours = (JSON.parse(written.toString("utf8")) as Meta).headRevisionId;
    if (!native && before.headRevisionId && ours) {
      const ids = await this.revisionIds(id);
      const since = ids.slice(ids.indexOf(before.headRevisionId) + 1);
      if (!ids.includes(before.headRevisionId) || since.length !== 1 || since[0] !== ours)
        throw new GatewayError(
          `CONCURRENT_EDIT: the content was replaced, but another revision reached Drive around this write (${since.filter((r) => r !== ours).join(",") || "the checked revision is gone"}); it may have been overwritten and is in the file's revision history. Read the file again and reconcile before any further update`,
        );
    }
    if (after.version) this.seen.set(id, after.version);
    entry.ok = true;
    return { before, after, uploadedSha256: entry.sha256 };
  }
  private async create(rawFolder: string, name: string, path: string, asDoc: boolean, entry: DriveLogEntry) {
    const folderId = this.id(rawFolder);
    entry.name = name;
    if (!this.options.policy.createIn.includes(folderId))
      throw new GatewayError("CREATE_OUTSIDE_TASK_DRIVE_SCOPE");
    if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name))
      throw new GatewayError("INVALID_FILE_NAME");
    const folder = await this.getMeta(folderId);
    if (folder.mimeType !== FOLDER || folder.trashed)
      throw new GatewayError("CREATE_TARGET_NOT_A_LIVE_FOLDER");
    const file = this.upload(path);
    const media = asDoc ? "text/markdown" : (UPLOAD_TYPES[file.ext] ?? "application/octet-stream");
    const metadata = { name, parents: [folderId], ...(asDoc ? { mimeType: DOC } : {}) };
    const boundary = "longform" + sha256(String(Date.now()) + name).slice(0, 24);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\ncontent-type: ${media}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    entry.sha256 = sha256(file.bytes);
    // Keep the exact upload before dispatch, including a native create
    // whose ID is unknowable until its response arrives. Its durable
    // intent points to this immutable staging record if the host dies.
    entry.record = this.save("uploaded", { id: "pending-create-" + randomUUID(), name, mimeType: media }, file.bytes, file.ext);
    const { bytes } = await this.guardedWrite(
      { kind: "create", folderId },
      () =>
        this.api("/files", {
          method: "POST",
          upload: true,
          type: `multipart/related; boundary=${boundary}`,
          body,
          query: { uploadType: "multipart", fields: FIELDS },
        }),
      (result) => {
        const id = (JSON.parse(result.bytes.toString("utf8")) as Meta).id;
        if (typeof id !== "string" || !id) throw new Error("NO_FILE_ID");
        return id;
      },
      entry,
    );
    const created: Meta = JSON.parse(bytes.toString("utf8"));
    entry.fileId = created.id;
    // The file exists from here, whatever the follow-up steps report (review C1).
    entry.written = true;
    this.created.add(created.id);
    const after = await this.getMeta(created.id);
    entry.versionAfter = after.version;
    entry.meta = logged(after);
    const now = await this.content(after);
    this.save("after", after, now.bytes, now.ext);
    if (after.version) this.seen.set(after.id, after.version);
    entry.ok = true;
    return after;
  }
}

/** Runs inside the sandbox; talks only to the gateway socket. */
export const DRIVE_CLIENT = `import { connect } from "node:net";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
const usage = \`longform-drive: Google Drive through the orchestrator's gateway
  meta <fileId>                          file metadata
  read <fileId> [--out <path>]           current content (Docs as Markdown, Sheets as CSV)
  list <folderId>                        files in a folder
  search <text>                          find files by name or text (only when the task allows any read)
  update <fileId> <file>                 replace a file's content with a workspace file (read it first)
  create <folderId> <name> <file> [--doc]  new file from a workspace file; --doc makes a Google Doc from Markdown
Nothing can be deleted, trashed, moved or renamed.\`;
const argv = process.argv.slice(2);
const op = argv[0];
const take = (flag) => { const i = argv.indexOf(flag); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = take("--out");
const doc = argv.includes("--doc");
const rest = argv.slice(1).filter((a) => a !== "--doc");
if (!op || op === "help" || op === "--help") { console.log(usage); process.exit(op ? 0 : 2); }
let args = rest;
if (op === "update") args = [rest[0], rest[1] && resolve(rest[1])];
if (op === "create") args = [rest[0], rest[1], rest[2] && resolve(rest[2]), doc ? "doc" : ""];
const socket = connect(${JSON.stringify(DRIVE_SOCKET_IN_SANDBOX)});
const chunks = [];
socket.on("connect", () => socket.write(JSON.stringify({ op, args }) + "\\n"));
socket.on("data", (d) => chunks.push(d));
socket.on("error", (e) => { console.error("longform-drive: gateway unavailable (" + (e.code ?? e.message) + ")"); process.exit(1); });
socket.on("end", () => {
  let reply;
  try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { console.error("longform-drive: malformed reply"); process.exit(1); }
  if (!reply.ok) { console.error("longform-drive: " + reply.error); process.exit(1); }
  if (op === "read") {
    const r = reply.result;
    console.error(JSON.stringify({ id: r.meta.id, name: r.meta.name, version: r.meta.version, exportedAs: r.exportedAs }));
    const bytes = Buffer.from(r.content, r.encoding);
    if (out) { writeFileSync(out, bytes); console.error("saved " + out); }
    else process.stdout.write(bytes);
  } else console.log(JSON.stringify(reply.result, null, 2));
});
`;
