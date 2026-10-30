#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commands = new Set([
  "orchestrate", "register", "status", "next", "plan", "route", "inspect",
  "reviews", "decisions", "report", "doctor", "audit", "grant", "decision",
  "revoke", "bind", "verify", "accept", "revise", "evidence", "cancel",
  "reconcile", "resume", "attest", "drift-ack",
  "drive-evidence", "resolve-hold", "budget-extend", "assessment",
  "export-patch", "drive-file", "brief-preview",
  "provider-pause", "retry-extend", "provider-limits", "claims",
  "claims-reconcile", "reconcile-helper",
]);

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return (major === 22 && minor >= 13) || (major >= 24 && Number.isInteger(major));
}

function runtimeCandidates() {
  const choices = [process.execPath];
  const versions = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(versions)) {
    const names = readdirSync(versions).filter((v) => /^v\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const aa = a.slice(1).split(".").map(Number);
        const bb = b.slice(1).split(".").map(Number);
        return bb[0] - aa[0] || bb[1] - aa[1] || bb[2] - aa[2];
      });
    choices.push(...names.map((v) => join(versions, v, "bin", "node")));
  }
  return [...new Set(choices)];
}

export function findNode() {
  for (const candidate of runtimeCandidates()) {
    if (basename(candidate) !== "node" && basename(candidate) !== "node.exe") continue;
    try {
      const result = JSON.parse(execFileSync(candidate,
        ["-p", "JSON.stringify({version:process.versions.node,execPath:process.execPath})"],
        { encoding: "utf8", timeout: 3000, maxBuffer: 4096, shell: false }));
      if (supportedNode(result.version) && isAbsolute(result.execPath)) {
        return realpathSync(result.execPath);
      }
    } catch { /* Try only another locally discovered Node executable. */ }
  }
  throw new Error("SUPPORTED_NODE_UNAVAILABLE: install Node 22.13+ or Node 24+; no provider was invoked");
}

export function loadIntegration(root = skillRoot) {
  const configPath = join(root, "integration.json");
  let config;
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf8"));
    if (!config || Object.keys(config).some((k) => !["schemaVersion", "projectRoot", "databasePath"].includes(k)) ||
      config.schemaVersion !== 1 || typeof config.projectRoot !== "string" ||
      typeof config.databasePath !== "string" || !isAbsolute(config.projectRoot) || !isAbsolute(config.databasePath)) {
      throw new Error("INVALID_INTEGRATION_CONFIG: expected fixed absolute projectRoot/databasePath and schemaVersion 1");
    }
  } else {
    // Development use within this repository only; installed copies require config.
    let current = root;
    while (dirname(current) !== current) {
      const file = join(current, "package.json");
      if (existsSync(file)) {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).name === "longform-orchestrator") {
            config = { schemaVersion: 1, projectRoot: current, databasePath: join(current, ".longform", "state.sqlite") };
            break;
          }
        } catch { /* Not this application. */ }
      }
      current = dirname(current);
    }
    if (!config) throw new Error("INTEGRATION_NOT_CONFIGURED: run the local integration installer");
  }
  const projectRoot = realpathSync(config.projectRoot);
  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  if (pkg.name !== "longform-orchestrator") throw new Error("INVALID_PROJECT: expected longform-orchestrator");
  const cli = join(projectRoot, "dist", "src", "cli.js");
  if (!existsSync(cli)) throw new Error("APPLICATION_NOT_BUILT: run npm run build in " + projectRoot);
  if (resolve(config.databasePath) !== join(projectRoot, ".longform", "state.sqlite")) {
    throw new Error("INVALID_DATABASE_PATH: integration database must be project/.longform/state.sqlite");
  }
  return { projectRoot, databasePath: config.databasePath, cli };
}

/** The installed copy's location names its host: ~/.claude/... or ~/.codex/... */
export function bridgeHost(scriptPath = fileURLToPath(import.meta.url)) {
  const parts = resolve(scriptPath).split(/[\\/]/);
  if (parts.includes(".claude")) return "claude";
  if (parts.includes(".codex")) return "codex";
  return undefined;
}

export function bridgeArguments(args, config, host) {
  if (!commands.has(args[0])) throw new Error("UNSUPPORTED_BRIDGE_COMMAND: use a controller operator command");
  if (args.some((arg) => arg === "--db" || arg.startsWith("--db="))) {
    throw new Error("DATABASE_OVERRIDE_DENIED: the integration uses its configured absolute database");
  }
  if (host && args.some((arg) => arg === "--host" || arg.startsWith("--host="))) {
    throw new Error("HOST_OVERRIDE_DENIED: the installed bridge names its own host");
  }
  return [config.cli, ...args, "--db", config.databasePath, ...(host ? ["--host", host] : [])];
}

async function main() {
  const config = loadIntegration();
  const args = bridgeArguments(process.argv.slice(2), config, bridgeHost());
  const child = spawn(findNode(), args, { cwd: config.projectRoot, stdio: "inherit", shell: false });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(JSON.stringify({ error: "BRIDGE_START_FAILED", message: error.message }) + "\n");
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ error: "INTEGRATION_UNAVAILABLE", message: error.message }) + "\n");
    process.exitCode = 1;
  });
}
