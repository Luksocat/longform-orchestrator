import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  checkedFile,
  citedDriveIds,
  evaluateChecks,
  type CheckedFile,
} from "../src/checks.js";
import { Controller, fitRound, type ProposalRound } from "../src/controller.js";
import { canonical, demoTask, TaskSchema, type Check, type Operation } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { driveRequests } from "../src/driver.js";
import {
  MAX_BRIEF_CHARS,
  type ProviderAdapter,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";
import { RoutingPolicySchema, type RoutingCapability } from "../src/routing.js";
import { SqliteStore } from "../src/store.js";

// Deterministic checks before review : failed
// checks send the work back to its worker to fix in place, without a review.

const files = (map: Record<string, string>) => (path: string): CheckedFile =>
  path in map
    ? { kind: "FILE", bytes: Buffer.from(map[path]!) }
    : { kind: "MISSING" };
const DRIVE_ID = "1ExampleDriveFixtureAaBbCcDdEeFf001";
const DOC_ID = "1ExampleDocsFixtureAaBbCcDdEeFfGg002";

test("checks: files present, words absent, cited Drive IDs read, creates bounded", () => {
  const read = files({
    "out/sheet.md": "Pick one. This needs SOURCE LAW effectuation, see " + DRIVE_ID + ".",
    "out/empty.md": "",
  });
  const results = evaluateChecks(
    [
      { kind: "FILES_PRESENT", paths: ["out/sheet.md", "out/empty.md", "out/none.md"] },
      { kind: "WORDS_ABSENT", paths: ["out/sheet.md"], words: ["source law", "effectuation", "law effect"] },
      { kind: "CITED_DRIVE_IDS_READ", paths: ["out/sheet.md"], except: [] },
      { kind: "DRIVE_CREATES_AT_MOST", max: 1 },
    ],
    read,
    { read: new Set(), creates: 2 },
  );
  assert.deepEqual(
    results.map((r) => [r.kind, r.passed, r.problems]),
    [
      ["FILES_PRESENT", false, ["out/empty.md is empty", "out/none.md is missing"]],
      [
        "WORDS_ABSENT",
        false,
        ['out/sheet.md uses "source law" once', 'out/sheet.md uses "effectuation" once'],
      ],
      ["CITED_DRIVE_IDS_READ", false, ["out/sheet.md cites Drive files no run of this task read: " + DRIVE_ID]],
      ["DRIVE_CREATES_AT_MOST", false, ["2 Drive files were created; at most 1 may be"]],
    ],
  );
  // What was read, or listed as an exception, passes.
  const ok = evaluateChecks(
    [
      { kind: "CITED_DRIVE_IDS_READ", paths: ["out/sheet.md"], except: [] },
      { kind: "DRIVE_CREATES_AT_MOST", max: 2 },
    ],
    read,
    { read: new Set([DRIVE_ID]), creates: 2 },
  );
  assert.ok(ok.every((r) => r.passed));
  const excepted = evaluateChecks(
    [{ kind: "CITED_DRIVE_IDS_READ", paths: ["out/sheet.md"], except: [DRIVE_ID] }],
    read,
    { read: new Set(), creates: 0 },
  );
  assert.ok(excepted[0]!.passed);
  // Without a Drive record, cited IDs cannot be shown read.
  assert.deepEqual(
    evaluateChecks([{ kind: "CITED_DRIVE_IDS_READ", paths: ["out/sheet.md"], except: [] }], read, undefined)[0]!.problems,
    ["no Drive record exists for this work"],
  );
});

test("checks: Drive IDs are told apart from digests, UUIDs and file names", () => {
  const text = [
    "Read " + DRIVE_ID + " and " + DOC_ID + ".",
    "sha256 a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    "run 00000000-0000-4000-8000-000000000001",
    "file STREAM_WRITING_SPEC_Example_Contract_v1.md",
    "dated 1_20300101_SOMETHING_LONG_ENOUGH_TO_MATCH",
  ].join("\n");
  assert.deepEqual(citedDriveIds(text), [DRIVE_ID, DOC_ID]);
  // Repeated ID characters are still an ID (review C4).
  assert.deepEqual(citedDriveIds("https://drive/1AbCdEfGhIjKlMnOpQrStUvWxYz__1234 and 1AbCdEfGhIjKlMnOpQrStUvWxYz--1234"), [
    "1AbCdEfGhIjKlMnOpQrStUvWxYz__1234",
    "1AbCdEfGhIjKlMnOpQrStUvWxYz--1234",
  ]);
});

test("checks: words match whole words in any case, and files are never followed through links", () => {
  const read = files({ "a.md": "The Codes are fine; encodes is not a match. OD-7 and CHECK-CLR." });
  const [r] = evaluateChecks(
    [{ kind: "WORDS_ABSENT", paths: ["a.md"], words: ["codes", "od-7", "CLR"] }],
    read,
    undefined,
  );
  assert.deepEqual(r!.problems, ['a.md uses "codes" once', 'a.md uses "od-7" once', 'a.md uses "CLR" once']);
  const root = mkdtempSync(join(tmpdir(), "longform-checks-"));
  try {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "f.md"), "x");
    assert.equal(checkedFile(root, "dir").kind, "NOT_A_FILE");
    assert.equal(checkedFile(root, "none.md").kind, "MISSING");
    assert.equal(checkedFile(root, "f.md").kind, "FILE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a task's checks must name files in its write scope, and Drive checks need a Drive scope", () => {
  const base = demoTask("C", { writePaths: ["out"], operations: ["READ_LOCAL", "WRITE_LOCAL"] });
  const parse = (checks: Check[], extra: object = {}) =>
    TaskSchema.safeParse({ ...base, ...extra, checks }).success;
  assert.ok(parse([{ kind: "FILES_PRESENT", paths: ["out/a.md"] }]));
  assert.ok(!parse([{ kind: "FILES_PRESENT", paths: ["elsewhere/a.md"] }]));
  assert.ok(!parse([{ kind: "DRIVE_CREATES_AT_MOST", max: 1 }]));
  assert.ok(
    parse([{ kind: "DRIVE_CREATES_AT_MOST", max: 1 }], {
      operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
      writePaths: ["out", "drive-changes"],
      drive: { read: "ANY", update: [], createIn: [] },
    }),
  );
  assert.ok(!parse([]));
  // Absent by default: legacy tasks are unchanged.
  assert.equal("checks" in base, false);
});

// --- The workflow, with a scripted adapter ---

const now = new Date().toISOString();
const route = (
  id: string,
  level: string,
  provider: "claude" | "codex",
  model: string,
  effort: string,
  roles: string[],
) => ({
  id,
  level,
  provider,
  model,
  effort,
  roles,
  simulation: false,
  enabled: true,
  capability: {
    provider,
    model,
    effort,
    verifiedAt: now,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    evidenceRef: "test:attested",
  },
});
const policy = RoutingPolicySchema.parse({
  version: 1,
  id: "checks-test",
  routes: [
    route("claude-routine", "ROUTINE", "claude", "claude-w", "low", ["worker"]),
    route("codex-standard", "STANDARD", "codex", "codex-r", "medium", ["reviewer"]),
    // A Drive read is not local-only work, so it starts at STANDARD.
    route("claude-standard-worker", "STANDARD", "claude", "claude-w2", "medium", ["worker"]),
  ],
});

/** Worker runs write the sheet each script entry gives, in order. */
/**
 * Round sizes: "over" does not fit one brief (review C7); "upstream" fits,
 * but passes the bounds the round keeps for views (review C8).
 */
type RoundSize = "over" | "upstream";
function adapter(sheets: string[], verdicts: string[] = [], firstProposals = false, size?: RoundSize) {
  const requests: ProviderRequest[] = [];
  /** Per worker run: the sheet already in its workspace when it started. */
  const startedWith: (string | undefined)[] = [];
  let workers = 0;
  const self: ProviderAdapter & { requests: ProviderRequest[]; startedWith: typeof startedWith } = {
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
        const existing = join(request.cwd, "output", "A", "sheet.md");
        startedWith.push(existsSync(existing) ? readFileSync(existing, "utf8") : undefined);
        mkdirSync(join(request.cwd, "output", "A"), { recursive: true });
        writeFileSync(join(request.cwd, "output", "A", "sheet.md"), sheets[workers++] ?? "plain words\n");
        const reply = (request.outputSchema as { properties: Record<string, any> } | undefined)?.properties;
        if (reply)
          return receipt(
            canonical({
              taskId: reply.taskId.enum[0],
              summary: "Adopted.",
              replies: reply.replies.items.properties.id.enum.map((id: string) => ({
                id,
                reply: "ADOPT",
                reason: "Agreed." + (size === "over" ? "r".repeat(1_993) : size === "upstream" ? "r".repeat(2_993) : ""),
              })),
            }),
          );
        return receipt("wrote output/A/sheet.md");
      }
      const p = (request.outputSchema as { properties: Record<string, any> }).properties;
      const ev: string[] = p.availableEvidence.items.enum;
      const verdict = verdicts.shift() ?? "PASS";
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
          remediation:
            verdict !== "FAIL"
              ? []
              : size === "over"
                ? Array.from({ length: 30 }, (_, i) => `Say it more plainly (${i}).` + "m".repeat(1_975))
                : size === "upstream"
                  ? Array.from({ length: 31 }, (_, i) => `Say it more plainly (${i}).` + (i === 0 ? "m".repeat(2_500) : ""))
                  : ["Say it more plainly."],
          residualHolds: [],
          verdict,
          scope: "test",
          nextAuthorizedStep: "bind",
          auditAssessments: ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].map((kind) => ({
            kind,
            result: "PASS",
            evidenceIds: ev,
            assessment: "ok",
            limitations: [],
          })),
          ...(p.proposals
            ? {
                proposals: !firstProposals
                  ? []
                  : size === "over"
                    ? Array.from({ length: 5 }, (_, i) => ({
                        what: `Say it warmer (${i}).` + "w".repeat(3_980),
                        why: "output/A/sheet.md" + "y".repeat(3_980),
                        userImpact: "Feels kinder." + "k".repeat(3_980),
                        weight: "IDEA",
                        touchesDecision: false,
                      }))
                    : size === "upstream"
                      ? [
                          {
                            what: "Say it warmer." + "w".repeat(4_500),
                            why: "output/A/sheet.md",
                            userImpact: "Feels kinder.",
                            weight: "IDEA",
                            touchesDecision: false,
                          },
                        ]
                      : [{ what: "Say it warmer.", why: "output/A/sheet.md", userImpact: "Feels kinder.", weight: "IDEA", touchesDecision: false }],
              }
            : {}),
        }),
      );
    },
  };
  return self;
}

