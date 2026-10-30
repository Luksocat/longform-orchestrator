import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/controller.js";
import { canonical, specDigest, TaskSchema, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { SqliteStore } from "../src/store.js";
import { RoutingPolicySchema } from "../src/routing.js";
import {
  OVERSEER_VIEW_HEADING,
  PROJECT_ARCHIVE_PATH,
  projectView,
} from "../src/project-view.js";
import {
  MAX_BRIEF_CHARS,
  MockProvider,
  OWNER_TEXT_IN_SANDBOX,
  type ProviderAdapter,
  type ProviderReceipt,
  type ProviderRequest,
} from "../src/providers.js";

const configured = JSON.parse(
  readFileSync(
    new URL("./fixtures/adaptive/two-tier-policy.json", import.meta.url),
    "utf8",
  ),
);
const policy = () =>
  RoutingPolicySchema.parse({
    ...configured,
    routes: configured.routes.map((r: any) => ({
      ...r,
      capability: {
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        evidenceRef: "test:attested",
      },
    })),
  });
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/** A two-tier project of `count` open tasks, each with a long record. */
function project(
  count: number,
  options: { prompt?: string; secondPrompt?: string; recordChars?: number } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "brief-fit-"));
  const db = new SqliteStore(join(root, "state.sqlite"));
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    async execute(r) {
      requests.push(r);
      return {
        runId: r.runId,
        taskId: r.taskId,
        provider: r.provider,
        model: r.model,
        effort: r.effort,
        sessionId: randomUUID(),
        exitCode: 1,
        status: "FAILED",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        output: "not run in this test",
        tests: [],
        costUsd: 0,
        tokens: 0,
        identityVerified: false,
        simulation: false,
      } satisfies ProviderReceipt;
    },
  };
  const c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    allowRealLocalTasks: true,
    routingPolicy: policy(),
    verifyRoutingCapability: () => true,
    projectProfile: {
      version: 1,
      protectedDocuments: [],
      protectedFolders: [],
      codePaths: ["output"],
    },
  });
  const o = new Orchestrator(c, { codex: adapter, claude: adapter }, "claude");
  const prompt = options.prompt ?? "OWNER-WORDS: build the project as specified.";
  const submitted = o.submit({
    requestKey: randomUUID(),
    prompt,
    context: { cwd: root, projectKey: "fit-" + count },
    sourceRef: "test:owner",
  });
  const id = submitted.request.id,
    source = o.ownerSource(id);
  // A second request in the same project, whose text Astra's view also carries.
  const second = options.secondPrompt
    ? o.submit({
        requestKey: randomUUID(),
        prompt: options.secondPrompt,
        context: { cwd: root, projectKey: "fit-" + count },
        sourceRef: "test:owner-second",
      }).request.id
    : undefined;
  const record = (n: number) =>
    `RECORD-${n}-START ` + "r".repeat(options.recordChars ?? 20_000) + ` RECORD-${n}-END`;
  const tasks: Task[] = Array.from({ length: count }, (_, n) =>
    TaskSchema.parse({
      id: "T" + String(n).padStart(2, "0"),
      programme: "TEST",
      lane: "LOCAL",
      title: "Task " + n,
      scope: record(n),
      deliverable: "output/T" + n + "/out.md",
      specVersion: 1,
      status: "DISCOVERED",
      artifactRevision: "r1",
      createdAt: new Date().toISOString(),
      dimensions: {
        authorization: "LOCAL_ONLY",
        sourceEffectuation: "CANDIDATE",
        implementation: "NOT_STARTED",
        review: "NONE",
        release: "NOT_AUTHORIZED",
      },
      sources: [{ ...source, evidenceId: source.evidenceId + "-T" + String(n).padStart(2, "0") }],
      specificationAuthenticated: true,
      providers: ["claude", "codex"],
      operations: ["READ_LOCAL", "WRITE_LOCAL"],
      writePaths: ["output/T" + n],
      risk: "LOW",
      reviewPolicy: { required: true, crossProvider: true, independentAudits: true },
      acceptance: [{ id: "out", description: "The output", evidenceKind: "LOCAL" }],
      simulation: false,
      budget: { deadlineMs: 60_000, maxAttempts: 5, maxCostUsd: 10, maxTokens: 100_000 },
    }),
  );
  c.importTasks(tasks, c.localActor());
  for (const t of tasks)
    c.grant(
      t.id,
      {
        id: randomUUID(),
        operations: ["READ_LOCAL", "WRITE_LOCAL"],
        paths: t.writePaths,
        decisionText: "Do the task",
        sourceRef: "test:owner",
      },
      c.localActor(),
    );
  o.attach(id, tasks.map((t) => t.id));
  return {
    root,
    db,
    c,
    o,
    id,
    prompt,
    tasks,
    requests,
    record,
    adapter,
    second,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const count of [5, 10, 20])
  test(`a project of ${count} open tasks with 20,000-character records gives every applicable role a fitting brief, keeping the owner's words and the anchored record whole`, () => {
    const p = project(count);
    try {
      for (const t of p.tasks) {
        const preview = p.o.previewBriefs(p.id, { taskId: t.id }) as any;
        assert.equal(preview.recorded, false);
        for (const r of preview.roles) {
          assert.equal(r.error, undefined, `${t.id} ${r.role}/${r.provider}: ${r.error}`);
          assert.ok(r.chars <= MAX_BRIEF_CHARS, `${t.id} ${r.role} ${r.chars}`);
          assert.equal(r.ownerTextInline, true, `${t.id} ${r.role}`);
        }
        assert.deepEqual(
          [...new Set(preview.roles.map((r: any) => r.role))].sort(),
          ["assessor", "overseer", "reviewer", "worker"],
        );
      }
      // Astra's brief, anchored on one task, as the controller builds it.
      const context = p.c.projectContextFor(p.id);
      const anchor = p.tasks[count - 1]!;
      const view = projectView(context, "overseer", anchor.id);
      const fitted = view.fit(MAX_BRIEF_CHARS - 4_000)!;
      assert.ok(fitted, "the overseer view fits");
      assert.ok(fitted.text.includes(p.prompt), "owner's words whole");
      assert.ok(fitted.text.includes(p.record(count - 1)), "anchored record whole");
      const body = JSON.parse(fitted.text.slice(fitted.text.indexOf(OVERSEER_VIEW_HEADING) + OVERSEER_VIEW_HEADING.length));
      assert.equal(body.anchoredTask, anchor.id);
      const indexed = body.snapshot.tasks.filter((e: any) => e.indexed);
      if (count >= 10) assert.equal(indexed.length, count - 1);
      // Each index entry matches the controller's record of that task.
      for (const e of indexed) {
        const recorded = context.snapshot.tasks.find((x) => x.task.id === e.task.id)!;
        const row = p.c.task(e.task.id);
        assert.equal(e.task.title, row.title);
        assert.equal(e.task.status, row.status);
        assert.deepEqual(e.task.dependencies, row.dependencies);
        assert.equal(e.specDigest, specDigest(row));
        assert.deepEqual(e.holds, recorded.gate!.holds);
        assert.equal(e.completionCurrent, recorded.gate!.completionCurrent);
        assert.equal(e.latestReview, null);
        assert.equal(typeof e.waitingFor, "string");
        assert.match(e.fullRecord, new RegExp(PROJECT_ARCHIVE_PATH.replace(/[/.]/g, "\\$&")));
        assert.ok(!JSON.stringify(e).includes("RECORD-"), "an index entry carries no record text");
      }
    } finally {
      p.close();
    }
  });

