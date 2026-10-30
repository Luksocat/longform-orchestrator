import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Controller } from "../src/controller.js";
import { SqliteStore } from "../src/store.js";
import { DriveGateway, type DriveWriteHooks } from "../src/drive.js";
import { FilingPlanSchema, fileToDrive } from "../src/filing.js";
import type { RoutingPolicy } from "../src/routing.js";
import { claimsConflict, createIntentClaim, driveFileClaim, driveFolderClaim, localClaim, resourceClaim } from "../src/claims.js";
import type { ProviderAdapter, ProviderReceipt, ProviderRequest } from "../src/providers.js";
import { fakeDrive } from "./fake-drive.js";

// One claim registry for workers and filing (the configured workflow,
// parallelism report §6).

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (s: string) => (s + "AAAAAAAAAAAAAAAA").slice(0, 16);

function task(name: string, drive: { update?: string[]; createIn?: string[]; requireLatest?: string[] }, extra: Record<string, unknown> = {}) {
  // A task with nothing to write on Drive has no Drive scope at all.
  const writes = !!(drive.update?.length || drive.createIn?.length);
  return {
    id: name,
    programme: "DEMO",
    lane: "L01",
    title: name,
    scope: "s",
    deliverable: "d",
    specVersion: 1,
    status: "DISCOVERED",
    dimensions: { authorization: "EXPLICIT", sourceEffectuation: "CANDIDATE", implementation: "NOT_STARTED", review: "NONE", release: "NOT_AUTHORIZED" },
    dependencies: [],
    blockers: [],
    sources: [{ evidenceId: "src-" + name, revision: "r1", digest: "a".repeat(64) }],
    specificationAuthenticated: true,
    providers: ["claude"],
    operations: writes ? ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE", "WRITE_DRIVE"] : ["READ_LOCAL", "WRITE_LOCAL"],
    writePaths: writes ? ["out", "drive-changes"] : ["out"],
    ...(writes
      ? { drive: { read: "ANY", update: drive.update ?? [], createIn: drive.createIn ?? [], ...(drive.requireLatest ? { requireLatest: drive.requireLatest } : {}) } }
      : {}),
    resources: [],
    risk: "LOW",
    reviewPolicy: { required: false, crossProvider: false, independentAudits: false },
    acceptance: [{ id: "a", description: "d", evidenceKind: "LOCAL" }],
    requiredTests: [],
    decisionRequired: false,
    priority: 50,
    estimatedCostUsd: 0,
    budget: { deadlineMs: 10_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 },
    artifactRevision: "rev1",
    simulation: false,
    createdAt: now(),
    ...extra,
  };
}
const route = (level: string, roles: string[]) => ({
  id: "claude-" + level.toLowerCase(),
  level,
  provider: "claude",
  model: "claude-model",
  effort: "low",
  roles,
  simulation: false,
  enabled: true,
  capability: { provider: "claude", model: "claude-model", effort: "low", verifiedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), evidenceRef: "file:test" },
});
const policy = () =>
  ({
    version: 1,
    id: "p",
    routes: ["ROUTINE", "STANDARD", "COMPLEX", "EXPERT"].map((level) => route(level, ["worker", "reviewer", "assessor", "advisor"])),
  }) as RoutingPolicy;

