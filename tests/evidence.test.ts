import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DriveReadOnlyAdapter,
  EvidenceEnvelopeSchema,
  GitHubReadOnlyAdapter,
  evidenceCurrentness,
  importLocalEvidence,
  redactSecrets,
  sha256,
} from "../src/evidence.js";
import { readFile } from "node:fs/promises";
import { TaskSchema, validateGraph } from "../src/domain.js";

const sha = "a".repeat(40);
function fake(responses: (Response | Error)[]) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const perform = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, "unexpected network request");
    return response;
  }) as typeof fetch;
  return { calls, perform };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const metadata = {
  id: "file-id-123",
  name: "candidate",
  mimeType: "text/markdown",
  version: "3",
  modifiedTime: "2026-10-18T12:00:00Z",
};

test("missing Drive/GitHub credentials fail precisely without a network request", async () => {
  const fixture = fake([]);
  const drive = await new DriveReadOnlyAdapter({ fetch: fixture.perform }).read(
    metadata.id,
    { taskId: "RESEARCH" },
  );
  const github = await new GitHubReadOnlyAdapter({
    fetch: fixture.perform,
  }).read("owner/repo", { kind: "commit", sha }, { taskId: "IMPLEMENT" });
  for (const result of [drive, github]) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "EVIDENCE_UNAVAILABLE");
      assert.match(result.reason, /MISSING_CREDENTIAL/);
    }
  }
  assert.equal(fixture.calls.length, 0);
});

test("Drive connector uses only fixed-origin GET and rechecks current metadata", async () => {
  const fixture = fake([
    json(metadata),
    new Response("PLANNING CANDIDATE"),
    json(metadata),
  ]);
  const result = await new DriveReadOnlyAdapter({
    token: "test-token",
    fetch: fixture.perform,
  }).read(metadata.id, { taskId: "RESEARCH", expectedRevision: "3" });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.envelope.authorityTier, "UNVERIFIED");
    assert.equal(result.envelope.currentness, "CURRENT_AT_RETRIEVAL");
    assert.equal(result.envelope.digest, sha256("PLANNING CANDIDATE"));
    assert.equal(result.envelope.authentication, "AUTHENTICATED_API");
  }
  assert.equal(fixture.calls.length, 3);
  for (const call of fixture.calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal(call.init?.redirect, "manual");
    assert.equal(call.url.origin, "https://www.googleapis.com");
    assert.equal(call.init?.body, undefined);
  }
});

test("Drive revision changed during export is unavailable, not silently assigned to old metadata", async () => {
  const fixture = fake([
    json(metadata),
    new Response("content"),
    json({ ...metadata, version: "4" }),
  ]);
  const result = await new DriveReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read(metadata.id, { taskId: "RESEARCH" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /CHANGED_DURING_RETRIEVAL/);
});

test("Drive does not declare empty remediation document evidence from its title", async () => {
  const fixture = fake([json(metadata), new Response("  ")]);
  const result = await new DriveReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read(metadata.id, { taskId: "DECISION" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /EMPTY_CONTENT/);
});

test("Drive binary package and unsupported native types do not trigger exports", async () => {
  for (const mimeType of [
    "application/zip",
    "application/vnd.google-apps.spreadsheet",
  ]) {
    const fixture = fake([json({ ...metadata, mimeType })]);
    const result = await new DriveReadOnlyAdapter({
      token: "x",
      fetch: fixture.perform,
    }).read(metadata.id, { taskId: "RESEARCH" });
    assert.equal(result.ok, false);
    assert.equal(fixture.calls.length, 1);
  }
});

test("Drive native Docs export uses MIME-specific GET", async () => {
  const meta = {
    ...metadata,
    mimeType: "application/vnd.google-apps.document",
  };
  const fixture = fake([json(meta), new Response("Document"), json(meta)]);
  const result = await new DriveReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read(metadata.id, { taskId: "RESEARCH" });
  assert.equal(result.ok, true);
  assert.match(fixture.calls[1]!.url.pathname, /\/export$/);
  assert.equal(
    fixture.calls[1]!.url.searchParams.get("mimeType"),
    "text/plain",
  );
});

test("Drive discover preserves opaque pagination and GET-only requests", async () => {
  const fixture = fake([json({ files: [], nextPageToken: "opaque-token" })]);
  const result = await new DriveReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).discover("trashed = false", "prior-token");
  assert.deepEqual(result, {
    ok: true,
    files: [],
    nextPageToken: "opaque-token",
  });
  assert.equal(fixture.calls[0]!.init?.method, "GET");
  assert.equal(
    fixture.calls[0]!.url.searchParams.get("pageToken"),
    "prior-token",
  );
});

test("read-only GitHub supports pinned commits, PR/review/CI/changed-file/branch metadata only through GET", async () => {
  const fixture = fake([
    json({ sha }),
    json({ head: { sha } }),
    json([]),
    json([]),
    json({ workflow_runs: [] }),
    json({ commit: { sha } }),
    json({ default_branch: "main" }),
  ]);
  const adapter = new GitHubReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  });
  const resources = [
    { kind: "commit", sha },
    { kind: "pullRequest", number: 1 },
    { kind: "changedFiles", number: 1 },
    { kind: "reviews", number: 1 },
    { kind: "workflowRuns", sha },
    { kind: "branch", branch: "main" },
    { kind: "repository" },
  ] as const;
  for (const resource of resources)
    assert.equal(
      (await adapter.read("owner/repo", resource, { taskId: "IMPLEMENT" })).ok,
      true,
    );
  for (const call of fixture.calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal(call.url.origin, "https://api.github.com");
    assert.equal(call.init?.body, undefined);
  }
});