test("a brief preview records nothing: registering, revising or rebinding inside it leaves the database as it was", () => {
  const p = project(2);
  try {
    const events = () => (p.db.get("SELECT COUNT(*) AS n FROM events") as any).n;
    const before = { events: events(), tasks: canonical(p.c.tasks()) };
    const candidate = { ...JSON.parse(canonical(p.tasks[0]!)), id: "NEW", sources: [], title: "New task", status: "DISCOVERED" };
    const registered = p.o.previewBriefs(p.id, { candidate }) as any;
    assert.equal(registered.action, "register");
    assert.ok(registered.roles.every((r: any) => r.fits));
    const revised = p.o.previewBriefs(p.id, {
      candidate: { ...JSON.parse(canonical(p.tasks[1]!)), specVersion: 2, scope: "REVISED " + "v".repeat(140_000), status: "DISCOVERED" },
    }) as any;
    assert.equal(revised.action, "revise");
    assert.equal(revised.fits, false);
    assert.ok(revised.roles.some((r: any) => /BRIEF_EXCEEDS_PROVIDER_LIMIT|PROJECT_CONTEXT_TOO_LARGE/.test(r.error ?? "")));
    assert.equal(events(), before.events);
    assert.equal(canonical(p.c.tasks()), before.tasks);
    assert.throws(() => p.c.task("NEW"), /TASK_NOT_FOUND/);
  } finally {
    p.close();
  }
});

