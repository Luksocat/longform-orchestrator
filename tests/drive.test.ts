import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveGateway, driveWriteSummary, recordDifference, restoreDriveRecords } from "../src/drive.js";
import { TaskSchema, demoTask } from "../src/domain.js";
import { buildCliArguments } from "../src/providers.js";

/**
 * In-memory Drive: files by ID with a version that bumps on every write, and
 * revision IDs for stored (non-native) files. `before` runs ahead of each API
 * call, so a test can land someone else's edit at an exact moment.
 */
function fakeDrive() {
  const files = new Map<
    string,
    { id: string; name: string; mimeType: string; parents: string[]; version: number; body: string; trashed?: boolean; revisions?: string[] }
  >();
  files.set("folderAAAAAAAAAA", { id: "folderAAAAAAAAAA", name: "RESEARCH", mimeType: "application/vnd.google-apps.folder", parents: ["rootAAAAAAAAAAAA"], version: 1, body: "" });
  files.set("docAAAAAAAAAAAAA", { id: "docAAAAAAAAAAAAA", name: "Packet", mimeType: "application/vnd.google-apps.document", parents: ["folderAAAAAAAAAA"], version: 5, body: "# Packet v1\n" });
  files.set("otherAAAAAAAAAAA", { id: "otherAAAAAAAAAAA", name: "Other", mimeType: "text/markdown", parents: ["elsewhereAAAAAAA"], version: 2, body: "other\n", revisions: ["r1"] });
  files.set("notesAAAAAAAAAAA", { id: "notesAAAAAAAAAAA", name: "Notes.md", mimeType: "text/markdown", parents: ["folderAAAAAAAAAA"], version: 3, body: "notes v1\n", revisions: ["r1", "r2"] });
  const calls: { method: string; url: string }[] = [];
  let next = 0;
  let before: ((method: string, path: string) => void) | undefined;
  const meta = (f: any) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, version: String(f.version), trashed: !!f.trashed, ...(f.revisions ? { headRevisionId: f.revisions.at(-1) } : {}) });
  /** Someone else's edit, as Drive would record it. */
  const edit = (id: string, body: string) => {
    const f = files.get(id)!;
    f.body = body;
    f.version++;
    f.revisions?.push("r" + (f.revisions.length + 1));
  };
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fetcher = async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    const method = init.method ?? "GET";
    calls.push({ method, url: url.pathname + url.search });
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "ya29.test" });
    const upload = url.pathname.startsWith("/upload");
    const path = url.pathname.replace(/^\/upload/, "").replace("/drive/v3", "");
    before?.(method, path + (url.searchParams.get("alt") === "media" ? "?media" : ""));
    const revisions = /^\/files\/([^/]+)\/revisions$/.exec(path);
    if (method === "GET" && revisions)
      return json({ revisions: (files.get(revisions[1]!)!.revisions ?? []).map((id) => ({ id })) });
    const m = /^\/files\/([^/]+)(\/export)?$/.exec(path);
    if (method === "GET" && m) {
      const f = files.get(m[1]!);
      if (!f) return new Response("{}", { status: 404 });
      if (m[2] || url.searchParams.get("alt") === "media") return new Response(f.body, { status: 200, headers: { "content-type": "text/plain" } });
      return json(meta(f));
    }
    if (method === "GET" && path === "/files") {
      const folder = /'([^']+)' in parents/.exec(url.searchParams.get("q") ?? "")?.[1];
      return json({ files: [...files.values()].filter((f) => f.parents.includes(folder!)).map(meta) });
    }
    if (method === "PATCH" && upload && m) {
      edit(m[1]!, Buffer.from(init.body as Uint8Array).toString("utf8"));
      return json(meta(files.get(m[1]!)));
    }
    if (method === "POST" && upload && path === "/files") {
      const text = Buffer.from(init.body as Uint8Array).toString("utf8");
      const metadata = JSON.parse(/\r\n\r\n(\{.*\})\r\n/.exec(text)![1]!);
      const id = "newfile" + String(++next).padStart(9, "A");
      files.set(id, { id, name: metadata.name, mimeType: metadata.mimeType ?? "text/markdown", parents: metadata.parents, version: 1, body: text.split("\r\n\r\n")[2]!.split("\r\n--")[0]! });
      return json(meta(files.get(id)));
    }
    return new Response("unexpected", { status: 400 });
  };
  return {
    files,
    calls,
    fetcher,
    edit,
    /** Run `hook` ahead of every later API call. */
    before: (hook: typeof before) => {
      before = hook;
    },
  };
}

