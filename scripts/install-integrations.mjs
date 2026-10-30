#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const defaultProject = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function collect(root) {
  const files = new Map();
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("SYMLINK_NOT_ALLOWED: " + path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
      else throw new Error("SPECIAL_FILE_NOT_ALLOWED: " + path);
    }
  }
  walk(root);
  return files;
}

function assertNoSymlinkAncestors(path) {
  let current = resolve(path);
  while (true) {
    let entry;
    try { entry = lstatSync(current); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    if (entry?.isSymbolicLink()) throw new Error("SYMLINK_DESTINATION_REFUSED: " + current);
    if (dirname(current) === current) break;
    current = dirname(current);
  }
}

function paths(home) {
  return {
    plugin: join(home, ".codex", "plugins", "longform-orchestrator"),
    codexSkill: join(home, ".codex", "skills", "longform-orchestrator"),
    claudeSkill: join(home, ".claude", "skills", "longform-orchestrator"),
    marketplace: join(home, ".agents", "plugins", "marketplace.json"),
    receipt: join(home, ".longform-orchestrator", "integration-installation.json"),
  };
}

function expectedFiles(project, dest) {
  const source = join(project, "plugins", "longform-orchestrator");
  const pluginFiles = collect(source);
  if (!pluginFiles.has("plugin.json") || !pluginFiles.has("skills/longform-orchestrator/SKILL.md")) {
    throw new Error("PLUGIN_PACKAGE_INCOMPLETE");
  }
  const config = json({
    schemaVersion: 1,
    projectRoot: project,
    databasePath: join(project, ".longform", "state.sqlite"),
  });
  pluginFiles.set("skills/longform-orchestrator/integration.json", config);
  const skillFiles = new Map([...pluginFiles]
    .filter(([name]) => name.startsWith("skills/longform-orchestrator/"))
    .map(([name, bytes]) => [name.slice("skills/longform-orchestrator/".length), bytes]));
  const files = new Map();
  for (const [root, content] of [[dest.plugin, pluginFiles], [dest.codexSkill, skillFiles], [dest.claudeSkill, skillFiles]]) {
    for (const [name, bytes] of content) files.set(join(root, name), bytes);
  }
  return files;
}

function inspectMarketplace(file) {
  if (!existsSync(file)) return { oldBytes: null, value: { name: "longform-local", interface: { displayName: "Longform Local" }, plugins: [] } };
  if (!lstatSync(file).isFile()) throw new Error("INVALID_MARKETPLACE_FILE");
  const oldBytes = readFileSync(file);
  const value = JSON.parse(oldBytes.toString("utf8"));
  if (!value || typeof value.name !== "string" || !value.name || !Array.isArray(value.plugins)) {
    throw new Error("INVALID_EXISTING_MARKETPLACE: name and plugins array required; unchanged");
  }
  return { oldBytes, value };
}

function pluginEntry() {
  return {
    name: "longform-orchestrator",
    source: { source: "local", path: "./.codex/plugins/longform-orchestrator" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };
}

function receiptTargets(receipt, dest) {
  return receipt?.scope === "claude-only"
    ? [dest.claudeSkill]
    : [dest.plugin, dest.codexSkill, dest.claudeSkill];
}

/** Checks the owned bytes under `roots` (default: every receipt target). */
function checkOwnedInstallation(receipt, dest, roots = receipt?.targets) {
  if (!receipt || receipt.schemaVersion !== 1 || !Array.isArray(receipt.files) ||
      !same(receipt.targets, receiptTargets(receipt, dest)) ||
      !roots.every((root) => receipt.targets.includes(root))) {
    throw new Error("INVALID_INSTALLATION_RECEIPT");
  }
  const recorded = new Map();
  for (const entry of receipt.files) {
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !receipt.targets.some((root) => entry.path.startsWith(root + sep)) || recorded.has(entry.path)) {
      throw new Error("INVALID_RECEIPT_FILE");
    }
    if (roots.some((root) => entry.path.startsWith(root + sep))) recorded.set(entry.path, entry.sha256);
  }
  for (const root of roots) {
    assertNoSymlinkAncestors(root);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error("OWNED_INSTALLATION_MISSING: " + root);
    const actual = collect(root);
    for (const [name, bytes] of actual) {
      const path = join(root, name);
      if (recorded.get(path) !== sha(bytes)) throw new Error("MODIFIED_INSTALLATION_REFUSED: " + path);
      recorded.delete(path);
    }
  }
  if (recorded.size) throw new Error("OWNED_INSTALLATION_MISSING: " + recorded.keys().next().value);
}

function replace(file, bytes) {
  const temp = file + ".longform-" + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/**
 * Update only the Claude Code skill. The Codex plugin, Codex skill and plugin
 * catalog belong to the Codex host's own installation and are never read for
 * modification, written or removed; an older all-host receipt records them as
 * relinquished.
 */
export function updateClaudeSkill({ home = homedir(), project = defaultProject, execute = false } = {}) {
  if (!isAbsolute(home) || !isAbsolute(project)) throw new Error("ABSOLUTE_HOME_AND_PROJECT_REQUIRED");
  home = resolve(home);
  project = realpathSync(project);
  if (JSON.parse(readFileSync(join(project, "package.json"), "utf8")).name !== "longform-orchestrator") {
    throw new Error("INVALID_PROJECT");
  }
  const dest = paths(home);
  [dest.claudeSkill, dest.receipt].forEach(assertNoSymlinkAncestors);
  const oldReceipt = existsSync(dest.receipt) ? readFileSync(dest.receipt) : null;
  const receipt = oldReceipt ? JSON.parse(oldReceipt.toString("utf8")) : null;
  if (receipt) {
    if (receipt.projectRoot !== project) throw new Error("INSTALLATION_PROJECT_MISMATCH");
    checkOwnedInstallation(receipt, dest, [dest.claudeSkill]);
  } else if (existsSync(dest.claudeSkill)) {
    throw new Error("EXISTING_DESTINATION_REFUSED: " + dest.claudeSkill);
  }
  const files = new Map([...expectedFiles(project, dest)].filter(([path]) => path.startsWith(dest.claudeSkill + sep)));
  const unchanged = receipt?.scope === "claude-only" &&
    receipt.files.length === files.size && [...files].every(([path, bytes]) =>
      receipt.files.some((entry) => entry.path === path && entry.sha256 === sha(bytes)));
  const nextReceipt = {
    schemaVersion: 1, scope: "claude-only", projectRoot: project, installedAt: new Date().toISOString(),
    targets: [dest.claudeSkill],
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
    ...(receipt && receipt.scope !== "claude-only" ? {
      relinquished: {
        targets: [dest.plugin, dest.codexSkill], marketplaceEntry: receipt.marketplaceEntry,
        previousReceiptSha256: sha(oldReceipt),
        note: "Left untouched for the separate Codex-host installation; this installer no longer owns them",
      },
    } : receipt?.relinquished ? { relinquished: receipt.relinquished } : {}),
  };
  const plan = {
    mode: execute ? "EXECUTED" : "DRY_RUN", action: "update-claude-skill", projectRoot: project,
    target: dest.claudeSkill, files: files.size, unchanged,
    untouched: [dest.plugin, dest.codexSkill, dest.marketplace],
  };
  if (!execute || unchanged) return plan;
  const staged = dest.claudeSkill + ".longform-" + randomUUID() + ".new";
  const previous = dest.claudeSkill + ".longform-" + randomUUID() + ".old";
  mkdirSync(dirname(dest.claudeSkill), { recursive: true, mode: 0o700 });
  mkdirSync(staged, { mode: 0o700 });
  try {
    for (const [file, bytes] of files) {
      const target = join(staged, relative(dest.claudeSkill, file));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    }
    if (existsSync(dest.claudeSkill)) renameSync(dest.claudeSkill, previous);
    renameSync(staged, dest.claudeSkill);
    mkdirSync(dirname(dest.receipt), { recursive: true, mode: 0o700 });
    replace(dest.receipt, json(nextReceipt));
  } catch (error) {
    // Restore the previous skill so the bytes on disk match the unchanged receipt.
    if (existsSync(previous)) {
      if (existsSync(dest.claudeSkill)) rmSync(dest.claudeSkill, { recursive: true, force: true });
      renameSync(previous, dest.claudeSkill);
    }
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  return plan;
}

/** Additive, local-only installation. The default is a plan with no filesystem writes. */
export function installIntegrations({ home = homedir(), project = defaultProject, execute = false, uninstall = false } = {}) {
  if (!isAbsolute(home) || !isAbsolute(project)) throw new Error("ABSOLUTE_HOME_AND_PROJECT_REQUIRED");
  home = resolve(home);
  project = realpathSync(project);
  if (JSON.parse(readFileSync(join(project, "package.json"), "utf8")).name !== "longform-orchestrator") {
    throw new Error("INVALID_PROJECT");
  }
  const dest = paths(home);
  Object.values(dest).forEach(assertNoSymlinkAncestors);
  const oldReceipt = existsSync(dest.receipt) ? readFileSync(dest.receipt) : null;
  const receipt = oldReceipt ? JSON.parse(oldReceipt.toString("utf8")) : null;
  const market = inspectMarketplace(dest.marketplace);
  const matching = market.value.plugins.filter((entry) => entry?.name === "longform-orchestrator");
  if (matching.length > 1) throw new Error("MARKETPLACE_NAME_COLLISION: duplicate longform-orchestrator entries");

  if (receipt?.scope === "claude-only") {
    if (receipt.projectRoot !== project) throw new Error("INSTALLATION_PROJECT_MISMATCH");
    checkOwnedInstallation(receipt, dest);
    if (!uninstall) return updateClaudeSkill({ home, project, execute });
    const plan = { mode: execute ? "EXECUTED" : "DRY_RUN", action: "uninstall", projectRoot: project,
      remove: [dest.claudeSkill, dest.receipt], preserves: "Codex-host installation and all unrelated files" };
    if (!execute) return plan;
    rmSync(dest.claudeSkill, { recursive: true });
    unlinkSync(dest.receipt);
    return plan;
  }
  if (uninstall) {
    if (!receipt) throw new Error("NO_OWNED_INSTALLATION: nothing will be removed");
    if (receipt.projectRoot !== project) throw new Error("INSTALLATION_PROJECT_MISMATCH");
    checkOwnedInstallation(receipt, dest);
    if (matching.length !== 1 || !same(matching[0], receipt.marketplaceEntry)) {
      throw new Error("MODIFIED_MARKETPLACE_ENTRY_REFUSED");
    }
    const remaining = { ...market.value, plugins: market.value.plugins.filter((entry) => entry !== matching[0]) };
    const marketOnlyOurs = receipt.createdMarketplace && sha(market.oldBytes) === receipt.installedMarketplaceSha256;
    const plan = {
      mode: execute ? "EXECUTED" : "DRY_RUN", action: "uninstall", projectRoot: project,
      remove: [...receipt.targets, dest.receipt],
      marketplace: dest.marketplace, removeMarketplaceFile: marketOnlyOurs,
      preserves: "All unrelated instructions, configuration, plugins and skills",
    };
    if (!execute) return plan;
    // All owned bytes and the exact entry have been checked before any mutation.
    if (marketOnlyOurs) unlinkSync(dest.marketplace);
    else replace(dest.marketplace, json(remaining));
    receipt.targets.forEach((root) => rmSync(root, { recursive: true }));
    unlinkSync(dest.receipt);
    return plan;
  }

  const files = expectedFiles(project, dest);
  if (receipt) {
    if (receipt.projectRoot !== project) throw new Error("INSTALLATION_PROJECT_MISMATCH");
    checkOwnedInstallation(receipt, dest);
    if (matching.length !== 1 || !same(matching[0], receipt.marketplaceEntry)) throw new Error("MODIFIED_MARKETPLACE_ENTRY_REFUSED");
    const oldFiles = new Map(receipt.files.map((entry) => [entry.path, entry.sha256]));
    if (oldFiles.size !== files.size || [...files].some(([path, bytes]) => oldFiles.get(path) !== sha(bytes))) {
      throw new Error("INSTALLATION_UPDATE_REQUIRES_UNINSTALL: preserve the old installation before updating");
    }
    return { mode: execute ? "EXECUTED" : "DRY_RUN", action: "install", unchanged: true, projectRoot: project,
      marketplaceName: market.value.name, plugin: "longform-orchestrator@" + market.value.name, targets: receipt.targets };
  }
  if (matching.length) throw new Error("MARKETPLACE_NAME_COLLISION: existing longform-orchestrator entry is not installer-owned");
  for (const root of [dest.plugin, dest.codexSkill, dest.claudeSkill]) {
    if (existsSync(root)) throw new Error("EXISTING_DESTINATION_REFUSED: " + root);
  }
  const entry = pluginEntry();
  const nextMarket = { ...market.value, plugins: [...market.value.plugins, entry] };
  const marketBytes = json(nextMarket);
  const nextReceipt = {
    schemaVersion: 1, projectRoot: project, installedAt: new Date().toISOString(),
    targets: [dest.plugin, dest.codexSkill, dest.claudeSkill],
    files: [...files].map(([path, bytes]) => ({ path, sha256: sha(bytes) })),
    marketplaceEntry: entry, createdMarketplace: market.oldBytes === null,
    installedMarketplaceSha256: sha(marketBytes),
  };
  const plan = {
    mode: execute ? "EXECUTED" : "DRY_RUN", action: "install", projectRoot: project,
    databasePath: join(project, ".longform", "state.sqlite"),
    targets: nextReceipt.targets, files: files.size, marketplace: dest.marketplace,
    marketplaceName: market.value.name, plugin: "longform-orchestrator@" + market.value.name,
    preserves: "All unrelated instructions, configuration, plugins and skills",
  };
  if (!execute) return plan;
  const created = [];
  let marketWritten = false;
  try {
    for (const root of nextReceipt.targets) {
      mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
      mkdirSync(root, { mode: 0o700 }); // Exclusive reservation: never overwrite a destination.
      created.push(root);
    }
    for (const [file, bytes] of files) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    }
    const current = existsSync(dest.marketplace) ? readFileSync(dest.marketplace) : null;
    if ((current === null) !== (market.oldBytes === null) || (current && sha(current) !== sha(market.oldBytes))) {
      throw new Error("MARKETPLACE_CHANGED_DURING_INSTALL: nothing replaced");
    }
    mkdirSync(dirname(dest.marketplace), { recursive: true, mode: 0o700 });
    replace(dest.marketplace, marketBytes);
    marketWritten = true;
    mkdirSync(dirname(dest.receipt), { recursive: true, mode: 0o700 });
    writeFileSync(dest.receipt, json(nextReceipt), { flag: "wx", mode: 0o600 });
  } catch (error) {
    created.reverse().forEach((root) => rmSync(root, { recursive: true, force: true }));
    if (marketWritten) {
      if (market.oldBytes === null) unlinkSync(dest.marketplace);
      else replace(dest.marketplace, market.oldBytes);
    }
    throw error;
  }
  return plan;
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--claude-only") options.claudeOnly = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--home" || arg === "--project") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("MISSING_OPTION_VALUE: " + arg);
      options[arg.slice(2)] = value;
    } else throw new Error("UNKNOWN_OPTION: " + arg);
  }
  const { claudeOnly, ...rest } = options;
  if (claudeOnly && rest.uninstall) throw new Error("CLAUDE_ONLY_IS_AN_UPDATE: use --uninstall alone");
  const result = claudeOnly ? updateClaudeSkill(rest) : installIntegrations(rest);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(JSON.stringify({ error: "INSTALLATION_REFUSED", message: error.message }) + "\n");
    process.exitCode = 1;
  }
}