/** Reserve an overseer run anchored on T00 (no checkpoint needed for oversight). */
function reserveOverseer(p: ReturnType<typeof project>) {
  return p.c.reserve(
    "T00",
    { role: "overseer", projectRequestId: p.id, requestKey: "oversight:" + randomUUID() },
    p.c.localActor(),
  );
}

test("the owner-text files are written at reservation, byte for byte, outside the workspace, with a manifest binding run, request and version", () => {
  const prompt = "LONG-OWNER-WORDS " + "w".repeat(64_000) + " — end, with é and ✓";
  const p = project(3, { prompt });
  try {
    const a = reserveOverseer(p) as any;
    assert.ok(a.ownerText, "owner text prepared");
    assert.ok(!a.ownerText.dir.startsWith(join(p.root, "workspaces")));
    const file = "request-" + p.id + ".txt";
    const bytes = readFileSync(join(a.ownerText.dir, file));
    assert.equal(bytes.toString("utf8"), prompt);
    assert.equal(sha(bytes), p.o.ownerSource(p.id).digest);
    const manifest = JSON.parse(readFileSync(join(a.ownerText.dir, "MANIFEST.json"), "utf8"));
    assert.equal(manifest.runId, a.id);
    assert.deepEqual(
      manifest.files.map((f: any) => [f.requestId, f.requestInputDigest, f.file, f.sha256, f.bytes]),
      [[p.id, (p.o.inspect(p.id) as any).request.inputDigest, file, sha(bytes), bytes.length]],
    );
  } finally {
    p.close();
  }
});

for (const tamper of ["changed", "missing", "linked"] as const)
  test(`owner text that is ${tamper} after reservation stops the run before launch, uses no attempt and leaves nothing reserved`, async () => {
    const prompt = "OWNER-WORDS " + "o".repeat(64_000);
    const p = project(1, { prompt });
    try {
      const a = reserveOverseer(p) as any;
      const path = join(a.ownerText.dir, "request-" + p.id + ".txt");
      if (tamper === "changed") writeFileSync(path, prompt + " (edited)");
      else if (tamper === "missing") unlinkSync(path);
      else {
        const elsewhere = join(p.root, "elsewhere.txt");
        writeFileSync(elsewhere, prompt);
        unlinkSync(path);
        symlinkSync(elsewhere, path);
      }
      await assert.rejects(
        p.c.execute(a, { execute: async () => assert.fail("must not launch") } as ProviderAdapter, p.c.localActor()),
        /OWNER_TEXT_UNAVAILABLE/,
      );
      const after = p.c.inspect("T00").attempts.find((x: any) => x.id === a.id);
      assert.equal(after.state, "NOT_STARTED");
      assert.equal(p.c.plan().active, 0);
      assert.equal(p.requests.length, 0);
      assert.ok(
        p.db.all("SELECT body FROM events WHERE kind='ATTEMPT_NOT_STARTED'").some((e: any) => JSON.parse(e.body).runId === a.id),
      );
    } finally {
      p.close();
    }
  });

test("a run whose brief points at the owner's text gets the file's mount and the requirement in its request", async () => {
  const prompt = "OWNER-WORDS " + "o".repeat(64_000);
  const p = project(1, { prompt, secondPrompt: "SECOND-WORDS " + "s".repeat(64_000) });
  try {
    const a = reserveOverseer(p) as any;
    await p.c.execute(a, p.adapter, p.c.localActor()).catch(() => undefined);
    const r = p.requests[0]!;
    assert.ok(r.brief.length <= MAX_BRIEF_CHARS);
    assert.equal(r.ownerText?.required, true);
    assert.equal(r.ownerText?.dir, a.ownerText.dir);
    for (const [id, text] of [
      [p.id, prompt],
      [p.second!, "SECOND-WORDS " + "s".repeat(64_000)],
    ] as const) {
      assert.ok(r.brief.includes(OWNER_TEXT_IN_SANDBOX + "/request-" + id + ".txt"));
      assert.ok(r.brief.includes(sha(text)));
      assert.ok(r.ownerText!.files.some((f) => f.file === "request-" + id + ".txt" && f.sha256 === sha(text)));
    }
    assert.ok(!r.brief.includes("o".repeat(1_000)), "the words are not inlined or summarized");
  } finally {
    p.close();
  }
});

