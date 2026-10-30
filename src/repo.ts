import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DRIVE_CHANGES_DIR } from "./drive.js";

/**
 * Code work from a pinned commit: a task that names
 * a configured repository and commit starts from that commit's tracked files.
 * The repository itself is only read, never changed; history and untracked
 * files (dependencies, caches) stay out of the workspace.
 */
export type RepoConfig = { path: string };

/**
 * Git with no user or system configuration, none of the caller's GIT_*
 * settings and no replacement objects (review K15), so it reads the commit's
 * own tree and blobs and its output is always the same shape.
 */
const gitEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  ),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  LC_ALL: "C",
});
const git = (
  repo: string,
  args: string[],
  maxBuffer = 1 << 20,
  input?: string,
): Buffer => {
  const r = spawnSync("git", ["-C", repo, ...args], {
    env: gitEnv(),
    maxBuffer,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.status !== 0 || r.error)
    throw new Error(String(r.error ?? r.stderr).slice(0, 300));
  return r.stdout;
};

/**
 * The commit's tracked files, written into `dir` (which must be empty)
 * exactly as the commit stores them (review K9): read from its tree and
 * blobs, not through `git archive` or a checkout, so no export rules, line
 * ending or filter settings change them.
 */
export function seedFromCommit(repo: RepoConfig, commit: string, dir: string) {
  let resolved: string;
  try {
    resolved = git(repo.path, ["rev-parse", "--verify", "--quiet", commit + "^{commit}"])
      .toString("utf8")
      .trim();
  } catch {
    throw new Error("REPO_COMMIT_NOT_FOUND: " + commit);
  }
  if (resolved !== commit) throw new Error("REPO_COMMIT_NOT_FOUND: " + commit);
  const entries = git(repo.path, ["ls-tree", "-r", "-z", "--full-tree", commit], 64 << 20)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, sha] = entry.slice(0, tab).split(" ");
      return { mode: mode!, type: type!, sha: sha!, path: entry.slice(tab + 1) };
    });
  // Sealed work holds no links or submodules, so a commit with them cannot seed one.
  if (entries.some((e) => e.mode === "120000" || e.mode === "160000"))
    throw new Error("REPO_COMMIT_HAS_LINKS_OR_SUBMODULES: " + commit);
  for (const e of entries) {
    const parts = e.path.split("/");
    if (
      e.type !== "blob" ||
      !/^100(644|755|664)$/.test(e.mode) ||
      !/^[0-9a-f]{40,64}$/.test(e.sha) ||
      e.path.includes("\uFFFD") ||
      parts.some((x) => x === "" || x === "." || x === ".." || x.toLowerCase() === ".git")
    )
      throw new Error("REPO_COMMIT_HAS_UNUSABLE_ENTRY: " + JSON.stringify(e.path));
    // The Drive record folder belongs to the host: seeded files there would
    // pass for inherited records.
    if (parts[0] === DRIVE_CHANGES_DIR)
      throw new Error("REPO_COMMIT_HAS_DRIVE_RECORD_FOLDER: " + commit);
  }
  // Every blob in one read: "<sha> blob <size>\n<bytes>\n" each.
  const out = entries.length
    ? git(repo.path, ["cat-file", "--batch"], 1 << 30, entries.map((e) => e.sha + "\n").join(""))
    : Buffer.alloc(0);
  let at = 0;
  for (const e of entries) {
    const header = out.subarray(at, out.indexOf(10, at)).toString("utf8");
    const [sha, type, size] = header.split(" ");
    if (sha !== e.sha || type !== "blob" || !/^\d+$/.test(size ?? ""))
      throw new Error("REPO_SEED_FAILED: " + header.slice(0, 200));
    const start = at + header.length + 1,
      end = start + Number(size);
    if (end >= out.length) throw new Error("REPO_SEED_FAILED: short read");
    const path = join(dir, e.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out.subarray(start, end), {
      flag: "wx",
      mode: e.mode === "100755" ? 0o755 : 0o644,
    });
    at = end + 1;
  }
}