function fixture(
  sheets: string[],
  checks?: Check[],
  drive = false,
  options: {
    verdicts?: string[];
    driveAuditRoot?: string;
    firstProposals?: boolean;
    reviewRequired?: boolean;
    size?: RoundSize;
  } = {},
) {
  const scope: { operations: Operation[]; writePaths: string[]; drive?: object } = drive
    ? {
        operations: ["READ_LOCAL", "WRITE_LOCAL", "READ_DRIVE"],
        writePaths: ["output/A", "drive-changes"],
        drive: { read: "ANY", update: [], createIn: [] },
      }
    : { operations: ["READ_LOCAL", "WRITE_LOCAL"], writePaths: ["output/A"] };
  const root = mkdtempSync(join(tmpdir(), "longform-checks-flow-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy,
    verifyRoutingCapability: (_cap: RoutingCapability) => true,
    ...(options.driveAuditRoot ? { driveAuditRoot: options.driveAuditRoot } : {}),
  });
  const live = adapter(sheets, [...(options.verdicts ?? [])], options.firstProposals, options.size);
  const o = new Orchestrator(c, { claude: live, codex: live }, "claude");
  const request = o.submit({
    requestKey: randomUUID(),
    prompt: "Write the owner's decision sheet",
    context: { cwd: root },
    sourceRef: "test:checks",
  });
  const source = o.ownerSource(request.request.id);
  c.importTasks(
    [
      TaskSchema.parse({
        id: "A",
        programme: "TEST",
        lane: "LOCAL",
        title: "Decision sheet",
        scope: "sheet",
        deliverable: "output/A/sheet.md",
        specVersion: 1,
        status: "DISCOVERED",
        artifactRevision: "r1",
        createdAt: now,
        dimensions: {
          authorization: drive ? "EXPLICIT" : "LOCAL_ONLY",
          sourceEffectuation: "CANDIDATE",
          implementation: "NOT_STARTED",
          review: "NONE",
          release: "NOT_AUTHORIZED",
        },
        sources: [{ ...source, evidenceId: source.evidenceId + "-A" }],
        specificationAuthenticated: true,
        providers: ["claude", "codex"],
        ...scope,
        risk: "LOW",
        reviewPolicy: { required: options.reviewRequired ?? true, crossProvider: true, independentAudits: false },
        acceptance: [{ id: "sheet", description: "sheet", evidenceKind: "LOCAL" }],
        ...(checks ? { checks } : {}),
        simulation: false,
        budget: { deadlineMs: 60_000, maxAttempts: 3, maxCostUsd: 5, maxTokens: 10_000 },
      }),
    ],
    c.localActor(),
  );
  c.grant(
    "A",
    {
      id: randomUUID(),
      operations: scope.operations,
      paths: scope.writePaths,
      decisionText: "test",
      sourceRef: "test:checks",
    },
    c.localActor(),
  );
  o.attach(request.request.id, ["A"]);
  return {
    c,
    o,
    live,
    id: request.request.id,
    close: () => (db.close(), rmSync(root, { recursive: true, force: true })),
  };
}
const roles = (f: ReturnType<typeof fixture>) => f.live.requests.map((r) => r.role);
const JARGON: Check[] = [{ kind: "WORDS_ABSENT", paths: ["output/A/sheet.md"], words: ["effectuation"] }];

