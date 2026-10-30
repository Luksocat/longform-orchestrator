import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);
const installer = join(project, "scripts", "install-integrations.mjs");
const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("claude-only update leaves a Codex-modified installation and catalog untouched", async () => {
  const home = mkdtempSync(join(tmpdir(), "longform-claude-only-"));
  const install = async (...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [
          installer,
          "--home",
          home,
          "--project",
          project,
          ...args,
        ])
      ).stdout,
    );
  try {
    await install("--execute");
    const codexSkill = join(
      home,
      ".codex",
      "skills",
      "longform-orchestrator",
      "SKILL.md",
    );
    const codexIntegration = join(
      home,
      ".codex",
      "skills",
      "longform-orchestrator",
      "integration.json",
    );
    const catalog = join(home, ".agents", "plugins", "marketplace.json");
    const claudeSkill = join(
      home,
      ".claude",
      "skills",
      "longform-orchestrator",
      "SKILL.md",
    );
    // The Codex host takes over its own copy, as a separate Codex orchestrator would.
    writeFileSync(codexSkill, "# Codex Orchestrator\n");
    writeFileSync(
      codexIntegration,
      JSON.stringify({ projectRoot: "/elsewhere" }),
    );
    const before = [codexSkill, codexIntegration, catalog].map(sha);
    // The all-host update now refuses, rather than overwrite the Codex copy.
    await assert.rejects(
      install("--uninstall"),
      /MODIFIED_INSTALLATION_REFUSED/,
    );
    // Simulate an older Claude skill so the update has something to change.
    writeFileSync(claudeSkill, readFileSync(claudeSkill, "utf8"));
    const plan = await install("--claude-only");
    assert.equal(plan.mode, "DRY_RUN");
    const done = await install("--claude-only", "--execute");
    assert.equal(done.action, "update-claude-skill");
    assert.deepEqual([codexSkill, codexIntegration, catalog].map(sha), before);
    assert.equal(
      readFileSync(claudeSkill, "utf8"),
      readFileSync(
        join(
          project,
          "plugins",
          "longform-orchestrator",
          "skills",
          "longform-orchestrator",
          "SKILL.md",
        ),
        "utf8",
      ),
    );
    const receipt = JSON.parse(
      readFileSync(
        join(home, ".longform-orchestrator", "integration-installation.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.scope, "claude-only");
    assert.deepEqual(receipt.relinquished.targets, [
      join(home, ".codex", "plugins", "longform-orchestrator"),
      join(home, ".codex", "skills", "longform-orchestrator"),
    ]);
    // Idempotent, and the plain installer now follows the Claude-only receipt.
    assert.equal((await install("--claude-only", "--execute")).unchanged, true);
    assert.equal((await install()).action, "update-claude-skill");
    // A locally modified Claude skill is still refused.
    writeFileSync(claudeSkill, "tampered");
    await assert.rejects(
      install("--claude-only", "--execute"),
      /MODIFIED_INSTALLATION_REFUSED/,
    );
    writeFileSync(
      claudeSkill,
      readFileSync(
        join(
          project,
          "plugins",
          "longform-orchestrator",
          "skills",
          "longform-orchestrator",
          "SKILL.md",
        ),
      ),
    );
    // Uninstall removes only the Claude skill and the receipt.
    await install("--uninstall", "--execute");
    assert.equal(
      existsSync(join(home, ".claude", "skills", "longform-orchestrator")),
      false,
    );
    assert.deepEqual([codexSkill, codexIntegration, catalog].map(sha), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
