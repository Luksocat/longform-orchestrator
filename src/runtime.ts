import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Controller } from "./controller.js";
import { ReadOnlyStore, SqliteStore } from "./store.js";
import { TaskSchema } from "./domain.js";
import { EvidenceEnvelopeSchema } from "./evidence.js";
import {
  ProjectProfileSchema,
  RoutingPolicySchema,
  type ProjectProfile,
} from "./routing.js";
import {
  liveCapabilityVerifier,
  liveRoutingPolicyLoader,
  loadLiveConfig,
  type LiveConfig,
} from "./live.js";

export const SnapshotSchema = z
  .object({
    tasks: z.array(TaskSchema),
    evidence: z.array(EvidenceEnvelopeSchema),
  })
  .passthrough();
export const defaultSnapshot = [
  new URL("../fixtures/programme-snapshot.json", import.meta.url),
  new URL("../../fixtures/programme-snapshot.json", import.meta.url),
]
  .map((url) => fileURLToPath(url))
  .find((path) => existsSync(path))!;
// Works in source and compiled dist/src layouts without depending on process cwd.
export const projectRoot = resolve(
  fileURLToPath(new URL("../", import.meta.url)).replace(/\/dist\/src\/$/, "/"),
);
export function loadSnapshot(path: string) {
  return SnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
/** Trusted operator file named by the live config; never request input. */
export function loadProjectProfile(path: string): ProjectProfile {
  return ProjectProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
/** Trusted operator file beside the private database; never request input. */
export function defaultLiveConfigPath(databasePath: string) {
  return resolve(databasePath, "../live-config.json");
}
/**
 * The runtime over a database opened read-only, for commands that must
 * change nothing (issue #12 review E5 V1): the same configuration as
 * openRuntime, no storage set up, migrated or initialized.
 */
export function openReadOnlyRuntime(
  path: string,
  options: { routingPolicyPath?: string; liveConfigPath?: string } = {},
) {
  const db = new ReadOnlyStore(resolve(path));
  try {
    // A database this CLI never opened (an evaluation journal, say) has no
    // recorded owner yet; the writable runtime would record this process's
    // user, so that is its owner here, recorded nowhere (E5 rereview W1).
    const found = db.get<{ value: string }>("SELECT value FROM settings WHERE key=?", "owner_uid");
    const current = process.getuid?.();
    if (!found && current === undefined) throw new Error("POSIX_IDENTITY_REQUIRED");
    const { config } = runtimeConfig(options);
    const workspaceRoot = resolve(realpathSync(dirname(resolve(path))), "workspaces");
    const c = new Controller(db, { ...config, workspaceRoot, ownerUid: found ? Number(found.value) : current!, readOnly: true });
    return { db, c, actor: c.localActor() };
  } catch (error) {
    db.close();
    throw error;
  }
}
/**
 * The controller configuration the options give, validated before any
 * storage is opened; the workspace root comes from the open database.
 */
function runtimeConfig(options: { routingPolicyPath?: string; liveConfigPath?: string }) {
  const live: LiveConfig | undefined = options.liveConfigPath
    ? loadLiveConfig(options.liveConfigPath)
    : undefined;
  if (live && options.routingPolicyPath)
    throw new Error("LIVE_CONFIG_OWNS_ROUTING_POLICY");
  const policyPath = options.routingPolicyPath
    ? resolve(options.routingPolicyPath)
    : undefined;
  const routingPolicyLoader = live
    ? liveRoutingPolicyLoader(live)
    : policyPath
      ? () =>
          RoutingPolicySchema.parse(
            JSON.parse(readFileSync(policyPath, "utf8")),
          )
      : undefined;
  routingPolicyLoader?.();
  const projectProfile: ProjectProfile | undefined = live?.projectProfilePath
    ? loadProjectProfile(live.projectProfilePath)
    : undefined;
  return {
    live,
    config: {
      routingPolicyLoader,
      ...(projectProfile ? { projectProfile } : {}),
      ...(live?.repos ? { repos: live.repos } : {}),
      ...(live?.commands ? { commands: live.commands } : {}),
      ...(live
        ? {
            driveAuditRoot: join(live.stateDir, "drive-audit"),
            allowRealLocalTasks: true,
            verifyRoutingCapability: liveCapabilityVerifier(live),
            // Codex runs share one login and its lock; queue them here so a
            // waiting run doesn't spend its deadline in the queue.
            serialProviders: ["codex"] as const,
          }
        : {}),
    },
  };
}
export function openRuntime(
  path: string,
  options: { routingPolicyPath?: string; liveConfigPath?: string } = {},
) {
  // Validate operator configuration before opening or initializing storage.
  const { live, config } = runtimeConfig(options);
  const db = new SqliteStore(resolve(path));
  // Each run folder is checked against its real path, so the root is the
  // database directory's real path too: a database reached through a linked
  // directory must not refuse every run as WORKSPACE_ESCAPE.
  const workspaceRoot = resolve(realpathSync(dirname(resolve(path))), "workspaces");
  const uid = db.transaction(() => {
    let found = db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key=?",
      "owner_uid",
    );
    if (!found) {
      const current = process.getuid?.();
      if (current === undefined) throw new Error("POSIX_IDENTITY_REQUIRED");
      db.run("INSERT INTO settings VALUES(?,?)", "owner_uid", String(current));
      found = { value: String(current) };
    }
    return found;
  });
  const c = new Controller(db, {
    ...config,
    workspaceRoot,
    ownerUid: Number(uid.value),
  });
  return {
    db,
    c,
    actor: c.localActor(),
    live,
    workspaceRoot,
  };
}
export function seedSnapshot(
  c: Controller,
  path: string,
  actor: ReturnType<Controller["localActor"]>,
) {
  // Validated as a whole, then imported from the raw records, so the
  // controller sees each task as written (a real task must state its risk).
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const snapshot = SnapshotSchema.parse(raw);
  c.db.transaction(() => {
    c.importTasks(raw.tasks as unknown[], actor);
    for (const e of snapshot.evidence) c.addEvidence(e, actor);
  });
  return {
    tasks: snapshot.tasks.length,
    evidence: snapshot.evidence.length,
    grants: 0,
  };
}