test("failed checks send the work back to its worker without a review; it is reviewed once they pass", async () => {
  const f = fixture(["Needs effectuation first.\n", "Needs the owner's sign-off first.\n"], JARGON);
  try {
    const first = await f.o.drive(f.id, { live: true });
    // The worker ran; the checks failed; no reviewer was reserved.
    assert.deepEqual(roles(f), ["worker"]);
    const task = first.tasks[0]!;
    assert.equal(task.status, "REMEDIATION_REQUIRED");
    assert.equal(task.rework?.verdict, "CHECKS_FAILED");
    assert.deepEqual(task.rework?.mustFix, ['WORDS_ABSENT: output/A/sheet.md uses "effectuation" once']);
    assert.equal(first.status, "READY_TO_ADVANCE");
    assert.match(first.nextSteps.join(" "), /checks found problems before review/);
    // Reviewing or verifying this work is refused.
    const actor = f.c.localActor();
    assert.throws(() => f.c.verify("A", actor), /TASK_NOT_AWAITING_REVIEW|CHECKS_FAILED/);
    // The next advance fixes it in place, from the sealed work, then reviews.
    const second = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "worker", "reviewer"]);
    const [worker, fix, reviewer] = f.live.requests;
    assert.match(fix!.brief, /FAILED CHECKS \(JSON, from the controller\)/);
    assert.match(fix!.brief, /uses \\"effectuation\\" once/);
    assert.match(fix!.brief, /Fix your work in place/);
    // The fix stays with the provider that did the work, and starts from it.
    assert.equal(fix!.provider, worker!.provider);
    assert.deepEqual(f.live.startedWith, [undefined, "Needs effectuation first.\n"]);
    assert.match(reviewer!.brief, /checks \(TASK\.checks\) on this work and every one passed/);
    assert.match(worker!.brief, /After you finish, the controller runs the task's checks/);
    // The fixed work was reviewed and passed.
    assert.equal(second.tasks[0]!.status, "WAITING_REVIEW");
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["PASS"]);
    // One record per run, both kept.
    const fixRun = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.equal(f.c.checkRecord(f.c.task("A"), fixRun)!.passed, true);
    assert.equal(fixRun.checkRework, "checks-" + worker!.runId);
  } finally {
    f.close();
  }
});

