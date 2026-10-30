import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const installer = join(project, "scripts", "install-integrations.mjs");
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "longform-integrations-"));
  const home = join(root, "home");
  const marketplace = join(home, ".agents", "plugins", "marketplace.json");
  const plugin = join(home, ".codex", "plugins", "longform-orchestrator");
  const codexSkill = join(home, ".codex", "skills", "longform-orchestrator");
  const claudeSkill = join(home, ".claude", "skills", "longform-orchestrator");
  const receipt = join(home, ".longform-orchestrator", "integration-installation.json");
  async function install(args: string[] = [], selectedProject = project) {
    const result = await run(process.execPath, [installer, "--home", home, "--project", selectedProject, ...args]);
    return JSON.parse(result.stdout);
  }
  function put(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  }
  return { root, home, marketplace, plugin, codexSkill, claudeSkill, receipt, install, put,
    close() { rmSync(root, { recursive: true, force: true }); } };
}

test("install and uninstall preserve a pre-existing orchestrator integration", async () => {
  const f = fixture();
  try {
    const legacyRoots = [
      join(f.home, ".codex", "plugins", "orchestrator"),
      join(f.home, ".codex", "skills", "orchestrator"),
      join(f.home, ".claude", "skills", "orchestrator"),
    ];
    const originals = legacyRoots.map((root, i) => {
      const file = join(root, "sentinel.txt");
      const bytes = `Existing integration ${i}: preserve these exact bytes.\n`;
      f.put(file, bytes);
      return { file, bytes };
    });
    const prior = {
      name: "existing-market",
      plugins: [{ name: "orchestrator", source: { source: "local", path: "./.codex/plugins/orchestrator" } }],
    };
    f.put(f.marketplace, prior);
    await f.install(["--execute"]);
    assert.equal(json(f.marketplace).plugins.length, 2);
    assert.deepEqual(json(f.marketplace).plugins[0], prior.plugins[0]);
    for (const { file, bytes } of originals) assert.equal(readFileSync(file, "utf8"), bytes);
    await f.install(["--uninstall", "--execute"]);
    assert.deepEqual(json(f.marketplace), prior);
    for (const { file, bytes } of originals) assert.equal(readFileSync(file, "utf8"), bytes);
  } finally { f.close(); }
});

test("integration installation defaults to dry-run without creating even a home directory", async () => {
  const f = fixture();
  try {
    const plan = await f.install();
    assert.equal(plan.mode, "DRY_RUN");
    assert.equal(plan.databasePath, join(project, ".longform", "state.sqlite"));
    assert.equal(existsSync(f.home), false);
  } finally { f.close(); }
});

test("additive installation preserves unrelated instructions, marketplace fields and plugins", async () => {
  const f = fixture();
  try {
    const instructions = join(f.home, ".claude", "CLAUDE.md");
    const config = join(f.home, ".codex", "config.toml");
    f.put(instructions, "Owner instructions remain byte-identical\n");
    f.put(config, 'model = "owner-choice"\n');
    const before = { name: "owner-market", custom: { preserve: true },
      interface: { displayName: "Owner Market" },
      plugins: [{ name: "existing", source: { source: "local", path: "./existing" } }] };
    f.put(f.marketplace, before);
    const plan = await f.install(["--execute"]);
    assert.equal(plan.plugin, "longform-orchestrator@owner-market");
    const after = json(f.marketplace);
    assert.deepEqual(after.custom, before.custom);
    assert.deepEqual(after.interface, before.interface);
    assert.deepEqual(after.plugins[0], before.plugins[0]);
    assert.equal(after.plugins[1].source.path, "./.codex/plugins/longform-orchestrator");
    assert.equal(readFileSync(instructions, "utf8"), "Owner instructions remain byte-identical\n");
    assert.equal(readFileSync(config, "utf8"), 'model = "owner-choice"\n');
    for (const root of [f.codexSkill, f.claudeSkill, join(f.plugin, "skills", "longform-orchestrator")]) {
      assert.equal(json(join(root, "integration.json")).databasePath, join(project, ".longform", "state.sqlite"));
      assert.ok(existsSync(join(root, "scripts", "bridge.mjs")));
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(join(root, "integration.json")).mode & 0o777, 0o600);
    }
    assert.equal(existsSync(join(project, ".longform", "integration-installation.json")), false);
    assert.equal(json(join(f.plugin, "plugin.json")).name, "longform-orchestrator");
  } finally { f.close(); }
});

