#!/usr/bin/env node
// Drive audit around a live run, read-only (uses live-config.json's drive login).
//   start <markFile>                record Drive's change cursor before the run
//   report <markFile> <stateDir>    every change since the mark, flagged against the gateway logs
// A change the gateway did not log, any removal, trash or move is flagged.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [command, markFile, stateDir] = process.argv.slice(2);
// Same login source as the gateway: the drive section of live-config.json.
const config = JSON.parse(readFileSync(new URL("../.longform/live-config.json", import.meta.url), "utf8"));
async function token() {
  const { driveAccessToken } = await import("../dist/src/drive.js");
  return (await driveAccessToken(config.drive)).value;
}
async function api(path, query, bearer) {
  const url = new URL("https://www.googleapis.com/drive/v3" + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { authorization: "Bearer " + bearer } });
    if (r.ok) return r.json();
    if (attempt >= 4 || ![403, 429, 500, 502, 503].includes(r.status))
      throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 300)}`);
    await new Promise((s) => setTimeout(s, 2000 * 2 ** attempt));
  }
}
const bearer = await token();
if (command === "start") {
  const { startPageToken } = await api("/changes/startPageToken", {}, bearer);
  writeFileSync(markFile, JSON.stringify({ startPageToken, at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ startPageToken }));
} else if (command === "report") {
  const mark = JSON.parse(readFileSync(markFile, "utf8"));
  const logged = new Map();
  const auditRoot = join(stateDir, "drive-audit");
  for (const run of existsSync(auditRoot) ? readdirSync(auditRoot) : []) {
    const log = join(auditRoot, run, "log.jsonl");
    if (!existsSync(log)) continue;
    for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      // A write that changed Drive and then reported an error counts too.
      if ((e.ok || e.written) && (e.op === "update" || e.op === "create") && e.at >= mark.at)
        logged.set(e.fileId, [...(logged.get(e.fileId) ?? []), { run, op: e.op, versionAfter: e.versionAfter }]);
    }
  }
  const changes = [];
  let pageToken = mark.startPageToken;
  while (pageToken) {
    const page = await api("/changes", {
      pageToken,
      includeRemoved: "true",
      pageSize: "1000",
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(name,mimeType,trashed,explicitlyTrashed,parents,modifiedTime,version,lastModifyingUser(displayName,me)))",
    }, bearer);
    changes.push(...page.changes);
    pageToken = page.nextPageToken;
  }
  const rows = changes.map((c) => {
    const flags = [];
    if (c.removed) flags.push("REMOVED");
    if (c.file?.trashed) flags.push("TRASHED");
    if (!logged.has(c.fileId)) flags.push("NOT_IN_GATEWAY_LOG");
    return { fileId: c.fileId, name: c.file?.name, time: c.time, modifiedBy: c.file?.lastModifyingUser?.displayName, parents: c.file?.parents, gateway: logged.get(c.fileId) ?? [], flags };
  });
  const missing = [...logged.keys()].filter((id) => !changes.some((c) => c.fileId === id));
  console.log(JSON.stringify({ since: mark.at, changes: rows.length, removedOrTrashed: rows.filter((r) => r.flags.includes("REMOVED") || r.flags.includes("TRASHED")), notInGatewayLog: rows.filter((r) => r.flags.includes("NOT_IN_GATEWAY_LOG")), gatewayWritesWithoutDriveChange: missing, rows }, null, 2));
} else {
  console.error("usage: drive-audit.mjs start <markFile> | report <markFile> <stateDir>");
  process.exit(2);
}