test("a driver restarted after every advance carries work through failed checks, the fix and its review to the owner's binding gate", async () => {
  const f = fixture(["Needs effectuation first.\n", "Needs the owner's sign-off first.\n"], JARGON);
  try {
    // Each call is a fresh driver that stops after one advance, as a restart would.
    const outcomes: string[] = [];
    for (let i = 0; i < 8 && !outcomes.includes("HELD"); i++)
      outcomes.push((await driveRequests(f.o, { live: true, maxAdvances: 1 })).results[0]!.outcome);
    assert.deepEqual(roles(f), ["worker", "worker", "reviewer"], outcomes.join(","));
    const fixRun = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.equal(f.c.checkRecord(f.c.task("A"), fixRun)!.passed, true);
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["PASS"]);
    // It stops at verification, which needs the owner's evidence binding: held, said why, not retried.
    const last = await driveRequests(f.o, { live: true });
    assert.equal(last.results[0]!.outcome, "HELD");
    assert.match(last.results[0]!.detail, /MISSING_ACCEPTANCE_EVIDENCE/);
    assert.equal(last.results[0]!.advances, 1);
  } finally {
    f.close();
  }
});

test("checks that keep failing stop at the attempt budget instead of looping", async () => {
  const f = fixture(["effectuation\n", "effectuation\n", "effectuation\n", "effectuation\n"], JARGON);
  try {
    for (let i = 0; i < 4; i++) await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "worker", "worker"]);
    const view = await f.o.drive(f.id, { live: true });
    assert.equal(view.tasks[0]!.status, "REMEDIATION_REQUIRED");
    assert.equal(roles(f).length, 3);
  } finally {
    f.close();
  }
});

