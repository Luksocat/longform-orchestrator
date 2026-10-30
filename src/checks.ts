import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./domain.js";

/**
 * Deterministic checks the controller runs on a worker's sealed work before
 * any review; the task's `checks` field lists them
 * (schema in domain.ts). They inspect only bytes and the host's Drive record;
 * a failed check sends the work back to its worker to fix in place, without
 * a review. Nothing here judges quality.
 */
export type CheckResult = {
  /** A listed check, or the task's required tests (run by the controller). */
  kind: Check["kind"] | "REQUIRED_TESTS";
  passed: boolean;
  /** What is wrong, one line each; empty when the check passed. */
  problems: string[];
};

/** A file as the check sees it: never followed through a link. */
export type CheckedFile =
  | { kind: "FILE"; bytes: Buffer }
  | { kind: "MISSING" | "NOT_A_FILE" | "TOO_LARGE" };

/** What the host's Drive records show for the specification's worker runs. */
export type DriveFacts = {
  /** IDs read, packed, updated or created. */
  read: ReadonlySet<string>;
  /** Files created (including a create that reported an error after writing). */
  creates: number;
};

/** Files larger than this are not scanned (the check fails instead). */
export const MAX_CHECKED_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Drive file IDs as Longform's records cite them: 28-44 characters of the ID
 * alphabet starting with "1" and mixing upper and lower case. Hex digests,
 * UUIDs and file names do not match.
 */
export function citedDriveIds(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_-])1[A-Za-z0-9_-]{27,43}(?![A-Za-z0-9_-])/g)) {
    const id = m[0];
    if (/[a-z]/.test(id) && /[A-Z]/.test(id)) found.add(id);
  }
  return [...found];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure: the same inputs always give the same results. */
export function evaluateChecks(
  checks: readonly Check[],
  file: (path: string) => CheckedFile,
  drive: DriveFacts | undefined,
): CheckResult[] {
  const text = (path: string, problems: string[]) => {
    const f = file(path);
    if (f.kind === "FILE") return f.bytes.toString("utf8");
    problems.push(
      f.kind === "MISSING"
        ? `${path} is missing`
        : f.kind === "NOT_A_FILE"
          ? `${path} is not a regular file`
          : `${path} is larger than ${MAX_CHECKED_FILE_BYTES} bytes`,
    );
    return undefined;
  };
  return checks.map((check): CheckResult => {
    const problems: string[] = [];
    switch (check.kind) {
      case "FILES_PRESENT":
        for (const path of check.paths) {
          const f = file(path);
          if (f.kind === "FILE" && f.bytes.length === 0)
            problems.push(`${path} is empty`);
          else if (f.kind !== "FILE") text(path, problems);
        }
        break;
      case "WORDS_ABSENT":
        for (const path of check.paths) {
          const body = text(path, problems);
          if (body === undefined) continue;
          for (const word of check.words) {
            const re = new RegExp(
              `(?<![\\p{L}\\p{N}_])${escape(word)}(?![\\p{L}\\p{N}_])`,
              "giu",
            );
            const hits = [...body.matchAll(re)].length;
            if (hits)
              problems.push(
                `${path} uses "${word}" ${hits === 1 ? "once" : hits + " times"}`,
              );
          }
        }
        break;
      case "CITED_DRIVE_IDS_READ": {
        if (!drive) {
          problems.push("no Drive record exists for this work");
          break;
        }
        const except = new Set(check.except);
        for (const path of check.paths) {
          const body = text(path, problems);
          if (body === undefined) continue;
          const unread = citedDriveIds(body).filter(
            (id) => !drive.read.has(id) && !except.has(id),
          );
          if (unread.length)
            problems.push(
              `${path} cites Drive files no run of this task read: ${unread.join(", ")}`,
            );
        }
        break;
      }
      case "DRIVE_CREATES_AT_MOST":
        if (!drive) break;
        if (drive.creates > check.max)
          problems.push(
            `${drive.creates} Drive files were created; at most ${check.max} may be`,
          );
        break;
    }
    return { kind: check.kind, passed: !problems.length, problems };
  });
}

/** A file of the sealed work, read without following links. */
export function checkedFile(workspace: string, path: string): CheckedFile {
  const full = join(workspace, path);
  if (!existsSync(full)) return { kind: "MISSING" };
  const info = lstatSync(full);
  if (!info.isFile()) return { kind: "NOT_A_FILE" };
  if (info.size > MAX_CHECKED_FILE_BYTES) return { kind: "TOO_LARGE" };
  return { kind: "FILE", bytes: readFileSync(full) };
}

/** The controller's record of one run's checks (event CHECKS_RECORDED). */
export type CheckRecord = {
  id: string;
  taskId: string;
  workerRunId: string;
  specDigest: string;
  artifactRevision: string;
  workspaceDigest: string;
  passed: boolean;
  results: CheckResult[];
  at: string;
};
