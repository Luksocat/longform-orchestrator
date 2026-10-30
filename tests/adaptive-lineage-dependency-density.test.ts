/** Y14 R9: accepted dependencies share lineage work at public lifecycle gates. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical } from "../src/domain.js";
import { MockProvider } from "../src/providers.js";
import { project, coordination, workWith, review, acceptTask, gateway, runs, EVIDENCE, AT, type Project } from "./fixtures/adaptive/remediation-project.js";

async function checkpoint(f: Project, taskId: string) {
  const attempt = f.c.reserve(taskId, {
    role: "overseer", projectRequestId: f.id, requestKey: "dependency-density:" + randomUUID(),
  }, f.c.localActor());
  const receipt = await f.c.execute(attempt, new MockProvider({
    output: canonical(coordination(attempt.projectContext!)),
  }), f.c.localActor());
  assert.equal(receipt.status, "SUCCEEDED", canonical(receipt));
  f.c.warmLineage();
  f.db.transaction(() => {
    const recorded = f.c.recordProjectCheckpoint(attempt.projectContext!, attempt.id, receipt.output);
    (f.o as any).recordAstraQuestions(f.id, recorded);
  });
}

type Operation = "reserve" | "start" | "heartbeat" | "finish" | "verify" | "accept";
type Counts = {
  constructions: number;
  edgeVisits: number;
  currencyChecks: number;
  currencyTasks: Record<string, number>;
  writes: number;
  writesWithActiveCache: number;
  scopes: Map<object, { calls: number; edges: number; origin: string }>;
};

test("Y14: public worker lifecycle shares dense REVIEW-bound dependency validation", async (t) => {
  const n = 12;
  const ids = Array.from({ length: n }, (_, i) => "D" + i);
  const dependencies = ids.filter((_, i) => i % 2 === 1);
  const f = project({
    tasks: [...ids, "FINAL"].map(id => ({ id, drive: true, reviewAcceptance: true })),
    // Six dependencies demand PROGRAMME oversight; qualify it using the
    // fixture's scripted evaluation harness, just like its existing tiers.
    evidence: { ...EVIDENCE, overseers: { ...EVIDENCE.overseers, PROGRAMME: [["astra-max-overseer", "strong"]] } },
  });
  try {
    const final = f.c.task("FINAL");
    f.c.revise("FINAL", { ...final, specVersion: final.specVersion + 1, dependencies }, f.c.localActor());
    f.o.rebind(f.id, ["FINAL"]);
    f.c.grant("FINAL", {
      id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: ["output/FINAL", "drive-changes"],
      decisionText: "Simulation work after all six accepted dependencies", sourceRef: "test:owner",
    }, f.c.localActor());

    // The same real project history as the checkpoint regression: every
    // writer discovers all preceding files, and alternate writers become
    // accepted through public REVIEW evidence, audit, verify and accept.
    const writers: Array<{ id: string; fileId: string; accepted: boolean }> = [];
    for (let i = 0; i < n; i++) {
      const taskId = ids[i]!;
      await checkpoint(f, taskId);
      const fileId = "DEPENDENCYDENSE" + String(i).padStart(10, "0");
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
        assert.equal(f.c.task(taskId).status, "ACCEPTED");
      }
      writers.push({ id: made.attempt.id, fileId, accepted });
    }
    await checkpoint(f, "FINAL");
    assert.deepEqual(f.c.task("FINAL").dependencies, dependencies);

    // These observers delegate every production call and every array item.
    // They neither construct source edges nor replace database/attempt data.
    const c = f.c as any;
    const sources = c.lineageSources.bind(c), cache = c.lineageCache.bind(c);
    const currency = c.acceptanceCurrentInScope.bind(c), finish = c.finish.bind(c);
    const databaseRun = f.db.run.bind(f.db);
    const operations: Operation[] = ["reserve", "start", "heartbeat", "finish", "verify", "accept"];
    const counts = Object.fromEntries(operations.map(op => [op, {
      constructions: 0, edgeVisits: 0, currencyChecks: 0, currencyTasks: {}, writes: 0, writesWithActiveCache: 0, scopes: new Map(),
    }])) as Record<Operation, Counts>;
    let current: Operation | undefined;
    function measure<T>(operation: Operation, action: () => T): T {
      assert.equal(current, undefined, "lifecycle measurements must not overlap");
      current = operation;
      try { return action(); }
      finally { current = undefined; }
    }
    c.lineageCache = () => {
      const active = c.activeLineageCache;
      const value = cache();
      if (current && f.db.inWriteTransaction() && !active) {
        const count = counts[current];
        count.constructions++;
        const origin = new Error().stack!.split("\n").slice(1)
          .map(line => line.trim().match(/^at ([^ (]+)/)?.[1] ?? "unknown")
          .filter(name => !name.endsWith("lineageCache") && !name.endsWith("withLineageWalk"))
          .slice(0, 3).join(" -> ");
        count.scopes.set(value, { calls: 0, edges: 0, origin });
      }
      return value;
    };
    c.acceptanceCurrentInScope = (...args: any[]) => {
      if (current && f.db.inWriteTransaction()) {
        const count = counts[current];
        count.currencyChecks++;
        count.currencyTasks[args[0].id] = (count.currencyTasks[args[0].id] ?? 0) + 1;
      }
      return currency(...args);
    };
    c.lineageSources = (id: string, active: object) => {
      const value = sources(id, active);
      if (!current || !f.db.inWriteTransaction()) return value;
      const count = counts[current];
      const scope = count.scopes.get(active) ?? { calls: 0, edges: 0, origin: "constructed before measured write transaction" };
      scope.calls++;
      count.scopes.set(active, scope);
      return new Proxy(value, { get(target, property, receiver) {
        if (property === Symbol.iterator) return function* () {
          for (const source of target) { scope.edges++; count.edgeVisits++; yield source; }
        };
        return Reflect.get(target, property, receiver);
      } });
    };
    c.finish = (...args: unknown[]) => measure("finish", () => finish(...args));
    f.db.run = (sql, ...args) => {
      if (current && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
        counts[current].writes++;
        if (c.activeLineageCache) counts[current].writesWithActiveCache++;
      }
      return databaseRun(sql, ...args);
    };
    try {
      const attempt = measure("reserve", () => f.c.reserve("FINAL", {
        role: "worker", projectRequestId: f.id, requestKey: "dependency-worker:" + randomUUID(),
      }, f.c.localActor()));
      assert.equal(attempt.state, "RESERVED");
      gateway(join(attempt.workspace, "drive-changes", attempt.id), [
        { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
      ]);

      const provider = new MockProvider({ output: "SIMULATION: final dependent artifact" });
      const execute = provider.execute.bind(provider);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      provider.execute = async request => {
        entered();
        await pending;
        return execute(request);
      };
      const running = measure("start", () => f.c.execute(attempt, provider, f.c.localActor()));
      let workerReceipt;
      try {
        await Promise.race([started, running.then(() => { throw new Error("worker ended before its provider started"); })]);
        const active = runs(f, "worker", "FINAL").find(a => a.id === attempt.id)!;
        assert.equal(active.state, "STARTED", "heartbeat must check an actual running worker");
        const lease = measure("heartbeat", () => f.c.heartbeat(active.id, active.leaseOwner));
        assert.ok(lease >= active.leaseUntil);
        assert.equal(runs(f, "worker", "FINAL").find(a => a.id === active.id)!.state, "STARTED");
      } finally {
        release();
        workerReceipt = await running;
      }
      assert.equal(workerReceipt.status, "SUCCEEDED");
      assert.equal(runs(f, "worker", "FINAL").find(a => a.id === attempt.id)!.state, "SUCCEEDED");

      // Finish is measured at the public method invoked by execute itself.
      // The independent reviewer and audit prepare real verification gates.
      c.finish = finish;
      const judged = await review(f, "PASS", "FINAL");
      f.c.bindAcceptance("FINAL", "receipt", "output-" + attempt.id, f.c.localActor());
      f.c.bindAcceptance("FINAL", "review", "review-workflow-review-" + judged.id, f.c.localActor());
      f.c.grant("FINAL", {
        id: randomUUID(), operations: ["ACCEPT"], paths: ["output/FINAL"],
        decisionText: "Accept the synthetic final artifact", sourceRef: "test:owner",
      }, f.c.localActor());
      f.c.audit("FINAL", f.c.localActor(), judged.id);
      measure("verify", () => f.c.verify("FINAL", f.c.localActor()));
      assert.equal(f.c.task("FINAL").status, "VERIFIED");
      f.c.decide("FINAL", {
        id: "accept-FINAL", text: "Accept the synthetic final artifact", sourceRef: "test:owner",
        alternatives: [], limits: ["simulation"], operations: ["ACCEPT"], artifactRevision: f.c.task("FINAL").artifactRevision,
      }, f.c.localActor());
      measure("accept", () => f.c.accept("FINAL", f.c.localActor()));
      assert.equal(f.c.task("FINAL").status, "ACCEPTED");
    } finally {
      c.lineageSources = sources;
      c.lineageCache = cache;
      c.acceptanceCurrentInScope = currency;
      c.finish = finish;
      f.db.run = databaseRun;
    }

    const denseEdges = n * (n - 1) / 2;
    const returnedIds = denseEdges + n;
    const perScopeBudget = returnedIds + 2 * n + 1;
    // Reservation has six separate read phases, including rechecks after
    // pin/exposure writes; a single cache cannot safely span those writes.
    // Every bound is a fixed lifecycle-phase count, independent of fan-out.
    const phaseBudget: Record<Operation, number> = { reserve: 6, start: 2, heartbeat: 2, finish: 2, verify: 1, accept: 1 };
    const measurements = Object.fromEntries(operations.map(op => [op, {
      ...counts[op], scopes: [...counts[op].scopes.values()],
      phaseBudget: phaseBudget[op], edgeBudget: phaseBudget[op] * perScopeBudget,
    }]));
    t.diagnostic("Y14_DEPENDENCY_DENSITY " + JSON.stringify({ writers: n, dependencies, returnedIds, measurements }));

    // A fresh public read must observe the owner's subsequent revocation.
    // This exercises the memo's lifetime after successful verify and accept.
    const revoked = dependencies.at(-1)!;
    const reason = "DEPENDENCY_NOT_CURRENT_ACCEPTED:" + revoked;
    assert.ok(!f.c.reasons("FINAL").includes(reason));
    f.c.revoke("accept-" + revoked, "Owner withdrew a dependency after the prior lifecycle reads", f.c.localActor());
    assert.ok(f.c.reasons("FINAL").includes(reason), "currency cannot remain cached across owner revocation");

    for (const op of operations) await t.test(op + " bounds separate read phases and traverses every accepted dependency", () => {
      const count = counts[op];
      assert.ok(count.writes >= 1, op + " must perform its real lifecycle mutation");
      assert.equal(count.writesWithActiveCache, 0, op + " cannot retain a lineage read cache across a database write");
      assert.ok(count.constructions >= 1, op + " must begin a real lineage read scope");
      assert.ok(count.edgeVisits >= denseEdges, op + " must traverse the actual dense writer history");
      for (const id of dependencies) assert.ok((count.currencyTasks[id] ?? 0) >= 1,
        op + " must fully validate REVIEW-bound accepted dependency " + id);
      assert.ok(count.constructions <= phaseBudget[op],
        `${op} builds caches per dependency instead of per read phase: ${count.constructions} > ${phaseBudget[op]}`);
      assert.ok(count.edgeVisits <= phaseBudget[op] * perScopeBudget,
        `${op} repeats dense dependency history: ${count.edgeVisits} > ${phaseBudget[op] * perScopeBudget}`);
      assert.ok(count.currencyChecks <= phaseBudget[op] * (dependencies.length + 1),
        `${op} repeats accepted-task currency work: ${count.currencyChecks}`);
    });
  } finally { f.close(); }
});