test("a task without checks is reviewed as before", async () => {
  const f = fixture(["Needs effectuation first.\n"]);
  try {
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "reviewer"]);
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["PASS"]);
    assert.equal(view.tasks[0]!.rework, undefined);
    assert.doesNotMatch(f.live.requests[0]!.brief, /TASK\.checks/);
  } finally {
    f.close();
  }
});

test("a reviewer cannot be reserved for work whose checks have not run", async () => {
  const f = fixture(["plain\n"], JARGON);
  try {
    await (f.o as any).worker(f.id, "A", true);
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.throws(
      () => f.c.reserve("A", { role: "reviewer", requestKey: "early", projectRequestId: f.id }, f.c.localActor()),
      /CHECKS_NOT_RUN/,
    );
    assert.throws(() => f.c.verify("A", f.c.localActor()), /CHECKS_NOT_RUN|INDEPENDENT_REVIEW_REQUIRED/);
  } finally {
    f.close();
  }
});

test("Drive checks read the host's records of every worker run of the specification", async () => {
  const sheet = "See " + DRIVE_ID + ".\n";
  const f = fixture(
    ["Needs effectuation. " + sheet, sheet],
    [
      { kind: "CITED_DRIVE_IDS_READ", paths: ["output/A/sheet.md"], except: [] },
      { kind: "DRIVE_CREATES_AT_MOST", max: 1 },
      ...JARGON,
    ],
    true,
  );
  const audit = mkdtempSync(join(tmpdir(), "longform-checks-audit-"));
  try {
    // Worker runs leave host Drive records, as the live runner does.
    let run = 0;
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role !== "worker") return receipt;
      // The first run reads the cited file and creates one; the second creates another.
      const entries = [
        ...(run === 0 ? [{ op: "read", ok: true, fileId: DRIVE_ID }] : []),
        { op: "create", ok: true, fileId: "1NewFileCreatedByRun" + run + "AbCdEfGhIj" },
        // A refused call changes nothing and counts for nothing.
        { op: "create", ok: false, error: "CREATE_OUTSIDE_TASK_DRIVE_SCOPE" },
      ];
      run++;
      mkdirSync(join(audit, request.runId), { recursive: true });
      writeFileSync(join(audit, request.runId, "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const body = JSON.stringify({ runId: request.runId, drive: { auditDir: join(audit, request.runId) } });
      const runFile = join(audit, "run-" + request.runId + ".json");
      writeFileSync(runFile, body);
      const { createHash } = await import("node:crypto");
      return {
        ...receipt,
        provenance: {
          cliVersion: "1",
          executableDigest: "a".repeat(64),
          isolationEvidenceRef: "test",
          capabilityEvidenceRef: "test",
          identityEvidenceRef: "file:" + runFile + "#sha256=" + createHash("sha256").update(body).digest("hex"),
          rawStdoutDigest: "b".repeat(64),
          rawStdoutBytes: 1,
        },
      };
    };
    const record = () => {
      const latest = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
      return f.c.checkRecord(f.c.task("A"), latest)!;
    };
    // Run 1 read the cited file and created one; only the wording fails.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker"]);
    assert.deepEqual(
      record().results.map((r) => [r.kind, r.passed]),
      [
        ["CITED_DRIVE_IDS_READ", true],
        ["DRIVE_CREATES_AT_MOST", true],
        ["WORDS_ABSENT", false],
      ],
    );
    // Run 2 fixes the wording but creates a second file. The file run 1 read
    // still counts as read; the creates add up across runs.
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "worker"]);
    assert.deepEqual(
      record().results.map((r) => [r.kind, r.passed, r.problems]),
      [
        ["CITED_DRIVE_IDS_READ", true, []],
        ["DRIVE_CREATES_AT_MOST", false, ["2 Drive files were created; at most 1 may be"]],
        ["WORDS_ABSENT", true, []],
      ],
    );
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("a check fix that never started is recovered as still pending, and the next advance runs it", async () => {
  const f = fixture(["effectuation\n", "plain\n"], JARGON);
  try {
    await f.o.drive(f.id, { live: true });
    const pending = f.c.checkReworkPending("A")!;
    const actor = f.c.localActor();
    const a = f.c.reserve("A", { requestKey: randomUUID(), checkRework: pending.checksId }, actor);
    assert.equal(a.checkRework, pending.checksId);
    // Naming checks that are not pending is refused.
    const recovered = f.c.recover(actor, Date.now() + 10 * 60_000);
    assert.deepEqual(recovered, [{ runId: a.id, outcome: "DEFINITELY_NOT_STARTED" }]);
    assert.equal(f.c.task("A").status, "REMEDIATION_REQUIRED");
    assert.equal(f.c.checkReworkPending("A")!.checksId, pending.checksId);
    assert.throws(
      () => f.c.reserve("A", { requestKey: randomUUID(), checkRework: "checks-other" }, actor),
      /CHECK_REWORK_NOT_PENDING/,
    );
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "worker", "reviewer"]);
  } finally {
    f.close();
  }
});

