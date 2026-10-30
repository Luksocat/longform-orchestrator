/** Regression cases for PR29 lineage findings Y1–Y14. Isolated scripted runs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonical, demoTask, digest, specDigest } from '../src/domain.js';
import { MockProvider } from '../src/providers.js';
import { defaultRoutingPolicy } from '../src/routing.js';
import { DriveGateway } from '../src/drive.js';
import { fakeDrive } from './fake-drive.js';
import { project, checkpoint, work, workWith, review, put, gateway, note, bind, acceptTask, EVIDENCE, ADVISED_EVIDENCE, BUDGET, AT, type Evidence } from './fixtures/adaptive/remediation-project.js';

const CLAUDE_SOURCE: Evidence = {
  ...EVIDENCE,
  pairs: { ...EVIDENCE.pairs, 'general/expert': [['opus-expert-xhigh-worker', 'sol-expert-max-reviewer', 'strong']] },
};
const has = (sources: any[], runId: string, kind?: string) => sources.some(s => s.producerRunId === runId && (!kind || s.kind === kind));
function filing(f: ReturnType<typeof project>, id: string, entries: unknown[], results: unknown[], task = 'A') {
  const auditDir = join(f.root, 'drive-audit', id);
  gateway(auditDir, entries);
  f.c.recordFiling(task, { id, auditDir, complete: true, results }, f.c.localActor());
}

test('Y1: historical two-tier guidance remains a source after the policy is adaptive', async () => {
  const f = project();
  try {
    await checkpoint(f);
    const made = await work(f);
    const c = f.c as any, cache = c.lineageCache();
    const original = cache.runs.get(made.attempt.id);
    const legacy = { ...original.a, id: 'historical-worker', routing: { ...original.a.routing, adaptive: undefined } };
    cache.runs.set(legacy.id, { ...original, a: legacy });
    cache.runs.set('historical-overseer', { ...original, a: { ...original.a, id: 'historical-overseer', role: 'overseer', provider: 'claude' } });
    legacy.projectContext = { ...original.a.projectContext, previous: { ...original.a.projectContext.previous, runId: 'historical-overseer', summary: 'Actual old substantive guidance' } };
    const sources = c.viewSources(f.c.task('A'), { ...legacy, rowid: Infinity, reservedAt: Infinity, briefAt: Infinity }, cache);
    assert.ok(has(sources, 'historical-overseer', 'CHECKPOINT_PLAN'));
    // The same unpinned legacy checkpoint is hidden for a genuinely new adaptive run.
    assert.ok(!has(c.viewSources(f.c.task('A'), { ...legacy, id: 'prospective-run', rowid: Infinity, reservedAt: Infinity, briefAt: Infinity }, cache), 'historical-overseer'));
  } finally { f.close(); }
});

test('Y2/T3: a seeded single-provider artifact selects the eligible opposite pair before reservation', async () => {
  const f = project({ repo: true, evidence: CLAUDE_SOURCE, tasks: [{ id: 'A' }, { id: 'C', expert: true }] });
  try {
    await checkpoint(f, undefined, 'C');
    const source = await work(f, 'A Claude-origin seed that must retain its author', 'C');
    assert.equal(source.attempt.provider, 'claude');
    const commit = f.commit({ 'seed.txt': source.receipt.output });
    const prior = f.c.task('A');
    f.c.revise('A', { ...prior, specVersion: 2, repo: { name: 'seed', commit } }, f.c.localActor());
    f.o.rebind(f.id, ['A']);
    f.c.grant('A', { id: randomUUID(), operations: ['READ_LOCAL', 'WRITE_LOCAL'], paths: prior.writePaths, decisionText: 'Use pinned seed', sourceRef: 'test:owner' }, f.c.localActor());
    await checkpoint(f);
    assert.equal(f.c.admissionRefusal('A', { projectRequestId: f.id }), undefined);
    const card = f.c.adaptiveScorecard('A');
    assert.equal(card.heldBecause, null);
    assert.equal(card.worker?.provider, 'claude');
    const reserved = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(reserved.provider, 'claude');
    assert.equal((f.c as any).latestPin(f.c.task('A')).reviewer.provider, 'codex');
  } finally { f.close(); }
});

test('Y3: an advisor viewing a fix-task review retains that review as a transitive source', async () => {
  const f = project({ tasks: [{ id: 'A' }, { id: 'B' }] });
  try {
    await checkpoint(f); await work(f); const judged = await review(f, 'FAIL');
    const c = f.c as any, t = { ...f.c.task('B'), fixes: 'A' };
    const sources = c.viewSources(t, { role: 'advisor', specDigest: specDigest(t), rowid: Infinity, reservedAt: Infinity, briefAt: Infinity }, c.lineageCache());
    assert.ok(has(sources, judged.id, 'REVIEW_LOOP'));
  } finally { f.close(); }
});

test('Y3: later replacement reviews cannot rewrite an advisor input, and old records replay from start order or hold unknown', async () => {
  const f = project({ tasks: [{ id: 'A' }, { id: 'B', advice: true }], evidence: ADVISED_EVIDENCE });
  try {
    await checkpoint(f); await work(f); const first = await review(f, 'FAIL');
    const old = f.c.task('B');
    f.c.revise('B', { ...old, specVersion: old.specVersion + 1, fixes: 'A', writePaths: ['output/A'] }, f.c.localActor());
    f.o.rebind(f.id, ['B']);
    f.c.grant('B', { id: randomUUID(), operations: ['READ_LOCAL', 'WRITE_LOCAL'], paths: ['output/A'], decisionText: 'Fix the original scope', sourceRef: 'test:owner' }, f.c.localActor());
    await checkpoint(f, undefined, 'B');
    const advisor = f.c.reserve('B', { role: 'advisor', requestKey: 'fix-advice', projectRequestId: f.id }, f.c.localActor());
    assert.equal(advisor.fixesReview, first.id);
    await f.c.execute(advisor, new MockProvider({ output: 'Advice about the first review' }), f.c.localActor());
    await checkpoint(f); await work(f); const later = await review(f, 'FAIL');
    const c = f.c as any, cache = c.lineageCache();
    const current = c.lineageSources(advisor.id, cache);
    assert.ok(has(current, first.id, 'REVIEW_LOOP'));
    assert.ok(!has(current, later.id, 'REVIEW_LOOP'));
    const original = cache.runs.get(advisor.id), legacy = 'legacy-unbound-advisor';
    cache.runs.set(legacy, { ...original, a: { ...original.a, id: legacy, fixesReview: undefined } });
    const order = c.lineageOrder(cache);
    order.reserved.set(legacy, order.reserved.get(advisor.id));
    order.started.set(legacy, order.started.get(advisor.id));
    const replayed = c.lineageSources(legacy, cache);
    assert.ok(has(replayed, first.id, 'REVIEW_LOOP'));
    assert.ok(!has(replayed, later.id, 'REVIEW_LOOP'));
    cache.sources.delete(legacy); order.started.delete(legacy);
    assert.ok(has(c.lineageSources(legacy, cache), 'UNKNOWN', 'REVIEW_LOOP'));
  } finally { f.close(); }
});

test('Y2/T3: a resumable legacy worker informs adaptive admission and pair selection before the copy', async () => {
  const f = project();
  try {
    const adaptivePolicy = (f.c as any).config.routingPolicy;
    const legacyPolicy = defaultRoutingPolicy();
    f.restart(legacyPolicy);
    const route = legacyPolicy.routes.find(r => r.provider === 'claude' && r.level === 'COMPLEX')!;
    const interrupted = f.c.reserve('A', { requestKey: 'legacy-interruption', provider: 'claude', model: route.model, effort: route.effort }, f.c.localActor());
    put(interrupted, 'output/A/partial.md', 'Claude partial work before interruption');
    const limit = { kind: 'USAGE_LIMIT' as const, evidence: 'test:limit', resetsAt: new Date(Date.now() + 60_000).toISOString(), resetBasis: 'STRUCTURED' as const, message: 'Usage limit' };
    const provider = new MockProvider({ outcome: 'failure', limit });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => ({ ...await execute(request), identityVerified: true });
    await f.c.execute(interrupted, provider, f.c.localActor());
    assert.equal((f.c as any).attempt(interrupted.id).interruption.snapshot.resumable, true);
    f.c.clearProviderPause('claude', { reason: 'Synthetic limit cleared', evidence: ['test:reset'], sourceRef: 'test:owner' }, f.c.localActor());
    f.restart(adaptivePolicy);
    await checkpoint(f);
    assert.equal(f.c.admissionRefusal('A', { projectRequestId: f.id }), undefined);
    assert.equal(f.c.adaptiveScorecard('A').worker?.provider, 'claude');
    const controller = f.c as any, snapshot = controller.snapshot.bind(controller);
    let historicalHashesUnderLock = 0;
    controller.snapshot = (path: string) => {
      if (path === interrupted.workspace && f.db.inWriteTransaction()) historicalHashesUnderLock++;
      return snapshot(path);
    };
    const resumed = f.c.reserve('A', { requestKey: 'adaptive-resume', projectRequestId: f.id }, f.c.localActor());
    assert.equal(resumed.provider, 'claude');
    assert.equal(resumed.resumes, interrupted.id);
    assert.equal(readFileSync(join(resumed.workspace, 'output/A/partial.md'), 'utf8'), 'Claude partial work before interruption');
    assert.equal(historicalHashesUnderLock, 0, 'a resumed historical source was already warmed before the lock');
  } finally { f.close(); }
});

test('Y4/Y5: refused staging is not output; a failed run stored response remains content-addressed', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B' }] });
  try {
    await checkpoint(f);
    const failed = await workWith(f, 'A', a => {
      gateway(join(a.workspace, 'drive-changes', a.id), [{ at: AT, op: 'update', ok: false, fileId: 'STAGE0123456789', versionBefore: '1', sha256: digest('owner bytes'), record: 'uploaded/STAGE0123456789@v1-1.txt', error: 'AUTHORIZATION_REFUSED' }]);
      put(a, `drive-changes/${a.id}/uploaded/STAGE0123456789@v1-1.txt`, 'owner bytes');
    }, new MockProvider({ outcome: 'failure', output: 'Failed but still generated this unique text' }));
    const c = f.c as any, outputs = c.lineageOutputs(c.lineageCache());
    assert.ok(!(outputs.get(digest('owner bytes')) ?? []).includes(failed.attempt.id));
    assert.ok((outputs.get(digest(failed.receipt.output)) ?? []).includes(failed.attempt.id));
    f.c.addEvidence({ ...note('copied-failed-output', 'B', 'outside-system', failed.receipt.output), metadata: {} }, f.c.localActor());
    const authorship = c.adaptiveAuthorship(f.c.task('B'), {});
    assert.ok(authorship.runs.includes(failed.attempt.id));
  } finally { f.close(); }
});

for (const scenario of [
  { operation: 'update', effects: 'APPLIED' },
  { operation: 'update', effects: 'NOT_APPLIED' },
  { operation: 'create', effects: 'APPLIED' },
] as const) test(`N1: ambiguous ${scenario.operation} reconciled ${scenario.effects} retains exactly its possible authorship`, async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B', drive: true, expert: true }], evidence: CLAUDE_SOURCE });
  const remote = fakeDrive(), c = f.c as any;
  // Only this isolated synthetic fixture uses a zero settling window.
  c.config.claimsSettlingMs = 0;
  const credentials = { clientFile: join(f.root, 'client.json'), tokenFile: join(f.root, 'token.json') };
  writeFileSync(credentials.clientFile, JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  writeFileSync(credentials.tokenFile, JSON.stringify({ refresh_token: 'r' }));
  const payload = 'Distinct Claude-authored bytes sent by an ambiguous ' + scenario.operation;
  const originalFileId = 'notesAAAAAAAAAAA', folderId = 'folderAAAAAAAAAA';
  let fileId = originalFileId, sends = 0;
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(writer.provider, 'claude');
    const provider = new MockProvider({ output: 'SIMULATION: ambiguous send reported without copying its bytes' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      // Simulation admission has no Drive claims. Seed its custody only;
      // begin/end, gateway records, remote effects and reconciliation are real.
      f.db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        [scenario.operation === 'update' ? 'drive:file:' + fileId : 'drive:folder:' + folderId], 'RUN'));
      const g = new DriveGateway({
        credentials, policy: { read: 'ANY', update: [fileId], createIn: [folderId] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }),
        fetcher: (async (raw: string, init: RequestInit) => {
          const upload = new URL(raw).pathname.startsWith('/upload') && ['PATCH', 'POST'].includes(init.method ?? 'GET');
          if (!upload) return remote.fetcher(raw, init);
          sends++;
          if (scenario.effects === 'APPLIED') await remote.fetcher(raw, init);
          // The caller cannot distinguish an applied request from a refusal.
          return new Response('lost write response', { status: 500 });
        }) as any,
      });
      try {
        if (scenario.operation === 'update') await g.operate('read', [fileId]);
        put(writer, 'output/B/payload.md', payload);
        const path = join(writer.workspace, 'output/B/payload.md');
        await assert.rejects(g.operate(scenario.operation, scenario.operation === 'update'
          ? [fileId, path] : [folderId, 'Ambiguous.md', path]), /DRIVE_WRITE_AMBIGUOUS/);
        // No local authored file may mask a missing Drive-output edge.
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'SUCCEEDED');
    assert.equal(sends, 1);
    if (scenario.operation === 'create') fileId = [...remote.files.values()].find(value => value.name === 'Ambiguous.md')!.id;
    const intent = f.c.unresolvedClaims().find(claim => claim.kind === 'INTENT' && claim.holderId === writer.id)!;
    assert.equal(intent.state, 'UNCERTAIN');
    const entry = c.gatewayRecord(c.attempt(writer.id)).entries.find((value: any) => value.op === scenario.operation);
    assert.equal(entry.ok, false);
    assert.equal(entry.written, undefined);
    if (scenario.operation === 'create') assert.equal(entry.fileId, undefined, 'only reconciliation learns the created ID');
    // Prime the persistent output cache before the claim changes, with no
    // subsequent filesystem change available to invalidate it.
    assert.ok(c.workerOutputs(c.attempt(writer.id), c.lineageCache()).includes(digest(payload)));
    const at = new Date().toISOString(), evidenceId = 'settled-' + writer.id;
    f.c.addEvidence({
      ...note(evidenceId, 'B', writer.id), retrievedAt: at,
      metadata: { intentId: intent.id, claimsReconciliation: {
        operationStopped: true, effectsSettled: true,
        remoteChecked: [{ what: 'In-memory remote file and revision inspected after stop', at }],
        effects: scenario.effects, ...(scenario.operation === 'create' ? { fileId } : {}),
        assessment: 'Scripted remote inspection establishes the write outcome',
      } },
    }, f.c.localActor());
    f.c.reconcileClaims({ intent: intent.id }, evidenceId, f.c.localActor());
    assert.ok(!f.c.unresolvedClaims().some(claim => claim.kind === 'INTENT' && claim.holderId === writer.id));
    assert.equal(c.workerOutputs(c.attempt(writer.id), c.lineageCache()).includes(digest(payload)), scenario.effects === 'APPLIED');

    await checkpoint(f);
    const reader = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(reader.provider, 'codex');
    assert.equal(c.latestPin(f.c.task('A')).reviewer.provider, 'claude');
    const readerProvider = new MockProvider({ output: 'SIMULATION: consumed the checked remote object' });
    const readExecute = readerProvider.execute.bind(readerProvider);
    readerProvider.execute = async request => {
      const g = new DriveGateway({ credentials, policy: { read: 'ANY', update: [], createIn: [] },
        workspace: reader.workspace, auditDir: join(f.root, 'drive-audit', reader.id), runId: reader.id,
        fetcher: remote.fetcher as any });
      try {
        // Create also uses metadata-only discovery: no byte hash can rescue
        // an absent reconciled file-ID edge in the writer index.
        await g.operate(scenario.operation === 'create' ? 'meta' : 'read', [fileId]);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return readExecute(request);
    };
    assert.equal((await f.c.execute(reader, readerProvider, f.c.localActor())).status, 'SUCCEEDED');
    const sources = c.lineageSources(reader.id, c.lineageCache());
    assert.equal(has(sources, writer.id, scenario.operation === 'create' ? 'DRIVE_DISCOVERY' : 'DRIVE_READ'), scenario.effects === 'APPLIED');
    const reserveReview = () => f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    if (scenario.effects === 'APPLIED') assert.throws(reserveReview, /ADAPTIVE_LINEAGE_CONFLICT/);
    else assert.equal(reserveReview().provider, 'claude');
  } finally { f.close(); }
});

test('Y6: repeated host updates of one native document trace the matching result version', async () => {
  const f = project({ tasks: [{ id: 'A' }, { id: 'B' }, { id: 'C', drive: true }] });
  try {
    await checkpoint(f); const first = await work(f, 'first-source');
    await checkpoint(f, undefined, 'B'); const second = await work(f, 'second-source', 'B');
    const fileId = 'NATIVE0123456789';
    filing(f, 'twice', [
      { at: AT, op: 'update', ok: true, fileId, versionAfter: '2', sha256: digest(first.receipt.output) },
      { at: AT, op: 'update', ok: true, fileId, versionAfter: '3', sha256: digest(second.receipt.output) },
    ], [
      { fileId, op: 'update', versionAfter: '2', sha256: digest(first.receipt.output), path: join(first.attempt.workspace, 'not-used') },
      { fileId, op: 'update', versionAfter: '3', sha256: digest(second.receipt.output), path: join(second.attempt.workspace, 'not-used') },
    ]);
    await checkpoint(f, undefined, 'C');
    const consumer = await workWith(f, 'C', a => gateway(join(a.workspace, 'drive-changes', a.id), [{ at: AT, op: 'read', ok: true, fileId, versionBefore: '3', sha256: digest('native exported bytes differ') }]));
    const c = f.c as any, sources = c.lineageSources(consumer.attempt.id, c.lineageCache());
    assert.ok(has(sources, second.attempt.id, 'DRIVE_READ'));
    assert.ok(!has(sources, first.attempt.id, 'DRIVE_READ'));
  } finally { f.close(); }
});

test('N1/Y6: a reconciled ambiguous host create traces its source through a result with no original file ID', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B', expert: true }], evidence: CLAUDE_SOURCE });
  const c = f.c as any, remote = fakeDrive(), id = randomUUID(), holder = { kind: 'filing' as const, id };
  c.config.claimsSettlingMs = 0;
  const credentials = { clientFile: join(f.root, 'client.json'), tokenFile: join(f.root, 'token.json') };
  writeFileSync(credentials.clientFile, JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  writeFileSync(credentials.tokenFile, JSON.stringify({ refresh_token: 'r' }));
  try {
    await checkpoint(f, undefined, 'B');
    const payload = 'Claude-authored native-document source for host filing';
    const writer = await workWith(f, 'B', a => put(a, 'output/B/source.md', payload));
    const sourcePath = join(writer.attempt.workspace, 'output/B/source.md');
    const workspace = join(f.root, 'filing', id), auditDir = join(f.root, 'drive-audit', 'filing-' + id);
    put({ workspace } as any, 'source.md', payload);
    f.db.transaction(() => c.insertClaims(holder, 'B', writer.attempt.specDigest, ['drive:folder:folderAAAAAAAAAA'], 'HELD'));
    const g = new DriveGateway({ credentials, policy: { read: 'ANY', update: [], createIn: ['folderAAAAAAAAAA'] },
      workspace, auditDir, runId: id, writes: f.c.driveWriteHooks(holder),
      fetcher: (async (raw: string, init: RequestInit) => {
        const result = await remote.fetcher(raw, init);
        return init.method === 'POST' && new URL(raw).pathname.startsWith('/upload')
          ? new Response('lost create response', { status: 500 }) : result;
      }) as any });
    try {
      await assert.rejects(g.operate('create', ['folderAAAAAAAAAA', 'Native ambiguous', join(workspace, 'source.md'), 'doc']), /DRIVE_WRITE_AMBIGUOUS/);
    } finally { await g.close(); f.c.releaseFilingClaims(id); }
    const result = { op: 'create', name: 'Native ambiguous', path: sourcePath, sha256: digest(payload), readback: 'NOT_READ', error: 'DRIVE_WRITE_AMBIGUOUS' };
    f.c.recordFiling('B', { id, auditDir, complete: false, results: [result] }, f.c.localActor());
    const fileId = [...remote.files.values()].find(value => value.name === 'Native ambiguous')!.id;
    const intent = f.c.unresolvedClaims().find(claim => claim.kind === 'INTENT' && claim.holderId === id)!;
    const at = new Date().toISOString(), evidenceId = 'filing-settled-' + id;
    f.c.addEvidence({ ...note(evidenceId, 'B', writer.attempt.id), retrievedAt: at,
      metadata: { intentId: intent.id, claimsReconciliation: {
        operationStopped: true, effectsSettled: true, effects: 'APPLIED', fileId,
        remoteChecked: [{ what: 'The created native document exists with the filed source', at }],
        assessment: 'The in-memory create was applied before its response was lost',
      } } }, f.c.localActor());
    f.c.reconcileClaims({ intent: intent.id }, evidenceId, f.c.localActor());
    assert.ok(!f.c.unresolvedClaims().some(claim => claim.holderId === id));
    await checkpoint(f);
    const reader = await workWith(f, 'A', a => gateway(join(a.workspace, 'drive-changes', a.id),
      [{ at, completedAt: new Date().toISOString(), op: 'meta', ok: true, fileId }]));
    const cache = c.lineageCache(), filed = f.db.all<{ body: string }>("SELECT body FROM events WHERE kind='DRIVE_FILED'")
      .map(row => JSON.parse(row.body)).find(value => value.id === id);
    assert.equal(filed.results[0].fileId, undefined);
    const entries = readFileSync(join(auditDir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(entries.find((value: any) => value.op === 'create').fileId, undefined);
    assert.ok(has(c.lineageSources(reader.attempt.id, cache), writer.attempt.id, 'DRIVE_DISCOVERY'));
    assert.throws(() => f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor()), /ADAPTIVE_LINEAGE_CONFLICT/);
  } finally { f.close(); }
});

test('Y7: a later versionless acknowledged writer cannot contaminate an earlier versioned read', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B', drive: true }] });
  let release = () => {};
  let running: Promise<unknown> | undefined;
  try {
    const fileId = 'TEMPORAL0123456789', earlierFileId = 'EARLIER0123456789', exactFileId = 'EXACT0123456789';
    const otherId = f.o.submit({ requestKey: randomUUID(), prompt: 'Independent concurrent writer project',
      context: { cwd: f.root, projectKey: 'overlapping-writer' }, sourceRef: 'test:owner' }).request.id;
    f.o.attach(otherId, ['B']);
    await checkpoint({ ...f, id: otherId }, undefined, 'B');
    await checkpoint(f);
    const later = f.c.reserve('B', { projectRequestId: otherId, requestKey: randomUUID() }, f.c.localActor());
    const pause = new Promise<void>(resolve => { release = resolve; });
    let entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    const provider = new MockProvider({ output: 'SIMULATION: concurrent writer' }), execute = provider.execute.bind(provider);
    provider.execute = async request => {
      entered(); await pause;
      gateway(join(later.workspace, 'drive-changes', later.id), [
        { at: '2026-10-29T02:00:00Z', op: 'update', ok: false, written: true, fileId, versionBefore: '1' },
        { at: '2026-10-29T00:59:00Z', op: 'update', ok: false, written: true, fileId: earlierFileId, versionBefore: '1' },
        { at: '2026-10-29T00:59:00Z', op: 'update', ok: true, fileId: exactFileId, versionAfter: '2' },
      ]);
      return execute(request);
    };
    running = f.c.execute(later, provider, f.c.localActor());
    await started;
    const read = await workWith(f, 'A', a => gateway(join(a.workspace, 'drive-changes', a.id),
      [fileId, earlierFileId, exactFileId].map(id => ({ at: '2026-10-29T01:00:00Z', completedAt: '2026-10-29T01:00:02Z', op: 'read', ok: true, fileId: id, versionBefore: '1' }))));
    release(); await running;
    const c = f.c as any, cache = c.lineageCache(), order = c.lineageOrder(cache);
    assert.ok(order.reserved.get(later.id) < order.received.get(read.attempt.id), 'the journal cutoff must admit this overlapping writer');
    const sources = c.lineageSources(read.attempt.id, cache);
    const from = (id: string) => sources.some((source: any) => source.producerRunId === later.id && source.kind === 'DRIVE_READ' && source.fields?.includes(id));
    assert.equal(from(fileId), false, 'a versionless write beginning after the read must be excluded by time');
    assert.equal(from(earlierFileId), true, 'a versionless write before the read remains a possible source');
    assert.equal(from(exactFileId), false, 'an earlier acknowledged write of a different version is excluded');
  } finally { release(); await running?.catch(() => {}); f.close(); }
});

test('Y8: paginated discovery includes a writer created after call start but before completion', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B', drive: true }] });
  try {
    const fileId = 'DISCOVER0123456789';
    await checkpoint(f, undefined, 'B');
    const writer = await workWith(f, 'B', a => gateway(join(a.workspace, 'drive-changes', a.id), [{ at: '2026-10-29T01:00:05Z', writeAcknowledgedAt: '2026-10-29T01:00:06Z', op: 'create', ok: true, fileId, versionAfter: '1' }]));
    await checkpoint(f);
    const reader = await workWith(f, 'A', a => gateway(join(a.workspace, 'drive-changes', a.id), [{ at: '2026-10-29T01:00:00Z', completedAt: '2026-10-29T01:00:10Z', op: 'list', ok: true, returned: [fileId] }]));
    const c = f.c as any;
    assert.ok(has(c.lineageSources(reader.attempt.id, c.lineageCache()), writer.attempt.id, 'DRIVE_DISCOVERY'));
  } finally { f.close(); }
});

test('Y9: filing a new pathname containing unchanged input bytes does not credit the copying worker', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }] });
  try {
    await checkpoint(f);
    const made = await workWith(f, 'A', a => {
      gateway(join(a.workspace, 'drive-changes', a.id), [{ at: AT, op: 'pack', ok: true, fileId: 'OWNER0123456789', sha256: digest('owner-authored source') }]);
      put(a, `drive-changes/${a.id}/pack/source.txt`, 'owner-authored source');
      put(a, 'output/A/copied.md', 'owner-authored source');
    });
    const c = f.c as any;
    assert.deepEqual(c.filingProducers({ path: join(made.attempt.workspace, 'output/A/copied.md'), sha256: digest('native export') }, Infinity, c.lineageCache()), []);
  } finally { f.close(); }
});

test('Y10: settling an outcome supplies neither provider identity nor a reviewer-independent session', async () => {
  const f = project();
  try {
    await checkpoint(f); const made = await work(f);
    const c = f.c as any, recorded = c.lineageCache().runs.get(made.attempt.id);
    assert.equal(c.contributorProvider(recorded), 'codex');
    for (const state of ['FAILED', 'CANCELLED', 'SUCCEEDED'])
      assert.equal(c.contributorProvider({ ...recorded, a: { ...recorded.a, state }, receiptValid: false, identityVerified: false }), 'UNKNOWN');
    assert.equal(c.contributorProvider({ ...recorded, identityVerified: false }), 'UNKNOWN');
    assert.equal(c.contributorProvider({ ...recorded, sessionId: undefined }), 'UNKNOWN');
  } finally { f.close(); }
});

test('Y10: an actually launched receiptless writer remains unknown after stopped-outcome reconciliation', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B' }] });
  try {
    await checkpoint(f);
    const a = f.c.reserve('A', { requestKey: 'lost-receipt', projectRequestId: f.id }, f.c.localActor());
    const text = 'Acknowledged bytes from a receiptless invocation';
    const provider = new MockProvider();
    provider.execute = async () => {
      gateway(join(a.workspace, 'drive-changes', a.id), [{ at: AT, op: 'create', ok: true, fileId: 'LOSTRECEIPT0123456789', versionAfter: '1', sha256: digest(text) }]);
      throw new Error('LOST_RUNNER_RETURN');
    };
    await assert.rejects(() => f.c.execute(a, provider, f.c.localActor()), /LOST_RUNNER_RETURN/);
    assert.equal((f.c as any).attempt(a.id).state, 'UNKNOWN');
    assert.equal(f.db.get('SELECT body FROM receipts WHERE attempt_id=?', a.id), undefined);
    f.c.addEvidence({ ...note('stopped-writer', 'A', a.id), revision: a.artifactRevision, retrievedAt: new Date().toISOString(), metadata: { runId: a.id, reconciliation: { processStopped: true, externalEffects: 'RECONCILED', assessment: 'The scripted invocation stopped after its acknowledged write', usage: { costUsd: 0, tokens: 0 } } } }, f.c.localActor());
    f.c.reconcile(a.id, 'FAILED', 'stopped-writer', f.c.localActor());
    f.c.addEvidence({ ...note('copied-unknown', 'B', 'outside-system', text), metadata: {} }, f.c.localActor());
    const authorship = (f.c as any).adaptiveAuthorship(f.c.task('B'), {});
    assert.ok(authorship.runs.includes(a.id));
    assert.equal(authorship.unknown, true);
    await checkpoint(f, undefined, 'B');
    assert.match(f.c.admissionRefusal('B', { projectRequestId: f.id }) ?? '', /ADAPTIVE_AUTHORSHIP_UNKNOWN/);
  } finally { f.close(); }
});

test('Y11: acceptance between reservation and start exempts the input; acceptance after start does not', async () => {
  const f = project({ tasks: [{ id: 'A' }, { id: 'B' }] });
  try {
    await checkpoint(f, undefined, 'B'); const source = await work(f, 'accepted source', 'B');
    const judged = await review(f, 'PASS', 'B');
    f.c.bindAcceptance('B', 'receipt', 'output-' + source.attempt.id, f.c.localActor());
    bind(f, 'A', [f.c.evidenceFor('B').find(e => e.id === 'output-' + source.attempt.id)!]);
    await checkpoint(f);
    const queued = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    acceptTask(f, 'B', judged.id);
    const c = f.c as any;
    // With no start intent, admission treats this as a prospective launch.
    assert.ok(!c.taskAuthorship(f.c.task('A'), c.lineageCache(), undefined, queued.id).runs.includes(source.attempt.id));
    const afterStart = c.lineageCache(), order = c.lineageOrder(afterStart);
    order.started.set(queued.id, order.reserved.get(queued.id));
    assert.ok(c.taskAuthorship(f.c.task('A'), afterStart, undefined, queued.id).runs.includes(source.attempt.id));
  } finally { f.close(); }
});

test('Y12: failed Drive bytes and accepted artifact hashing are warmed outside the write lock; tampering invalidates them', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }, { id: 'B', reviewAcceptance: true }] });
  try {
    await checkpoint(f);
    await workWith(f, 'A', a => {
      gateway(join(a.workspace, 'drive-changes', a.id), [{ at: AT, op: 'create', ok: true, fileId: 'OUTPUT0123456789', versionAfter: '1', sha256: digest('large failed output') }]);
      put(a, `drive-changes/${a.id}/after/OUTPUT0123456789@v1-1.txt`, 'large failed output');
    }, new MockProvider({ outcome: 'failure' }));
    await checkpoint(f, undefined, 'B'); const accepted = await work(f, 'accepted bytes', 'B');
    const judged = await review(f, 'PASS', 'B');
    f.c.bindAcceptance('B', 'receipt', 'output-' + accepted.attempt.id, f.c.localActor());
    f.c.bindAcceptance('B', 'review', 'review-workflow-review-' + judged.id, f.c.localActor());
    acceptTask(f, 'B', judged.id);
    f.restart(); const c = f.c as any;
    c.warmLineage();
    const oldSnapshot = c.snapshot.bind(c); let lockedReads = 0;
    c.snapshot = (...args: any[]) => { if (f.db.inWriteTransaction()) lockedReads++; return oldSnapshot(...args); };
    f.db.transaction(() => {
      const cache = c.lineageCache();
      c.lineageOutputs(cache);
      assert.equal(c.acceptedArtifact(accepted.attempt.id, Infinity, cache), true);
      c.projectContextFor(f.id);
    });
    assert.equal(lockedReads, 0);
    chmodSync(accepted.attempt.workspace, 0o755);
    writeFileSync(join(accepted.attempt.workspace, 'tampered.txt'), 'changed after warm');
    f.db.transaction(() => assert.equal(c.acceptedArtifact(accepted.attempt.id, Infinity, c.lineageCache()), false));
    assert.equal(lockedReads, 0);
  } finally { f.close(); }
});

test('Y13: a chain of accepted reviewed inputs shares currency validation instead of branching exponentially', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'N' + i);
  const f = project({ tasks: ids.map(id => ({ id, reviewAcceptance: true })) });
  try {
    let previous: any;
    for (const id of ids) {
      if (previous) bind(f, id, [previous]);
      await checkpoint(f, undefined, id);
      const made = await work(f, 'artifact-' + id, id), judged = await review(f, 'PASS', id);
      f.c.bindAcceptance(id, 'receipt', 'output-' + made.attempt.id, f.c.localActor());
      f.c.bindAcceptance(id, 'review', 'review-workflow-review-' + judged.id, f.c.localActor());
      acceptTask(f, id, judged.id);
      previous = f.c.evidenceFor(id).find(e => e.id === 'output-' + made.attempt.id);
    }
    const c = f.c as any, original = c.acceptanceCurrent.bind(c); let calls = 0;
    c.acceptanceCurrent = (...args: any[]) => { assert.ok(++calls < 150, 'currency must not branch exponentially'); return original(...args); };
    c.taskAuthorship(f.c.task(ids.at(-1)!));
    assert.ok(calls <= 4 * ids.length, String(calls));
    c.acceptanceCurrent = original;
    const last = ids.at(-1)!;
    assert.equal(c.acceptanceCurrent(f.c.task(last)), true);
    f.c.revoke('accept-' + last, 'Owner withdrew acceptance after the prior read', f.c.localActor());
    assert.equal(c.acceptanceCurrent(f.c.task(last)), false, 'a fresh read cannot reuse a scope from before the revocation');
  } finally { f.close(); }
});

test('Y14: dense acyclic lineage walks each edge once and handles cycles without transitive-set unions', () => {
  const f = project();
  try {
    const c = f.c as any, cache = c.lineageCache();
    const n = 1200, roots = Array.from({ length: n }, (_, i) => 'writer-' + i);
    const source = (producerRunId: string) => ({ kind: 'DRIVE_DISCOVERY', producerRunId });
    for (let i = 0; i < n; i++) {
      cache.runs.set(roots[i], { a: { id: roots[i], taskId: 'A', role: 'worker', state: 'SUCCEEDED' }, rowid: i, receiptValid: false });
      cache.sources.set(roots[i], roots.slice(0, i).map(source));
    }
    const original = c.lineageSources.bind(c); let vertices = 0, edges = 0;
    c.lineageSources = (id: string, active: any) => { vertices++; const found = original(id, active); edges += found.length; return found; };
    const result = c.lineageReachable(roots, cache);
    assert.equal(result.size, n); assert.equal(vertices, n); assert.equal(edges, n * (n - 1) / 2);
    // Begin a new read scope before changing the graph. The earlier cache
    // already has every DAG summary, and its last root already reaches all
    // nodes; reusing it would make a cycle assertion vacuous.
    const cycle = c.lineageCache();
    for (const [id, run] of cache.runs) cycle.runs.set(id, run);
    for (const [id, sources] of cache.sources) cycle.sources.set(id, [...sources]);
    cycle.sources.get(roots[0]).push(source(roots[n - 1]!));
    vertices = 0; edges = 0;
    assert.equal(c.lineageReachable([roots[0]], cycle).size, n,
      'the first root reaches the other writers only through the new cycle');
    assert.equal(vertices, n); assert.equal(edges, n * (n - 1) / 2 + 1);
    assert.equal(c.lineageReachable([roots[1]], cycle).size, n,
      'every member receives the completed strongly connected summary');
    assert.equal(vertices, n, 'the second member uses its completed cycle summary');
  } finally { f.close(); }
});
