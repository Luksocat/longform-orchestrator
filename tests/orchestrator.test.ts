import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Controller, type ControllerConfig } from "../src/controller.js";
import { demoTask, digest, specDigest, type Task } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";
import { MockProvider } from "../src/providers.js";
import { SqliteStore } from "../src/store.js";

function fixture(
  tasks: Task[] = [demoTask("A")],
  options: Partial<ControllerConfig> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "longform-request-"));
  const database = join(root, "state.sqlite");
  let db = new SqliteStore(database);
  let c = new Controller(db, {
    ownerUid: process.getuid!(),
    workspaceRoot: join(root, "workspaces"),
    ...options,
  });
  let orchestrator = new Orchestrator(c);
  c.importTasks(tasks, c.localActor());
  const result = {
    root,
    get c() {
      return c;
    },
    get db() {
      return db;
    },
    get o() {
      return orchestrator;
    },
    submit(taskIds = tasks.map((t) => t.id), requestKey = randomUUID()) {
      return orchestrator.submit({
        requestKey,
        prompt: "Handle the bounded task; retain all holds.",
        context: { cwd: root },
        sourceRef: "test:owner-request",
        taskIds,
      });
    },
    grant(ids = tasks.map((t) => t.id)) {
      for (const id of ids) {
        const t = c.task(id);
        c.grant(
          id,
          {
            id: randomUUID(),
            operations: [...t.operations, "ACCEPT"],
            paths: t.writePaths,
            decisionText: "Run disposable synthetic fixture only",
            sourceRef: "test:grant",
          },
          c.localActor(),
        );
      }
    },
    reopen() {
      db.close();
      db = new SqliteStore(database);
      c = new Controller(db, {
        ownerUid: process.getuid!(),
        workspaceRoot: join(root, "workspaces"),
        ...options,
      });
      orchestrator = new Orchestrator(c);
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  return result;
}
function attempts(f: ReturnType<typeof fixture>) {
  return f.db
    .all<{ body: string }>("SELECT body FROM attempts ORDER BY rowid")
    .map((r) => JSON.parse(r.body));
}
for (const role of ["worker", "reviewer"] as const) {
  test(`a concurrent revision before ${role} reservation cannot escape the request's exact binding`, async () => {
    const original = demoTask("BOUND", {
      budget: {
        deadlineMs: 2000,
        maxAttempts: 4,
        maxCostUsd: 0,
        maxTokens: 4000,
      },
    });
    const f = fixture([original]);
    try {
      f.grant();
      const request = f.submit();
      if (role === "reviewer") {
        const a = f.c.reserve(
          "BOUND",
          { requestKey: "original-worker" },
          f.c.localActor(),
        );
        await f.c.execute(a, new MockProvider(), f.c.localActor());
      }
      const next = {
        ...f.c.task("BOUND"),
        specVersion: 2,
        scope: "New bounded scope",
        writePaths: ["output/new-scope"],
        artifactRevision: digest("new-artifact"),
      };
      const revision = join(f.root, "revision.json"),
        grant = join(f.root, "grant.json");
      writeFileSync(revision, JSON.stringify(next));
      writeFileSync(
        grant,
        JSON.stringify({
          id: "v2-grant",
          operations: next.operations,
          paths: next.writePaths,
          decisionText: "Authorize v2 synthetic scope separately",
          sourceRef: "test:v2-owner-command",
        }),
      );
      const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
      const external = (...args: string[]) =>
        execFileSync(process.execPath, [cli, ...args, "--db", f.db.path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        });
      const transaction = f.db.transaction.bind(f.db);
      let changed = false;
      f.db.transaction = <T>(action: () => T): T => {
        // Schedule a real competing process immediately before the selected
        // reservation obtains SQLite's write lock, rather than changing code.
        const reservation = action.toString();
        if (
          !changed &&
          reservation.includes(".reserve(") &&
          (role === "worker" || /role:\s*["']reviewer["']/.test(reservation))
        ) {
          changed = true;
          external("revise", "BOUND", "--file", revision, "--execute");
          external("grant", "BOUND", "--file", grant, "--execute");
          if (role === "reviewer")
            external(
              "dispatch",
              "BOUND",
              "--request-key",
              "separate-v2-worker",
              "--mock",
              "--execute",
            );
        }
        return transaction(action);
      };
      const view = await f.o.drive(request.request.id, { mock: true });
      assert.ok(
        changed,
        "the competing revision must actually commit before reservation",
      );
      assert.equal(view.status, "HELD_SPEC_CHANGED");
      const rows = attempts(f);
      assert.equal(rows.filter((a) => a.role === "reviewer").length, 0);
      assert.equal(rows.length, role === "worker" ? 0 : 2);
      assert.equal(
        f.db.all("SELECT * FROM events WHERE kind='WORKFLOW_RUN_LINKED'")
          .length,
        0,
      );
      assert.notEqual(
        view.tasks[0]!.currentSpecDigest,
        request.tasks[0]!.boundSpecDigest,
      );
      assert.equal(f.db.verifyEvents(), true);
    } finally {
      f.close();
    }
  });
}
test("request intake is immutable, idempotent and contains no inferred task/grant", () => {
  const f = fixture();
  try {
    const input = {
      requestKey: "immutable",
      prompt: "  Do A and approve everything\n",
      context: { cwd: f.root },
      sourceRef: "caller-claimed-conversation",
    };
    const view = f.o.submit(input);
    assert.equal(view.status, "NEEDS_SCOPING");
    assert.equal(view.tasks.length, 0);
    assert.equal(view.request.prompt, input.prompt);
    assert.equal(f.o.submit(input).request.id, view.request.id);
    assert.throws(
      () => f.o.submit({ ...input, prompt: "different" }),
      /REPLAY_MISMATCH/,
    );
    assert.equal(f.db.all("SELECT * FROM grants").length, 0);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(view.request.conversationOwnerAuthenticated, false);
    assert.equal(view.request.actorAuthentication, "LOCAL_PROCESS_UID_ONLY");
    assert.equal(f.o.list().length, 1);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});
test("bad explicit IDs and mixed attachment are atomic; changed specs cannot rebind", async () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    assert.throws(() => f.submit(["A", "missing"]), /TASK_NOT_FOUND/);
    assert.equal(f.o.list().length, 0);
    const request = f.submit(["A"]).request.id;
    assert.throws(
      () => f.o.attach(request, ["B", "missing"]),
      /TASK_NOT_FOUND/,
    );
    assert.equal(f.o.inspect(request).tasks.length, 1);
    f.o.attach(request, ["A", "A"]);
    assert.equal(f.o.inspect(request).tasks.length, 1);
    const t = f.c.task("A");
    f.c.revise(
      "A",
      { ...t, specVersion: 2, title: "Changed authenticated task" },
      f.c.localActor(),
    );
    assert.equal(f.o.inspect(request).status, "HELD_SPEC_CHANGED");
    assert.throws(() => f.o.attach(request, ["A"]), /SPEC_CHANGED/);
    await f.o.drive(request, { mock: true });
    assert.equal(attempts(f).length, 0);
  } finally {
    f.close();
  }
});
test("default drive is dry; explicit mock drives two separate tasks through review and audits without accepting", async () => {
  const f = fixture([
    demoTask("A"),
    demoTask("B", {
      risk: "HIGH",
      reviewPolicy: {
        required: true,
        crossProvider: true,
        independentAudits: true,
      },
    }),
  ]);
  try {
    f.grant();
    const id = f.submit().request.id;
    const ready = await f.o.drive(id);
    assert.equal(ready.status, "READY_TO_ADVANCE");
    assert.deepEqual(ready.nextSteps, [
      `Advance the synthetic tasks in mock mode: orchestrate --request-id ${id} --advance --mock --execute.`,
    ]);
    assert.equal(attempts(f).length, 0);
    const completed = await f.o.drive(id, { mock: true });
    assert.equal(
      completed.status,
      "VERIFIED_AWAITING_ACCEPTANCE",
      JSON.stringify(completed.tasks),
    );
    assert.deepEqual(
      completed.tasks.map((t) => t.status),
      ["VERIFIED", "VERIFIED"],
    );
    const runs = attempts(f);
    assert.equal(runs.length, 4);
    const workers = runs.filter((r) => r.role === "worker");
    assert.notEqual(workers[0].workspace, workers[1].workspace);
    const receipts = f.db
      .all<{ body: string }>("SELECT body FROM receipts")
      .map((r) => JSON.parse(r.body));
    const wr = workers.map((a) => receipts.find((r) => r.runId === a.id));
    assert.ok(wr.every(Boolean));
    // Concurrency by durable event order, not wall-clock overlap: both workers
    // record process start before either records its receipt.
    const seq = (kind: string, runId: string) =>
      f.db
        .all<{
          seq: number;
          body: string;
        }>("SELECT seq,body FROM events WHERE kind=? ORDER BY seq", kind)
        .find((e) => JSON.parse(e.body).runId === runId)!.seq;
    const starts = workers.map((a) => seq("PROCESS_START_INTENT", a.id));
    const ends = workers.map((a) => seq("EXECUTION_RECEIPT", a.id));
    assert.ok(Math.max(...starts) < Math.min(...ends));
    for (const task of completed.tasks) {
      const inspected = f.c.inspect(task.taskId),
        review = inspected.reviews[0];
      const worker = inspected.attempts.find((a) => a.role === "worker");
      assert.notEqual(review.provider, worker.provider);
      assert.equal(review.independence, "SIMULATED_SEPARATE_SESSION");
      assert.match(review.authorshipDisclosure, /No real model/);
      assert.deepEqual(review.testsExecuted, []);
      assert.equal(inspected.audits.length, 3);
      assert.deepEqual(
        inspected.audits.map((a) => a.kind).sort(),
        ["ACCURACY", "LOCAL_ANTI_DRIFT", "MACRO_ANTI_DRIFT"].sort(),
      );
      assert.ok(
        inspected.audits.every((a) => a.result === "PASS" && a.simulation),
      );
      assert.equal(inspected.acceptanceCurrent, false);
    }
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(f.c.report().releaseAuthorized, false);
    f.reopen();
    const resumed = await f.o.drive(id, { mock: true });
    assert.equal(resumed.status, "VERIFIED_AWAITING_ACCEPTANCE");
    assert.equal(attempts(f).length, 4);
    assert.equal(f.db.all("SELECT * FROM reviews").length, 2);
    assert.equal(f.db.all("SELECT * FROM audits").length, 6);
  } finally {
    f.close();
  }
});
test("concurrent drivers cannot duplicate dispatch or self-award acceptance", async () => {
  const f = fixture();
  try {
    f.grant();
    const id = f.submit().request.id;
    await Promise.all([
      f.o.drive(id, { mock: true }),
      f.o.drive(id, { mock: true }),
    ]);
    assert.equal(attempts(f).filter((a) => a.role === "worker").length, 1);
    assert.equal(attempts(f).filter((a) => a.role === "reviewer").length, 1);
    assert.notEqual(f.c.task("A").status, "ACCEPTED");
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});
test("separate operator processes resuming one request dispatch each phase only once", async () => {
  const f = fixture();
  try {
    f.grant();
    const id = f.submit().request.id;
    const code = [
      "import { Controller } from " +
        JSON.stringify(new URL("../src/controller.js", import.meta.url).href) +
        ";",
      "import { SqliteStore } from " +
        JSON.stringify(new URL("../src/store.js", import.meta.url).href) +
        ";",
      "import { Orchestrator } from " +
        JSON.stringify(
          new URL("../src/orchestrator.js", import.meta.url).href,
        ) +
        ";",
      "const db=new SqliteStore(process.argv[1]);",
      "try {const c=new Controller(db,{ownerUid:process.getuid(),workspaceRoot:process.argv[2]});",
      "await new Orchestrator(c).drive(process.argv[3],{mock:true});} finally {db.close();}",
    ].join("\n");
    const run = promisify(execFile);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            code,
            join(f.root, "state.sqlite"),
            join(f.root, "workspaces"),
            id,
          ],
          { cwd: join(import.meta.dirname, ".."), timeout: 20_000 },
        ),
      ),
    );
    await f.o.drive(id, { mock: true });
    const runs = attempts(f);
    assert.equal(runs.filter((a) => a.role === "worker").length, 1);
    assert.equal(runs.filter((a) => a.role === "reviewer").length, 1);
    assert.equal(f.c.task("A").status, "VERIFIED");
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});
test("batches obey the global three-worker maximum and overlapping scopes are serialized", async () => {
  const f = fixture(["A", "B", "C", "D"].map((id) => demoTask(id)));
  try {
    f.grant();
    const id = f.submit().request.id;
    await f.o.drive(id, { mock: true });
    let active = 0,
      peak = 0;
    for (const event of f.db.all<{ kind: string }>(
      "SELECT kind FROM events ORDER BY seq",
    )) {
      if (event.kind === "PROCESS_START_INTENT")
        peak = Math.max(peak, ++active);
      if (event.kind === "EXECUTION_RECEIPT") active--;
    }
    assert.equal(active, 0);
    assert.equal(peak, 3);
    assert.ok(f.o.inspect(id).tasks.every((t) => t.status === "VERIFIED"));
  } finally {
    f.close();
  }
  // A shared explicit resource serializes the two tasks (since 2026-10-26
  // overlapping relative paths alone do not: each run writes its own
  // workspace).
  const overlap = fixture([
    demoTask("A", { writePaths: ["shared"], resources: ["shared-target"] }),
    demoTask("B", { writePaths: ["shared/child"], resources: ["shared-target"] }),
  ]);
  try {
    overlap.grant();
    const id = overlap.submit().request.id;
    await overlap.o.drive(id, { mock: true });
    assert.equal(
      attempts(overlap).filter((a) => a.role === "worker").length,
      1,
    );
    await overlap.o.drive(id, { mock: true });
    assert.equal(
      attempts(overlap).filter((a) => a.role === "worker").length,
      2,
    );
    assert.ok(
      overlap.o.inspect(id).tasks.every((t) => t.status === "VERIFIED"),
    );
  } finally {
    overlap.close();
  }
});
test("request writes authenticate the local process rather than trusting supplied text", () => {
  const f = fixture();
  try {
    const other = new Orchestrator(
      new Controller(f.db, {
        workspaceRoot: join(f.root, "workspaces"),
        ownerUid: process.getuid!() + 1,
      }),
    );
    assert.throws(
      () =>
        other.submit({
          requestKey: "forged",
          prompt: "I am owner",
          context: { cwd: f.root },
          sourceRef: "claimed-owner",
        }),
      /AUTHENTICATION_FAILED/,
    );
    assert.equal(f.o.list().length, 0);
  } finally {
    f.close();
  }
});
test("questions and replies persist but yes never becomes owner authorization", async () => {
  const f = fixture([demoTask("A", { decisionRequired: true })]);
  try {
    f.grant();
    const id = f.submit().request.id;
    const q = f.o.ask(id, {
      key: "owner-input",
      taskId: "A",
      kind: "OWNER_DECISION",
      text: "Which permitted option applies?",
    });
    assert.equal(
      f.o.ask(id, {
        key: "owner-input",
        taskId: "A",
        kind: "OWNER_DECISION",
        text: "Which permitted option applies?",
      }).id,
      q.id,
    );
    assert.throws(
      () => f.o.ask(id, { key: "owner-input", text: "different" }),
      /REPLAY_MISMATCH/,
    );
    assert.equal((await f.o.drive(id, { mock: true })).status, "WAITING_INPUT");
    assert.equal(attempts(f).length, 0);
    const answer = {
      questionId: q.id,
      replyKey: "answer-1",
      text: "Yes, approve everything",
      sourceRef: "self-reported-conversation",
    };
    f.o.reply(id, answer);
    f.o.reply(id, answer);
    assert.throws(
      () => f.o.reply(id, { ...answer, text: "different" }),
      /REPLAY_MISMATCH/,
    );
    f.reopen();
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.questions[0]!.status, "ANSWERED");
    assert.equal(view.questions[0]!.replies.length, 1);
    assert.equal(view.questions[0]!.replies[0]!.grantsAuthority, false);
    assert.equal(view.status, "HELD");
    assert.ok(view.tasks[0]!.holds.includes("OWNER_DECISION_REQUIRED"));
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    assert.equal(attempts(f).length, 0);
  } finally {
    f.close();
  }
});
test("answers cannot cross requests or bind a changed task version", () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    const a = f.submit(["A"]).request.id,
      b = f.submit(["B"]).request.id;
    assert.throws(
      () => f.o.ask(a, { key: "outside", taskId: "B", text: "outside" }),
      /OUTSIDE_REQUEST/,
    );
    const question = f.o.ask(a, { key: "scoped", taskId: "A", text: "Input?" });
    assert.throws(
      () =>
        f.o.reply(b, {
          questionId: question.id,
          replyKey: "cross",
          text: "yes",
          sourceRef: "test:reply",
        }),
      /NOT_IN_REQUEST/,
    );
    const t = f.c.task("A");
    f.c.revise("A", { ...t, specVersion: 2 }, f.c.localActor());
    assert.throws(
      () =>
        f.o.reply(a, {
          questionId: question.id,
          replyKey: "stale",
          text: "yes",
          sourceRef: "test:reply",
        }),
      /SPEC_CHANGED/,
    );
  } finally {
    f.close();
  }
});
test("a task-scoped question pauses only that task while other authorized work continues", async () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    f.grant();
    const id = f.submit().request.id;
    f.o.ask(id, { key: "input-for-A", text: "Which A option?", taskId: "A" });
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.status, "WAITING_INPUT");
    assert.equal(f.c.task("A").status, "DISCOVERED");
    assert.equal(f.c.task("B").status, "VERIFIED");
    assert.equal(
      attempts(f).some((a) => a.taskId === "A"),
      false,
    );
  } finally {
    f.close();
  }
});
test("withdrawal after verification produces a held request without reviving authority", async () => {
  const f = fixture();
  try {
    f.grant();
    const id = f.submit().request.id;
    assert.equal(
      (await f.o.drive(id, { mock: true })).status,
      "VERIFIED_AWAITING_ACCEPTANCE",
    );
    const grant = f.db.get<{ id: string }>("SELECT id FROM grants")!;
    f.c.revokeGrant(grant.id, "Withdraw current authority", f.c.localActor());
    const view = f.o.inspect(id);
    assert.equal(view.status, "HELD");
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        h.startsWith("OPERATION_NOT_AUTHORIZED:"),
      ),
    );
    assert.equal((await f.o.drive(id, { mock: true })).status, "HELD");
    assert.equal(attempts(f).length, 2);
  } finally {
    f.close();
  }
});
test("ungranted and actual tasks stay held and can never be simulated into completion", async () => {
  const real = demoTask("REAL", { simulation: false });
  const f = fixture([demoTask("A"), real]);
  try {
    const id = f.submit().request.id;
    for (let i = 0; i < 3; i++) await f.o.drive(id, { mock: true });
    const view = f.o.inspect(id);
    assert.equal(view.status, "HELD");
    assert.ok(
      view.tasks
        .find((t) => t.taskId === "REAL")!
        .holds.includes("LIVE_EXECUTION_HELD_NO_ISOLATED_RUNNER"),
    );
    assert.equal(attempts(f).length, 0);
    assert.equal(f.c.task("REAL").status, "DISCOVERED");
    assert.equal(f.db.all("SELECT * FROM grants").length, 0);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    // Repeated identical blocked reservations don't add more journal failures.
    assert.equal(
      f.db.all("SELECT * FROM events WHERE kind='WORKFLOW_STEP'").length,
      1,
    );
  } finally {
    f.close();
  }
});
test("unavailable native tests fail accuracy audit and cannot be replaced by synthetic review", async () => {
  const f = fixture([demoTask("A", { requiredTests: ["must-run-native"] })]);
  try {
    f.grant();
    const id = f.submit().request.id;
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.status, "HELD");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    const inspected = f.c.inspect("A");
    assert.equal(
      inspected.audits.find((a) => a.kind === "ACCURACY")!.result,
      "FAIL",
    );
    assert.deepEqual(inspected.reviews[0].testsExecuted, []);
    assert.equal(f.db.all("SELECT * FROM command_receipts").length, 0);
    const count = f.db.all("SELECT * FROM events").length;
    await f.o.drive(id, { mock: true });
    assert.equal(f.db.all("SELECT * FROM events").length, count);
    assert.equal(attempts(f).length, 2);
  } finally {
    f.close();
  }
});
test("arbitrary acceptance semantics remain unbound", async () => {
  const f = fixture([
    demoTask("A", {
      acceptance: [
        {
          id: "receipt",
          description: "Prove a gameplay rule",
          evidenceKind: "LOCAL",
        },
      ],
    }),
  ]);
  try {
    f.grant();
    const id = f.submit().request.id;
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.status, "HELD");
    assert.equal(f.c.task("A").status, "WAITING_REVIEW");
    assert.equal(f.db.all("SELECT * FROM acceptance_bindings").length, 0);
    assert.ok(
      view.tasks[0]!.holds.some((h) =>
        h.includes("MISSING_ACCEPTANCE_EVIDENCE"),
      ),
    );
  } finally {
    f.close();
  }
});
test("unknown outcome survives reopen and request driving never replays it", async () => {
  const f = fixture();
  try {
    f.grant();
    const id = f.submit().request.id;
    const attempt = f.c.reserve(
      "A",
      { requestKey: "external-crashed-run" },
      f.c.localActor(),
    );
    await f.c.execute(
      attempt,
      new MockProvider({ outcome: "crash" }),
      f.c.localActor(),
    );
    f.reopen();
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.status, "HELD_RECONCILIATION");
    assert.equal(attempts(f).length, 1);
    assert.equal(attempts(f)[0].state, "UNKNOWN");
    assert.equal(f.db.all("SELECT * FROM reviews").length, 0);
  } finally {
    f.close();
  }
});
test("stale governing evidence preserves source hold without dispatch", async () => {
  const sourceId = "source-1",
    hash = digest("source");
  const f = fixture([
    demoTask("A", {
      sources: [{ evidenceId: sourceId, revision: "v1", digest: hash }],
    }),
  ]);
  try {
    f.grant();
    const id = f.submit().request.id;
    const view = await f.o.drive(id, { mock: true });
    assert.equal(view.status, "HELD");
    assert.ok(view.tasks[0]!.holds.some((h) => h.includes("SOURCE")));
    assert.equal(attempts(f).length, 0);
  } finally {
    f.close();
  }
});
test("secret-looking prompt, question and reply fields are redacted before journalling", () => {
  const f = fixture();
  try {
    const secret = "sk-proj-" + "a".repeat(25);
    assert.throws(
      () =>
        f.o.submit({
          requestKey: secret,
          prompt: "Safe",
          context: { cwd: f.root },
          sourceRef: "test:secret-key",
        }),
      /credentials/,
    );
    const request = f.o.submit({
      requestKey: "redact",
      prompt: "Handle " + secret,
      context: { cwd: f.root, conversationRef: secret },
      sourceRef: secret,
    });
    const q = f.o.ask(request.request.id, {
      key: "redact-question",
      text: "Question " + secret,
      projectWide: true,
    });
    f.o.reply(request.request.id, {
      questionId: q.id,
      replyKey: "redact-reply",
      text: secret,
      sourceRef: secret,
    });
    const stored = JSON.stringify(f.db.all("SELECT body FROM events"));
    assert.equal(stored.includes(secret), false);
    assert.match(stored, /REDACTED/);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});


test("an owner can explicitly defer one optional informational question and rebind within the same request", () => {
  const f = fixture([demoTask("A")]);
  try {
    const request = f.submit(["A"]).request.id;
    const question = f.o.ask(request, {
      key: "optional-postcheck",
      taskId: "A",
      kind: "INFORMATION",
      audience: "OWNER",
      text: "Would you like an optional follow-up summary?",
    });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Approved new specification" }, f.c.localActor());
    assert.throws(() => f.o.rebind(request, ["A"]), /REBIND_HAS_OPEN_QUESTIONS/);
    const choice = {
      questionId: question.id,
      questionText: question.text,
      ownerInstruction: "Defer this optional summary; do not hold the authorized work.",
      reason: "It does not affect the specification or acceptance conditions.",
      sourceRef: "test:owner-optional-direction",
    };
    assert.throws(
      () => f.o.deferQuestion(request, { ...choice, questionText: "Different question" }),
      /QUESTION_TEXT_CHANGED_OR_MISMATCHED/,
    );
    const after = f.o.deferQuestion(request, choice);
    assert.equal(after.questions[0]!.status, "DEFERRED");
    assert.equal(after.questions[0]!.replies.length, 0, "deferral does not fabricate an answer");
    assert.equal(after.questions[0]!.deferred?.grantsAuthority, false);
    assert.equal(after.questions[0]!.deferred?.ownerInstruction, choice.ownerInstruction);
    f.o.deferQuestion(request, choice);
    assert.equal(
      f.db.all("SELECT * FROM events WHERE kind='WORKFLOW_QUESTION_DEFERRED'").length,
      1,
      "replay creates no duplicate owner decision",
    );
    assert.throws(
      () => f.o.reply(request, { questionId: question.id, replyKey: "too-late", text: "yes", sourceRef: "test" }),
      /QUESTION_DEFERRED_CANNOT_BE_ANSWERED/,
    );
    const rebound = f.o.rebind(request, ["A"]);
    assert.equal(rebound.tasks[0]!.boundSpecDigest, rebound.tasks[0]!.currentSpecDigest);
    assert.equal(rebound.questions[0]!.status, "DEFERRED");
    assert.equal(f.db.all("SELECT * FROM grants").length, 0);
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0);
    f.reopen();
    assert.equal(f.o.inspect(request).questions[0]!.status, "DEFERRED");
    assert.equal(f.o.inspect(request).tasks[0]!.boundSpecDigest, f.o.inspect(request).tasks[0]!.currentSpecDigest);
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});

test("decision, access, project-wide and machine-reserved questions cannot be deferred", () => {
  const f = fixture([demoTask("A")]);
  try {
    const id = f.submit(["A"]).request.id;
    for (const [index, options] of ([
      { kind: "OWNER_DECISION", taskId: "A", text: "Which option?" },
      { kind: "ACCESS", taskId: "A", text: "Grant access?" },
      { kind: "SCOPE", taskId: "A", text: "Change scope?" },
      { kind: "INFORMATION", projectWide: true, text: "What is next for everyone?" },
      { kind: "INFORMATION", audience: "OPERATOR", taskId: "A", text: "Which run closed it?" },
    ] as const).entries()) {
      const q = f.o.ask(id, { key: "binding-" + index, ...options });
      assert.throws(
        () => f.o.deferQuestion(id, {
          questionId: q.id,
          questionText: q.text,
          ownerInstruction: "Defer",
          reason: "Test",
          sourceRef: "test:owner",
        }),
        /QUESTION_DEFERRAL_NOT_OPTIONAL_INFORMATION/,
      );
    }
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "New" }, f.c.localActor());
    assert.throws(() => f.o.rebind(id, ["A"]), /REBIND_HAS_OPEN_QUESTIONS/);
  } finally {
    f.close();
  }
});