test("GitHub rejects mutable commit identifiers, injected paths and commit mismatches", async () => {
  const fixture = fake([json({ sha: "b".repeat(40) })]);
  const adapter = new GitHubReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  });
  for (const [repo, resource] of [
    ["owner/repo", { kind: "commit", sha: "main" }],
    ["owner/repo/../actions", { kind: "repository" }],
    ["owner/repo", { kind: "branch", branch: "../pulls/1/merge" }],
  ] as const)
    assert.equal(
      (await adapter.read(repo, resource, { taskId: "IMPLEMENT" })).ok,
      false,
    );
  const result = await adapter.read(
    "owner/repo",
    { kind: "commit", sha },
    { taskId: "IMPLEMENT" },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /COMMIT_ID_MISMATCH/);
  assert.equal(fixture.calls.length, 1);
});

test("100-item GitHub page never claims complete evidence", async () => {
  const fixture = fake([
    json(Array.from({ length: 100 }, (_, id) => ({ id }))),
  ]);
  const result = await new GitHubReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read("owner/repo", { kind: "reviews", number: 1 }, { taskId: "IMPLEMENT" });
  assert.ok(result.ok);
  assert.equal(result.envelope.metadata.paginationComplete, false);
});

test("authentication failure, redirects and oversized streaming response are unavailable", async () => {
  for (const response of [
    new Response("", { status: 401 }),
    new Response("", {
      status: 302,
      headers: { location: "https://evil.invalid" },
    }),
    new Response("x".repeat(501)),
  ]) {
    const fixture = fake([response]);
    const result = await new GitHubReadOnlyAdapter({
      token: "x",
      fetch: fixture.perform,
      maxBytes: 500,
    }).read("owner/repo", { kind: "repository" }, { taskId: "IMPLEMENT" });
    assert.equal(result.ok, false);
    assert.equal(fixture.calls.length, 1);
  }
});