function setup(policy: { read: "ANY" | string[]; update?: string[]; createIn?: string[]; pack?: string[] }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-gw-")));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const creds = join(root, "creds");
  mkdirSync(creds);
  writeFileSync(join(creds, "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  writeFileSync(join(creds, "token.json"), JSON.stringify({ refresh_token: "r" }));
  const drive = fakeDrive();
  const gateway = new DriveGateway({
    credentials: { clientFile: join(creds, "client.json"), tokenFile: join(creds, "token.json") },
    policy: {
      read: policy.read,
      update: policy.update ?? [],
      createIn: policy.createIn ?? [],
      ...(policy.pack ? { pack: policy.pack } : {}),
    },
    workspace,
    auditDir: join(root, "audit", "run1"),
    runId: "run1",
    fetcher: drive.fetcher as any,
  });
  const socket = join(root, "drive.sock");
  const call = (op: string, ...args: string[]) =>
    new Promise<{ ok: boolean; result?: any; error?: string }>((resolve, reject) => {
      const c = connect(socket);
      const chunks: Buffer[] = [];
      c.on("connect", () => c.write(JSON.stringify({ op, args }) + "\n"));
      c.on("data", (d) => chunks.push(d));
      c.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
      c.on("error", reject);
    });
  return { root, workspace, drive, gateway, socket, call };
}

test("drive gateway: read, update and create are scoped, recorded and copied for review", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], update: ["docAAAAAAAAAAAAA"], createIn: ["folderAAAAAAAAAA"] });
  await s.gateway.prepare();
  await s.gateway.listen(s.socket);
  writeFileSync(join(s.workspace, "packet.md"), "# Packet v2\n");

  // Update needs a read in this run first.
  const early = await s.call("update", "docAAAAAAAAAAAAA", join(s.workspace, "packet.md"));
  assert.equal(early.ok, false);
  assert.match(early.error!, /READ_BEFORE_UPDATE_REQUIRED/);

  const read = await s.call("read", "docAAAAAAAAAAAAA");
  assert.ok(read.ok);
  assert.equal(read.result.content, "# Packet v1\n");
  assert.equal(read.result.exportedAs, "text/markdown");

  // Someone else edits it after the read: the update is refused.
  s.drive.files.get("docAAAAAAAAAAAAA")!.version++;
  const stale = await s.call("update", "docAAAAAAAAAAAAA", join(s.workspace, "packet.md"));
  assert.match(stale.error!, /CHANGED_SINCE_READ/);
  assert.ok((await s.call("read", "docAAAAAAAAAAAAA")).ok);

  const updated = await s.call("update", "docAAAAAAAAAAAAA", join(s.workspace, "packet.md"));
  assert.ok(updated.ok, updated.error);
  assert.equal(s.drive.files.get("docAAAAAAAAAAAAA")!.body, "# Packet v2\n");
  const patch = s.drive.calls.find((c) => c.method === "PATCH")!;
  assert.match(patch.url, /uploadType=media/);

  const created = await s.call("create", "folderAAAAAAAAAA", "Erratum", join(s.workspace, "packet.md"), "doc");
  assert.ok(created.ok, created.error);
  assert.equal(created.result.name, "Erratum");

  // Out of scope: other folder's file, update of a read-only file, create elsewhere.
  assert.match((await s.call("read", "otherAAAAAAAAAAA")).error!, /OUTSIDE_TASK_DRIVE_SCOPE/);
  assert.match((await s.call("update", "otherAAAAAAAAAAA", join(s.workspace, "packet.md"))).error!, /UPDATE_OUTSIDE/);
  assert.match((await s.call("create", "elsewhereAAAAAAA", "x", join(s.workspace, "packet.md"))).error!, /CREATE_OUTSIDE/);
  assert.match((await s.call("search", "Packet")).error!, /SEARCH_REQUIRES_READ_ANY/);

  // Nothing destructive exists, whatever is asked.
  for (const op of ["delete", "trash", "move", "rename", "share"])
    assert.match((await s.call(op, "docAAAAAAAAAAAAA")).error!, /UNSUPPORTED_OPERATION/);
  assert.ok(!s.drive.calls.some((c) => c.method === "DELETE"));
  assert.ok(!s.drive.files.get("docAAAAAAAAAAAAA")!.trashed);

  // Uploads come only from regular workspace files.
  writeFileSync(join(s.root, "outside.md"), "x");
  assert.match((await s.call("update", "docAAAAAAAAAAAAA", join(s.root, "outside.md"))).error!, /OUTSIDE_WORKSPACE/);
  symlinkSync(join(s.root, "outside.md"), join(s.workspace, "link.md"));
  assert.match((await s.call("update", "docAAAAAAAAAAAAA", join(s.workspace, "link.md"))).error!, /OUTSIDE_WORKSPACE/);

  await s.gateway.close();
  const copy = s.gateway.finalize();
  assert.ok(copy.copied, copy.error);
  const record = join(s.workspace, "drive-changes", "run1");
  const before = readdirSync(join(record, "before"));
  assert.equal(before.length, 1);
  assert.equal(readFileSync(join(record, "before", before[0]!), "utf8"), "# Packet v1\n");
  assert.equal(readdirSync(join(record, "after")).length, 2);
  const log = readFileSync(join(record, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    log.filter((e) => e.ok && (e.op === "update" || e.op === "create")).map((e) => e.op),
    ["update", "create"],
  );
  assert.ok(log.some((e) => !e.ok && e.op === "delete"));
  // Drive's metadata responses are in the record, so reviewers can check placement and type.
  const create = log.find((e) => e.ok && e.op === "create");
  assert.deepEqual(create.meta.parents, ["folderAAAAAAAAAA"]);
  assert.equal(create.meta.mimeType, "application/vnd.google-apps.document");
  const update = log.find((e) => e.ok && e.op === "update");
  for (const written of [update, create]) {
    assert.ok(Date.parse(written.at) <= Date.parse(written.writeStartedAt));
    assert.ok(Date.parse(written.writeStartedAt) <= Date.parse(written.writeAcknowledgedAt));
    assert.ok(Date.parse(written.writeAcknowledgedAt) <= Date.parse(written.completedAt));
  }
  assert.equal(update.metaBefore.version, "6");
  assert.equal(update.meta.version, "7");
  assert.equal(log.find((e) => e.ok && e.op === "read").meta.id, "docAAAAAAAAAAAAA");
});