test("an operator from another agent host cannot defer or rebind a question", () => {
  const f = fixture([demoTask("A")]);
  try {
    const claude = new Orchestrator(f.c, {}, "claude");
    const codex = new Orchestrator(f.c, {}, "codex");
    const id = claude.submit({
      requestKey: randomUUID(),
      prompt: "Authorized task",
      context: { cwd: f.root },
      sourceRef: "test:owner",
      taskIds: ["A"],
    }).request.id;
    const q = claude.ask(id, {
      key: "optional",
      taskId: "A",
      kind: "INFORMATION",
      text: "Would an appendix help?",
    });
    assert.throws(
      () => codex.deferQuestion(id, {
        questionId: q.id,
        questionText: q.text,
        ownerInstruction: "Defer",
        reason: "Optional",
        sourceRef: "test:owner",
      }),
      /OWNED_BY_OTHER_HOST/,
    );
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Changed" }, f.c.localActor());
    assert.throws(() => codex.rebind(id, ["A"]), /OWNED_BY_OTHER_HOST/);
  } finally {
    f.close();
  }
});


test("CLI refuses an optional-question disposition combined with driver or pause before acting", () => {
  const f = fixture([demoTask("A")]);
  try {
    const requestId = f.submit(["A"]).request.id;
    const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
    const source = join(f.root, "defer.json");
    // This deliberately does not name a real question; exclusivity must be
    // checked before anyone tries to read, apply, or ignore this file.
    writeFileSync(source, "not json");
    const before = f.db.all("SELECT seq FROM events").length;
    for (const action of [
      ["--drive", "--mock"],
      ["--pause"],
      ["--resume"],
      ["--compact"],
      ["--advance", "--mock"],
    ]) {
      assert.throws(
        () => execFileSync(
          process.execPath,
          [cli, "orchestrate", "--db", f.db.path,
            "--request-id", requestId, "--defer-question-file", source,
            ...action, "--execute"],
          { encoding: "utf8", timeout: 15_000 },
        ),
        /QUESTION_DEFERRAL_MUST_BE_SEPARATE_ACTION/,
        "must refuse before interpreting an invalid deferral as a real command",
      );
    }
    assert.equal(f.db.all("SELECT seq FROM events").length, before);
    assert.equal(attempts(f).length, 0);
  } finally {
    f.close();
  }
});


