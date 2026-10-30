import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const paths = [];
const collect = (directory) => {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = (directory ? directory + "/" : "") + entry.name;
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile()) paths.push(path);
    else throw new Error("Nonregular source entry: " + path);
  }
};
for (const directory of [
  "src",
  "tests",
  "bin",
  "scripts",
  "fixtures",
  "docs",
  "plugins",
])
  collect(directory);
paths.push(
  "AGENTS.md",
  "README.md",
  "NOTICE.md",
  "LICENSE",
  "LICENSE-JordyDutch.txt",
  ".gitignore",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".agents/plugins/marketplace.json",
);
const files = paths.sort().map((path) => {
  const bytes = readFileSync(join(root, path));
  return { path, sha256: sha256(bytes), bytes: bytes.length };
});
let head = null;
try {
  head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  project: "LONGFORM_ORCHESTRATOR_v0.1",
  worktree: root,
  git: {
    branch: execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    head,
    identity: head
      ? "COMMITTED_WITH_WORKTREE_MANIFEST"
      : "UNBORN_HEAD_UNCOMMITTED_WORKTREE",
  },
  sourceAggregateSha256: sha256(JSON.stringify(files)),
  exclusions: [
    "evidence/** (including this manifest and reviews)",
    ".longform/**",
    "vendor/**",
    "node_modules/**",
    "dist/**",
  ],
  files,
};
mkdirSync(join(root, "evidence"), { recursive: true });
writeFileSync(
  join(root, "evidence/source-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
process.stdout.write(
  JSON.stringify({
    path: relative(root, join(root, "evidence/source-manifest.json")),
    files: files.length,
    sourceAggregateSha256: manifest.sourceAggregateSha256,
    git: manifest.git,
  }) + "\n",
);