test("drive gateway: an acknowledged write keeps its identity and interval if custody recording fails", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], createIn: ["folderAAAAAAAAAA"] });
  try {
    (s.gateway as any).options.writes = {
      begin: () => "intent-recorded",
      end: () => { throw new Error("outcome journal unavailable"); },
    };
    writeFileSync(join(s.workspace, "created.md"), "created even though its custody outcome could not be recorded\n");
    await s.gateway.listen(s.socket);
    const result = await s.call("create", "folderAAAAAAAAAA", "created.md", join(s.workspace, "created.md"));
    assert.equal(result.ok, false);
    assert.match(result.error!, /DRIVE_CUSTODY_UNCERTAIN/);
    const entry = s.gateway.log.find((e) => e.op === "create")!;
    assert.equal(entry.written, true);
    assert.ok(s.drive.files.has(entry.fileId!));
    assert.ok(Date.parse(entry.at) <= Date.parse(entry.writeStartedAt!));
    assert.ok(Date.parse(entry.writeStartedAt!) <= Date.parse(entry.writeAcknowledgedAt!));
    assert.ok(Date.parse(entry.writeAcknowledgedAt!) <= Date.parse(entry.completedAt!));
  } finally {
    await s.gateway.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("drive gateway: an edit made while the pre-image is fetched is refused, not overwritten", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], update: ["docAAAAAAAAAAAAA"] });
  await s.gateway.listen(s.socket);
  writeFileSync(join(s.workspace, "packet.md"), "# Packet v2\n");
  assert.ok((await s.call("read", "docAAAAAAAAAAAAA")).ok);
  // The owner edits the document while the gateway fetches its pre-image.
  let edited = false;
  s.drive.before((method, path) => {
    if (!edited && method === "GET" && path.endsWith("/export")) {
      edited = true;
      s.drive.edit("docAAAAAAAAAAAAA", "# Packet v1, owner's edit\n");
    }
  });
  const update = await s.call("update", "docAAAAAAAAAAAAA", join(s.workspace, "packet.md"));
  assert.equal(update.ok, false);
  assert.match(update.error!, /CHANGED_SINCE_READ/);
  assert.equal(s.drive.files.get("docAAAAAAAAAAAAA")!.body, "# Packet v1, owner's edit\n");
  assert.ok(!s.drive.calls.some((c) => c.method === "PATCH"));
  await s.gateway.close();
});