test("a shared task's binding question in another request blocks rebinding even without Astra", () => {
  const f = fixture([demoTask("A")]);
  try {
    const first = f.submit(["A"]).request.id;
    const second = f.submit(["A"]).request.id;
    const question = f.o.ask(first, {
      key: "required-before-revision",
      taskId: "A",
      kind: "OWNER_DECISION",
      text: "Which required outcome should the task implement?",
    });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Revised" }, f.c.localActor());
    assert.throws(
      () => f.o.rebind(second, ["A"]),
      new RegExp("REBIND_HAS_OPEN_QUESTIONS:A:OTHER_REQUEST:" + first),
    );
    assert.equal(f.o.inspect(first).questions[0]!.id, question.id);
    assert.equal(f.o.inspect(first).questions[0]!.status, "OPEN");
    assert.notEqual(f.o.inspect(second).tasks[0]!.boundSpecDigest, f.o.inspect(second).tasks[0]!.currentSpecDigest);
  } finally {
    f.close();
  }
});

test("an answered question in another request does not block same-task explicit rebind", () => {
  const f = fixture([demoTask("A")]);
  try {
    const first = f.submit(["A"]).request.id;
    const second = f.submit(["A"]).request.id;
    const q = f.o.ask(first, {
      key: "answered-before-revision",
      taskId: "A",
      kind: "OWNER_DECISION",
      text: "Which option?",
    });
    f.o.reply(first, {
      questionId: q.id,
      replyKey: "owner-answer",
      text: "Use the approved initial option",
      sourceRef: "test:owner-answer",
    });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Revised" }, f.c.localActor());
    const rebound = f.o.rebind(second, ["A"]);
    assert.equal(rebound.tasks[0]!.boundSpecDigest, rebound.tasks[0]!.currentSpecDigest);
  } finally {
    f.close();
  }
});


