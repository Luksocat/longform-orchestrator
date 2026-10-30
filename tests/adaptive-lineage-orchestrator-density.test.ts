/** Y14 R11: public orchestrator transactions share each synchronous lineage read. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical, digest } from "../src/domain.js";
import {
  project, checkpoint, workWith, review, acceptTask, gateway, runs, EVIDENCE, AT, type Project,
} from "./fixtures/adaptive/remediation-project.js";

type Shape = "flat" | "chained";
type Operation = "worker" | "overseer" | "VERIFY" | "owner-pause" | "preview-batch" | "preview-revised";
type Event = { kind: string; taskId?: string; role?: string; stage?: string; outcome?: string };
type Scope = { calls: number; edges: number; origin: string };
type Frame = {
  action: string;
  boundary: "transaction" | "rollbackOnly";
  constructions: number;
  edgeVisits: number;
  currencyChecks: number;
  currencyTasks: Record<string, number>;
  currencyResults: Record<string, { current: number; notCurrent: number; failed: number }>;
  writes: number;
  writesWithActiveCache: number;
  activeCacheAtEnd: boolean;
  overseerBriefs: number;
  events: Event[];
  scopes: Scope[];
  scopeLookup: WeakMap<object, Scope>;
};

/** Observe the actual outer lock, including reads before the event identifying it. */
function observe(f: Project) {
  const c = f.c as any;
  const cache = c.lineageCache.bind(c), sources = c.lineageSources.bind(c);
  const currency = c.acceptanceCurrentInScope.bind(c), brief = c.briefParts.bind(c);
  const transaction = f.db.transaction.bind(f.db), rollbackOnly = f.db.rollbackOnly.bind(f.db);
  const run = f.db.run.bind(f.db);
  const frames: Frame[] = [];
  let action = "setup", current: Frame | undefined;
  function boundary<T>(kind: Frame["boundary"], original: (fn: () => T) => T, fn: () => T): T {
    if (f.db.inWriteTransaction()) return original(fn);
    return original(() => {
      assert.equal(current, undefined, "outer write transactions cannot overlap");
      const frame: Frame = {
        action, boundary: kind, constructions: 0, edgeVisits: 0, currencyChecks: 0,
        currencyTasks: {}, currencyResults: {}, writes: 0, writesWithActiveCache: 0, activeCacheAtEnd: false,
        overseerBriefs: 0, events: [], scopes: [], scopeLookup: new WeakMap(),
      };
      current = frame;
      try { return fn(); }
      finally {
        frame.activeCacheAtEnd = !!c.activeLineageCache;
        current = undefined;
        frames.push(frame);
      }
    });
  }
  f.db.transaction = <T>(fn: () => T): T => boundary("transaction", transaction, fn);
  f.db.rollbackOnly = <T>(fn: () => T): T => boundary("rollbackOnly", rollbackOnly, fn);
  c.lineageCache = () => {
    const active = c.activeLineageCache, value = cache();
    if (current && f.db.inWriteTransaction() && !active) {
      current.constructions++;
      const origin = new Error().stack!.split("\n").slice(1)
        .map(line => line.trim().match(/^at ([^ (]+)/)?.[1] ?? "unknown")
        .filter(name => !name.endsWith("lineageCache") && !name.endsWith("withLineageWalk") && !name.endsWith("withLineageRead"))
        .slice(0, 3).join(" -> ");
      const scope = { calls: 0, edges: 0, origin };
      // Retain only counters. Strong cache keys would keep every historical
      // attempt/receipt map alive and manufacture baseline memory pressure.
      current.scopeLookup.set(value, scope);
      current.scopes.push(scope);
    }
    return value;
  };
  c.acceptanceCurrentInScope = (...args: any[]) => {
    const frame = current && f.db.inWriteTransaction() ? current : undefined;
    if (frame) {
      frame.currencyChecks++;
      const id = args[0].id;
      frame.currencyTasks[id] = (frame.currencyTasks[id] ?? 0) + 1;
    }
    try {
      const result = currency(...args);
      if (frame) {
        const counts = frame.currencyResults[args[0].id] ??= { current: 0, notCurrent: 0, failed: 0 };
        counts[result ? "current" : "notCurrent"]++;
      }
      return result;
    } catch (error) {
      if (frame) (frame.currencyResults[args[0].id] ??= { current: 0, notCurrent: 0, failed: 0 }).failed++;
      throw error;
    }
  };
  c.lineageSources = (id: string, active: object) => {
    const value = sources(id, active), frame = current;
    if (!frame || !f.db.inWriteTransaction()) return value;
    let scope = frame.scopeLookup.get(active);
    if (!scope) {
      scope = { calls: 0, edges: 0, origin: "constructed before this transaction" };
      frame.scopeLookup.set(active, scope);
      frame.scopes.push(scope);
    }
    scope.calls++;
    const countedScope = scope;
    return new Proxy(value, { get(target, property, receiver) {
      if (property === Symbol.iterator) return function* () {
        for (const source of target) { countedScope.edges++; frame.edgeVisits++; yield source; }
      };
      return Reflect.get(target, property, receiver);
    } });
  };
  c.briefParts = (...args: any[]) => {
    if (current && f.db.inWriteTransaction() && args[1]?.role === "overseer") current.overseerBriefs++;
    return brief(...args);
  };
  f.db.run = (sql, ...args) => {
    if (current && /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
      current.writes++;
      if (c.activeLineageCache) current.writesWithActiveCache++;
      if (/INSERT INTO events\b/i.test(sql)) {
        const body = JSON.parse(String(args[3]));
        current.events.push({
          kind: String(args[1]), taskId: body.taskId ?? body.step?.taskId ?? args[2] ?? undefined,
          ...(body.role ? { role: body.role } : {}),
          ...(body.step ? { stage: body.step.stage, outcome: body.step.outcome } : {}),
        });
      }
    }
    return run(sql, ...args);
  };
  return {
    frames,
    setAction(value: string) { action = value; },
    restore() {
      c.lineageCache = cache; c.lineageSources = sources;
      c.acceptanceCurrentInScope = currency; c.briefParts = brief;
      f.db.transaction = transaction; f.db.rollbackOnly = rollbackOnly; f.db.run = run;
    },
  };
}

function dependOn(f: Project, taskId: string, dependencies: string[]) {
  const before = f.c.task(taskId);
  f.c.revise(taskId, { ...before, specVersion: before.specVersion + 1, dependencies }, f.c.localActor());
  f.o.rebind(f.id, [taskId]);
  f.c.grant(taskId, {
    id: randomUUID(), operations: ["READ_LOCAL", "WRITE_LOCAL"], paths: before.writePaths,
    decisionText: "Simulation work with the named accepted dependencies", sourceRef: "test:owner",
  }, f.c.localActor());
}

function durableCounts(f: Project) {
  return Object.fromEntries(f.db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .map(({ name }) => [name, digest(f.db.all('SELECT * FROM "' + name.replaceAll('"', '""') + '"').map(row => canonical(row)).sort())]));
}

async function scenario(shape: Shape, additional: number) {
  const n = 8, ids = Array.from({ length: n }, (_, i) => "D" + i);
  const dependencies = ids.filter((_, i) => i % 2 === 1);
  const extras = Array.from({ length: additional }, (_, i) => "EXTRA" + i);
  const f = project({
    tasks: [...ids.map(id => ({ id, drive: true, reviewAcceptance: true })),
      { id: "FINAL", drive: true }, ...extras.map(id => ({ id }))],
    evidence: { ...EVIDENCE, overseers: { ...EVIDENCE.overseers, PROGRAMME: [["astra-max-overseer", "strong"]] } },
  });
  let observer: ReturnType<typeof observe> | undefined;
  const earlierFrames: Frame[] = [];
  const previewOutcomes: Partial<Record<Operation, { error?: string; roles?: number; expectedTaskHolds?: boolean }>> = {};
  function coldObserver() {
    earlierFrames.push(...observer!.frames);
    observer!.restore();
    f.restart();
    observer = observe(f);
  }
  try {
    if (shape === "chained")
      for (let i = 1; i < dependencies.length; i++) dependOn(f, dependencies[i]!, [dependencies[i - 1]!]);
    for (const id of ["FINAL", ...extras]) dependOn(f, id, dependencies);
    const writers: Array<{ id: string; fileId: string }> = [];
    for (let i = 0; i < n; i++) {
      const taskId = ids[i]!;
      await checkpoint(f, undefined, taskId);
      const fileId = "ORCHESTRATORDENSE" + String(i).padStart(10, "0");
      const made = await workWith(f, taskId, a => gateway(join(a.workspace, "drive-changes", a.id), [
        { at: AT, op: "create", ok: true, fileId, versionAfter: "1" },
        { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map(w => w.fileId) },
      ]));
      assert.equal(made.receipt.status, "SUCCEEDED", canonical(made.receipt));
      if (dependencies.includes(taskId)) {
        const judged = await review(f, "PASS", taskId);
        f.c.bindAcceptance(taskId, "receipt", "output-" + made.attempt.id, f.c.localActor());
        f.c.bindAcceptance(taskId, "review", "review-workflow-review-" + judged.id, f.c.localActor());
        acceptTask(f, taskId, judged.id);
        assert.equal(f.c.task(taskId).status, "ACCEPTED");
      }
      writers.push({ id: made.attempt.id, fileId });
    }
    // Public drive advances only FINAL, while every writer and extra dependent
    // remains in the real request/project views and in overseer briefs.
    const heldIds = [...ids, ...extras];
    const question = f.o.ask(f.id, {
      key: "hold-other-work", text: "Keep these tasks unchanged while FINAL runs?",
      kind: "INFORMATION", taskIds: heldIds,
    });
    const initial = f.o.inspect(f.id);
    assert.ok(initial.questions.some(q => q.id === question.id && q.status === "OPEN"));
    assert.ok(!initial.tasks.find(t => t.taskId === "FINAL")!.holds.some(h => h.startsWith("DEPENDENCY_NOT_CURRENT_ACCEPTED:")));
    for (const id of dependencies) assert.equal(initial.tasks.find(t => t.taskId === id)!.acceptanceCurrent, true);

    observer = observe(f);
    observer.setAction("drive");
    const driven = await f.o.drive(f.id, { mock: true });
    assert.equal(f.c.task("FINAL").status, "VERIFIED", canonical(driven));
    assert.equal(runs(f, "worker", "FINAL").length, 1);
    assert.equal(runs(f, "worker", "FINAL")[0]!.state, "SUCCEEDED");
    assert.ok(runs(f, "overseer", "FINAL").some(a => a.state === "SUCCEEDED"));
    for (const id of ids) assert.equal(runs(f, "worker", id).length, 1, "scoped owner question must keep prior work unchanged");
    for (const id of extras) assert.equal(runs(f, "worker", id).length, 0, "scoped extra tasks must not start");
    assert.ok(driven.questions.some(q => q.id === question.id && q.status === "OPEN"));

    // Each preview is a genuinely cold public entry: no manual warmLineage,
    // preceding inspect, or retained controller memo prepares its bytes.
    coldObserver();
    observer!.setAction("preview-batch");
    const beforePreview = durableCounts(f);
    try {
      const previews = f.o.previewBatch(f.id, { taskIds: ["FINAL", ...extras] });
      assert.equal(previews.length, 1 + additional);
      assert.ok(previews.every(p => p.recorded === false));
      assert.ok(previews.every(p => ["worker", "reviewer", "overseer"].every(role => p.roles.some(r => r.role === role))));
      assert.ok(previews.every(p => p.roles.every(r => !r.error?.includes("NOT_PREWARMED"))));
      previewOutcomes["preview-batch"] = { roles: previews.reduce((sum, p) => sum + p.roles.length, 0), expectedTaskHolds: true };
    } catch (error) { previewOutcomes["preview-batch"] = { error: String(error) }; }
    assert.deepEqual(durableCounts(f), beforePreview, "hypothetical grants, journal entries and attempts must roll back");

    coldObserver();
    observer!.setAction("preview-revised");
    const beforeRevisionPreview = durableCounts(f);
    try {
      const previews = f.o.previewBatch(f.id, { revise: ["FINAL", ...extras].map(id => {
        const task = f.c.task(id);
        return { ...task, specVersion: task.specVersion + 1, title: task.title + " preview revision" };
      }) });
      assert.equal(previews.length, 1 + additional);
      assert.ok(previews.every(p => p.recorded === false && p.action === "revise"));
      assert.equal(previews.find(p => p.taskId === "FINAL")!.rebindHeld, undefined);
      for (const id of extras)
        assert.ok(previews.find(p => p.taskId === id)!.rebindHeld?.includes("REBIND_HAS_OPEN_QUESTIONS:" + id),
          "a hypothetical revision must retain that task's actual open-question hold");
      assert.ok(previews.every(p => p.roles.every(r => !r.error?.includes("NOT_PREWARMED"))));
      previewOutcomes["preview-revised"] = { roles: previews.reduce((sum, p) => sum + p.roles.length, 0), expectedTaskHolds: true };
    } catch (error) { previewOutcomes["preview-revised"] = { error: String(error) }; }
    assert.deepEqual(durableCounts(f), beforeRevisionPreview, "all hypothetical revision, binding, grant and journal changes must roll back");

    observer!.setAction("owner-pause");
    const paused = f.o.pauseRequest(f.id, { text: "Pause the density fixture", sourceRef: "test:owner" });
    assert.equal(paused.status, "PAUSED");
    const finalHolds = driven.tasks.find(t => t.taskId === "FINAL")!.holds;
    assert.deepEqual(paused.tasks.find(t => t.taskId === "FINAL")!.holds, finalHolds, "a request pause preserves task holds");
    for (const id of dependencies) assert.equal(paused.tasks.find(t => t.taskId === id)!.acceptanceCurrent, true);

    // A committed revocation between two owner commands must invalidate the
    // previous read's currency memo, including the chained accepted history.
    observer!.setAction("revoke");
    const revoked = dependencies.at(-1)!;
    f.c.revoke("accept-" + revoked, "Withdraw the accepted dependency after the measured reads", f.c.localActor());
    observer!.setAction("owner-resume-after-revoke");
    const resumed = f.o.pauseRequest(f.id, { text: "Resume after dependency withdrawal", sourceRef: "test:owner" }, true);
    assert.equal(f.o.requestPause(f.id), undefined);
    assert.equal(resumed.tasks.find(t => t.taskId === revoked)!.acceptanceCurrent, false);
    for (const id of ["FINAL", ...extras])
      assert.ok(resumed.tasks.find(t => t.taskId === id)!.holds.includes("DEPENDENCY_NOT_CURRENT_ACCEPTED:" + revoked));
    assert.ok(resumed.questions.some(q => q.id === question.id && q.status === "OPEN"));

    const allFrames = [...earlierFrames, ...observer!.frames];
    const classified: Record<Operation, Frame[]> = {
      worker: allFrames.filter(f => f.action === "drive" && f.events.some(e => e.kind === "WORKFLOW_RUN_LINKED" && e.role === "worker" && e.taskId === "FINAL")),
      overseer: allFrames.filter(f => f.action === "drive" && f.events.some(e => e.kind === "WORKFLOW_RUN_LINKED" && e.role === "overseer" && e.taskId === "FINAL")),
      VERIFY: allFrames.filter(f => f.action === "drive" && f.events.some(e => e.kind === "WORKFLOW_STEP" && e.stage === "VERIFY" && e.outcome === "RECORDED" && e.taskId === "FINAL")),
      "owner-pause": allFrames.filter(f => f.action === "owner-pause" && f.events.some(e => e.kind === "WORKFLOW_REQUEST_PAUSED")),
      "preview-batch": allFrames.filter(f => f.action === "preview-batch" && f.boundary === "rollbackOnly"),
      "preview-revised": allFrames.filter(f => f.action === "preview-revised" && f.boundary === "rollbackOnly"),
    };
    for (const frame of allFrames) {
      assert.equal(frame.writesWithActiveCache, 0, "no public operation may keep the lineage cache across a write");
      assert.equal(frame.activeCacheAtEnd, false, "no public operation may leak the lineage cache past its read phase");
    }
    return { shape, writers: n, additionalBoundDependents: additional, boundTasks: n + additional + 1,
      dependencies, denseEdges: n * (n - 1) / 2, perScopeBudget: n * (n - 1) / 2 + 3 * n + 1,
      measurements: Object.fromEntries(Object.entries(classified).map(([op, frames]) => [op, frames.map(frame => {
        const { scopeLookup: _lookup, ...counts } = frame;
        return counts;
      })])) as Record<Operation, Array<Omit<Frame, "scopeLookup">>>,
      totalObservedWrites: allFrames.reduce((sum, f) => sum + f.writes, 0),
      totalWritesWithActiveCache: allFrames.reduce((sum, f) => sum + f.writesWithActiveCache, 0),
      previewOutcomes, previewRolledBack: true, revocationObservedByNextOwnerCommand: true,
    };
  } finally { observer?.restore(); f.close(); }
}

// Ceilings count synchronous read phases separated by writes, never project
// tasks or dependencies. Owner views and the final preview map are one read;
// reservations retain their separate post-pin, exposure and admission phases.
const phaseBudget: Record<Operation, number> = { worker: 6, overseer: 4, VERIFY: 1, "owner-pause": 1, "preview-batch": 1, "preview-revised": 1 };
for (const shape of ["flat", "chained"] as const) test("Y14: public orchestrator shares dense " + shape + " accepted history as bound tasks grow", async t => {
  const cases = [await scenario(shape, 0), await scenario(shape, 4)];
  for (const measured of cases) t.diagnostic("Y14_ORCHESTRATOR_DENSITY " + JSON.stringify(measured));
  for (const operation of Object.keys(phaseBudget) as Operation[]) await t.test(operation + " keeps a fixed lineage bound per write transaction", () => {
    for (const measured of cases) {
      assert.equal(measured.previewOutcomes[operation]?.error, undefined, operation + " must work as a cold public entry point");
      assert.ok(measured.measurements[operation].length >= 1, operation + " must occur through its real public entry point");
      for (const frame of measured.measurements[operation]) {
      assert.ok(frame.writes > 0, operation + " must perform real committed or rolled-back writes");
      assert.ok(frame.constructions >= 1, operation + " must perform a real locked lineage read");
      assert.ok(frame.edgeVisits >= measured.denseEdges, operation + " must traverse the real dense writer history");
      for (const id of measured.dependencies) assert.ok((frame.currencyTasks[id] ?? 0) >= 1,
        operation + " must fully validate REVIEW-bound accepted dependency " + id);
      if (operation === "overseer") assert.ok(frame.overseerBriefs > 0, "the real overseer reservation must build its brief under the lock");
      if (operation === "preview-batch" || operation === "preview-revised")
        for (const id of measured.dependencies) assert.ok((frame.currencyResults[id]?.current ?? 0) >= 1,
          operation + " must positively authenticate still-current accepted dependency " + id + " after a cold restart");
      assert.ok(frame.constructions <= phaseBudget[operation],
        `${operation}, ${measured.boundTasks} bound tasks: ${frame.constructions} caches exceed ${phaseBudget[operation]} read phases`);
      assert.ok(frame.edgeVisits <= phaseBudget[operation] * measured.perScopeBudget,
        `${operation}, ${measured.boundTasks} bound tasks: ${frame.edgeVisits} edge visits exceed the phase bound`);
      for (const id of measured.dependencies) assert.ok(frame.currencyTasks[id]! <= phaseBudget[operation],
        `${operation} repeatedly checks accepted ${id} per bound task: ${frame.currencyTasks[id]}`);
      }
    }
    const maxima = cases.map(measured => ({
      caches: Math.max(...measured.measurements[operation].map(f => f.constructions)),
      edges: Math.max(...measured.measurements[operation].map(f => f.edgeVisits)),
      acceptedCurrency: Math.max(...measured.measurements[operation].map(f =>
        measured.dependencies.reduce((sum, id) => sum + (f.currencyTasks[id] ?? 0), 0))),
    }));
    assert.ok(maxima[1]!.caches <= maxima[0]!.caches, operation + " must not add read phases for additional bound dependents");
    assert.ok(maxima[1]!.edges <= maxima[0]!.edges, operation + " must not re-walk dense history for additional bound dependents");
    assert.ok(maxima[1]!.acceptedCurrency <= maxima[0]!.acceptedCurrency, operation + " must not repeat full accepted-dependency validation for additional bound dependents");
  });
});