test("drive gateway: a stored file's update reports an edit that reached Drive around the write", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], update: ["notesAAAAAAAAAAA"] });
  await s.gateway.listen(s.socket);
  writeFileSync(join(s.workspace, "notes.md"), "notes v2\n");
  // An ordinary update passes the revision check.
  assert.ok((await s.call("read", "notesAAAAAAAAAAA")).ok);
  const clean = await s.call("update", "notesAAAAAAAAAAA", join(s.workspace, "notes.md"));
  assert.ok(clean.ok, clean.error);
  // Someone else's edit lands in the moment between the last check and the upload.
  writeFileSync(join(s.workspace, "notes.md"), "notes v3\n");
  assert.ok((await s.call("read", "notesAAAAAAAAAAA")).ok);
  let edited = false;
  s.drive.before((method) => {
    if (!edited && method === "PATCH") {
      edited = true;
      s.drive.edit("notesAAAAAAAAAAA", "notes, owner's edit\n");
    }
  });
  const raced = await s.call("update", "notesAAAAAAAAAAA", join(s.workspace, "notes.md"));
  assert.equal(raced.ok, false);
  assert.match(raced.error!, /CONCURRENT_EDIT: the content was replaced/);
  // The overwritten edit is still in the file's history.
  assert.deepEqual(s.drive.files.get("notesAAAAAAAAAAA")!.revisions, ["r1", "r2", "r3", "r4", "r5"]);
  // A further update needs a fresh read first.
  const again = await s.call("update", "notesAAAAAAAAAAA", join(s.workspace, "notes.md"));
  assert.match(again.error!, /CHANGED_SINCE_READ/);
  await s.gateway.close();
  const copy = s.gateway.finalize();
  assert.ok(copy.copied, copy.error);
  const log = readFileSync(join(s.workspace, "drive-changes", "run1", "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.op === "update");
  assert.deepEqual(
    log.map((e) => [e.ok, !!e.written]),
    [
      [true, true],
      [false, true],
      [false, false],
    ],
  );
  // The run's evidence lists the conflicted write with its error; only the
  // update that changed nothing counts as refused.
  const summary = driveWriteSummary(s.gateway.log);
  assert.deepEqual(summary.writes.map((w) => (w as { error?: string }).error?.split(":")[0]), [undefined, "CONCURRENT_EDIT"]);
  assert.equal(summary.refused, 1);
});

test("drive gateway: a planted symlink in the record folder stops the copy instead of writing through it", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"] });
  await s.gateway.listen(s.socket);
  assert.ok((await s.call("read", "docAAAAAAAAAAAAA")).ok);
  await s.gateway.close();
  const target = join(s.root, "escape");
  mkdirSync(target);
  mkdirSync(join(s.workspace, "drive-changes"));
  symlinkSync(target, join(s.workspace, "drive-changes", "run1"));
  const copy = s.gateway.finalize();
  assert.equal(copy.copied, false);
  assert.deepEqual(readdirSync(target), []);
  // The host copy is untouched.
  assert.ok(existsSync(join(s.root, "audit", "run1", "log.jsonl")));
});