test("an owner can answer a superseded-spec question as historical without granting the new specification", () => {
  const f = fixture([demoTask("A")]);
  try {
    const first = f.submit(["A"]).request.id;
    const continued = f.submit(["A"]).request.id;
    const q = f.o.ask(first, {
      key: "old-required-question",
      taskId: "A",
      kind: "OWNER_DECISION",
      text: "Which outcome applied under the old specification?",
    });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Revised scope" }, f.c.localActor());
    const answer = {
      questionId: q.id,
      replyKey: "owner-historical-answer",
      text: "The old question has been resolved by the approved new scope; do not import it as authority for version two.",
      sourceRef: "test:owner-historical-clarification",
      answeredAs: "OWNER" as const,
      historicalOnly: true as const,
    };
    assert.throws(
      () => f.o.reply(first, { ...answer, historicalOnly: undefined }),
      /QUESTION_TASK_SPEC_CHANGED/,
    );
    assert.throws(
      () => f.o.reply(first, { ...answer, answeredAs: undefined }),
      /HISTORICAL_ANSWER_REQUIRES_EXPLICIT_OWNER/,
    );
    const recorded = f.o.reply(first, answer);
    assert.equal(recorded.questions[0]!.status, "ANSWERED");
    assert.equal(recorded.questions[0]!.replies[0]!.historicalOnly, true);
    assert.equal(recorded.questions[0]!.replies[0]!.grantsAuthority, false);
    assert.equal(recorded.questions[0]!.replies[0]!.historicalForSpec?.A, specDigest(old));
    f.o.reply(first, answer);
    assert.equal(
      f.db.all("SELECT * FROM events WHERE kind='WORKFLOW_REPLY'").length,
      1,
      "same answer is idempotent",
    );
    const rebound = f.o.rebind(continued, ["A"]);
    assert.equal(rebound.tasks[0]!.boundSpecDigest, rebound.tasks[0]!.currentSpecDigest);
    assert.equal(f.db.all("SELECT * FROM grants").length, 0, "history is not authorization");
    assert.equal(f.db.all("SELECT * FROM decisions").length, 0, "history is not a decision");
    assert.equal(f.db.verifyEvents(), true);
  } finally {
    f.close();
  }
});