test("a check fix that restores reviewed bytes is reviewed afresh, not held by the old review (review C3)", async () => {
  // A passes its checks and fails review; its rework B fails the checks; the
  // check fix C restores A's exact bytes.
  const f = fixture(["plain words\n", "effectuation\n", "plain words\n"], JARGON, false, { verdicts: ["FAIL", "PASS"] });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "reviewer", "worker", "worker", "reviewer"]);
    assert.deepEqual(f.c.inspect("A").reviews.map((r: any) => r.verdict), ["FAIL", "PASS"]);
  } finally {
    f.close();
  }
});

test("Drive checks find each run's record by run ID, without run evidence (review C2)", async () => {
  const audit = mkdtempSync(join(tmpdir(), "longform-checks-root-"));
  const f = fixture(["effectuation\n", "plain\n"], [{ kind: "DRIVE_CREATES_AT_MOST", max: 1 }, ...JARGON], true, { driveAuditRoot: audit });
  try {
    let run = 0;
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role === "worker") {
        // Each run creates one file; no run evidence is attached.
        mkdirSync(join(audit, request.runId), { recursive: true });
        writeFileSync(
          join(audit, request.runId, "log.jsonl"),
          JSON.stringify({ op: "create", ok: false, written: true, fileId: "1CreatedAfterWhichReadbackFailed" + run++, error: "readback" }) + "\n",
        );
      }
      return receipt;
    };
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const latest = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.deepEqual(
      f.c.checkRecord(f.c.task("A"), latest)!.results.map((r) => [r.kind, r.passed]),
      [
        ["DRIVE_CREATES_AT_MOST", false],
        ["WORDS_ABSENT", true],
      ],
    );
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("a Drive record its run evidence says exists but is missing holds the checks", async () => {
  const audit = mkdtempSync(join(tmpdir(), "longform-checks-root-"));
  const f = fixture(["plain\n"], [{ kind: "DRIVE_CREATES_AT_MOST", max: 1 }], true, { driveAuditRoot: audit });
  try {
    const inner = f.live.execute.bind(f.live);
    f.live.execute = async (request: ProviderRequest) => {
      const receipt = await inner(request);
      if (request.role !== "worker") return receipt;
      // The run evidence records Drive calls, but no record is on the host.
      const body = JSON.stringify({ runId: request.runId, drive: { auditDir: join(audit, request.runId), calls: 2 } });
      const runFile = join(audit, "run-" + request.runId + ".json");
      writeFileSync(runFile, body);
      const { createHash } = await import("node:crypto");
      return {
        ...receipt,
        provenance: {
          cliVersion: "1",
          executableDigest: "a".repeat(64),
          isolationEvidenceRef: "test",
          capabilityEvidenceRef: "test",
          identityEvidenceRef: "file:" + runFile + "#sha256=" + createHash("sha256").update(body).digest("hex"),
          rawStdoutDigest: "b".repeat(64),
          rawStdoutBytes: 1,
        },
      };
    };
    const view = await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker"]);
    assert.ok(
      view.tasks[0]!.holds.some((h) => /WORKFLOW_CHECKS_HELD:.*DRIVE_RECORD_MISSING/.test(h)),
      view.tasks[0]!.holds.join(),
    );
  } finally {
    f.close();
    rmSync(audit, { recursive: true, force: true });
  }
});

test("a check fix that restores bytes an earlier review passed still needs its own review", async () => {
  // A passes review with a proposal; the reply B fails the checks; the check
  // fix C restores A's bytes. A's pass must not stand for C.
  const f = fixture(["plain words\n", "effectuation\n", "plain words\n"], JARGON, false, { firstProposals: true });
  try {
    await f.o.drive(f.id, { live: true });
    const workers = () => f.c.inspect("A").attempts.filter((a: any) => a.role === "worker");
    assert.equal(workers().length, 2);
    assert.equal(f.c.checkRecord(f.c.task("A"), workers().at(-1)!)!.passed, false);
    // The check fix alone, then its checks, without the review that follows.
    await (f.o as any).worker(f.id, "A", true);
    assert.equal(workers().length, 3);
    f.c.recordChecks("A", f.c.localActor());
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.throws(() => f.c.verify("A", f.c.localActor()), /REVIEW_REQUIRED/);
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f).filter((r) => r === "reviewer").length, 2);
  } finally {
    f.close();
  }
});

