/** Y14 R7: real accepted artifacts must share nested dense reachability. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { project, checkpoint, workWith, review, acceptTask, gateway, AT } from "./fixtures/adaptive/remediation-project.js";

test("Y14: accepted and unaccepted dense Drive writers share edge work during real reviewer reservation", async (t) => {
  const n = 16;
  const ids = Array.from({ length: n }, (_, i) => "D" + i);
  const f = project({ tasks: [...ids, "TARGET"].map(id => ({ id, drive: true, reviewAcceptance: true })) });
  try {
    const scoped = (taskId: string) => {
      const request = f.o.submit({ requestKey: randomUUID(), prompt: "Dense lineage task " + taskId,
        context: { cwd: f.root, projectKey: "dense-" + taskId }, sourceRef: "test:owner" }).request;
      f.o.attach(request.id, [taskId]);
      return { ...f, id: request.id };
    };
    const writers: Array<{ id: string; fileId: string; accepted: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const taskId = ids[i]!;
      const task = scoped(taskId);
      await checkpoint(task, undefined, taskId);
      const fileId = "ACCEPTEDDENSE" + String(i).padStart(10, "0");
      const made = await workWith(task, taskId, a => gateway(join(a.workspace, "drive-changes", a.id), [
        { at: AT, op: "create", ok: true, fileId, versionAfter: "1" },
        { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
      ]));
      assert.equal(made.receipt.status, "SUCCEEDED");
      const accepted = i % 2 === 1;
      if (accepted) {
        const judged = await review(task, "PASS", taskId);
        f.c.bindAcceptance(taskId, "receipt", "output-" + made.attempt.id, f.c.localActor());
        f.c.bindAcceptance(taskId, "review", "review-workflow-review-" + judged.id, f.c.localActor());
        acceptTask(task, taskId, judged.id);
        assert.equal(f.c.task(taskId).status, "ACCEPTED", "acceptance is established through public audit/verify/accept");
      }
      writers.push({ id: made.attempt.id, fileId, accepted });
    }
    const targetProject = scoped("TARGET");
    await checkpoint(targetProject, undefined, "TARGET");
    const target = await workWith(targetProject, "TARGET", a => gateway(join(a.workspace, "drive-changes", a.id), [
      { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
    ]));
    assert.equal(target.receipt.status, "SUCCEEDED");

    const c = f.c as any;
    const original = c.lineageSources.bind(c);
    const byCache = new Map<object, { calls: number; edges: number }>();
    let calls = 0, edges = 0;
    c.lineageSources = (id: string, cache: any) => {
      const sources = original(id, cache);
      if (f.db.inWriteTransaction()) {
        const counted = byCache.get(cache) ?? { calls: 0, edges: 0 };
        counted.calls++;
        byCache.set(cache, counted);
        calls++;
        // Count actual source-edge iteration by the real traversal, including
        // nested accepted-task queries. Preserve the original cached records;
        // this observer neither supplies edges nor replaces their resolution.
        return new Proxy(sources, { get(target, property, receiver) {
          if (property === Symbol.iterator) return function* () {
            for (const source of target) { counted.edges++; edges++; yield source; }
          };
          return Reflect.get(target, property, receiver);
        } });
      }
      return sources;
    };
    let reviewer;
    try {
      reviewer = f.c.reserve("TARGET", {
        role: "reviewer", projectRequestId: targetProject.id, requestKey: "dense-review:" + randomUUID(),
      }, f.c.localActor());
    } finally { c.lineageSources = original; }
    assert.equal(reviewer.provider, "claude");
    const authorship = c.taskAuthorship(f.c.task("TARGET"));
    assert.equal(authorship.unknown, false);
    for (const writer of writers) assert.equal(authorship.runs.includes(writer.id), !writer.accepted,
      "accepted producers are exempt while all unaccepted authors remain");
    const returnedIds = n * (n - 1) / 2 + n;
    const gatewayEntries = 2 * n + 1;
    const budget = 4 * (gatewayEntries + returnedIds + n);
    t.diagnostic(`${n} real workers, ${n / 2} publicly accepted; ${returnedIds} discovery IDs; ${calls} source visits; ${edges} edge visits; ${byCache.size} read scopes; budget ${budget}; scopes ${JSON.stringify([...byCache.values()])}`);
    assert.ok(edges <= budget, `nested accepted lineage exceeds the linear edge-work budget: ${edges} > ${budget}`);
  } finally { f.close(); }
});