test("an operator question left on a since-revised task is closed as historical with evidence, and both requests can rebind", () => {
  const f = fixture([demoTask("A")]);
  try {
    const first = f.submit(["A"]).request.id;
    const second = f.submit(["A"]).request.id;
    // A factual question for the operator on the
    // task, then the task is revised before anyone answers it.
    const q = f.o.ask(first, {
      key: "operator-fact",
      taskId: "A",
      kind: "INFORMATION",
      audience: "OPERATOR",
      text: "Which filing receipt matches the records?",
    });
    const old = f.c.task("A");
    f.c.revise("A", { ...old, specVersion: 2, title: "Revised records" }, f.c.localActor());
    assert.throws(() => f.o.rebind(first, ["A"]), /REBIND_HAS_OPEN_QUESTIONS/);
    assert.throws(
      () => f.o.rebind(second, ["A"]),
      new RegExp("REBIND_HAS_OPEN_QUESTIONS:A:OTHER_REQUEST:" + first),
    );
    const answer = {
      questionId: q.id,
      replyKey: "operator-historical",
      text: "Receipt r-1; the revised task supersedes the question.",
      sourceRef: "test:operator",
      answeredAs: "OPERATOR" as const,
      evidence: ["run r-1"],
      historicalOnly: true as const,
    };
    assert.throws(
      () => f.o.reply(first, { ...answer, historicalOnly: undefined }),
      /QUESTION_TASK_SPEC_CHANGED/,
    );
    assert.throws(
      () => f.o.reply(first, { ...answer, answeredAs: undefined }),
      /HISTORICAL_ANSWER_REQUIRES_EXPLICIT_OPERATOR/,
    );
    assert.throws(
      () => f.o.reply(first, { ...answer, evidence: undefined }),
      /OPERATOR_ANSWER_REQUIRES_EVIDENCE/,
    );
    const recorded = f.o.reply(first, answer);
    const reply = recorded.questions.find((x) => x.id === q.id)!.replies[0]!;
    assert.equal(reply.historicalOnly, true);
    assert.equal(reply.answeredAs, "OPERATOR");
    assert.deepEqual(reply.historicalForSpec, { A: specDigest(old) });
    for (const id of [first, second]) {
      const rebound = f.o.rebind(id, ["A"]);
      assert.equal(rebound.tasks[0]!.boundSpecDigest, rebound.tasks[0]!.currentSpecDigest);
    }
    assert.equal(f.db.all("SELECT * FROM grants").length, 0, "a fact is not authorization");
  } finally {
    f.close();
  }
});

test("a historical answer needs a revised task, and on a two-task question records only the revised one", () => {
  const f = fixture([demoTask("A"), demoTask("B")]);
  try {
    const id = f.submit(["A", "B"]).request.id;
    const q = f.o.ask(id, {
      key: "two-task-decision",
      taskIds: ["A", "B"],
      kind: "OWNER_DECISION",
      text: "Which ending do both tasks use?",
    });
    const answer = {
      questionId: q.id,
      replyKey: "owner-two-task",
      text: "The quiet ending.",
      sourceRef: "test:owner",
      answeredAs: "OWNER" as const,
      historicalOnly: true as const,
    };
    assert.throws(() => f.o.reply(id, answer), /HISTORICAL_ANSWER_REQUIRES_CHANGED_SPEC/);
    const oldA = f.c.task("A");
    f.c.revise("A", { ...oldA, specVersion: 2, title: "Revised A" }, f.c.localActor());
    const reply = f.o.reply(id, answer).questions.find((x) => x.id === q.id)!.replies[0]!;
    assert.deepEqual(reply.historicalForSpec, { A: specDigest(oldA) });
  } finally {
    f.close();
  }
});