test("connector deadline is installed, error strings redact the credential", async () => {
  const fixture = fake([new Error("network with supplied-secret-value")]);
  const result = await new GitHubReadOnlyAdapter({
    token: "supplied-secret-value",
    fetch: fixture.perform,
    timeoutMs: 10,
  }).read("owner/repo", { kind: "repository" }, { taskId: "IMPLEMENT" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(!result.reason.includes("supplied-secret-value"));
  assert.ok(fixture.calls[0]!.init?.signal instanceof AbortSignal);
});

test("stale expected source digest/revision remains stale and hash is not authorization", async () => {
  const fixture = fake([json({ sha })]);
  const result = await new GitHubReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read(
    "owner/repo",
    { kind: "commit", sha },
    { taskId: "IMPLEMENT", expectedDigest: "b".repeat(64) },
  );
  assert.ok(result.ok);
  assert.equal(result.envelope.currentness, "STALE");
  assert.equal(result.envelope.authorityTier, "UNVERIFIED");
  assert.equal(evidenceCurrentness(result.envelope, {}), "UNKNOWN");
  assert.equal(
    evidenceCurrentness(result.envelope, { revision: sha }),
    "CURRENT_AT_RETRIEVAL",
  );
});

test("local import checks SHA256, path allowlist, symlink escape and bounded bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "longform-evidence-"));
  const outside = await mkdtemp(join(tmpdir(), "longform-outside-"));
  try {
    const file = join(root, "receipt.txt");
    await writeFile(file, "exit=0");
    const valid = await importLocalEvidence({
      taskId: "MOCK-1",
      path: file,
      allowedRoot: root,
      expectedDigest: sha256("exit=0"),
      kind: "TEST_RECEIPT",
    });
    assert.ok(valid.ok);
    assert.equal(valid.envelope.currentness, "CURRENT_AT_RETRIEVAL");
    assert.equal(valid.envelope.authentication, "LOCAL_IMPORT");
    const stale = await importLocalEvidence({
      taskId: "MOCK-1",
      path: file,
      allowedRoot: root,
      expectedDigest: "f".repeat(64),
    });
    assert.ok(stale.ok);
    assert.equal(stale.envelope.currentness, "STALE");
    const external = join(outside, "secret");
    await writeFile(external, "outside");
    await symlink(external, join(root, "escape"));
    assert.equal(
      (
        await importLocalEvidence({
          taskId: "MOCK-1",
          path: join(root, "escape"),
          allowedRoot: root,
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await importLocalEvidence({
          taskId: "MOCK-1",
          path: file,
          allowedRoot: root,
          maxBytes: 2,
        })
      ).ok,
      false,
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});

test("sensitive data is redacted before returning content, original digest is retained", async () => {
  const raw =
    "password=hunter2 Bearer abc.def.ghi postgresql://user:secret@db:5432/db sk-proj-abcdefghijklmnopqrstuvwxyz";
  const fixture = fake([json(metadata), new Response(raw), json(metadata)]);
  const result = await new DriveReadOnlyAdapter({
    token: "x",
    fetch: fixture.perform,
  }).read(metadata.id, { taskId: "RESEARCH" });
  assert.ok(result.ok);
  assert.equal(result.envelope.digest, sha256(raw));
  for (const secret of [
    "hunter2",
    "abc.def.ghi",
    "user:secret",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
  ])
    assert.ok(!result.content.includes(secret));
  assert.equal(
    redactSecrets("custom credential", ["credential"]),
    "custom [REDACTED]",
  );
});

test("malformed evidence envelope and oversized adapter configuration fail schema validation", () => {
  assert.equal(
    EvidenceEnvelopeSchema.safeParse({
      id: "a",
      taskId: "missing",
      accepted: true,
    }).success,
    false,
  );
  assert.throws(() => new DriveReadOnlyAdapter({ maxBytes: Infinity }));
  assert.throws(() => new GitHubReadOnlyAdapter({ timeoutMs: 0 }));
});

test("private key blocks are removed from redacted evidence", () => {
  assert.equal(
    redactSecrets(
      "-----BEGIN RSA PRIVATE KEY-----\nsecret bytes\n-----END RSA PRIVATE KEY-----",
    ),
    "[REDACTED PRIVATE KEY]",
  );
});

test("synthetic planning fixtures preserve holds without importing private sources", async () => {
  const snapshot = JSON.parse(
    await readFile(new URL("../fixtures/programme-snapshot.json", import.meta.url), "utf8"),
  );
  const tasks = snapshot.tasks.map((value: unknown) => TaskSchema.parse(value));
  const evidence = snapshot.evidence.map((value: unknown) => EvidenceEnvelopeSchema.parse(value));
  validateGraph(tasks);
  assert.equal(tasks.length, 21);
  assert.equal(evidence.length, 28);
  for (const id of ["PLAN", "RESEARCH", "DRAFT", "DECISION", "IMPLEMENT", "DELIVER", "CHOOSE-HOST"])
    assert.ok(tasks.some((task: { id: string }) => task.id === id));
  for (const task of tasks) {
    assert.ok(["BLOCKED", "WAITING_OWNER"].includes(task.status));
    assert.equal(task.specificationAuthenticated, false);
    assert.equal(task.dimensions.authorization, "HELD");
    assert.equal(task.dimensions.release, "NOT_AUTHORIZED");
    assert.deepEqual(task.operations, ["READ_LOCAL"]);
    for (const source of task.sources)
      assert.ok(evidence.some((item: any) =>
        item.id === source.evidenceId && item.taskId === task.id &&
        item.revision === source.revision && item.digest === source.digest));
  }
  for (const item of evidence) {
    assert.equal(item.authentication, "LOCAL_IMPORT");
    assert.equal(item.authorityTier, "UNVERIFIED");
    assert.equal(item.metadata.synthetic, true);
    assert.match(item.uri, /^fixture:\/\/example\//);
    assert.equal(item.digest, sha256(String(item.metadata.content)));
  }
});