test("owned identical installation is idempotent and uninstall preserves prior marketplace entries", async () => {
  const f = fixture();
  try {
    const before = { name: "custom", plugins: [{ name: "other", extra: "preserve" }], extra: 3 };
    f.put(f.marketplace, before);
    await f.install(["--execute"]);
    const receipt = readFileSync(f.receipt);
    assert.equal((await f.install(["--execute"])).unchanged, true);
    assert.deepEqual(readFileSync(f.receipt), receipt);
    assert.equal((await f.install(["--uninstall"])).mode, "DRY_RUN");
    assert.ok(existsSync(f.plugin));
    await f.install(["--uninstall", "--execute"]);
    assert.deepEqual(json(f.marketplace), before);
    assert.equal(existsSync(f.plugin), false);
    assert.equal(existsSync(f.codexSkill), false);
    assert.equal(existsSync(f.claudeSkill), false);
    assert.equal(existsSync(f.receipt), false);
  } finally { f.close(); }
});

test("unowned skill destination conflicts are rejected before any integration is changed", async () => {
  const f = fixture();
  try {
    f.put(join(f.claudeSkill, "SKILL.md"), "existing user skill");
    await assert.rejects(f.install(["--execute"]), /EXISTING_DESTINATION_REFUSED/);
    assert.equal(existsSync(f.plugin), false);
    assert.equal(existsSync(f.codexSkill), false);
    assert.equal(existsSync(f.marketplace), false);
    assert.equal(readFileSync(join(f.claudeSkill, "SKILL.md"), "utf8"), "existing user skill");
  } finally { f.close(); }
});

test("a marketplace plugin-name collision is never replaced or adopted", async () => {
  const f = fixture();
  try {
    f.put(f.marketplace, { name: "custom", plugins: [{ name: "longform-orchestrator", source: { source: "local", path: "./someone-else" } }] });
    const before = readFileSync(f.marketplace);
    await assert.rejects(f.install(["--execute"]), /MARKETPLACE_NAME_COLLISION/);
    assert.deepEqual(readFileSync(f.marketplace), before);
    assert.equal(existsSync(f.plugin), false);
  } finally { f.close(); }
});

test("symlinked destination ancestors are rejected without writing through the link", async () => {
  const f = fixture();
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    mkdirSync(f.home);
    symlinkSync(outside, join(f.home, ".claude"));
    await assert.rejects(f.install(["--execute"]), /SYMLINK_DESTINATION_REFUSED/);
    assert.equal(existsSync(join(outside, "skills")), false);
    assert.equal(existsSync(f.plugin), false);
  } finally { f.close(); }
});

test("dangling destination symlinks are refused rather than followed or replaced", async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".codex", "skills"), { recursive: true });
    symlinkSync(join(f.root, "missing-target"), f.codexSkill);
    await assert.rejects(f.install(["--execute"]), /SYMLINK_DESTINATION_REFUSED/);
    assert.equal(existsSync(f.plugin), false);
    assert.equal(existsSync(f.marketplace), false);
    assert.equal(existsSync(join(f.root, "missing-target")), false);
  } finally { f.close(); }
});

test("uninstall refuses modified owned bytes before removing any installation component", async () => {
  const f = fixture();
  try {
    await f.install(["--execute"]);
    f.put(join(f.codexSkill, "SKILL.md"), "owner changed this skill");
    const before = readFileSync(f.marketplace);
    await assert.rejects(f.install(["--uninstall", "--execute"]), /MODIFIED_INSTALLATION_REFUSED/);
    assert.ok(existsSync(f.plugin));
    assert.ok(existsSync(f.claudeSkill));
    assert.deepEqual(readFileSync(f.marketplace), before);
    assert.ok(existsSync(f.receipt));
  } finally { f.close(); }
});

