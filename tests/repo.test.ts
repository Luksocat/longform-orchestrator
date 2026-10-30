import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { patchText, seedFromCommit, workChanges } from "../src/repo.js";
import { Controller, type CommandSpec } from "../src/controller.js";
import { canonical, TaskSchema } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ProviderAdapter, ProviderReceipt, ProviderRequest } from "../src/providers.js";
import { RoutingPolicySchema, type RoutingCapability } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";
import { sandboxed } from "./sandbox-support.js";

// Code work from a pinned commit .

/** A small repository with two commits; returns its path and the commit IDs. */
function repository() {
  const path = mkdtempSync(join(tmpdir(), "longform-repo-"));
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString().trim();
  g("init", "-q");
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "src", "game.txt"), "rule: broken\n");
  writeFileSync(join(path, "README.md"), "readme\n");
  g("add", ".");
  g("commit", "-q", "-m", "one");
  const first = g("rev-parse", "HEAD");
  writeFileSync(join(path, "untracked.txt"), "not in the commit\n");
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", "dep.js"), "dependency\n");
  symlinkSync("README.md", join(path, "link"));
  g("add", "link");
  g("commit", "-q", "-m", "two, with a link");
  const linked = g("rev-parse", "HEAD");
  return { path, first, linked, close: () => rmSync(path, { recursive: true, force: true }) };
}