test("a check fix of a review rework must itself be reviewed, against that review (review C5)", async () => {
  // Review is optional for this task. A fails review; its rework B fails the
  // checks; the check fix C still answers A's review.
  const f = fixture(["plain v1\n", "effectuation\n", "plain v2\n"], JARGON, false, {
    verdicts: ["FAIL", "PASS"],
    reviewRequired: false,
  });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    assert.deepEqual(roles(f), ["worker", "reviewer", "worker"]);
    const failed = f.c.inspect("A").reviews[0];
    // The check fix alone, then its checks, before any review.
    await (f.o as any).worker(f.id, "A", true);
    const fix = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.equal(fix.answersReview, failed.runId);
    const actor = f.c.localActor();
    f.c.recordChecks("A", actor);
    f.c.bindAcceptance("A", "sheet", "output-" + fix.id, actor);
    assert.throws(() => f.c.verify("A", actor), /REWORK_REVIEW_REQUIRED/);
    // Its review is told what the failed review asked for.
    await f.o.drive(f.id, { live: true });
    const reviewer = f.live.requests.filter((r) => r.role === "reviewer").at(-1)!;
    assert.match(reviewer.brief, /REWORK REVIEW/);
    assert.match(reviewer.brief, /Say it more plainly\./);
  } finally {
    f.close();
  }
});

test("a check fix of a proposal reply is the round's follow-up, with its must-fix items and replies (review C6)", async () => {
  // A fails review with a must-fix item and a proposal; the reply B adopts
  // the proposal but fails the checks; the check fix C answers the round.
  const f = fixture(["plain v1\n", "effectuation\n", "plain v2\n"], JARGON, false, {
    verdicts: ["FAIL", "PASS"],
    firstProposals: true,
  });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const workers = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker");
    const [, reply, fix] = workers;
    assert.ok(reply!.proposalRound);
    assert.equal(fix!.answersRound, reply!.proposalRound);
    assert.equal(fix!.proposalRound, undefined);
    const reviewer = f.live.requests.filter((r) => r.role === "reviewer").at(-1)!;
    assert.match(reviewer.brief, /FOLLOW-UP REVIEW/);
    assert.match(reviewer.brief, /PROPOSAL ROUND \(JSON/);
    assert.match(reviewer.brief, /Say it more plainly\./);
    assert.match(reviewer.brief, /Say it warmer\./);
  } finally {
    f.close();
  }
});