test("uninstall preserves unrelated marketplace additions made after installation", async () => {
  const f = fixture();
  try {
    await f.install(["--execute"]);
    const market = json(f.marketplace);
    market.plugins.push({ name: "later-plugin", source: { source: "local", path: "./later" } });
    market.ownerField = "new";
    f.put(f.marketplace, market);
    await f.install(["--uninstall", "--execute"]);
    const remaining = json(f.marketplace);
    assert.deepEqual(remaining.plugins, [market.plugins[1]]);
    assert.equal(remaining.ownerField, "new");
    assert.equal(existsSync(f.plugin), false);
  } finally { f.close(); }
});

test("a newly created untouched marketplace is removed when its integration is uninstalled", async () => {
  const f = fixture();
  try {
    await f.install(["--execute"]);
    await f.install(["--uninstall", "--execute"]);
    assert.equal(existsSync(f.marketplace), false);
    assert.equal(existsSync(f.plugin), false);
  } finally { f.close(); }
});

test("racing installers yield one owned installation without duplicate plugin registrations", async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([f.install(["--execute"]), f.install(["--execute"])]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.equal(json(f.marketplace).plugins.filter((p: { name: string }) => p.name === "longform-orchestrator").length, 1);
    assert.equal((await f.install()).unchanged, true);
  } finally { f.close(); }
});

async function bridgeFixture() {
  const f = fixture();
  const app = join(f.root, "application with spaces");
  mkdirSync(join(app, "dist", "src"), { recursive: true });
  f.put(join(app, "package.json"), { name: "longform-orchestrator", type: "module" });
  cpSync(join(project, "plugins"), join(app, "plugins"), { recursive: true });
  f.put(join(app, "dist", "src", "cli.js"),
    'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),version:process.versions.node})+"\\n");\n');
  await f.install(["--execute"], app);
  return { ...f, app, bridge: join(f.claudeSkill, "scripts", "bridge.mjs") };
}

test("installed bridge uses a supported native Node and fixed database from an unrelated working directory", async () => {
  const f = await bridgeFixture();
  try {
    const outside = join(f.root, "other working directory");
    mkdirSync(outside);
    const prompt = join(outside, "task $(touch unsafe-marker) `literal`.txt");
    f.put(prompt, "Keep $() and backticks literal; never execute this task as shell text.");
    const args = ["orchestrate", "--prompt-file", prompt, "--request-key", "key; literal", "--context-cwd", outside, "--execute"];
    const result = JSON.parse((await run(process.execPath, [f.bridge, ...args], { cwd: outside })).stdout);
    // The Claude-installed copy names its own host so requests are host-owned.
    assert.deepEqual(result.argv, [...args, "--db", join(f.app, ".longform", "state.sqlite"), "--host", "claude"]);
    assert.equal(result.cwd, f.app);
    const [major, minor] = result.version.split(".").map(Number);
    assert.ok((major === 22 && minor >= 13) || major >= 24);
    assert.equal(existsSync(join(outside, "unsafe-marker")), false);
    assert.equal(existsSync(join(outside, ".longform")), false);
  } finally { f.close(); }
});

test("bridge refuses database redirection and arbitrary executable configuration", async () => {
  const f = await bridgeFixture();
  try {
    await assert.rejects(run(process.execPath, [f.bridge, "status", "--db", join(f.root, "other.sqlite")]), /DATABASE_OVERRIDE_DENIED/);
    await assert.rejects(run(process.execPath, [f.bridge, "status", "--db=other.sqlite"]), /DATABASE_OVERRIDE_DENIED/);
    const configPath = join(f.claudeSkill, "integration.json");
    const config = json(configPath);
    f.put(configPath, { ...config, nodeExecutable: "/bin/sh" });
    await assert.rejects(run(process.execPath, [f.bridge, "status"]), /INVALID_INTEGRATION_CONFIG/);
    assert.equal(existsSync(join(f.root, "other.sqlite")), false);
  } finally { f.close(); }
});