/** Each regular file under `root` (relative path → executable bit and bytes). */
function files(root: string, at = ""): Map<string, { exec: boolean; bytes: Buffer }> {
  const out = new Map<string, { exec: boolean; bytes: Buffer }>();
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const rel = at ? at + "/" + entry.name : entry.name;
    if (entry.isDirectory()) for (const [k, v] of files(root, rel)) out.set(k, v);
    else if (entry.isFile()) {
      const path = join(root, rel);
      out.set(rel, { exec: (lstatSync(path).mode & 0o111) !== 0, bytes: readFileSync(path) });
    } else throw new Error("REPO_WORK_HAS_SPECIAL_FILE: " + rel);
  }
  return out;
}

/**
 * The work's changes against the commit it started from (review K2, K3, K8):
 * a git patch with a/ and b/ paths (apply with `git apply` from the
 * repository root) that keeps file modes, empty and binary files, and the
 * changed files from git's machine-readable list. Only the workspace's own
 * top-level Drive record folder is left out. The patch is checked by
 * applying it to a fresh copy of the commit: it must rebuild the work's
 * files exactly, else REPO_PATCH_INCOMPLETE. The patch is bytes, as git
 * wrote them (review K13): text in another encoding stays exact.
 */
export function workChanges(
  repo: RepoConfig,
  commit: string,
  workspace: string,
): { patch: Buffer; files: string[] } {
  const root = mkdtempSync(join(tmpdir(), "longform-diff-"));
  try {
    for (const side of ["a", "c"]) {
      mkdirSync(join(root, side));
      seedFromCommit(repo, commit, join(root, side));
    }
    cpSync(workspace, join(root, "b"), { recursive: true, dereference: false });
    rmSync(join(root, "b", DRIVE_CHANGES_DIR), { recursive: true, force: true });
    const git = (args: string[], cwd = root, input?: Buffer) =>
      spawnSync("git", args, {
        cwd,
        env: gitEnv(),
        maxBuffer: 256 << 20,
        ...(input !== undefined ? { input } : {}),
      });
    const diff = git([
      "diff",
      "--no-index",
      "--no-prefix",
      "--binary",
      "--no-renames",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "a",
      "b",
    ]);
    // git diff exits 1 when the trees differ, other codes on trouble.
    if (diff.status !== 0 && diff.status !== 1)
      throw new Error("REPO_DIFF_FAILED: " + String(diff.stderr).slice(0, 300));
    const patch = diff.stdout;
    const names = git(["diff", "--no-index", "--name-status", "-z", "--no-renames", "a", "b"]);
    if (names.status !== 0 && names.status !== 1)
      throw new Error("REPO_DIFF_FAILED: " + String(names.stderr).slice(0, 300));
    const fields = String(names.stdout).split("\0").filter((x) => x !== "");
    const changed: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2)
      changed.push(fields[i]!.slice(0, 1) + " " + fields[i + 1]!.replace(/^[ab]\//, ""));
    if (patch.length) {
      const applied = git(["apply", "--whitespace=nowarn", "-"], join(root, "c"), patch);
      if (applied.status !== 0)
        throw new Error("REPO_PATCH_INCOMPLETE: " + String(applied.stderr).slice(0, 300));
    }
    const want = files(join(root, "b")),
      got = files(join(root, "c"));
    for (const [path, file] of want) {
      const other = got.get(path);
      if (!other || other.exec !== file.exec || !other.bytes.equals(file.bytes))
        throw new Error("REPO_PATCH_INCOMPLETE: " + path);
    }
    for (const path of got.keys())
      if (!want.has(path)) throw new Error("REPO_PATCH_INCOMPLETE: " + path);
    return { patch, files: changed };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/** The patch as text when it is UTF-8 throughout, else undefined (review K13). */
export function patchText(patch: Buffer): string | undefined {
  const text = patch.toString("utf8");
  return Buffer.from(text, "utf8").equals(patch) ? text : undefined;
}