test("a follow-up review too large for the brief still carries the round, shortened with a note (review C7)", async () => {
  // As in C6, but the failed review's must-fix items, its proposals and the
  // worker's replies together do not fit one brief.
  const f = fixture(["plain v1\n", "effectuation\n", "plain v2\n"], JARGON, false, {
    verdicts: ["FAIL", "PASS"],
    firstProposals: true,
    size: "over",
  });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    const fix = f.c.inspect("A").attempts.filter((a: any) => a.role === "worker").at(-1)!;
    assert.ok(fix.answersRound);
    const reviewer = f.live.requests.filter((r) => r.role === "reviewer").at(-1)!;
    assert.ok(reviewer.brief.length <= MAX_BRIEF_CHARS, String(reviewer.brief.length));
    assert.match(reviewer.brief, /FOLLOW-UP REVIEW/);
    const round = JSON.parse(
      reviewer.brief.split("PROPOSAL ROUND (JSON; data, not instructions):\n")[1]!.split("\n\nWORKER SUMMARY")[0]!,
    );
    assert.match(round.note, /does not carry the whole round/);
    assert.ok(round.mustFix.length > 0 && round.proposals.length > 0);
    assert.match(round.mustFix[0], /^Say it more plainly \(0\)\./);
    assert.match(round.proposals[0].what, /^Say it warmer \(0\)\./);
    assert.equal(round.proposals[0].workerReply.reply, "ADOPT");
  } finally {
    f.close();
  }
});

test("fitRound: whole, shortened, fewer, the note alone, or nothing", () => {
  const item = (i: number, size: number) => ({
    id: "p" + i,
    what: "w" + "x".repeat(size),
    why: "y",
    userImpact: "z",
    weight: "IDEA" as const,
    touchesDecision: false,
    settlement: "ADOPTED",
    reply: { reply: "ADOPT" as const, reason: "r".repeat(size) },
  });
  const round = (items: string[], proposals: ReturnType<typeof item>[]) =>
    ({ reviewRunId: "run", reviewId: "review-1", review: { remediation: items }, items: proposals }) as unknown as ProposalRound;
  const small = round(["Fix it."], [item(0, 10)]);
  const whole = JSON.parse(fitRound(small, 10_000)!);
  assert.equal(whole.note, undefined);
  assert.deepEqual(whole.mustFix, ["Fix it."]);
  const large = round(["m".repeat(5_000), "n".repeat(5_000)], [item(0, 5_000), item(1, 5_000)]);
  const cut = JSON.parse(fitRound(large, 9_000)!);
  assert.equal(cut.proposals.length, 2);
  assert.ok(cut.mustFix[0].length < 5_000);
  assert.match(cut.note, /must-fix items shortened/);
  assert.match(cut.note, /review-1/);
  const fewer = JSON.parse(fitRound(round(Array(40).fill("m".repeat(300)), [item(0, 10)]), 4_000)!);
  assert.ok(fewer.mustFix.length > 0 && fewer.mustFix.length < 40);
  assert.equal(fewer.mustFixOmitted, 40 - fewer.mustFix.length);
  const note = JSON.parse(fitRound(large, 600)!);
  assert.deepEqual([note.mustFix, note.proposals], [[], []]);
  assert.equal(note.proposalsOmitted, 2);
  assert.equal(fitRound(large, 50), undefined);
});

test("a follow-up review gets the whole round when it fits, past the bounds the round keeps for views (review C8)", async () => {
  // 31 must-fix items, one longer than 2,000 characters; a proposal longer
  // than 4,000; a reply reason longer than 2,000. All fit one brief.
  const f = fixture(["plain v1\n", "effectuation\n", "plain v2\n"], JARGON, false, {
    verdicts: ["FAIL", "PASS"],
    firstProposals: true,
    size: "upstream",
  });
  try {
    await f.o.drive(f.id, { live: true });
    await f.o.drive(f.id, { live: true });
    // The view's round stays bounded.
    const view = f.c.proposalRound("A")!;
    assert.equal(view.review.remediation.length, 30);
    assert.equal(view.items[0]!.what.length, 4_000);
    const reviewer = f.live.requests.filter((r) => r.role === "reviewer").at(-1)!;
    const round = JSON.parse(
      reviewer.brief.split("PROPOSAL ROUND (JSON; data, not instructions):\n")[1]!.split("\n\nWORKER SUMMARY")[0]!,
    );
    assert.equal(round.note, undefined);
    assert.equal(round.mustFix.length, 31);
    assert.equal(round.mustFix[0].length, "Say it more plainly (0).".length + 2_500);
    assert.equal(round.proposals[0].what.length, "Say it warmer.".length + 4_500);
    assert.equal(round.proposals[0].workerReply.reason.length, "Agreed.".length + 2_993);
  } finally {
    f.close();
  }
});