test("a brief preview inside an enclosing transaction undoes only its own changes (review S1-1)", () => {
  const p = project(2);
  try {
    const events = () => (p.db.get("SELECT COUNT(*) AS n FROM events") as any).n;
    const before = events();
    const candidate = { ...JSON.parse(canonical(p.tasks[0]!)), id: "NEW", sources: [], title: "New task", status: "DISCOVERED" };
    p.db.transaction(() => {
      p.db.event("TEST_OUTER_WRITE", null, {});
      const preview = p.o.previewBriefs(p.id, { candidate }) as any;
      assert.equal(preview.recorded, false);
      assert.equal(preview.action, "register");
    });
    // The outer transaction committed its own write and nothing of the preview's.
    assert.equal(events(), before + 1);
    assert.throws(() => p.c.task("NEW"), /TASK_NOT_FOUND/);
    assert.equal(p.db.all("SELECT * FROM grants WHERE body LIKE '%brief-preview%'").length, 0);
    assert.ok(p.db.verifyEvents());
  } finally {
    p.close();
  }
});

test("a batch preview sizes every task against the project the whole batch would leave (review S1-5)", () => {
  const p = project(2, { recordChars: 2_000 });
  try {
    const events = () => (p.db.get("SELECT COUNT(*) AS n FROM events") as any).n;
    const before = { events: events(), tasks: canonical(p.c.tasks()) };
    const base = JSON.parse(canonical(p.tasks[0]!));
    const a = { ...base, id: "NEWA", sources: [], title: "New A", status: "DISCOVERED" };
    const b = { ...base, id: "NEWB", sources: [], title: "New B", status: "DISCOVERED", dependencies: ["NEWA"] };
    const registered = p.o.previewBatch(p.id, { register: [a, b] }) as any[];
    assert.deepEqual(registered.map((r) => [r.taskId, r.action]), [["NEWA", "register"], ["NEWB", "register"]]);
    for (const r of registered)
      for (const role of r.roles) assert.equal(role.error, undefined, `${r.taskId} ${role.role}: ${role.error}`);
    assert.equal(events(), before.events);
    assert.equal(canonical(p.c.tasks()), before.tasks);
    // Two revised tasks, rebound together as `--rebind T00 --rebind T01` would.
    for (const t of p.tasks)
      p.c.revise(t.id, { ...JSON.parse(canonical(t)), specVersion: 2, scope: "REVISED " + t.scope, status: "DISCOVERED" }, p.c.localActor());
    const afterRevise = events();
    const rebound = p.o.previewBatch(p.id, { taskIds: ["T00", "T01"] }) as any[];
    assert.deepEqual(rebound.map((r) => [r.taskId, r.action]), [["T00", "rebind"], ["T01", "rebind"]]);
    for (const r of rebound)
      for (const role of r.roles) assert.equal(role.error, undefined, `${r.taskId} ${role.role}: ${role.error}`);
    assert.equal(events(), afterRevise);
    assert.ok(p.o.inspect(p.id).tasks.every((t: any) => t.boundSpecDigest !== t.currentSpecDigest), "nothing was rebound");
  } finally {
    p.close();
  }
});

test("a settled anchor's entry stays whole in Astra's view (review S1-4)", () => {
  const p = project(3, { recordChars: 2_000 });
  try {
    const context = JSON.parse(canonical(p.c.projectContextFor(p.id)));
    const anchor = context.snapshot.tasks.find((e: any) => e.task.id === "T00");
    anchor.task.status = "VERIFIED";
    const fitted = projectView(context, "overseer", "T00").fit(MAX_BRIEF_CHARS)!;
    const body = JSON.parse(fitted.text.slice(fitted.text.indexOf(OVERSEER_VIEW_HEADING) + OVERSEER_VIEW_HEADING.length));
    const entry = body.snapshot.tasks.find((e: any) => e.task.id === "T00");
    assert.equal(body.anchoredTask, "T00");
    assert.equal(entry.archived, undefined);
    assert.equal(entry.task.scope, p.record(0));
    assert.deepEqual(entry.grants, anchor.grants);
    assert.deepEqual(entry.evidence, anchor.evidence);
    assert.deepEqual(body.view.leftOut, []);
  } finally {
    p.close();
  }
});

test("runs stopped before launch for missing owner text use none of Astra's two runs (review S1-3)", async () => {
  const prompt = "OWNER-WORDS " + "o".repeat(64_000);
  const p = project(1, { prompt });
  try {
    for (let i = 0; i < 2; i++) {
      const a = reserveOverseer(p) as any;
      unlinkSync(join(a.ownerText.dir, "request-" + p.id + ".txt"));
      await assert.rejects(
        p.c.execute(a, { execute: async () => assert.fail("must not launch") } as ProviderAdapter, p.c.localActor()),
        /OWNER_TEXT_UNAVAILABLE/,
      );
    }
    const third = reserveOverseer(p) as any;
    assert.equal(third.state, "RESERVED");
  } finally {
    p.close();
  }
});