test("a workspace starts as the commit's tracked files only, and a link or unknown commit refuses", () => {
  const r = repository();
  const dir = mkdtempSync(join(tmpdir(), "longform-seed-"));
  try {
    seedFromCommit({ path: r.path }, r.first, dir);
    assert.deepEqual(readdirSync(dir).sort(), ["README.md", "src"]);
    assert.equal(readFileSync(join(dir, "src", "game.txt"), "utf8"), "rule: broken\n");
    const other = mkdtempSync(join(tmpdir(), "longform-seed-"));
    assert.throws(() => seedFromCommit({ path: r.path }, r.linked, other), /REPO_COMMIT_HAS_LINKS_OR_SUBMODULES/);
    assert.throws(() => seedFromCommit({ path: r.path }, "f".repeat(40), other), /REPO_COMMIT_NOT_FOUND/);
    // An abbreviated or symbolic name is not an exact commit.
    assert.throws(() => seedFromCommit({ path: r.path }, "HEAD", other), /REPO_COMMIT_NOT_FOUND/);
    rmSync(other, { recursive: true, force: true });
    // The repository is only read.
    assert.ok(existsSync(join(r.path, "untracked.txt")));
    // A commit carrying a Drive record folder would pass it off as inherited records.
    mkdirSync(join(r.path, "drive-changes", "run1"), { recursive: true });
    writeFileSync(join(r.path, "drive-changes", "run1", "log.jsonl"), "{}\n");
    rmSync(join(r.path, "link"));
    execFileSync("git", ["-C", r.path, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
    execFileSync("git", ["-C", r.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "three"]);
    const third = execFileSync("git", ["-C", r.path, "rev-parse", "HEAD"]).toString().trim();
    const fresh = mkdtempSync(join(tmpdir(), "longform-seed-"));
    assert.throws(() => seedFromCommit({ path: r.path }, third, fresh), /REPO_COMMIT_HAS_DRIVE_RECORD_FOLDER/);
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.close();
  }
});

test("the diff against the commit lists added, changed and removed files and leaves out the Drive record", () => {
  const r = repository();
  const dir = mkdtempSync(join(tmpdir(), "longform-seed-"));
  try {
    seedFromCommit({ path: r.path }, r.first, dir);
    writeFileSync(join(dir, "src", "game.txt"), "rule: fixed\n");
    writeFileSync(join(dir, "src", "new file.txt"), "new\n");
    rmSync(join(dir, "README.md"));
    mkdirSync(join(dir, "drive-changes", "run1"), { recursive: true });
    writeFileSync(join(dir, "drive-changes", "run1", "log.jsonl"), "{}\n");
    // What diff alone would miss (review K2, K3, K8): a mode change, an empty
    // new file, a binary file, a nested folder named drive-changes, and a
    // name with a tab in it.
    writeFileSync(join(dir, "src", "run.sh"), "echo\n", { mode: 0o755 });
    writeFileSync(join(dir, "src", "empty.txt"), "");
    writeFileSync(join(dir, "src", "blob.bin"), Buffer.from([0, 1, 2, 255]));
    mkdirSync(join(dir, "src", "drive-changes"));
    writeFileSync(join(dir, "src", "drive-changes", "rules.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "src", "x\ty.ts"), "tab\n");
    const { patch, files: changed } = workChanges({ path: r.path }, r.first, dir);
    const diff = patch.toString("utf8");
    assert.deepEqual(changed.sort(), [
      "A src/blob.bin",
      "A src/drive-changes/rules.ts",
      "A src/empty.txt",
      "A src/new file.txt",
      "A src/run.sh",
      "A src/x\ty.ts",
      "D README.md",
      "M src/game.txt",
    ]);
    assert.match(diff, /^-rule: broken$/m);
    assert.match(diff, /^\+rule: fixed$/m);
    assert.match(diff, /GIT binary patch/);
    assert.match(diff, /new file mode 100755/);
    assert.doesNotMatch(diff, /log\.jsonl/);
    // It applies to the commit with git apply.
    const check = mkdtempSync(join(tmpdir(), "longform-apply-"));
    seedFromCommit({ path: r.path }, r.first, check);
    execFileSync("git", ["init", "-q"], { cwd: check });
    execFileSync("git", ["apply"], { cwd: check, input: patch });
    assert.equal(readFileSync(join(check, "src", "game.txt"), "utf8"), "rule: fixed\n");
    assert.ok(!existsSync(join(check, "README.md")));
    assert.deepEqual([...readFileSync(join(check, "src", "blob.bin"))], [0, 1, 2, 255]);
    assert.equal(readFileSync(join(check, "src", "empty.txt"), "utf8"), "");
    assert.ok((statSync(join(check, "src", "run.sh")).mode & 0o111) !== 0);
    rmSync(check, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.close();
  }
});

// --- The workflow ---

const now = new Date().toISOString();
const route = (id: string, level: string, provider: "claude" | "codex", model: string, roles: string[]) => ({
  id,
  level,
  provider,
  model,
  effort: "medium",
  roles,
  simulation: false,
  enabled: true,
  capability: {
    provider,
    model,
    effort: "medium",
    verifiedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "test:attested",
  },
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "repo-test",
  routes: [
    route("w-standard", "STANDARD", "claude", "claude-w", ["worker"]),
    route("r-standard", "STANDARD", "codex", "codex-r", ["reviewer"]),
  ],
});

/** Worker runs record what they start from and write the given rule. */
function adapter(rules: string[]) {
  const requests: ProviderRequest[] = [];
  const startedWith: string[] = [];
  let workers = 0;
  const self: ProviderAdapter & { requests: ProviderRequest[]; startedWith: string[] } = {
    requests,
    startedWith,
    async execute(request: ProviderRequest): Promise<ProviderReceipt> {
      requests.push(request);
      const receipt = (output: string): ProviderReceipt => ({
        runId: request.runId,
        taskId: request.taskId,
        provider: request.provider,
        model: request.model,
        effort: request.effort,
        sessionId: randomUUID(),
        exitCode: 0,
        status: "SUCCEEDED",
        startedAt: now,
        endedAt: new Date().toISOString(),
        output,
        tests: [],
        costUsd: 0.01,
        tokens: 10,
        identityVerified: true,
        simulation: false,
      });
      if (request.role === "worker") {
        const file = join(request.cwd, "src", "game.txt");
        startedWith.push(existsSync(file) ? readFileSync(file, "utf8") : "(empty)");
        writeFileSync(file, rules[workers++] ?? "rule: fixed\n");
        return receipt("changed src/game.txt");
      }
      const p = (request.outputSchema as { properties: Record<string, any> }).properties;
      const ev: string[] = p.availableEvidence.items.enum;
      return receipt(
        canonical({
          taskId: p.taskId.enum[0],
          artifactRevision: p.artifactRevision.enum[0],
          specDigest: p.specDigest.enum[0],
          provider: p.provider.enum[0],
          authorshipDisclosure: "separate session",
          availableEvidence: ev,
          findings: [],
          testsExecuted: [],
          testsNotExecuted: ["none"],
          conflictingEvidence: [],
          remediation: [],
          residualHolds: [],
          verdict: "PASS",
          scope: "test",
          nextAuthorizedStep: "bind",
          auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "ok",
            limitations: [],
          })),
          ...(p.proposals ? { proposals: [] } : {}),
        }),
      );
    },
  };
  return self;
}

function fixture(rules: string[], commands: Record<string, CommandSpec>) {
  const r = repository();
  const root = mkdtempSync(join(tmpdir(), "longform-code-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: (_cap: RoutingCapability) => true,
    repos: { game: { path: r.path } },
    commands,
  });
  const live = adapter(rules);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({ requestKey: randomUUID(), prompt: "Fix the rule", context: { cwd: root }, sourceRef: "test:repo" });
  const source = o.ownerSource(request.request.id);
  const task = (overrides: Record<string, unknown> = {}) =>
    TaskSchema.parse({
      id: "A",
      programme: "TEST",
      lane: "LOCAL",
      title: "Fix the rule",
      scope: "fix src/game.txt",
      deliverable: "src/game.txt",
      specVersion: 1,
      status: "DISCOVERED",
      artifactRevision: "r1",
      createdAt: now,
      dimensions: {
        authorization: "LOCAL_ONLY",
        sourceEffectuation: "CANDIDATE",
        implementation: "NOT_STARTED",
        review: "NONE",
        release: "NOT_AUTHORIZED",
      },
      sources: [{ ...source, evidenceId: source.evidenceId + "-A" }],
      specificationAuthenticated: true,
      providers: ["claude", "codex"],
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      writePaths: ["src"],
      risk: "MEDIUM",
      reviewPolicy: { required: true, crossProvider: true, independentAudits: false },
      acceptance: [{ id: "fix", description: "fix", evidenceKind: "LOCAL" }],
      repo: { name: "game", commit: r.first },
      requiredTests: ["rule-test"],
      simulation: false,
      budget: { deadlineMs: 60_000, maxAttempts: 3, maxCostUsd: 5, maxTokens: 10_000 },
      ...overrides,
    });
  return {
    c,
    o,
    live,
    r,
    id: request.request.id,
    task,
    register(t = task()) {
      c.importTasks([t], c.localActor());
      c.grant("A", { id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["src"], decisionText: "test", sourceRef: "test:repo" }, c.localActor());
      o.attach(request.request.id, ["A"]);
    },
    close: () => (db.close(), rmSync(root, { recursive: true, force: true }), r.close()),
  };
}

/** The task's command receipts, oldest first. */
const receipts = (f: { c: Controller }): any[] =>
  (f.c as any).db
    .all("SELECT body FROM command_receipts WHERE task_id=? ORDER BY rowid", "A")
    .map((r: { body: string }) => JSON.parse(r.body));

/** A test script: passes only once the rule reads "fixed"; writes a report (needs the copy). */
function ruleTest(dir: string) {
  const script = join(dir, "rule-test.sh");
  writeFileSync(
    script,
    '#!/bin/sh\necho report > /work/report.txt || exit 3\nif grep -q "rule: fixed" /work/src/game.txt; then echo ok; else echo "expected the rule to be fixed"; exit 1; fi\n',
    { mode: 0o755 },
  );
  return script;
}

test("an unknown repository is refused at registration", () => {
  const f = fixture([], {});
  try {
    assert.throws(
      () => f.c.importTasks([f.task({ repo: { name: "other", commit: f.r.first } })], f.c.localActor()),
      /UNKNOWN_REPO:other/,
    );
  } finally {
    f.close();
  }
});

test(
  "code work starts from the commit; a failing test sends it back with the output; the reviewer sees the diff",
  sandboxed,
  async () => {
    const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
    const f = fixture(["rule: still broken\n", "rule: fixed\n"], {
      "rule-test": { executable: ruleTest(scripts), args: [], copy: true, deadlineMs: 20_000 },
    });
    try {
      f.register();
      const first = await f.o.drive(f.id, { live: true });
      // The worker started from the commit's files.
      assert.deepEqual(f.live.startedWith, ["rule: broken\n"]);
      assert.match(f.live.requests[0]!.brief, /REPOSITORY: the current directory started as game at commit/);
      assert.match(f.live.requests[0]!.brief, /runs the task's tests \(TASK\.requiredTests\)/);
      // The test failed: back to the worker, no reviewer.
      assert.deepEqual(f.live.requests.map((r) => r.role), ["worker"]);
      assert.equal(first.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
      assert.match(first.tasks[0]!.rework!.mustFix[0]!, /REQUIRED_TESTS: rule-test failed\. The end of its output:\nexpected the rule to be fixed/);
      await f.o.drive(f.id, { live: true });
      assert.deepEqual(f.live.requests.map((r) => r.role), ["worker", "worker", "reviewer"]);
      // The fix started from its own earlier work, with the test's output.
      assert.deepEqual(f.live.startedWith, ["rule: broken\n", "rule: still broken\n"]);
      assert.match(f.live.requests[1]!.brief, /expected the rule to be fixed/);
      // The reviewer is given the changes against the commit.
      const reviewer = f.live.requests[2]!.brief;
      assert.match(reviewer, /CODE CHANGES against game at commit [a-f0-9]{40}/);
      assert.match(reviewer, /^M src\/game\.txt$/m);
      assert.match(reviewer, /^-rule: broken$/m);
      assert.match(reviewer, /^\+rule: fixed$/m);
      // The test ran on a copy: the sealed work has no report in it.
      const sealed = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
      assert.ok(!existsSync(join(sealed.workspace, "report.txt")));
      // The host can take the result as a patch.
      const patch = f.c.exportPatch("A");
      assert.deepEqual(patch.files, ["M src/game.txt"]);
      assert.equal(patch.workerRunId, sealed.id);
    } finally {
      f.close();
      rmSync(scripts, { recursive: true, force: true });
    }
  },
);

test("a required test that cannot run holds the task instead of sending the work back", sandboxed, async () => {
  const f = fixture(["rule: fixed\n"], {});
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker"]);
    assert.equal(view.tasks[0]!.rework, undefined);
    assert.ok(
      view.tasks[0]!.holds.some((h) => /WORKFLOW_CHECKS_HELD:.*REQUIRED_TEST_NOT_RUN: rule-test/.test(h)),
      view.tasks[0]!.holds.join(),
    );
  } finally {
    f.close();
  }
});

test("a read-only test cannot write the work; binds need a copy", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const f = fixture(["rule: fixed\n"], {
    // Without the copy the report cannot be written, so the test fails.
    "rule-test": { executable: ruleTest(scripts), args: [] },
  });
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(view.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a test on a copy sees installed dependencies read-only, and the config requires the copy for them", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const deps = mkdtempSync(join(tmpdir(), "longform-deps-"));
  writeFileSync(join(deps, "dep.js"), "dependency\n");
  const script = join(scripts, "dep-test.sh");
  writeFileSync(
    script,
    "#!/bin/sh\ntest -f /work/node_modules/dep.js || { echo missing; exit 1; }\nif touch /work/node_modules/x 2>/dev/null; then echo writable; exit 1; fi\necho ok\n",
    { mode: 0o755 },
  );
  const f = fixture(["rule: fixed\n"], {
    "rule-test": { executable: script, args: [], copy: true, binds: [{ from: deps, to: "node_modules" }] },
  });
  try {
    f.register();
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker", "reviewer"]);
    // Nothing was written into the dependencies.
    assert.deepEqual(readdirSync(deps), ["dep.js"]);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
    rmSync(deps, { recursive: true, force: true });
  }
  const { LiveConfigSchema } = await import("../src/live.js");
  const base = {
    version: 1,
    stateDir: "/tmp/s",
    routingPolicyPath: "/tmp/p.json",
    sanitizedPublicBrief: true,
    providers: {},
  };
  assert.ok(LiveConfigSchema.safeParse({ ...base, repos: { game: { path: "/r" } }, commands: { t: { executable: "/bin/true", copy: true, binds: [{ from: "/d", to: "node_modules" }] } } }).success);
  assert.ok(!LiveConfigSchema.safeParse({ ...base, commands: { t: { executable: "/bin/true", binds: [{ from: "/d", to: "node_modules" }] } } }).success);
  assert.ok(!LiveConfigSchema.safeParse({ ...base, commands: { t: { executable: "/bin/true", copy: true, binds: [{ from: "/d", to: "../out" }] } } }).success);
  assert.ok(!LiveConfigSchema.safeParse({ ...base, repos: { Game: { path: "/r" } } }).success);
});

test("a required test whose sandbox could not start holds the task instead of failing the work (review K4)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const f = fixture(["rule: fixed\n"], {
    // The dependency folder does not exist, so the sandbox cannot start.
    "rule-test": { executable: ruleTest(scripts), args: [], copy: true, binds: [{ from: "/nonexistent-longform-deps", to: "node_modules" }] },
  });
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker"]);
    assert.equal(view.tasks[0]!.rework, undefined);
    assert.ok(
      view.tasks[0]!.holds.some((h) => /WORKFLOW_CHECKS_HELD:.*REQUIRED_TEST_NOT_RUN: rule-test \(the sandbox did not start it\)/.test(h)),
      view.tasks[0]!.holds.join(),
    );
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a workspace is the commit's exact files, whatever its export rules say, and patches keep other encodings (review K9, K13)", () => {
  const r = repository();
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", r.path, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString().trim();
  rmSync(join(r.path, "link"));
  writeFileSync(join(r.path, ".gitattributes"), "package.json export-ignore\nstamp.txt export-subst\nsrc/*.txt text eol=crlf\n");
  writeFileSync(join(r.path, "package.json"), "{}\n");
  writeFileSync(join(r.path, "stamp.txt"), "$Format:%H$\n");
  writeFileSync(join(r.path, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  g("add", "-A");
  g("commit", "-q", "-m", "attributes");
  const commit = g("rev-parse", "HEAD");
  const dir = mkdtempSync(join(tmpdir(), "longform-seed-"));
  try {
    seedFromCommit({ path: r.path }, commit, dir);
    // Nothing left out, substituted or converted.
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), "{}\n");
    assert.equal(readFileSync(join(dir, "stamp.txt"), "utf8"), "$Format:%H$\n");
    assert.equal(readFileSync(join(dir, "src", "game.txt"), "utf8"), "rule: broken\n");
    // The worker edits the export-ignored file and the Latin-1 one.
    writeFileSync(join(dir, "package.json"), '{"name":"game"}\n');
    writeFileSync(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]));
    const { patch, files } = workChanges({ path: r.path }, commit, dir);
    assert.deepEqual(files.sort(), ["M latin1.txt", "M package.json"]);
    assert.equal(patchText(patch), undefined);
    // The patch applies to a real checkout of the commit and rebuilds the work.
    const clone = mkdtempSync(join(tmpdir(), "longform-clone-"));
    execFileSync("git", ["clone", "-q", r.path, clone]);
    execFileSync("git", ["-C", clone, "checkout", "-q", commit]);
    execFileSync("git", ["-C", clone, "apply"], { input: patch });
    assert.equal(readFileSync(join(clone, "package.json"), "utf8"), '{"name":"game"}\n');
    assert.deepEqual([...readFileSync(join(clone, "latin1.txt"))], [0x63, 0x61, 0x66, 0xe8, 0x0a]);
    rmSync(clone, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.close();
  }
});

