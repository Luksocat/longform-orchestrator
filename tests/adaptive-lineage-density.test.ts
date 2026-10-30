/** Y14: source construction from a persisted dense Drive discovery history. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonical, digest } from "../src/domain.js";
import { project, checkpoint, work, gateway, AT, type Attempt } from "./fixtures/adaptive/remediation-project.js";

test("Y14: real dense discovery sources retain every writer with a quadratic gateway-work bound", async (t) => {
  const f = project({ tasks: [{ id: "A", drive: true }] });
  try {
    await checkpoint(f);
    const made = await work(f);
    const c = f.c as any;
    const template: Attempt = c.attempt(made.attempt.id);
    const n = 200;
    const writers: Array<{ id: string; fileId: string }> = [];

    // Store historical runs, valid receipts, journal order and actual gateway
    // logs. No lineage source/edge cache is seeded: viewSources must discover
    // each of the n(n-1)/2 contributions from these persisted records.
    for (let i = 0; i < n; i++) {
      const id = randomUUID(), fileId = "DENSE" + String(i).padStart(15, "0");
      const workspace = join(f.root, "workspaces", id);
      gateway(join(workspace, "drive-changes", id), [
        { at: AT, op: "create", ok: true, fileId, versionAfter: "1" },
        { at: AT, completedAt: AT, op: "list", ok: true, returned: writers.map((writer) => writer.fileId) },
      ]);
      const attempt: Attempt = {
        ...template,
        id,
        workspace,
        projectContext: undefined,
        baseline: {},
        workspaceDigest: digest(c.snapshot(workspace)),
        requestKey: "density:" + id,
      };
      const receipt = { ...made.receipt, runId: id, sessionId: randomUUID(), output: "SIMULATION: dense writer " + i };
      f.db.transaction(() => {
        f.db.run(
          "INSERT INTO attempts(id,task_id,role,state,lease_owner,lease_until,body) VALUES(?,?,?,?,?,?,?)",
          id, attempt.taskId, attempt.role, attempt.state, attempt.leaseOwner, attempt.leaseUntil, canonical(attempt),
        );
        f.db.run("INSERT INTO receipts(id,attempt_id,body) VALUES(?,?,?)", randomUUID(), id, canonical(receipt));
        f.db.event("ATTEMPT_RESERVED", attempt.taskId, { id });
        f.db.event("PROCESS_START_INTENT", attempt.taskId, { runId: id });
        f.db.event("EXECUTION_RECEIPT", attempt.taskId, { runId: id });
      });
      writers.push({ id, fileId });
    }

    // Match the production reservation boundary: historical content is warmed
    // before BEGIN IMMEDIATE, then the new lineage walk starts with no sources.
    c.warmLineage();
    const returnedIds = n * (n - 1) / 2;
    const gatewayEntries = 2 * n;
    const gatewayBudget = 4 * (gatewayEntries + returnedIds + n);
    const gatewayRecord = c.gatewayRecord.bind(c);
    let gatewayCalls = 0;
    c.gatewayRecord = (attempt: Attempt) => {
      assert.equal(f.db.inWriteTransaction(), true, "the measured source construction runs under the reservation lock");
      gatewayCalls++;
      assert.ok(gatewayCalls <= gatewayBudget,
        `gateway lookup budget exceeded: ${gatewayCalls} calls for ${gatewayEntries} entries and ${returnedIds} returned IDs`);
      return gatewayRecord(attempt);
    };
    try {
      f.db.transaction(() => {
        const cache = c.lineageCache();
        assert.equal(cache.sources.size, 0, "source construction must not be replaced by prefilled graph edges");
        assert.equal(cache.driveWriters, undefined, "the writer index must be built during this measured walk");
        for (const { id } of writers) {
          assert.equal(cache.runs.get(id).receiptValid, true);
          assert.equal(cache.runs.get(id).identityVerified, true);
        }
        const reachable: Set<string> = c.lineageReachable([writers.at(-1)!.id], cache);
        assert.equal(reachable.has("UNKNOWN"), false);
        for (const { id } of writers) assert.ok(reachable.has(id), `missing contributor ${id}`);

        let discoveredEdges = 0;
        for (let i = 0; i < n; i++) {
          const sources = cache.sources.get(writers[i]!.id);
          assert.ok(sources, "the real walk must construct sources for every reachable writer");
          const discovered = sources.filter((source: any) => source.kind === "DRIVE_DISCOVERY");
          discoveredEdges += discovered.length;
          assert.equal(discovered.length, i, `writer ${i} must retain each earlier discovered author`);
          assert.deepEqual(
            discovered.map((source: any) => [source.producerRunId, source.provider, source.fields]),
            writers.slice(0, i).map((writer) => [writer.id, template.provider, [writer.fileId]]),
          );
        }
        assert.equal(discoveredEdges, returnedIds, "the work bound cannot pass by losing provenance edges");
      });
    } finally {
      c.gatewayRecord = gatewayRecord;
    }
    assert.ok(gatewayCalls >= n, "the counter must observe actual gateway source reads");
    assert.ok(gatewayCalls <= gatewayBudget);
    t.diagnostic(`${n} persisted writers; ${returnedIds} real discovery edges; ${gatewayCalls} gateway lookups (bound ${gatewayBudget})`);
  } finally {
    f.close();
  }
});