test("drive gateway: a source pack is read before launch, recorded, copied in and counts as read", async () => {
  const s = setup({
    read: ["folderAAAAAAAAAA"],
    update: ["notesAAAAAAAAAAA"],
    pack: ["docAAAAAAAAAAAAA", "notesAAAAAAAAAAA"],
  });
  try {
    await s.gateway.prepare();
    const manifest = await s.gateway.preparePack();
    assert.deepEqual(
      manifest.map((f) => [f.id, f.version, f.path, f.exportedAs]),
      [
        ["docAAAAAAAAAAAAA", "5", "docAAAAAAAAAAAAA.md", "text/markdown"],
        ["notesAAAAAAAAAAA", "3", "notesAAAAAAAAAAA.md", "text/markdown"],
      ],
    );
    // The worker's copy is in place before it starts, with the manifest.
    const inWorkspace = join(s.workspace, "drive-changes", "run1", "pack");
    assert.equal(readFileSync(join(inWorkspace, "docAAAAAAAAAAAAA.md"), "utf8"), "# Packet v1\n");
    assert.equal(readFileSync(join(inWorkspace, "notesAAAAAAAAAAA.md"), "utf8"), "notes v1\n");
    assert.deepEqual(JSON.parse(readFileSync(join(inWorkspace, "MANIFEST.json"), "utf8")), manifest);
    assert.equal(
      manifest[0]!.sha256,
      createHash("sha256").update("# Packet v1\n").digest("hex"),
    );
    // Each fetch is logged as a "pack" entry in the host record.
    const host = join(s.root, "audit", "run1");
    const logged = readFileSync(join(host, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      logged.map((e) => [e.op, e.ok, e.fileId, e.versionBefore, e.record]),
      [
        ["pack", true, "docAAAAAAAAAAAAA", "5", "pack/docAAAAAAAAAAAAA.md"],
        ["pack", true, "notesAAAAAAAAAAA", "3", "pack/notesAAAAAAAAAAA.md"],
      ],
    );
    // A pack file counts as read in this run: an update in scope needs no second read.
    await s.gateway.listen(s.socket);
    writeFileSync(join(s.workspace, "notes.md"), "notes v2\n");
    const updated = await s.call("update", "notesAAAAAAAAAAA", join(s.workspace, "notes.md"));
    assert.ok(updated.ok, updated.error);
    // But only at the version fetched.
    s.drive.edit("notesAAAAAAAAAAA", "notes, owner's edit\n");
    writeFileSync(join(s.workspace, "notes.md"), "notes v3\n");
    const stale = await s.call("update", "notesAAAAAAAAAAA", join(s.workspace, "notes.md"));
    assert.match(stale.error!, /CHANGED_SINCE_READ/);
    // A worker that edits its copy cannot mislead the reviewer: finalize restores it.
    writeFileSync(join(inWorkspace, "docAAAAAAAAAAAAA.md"), "# Forged\n");
    await s.gateway.close();
    const copy = s.gateway.finalize();
    assert.ok(copy.copied, copy.error);
    assert.equal(readFileSync(join(inWorkspace, "docAAAAAAAAAAAAA.md"), "utf8"), "# Packet v1\n");
  } finally {
    // A failed assertion must not leave the socket holding the test open.
    await s.gateway.close();
  }
});

test("drive gateway: a pack file outside the read scope stops the run before launch", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], pack: ["docAAAAAAAAAAAAA", "otherAAAAAAAAAAA"] });
  await s.gateway.prepare();
  await assert.rejects(s.gateway.preparePack(), /OUTSIDE_TASK_DRIVE_SCOPE/);
  const logged = readFileSync(join(s.root, "audit", "run1", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    logged.map((e) => [e.op, e.ok, e.fileId]),
    [
      ["pack", true, "docAAAAAAAAAAAAA"],
      ["pack", false, "otherAAAAAAAAAAA"],
    ],
  );
  // Nothing partial reaches the workspace.
  assert.ok(!existsSync(join(s.workspace, "drive-changes")));
  // A pack past the size limit stops the run too, before anything reaches the workspace.
  const big = setup({ read: ["folderAAAAAAAAAA"], pack: ["docAAAAAAAAAAAAA", "notesAAAAAAAAAAA"] });
  (big.gateway as unknown as { options: { maxPackBytes: number } }).options.maxPackBytes = 15;
  await assert.rejects(big.gateway.preparePack(), /PACK_TOO_LARGE: the pack passes 15 bytes at notesAAAAAAAAAAA/);
  assert.ok(!existsSync(join(big.workspace, "drive-changes")));
  // The bytes read are still kept and logged (review r1 finding R4).
  const bigLog = readFileSync(join(big.root, "audit", "run1", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(bigLog[1].ok, false);
  assert.equal(bigLog[1].record, "pack/notesAAAAAAAAAAA.md");
  assert.equal(bigLog[1].sha256, createHash("sha256").update("notes v1\n").digest("hex"));
  assert.equal(readFileSync(join(big.root, "audit", "run1", "pack", "notesAAAAAAAAAAA.md"), "utf8"), "notes v1\n");
  // Without a pack nothing is fetched.
  const plain = setup({ read: "ANY" });
  assert.deepEqual(await plain.gateway.preparePack(), []);
  assert.equal(plain.drive.calls.length, 0);
});

test("a task's source pack must list distinct files and is absent by default", () => {
  const base = demoTask("P", {
    operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
    writePaths: ["out", "drive-changes"],
    drive: { read: "ANY", update: [], createIn: [] },
  });
  assert.equal("pack" in base.drive!, false);
  const withPack = (pack: string[]) =>
    TaskSchema.safeParse({ ...base, drive: { ...base.drive, pack } }).success;
  assert.ok(withPack(["docAAAAAAAAAAAAA"]));
  assert.ok(!withPack([]));
  assert.ok(!withPack(["docAAAAAAAAAAAAA", "docAAAAAAAAAAAAA"]));
  assert.ok(!withPack(["bad id"]));
});

test("task Drive scope requires READ_DRIVE, matching WRITE_DRIVE and the drive-changes path", () => {
  const base = demoTask("D", {
    operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
    writePaths: ["out", "drive-changes"],
    drive: { read: ["folderAAAAAAAAAA"], update: ["docAAAAAAAAAAAAA"], createIn: [] },
  });
  assert.ok(TaskSchema.safeParse(base).success);
  assert.ok(!TaskSchema.safeParse({ ...base, operations: ["READ_LOCAL", "WRITE_LOCAL", "WRITE_DRIVE"] }).success);
  assert.ok(!TaskSchema.safeParse({ ...base, operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"] }).success);
  assert.ok(!TaskSchema.safeParse({ ...base, writePaths: ["out"] }).success);
  assert.ok(
    TaskSchema.safeParse({
      ...base,
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
      drive: { read: "ANY", update: [], createIn: [] },
    }).success,
  );
  // Legacy tasks without a Drive scope are unchanged.
  assert.equal(TaskSchema.parse(demoTask("L")).drive, undefined);
});

test("Drive workers get only the gateway client as a shell; Codex gets socket access", () => {
  const request = {
    runId: "r",
    taskId: "T",
    model: "m",
    effort: "low",
    role: "worker" as const,
    cwd: "/x",
    brief: "b",
    deadlineMs: 1000,
    filesystemPolicy: { writablePaths: ["out", "drive-changes"] },
    drivePolicy: { read: "ANY" as const, update: [], createIn: [] },
  };
  const claude = buildCliArguments("claude", { ...request, provider: "claude" }, true, { subscriptionAuth: true });
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Edit,Write,Bash");
  assert.equal(
    claude[claude.indexOf("--allowedTools") + 1],
    "Read,Edit,Write,Bash(/run/longform-shim/longform-drive:*)",
  );
  const codex = buildCliArguments("codex", { ...request, provider: "codex" }, true, { subscriptionAuth: true });
  assert.ok(codex.includes("sandbox_workspace_write.network_access=true"));
  // Without a Drive scope nothing changes.
  const plain = buildCliArguments("claude", { ...request, provider: "claude", drivePolicy: undefined }, true, { subscriptionAuth: true });
  assert.equal(plain[plain.indexOf("--tools") + 1], "Read,Edit,Write");
  const plainCodex = buildCliArguments("codex", { ...request, provider: "codex", drivePolicy: undefined }, true, { subscriptionAuth: true });
  assert.ok(!plainCodex.includes("sandbox_workspace_write.network_access=true"));
});

test("drive gateway: hard links a worker plants in its record cannot change what the reviewer sees", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], pack: ["docAAAAAAAAAAAAA", "notesAAAAAAAAAAA"] });
  try {
    await s.gateway.prepare();
    await s.gateway.preparePack();
    const pack = join(s.workspace, "drive-changes", "run1", "pack");
    // The worker links one pack file to the other, and its own output to a pack file.
    rmSync(join(pack, "docAAAAAAAAAAAAA.md"));
    linkSync(join(pack, "notesAAAAAAAAAAA.md"), join(pack, "docAAAAAAAAAAAAA.md"));
    mkdirSync(join(s.workspace, "out"));
    writeFileSync(join(s.workspace, "out", "work.md"), "my work\n");
    rmSync(join(pack, "MANIFEST.json"));
    linkSync(join(s.workspace, "out", "work.md"), join(pack, "MANIFEST.json"));
    await s.gateway.close();
    const copy = s.gateway.finalize();
    assert.ok(copy.copied, copy.error);
    // Each path holds the host's bytes, and the worker's own file is untouched.
    assert.equal(readFileSync(join(pack, "docAAAAAAAAAAAAA.md"), "utf8"), "# Packet v1\n");
    assert.equal(readFileSync(join(pack, "notesAAAAAAAAAAA.md"), "utf8"), "notes v1\n");
    assert.equal(readFileSync(join(s.workspace, "out", "work.md"), "utf8"), "my work\n");
    assert.equal(JSON.parse(readFileSync(join(pack, "MANIFEST.json"), "utf8")).length, 2);
    // No temporary file is left behind.
    assert.ok(!readdirSync(pack).some((f) => f.startsWith(".longform-copy-")));
  } finally {
    await s.gateway.close();
  }
});

