/** N1 correction note: actual ambiguous gateway write, synthetic historical cutoffs. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DriveGateway } from "../src/drive.js";
import { MockProvider } from "../src/providers.js";
import { fakeDrive } from "./fake-drive.js";
import { project, checkpoint, gateway, put, note, type Attempt } from "./fixtures/adaptive/remediation-project.js";

test("N1 correction note: ambiguous applied writes cannot make restoration look like a Max correction", async () => {
  const f = project({ tasks: [{ id: "A", drive: true }, { id: "B", drive: true }] });
  const c = f.c as any, remote = fakeDrive(), fileId = "notesAAAAAAAAAAA";
  c.config.claimsSettlingMs = 0; // isolated synthetic test only
  const original = remote.files.get(fileId)!.body;
  const credentials = { clientFile: join(f.root, "client.json"), tokenFile: join(f.root, "token.json") };
  writeFileSync(credentials.clientFile, JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  writeFileSync(credentials.tokenFile, JSON.stringify({ refresh_token: "r" }));
  const at = (time: number) => new Date(time).toISOString();
  const synthetic = (id: string, ended: number) => ({ id, taskId: "A", state: "SUCCEEDED",
    workspace: mkdtempSync(join(f.root, id + "-")), finishedAt: at(ended) }) as Attempt;
  const fix = (text: string, when: number) => {
    const a = synthetic("fix-" + randomUUID(), when + 10);
    gateway(join(a.workspace, "drive-changes", a.id), [{ at: at(when), writeStartedAt: at(when),
      writeAcknowledgedAt: at(when + 1), completedAt: at(when + 2), op: "update", ok: true,
      fileId, versionBefore: "4", versionAfter: "5" }]);
    put(a, `drive-changes/${a.id}/before/${fileId}@v4-1.md`, "intermediate");
    put(a, `drive-changes/${a.id}/after/${fileId}@v5-2.md`, text);
    return a;
  };
  try {
    const faulted = synthetic("faulted", Date.now() - 3_600_000);
    await checkpoint(f, undefined, "B");
    const writer = f.c.reserve("B", { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const provider = new MockProvider({ output: "SIMULATION: the remote write returned an ambiguous error" });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      // Simulation admission supplies no Drive claims. Only custody is seeded;
      // begin/end intents, send, staging, response loss and reconciliation are real.
      f.db.transaction(() => c.insertClaims({ kind: "run", id: writer.id }, "B", writer.specDigest,
        ["drive:file:" + fileId], "RUN"));
      const g = new DriveGateway({ credentials, policy: { read: "ANY", update: [fileId], createIn: [] },
        workspace: writer.workspace, auditDir: join(f.root, "drive-audit", writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: "run", id: writer.id }),
        fetcher: (async (raw: string, init: RequestInit) => {
          const response = await remote.fetcher(raw, init);
          return new URL(raw).pathname.startsWith("/upload") && init.method === "PATCH"
            ? new Response("lost response after mutation", { status: 500 }) : response;
        }) as any });
      try {
        await g.operate("read", [fileId]);
        put(writer, "output/B/change.md", "intermediate");
        await assert.rejects(g.operate("update", [fileId, join(writer.workspace, "output/B/change.md")]), /DRIVE_WRITE_AMBIGUOUS/);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, "SUCCEEDED");
    assert.equal(remote.files.get(fileId)!.body, "intermediate");
    const currentWriter = c.attempt(writer.id);
    const entry = c.gatewayRecord(currentWriter).entries.find((e: any) => e.op === "update");
    assert.equal(entry.ok, false);
    assert.equal(entry.written, undefined);
    const intent = f.c.unresolvedClaims().find(claim => claim.kind === "INTENT" && claim.holderId === writer.id)!;
    const restoration = fix(original, Date.now() + 10_000), correction = fix("corrected", Date.now() + 20_000);
    const unresolved = c.driveWriteChanged(correction, fileId, faulted);
    // Keep the evidence bound strictly after the operation's stop, so the
    // overlap control can distinguish an error completion from settled effects.
    await new Promise(resolve => setTimeout(resolve, 5));
    const settled = new Date().toISOString(), evidenceId = "settled-" + writer.id;
    f.c.addEvidence({ ...note(evidenceId, "B", writer.id), retrievedAt: settled,
      metadata: { intentId: intent.id, claimsReconciliation: {
        operationStopped: true, effectsSettled: true, effects: "APPLIED",
        remoteChecked: [{ what: "Inspect the mutated in-memory remote file after stop", at: settled }],
        assessment: "The actual remote update is applied and settled",
      } } }, f.c.localActor());
    f.c.reconcileClaims({ intent: intent.id }, evidenceId, f.c.localActor());
    assert.equal(c.driveWriteChanged(restoration, fileId, faulted), false,
      "an intervening ambiguous APPLIED write cannot turn restoration of the faulted bytes into a correction");
    assert.equal(c.driveWriteChanged(correction, fileId, faulted), true,
      "retained pre-image and settled ordering still establish an actual content change");
    assert.equal(unresolved, false, "an unresolved remote effect has no trustworthy completion bound");
    const overlap = { ...faulted, finishedAt: at(Date.parse(currentWriter.finishedAt) + 1) };
    assert.ok(Date.parse(overlap.finishedAt) < Date.parse(settled));
    assert.equal(c.driveWriteChanged(correction, fileId, overlap), false,
      "an earlier transport error and run finish cannot bound effects settled after the faulted boundary");

    // A durable intent without its dispatch entry must still prevent choosing
    // the later fix's pre-image. This is a controller-level crash-record fixture.
    const log = join(currentWriter.workspace, "drive-changes", writer.id, "log.jsonl");
    writeFileSync(log, "");
    c.gatewayCache.clear();
    assert.equal(c.driveWriteChanged(correction, fileId, faulted), false,
      "a missing dispatch entry leaves the first possible write's pre-image unproved");

    // Resolved effects provably before a later boundary are immaterial, even
    // when their old log cannot be opened; retain M3's availability behavior.
    writeFileSync(log, "broken-json");
    c.gatewayCache.clear();
    const laterBoundary = Date.parse(settled) + 30_000;
    assert.equal(c.driveWriteChanged(fix("corrected", laterBoundary + 1000), fileId,
      { ...faulted, finishedAt: at(laterBoundary) }), true);
  } finally { f.close(); }
});
