/** Real gateway/custody regressions for the R6 N1 and R6-A findings. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../src/domain.js';
import { DriveGateway } from '../src/drive.js';
import { MockProvider } from '../src/providers.js';
import { fakeDrive } from './fake-drive.js';
import { project, checkpoint, put, note, EVIDENCE, type Evidence, type Project, type Attempt } from './fixtures/adaptive/remediation-project.js';

const FILE = 'notesAAAAAAAAAAA', OTHER = 'otherAAAAAAAAAAA', FOLDER = 'folderAAAAAAAAAA';
const CLAUDE_SOURCE: Evidence = {
  ...EVIDENCE,
  pairs: { ...EVIDENCE.pairs, 'general/expert': [['opus-expert-xhigh-worker', 'sol-expert-max-reviewer', 'strong']] },
};
const fixture = (extraReader = false) => project({
  tasks: [{ id: 'A', drive: true }, { id: 'B', drive: true, expert: true }, ...(extraReader ? [{ id: 'C', drive: true }] : [])],
  evidence: CLAUDE_SOURCE,
});
function credentials(f: Project) {
  const value = { clientFile: join(f.root, 'client.json'), tokenFile: join(f.root, 'token.json') };
  writeFileSync(value.clientFile, JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  writeFileSync(value.tokenFile, JSON.stringify({ refresh_token: 'r' }));
  return value;
}
function intentFor(f: Project, runId: string) {
  const rows = f.c.unresolvedClaims().filter(row => row.kind === 'INTENT' && row.holderId === runId);
  assert.equal(rows.length, 1, 'the run has exactly one unresolved send');
  return rows[0]!;
}
function settleIntent(f: Project, writer: Attempt, effects: 'APPLIED' | 'NOT_APPLIED', fileId?: string) {
  const intent = intentFor(f, writer.id), at = new Date().toISOString(), id = 'intent-settled-' + writer.id;
  (f.c as any).config.claimsSettlingMs = 0;
  f.c.addEvidence({
    ...note(id, writer.taskId, writer.id), retrievedAt: at,
    metadata: { intentId: intent.id, claimsReconciliation: {
      operationStopped: true, effectsSettled: true, effects, ...(fileId ? { fileId } : {}),
      remoteChecked: [{ what: 'In-memory Drive bytes and revisions inspected after operation stopped', at }],
      assessment: 'The scripted remote establishes the result of the one dispatched request',
    } },
  }, f.c.localActor());
  f.c.reconcileClaims({ intent: intent.id }, id, f.c.localActor());
}
async function readFile(f: Project, remote: ReturnType<typeof fakeDrive>, auth: ReturnType<typeof credentials>, taskId: string,
                        op: 'read' | 'meta' | 'list', fileId: string) {
  await checkpoint(f, undefined, taskId);
  const reader = f.c.reserve(taskId, { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
  assert.equal(reader.provider, 'codex');
  const provider = new MockProvider({ output: 'SIMULATION: consumed the remote observation without quoting its bytes' });
  const execute = provider.execute.bind(provider);
  provider.execute = async request => {
    const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [], createIn: [] },
      workspace: reader.workspace, auditDir: join(f.root, 'drive-audit', reader.id), runId: reader.id,
      fetcher: remote.fetcher as any });
    try {
      // list is also accepted by the gateway's public dispatch protocol.
      await (g as any).operate(op, [fileId]);
      assert.equal(g.finalize().copied, true);
    } finally { await g.close(); }
    return execute(request);
  };
  assert.equal((await f.c.execute(reader, provider, f.c.localActor())).status, 'SUCCEEDED');
  return reader;
}
function reviewer(f: Project, taskId = 'A') {
  return f.c.reserve(taskId, { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
}
const has = (sources: any[], runId: string) => sources.some(source => source.producerRunId === runId);

test('N1: a host killed after upload leaves a real OPEN intent whose reconciled writer stays unknown', async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive(), c = f.c as any;
  const payload = 'Receiptless Claude bytes applied immediately before the gateway host was killed';
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(writer.provider, 'claude');
    const remoteState = join(f.root, 'remote-after-crash.json');
    const modules = {
      controller: new URL('../src/controller.ts', import.meta.url).href,
      store: new URL('../src/store.ts', import.meta.url).href,
      providers: new URL('../src/providers.ts', import.meta.url).href,
      drive: new URL('../src/drive.ts', import.meta.url).href,
      fake: new URL('./fake-drive.ts', import.meta.url).href,
    };
    // The entire executing controller/gateway host dies in the real send path.
    // No outcome hook, dispatch finally block, finalize or receipt can run.
    const childCode = `
      import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
      import { join, dirname } from 'node:path';
      import { Controller } from ${JSON.stringify(modules.controller)};
      import { SqliteStore } from ${JSON.stringify(modules.store)};
      import { MockProvider } from ${JSON.stringify(modules.providers)};
      import { DriveGateway } from ${JSON.stringify(modules.drive)};
      import { fakeDrive } from ${JSON.stringify(modules.fake)};
      const setup = JSON.parse(process.env.LONGFORM_CRASH_FIXTURE);
      const db = new SqliteStore(join(setup.root, 'state.sqlite'));
      const c = new Controller(db, { ownerUid: process.getuid(), workspaceRoot: join(setup.root, 'workspaces'),
        driveAuditRoot: join(setup.root, 'drive-audit'), routingPolicy: setup.policy, verifyRoutingCapability: () => true });
      const remote = fakeDrive(), writer = setup.writer;
      const provider = new MockProvider();
      provider.execute = async () => {
        db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
          ['drive:file:' + setup.fileId], 'RUN'));
        const path = join(writer.workspace, 'output/B/payload.md');
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, setup.payload);
        const g = new DriveGateway({ credentials: setup.auth, policy: { read: 'ANY', update: [setup.fileId], createIn: [] },
          workspace: writer.workspace, auditDir: join(setup.root, 'drive-audit', writer.id), runId: writer.id,
          writes: c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: async (raw, init) => {
            const response = await remote.fetcher(raw, init);
            if (new URL(raw).pathname.startsWith('/upload') && init.method === 'PATCH') {
              writeFileSync(setup.remoteState, JSON.stringify([...remote.files]));
              unlinkSync(path); // Leave only the real gateway's already-staged uploaded bytes.
              process.kill(process.pid, 'SIGKILL');
              await new Promise(() => {});
            }
            return response;
          } });
        await g.operate('read', [setup.fileId]);
        await g.operate('update', [setup.fileId, path]);
        throw new Error('CRASH_BOUNDARY_WAS_NOT_REACHED');
      };
      await c.execute(writer, provider, c.localActor());
    `;
    const stopped = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childCode], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 15_000,
        env: { ...process.env, LONGFORM_CRASH_FIXTURE: JSON.stringify({
          root: f.root, writer, policy: c.config.routingPolicy, auth, payload, fileId: FILE, remoteState,
        }) }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', bytes => { stderr += bytes; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(stopped.signal, 'SIGKILL', stopped.stderr);
    assert.equal(stopped.code, null);
    remote.files.clear();
    for (const [id, value] of JSON.parse(readFileSync(remoteState, 'utf8'))) remote.files.set(id, value);
    assert.equal(remote.files.get(FILE)!.body, payload, 'the fake remote actually applied the upload');
    const crashed = c.attempt(writer.id);
    assert.equal(crashed.state, 'STARTED');
    assert.equal(intentFor(f, writer.id).state, 'OPEN');
    assert.equal(f.db.get('SELECT body FROM receipts WHERE attempt_id=?', writer.id), undefined);
    const hostLog = readFileSync(join(f.root, 'drive-audit', writer.id, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(hostLog.some(entry => entry.op === 'read'));
    assert.ok(!hostLog.some(entry => entry.op === 'update'), 'dispatch finally never recorded the killed send');
    f.c.recover(f.c.localActor(), crashed.leaseUntil + 1);
    assert.equal(c.attempt(writer.id).state, 'UNKNOWN');
    const evidenceId = 'crash-stopped-' + writer.id;
    f.c.addEvidence({ ...note(evidenceId, 'B', writer.id), revision: writer.artifactRevision,
      retrievedAt: new Date().toISOString(), metadata: { runId: writer.id, reconciliation: {
        processStopped: true, externalEffects: 'RECONCILED', assessment: 'The child exited on SIGKILL and its remote bytes were inspected',
      } } }, f.c.localActor());
    f.c.reconcile(writer.id, 'FAILED', evidenceId, f.c.localActor());
    settleIntent(f, writer, 'APPLIED');
    assert.equal(c.contributorProvider(c.lineageCache().runs.get(writer.id)), 'UNKNOWN', 'owner settlement cannot invent a provider receipt');
    const reader = await readFile(f, remote, auth, 'A', 'read', FILE);
    const sources = c.lineageSources(reader.id, c.lineageCache());
    assert.ok(has(sources, writer.id) || has(sources, 'UNKNOWN'), 'the real crash intent must remain a source or an explicit unknown');
    assert.throws(() => reviewer(f), /ADAPTIVE_AUTHORSHIP_UNKNOWN|ADAPTIVE_LINEAGE_CONFLICT/);
  } finally { f.close(); }
});

for (const scenario of [
  { op: 'list', unrelated: false },
  { op: 'meta', unrelated: false },
  { op: 'read', unrelated: false },
  { op: 'list', unrelated: true },
] as const) test(`N1: unresolved native create ${scenario.unrelated ? 'does not taint an unrelated folder list' : 'makes read-only ' + scenario.op + ' unknown'}`, async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive(), c = f.c as any;
  const payload = '# Native input\n\nDistinct unpublished Markdown';
  let created = '', sends = 0;
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const provider = new MockProvider({ output: 'SIMULATION: native creation response was lost' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest, ['drive:folder:' + FOLDER], 'RUN'));
      put(writer, 'output/B/source.md', payload);
      const path = join(writer.workspace, 'output/B/source.md');
      const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [], createIn: [FOLDER] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: (async (raw: string, init: RequestInit) => {
          const response = await remote.fetcher(raw, init);
          if (new URL(raw).pathname.startsWith('/upload') && init.method === 'POST') {
            sends++;
            const native = [...remote.files.values()].find(file => file.name === 'Unresolved native')!;
            created = native.id;
            // A native Doc's plain-text export differs from its Markdown upload.
            native.body = 'Native input\n\nDistinct unpublished Markdown\n';
            return new Response('lost native create response', { status: 500 });
          }
          return response;
        }) as any });
      try {
        await assert.rejects(g.operate('create', [FOLDER, 'Unresolved native', path, 'doc']), /DRIVE_WRITE_AMBIGUOUS/);
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'SUCCEEDED');
    assert.equal(sends, 1);
    assert.equal(intentFor(f, writer.id).state, 'UNCERTAIN');
    assert.equal(c.gatewayRecord(c.attempt(writer.id)).entries.find((entry: any) => entry.op === 'create').fileId, undefined);
    assert.notEqual(digest(remote.files.get(created)!.body), digest(payload), 'native read cannot recover authorship from identical bytes');
    const target = scenario.op === 'list' ? (scenario.unrelated ? 'elsewhereAAAAAAA' : FOLDER) : created;
    const reader = await readFile(f, remote, auth, 'A', scenario.op, target);
    const sources = c.lineageSources(reader.id, c.lineageCache());
    if (scenario.unrelated) {
      assert.ok(!has(sources, 'UNKNOWN') && !has(sources, writer.id), 'the known unrelated folder does not intersect the create intent');
      assert.equal(reviewer(f).provider, 'claude');
    } else {
      assert.ok(has(sources, 'UNKNOWN'), 'an unresolved create cannot silently disappear from read-only discovery');
      assert.throws(() => reviewer(f), /ADAPTIVE_AUTHORSHIP_UNKNOWN/);
    }
  } finally { f.close(); }
});

for (const scenario of [
  { effects: 'APPLIED', legacy: false },
  { effects: 'NOT_APPLIED', legacy: false },
  { effects: 'NOT_APPLIED', legacy: true },
] as const) test(`R6-A: latched retry F and attempted G are not authorship after ${scenario.effects}${scenario.legacy ? ' (legacy entries without intentId)' : ''}`, async () => {
  const f = fixture(true), auth = credentials(f), remote = fakeDrive(), c = f.c as any;
  const payloads = ['First send to F', 'Refused retry to F', 'Refused attempt to G'].map(text => text + ': unique Claude payload');
  let sends = 0;
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const provider = new MockProvider({ output: 'SIMULATION: first write was ambiguous and later writes were refused' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        ['drive:file:' + FILE, 'drive:file:' + OTHER], 'RUN'));
      const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [FILE, OTHER], createIn: [] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: (async (raw: string, init: RequestInit) => {
          if (new URL(raw).pathname.startsWith('/upload') && init.method === 'PATCH') {
            sends++;
            if (scenario.effects === 'APPLIED') await remote.fetcher(raw, init);
            return new Response('lost first update response', { status: 500 });
          }
          return remote.fetcher(raw, init);
        }) as any });
      if (scenario.legacy) {
        // Only omit the additive identifier at the real persistence boundary;
        // the gateway still supplies all original timing, staging and outcomes.
        const record = (g as any).record.bind(g);
        (g as any).record = (entry: any) => { delete entry.intentId; record(entry); };
      }
      const paths = payloads.map((text, i) => {
        const relative = 'output/B/payload-' + i + '.md'; put(writer, relative, text); return join(writer.workspace, relative);
      });
      try {
        await g.operate('read', [FILE]); await g.operate('read', [OTHER]);
        await assert.rejects(g.operate('update', [FILE, paths[0]!]), /DRIVE_WRITE_AMBIGUOUS/);
        // Reads remain allowed after the latch. Refresh F so the retry reaches
        // the latch, rather than stopping at the stale-version check.
        await g.operate('read', [FILE]);
        await assert.rejects(g.operate('update', [FILE, paths[1]!]), /DRIVE_CUSTODY_UNCERTAIN: DRIVE_WRITE_AMBIGUOUS/);
        await assert.rejects(g.operate('update', [OTHER, paths[2]!]), /DRIVE_CUSTODY_UNCERTAIN: DRIVE_WRITE_AMBIGUOUS/);
        for (const path of paths) unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'SUCCEEDED');
    assert.equal(sends, 1, 'only the first write reaches the remote');
    const entries = c.gatewayRecord(c.attempt(writer.id)).entries.filter((entry: any) => entry.op === 'update');
    assert.equal(entries.length, 3);
    assert.ok(entries[0].writeStartedAt);
    assert.equal(entries[1].writeStartedAt, undefined);
    assert.equal(entries[2].writeStartedAt, undefined);
    if (scenario.legacy) assert.ok(entries.every((entry: any) => entry.intentId === undefined));
    assert.equal(f.db.all("SELECT id FROM resource_claims WHERE holder_id=? AND kind='INTENT'", writer.id).length, 1);
    c.workerOutputs(c.attempt(writer.id), c.lineageCache()); // Prime before reconciliation.
    settleIntent(f, writer, scenario.effects);
    const outputs = c.workerOutputs(c.attempt(writer.id), c.lineageCache());
    // The refresh read makes the first payload a held input too. Check the
    // dispatched Drive output directly, then test file attribution below.
    assert.equal(c.lineageDriveOutputs(c.attempt(writer.id), c.lineageCache()).includes(digest(payloads[0]!)), scenario.effects === 'APPLIED');
    assert.ok(!outputs.includes(digest(payloads[1]!)), 'latched retry F never sent its staged bytes');
    assert.ok(!outputs.includes(digest(payloads[2]!)), 'latched attempt G never sent its staged bytes');
    for (const [taskId, fileId] of [['A', FILE], ['C', OTHER]]) {
      const reader = await readFile(f, remote, auth, taskId!, 'meta', fileId!);
      const sources = c.lineageSources(reader.id, c.lineageCache());
      const applied = fileId === FILE && scenario.effects === 'APPLIED';
      assert.equal(has(sources, writer.id), applied, 'authorship follows the sole dispatched write on its own file');
      assert.ok(!has(sources, 'UNKNOWN'), 'the owner settled the only dispatched write');
      if (applied) assert.throws(() => reviewer(f, taskId), /ADAPTIVE_LINEAGE_CONFLICT/);
      else {
        const admitted = reviewer(f, taskId);
        assert.equal(admitted.provider, 'claude');
        f.c.cancel(admitted.id, f.c.localActor());
      }
    }
  } finally { f.close(); }
});

for (const fileId of [FILE, OTHER]) test(`N1: an unreadable legacy writer record ${fileId === FILE ? 'holds its claimed file' : 'does not taint another file'}`, async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive();
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const provider = new MockProvider({ outcome: 'failure', output: 'SIMULATION: a legacy gateway wrote one claimed file before the run failed' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => (f.c as any).insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        ['drive:file:' + FILE], 'RUN'));
      put(writer, 'output/B/payload.md', 'Legacy content written to the claimed file');
      const path = join(writer.workspace, 'output/B/payload.md');
      // Historical gateways did not have write-intent hooks. The actual
      // claimed operation and its gateway log are still produced here.
      const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [FILE], createIn: [] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        fetcher: remote.fetcher as any });
      try {
        await g.operate('read', [FILE]);
        await g.operate('update', [FILE, path]);
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'FAILED');
    assert.equal(f.db.all("SELECT id FROM resource_claims WHERE kind='INTENT' AND holder_id=?", writer.id).length, 0);
    // Deliberate corruption is the condition under test, not a manufactured
    // missing dispatch record. The crash regression above kills the real host.
    writeFileSync(join(writer.workspace, 'drive-changes', writer.id, 'log.jsonl'), '{ truncated legacy record\n');
    f.restart();
    const c = f.c as any;
    assert.equal(c.gatewayRecord(c.attempt(writer.id)).unreadable, true);
    const reader = await readFile(f, remote, auth, 'A', 'meta', fileId);
    const sources = c.lineageSources(reader.id, c.lineageCache());
    if (fileId === FILE) {
      assert.ok(has(sources, 'UNKNOWN'), 'the unreadable record cannot erase authorship within its durable claim');
      assert.throws(() => reviewer(f), /ADAPTIVE_AUTHORSHIP_UNKNOWN/);
    } else {
      assert.ok(!has(sources, 'UNKNOWN') && !has(sources, writer.id), 'a claim on F does not make unrelated G unknown');
      assert.equal(reviewer(f).provider, 'claude');
    }
  } finally { f.close(); }
});

test('Author-found: rereading its own applied Drive bytes cannot erase a writer from content-only evidence', async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive(), c = f.c as any;
  const payload = 'Distinct Claude-authored content later read back by its own writer';
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(writer.provider, 'claude');
    const provider = new MockProvider({ output: 'SIMULATION: wrote and read back an external artifact' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        ['drive:file:' + FILE], 'RUN'));
      put(writer, 'output/B/source.md', payload);
      const path = join(writer.workspace, 'output/B/source.md');
      const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [FILE], createIn: [] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: remote.fetcher as any });
      try {
        await g.operate('read', [FILE]);
        await g.operate('update', [FILE, path]);
        await g.operate('read', [FILE]);
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'SUCCEEDED');
    assert.equal(remote.files.get(FILE)!.body, payload);
    assert.ok(!f.c.unresolvedClaims().some(claim => claim.kind === 'INTENT' && claim.holderId === writer.id));
    f.c.addEvidence({ ...note('content-only-after-self-read', 'A', 'outside-system', payload),
      retrievedAt: new Date().toISOString(), metadata: {} }, f.c.localActor());
    const authorship = c.adaptiveAuthorship(f.c.task('A'), {});
    assert.ok(authorship.runs.includes(writer.id), 'reading its own output afterward does not turn it into an unowned input');
    assert.equal(authorship.unknown, false, 'the original writer still has a valid provider receipt');
    await checkpoint(f);
    const consumer = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(consumer.provider, 'claude', 'selection accounts for the content producer before reserving a pair');
    assert.equal(c.latestPin(f.c.task('A')).reviewer.provider, 'codex');
  } finally { f.close(); }
});

test('N1: a proven non-applied native create with an unreadable record does not leave its folder unknown', async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive(), initialFiles = [...remote.files.keys()];
  let sends = 0;
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    const provider = new MockProvider({ outcome: 'failure', output: 'SIMULATION: native create response failed and the operation stopped' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => (f.c as any).insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        ['drive:folder:' + FOLDER], 'RUN'));
      put(writer, 'output/B/source.md', 'A native document that never reached the remote');
      const path = join(writer.workspace, 'output/B/source.md');
      const g = new DriveGateway({ credentials: auth, policy: { read: 'ANY', update: [], createIn: [FOLDER] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: (async (raw: string, init: RequestInit) => {
          if (new URL(raw).pathname.startsWith('/upload') && init.method === 'POST') {
            sends++;
            // The simulated transport fails before calling the remote write
            // handler. NOT_APPLIED is true, not a fabricated owner assertion.
            return new Response('native create was never applied', { status: 500 });
          }
          return remote.fetcher(raw, init);
        }) as any });
      try {
        await assert.rejects(g.operate('create', [FOLDER, 'Never created', path, 'doc']), /DRIVE_WRITE_AMBIGUOUS/);
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'FAILED');
    assert.equal(sends, 1);
    assert.deepEqual([...remote.files.keys()], initialFiles, 'the remote has no created document');
    assert.equal(intentFor(f, writer.id).state, 'UNCERTAIN');
    settleIntent(f, writer, 'NOT_APPLIED');
    assert.ok(!f.c.unresolvedClaims().some(claim => claim.kind === 'INTENT' && claim.holderId === writer.id));
    writeFileSync(join(writer.workspace, 'drive-changes', writer.id, 'log.jsonl'), '{ truncated modern record\n');
    f.restart();
    const c = f.c as any;
    assert.equal(c.gatewayRecord(c.attempt(writer.id)).unreadable, true);
    const reader = await readFile(f, remote, auth, 'A', 'list', FOLDER);
    const sources = c.lineageSources(reader.id, c.lineageCache());
    assert.ok(!has(sources, 'UNKNOWN') && !has(sources, writer.id), 'settling every possible send as non-applied clears the damaged-record folder fallback');
    assert.equal(reviewer(f).provider, 'claude');
  } finally { f.close(); }
});

for (const scenario of [
  { name: 'Doc create', op: 'create', mimeType: 'application/vnd.google-apps.document', earlierInput: false },
  { name: 'Doc update', op: 'update', mimeType: 'application/vnd.google-apps.document', earlierInput: false },
  { name: 'Sheet update', op: 'update', mimeType: 'application/vnd.google-apps.spreadsheet', earlierInput: false },
  { name: 'Doc update preserves an earlier unchanged export as input', op: 'update', mimeType: 'application/vnd.google-apps.document', earlierInput: true },
] as const) test(`AF1 native export: ${scenario.name}`, async () => {
  const f = fixture(), auth = credentials(f), remote = fakeDrive(), c = f.c as any;
  const originalId = 'docAAAAAAAAAAAAA', name = 'Authored native export';
  const sheet = scenario.mimeType === 'application/vnd.google-apps.spreadsheet';
  const payload = sheet ? 'heading,value\r\nexport,normalized\r\n' : '# Native output\n\nDistinct uploaded Markdown';
  const exported = sheet ? 'heading,value\nexport,normalized\n' : 'Native output\n\nDistinct uploaded Markdown\n';
  const existing = remote.files.get(originalId)!;
  existing.mimeType = scenario.mimeType;
  existing.body = scenario.earlierInput ? exported : 'Existing native content before this worker';
  let writtenId = originalId, sends = 0;
  try {
    await checkpoint(f, undefined, 'B');
    const writer = f.c.reserve('B', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(writer.provider, 'claude');
    const provider = new MockProvider({ output: 'SIMULATION: wrote a native file and checked its exported content' });
    const execute = provider.execute.bind(provider);
    provider.execute = async request => {
      f.db.transaction(() => c.insertClaims({ kind: 'run', id: writer.id }, 'B', writer.specDigest,
        [scenario.op === 'create' ? 'drive:folder:' + FOLDER : 'drive:file:' + originalId], 'RUN'));
      const relative = 'output/B/source.' + (sheet ? 'csv' : 'md');
      put(writer, relative, payload);
      const path = join(writer.workspace, relative);
      const g = new DriveGateway({ credentials: auth,
        policy: { read: 'ANY', update: scenario.op === 'update' ? [originalId] : [], createIn: scenario.op === 'create' ? [FOLDER] : [] },
        workspace: writer.workspace, auditDir: join(f.root, 'drive-audit', writer.id), runId: writer.id,
        writes: f.c.driveWriteHooks({ kind: 'run', id: writer.id }), fetcher: (async (raw: string, init: RequestInit) => {
          const response = await remote.fetcher(raw, init);
          if (new URL(raw).pathname.startsWith('/upload') && ['POST', 'PATCH'].includes(init.method ?? '')) {
            sends++;
            if (scenario.op === 'create') writtenId = [...remote.files.values()].find(file => file.name === name)!.id;
            // Model native import/export normalization as part of this send,
            // with the same file version, before the gateway's real read-back.
            remote.files.get(writtenId)!.body = exported;
          }
          return response;
        }) as any });
      try {
        if (scenario.op === 'create') {
          const created = await g.operate('create', [FOLDER, name, path, 'doc']) as { id: string };
          assert.equal(created.id, writtenId);
        } else {
          await g.operate('read', [originalId]);
          await g.operate('update', [originalId, path]);
        }
        await g.operate('read', [writtenId]);
        unlinkSync(path);
        assert.equal(g.finalize().copied, true);
      } finally { await g.close(); }
      return execute(request);
    };
    assert.equal((await f.c.execute(writer, provider, f.c.localActor())).status, 'SUCCEEDED');
    assert.equal(sends, 1);
    assert.notEqual(digest(exported), digest(payload), 'a native export cannot be matched by upload bytes');
    assert.equal(remote.files.get(writtenId)!.body, exported);
    assert.ok(!f.c.unresolvedClaims().some(claim => claim.kind === 'INTENT' && claim.holderId === writer.id));
    const record = c.gatewayRecord(c.attempt(writer.id));
    const writePosition = record.entries.findIndex((entry: any) => entry.op === scenario.op && entry.written);
    const readPosition = record.entries.findLastIndex((entry: any) => entry.op === 'read' && entry.fileId === writtenId);
    assert.ok(writePosition >= 0 && readPosition > writePosition, 'the real gateway recorded the export read after this write');
    assert.ok(c.recordDigests(record.dir, 'after').includes(digest(exported)), 'the gateway retained the actual native export as the write read-back');
    f.c.addEvidence({ ...note('content-only-native-export', 'A', 'outside-system', exported),
      retrievedAt: new Date().toISOString(), metadata: {} }, f.c.localActor());
    const authorship = c.adaptiveAuthorship(f.c.task('A'), {});
    assert.equal(authorship.runs.includes(writer.id), !scenario.earlierInput,
      scenario.earlierInput ? 'an earlier native export remains an external input, not output credited to its copier'
        : 'a later self-read of a different native export must preserve the actual writer');
    assert.equal(authorship.unknown, false);
    await checkpoint(f);
    const consumer = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(consumer.provider, scenario.earlierInput ? 'codex' : 'claude');
    assert.equal(c.latestPin(f.c.task('A')).reviewer.provider, scenario.earlierInput ? 'claude' : 'codex',
      'public selection pins the reviewer independently of the actual content producer');
  } finally { f.close(); }
});