test("drive gateway: cancelling the run stops the pack fetch, and nothing reaches the workspace", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], pack: ["docAAAAAAAAAAAAA", "notesAAAAAAAAAAA"] });
  await s.gateway.prepare();
  const stop = new AbortController();
  // The second file's content arrives only once the test lets it.
  let reached!: () => void;
  const atSecond = new Promise<void>((r) => (reached = r));
  const inner = (s.gateway as unknown as { options: { fetcher: (u: string, i: RequestInit) => Promise<Response> } }).options;
  const original = inner.fetcher;
  inner.fetcher = async (url: string, init: RequestInit) => {
    if (url.includes("notesAAAAAAAAAAA") && url.includes("alt=media")) {
      reached();
      await new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      );
    }
    return original(url, init);
  };
  const fetching = s.gateway.preparePack(stop.signal);
  await atSecond;
  stop.abort(new Error("RUN_CANCELLED"));
  await assert.rejects(fetching, /RUN_CANCELLED/);
  assert.ok(!existsSync(join(s.workspace, "drive-changes")));
  // The worker's own calls later are not tied to that signal.
  inner.fetcher = original;
  await s.gateway.listen(s.socket);
  assert.ok((await s.call("read", "notesAAAAAAAAAAA")).ok);
  await s.gateway.close();
});

