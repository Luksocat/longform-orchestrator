import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { checkFilingPlan, fileToDrive, FilingPlanSchema } from "../src/filing.js";
import { Controller } from "../src/controller.js";
import { demoTask, specDigest, TaskSchema } from "../src/domain.js";
import { SqliteStore } from "../src/store.js";
import { fakeDrive } from "./fake-drive.js";

// Filing by a tool, not a model .

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-filing-")));
  const creds = join(root, "creds");
  mkdirSync(creds);
  writeFileSync(join(creds, "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  writeFileSync(join(creds, "token.json"), JSON.stringify({ refresh_token: "r" }));
  writeFileSync(join(root, "record.md"), "# Review record\n\nExact bytes, kept.\n");
  writeFileSync(join(root, "notes.md"), "notes v2\n");
  return {
    root,
    drive: fakeDrive(),
    credentials: { clientFile: join(creds, "client.json"), tokenFile: join(creds, "token.json") },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
const scope = { read: "ANY" as const, update: ["notesAAAAAAAAAAA"], createIn: ["folderAAAAAAAAAA"] };
/** An owner-request source, as the orchestrator records one, for a real test task. */
function ownerSource(c: Controller, taskId: string) {
  const actor = c.localActor();
  const id = "owner-request-" + taskId;
  const text = "File the records.";
  return {
    id,
    envelope: {
      id,
      taskId,
      kind: "LOCAL",
      uri: "request:" + taskId,
      revision: "r1",
      digest: createHash("sha256").update(text).digest("hex"),
      retrievedAt: new Date().toISOString(),
      authorityTier: "OWNER_DECISION",
      authentication: "LOCAL_OWNER_REQUEST",
      currentness: "CURRENT_AT_RETRIEVAL",
      claims: ["the owner's request"],
      metadata: {},
    },
  };
}


test("a filing plan is refused outside the task's scope or for a missing file", () => {
  const s = setup();
  try {
    const plan = FilingPlanSchema.parse({
      create: [{ folderId: "elsewhereAAAAAAA", name: "x", path: join(s.root, "record.md") }],
      update: [
        { fileId: "otherAAAAAAAAAAA", path: join(s.root, "notes.md") },
        { fileId: "notesAAAAAAAAAAA", path: join(s.root, "missing.md") },
      ],
      reason: "file the review records",
      sourceRef: "test",
    });
    assert.deepEqual(checkFilingPlan(plan, scope), [
      "create outside the task's Drive scope: folder elsewhereAAAAAAA",
      "update outside the task's Drive scope: file otherAAAAAAAAAAA",
      "not a regular file up to 25 MiB: " + join(s.root, "missing.md"),
    ]);
    assert.ok(!FilingPlanSchema.safeParse({ reason: "r", sourceRef: "s" }).success);
  } finally {
    s.close();
  }
});

test("filing sends exact bytes through the gateway, reads them back and keeps the host record", async () => {
  const s = setup();
  try {
    const plan = FilingPlanSchema.parse({
      create: [{ folderId: "folderAAAAAAAAAA", name: "L11_REVIEW_RECORD.md", path: join(s.root, "record.md") }],
      update: [{ fileId: "notesAAAAAAAAAAA", path: join(s.root, "notes.md") }],
      reason: "file the review records",
      sourceRef: "test",
    });
    const auditDir = join(s.root, "audit");
    const filed = await fileToDrive({
      plan,
      scope,
      credentials: s.credentials,
      workspace: join(s.root, "filing"),
      auditDir,
      fetcher: s.drive.fetcher as any,
    });
    assert.equal(filed.complete, true);
    assert.deepEqual(
      filed.results.map((r) => [r.op, r.readback, r.bytes]),
      [
        ["update", "MATCH", 9],
        ["create", "MATCH", 36],
      ],
    );
    assert.equal(s.drive.files.get("notesAAAAAAAAAAA")!.body, "notes v2\n");
    const created = [...s.drive.files.values()].find((f) => f.name === "L11_REVIEW_RECORD.md")!;
    assert.equal(created.body, "# Review record\n\nExact bytes, kept.\n");
    assert.equal(filed.results[1]!.fileId, created.id);
    // Every call is in the host record: the read before the update, the
    // update, the create and the readbacks.
    const log = readFileSync(join(auditDir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.op, e.ok]), [
      ["read", true],
      ["update", true],
      ["read", true],
      ["create", true],
      ["read", true],
    ]);
  } finally {
    s.close();
  }
});

test("filing stops at the first refusal and says what was done", async () => {
  const s = setup();
  try {
    // Someone else edits the file after the read, while the update takes its
    // pre-image (the second download of the file).
    let downloads = 0;
    s.drive.before((method, path) => {
      if (method === "GET" && path === "/files/notesAAAAAAAAAAA?media" && ++downloads === 2)
        s.drive.edit("notesAAAAAAAAAAA", "the owner's edit\n");
    });
    const filed = await fileToDrive({
      plan: FilingPlanSchema.parse({
        update: [{ fileId: "notesAAAAAAAAAAA", path: join(s.root, "notes.md") }],
        create: [{ folderId: "folderAAAAAAAAAA", name: "never", path: join(s.root, "record.md") }],
        reason: "r",
        sourceRef: "s",
      }),
      scope,
      credentials: s.credentials,
      workspace: join(s.root, "filing"),
      auditDir: join(s.root, "audit"),
      fetcher: s.drive.fetcher as any,
    });
    assert.equal(filed.complete, false);
    assert.equal(filed.results.length, 1);
    assert.match(filed.results[0]!.error!, /CHANGED_SINCE_READ/);
    assert.equal(s.drive.files.get("notesAAAAAAAAAAA")!.body, "the owner's edit\n");
    assert.ok(![...s.drive.files.values()].some((f) => f.name === "never"));
  } finally {
    s.close();
  }
});

test("only a real task with granted Drive writes can be filed for", () => {
  const root = mkdtempSync(join(tmpdir(), "longform-filing-scope-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  try {
    const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "w"), allowRealLocalTasks: true });
    const actor = c.localActor();
    const source = ownerSource(c, "F");
    const t = TaskSchema.parse({
      ...demoTask("F", {
        sources: [{ evidenceId: source.id, revision: "r1", digest: source.envelope.digest }],
        simulation: false,
        risk: "LOW",
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
        writePaths: ["out", "drive-changes"],
        drive: { read: "ANY", update: ["notesAAAAAAAAAAA"], createIn: [] },
        dimensions: {
          authorization: "EXPLICIT",
          sourceEffectuation: "CANDIDATE",
          implementation: "NOT_STARTED",
          review: "NONE",
          release: "NOT_AUTHORIZED",
        },
      }),
    });
    c.importTasks([t], actor);
    c.addEvidence(source.envelope, actor);
    assert.throws(() => c.filingScope("F", actor), /DRIVE_WRITE_NOT_AUTHORIZED/);
    c.grant("F", { id: randomUUID(), operations: t.operations, paths: t.writePaths, decisionText: "file", sourceRef: "test" }, actor);
    assert.deepEqual(c.filingScope("F", actor).update, ["notesAAAAAAAAAAA"]);
    c.recordFiling("F", { id: "x", results: [] }, actor);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("filing stops at a readback that does not match (review K6)", async () => {
  const s = setup();
  try {
    writeFileSync(join(s.root, "notes2.md"), "second\n");
    // Drive hands back other bytes for the first file's readback.
    let downloads = 0;
    s.drive.before((method, path) => {
      // 1 read, 2 the update's pre-image, 3 its after-copy, 4 the readback.
      if (method === "GET" && path === "/files/notesAAAAAAAAAAA?media" && ++downloads === 4)
        s.drive.edit("notesAAAAAAAAAAA", "not what was sent\n");
    });
    const filed = await fileToDrive({
      plan: FilingPlanSchema.parse({
        update: [{ fileId: "notesAAAAAAAAAAA", path: join(s.root, "notes.md") }],
        create: [{ folderId: "folderAAAAAAAAAA", name: "never", path: join(s.root, "notes2.md") }],
        reason: "r",
        sourceRef: "s",
      }),
      scope,
      credentials: s.credentials,
      workspace: join(s.root, "filing"),
      auditDir: join(s.root, "audit"),
      fetcher: s.drive.fetcher as any,
    });
    assert.equal(filed.complete, false);
    assert.deepEqual(filed.results.map((r) => [r.op, r.readback, r.error]), [["update", "MISMATCH", "READBACK_MISMATCH"]]);
    assert.ok(![...s.drive.files.values()].some((f) => f.name === "never"));
  } finally {
    s.close();
  }
});

test("filing is held by the task's blockers, stale sources, unaccepted dependencies and a missing owner decision (review K1)", () => {
  const cases: [string, Record<string, unknown>, RegExp | undefined][] = [
    ["none", {}, undefined],
    ["blocker", { blockers: ["OWNER_SAID_WAIT"] }, /FILING_HELD: task blockers: OWNER_SAID_WAIT/],
    ["stale source", { sourceRevision: "r0" }, /FILING_HELD: sources: STALE_SOURCE/],
    ["dependency", { dependencies: ["G"] }, /FILING_HELD: authorization or dependencies not current/],
    [
      "decision",
      { decisionRequired: true, reviewPolicy: { required: true, crossProvider: true, independentAudits: true } },
      /FILING_HELD: the owner's decision is required/,
    ],
  ];
  for (const [name, change, held] of cases) {
    const root = mkdtempSync(join(tmpdir(), "longform-filing-hold-"));
    const db = new SqliteStore(join(root, "state.sqlite"));
    try {
      const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "w"), allowRealLocalTasks: true });
      const actor = c.localActor();
      const real = (id: string, extra: Record<string, unknown>) => {
        const source = ownerSource(c, id);
        const { sourceRevision, ...rest } = extra;
        const t = TaskSchema.parse({
          ...demoTask(id, {
            sources: [{ evidenceId: source.id, revision: (sourceRevision as string) ?? "r1", digest: source.envelope.digest }],
            simulation: false,
            risk: "LOW",
            operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
            writePaths: ["out", "drive-changes"],
            drive: { read: "ANY", update: ["notesAAAAAAAAAAA"], createIn: [] },
            dimensions: {
              authorization: "EXPLICIT",
              sourceEffectuation: "CANDIDATE",
              implementation: "NOT_STARTED",
              review: "NONE",
              release: "NOT_AUTHORIZED",
            },
            ...rest,
          }),
        });
        return { t, source };
      };
      const tasks = [real("F", change), ...(name === "dependency" ? [real("G", {})] : [])];
      c.importTasks(tasks.map((x) => x.t), actor);
      for (const { t, source } of tasks) {
        c.addEvidence(source.envelope, actor);
        c.grant(t.id, { id: randomUUID(), operations: t.operations, paths: t.writePaths, decisionText: "file", sourceRef: "test" }, actor);
      }
      if (held) assert.throws(() => c.filingScope("F", actor), held, name);
      else assert.deepEqual(c.filingScope("F", actor).update, ["notesAAAAAAAAAAA"], name);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("filing asks again before each write and stops when its authority is withdrawn (review K22)", async () => {
  for (const withdraw of ["refused", "out of scope"] as const) {
    const s = setup();
    try {
      const plan = FilingPlanSchema.parse({
        update: [{ fileId: "notesAAAAAAAAAAA", path: join(s.root, "notes.md") }],
        create: [{ folderId: "folderAAAAAAAAAA", name: "L11_REVIEW_RECORD.md", path: join(s.root, "record.md") }],
        reason: "file the review records",
        sourceRef: "test",
      });
      let asked = 0;
      const filed = await fileToDrive({
        plan,
        scope,
        credentials: s.credentials,
        workspace: join(s.root, "filing"),
        auditDir: join(s.root, "audit"),
        fetcher: s.drive.fetcher as any,
        // Allowed for the first write; withdrawn before the second.
        authorize: () => {
          if (++asked === 1) return scope;
          if (withdraw === "refused") throw new Error("DRIVE_WRITE_NOT_AUTHORIZED");
          return { ...scope, createIn: [] };
        },
      });
      assert.equal(asked, 2, withdraw);
      assert.equal(filed.complete, false);
      assert.deepEqual(filed.results.map((r) => [r.op, r.readback]), [
        ["update", "MATCH"],
        ["create", "NOT_READ"],
      ]);
      assert.match(filed.results[1]!.error!, withdraw === "refused" ? /FILING_AUTHORITY_WITHDRAWN: DRIVE_WRITE_NOT_AUTHORIZED/ : /FILING_AUTHORITY_WITHDRAWN: no longer in the task's Drive scope/);
      assert.ok(![...s.drive.files.values()].some((f) => f.name === "L11_REVIEW_RECORD.md"), withdraw);
    } finally {
      s.close();
    }
  }
});

test("a filing stays bound to the specification it started under (review K22)", () => {
  const root = mkdtempSync(join(tmpdir(), "longform-filing-spec-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  try {
    const c = new Controller(db, { ownerUid: process.getuid!(), workspaceRoot: join(root, "w"), allowRealLocalTasks: true });
    const actor = c.localActor();
    const source = ownerSource(c, "F");
    const t = TaskSchema.parse({
      ...demoTask("F", {
        sources: [{ evidenceId: source.id, revision: "r1", digest: source.envelope.digest }],
        simulation: false,
        risk: "LOW",
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"],
        writePaths: ["out", "drive-changes"],
        drive: { read: "ANY", update: ["notesAAAAAAAAAAA"], createIn: [] },
        dimensions: { authorization: "EXPLICIT", sourceEffectuation: "CANDIDATE", implementation: "NOT_STARTED", review: "NONE", release: "NOT_AUTHORIZED" },
      }),
    });
    c.importTasks([t], actor);
    c.addEvidence(source.envelope, actor);
    c.grant("F", { id: randomUUID(), operations: t.operations, paths: t.writePaths, decisionText: "file", sourceRef: "test" }, actor);
    const spec = specDigest(c.task("F"));
    assert.deepEqual(c.filingScope("F", actor, spec).update, ["notesAAAAAAAAAAA"]);
    c.revise("F", { ...c.task("F"), specVersion: 2 }, actor);
    assert.throws(() => c.filingScope("F", actor, spec), /FILING_HELD: the task's specification changed since filing started/);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
