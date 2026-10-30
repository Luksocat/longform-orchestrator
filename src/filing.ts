import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  DriveGateway,
  type DriveCredentials,
  type DriveFetch,
  type DriveWriteHooks,
} from "./drive.js";
import type { DrivePolicy } from "./domain.js";

/**
 * Filing by a tool, not a model: exact bytes go to
 * Drive within a task's Drive scope and grants, through the same gateway a
 * worker uses (scope checks, read before update, version checks, the host
 * record), and are read back. No model takes part.
 */
const driveFileId = z.string().regex(/^[A-Za-z0-9_-]{10,128}$/);
const localFile = z.string().refine(isAbsolute, "absolute path required");
export const FilingPlanSchema = z
  .object({
    create: z
      .array(
        z
          .object({
            folderId: driveFileId,
            name: z.string().min(1).max(255),
            path: localFile,
            /** Make a Google Doc from Markdown (its readback is the Doc's export). */
            doc: z.boolean().default(false),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    update: z
      .array(
        z
          .object({
            fileId: driveFileId,
            path: localFile,
            /**
             * The Drive version the work was made against; filing refuses if
             * Drive has another (default: the version the current sealed work
             * recorded for the file).
             */
            expectedVersion: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    reason: z.string().trim().min(1).max(2_000),
    sourceRef: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((p) => p.create.length + p.update.length > 0, "nothing to file");
export type FilingPlan = z.infer<typeof FilingPlanSchema>;

export type FilingResult = {
  op: "create" | "update";
  fileId?: string;
  name?: string;
  path: string;
  sha256: string;
  bytes: number;
  versionAfter?: string;
  /** The version the update was checked against before writing; null when none was known. */
  baseVersion?: string | null;
  /** For a stored file, the bytes read back equal the bytes sent. */
  readback: "MATCH" | "MISMATCH" | "EXPORTED" | "NOT_READ";
  error?: string;
};

/** Plan errors before anything is sent: scope, files. */
export function checkFilingPlan(plan: FilingPlan, scope: DrivePolicy): string[] {
  const problems: string[] = [];
  for (const c of plan.create)
    if (!scope.createIn.includes(c.folderId))
      problems.push("create outside the task's Drive scope: folder " + c.folderId);
  for (const u of plan.update)
    if (!scope.update.includes(u.fileId))
      problems.push("update outside the task's Drive scope: file " + u.fileId);
  for (const f of [...plan.create, ...plan.update]) {
    let ok = false;
    try {
      const info = lstatSync(f.path);
      ok = info.isFile() && info.size <= 25 * 1024 * 1024;
    } catch {
      /* reported below */
    }
    if (!ok) problems.push("not a regular file up to 25 MiB: " + f.path);
  }
  return problems;
}

/**
 * Carry the plan out. Each local file is copied into a fresh filing folder
 * (the gateway uploads only files inside its workspace), updates are read
 * first, and every call is in the host record under `auditDir`. Stops at the
 * first failure; what was done so far is in the results and the record.
 */
export async function fileToDrive(options: {
  plan: FilingPlan;
  scope: DrivePolicy;
  credentials: DriveCredentials;
  /** A new, empty folder for this filing's copies. */
  workspace: string;
  auditDir: string;
  id?: string;
  fetcher?: DriveFetch;
  /**
   * The task's Drive scope as it stands now, asked again just before each
   * write: it throws when filing is no longer allowed (review K22), or when
   * the filing no longer holds its claims.
   */
  authorize?: () => DrivePolicy;
  /** The controller's write-intent hooks for this filing (S4). */
  writes?: DriveWriteHooks;
  /** The version the current sealed work recorded for each file it read or wrote. */
  sealedVersions?: Record<string, string>;
  /**
   * Governing sources that must still be at the version the sealed work
   * read when each write is made (`requireLatest`); null: the work never
   * read it, so nothing can be filed.
   */
  requireLatest?: Array<{ fileId: string; version: string | null }>;
}): Promise<{ id: string; results: FilingResult[]; complete: boolean }> {
  const id = options.id ?? randomUUID();
  const files = join(options.workspace, "files");
  mkdirSync(files, { recursive: true, mode: 0o700 });
  const gateway = new DriveGateway({
    credentials: options.credentials,
    // Only what it files: the files it may update, and the ones it creates.
    policy: {
      read: [
        ...options.scope.update,
        ...(options.requireLatest ?? []).map((r) => r.fileId),
      ],
      update: options.scope.update,
      createIn: options.scope.createIn,
    },
    workspace: options.workspace,
    auditDir: options.auditDir,
    runId: "filing-" + id,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.writes ? { writes: options.writes } : {}),
  });
  await gateway.prepare();
  const results: FilingResult[] = [];
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  let n = 0;
  // Before each write: still allowed, and the target still in scope.
  const allowed = (result: FilingResult, inScope: (scope: DrivePolicy) => boolean) => {
    if (!options.authorize) return true;
    try {
      if (inScope(options.authorize())) return true;
      result.error = "FILING_AUTHORITY_WITHDRAWN: no longer in the task's Drive scope";
    } catch (error) {
      result.error = "FILING_AUTHORITY_WITHDRAWN: " + (error instanceof Error ? error.message : String(error));
    }
    return false;
  };
  // Before each write: every governing source still at the version the
  // sealed work read ; writes made stay recorded.
  const sourcesCurrent = async (result: FilingResult) => {
    for (const r of options.requireLatest ?? []) {
      const now = ((await gateway.operate("meta", [r.fileId])) as { version?: string }).version;
      if (r.version === null || now !== r.version) {
        result.error = `FILING_REQUIRED_SOURCE_CHANGED: ${r.fileId} is version ${now}; the work read ${r.version ?? "no version of it"}. Rework it against the current source`;
        return false;
      }
    }
    return true;
  };
  const stage = (path: string) => {
    const copy = join(files, String(++n) + "-" + basename(path));
    copyFileSync(path, copy);
    return { copy, bytes: readFileSync(copy) };
  };
  try {
    for (const u of options.plan.update) {
      const { copy, bytes } = stage(u.path);
      const result: FilingResult = { op: "update", fileId: u.fileId, path: u.path, sha256: sha(bytes), bytes: bytes.length, readback: "NOT_READ" };
      results.push(result);
      const current = ((await gateway.operate("read", [u.fileId])) as { meta: { version?: string } }).meta.version;
      // The file must still be at the version the work was made against.
      const base = u.expectedVersion ?? options.sealedVersions?.[u.fileId] ?? null;
      result.baseVersion = base;
      if (base !== null && current !== base) {
        result.error = `CHANGED_SINCE_WORKER_READ: the work was made against version ${base}; Drive now has ${current}`;
        return { id, results, complete: false };
      }
      if (!allowed(result, (s) => s.update.includes(u.fileId))) return { id, results, complete: false };
      if (!(await sourcesCurrent(result))) return { id, results, complete: false };
      const done = (await gateway.operate("update", [u.fileId, copy])) as {
        after: { version?: string; mimeType: string };
      };
      result.versionAfter = done.after.version;
      result.readback = await readback(gateway, u.fileId, bytes, done.after.mimeType);
      // A mismatch stops the filing there (review K6).
      if (result.readback === "MISMATCH") {
        result.error = "READBACK_MISMATCH";
        return { id, results, complete: false };
      }
    }
    for (const c of options.plan.create) {
      const { copy, bytes } = stage(c.path);
      const result: FilingResult = { op: "create", name: c.name, path: c.path, sha256: sha(bytes), bytes: bytes.length, readback: "NOT_READ" };
      results.push(result);
      if (!allowed(result, (s) => s.createIn.includes(c.folderId))) return { id, results, complete: false };
      if (!(await sourcesCurrent(result))) return { id, results, complete: false };
      const made = (await gateway.operate("create", [c.folderId, c.name, copy, c.doc ? "doc" : ""])) as {
        id: string;
        version?: string;
        mimeType: string;
      };
      result.fileId = made.id;
      result.versionAfter = made.version;
      result.readback = await readback(gateway, made.id, bytes, made.mimeType);
      if (result.readback === "MISMATCH") {
        result.error = "READBACK_MISMATCH";
        return { id, results, complete: false };
      }
    }
  } catch (error) {
    const last = results.at(-1);
    if (last && last.readback === "NOT_READ") last.error = error instanceof Error ? error.message : String(error);
    return { id, results, complete: false };
  } finally {
    await gateway.close();
  }
  return { id, results, complete: results.every((r) => r.readback !== "MISMATCH") };
}

async function readback(gateway: DriveGateway, fileId: string, sent: Buffer, mimeType: string) {
  // A Google Doc reads back as its export, which is not the bytes sent.
  if (mimeType.startsWith("application/vnd.google-apps.")) return "EXPORTED" as const;
  const read = (await gateway.operate("read", [fileId])) as { content: string; encoding: "utf8" | "base64" };
  return Buffer.from(read.content, read.encoding).equals(sent) ? ("MATCH" as const) : ("MISMATCH" as const);
}