test("after a run every Drive record in the workspace is the host's; a planted file or folder fails it (review r2 R6)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "drive-restore-")));
  try {
    const audit = join(root, "audit"), workspace = join(root, "ws");
    // Two earlier runs' host records, and the copies a later worker carries.
    for (const run of ["run1", "run2"]) {
      mkdirSync(join(audit, run, "pack"), { recursive: true });
      writeFileSync(join(audit, run, "log.jsonl"), run + " log\n");
      writeFileSync(join(audit, run, "pack", "docAAAAAAAAAAAAA.md"), run + " source\n");
      mkdirSync(join(workspace, "drive-changes", run, "pack"), { recursive: true });
      writeFileSync(join(workspace, "drive-changes", run, "log.jsonl"), run + " log\n");
      writeFileSync(join(workspace, "drive-changes", run, "pack", "docAAAAAAAAAAAAA.md"), run + " source\n");
    }
    // The later worker rewrites an earlier run's pack file and removes its log.
    writeFileSync(join(workspace, "drive-changes", "run1", "pack", "docAAAAAAAAAAAAA.md"), "invented\n");
    rmSync(join(workspace, "drive-changes", "run2", "log.jsonl"));
    assert.equal(recordDifference(join(audit, "run1"), join(workspace, "drive-changes", "run1")), "changed pack/docAAAAAAAAAAAAA.md");
    const allowed = new Set(["run1", "run2"]);
    const restored = restoreDriveRecords(workspace, audit, allowed);
    assert.equal(restored.error, undefined);
    assert.deepEqual(restored.restored.sort(), ["run1", "run2"]);
    assert.equal(readFileSync(join(workspace, "drive-changes", "run1", "pack", "docAAAAAAAAAAAAA.md"), "utf8"), "run1 source\n");
    assert.equal(readFileSync(join(workspace, "drive-changes", "run2", "log.jsonl"), "utf8"), "run2 log\n");
    assert.equal(recordDifference(join(audit, "run1"), join(workspace, "drive-changes", "run1")), undefined);
    // A file the host record does not have fails the run, and is kept.
    writeFileSync(join(workspace, "drive-changes", "run1", "pack", "extra.md"), "planted\n");
    assert.match(restoreDriveRecords(workspace, audit, allowed).error!, /DRIVE_RECORD_ALTERED:run1\/pack\/extra\.md/);
    assert.ok(existsSync(join(workspace, "drive-changes", "run1", "pack", "extra.md")));
    assert.equal(recordDifference(join(audit, "run1"), join(workspace, "drive-changes", "run1")), "extra pack/extra.md");
    rmSync(join(workspace, "drive-changes", "run1", "pack", "extra.md"));
    // So does a record folder with no host record.
    mkdirSync(join(workspace, "drive-changes", "invented-run"));
    assert.match(restoreDriveRecords(workspace, audit, allowed).error!, /DRIVE_RECORD_UNKNOWN:invented-run/);
    rmSync(join(workspace, "drive-changes", "invented-run"), { recursive: true });
    // A folder named after a real run the work did not carry is never filled
    // from the host (review r3 R7): it could import another task's record.
    mkdirSync(join(audit, "other-task-run", "reads"), { recursive: true });
    writeFileSync(join(audit, "other-task-run", "reads", "secret.md"), "another task's read\n");
    mkdirSync(join(workspace, "drive-changes", "other-task-run"));
    assert.match(restoreDriveRecords(workspace, audit, allowed).error!, /DRIVE_RECORD_UNKNOWN:other-task-run/);
    assert.deepEqual(readdirSync(join(workspace, "drive-changes", "other-task-run")), []);
    rmSync(join(workspace, "drive-changes", "other-task-run"), { recursive: true });
    // An allowed record the worker removed comes back.
    rmSync(join(workspace, "drive-changes", "run2"), { recursive: true });
    assert.equal(restoreDriveRecords(workspace, audit, allowed).error, undefined);
    assert.equal(readFileSync(join(workspace, "drive-changes", "run2", "log.jsonl"), "utf8"), "run2 log\n");
    // A workspace without records is left alone.
    assert.deepEqual(restoreDriveRecords(join(root, "empty"), audit, new Set()), { restored: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("drive gateway: a file edited during its download is downloaded again, and the stale copy kept (review r4 R9)", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], update: ["notesAAAAAAAAAAA"], pack: ["notesAAAAAAAAAAA"] });
  try {
    await s.gateway.prepare();
    // Someone edits the file while the pack downloads it, once.
    let edited = false;
    s.drive.before((method, path) => {
      if (!edited && method === "GET" && path === "/files/notesAAAAAAAAAAA?media") {
        edited = true;
        s.drive.edit("notesAAAAAAAAAAA", "notes, edited meanwhile\n");
      }
    });
    const [file] = await s.gateway.preparePack();
    // The pack holds the content of the version it names.
    assert.equal(file!.version, "4");
    const pack = join(s.workspace, "drive-changes", "run1", "pack", "notesAAAAAAAAAAA.md");
    assert.equal(readFileSync(pack, "utf8"), "notes, edited meanwhile\n");
    const entry = s.gateway.log.find((e) => e.op === "pack")!;
    assert.equal(entry.versionBefore, "4");
    assert.equal(entry.superseded!.length, 1);
    assert.equal(entry.superseded![0]!.version, "3");
    // (The edit landed before that download's body was sent, so the stale
    // copy holds the new text under the old version: exactly the mismatch.)
    assert.match(entry.superseded![0]!.record, /^pack-downloads\//);
    assert.equal(readFileSync(join(s.root, "audit", "run1", entry.superseded![0]!.record), "utf8"), "notes, edited meanwhile\n");
    // A worker's own read is held to the same rule.
    s.drive.before(undefined);
    let again = false;
    s.drive.before((method, path) => {
      if (!again && method === "GET" && path === "/files/notesAAAAAAAAAAA?media") {
        again = true;
        s.drive.edit("notesAAAAAAAAAAA", "notes, edited again\n");
      }
    });
    await s.gateway.listen(s.socket);
    const read = await s.call("read", "notesAAAAAAAAAAA");
    assert.ok(read.ok, read.error);
    assert.equal(read.result.content, "notes, edited again\n");
    assert.equal(read.result.meta.version, "5");
    // A file that keeps changing stops the read.
    s.drive.before((method, path) => {
      if (method === "GET" && path === "/files/notesAAAAAAAAAAA?media") s.drive.edit("notesAAAAAAAAAAA", "churn " + Date.now() + "\n");
    });
    assert.match((await s.call("read", "notesAAAAAAAAAAA")).error!, /SOURCE_CHANGING/);
  } finally {
    await s.gateway.close();
  }
});

test("drive gateway: a create counts as written even when its readback then fails (review C1)", async () => {
  const s = setup({ read: ["folderAAAAAAAAAA"], createIn: ["folderAAAAAAAAAA"] });
  try {
    await s.gateway.listen(s.socket);
    writeFileSync(join(s.workspace, "new.md"), "new\n");
    s.drive.before((method, path) => {
      if (method === "GET" && path.startsWith("/files/newfile")) throw new Error("readback unavailable");
    });
    const created = await s.call("create", "folderAAAAAAAAAA", "New", join(s.workspace, "new.md"));
    assert.equal(created.ok, false);
    const entry = s.gateway.log.find((e) => e.op === "create")!;
    assert.equal(entry.written, true);
    assert.equal(driveWriteSummary(s.gateway.log).writes.length, 1);
    assert.equal(driveWriteSummary(s.gateway.log).refused, 0);
  } finally {
    await s.gateway.close();
  }
});

test("drive gateway: a download whose version check fails is still kept (review r5 R10)", async () => {
  for (const kind of ["pack", "read"] as const) {
    const s = setup({ read: ["folderAAAAAAAAAA"], ...(kind === "pack" ? { pack: ["notesAAAAAAAAAAA"] } : {}) });
    try {
      await s.gateway.prepare();
      // The metadata check after the download fails.
      let downloaded = false;
      s.drive.before((method, path) => {
        if (method === "GET" && path === "/files/notesAAAAAAAAAAA?media") downloaded = true;
        else if (downloaded && method === "GET" && path === "/files/notesAAAAAAAAAAA") throw new Error("metadata unavailable");
      });
      if (kind === "pack") await assert.rejects(s.gateway.preparePack(), /metadata unavailable/);
      else {
        await s.gateway.listen(s.socket);
        assert.match((await s.call("read", "notesAAAAAAAAAAA")).error!, /metadata unavailable/);
      }
      const entry = s.gateway.log.find((e) => e.op === kind)!;
      assert.equal(entry.ok, false);
      assert.equal(entry.unverified!.version, "3");
      assert.equal(readFileSync(join(s.root, "audit", "run1", entry.unverified!.record), "utf8"), "notes v1\n");
      // Nothing reached the workspace, and nothing counts as read.
      assert.ok(!existsSync(join(s.workspace, "drive-changes")));
    } finally {
      await s.gateway.close();
    }
  }
});

test("drive gateway: text in another encoding reads back as its exact bytes (review K20)", async () => {
  const s = setup({ read: ["notesAAAAAAAAAAA"] });
  try {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    s.drive.files.get("notesAAAAAAAAAAA")!.body = latin1 as any;
    await s.gateway.prepare();
    // As filing reads a file back, and as a worker's read arrives.
    const read = (await s.gateway.operate("read", ["notesAAAAAAAAAAA"])) as { content: string; encoding: "utf8" | "base64" };
    assert.equal(read.encoding, "base64");
    assert.deepEqual([...Buffer.from(read.content, read.encoding)], [...latin1]);
    // UTF-8 text still reads as text.
    s.drive.files.get("notesAAAAAAAAAAA")!.body = "café\n";
    const text = (await s.gateway.operate("read", ["notesAAAAAAAAAAA"])) as { content: string; encoding: string };
    assert.deepEqual([text.encoding, text.content], ["utf8", "café\n"]);
  } finally {
    await s.gateway.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});