test("only the operator's own repository and command names count (review K14)", async () => {
  const f = fixture([], {});
  try {
    assert.throws(
      () => f.c.importTasks([f.task({ repo: { name: "constructor", commit: f.r.first } })], f.c.localActor()),
      /UNKNOWN_REPO:constructor/,
    );
    f.register(f.task({ requiredTests: [] }));
    await (f.o as any).worker(f.id, "A", true);
    await assert.rejects(f.c.command("A", "constructor", f.c.localActor()), /COMMAND_NOT_ALLOWLISTED/);
    await assert.rejects(f.c.command("A", "toString", f.c.localActor()), /COMMAND_NOT_ALLOWLISTED/);
  } finally {
    f.close();
  }
});

test("a verifier the sandbox cannot execute holds the task; a test that floods its output is the work's failure (review K10)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const plain = join(scripts, "not-executable.sh");
  writeFileSync(plain, "#!/bin/sh\necho ok\n", { mode: 0o644 });
  const missing = join(scripts, "missing-interpreter.sh");
  writeFileSync(missing, "#!/no/such/interpreter\n", { mode: 0o755 });
  const flood = join(scripts, "flood.sh");
  // Writes far past the output limit, mostly to stdout, before anything on stderr.
  writeFileSync(flood, "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' x\necho done >&2\n", { mode: 0o755 });
  try {
    for (const [executable, held] of [
      [plain, true],
      [missing, true],
      [flood, false],
    ] as const) {
      const f = fixture(["rule: fixed\n"], { "rule-test": { executable, args: [] } });
      try {
        f.register();
        const view = await f.o.drive(f.id, { live: true });
        const receipt = receipts(f).at(-1);
        assert.equal(receipt.launched, !held, executable);
        if (held)
          assert.ok(
            view.tasks[0]!.holds.some((h) => /REQUIRED_TEST_NOT_RUN: rule-test \(the sandbox did not start it\)/.test(h)),
            view.tasks[0]!.holds.join(),
          );
        else assert.equal(view.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
      } finally {
        f.close();
      }
    }
  } finally {
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a test that never launched, or was not configured, runs once its setup is repaired (review K11)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const deps = join(scripts, "deps-not-yet");
  const commands: Record<string, CommandSpec> = {};
  const f = fixture(["rule: fixed\n"], commands);
  try {
    f.register();
    // Not configured yet: held.
    let view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker"]);
    assert.ok(view.tasks[0]!.holds.some((h) => /REQUIRED_TEST_NOT_RUN/.test(h)), view.tasks[0]!.holds.join());
    // Configured with a dependency folder that does not exist yet: the sandbox cannot start it.
    commands["rule-test"] = { executable: ruleTest(scripts), args: [], copy: true, binds: [{ from: deps, to: "node_modules" }] };
    view = await f.o.drive(f.id, { live: true });
    assert.equal(receipts(f).at(-1).launched, false);
    assert.ok(view.tasks[0]!.holds.some((h) => /the sandbox did not start it/.test(h)), view.tasks[0]!.holds.join());
    // Repaired: the next advance runs it, and the work goes on to review.
    mkdirSync(deps);
    view = await f.o.drive(f.id, { live: true });
    const tests = receipts(f);
    assert.deepEqual(tests.map((r) => [r.launched, r.passed]), [[false, false], [true, true]]);
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker", "reviewer"]);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("replacement objects never change what a pinned commit seeds (review K15)", () => {
  const r = repository();
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", r.path, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).toString().trim();
  const dir = mkdtempSync(join(tmpdir(), "longform-seed-"));
  try {
    // Replace the pinned commit with a later one, and its game file's blob with other bytes.
    g("replace", r.first, r.linked);
    const blob = g("rev-parse", r.first + ":src/game.txt");
    const other = execFileSync("git", ["-C", r.path, "hash-object", "-w", "--stdin"], { input: "rule: replaced\n" }).toString().trim();
    g("replace", "-f", blob, other);
    assert.equal(g("show", r.first + ":src/game.txt"), "rule: replaced");
    seedFromCommit({ path: r.path }, r.first, dir);
    assert.deepEqual(readdirSync(dir).sort(), ["README.md", "src"]);
    assert.equal(readFileSync(join(dir, "src", "game.txt"), "utf8"), "rule: broken\n");
    // The unchanged work has no changes against the real commit.
    assert.deepEqual(workChanges({ path: r.path }, r.first, dir).files, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    r.close();
  }
});

test("a sandbox setup failure is not taken for a launched command when this process is too busy to see it exit (review K16)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const commands: Record<string, CommandSpec> = {
    "rule-test": {
      executable: ruleTest(scripts),
      args: [],
      copy: true,
      binds: [{ from: join(scripts, "missing"), to: "node_modules" }],
      deadlineMs: 1_000,
    },
  };
  const f = fixture(["rule: fixed\n"], commands);
  try {
    f.register();
    await (f.o as any).worker(f.id, "A", true);
    // The sandbox fails at once, but this process is busy past the deadline,
    // so the deadline is handled before the exit is seen.
    const running = f.c.command("A", "rule-test", f.c.localActor());
    const start = Date.now();
    while (Date.now() - start < 1_500) {
      /* busy */
    }
    const receipt = await running;
    assert.equal(receipt.timedOut, true);
    assert.equal(receipt.launched, false);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a sandbox counts as running only while its own process is, not once it has ended unseen (reviews K16, K18)", sandboxed, async () => {
  const { spawn } = await import("node:child_process");
  const { stillRunning } = await import("../src/controller.js");
  const args = ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev"];
  const running = spawn("/usr/bin/bwrap", [...args, "--", "/bin/sleep", "5"], { stdio: "ignore" });
  const failed = spawn("/usr/bin/bwrap", [...args, "--ro-bind", "/nonexistent-longform", "/x", "--", "/bin/sleep", "5"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(stillRunning(running.pid!), true);
    assert.equal(stillRunning(failed.pid!), false);
    // Ended while this process was busy: a zombie, not running.
    const ended = spawn("/bin/true", [], { stdio: "ignore" });
    const start = Date.now();
    while (Date.now() - start < 300) {
      /* busy: the exit is not seen yet */
    }
    assert.equal(stillRunning(ended.pid!), false);
  } finally {
    running.kill("SIGKILL");
    failed.kill("SIGKILL");
  }
});

test("a test that renames itself to look like Bubblewrap still counts as started (review K18)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const disguised = join(scripts, "disguised.sh");
  // Renames itself, then spins with no children until stopped.
  writeFileSync(disguised, "#!/bin/sh\nprintf bwrap > /proc/$$/comm\nwhile :; do :; done\n", { mode: 0o755 });
  const f = fixture(["rule: fixed\n"], { "rule-test": { executable: disguised, args: [], deadlineMs: 1_000 } });
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    const receipt = receipts(f).at(-1);
    assert.deepEqual([receipt.timedOut, receipt.launched, receipt.passed], [true, true, false]);
    assert.equal(view.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a pass recorded before required tests counted as checks does not stand (review K19)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const f = fixture(["rule: still broken\n"], { "rule-test": { executable: ruleTest(scripts), args: [], copy: true } });
  try {
    f.register();
    await (f.o as any).worker(f.id, "A", true);
    const worker = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    // The earlier controller's record: the listed checks only, passed.
    (f.c as any).db.event("CHECKS_RECORDED", "A", {
      id: "checks-" + worker.id,
      taskId: "A",
      workerRunId: worker.id,
      specDigest: worker.specDigest,
      artifactRevision: worker.artifactRevision,
      workspaceDigest: worker.workspaceDigest,
      passed: true,
      results: [],
      at: new Date().toISOString(),
    });
    // And its step in the request's journal.
    (f.o as any).step(f.id, {
      taskId: "A",
      key: "checks-" + worker.id,
      stage: "CHECKS",
      condition: worker.id,
      outcome: "RECORDED",
      detail: "all checks passed",
    });
    assert.equal(f.c.checkRecord(f.c.task("A"), worker), undefined);
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", requestKey: "early", projectRequestId: f.id }, f.c.localActor()),
      /CHECKS_NOT_RUN/,
    );
    // The next advance runs the test, records the checks afresh and sends the work back.
    const view = await f.o.drive(f.id, { live: true });
    const record = f.c.checkRecord(f.c.task("A"), worker)!;
    assert.deepEqual([record.id, record.passed], ["checks-" + worker.id + "-2", false]);
    const steps = (f.o as any).events(f.id).filter((e: any) => e.kind === "WORKFLOW_STEP").map((e: any) => e.body.step);
    assert.ok(steps.some((st: any) => st.key === record.id && st.stage === "CHECKS_FAILED"));
    assert.equal(view.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
    assert.ok(!f.live.requests.some((r) => r.role === "reviewer"));
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a failed test whose receipt predates launch records runs again instead of failing the work (review K17)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const f = fixture(["rule: fixed\n"], { "rule-test": { executable: ruleTest(scripts), args: [], copy: true } });
  try {
    f.register();
    await (f.o as any).worker(f.id, "A", true);
    // A receipt as the earlier controller wrote it: a failure, with no launch record.
    const ran = await f.c.command("A", "rule-test", f.c.localActor());
    const { launched: _, ...old } = { ...(ran as any), id: randomUUID(), passed: false, exitCode: 1 };
    (f.c as any).db.run("INSERT INTO command_receipts VALUES(?,?,?)", old.id, "A", canonical(old));
    assert.throws(() => f.c.recordChecks("A", f.c.localActor()), /REQUIRED_TEST_NOT_RUN: rule-test \(its receipt does not say whether it started\)/);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    // The next advance runs it again, and the work goes on to review.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(receipts(f).map((r) => r.launched), [true, undefined, true]);
    assert.deepEqual(f.live.requests.map((r) => r.role), ["worker", "reviewer"]);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a test that locks its copy still has its result kept, and the copy is removed (review K21)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const locking = join(scripts, "locking.sh");
  writeFileSync(locking, "#!/bin/sh\nchmod 000 /work\nexit 1\n", { mode: 0o755 });
  const f = fixture(["rule: fixed\n"], { "rule-test": { executable: locking, args: [], copy: true } });
  try {
    f.register();
    const view = await f.o.drive(f.id, { live: true });
    const receipt = receipts(f).at(-1);
    assert.deepEqual([receipt.launched, receipt.passed, receipt.cleanupError], [true, false, undefined]);
    assert.equal(view.tasks[0]!.rework?.verdict, "CHECKS_FAILED");
    const parent = dirname((f.c as any).config.workspaceRoot);
    assert.deepEqual(readdirSync(parent).filter((n) => n.startsWith("command-copy-")), []);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});

test("a test's deadline is at least a second, whatever the task or command asks (review K18 note)", sandboxed, async () => {
  const scripts = mkdtempSync(join(tmpdir(), "longform-scripts-"));
  const slow = join(scripts, "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 0.4\n", { mode: 0o755 });
  const f = fixture(["rule: fixed\n"], { "rule-test": { executable: slow, args: [], deadlineMs: 50 } });
  try {
    f.register();
    await (f.o as any).worker(f.id, "A", true);
    const receipt = await f.c.command("A", "rule-test", f.c.localActor());
    assert.deepEqual([receipt.timedOut, receipt.passed], [false, true]);
  } finally {
    f.close();
    rmSync(scripts, { recursive: true, force: true });
  }
});