function setup(tasks: ReturnType<typeof task>[], options: { settlingMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-claims-")));
  const path = join(root, "state.sqlite");
  const stores: SqliteStore[] = [];
  const open = () => {
    const db = new SqliteStore(path);
    stores.push(db);
    return {
      db,
      c: new Controller(db, {
        workspaceRoot: join(root, "ws"),
        ownerUid: process.getuid!(),
        allowRealLocalTasks: true,
        routingPolicyLoader: policy,
        verifyRoutingCapability: () => true,
        ...(options.settlingMs !== undefined ? { claimsSettlingMs: options.settlingMs } : {}),
      }),
    };
  };
  const { db, c } = open();
  const actor = c.localActor();
  c.importTasks(tasks as never, actor);
  for (const t of tasks) {
    c.addEvidence(
      { id: "src-" + t.id, taskId: t.id, kind: "LOCAL", uri: "x", revision: "r1", digest: "a".repeat(64), retrievedAt: now(), authorityTier: "PLANNING", authentication: "LOCAL_OWNER_REQUEST", currentness: "CURRENT_AT_RETRIEVAL", claims: [], metadata: {} },
      actor,
    );
    c.grant(t.id, { id: "g-" + t.id, operations: t.operations as never, paths: t.writePaths, decisionText: "go", sourceRef: "test" }, actor);
  }
  const creds = join(root, "creds");
  mkdirSync(creds);
  writeFileSync(join(creds, "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  writeFileSync(join(creds, "token.json"), JSON.stringify({ refresh_token: "r" }));
  return {
    root,
    db,
    c,
    actor,
    again: () => open().c,
    credentials: { clientFile: join(creds, "client.json"), tokenFile: join(creds, "token.json") },
    held: () => c.unresolvedClaims().map((h) => [h.resource, h.holderKind, h.state] as const),
    close: () => {
      for (const s of stores) s.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const receipt = (r: ProviderRequest, status: ProviderReceipt["status"] = "SUCCEEDED"): ProviderReceipt => ({
  runId: r.runId,
  taskId: r.taskId,
  provider: r.provider,
  model: r.model,
  effort: r.effort,
  sessionId: randomUUID(),
  exitCode: status === "SUCCEEDED" ? 0 : 1,
  status,
  startedAt: now(),
  endedAt: now(),
  output: "done",
  tests: [],
  costUsd: 0.01,
  tokens: 10,
  identityVerified: status === "SUCCEEDED",
  simulation: false,
});
/** A worker that makes Drive writes through the controller's hooks, as the gateway would. */
const writing = (script: (hooks: DriveWriteHooks, r: ProviderRequest) => void | Promise<void>, status: ProviderReceipt["status"] = "SUCCEEDED"): ProviderAdapter => ({
  async execute(r) {
    assert.ok(r.driveWrites, "a Drive worker gets the write hooks");
    await script(r.driveWrites!, r);
    return receipt(r, status);
  },
});
/** Evidence for reconciling a write intent or a filing. */
function settleEvidence(f: ReturnType<typeof setup>, taskId: string, bound: { intentId: string } | { filingId: string }, checkedAt: string, effects: "APPLIED" | "NOT_APPLIED", fileId?: string) {
  const evidenceId = "settled-" + randomUUID();
  f.c.addEvidence(
    {
      id: evidenceId,
      taskId,
      kind: "LOCAL",
      uri: "local-assessment:" + evidenceId,
      revision: "rev1",
      digest: "b".repeat(64),
      retrievedAt: now(),
      authorityTier: "UNVERIFIED",
      authentication: "LOCAL_IMPORT",
      currentness: "CURRENT_AT_RETRIEVAL",
      claims: ["operator assessment"],
      metadata: {
        ...bound,
        claimsReconciliation: {
          operationStopped: true,
          effectsSettled: true,
          remoteChecked: [{ what: "listed the folder and the file's revisions", at: checkedAt }],
          effects,
          ...(fileId ? { fileId } : {}),
          assessment: "checked Drive after the window",
        },
      },
    },
    f.actor,
  );
  return evidenceId;
}

test("claims conflict on equal keys, overlapping paths under one root, and an unresolved create against Drive files or its folder", () => {
  assert.ok(claimsConflict(driveFileClaim("f1"), driveFileClaim("f1")));
  assert.ok(!claimsConflict(driveFileClaim("f1"), driveFileClaim("f2")));
  assert.ok(claimsConflict(resourceClaim("r"), resourceClaim("r")));
  assert.ok(claimsConflict(localClaim("/ws/a", "out"), localClaim("/ws/a", "out/x")));
  assert.ok(!claimsConflict(localClaim("/ws/a", "drive-changes"), localClaim("/ws/b", "drive-changes")), "private workspaces never conflict");
  assert.ok(!claimsConflict(localClaim("/w:s", "out"), localClaim("/w", "s:out")), "a colon in a root cannot fake a match");
  const create = createIntentClaim("folder1", "i1");
  assert.ok(claimsConflict(create, driveFileClaim("anything")));
  assert.ok(claimsConflict(driveFolderClaim("folder1"), create));
  assert.ok(!claimsConflict(create, driveFolderClaim("folder2")));
  assert.ok(!claimsConflict(create, resourceClaim("r")));
});

test("Drive workers with disjoint targets run at once; the same file, create folder or resource admits one; read-only roles hold no Drive claims", async () => {
  const f = setup([
    task("A", { update: [id("fileA")] }),
    task("B", { update: [id("fileB")] }),
    task("C", { update: [id("fileA")] }),
    task("D", { createIn: [id("folderX")] }),
    task("E", { createIn: [id("folderX")] }),
    task("F", {}, { resources: ["r1"] }),
    task("G", {}, { resources: ["r1"] }),
  ]);
  try {
    f.c.reserve("A", { requestKey: "a" }, f.actor);
    // Both list drive-changes in their write paths, as every Drive task must;
    // each writes its own workspace, so they no longer collide.
    const b = f.c.reserve("B", { requestKey: "b" }, f.actor);
    assert.throws(() => f.c.reserve("C", { requestKey: "c" }, f.actor), /CLAIM_CONFLICT:drive:file:fileA\w*/);
    await f.c.execute(b, writing(() => {}), f.actor);
    const d = f.c.reserve("D", { requestKey: "d" }, f.actor);
    assert.throws(() => f.c.reserve("E", { requestKey: "e" }, f.actor), /CLAIM_CONFLICT:drive:folder:folderX\w*/);
    await f.c.execute(d, writing(() => {}), f.actor);
    f.c.reserve("F", { requestKey: "f" }, f.actor);
    assert.throws(() => f.c.reserve("G", { requestKey: "g" }, f.actor), /CLAIM_CONFLICT:resource:r1/);
    // An assessor of C writes nothing, so A's claim on fileA does not hold it.
    const assessor = f.c.reserve("C", { requestKey: "c-assess", role: "assessor" }, f.actor);
    assert.deepEqual(f.c.unresolvedClaims().filter((h) => h.holderId === assessor.id), []);
    // The planner uses the same rule.
    assert.ok(!f.c.plan().allocation.some((a) => a.taskId === "E" || a.taskId === "G"));
  } finally {
    f.close();
  }
});

test("a filing and a worker, or two filings, never write one file at once; an explicit resource alone conflicts too", () => {
  const f = setup([
    task("A", { update: [id("fileA")] }),
    task("H", { update: [id("fileH")] }),
    task("R", {}, { resources: ["r2"] }),
    task("S", { update: [id("fileS")] }, { resources: ["r2"] }),
  ]);
  try {
    const spec = (t: string) => (f.c as any).inspect(t).specDigest as string;
    f.c.reserve("A", { requestKey: "a" }, f.actor);
    assert.throws(() => f.c.acquireFilingClaims("A", { update: [{ fileId: id("fileA") }], create: [] }, spec("A"), f.actor), /FILING_CLAIM_CONFLICT:drive:file:fileA\w*/);
    const first = f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec("H"), f.actor);
    assert.throws(() => f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec("H"), f.actor), /FILING_CLAIM_CONFLICT/);
    assert.throws(() => f.c.reserve("H", { requestKey: "h" }, f.actor), /CLAIM_CONFLICT:drive:file:fileH\w* held by filing/);
    f.c.releaseFilingClaims(first);
    f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec("H"), f.actor);
    f.c.reserve("R", { requestKey: "r" }, f.actor);
    assert.throws(() => f.c.acquireFilingClaims("S", { update: [{ fileId: id("fileS") }], create: [] }, spec("S"), f.actor), /FILING_CLAIM_CONFLICT:resource:r2/);
  } finally {
    f.close();
  }
});

test("every Drive write is an intent: a created file becomes the run's claim, an unclaimed target is refused, and unsettled writes outlive the run", async () => {
  const f = setup([
    task("A", { update: [id("fileA")], createIn: [id("folderA")] }),
    task("K", { update: [id("fileK")] }),
    task("L", { update: [id("fileL")] }),
    task("Z", { update: [id("fileZ")] }),
    task("Y", { createIn: [id("folderY")] }),
    task("W", { update: [id("fileK")] }),
    task("V", { update: [id("fileL")] }),
  ]);
  try {
    let created = "";
    const a = f.c.reserve("A", { requestKey: "a" }, f.actor);
    await f.c.execute(
      a,
      writing((hooks) => {
        hooks.end(hooks.begin({ kind: "update", fileId: id("fileA") }), { applied: true, fileId: id("fileA") });
        created = id("newfile");
        hooks.end(hooks.begin({ kind: "create", folderId: id("folderA") }), { applied: true, fileId: created });
        // The created file is the run's from here, before the result returns.
        assert.ok(f.c.unresolvedClaims().some((h) => h.resource === driveFileClaim(created) && h.holderId === a.id));
        assert.throws(() => hooks.begin({ kind: "update", fileId: id("fileZ") }), /DRIVE_WRITE_NOT_CLAIMED/);
      }),
      f.actor,
    );
    assert.ok(!f.c.unresolvedClaims().some((h) => h.holderId === a.id), "the run's custody ended with it");
    assert.throws(() => f.c.beginWrite({ kind: "run", id: a.id }, { kind: "update", fileId: id("fileA") }), /DRIVE_WRITE_WITHOUT_CUSTODY/);
    // A lost update response, and a crash between intent and outcome.
    await f.c.execute(
      f.c.reserve("K", { requestKey: "k" }, f.actor),
      writing((hooks) => hooks.end(hooks.begin({ kind: "update", fileId: id("fileK") }), { ambiguous: true, error: "DRIVE_WRITE_AMBIGUOUS: DRIVE_HTTP_503" })),
      f.actor,
    );
    await f.c.execute(f.c.reserve("L", { requestKey: "l" }, f.actor), writing((hooks) => void hooks.begin({ kind: "update", fileId: id("fileL") })), f.actor);
    assert.throws(() => f.c.reserve("W", { requestKey: "w" }, f.actor), /CLAIM_CONFLICT:drive:file:fileK\w* held by run .* \(write intent UNCERTAIN, attempt SUCCEEDED\)/);
    assert.throws(() => f.c.reserve("V", { requestKey: "v" }, f.actor), /CLAIM_CONFLICT:drive:file:fileL\w* held by run .* \(write intent OPEN, attempt SUCCEEDED\)/);
    const spec = (f.c as any).inspect("W").specDigest;
    assert.throws(() => f.c.acquireFilingClaims("W", { update: [{ fileId: id("fileK") }], create: [] }, spec, f.actor), /FILING_CLAIM_CONFLICT/);
    // A lost create response fences every Drive writer until reconciled.
    const y = f.c.reserve("Y", { requestKey: "y" }, f.actor);
    await f.c.execute(y, writing((hooks) => hooks.end(hooks.begin({ kind: "create", folderId: id("folderY") }), { ambiguous: true, error: "lost" })), f.actor);
    assert.throws(() => f.c.reserve("Z", { requestKey: "z" }, f.actor), /CLAIM_CONFLICT:drive:file:fileZ\w* held by run .*drive:create|write intent UNCERTAIN/);
  } finally {
    f.close();
  }
});

test("the gateway never sends a write twice after an ambiguous response, records it uncertain and refuses later writes", async () => {
  const f = setup([task("F", { update: [id("notes")], createIn: ["folderAAAAAAAAAA"] }, { drive: { read: "ANY", update: ["notesAAAAAAAAAAA"], createIn: ["folderAAAAAAAAAA"] } })]);
  const drive = fakeDrive();
  let posts = 0;
  const fetcher = async (raw: string, init: RequestInit) => {
    const response = await drive.fetcher(raw, init);
    if ((init.method ?? "GET") === "POST" && raw.includes("/upload/")) {
      posts++;
      // Drive applied the create, then the response was lost as a 500.
      return new Response("backend error", { status: 500 });
    }
    return response;
  };
  try {
    writeFileSync(join(f.root, "new.md"), "new\n");
    writeFileSync(join(f.root, "second.md"), "second\n");
    const filed = await f.c.fileTask(
      "F",
      FilingPlanSchema.parse({
        create: [
          { folderId: "folderAAAAAAAAAA", name: "New", path: join(f.root, "new.md") },
          { folderId: "folderAAAAAAAAAA", name: "Second", path: join(f.root, "second.md") },
        ],
        reason: "file",
        sourceRef: "test",
      }),
      f.actor,
      { credentials: f.credentials, stateDir: join(f.root, "state"), fetcher: fetcher as never },
    );
    assert.equal(posts, 1, "exactly one create was sent");
    assert.equal([...drive.files.values()].filter((x) => x.name === "New").length, 1);
    assert.equal(filed.complete, false);
    assert.match(String(filed.results[0]!.error), /DRIVE_WRITE_AMBIGUOUS/);
    const intents = f.c.unresolvedClaims().filter((h) => h.kind === "INTENT");
    assert.deepEqual(intents.map((h) => h.state), ["UNCERTAIN"]);
    // The filing's own claims are released; its uncertain write is not, and it fences the folder.
    assert.ok(!f.c.unresolvedClaims().some((h) => h.kind === "CLAIM"));
    const spec = (f.c as any).inspect("F").specDigest;
    assert.throws(() => f.c.acquireFilingClaims("F", { update: [], create: [{ folderId: "folderAAAAAAAAAA" }] }, spec, f.actor), /FILING_CLAIM_CONFLICT/);
  } finally {
    f.close();
  }
  // At the gateway itself: after an ambiguous write, reads go on and writes stop.
  const g = fakeDrive();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-latch-")));
  try {
    mkdirSync(join(root, "creds"));
    writeFileSync(join(root, "creds", "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
    writeFileSync(join(root, "creds", "token.json"), JSON.stringify({ refresh_token: "r" }));
    writeFileSync(join(root, "x.md"), "x\n");
    let patches = 0;
    const outcomes: unknown[] = [];
    const gateway = new DriveGateway({
      credentials: { clientFile: join(root, "creds", "client.json"), tokenFile: join(root, "creds", "token.json") },
      policy: { read: "ANY", update: ["notesAAAAAAAAAAA", "otherAAAAAAAAAAA"], createIn: [] },
      workspace: root,
      auditDir: join(root, "audit"),
      runId: "latch",
      fetcher: (async (raw: string, init: RequestInit) => {
        if (init.method === "PATCH") {
          patches++;
          throw new Error("socket hang up");
        }
        return g.fetcher(raw, init);
      }) as never,
      writes: { begin: () => "intent-1", end: (_id, outcome) => void outcomes.push(outcome) },
    });
    await gateway.operate("read", ["notesAAAAAAAAAAA"]);
    await assert.rejects(gateway.operate("update", ["notesAAAAAAAAAAA", join(root, "x.md")]), /DRIVE_WRITE_AMBIGUOUS/);
    assert.equal(patches, 1);
    assert.deepEqual(outcomes.map((o: any) => Object.keys(o)[0]), ["ambiguous"]);
    await gateway.operate("read", ["otherAAAAAAAAAAA"]);
    await assert.rejects(gateway.operate("update", ["otherAAAAAAAAAAA", join(root, "x.md")]), /DRIVE_CUSTODY_UNCERTAIN/);
    assert.equal(patches, 1);
    await gateway.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an uncertain write is reconciled only after its operation stopped, from bound evidence checked after the settling window", async () => {
  const f = setup([task("K", { update: [id("fileK")] }), task("W", { update: [id("fileK")] }), task("Y", { createIn: [id("folderY")] })], { settlingMs: 400 });
  try {
    let intent = "";
    const k = f.c.reserve("K", { requestKey: "k" }, f.actor);
    await f.c.execute(
      k,
      writing((hooks) => {
        intent = hooks.begin({ kind: "update", fileId: id("fileK") });
        hooks.end(intent, { ambiguous: true, error: "DRIVE_WRITE_AMBIGUOUS: DRIVE_HTTP_502" });
        const early = settleEvidence(f, "K", { intentId: intent }, now(), "APPLIED");
        assert.throws(() => f.c.reconcileClaims({ intent }, early, f.actor), /OPERATION_NOT_STOPPED/);
      }),
      f.actor,
    );
    const tooEarly = now();
    assert.throws(() => f.c.reconcileClaims({ intent }, settleEvidence(f, "K", { intentId: "another" }, tooEarly, "APPLIED"), f.actor), /EVIDENCE_NOT_BOUND/);
    await sleep(500);
    // A look taken before the window ended, filed afterwards, is refused.
    assert.throws(() => f.c.reconcileClaims({ intent }, settleEvidence(f, "K", { intentId: intent }, tooEarly, "APPLIED"), f.actor), /CHECKED_TOO_EARLY/);
    f.c.reconcileClaims({ intent }, settleEvidence(f, "K", { intentId: intent }, now(), "APPLIED"), f.actor);
    f.c.reserve("W", { requestKey: "w" }, f.actor);
    // An applied create must name the file found.
    let create = "";
    await f.c.execute(
      f.c.reserve("Y", { requestKey: "y" }, f.actor),
      writing((hooks) => {
        create = hooks.begin({ kind: "create", folderId: id("folderY") });
        hooks.end(create, { ambiguous: true, error: "lost" });
      }),
      f.actor,
    );
    await sleep(500);
    assert.throws(() => f.c.reconcileClaims({ intent: create }, settleEvidence(f, "Y", { intentId: create }, now(), "APPLIED"), f.actor), /CREATED_FILE_REQUIRED/);
    f.c.reconcileClaims({ intent: create }, settleEvidence(f, "Y", { intentId: create }, now(), "APPLIED", id("found")), f.actor);
    assert.deepEqual(f.c.unresolvedClaims().filter((h) => h.kind === "INTENT"), []);
  } finally {
    f.close();
  }
});

test("a filing that stops without releasing its claims holds them, uncertain, until reconciled", async () => {
  const f = setup([task("H", { update: [id("fileH")] })], { settlingMs: 300 });
  try {
    const spec = (f.c as any).inspect("H").specDigest;
    const filing = f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec, f.actor);
    const evidence = () => settleEvidence(f, "H", { filingId: filing }, now(), "NOT_APPLIED");
    assert.throws(() => f.c.reconcileClaims({ filing }, evidence(), f.actor), /OPERATION_NOT_STOPPED:lease/);
    // Its process died and its lease ran out.
    f.db.run(
      "UPDATE resource_claims SET lease_until=?, body=? WHERE holder_id=?",
      Date.now() - 1,
      JSON.stringify({ pid: 999_999_999, processStart: "1" }),
      filing,
    );
    assert.ok(f.c.unresolvedClaims().some((h) => h.holderId === filing && "leaseExpired" in h));
    assert.throws(() => f.c.reserve("H", { requestKey: "h" }, f.actor), /lease ran out/);
    // Its stop is known from when it is first seen gone (review S4-3).
    assert.throws(() => f.c.reconcileClaims({ filing }, evidence(), f.actor), /CHECKED_TOO_EARLY/);
    await sleep(400);
    f.c.reconcileClaims({ filing }, evidence(), f.actor);
    f.c.reserve("H", { requestKey: "h2" }, f.actor);
  } finally {
    f.close();
  }
});

test("governing sources declared current at publication: a worker must have read each at Drive's version, and filing stops if one changed", async () => {
  const drive = fakeDrive();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "longform-latest-")));
  try {
    mkdirSync(join(root, "creds"));
    writeFileSync(join(root, "creds", "client.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
    writeFileSync(join(root, "creds", "token.json"), JSON.stringify({ refresh_token: "r" }));
    writeFileSync(join(root, "x.md"), "x\n");
    const credentials = { clientFile: join(root, "creds", "client.json"), tokenFile: join(root, "creds", "token.json") };
    const gateway = new DriveGateway({
      credentials,
      policy: { read: "ANY", update: ["notesAAAAAAAAAAA"], createIn: [], requireLatest: ["docAAAAAAAAAAAAA"] },
      workspace: root,
      auditDir: join(root, "audit"),
      runId: "latest",
      fetcher: drive.fetcher as never,
    });
    await gateway.operate("read", ["notesAAAAAAAAAAA"]);
    await assert.rejects(gateway.operate("update", ["notesAAAAAAAAAAA", join(root, "x.md")]), /REQUIRED_SOURCE_NOT_READ/);
    await gateway.operate("read", ["docAAAAAAAAAAAAA"]);
    drive.edit("docAAAAAAAAAAAAA", "# Packet v2\n");
    await assert.rejects(gateway.operate("update", ["notesAAAAAAAAAAA", join(root, "x.md")]), /REQUIRED_SOURCE_CHANGED/);
    await gateway.operate("read", ["docAAAAAAAAAAAAA"]);
    await gateway.operate("update", ["notesAAAAAAAAAAA", join(root, "x.md")]);
    await gateway.close();
    // Filing: the update target and the governing source as the sealed work read them.
    const plan = FilingPlanSchema.parse({ update: [{ fileId: "notesAAAAAAAAAAA", path: join(root, "x.md") }], reason: "r", sourceRef: "s" });
    const scope = { read: "ANY" as const, update: ["notesAAAAAAAAAAA"], createIn: [] };
    const file = (extra: Record<string, unknown>, n: number) =>
      fileToDrive({ plan, scope, credentials, workspace: join(root, "f" + n), auditDir: join(root, "fa" + n), fetcher: drive.fetcher as never, ...extra });
    const notes = drive.files.get("notesAAAAAAAAAAA")!.version;
    const stale = await file({ sealedVersions: { notesAAAAAAAAAAA: String(notes - 1) } }, 1);
    assert.match(String(stale.results[0]!.error), /CHANGED_SINCE_WORKER_READ/);
    const doc = drive.files.get("docAAAAAAAAAAAAA")!.version;
    const changed = await file({ sealedVersions: { notesAAAAAAAAAAA: String(notes) }, requireLatest: [{ fileId: "docAAAAAAAAAAAAA", version: String(doc - 1) }] }, 2);
    assert.match(String(changed.results[0]!.error), /FILING_REQUIRED_SOURCE_CHANGED/);
    assert.equal(drive.files.get("notesAAAAAAAAAAA")!.version, notes, "nothing was written");
    const ok = await file({ sealedVersions: { notesAAAAAAAAAAA: String(notes) }, requireLatest: [{ fileId: "docAAAAAAAAAAAAA", version: String(doc) }] }, 3);
    assert.equal(ok.complete, true);
    assert.equal(ok.results[0]!.baseVersion, String(notes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filing checks against the versions the current sealed work recorded", async () => {
  const f = setup([task("P", { update: ["notesAAAAAAAAAAA"] })]);
  try {
    const a = f.c.reserve("P", { requestKey: "p" }, f.actor);
    await f.c.execute(
      a,
      {
        async execute(r) {
          const dir = join(r.cwd, "drive-changes", r.runId);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, "log.jsonl"),
            [
              { at: "2026-10-27T01:00:00.000Z", op: "read", ok: true, fileId: "notesAAAAAAAAAAA", versionBefore: "3" },
              { at: "2026-10-27T01:01:00.000Z", op: "read", ok: true, fileId: "docAAAAAAAAAAAAA", versionBefore: "5" },
              { at: "2026-10-27T01:02:00.000Z", op: "update", ok: true, fileId: "notesAAAAAAAAAAA", versionBefore: "3", versionAfter: "4" },
              { at: "2026-10-27T01:03:00.000Z", op: "update", ok: false, fileId: "docAAAAAAAAAAAAA" },
            ]
              .map((e) => JSON.stringify(e))
              .join("\n") + "\n",
          );
          return receipt(r);
        },
      },
      f.actor,
    );
    assert.deepEqual(f.c.filingVersions("P"), { notesAAAAAAAAAAA: "4", docAAAAAAAAAAAAA: "5" });
  } finally {
    f.close();
  }
});

test("two controllers on one database run two Drive workers on disjoint files at the same moment, each bound to its own task and run", async () => {
  const f = setup([task("P", { update: [id("fileP")] }), task("Q", { update: [id("fileQ")] })]);
  try {
    const other = f.again();
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const both = (r: ProviderRequest, hooks: DriveWriteHooks) => async () => {
      if (++arrived === 2) release();
      await barrier;
      const file = r.taskId === "P" ? id("fileP") : id("fileQ");
      hooks.end(hooks.begin({ kind: "update", fileId: file }), { applied: true, fileId: file });
    };
    const p = f.c.reserve("P", { requestKey: "p" }, f.actor);
    const q = other.reserve("Q", { requestKey: "q" }, other.localActor());
    const results = await Promise.all([
      f.c.execute(p, writing((hooks, r) => both(r, hooks)()), f.actor),
      other.execute(q, writing((hooks, r) => both(r, hooks)()), other.localActor()),
    ]);
    assert.deepEqual(results.map((r) => [r.taskId, r.runId, r.status]), [
      ["P", p.id, "SUCCEEDED"],
      ["Q", q.id, "SUCCEEDED"],
    ]);
    assert.equal(f.c.inspect("P").attempts[0]!.id, p.id);
    assert.equal(f.c.inspect("Q").attempts[0]!.id, q.id);
    assert.ok(f.c.inspect("P").evidence.some((e: any) => e.metadata?.runId === p.id));
    assert.deepEqual(f.c.unresolvedClaims(), []);
    assert.ok(f.db.verifyEvents());
  } finally {
    f.close();
  }
});

test("a run reserved before the registry is kept apart by the task-level rule it was admitted under", () => {
  const f = setup([task("A", { update: [id("fileA")] }), task("B", { update: [id("fileB")] })]);
  try {
    const a = f.c.reserve("A", { requestKey: "a" }, f.actor);
    // As a run from before migration 6 is stored: no claims, no marker.
    const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", a.id)!.body);
    delete body.claimsVersion;
    f.db.run("UPDATE attempts SET body=? WHERE id=?", JSON.stringify(body), a.id);
    f.db.run("DELETE FROM resource_claims WHERE holder_id=?", a.id);
    // Both write drive-changes, so the old rule keeps them apart.
    assert.throws(() => f.c.reserve("B", { requestKey: "b" }, f.actor), /OVERLAPPING_WRITE_SCOPE/);
  } finally {
    f.close();
  }
});

// Review round 1 (S4-1..S4-5): each test below fails on the commit before the fix.

/** Store a reservation as one made before migration 6: no claims, no marker. */
function asLegacy(f: ReturnType<typeof setup>, runId: string) {
  const body = JSON.parse(f.db.get<{ body: string }>("SELECT body FROM attempts WHERE id=?", runId)!.body);
  delete body.claimsVersion;
  f.db.run("UPDATE attempts SET body=? WHERE id=?", JSON.stringify(body), runId);
  f.db.run("DELETE FROM resource_claims WHERE holder_id=?", runId);
}

test("S4-1: filing keeps clear of a run reserved before the registry by the same legacy rule as admission", () => {
  const f = setup([
    task("A", { update: [id("fileA")] }),
    task("C", { update: [id("fileA")] }, { writePaths: ["c-out", "drive-changes"] }),
    task("R", {}, { resources: ["r9"], writePaths: ["r-out"] }),
    task("S", { update: [id("fileS")] }, { resources: ["r9"], writePaths: ["s-out", "drive-changes"] }),
    task("N", {}, { writePaths: ["n-out"] }),
    task("H", { update: [id("fileH")] }, { writePaths: ["h-out", "drive-changes"] }),
  ]);
  try {
    const spec = (t: string) => (f.c as any).inspect(t).specDigest as string;
    // A shared explicit resource.
    asLegacy(f, f.c.reserve("R", { requestKey: "r" }, f.actor).id);
    assert.throws(
      () => f.c.acquireFilingClaims("S", { update: [{ fileId: id("fileS") }], create: [] }, spec("S"), f.actor),
      /FILING_OVERLAPPING_WRITE_SCOPE: run .* of task R was reserved before the claim registry/,
    );
    // Nothing shared: the rule is not a blanket hold.
    asLegacy(f, f.c.reserve("N", { requestKey: "n" }, f.actor).id);
    f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec("H"), f.actor);
    assert.deepEqual(f.c.unresolvedClaims().filter((h) => h.holderKind === "filing").map((h) => h.resource), [driveFileClaim(id("fileH"))]);
    // Another Drive task's legacy worker: both write drive-changes, so the old rule holds the filing.
    asLegacy(f, f.c.reserve("A", { requestKey: "a" }, f.actor).id);
    assert.throws(
      () => f.c.acquireFilingClaims("C", { update: [{ fileId: id("fileA") }], create: [] }, spec("C"), f.actor),
      /FILING_OVERLAPPING_WRITE_SCOPE: run .* of task A/,
    );
  } finally {
    f.close();
  }
});

test("S4-2: a reservation from before the registry is not launched with Drive write access, and is reserved again under it", async () => {
  const f = setup([task("A", { update: [id("fileA")] })]);
  try {
    const a = f.c.reserve("A", { requestKey: "a" }, f.actor);
    asLegacy(f, a.id);
    let launched = 0;
    await assert.rejects(
      f.c.execute(a, { async execute(r) { launched++; return receipt(r); } }, f.actor),
      /RESERVED_BEFORE_CLAIM_REGISTRY/,
    );
    assert.equal(launched, 0, "the provider was never started");
    assert.equal(f.c.inspect("A").attempts.find((x: any) => x.id === a.id)!.state, "NOT_STARTED");
    // A fresh reservation holds claims and gets the write hooks.
    const again = f.c.reserve("A", { requestKey: "a2" }, f.actor);
    assert.deepEqual(f.c.unresolvedClaims().filter((h) => h.holderId === again.id && h.resource.startsWith("drive:")).map((h) => h.resource), [driveFileClaim(id("fileA"))]);
    await f.c.execute(again, writing((hooks) => hooks.end(hooks.begin({ kind: "update", fileId: id("fileA") }), { applied: true, fileId: id("fileA") })), f.actor);
    assert.deepEqual(f.c.unresolvedClaims(), []);
  } finally {
    f.close();
  }
});

test("S4-3: a filing whose lease ran out while its process lived is settled from when it was first seen gone, not from its lease", async () => {
  const f = setup([task("H", { update: [id("fileH")] })], { settlingMs: 300 });
  try {
    const spec = (f.c as any).inspect("H").specDigest;
    const filing = f.c.acquireFilingClaims("H", { update: [{ fileId: id("fileH") }], create: [] }, spec, f.actor);
    // Renewal stopped long ago; the process (this one) is still alive.
    f.db.run("UPDATE resource_claims SET lease_until=? WHERE holder_id=?", Date.now() - 60_000, filing);
    await sleep(350);
    const evidence = () => settleEvidence(f, "H", { filingId: filing }, now(), "NOT_APPLIED");
    assert.throws(() => f.c.reconcileClaims({ filing }, evidence(), f.actor), /OPERATION_NOT_STOPPED:process/);
    // Now it dies. A look taken just as it went is too early, although it is
    // long after the lease ran out.
    f.db.run("UPDATE resource_claims SET body=? WHERE holder_id=?", JSON.stringify({ pid: 999_999_999, processStart: "1" }), filing);
    assert.throws(() => f.c.reconcileClaims({ filing }, evidence(), f.actor), /CHECKED_TOO_EARLY/);
    const sightings = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='FILING_STOP_OBSERVED'");
    assert.equal(sightings.length, 1, "the first sighting stands although the reconciliation was refused");
    assert.throws(() => f.c.reconcileClaims({ filing }, evidence(), f.actor), /CHECKED_TOO_EARLY/);
    assert.equal(f.db.all("SELECT body FROM events WHERE kind='FILING_STOP_OBSERVED'").length, 1, "recorded once");
    await sleep(350);
    f.c.reconcileClaims({ filing }, evidence(), f.actor);
    assert.deepEqual(f.c.unresolvedClaims(), []);
  } finally {
    f.close();
  }
});

test("S4-4: sealed work that changed or cannot be read stops filing and releases its claims; no sealed work is no baseline", async () => {
  const f = setup([task("P", { update: ["notesAAAAAAAAAAA"] }), task("Q", { update: ["docAAAAAAAAAAAAA"] })]);
  const drive = fakeDrive();
  try {
    assert.deepEqual(f.c.filingVersions("P"), {}, "no sealed work yet");
    const sealedLog = (lines: string[]) => ({
      async execute(r: ProviderRequest) {
        const dir = join(r.cwd, "drive-changes", r.runId);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "log.jsonl"), lines.join("\n") + "\n");
        return receipt(r);
      },
    });
    const p = f.c.reserve("P", { requestKey: "p" }, f.actor);
    await f.c.execute(p, sealedLog([JSON.stringify({ at: now(), op: "read", ok: true, fileId: "notesAAAAAAAAAAA", versionBefore: "3" })]), f.actor);
    assert.deepEqual(f.c.filingVersions("P"), { notesAAAAAAAAAAA: "3" });
    // The sealed workspace changes afterwards.
    writeFileSync(join(p.workspace, "out-extra.md"), "edited after sealing\n");
    assert.throws(() => f.c.filingVersions("P"), /FILING_HELD: the sealed work changed or cannot be read: .*WORKER_ARTIFACT_CHANGED_OR_UNSEALED/);
    writeFileSync(join(f.root, "x.md"), "x\n");
    const before = drive.files.get("notesAAAAAAAAAAA")!.version;
    await assert.rejects(
      f.c.fileTask("P", FilingPlanSchema.parse({ update: [{ fileId: "notesAAAAAAAAAAA", path: join(f.root, "x.md") }], reason: "r", sourceRef: "s" }), f.actor, {
        credentials: f.credentials,
        stateDir: join(f.root, "state"),
        fetcher: drive.fetcher as never,
      }),
      /FILING_HELD: the sealed work changed/,
    );
    assert.equal(drive.files.get("notesAAAAAAAAAAA")!.version, before, "nothing was written");
    assert.deepEqual(f.c.unresolvedClaims(), [], "the filing's claims were released");
    // A sealed Drive record with a line that is not a record.
    await f.c.execute(f.c.reserve("Q", { requestKey: "q" }, f.actor), sealedLog(["{not json"]), f.actor);
    assert.throws(() => f.c.filingVersions("Q"), /FILING_HELD: the sealed work's Drive record cannot be read/);
  } finally {
    f.close();
  }
});

test("S4-5: every reviewer is told which Drive files must be current at publication, a Codex one without Drive access too", () => {
  const f = setup([task("L", { update: [id("fileL")], requireLatest: [id("govern")] }, { providers: ["codex", "claude"] })]);
  try {
    const t = (f.c as any).task("L");
    const brief = (provider: "codex" | "claude") =>
      (f.c as any).liveBrief(
        t,
        { id: "preview-" + provider, taskId: "L", role: "reviewer", provider, model: "m", effort: "e", specDigest: (f.c as any).inspect("L").specDigest, artifactRevision: t.artifactRevision, workspace: "", state: "RESERVED", leaseOwner: "", leaseUntil: 0, started: false, simulation: false, baseline: {}, macroBaseline: "", condition: "", requestKey: "" },
        undefined,
        true,
      ) as string;
    for (const provider of ["codex", "claude"] as const) {
      const text = brief(provider);
      assert.match(text, new RegExp("must be current when the work is published \\(requireLatest\\): " + id("govern")), provider);
    }
    assert.doesNotMatch(brief("codex"), /You can also read Google Drive/, "the Codex reviewer still has no Drive access");
  } finally {
    f.close();
  }
});
