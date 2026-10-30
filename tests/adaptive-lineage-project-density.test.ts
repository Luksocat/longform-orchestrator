/** Y14 R8: a whole project's checkpoint must share accepted lineage work. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical } from "../src/domain.js";
import { MockProvider } from "../src/providers.js";
import { project, coordination, workWith, review, acceptTask, gateway, AT, type Project } from "./fixtures/adaptive/remediation-project.js";

async function checkpointRun(f: Project, taskId: string) {
  const attempt = f.c.reserve(taskId, {
    role: "overseer", projectRequestId: f.id, requestKey: "project-density:" + randomUUID(),
  }, f.c.localActor());
  const receipt = await f.c.execute(attempt, new MockProvider({
    output: canonical(coordination(attempt.projectContext!)),
  }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  return { attempt, receipt };
}

function record(f: Project, run: Awaited<ReturnType<typeof checkpointRun>>) {
  // Match the orchestrator's public checkpoint boundary: preparation occurs
  // outside its outer transaction, and checkpoint/questions commit together.
  f.c.warmLineage();
  return f.db.transaction(() => {
    const checkpoint = f.c.recordProjectCheckpoint(run.attempt.projectContext!, run.attempt.id, run.receipt.output);
    (f.o as any).recordAstraQuestions(f.id, checkpoint);
    return checkpoint;
  });
}

test("Y14: one public project checkpoint shares dense accepted history across every task gate", async (t) => {
  const n = 12;
  const ids = Array.from({ length: n }, (_, i) => "D" + i);
  const f = project({ tasks: [...ids, "TARGET"].map(id => ({ id, drive: true, reviewAcceptance: true })) });
  try {
    const writers: Array<{ id: string; fileId: string; accepted: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const taskId = ids[i]!;
      record(f, await checkpointRun(f, taskId));
      const fileId = "PROJECTDENSE" + String(i).padStart(10, "0");
      const made = await workWith(f, taskId, a => gateway(join(a.workspace, "drive-changes", a.id), [
        { at: AT, op: "create", ok: true, fileId, versionAfter: "1" },
        { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
      ]));
      assert.equal(made.receipt.status, "SUCCEEDED");
      const accepted = i % 2 === 1;
      if (accepted) {
        const judged = await review(f, "PASS", taskId);
        f.c.bindAcceptance(taskId, "receipt", "output-" + made.attempt.id, f.c.localActor());
        f.c.bindAcceptance(taskId, "review", "review-workflow-review-" + judged.id, f.c.localActor());
        acceptTask(f, taskId, judged.id);
        assert.equal(f.c.task(taskId).status, "ACCEPTED", "accept through public review/audit/verify/decide/accept");
      }
      writers.push({ id: made.attempt.id, fileId, accepted });
    }
    record(f, await checkpointRun(f, "TARGET"));
    const target = await workWith(f, "TARGET", a => gateway(join(a.workspace, "drive-changes", a.id), [
      { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
    ]));
    assert.equal(target.receipt.status, "SUCCEEDED");
    const run = await checkpointRun(f, "TARGET");
    assert.deepEqual(run.attempt.projectContext!.snapshot.tasks.map(t => t.task.id).sort(), [...ids, "TARGET"].sort(),
      "all accepted and unaccepted writers belong to this one checkpoint's project");

    const c = f.c as any;
    const sources = c.lineageSources.bind(c), cache = c.lineageCache.bind(c);
    const currency = c.acceptanceCurrentInScope.bind(c);
    const checkpoint = c.recordProjectCheckpoint.bind(c);
    const byCache = new Map<object, { calls: number; edges: number }>();
    let edgeVisits = 0, constructions = 0, currencyChecks = 0;
    let recording = false;
    c.recordProjectCheckpoint = (...args: unknown[]) => {
      recording = true;
      try { return checkpoint(...args); }
      finally { recording = false; }
    };
    c.lineageCache = () => {
      const active = c.activeLineageCache;
      const value = cache();
      if (recording && f.db.inWriteTransaction() && !active) constructions++;
      return value;
    };
    c.acceptanceCurrentInScope = (...args: unknown[]) => {
      if (recording && f.db.inWriteTransaction()) currencyChecks++;
      return currency(...args);
    };
    c.lineageSources = (id: string, active: object) => {
      const value = sources(id, active);
      if (!recording || !f.db.inWriteTransaction()) return value;
      const count = byCache.get(active) ?? { calls: 0, edges: 0 };
      count.calls++;
      byCache.set(active, count);
      return new Proxy(value, { get(target, property, receiver) {
        if (property === Symbol.iterator) return function* () {
          for (const source of target) { count.edges++; edgeVisits++; yield source; }
        };
        return Reflect.get(target, property, receiver);
      } });
    };
    let recorded;
    try { recorded = record(f, run); }
    finally {
      c.lineageSources = sources;
      c.lineageCache = cache;
      c.acceptanceCurrentInScope = currency;
      c.recordProjectCheckpoint = checkpoint;
    }
    assert.equal(recorded.runId, run.attempt.id);
    const returnedIds = n * (n - 1) / 2 + n;
    const budget = 3 * (returnedIds + 2 * n + 1);
    t.diagnostic(`${n} real writers, ${n / 2} publicly accepted in one project; ${returnedIds} discovery IDs; ${edgeVisits} edge visits; ${constructions} cache constructions; ${currencyChecks} full currency checks; budget ${budget}; scopes ${JSON.stringify([...byCache.values()])}`);
    assert.ok(edgeVisits <= budget, `checkpoint repeats dense history beyond the linear edge-work budget: ${edgeVisits} > ${budget}`);
    assert.ok(constructions <= 2, `checkpoint builds a cache per task instead of per read batch: ${constructions}`);
    assert.ok(currencyChecks <= n, `checkpoint repeats accepted-task currency work: ${currencyChecks}`);
    assert.ok(edgeVisits >= n * (n - 1) / 2, "the measured checkpoint traverses the actual dense writer history");
    assert.ok(constructions >= 1, "the checkpoint begins a fresh read scope");
    assert.ok(currencyChecks >= n / 2, "every accepted task is checked in that read scope");

    const authorship = c.taskAuthorship(f.c.task("TARGET"));
    assert.equal(authorship.unknown, false);
    for (const writer of writers) assert.equal(authorship.runs.includes(writer.id), !writer.accepted,
      "accepted artifacts remain exempt while all unaccepted writers remain authors");
  } finally { f.close(); }
});