test("a project of 65 requests gives a run every owner-text file and a request providers accept (review S1-2)", async () => {
  const p = project(1, { recordChars: 200 });
  try {
    for (let i = 0; i < 64; i++)
      p.o.submit({
        requestKey: randomUUID(),
        prompt: "MORE-OWNER-WORDS " + i,
        context: { cwd: p.root, projectKey: "fit-1" },
        sourceRef: "test:owner-" + i,
      });
    const a = reserveOverseer(p) as any;
    assert.equal(a.ownerText.files.length, 65);
    // The adapter checks the request as the real ones do, then reports a failure.
    const checked: ProviderAdapter = {
      async execute(r) {
        await new MockProvider().execute(r);
        return p.adapter.execute(r);
      },
    };
    await p.c.execute(a, checked, p.c.localActor()).catch(() => undefined);
    assert.equal(p.requests.length, 1, "launched once");
    assert.equal(p.requests[0]!.ownerText!.files.length, 65);
    const after = p.c.inspect("T00").attempts.find((x: any) => x.id === a.id);
    assert.equal(after.state, "FAILED");
  } finally {
    p.close();
  }
});

test("a register preview of more than 100 new tasks sizes them all (review S1-6)", () => {
  const p = project(1, { recordChars: 100 });
  try {
    const base = JSON.parse(canonical(p.tasks[0]!));
    const candidates = Array.from({ length: 101 }, (_, n) => ({
      ...base,
      id: "N" + String(n).padStart(3, "0"),
      sources: [],
      title: "New " + n,
      scope: "Short task " + n,
      status: "DISCOVERED",
      deliverable: "output/N" + n + "/out.md",
      writePaths: ["output/N" + n],
    }));
    const previews = p.o.previewBatch(p.id, { register: candidates }) as any[];
    assert.equal(previews.length, 101);
    assert.ok(previews.every((r) => r.action === "register" && r.roles.length > 0));
    for (const r of previews)
      for (const role of r.roles) assert.equal(role.error, undefined, `${r.taskId} ${role.role}: ${role.error}`);
    assert.throws(() => p.c.task("N000"), /TASK_NOT_FOUND/);
  } finally {
    p.close();
  }
});

test("a revision preview gives sizes even when the rebind would wait, and says why (review S1-7)", () => {
  const p = project(2, { recordChars: 2_000 });
  try {
    p.o.ask(p.id, { key: "t00-question", text: "Which wording for T00?", taskId: "T00" });
    const preview = p.o.previewBriefs(p.id, {
      candidate: { ...JSON.parse(canonical(p.tasks[0]!)), specVersion: 2, scope: "REVISED", status: "DISCOVERED" },
    }) as any;
    assert.equal(preview.action, "revise");
    assert.match(preview.rebindHeld, /REBIND_HAS_OPEN_QUESTIONS/);
    for (const role of preview.roles) assert.equal(role.error, undefined, `${role.role}: ${role.error}`);
    // An explicit rebind dry run still refuses as the command does.
    p.c.revise("T00", { ...JSON.parse(canonical(p.tasks[0]!)), specVersion: 2, scope: "REVISED", status: "DISCOVERED" }, p.c.localActor());
    assert.throws(() => p.o.previewBatch(p.id, { taskIds: ["T00"] }), /REBIND_HAS_OPEN_QUESTIONS/);
  } finally {
    p.close();
  }
});

test("a request no provider would accept stops before the run is marked started (review S1-2 note)", async () => {
  const p = project(1, { recordChars: 200 });
  try {
    const a = reserveOverseer(p) as any;
    // A model name providers refuse, as a corrupted reservation might carry.
    p.db.run("UPDATE attempts SET body=json_set(body,'$.model','not a valid model!') WHERE id=?", a.id);
    await assert.rejects(
      p.c.execute(a, { execute: async () => assert.fail("must not launch") } as ProviderAdapter, p.c.localActor()),
      /PROVIDER_REQUEST_INVALID/,
    );
    const after = p.c.inspect("T00").attempts.find((x: any) => x.id === a.id);
    assert.equal(after.state, "NOT_STARTED");
    assert.equal(p.c.plan().active, 0);
  } finally {
    p.close();
  }
});
