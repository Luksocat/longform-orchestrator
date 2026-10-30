/** R7-A: a gateway with no calls is empty, not a permanently damaged writer. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { canonical, demoTask, digest, reviewPayload, specDigest, type Review } from '../src/domain.js';
import { DriveGateway } from '../src/drive.js';
import { MockProvider, type ProviderReceipt, type ProviderRequest } from '../src/providers.js';
import { fakeDrive } from './fake-drive.js';
import { project, checkpoint, work, type Project, type Attempt } from './fixtures/adaptive/remediation-project.js';

const FILE = 'notesAAAAAAAAAAA', FOLDER = 'folderAAAAAAAAAA';
function credentials(f: Project) {
  const auth = { clientFile: join(f.root, 'client.json'), tokenFile: join(f.root, 'token.json') };
  writeFileSync(auth.clientFile, JSON.stringify({ installed: { client_id: 'c', client_secret: 's' } }));
  writeFileSync(auth.tokenFile, JSON.stringify({ refresh_token: 'r' }));
  return auth;
}
function receipt(r: ProviderRequest, extra: Partial<ProviderReceipt> = {}): ProviderReceipt {
  const at = new Date().toISOString();
  return { runId: r.runId, taskId: r.taskId, provider: r.provider, model: r.model, effort: r.effort,
    sessionId: randomUUID(), status: 'SUCCEEDED', exitCode: 0, startedAt: at, endedAt: at,
    output: 'Scripted gateway fixture, no live model invoked', tests: [], costUsd: 0, tokens: 0,
    identityVerified: true, simulation: false, ...extra };
}
function runEvidence(f: Project, a: Attempt, calls: number): ProviderReceipt['provenance'] {
  const path = join(f.root, 'run-' + a.id + '.json');
  const bytes = JSON.stringify({ runId: a.id, drive: { auditDir: join(f.root, 'drive-audit', a.id), calls } });
  writeFileSync(path, bytes);
  return { cliVersion: 'scripted-test', executableDigest: digest('scripted-test'),
    isolationEvidenceRef: 'test:scripted', capabilityEvidenceRef: 'test:scripted',
    identityEvidenceRef: 'file:' + path + '#sha256=' + digest(bytes), rawStdoutDigest: digest(''), rawStdoutBytes: 0 };
}

type RecordCase = 'refused-empty' | 'reported-empty' | 'unknown-empty' | 'unknown-called' |
  'missing-called-log' | 'truncated-log' | 'blank-log' | 'whitespace-log' | 'malformed-reference' | 'unlogged-bytes' | 'open-intent';
/**
 * Use a non-simulation two-tier task so reserve creates real Drive claims and
 * execute supplies its actual policy/hooks. Only the provider and remote are
 * scripted. The later consumer uses the existing adaptive simulation policy.
 */
async function priorGateway(f: Project, remote: ReturnType<typeof fakeDrive>, kind: RecordCase) {
  const c = f.c as any, adaptivePolicy = c.config.routingPolicy, actor = f.c.localActor();
  c.config.allowRealLocalTasks = true;
  c.config.routingPolicy = { version: 1, id: 'r7a-scripted-two-tier', routes: ['ROUTINE', 'STANDARD', 'COMPLEX', 'EXPERT'].map(level => ({
    id: 'r7a-' + level.toLowerCase(), level, provider: 'claude', model: 'claude-opus-5-5', effort: 'max',
    roles: ['worker', 'reviewer'], simulation: false, enabled: true,
    capability: { provider: 'claude', model: 'claude-opus-5-5', effort: 'max',
      verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), evidenceRef: 'test:scripted' },
  })) };
  const source = { evidenceId: 'source-LEGACY', revision: 'r1', digest: digest('owner-authorized fixture') };
  const task = demoTask('LEGACY', { simulation: false, providers: ['claude'], sources: [source],
    dimensions: { authorization: 'EXPLICIT', sourceEffectuation: 'CANDIDATE', implementation: 'NOT_STARTED', review: 'NONE', release: 'NOT_AUTHORIZED' },
    operations: ['READ_LOCAL', 'WRITE_LOCAL', 'READ_DRIVE', 'WRITE_DRIVE'], writePaths: ['output/LEGACY', 'drive-changes'],
    drive: { read: 'ANY', update: [FILE], createIn: [FOLDER] }, reviewPolicy: { required: false, crossProvider: false, independentAudits: false },
    budget: { deadlineMs: 10_000, maxAttempts: 2, maxCostUsd: 1, maxTokens: 10000 } });
  f.c.importTasks([task], actor);
  f.c.addEvidence({ id: source.evidenceId, taskId: task.id, kind: 'LOCAL', uri: 'test:source', revision: source.revision,
    digest: source.digest, retrievedAt: new Date().toISOString(), authorityTier: 'PLANNING', authentication: 'LOCAL_OWNER_REQUEST',
    currentness: 'CURRENT_AT_RETRIEVAL', claims: [], metadata: {} }, actor);
  f.c.grant(task.id, { id: randomUUID(), operations: task.operations, paths: task.writePaths,
    decisionText: 'Use the in-memory Drive fixture only', sourceRef: 'test:owner' }, actor);
  const auth = credentials(f);
  try {
    const a = f.c.reserve(task.id, { requestKey: randomUUID() }, actor);
    const claims = f.c.unresolvedClaims().filter(row => row.holderId === a.id && row.kind === 'CLAIM').map(row => row.resource);
    assert.ok(claims.includes('drive:file:' + FILE), 'real reservation claims its update file');
    assert.ok(claims.includes('drive:folder:' + FOLDER), 'real reservation claims its create folder');
    const result = await f.c.execute(a, { execute: async request => {
      assert.deepEqual(request.drivePolicy, task.drive);
      assert.ok(request.driveWrites, 'real task supplies durable write hooks');
      const dir = join(f.root, 'drive-audit', a.id), log = join(dir, 'log.jsonl');
      const gateway = new DriveGateway({ credentials: auth, policy: request.drivePolicy!, workspace: a.workspace,
        auditDir: dir, runId: a.id, writes: request.driveWrites, fetcher: remote.fetcher as any });
      try {
        await gateway.prepare();
        assert.equal(gateway.log.length, 0);
        assert.equal(existsSync(log), false, 'preparation creates directories, not a call log');
        if (kind === 'refused-empty') {
          // A scripted observation arrives while gateway preparation waits,
          // just as another run's reported provider limit can do in the host.
          f.db.event('PROVIDER_LIMIT_OBSERVED', null, { provider: 'claude', kind: 'USAGE_LIMIT',
            until: new Date(Date.now() + 600_000).toISOString(), validResetAt: null, observedAt: new Date().toISOString() });
          const why = request.launchGate!();
          assert.match(why ?? '', /PROVIDER_PAUSED:claude/);
          return receipt(request, { status: 'FAILED', exitCode: null, identityVerified: false, notLaunched: true, output: why! });
        }
        if (kind === 'open-intent') {
          request.driveWrites!.begin({ kind: 'create', folderId: FOLDER });
          throw new Error('SCRIPTED_HOST_STOP_BEFORE_LOG');
        }
        if (['missing-called-log', 'blank-log', 'whitespace-log', 'unknown-called'].includes(kind)) {
          await gateway.operate('meta', [FILE]);
          assert.equal(gateway.log.length, 1);
          if (kind === 'missing-called-log') unlinkSync(log); // A lost log despite an authenticated nonzero call count.
          else if (kind === 'blank-log') writeFileSync(log, '');
          else if (kind === 'whitespace-log') writeFileSync(log, ' \n\t\n');
        } else if (kind === 'truncated-log') writeFileSync(log, '{"op":');
        else if (kind === 'unlogged-bytes') writeFileSync(join(dir, 'reads', 'unlogged.md'), 'retained read bytes');
        gateway.finalize();
        const provenance = kind === 'unlogged-bytes' ? undefined : runEvidence(f, a, gateway.log.length);
        if (kind === 'malformed-reference') provenance!.identityEvidenceRef = 'file:' + join(f.root, 'run-' + a.id + '.json') + '#sha256=broken';
        return receipt(request, { ...(provenance ? { provenance } : {}),
          ...(['unknown-empty', 'unknown-called'].includes(kind) ? { status: 'UNKNOWN', exitCode: null, identityVerified: false } : {}) });
      } finally { await gateway.close(); }
    } }, actor).catch(error => {
      if (kind !== 'open-intent') throw error;
      assert.match(String(error), /SCRIPTED_HOST_STOP_BEFORE_LOG/);
      return undefined;
    });
    if (kind === 'refused-empty') {
      assert.equal(result?.notLaunched, true);
      assert.equal(c.attempt(a.id).state, 'NOT_STARTED');
      assert.equal(c.attempt(a.id).started, true, 'controller entry preceded the runner launch refusal');
      f.c.clearProviderPause('claude', { reason: 'Scripted pause is over', evidence: ['test:clock-independent-pause'], sourceRef: 'test:owner' }, actor);
    }
    if (kind === 'open-intent') {
      assert.equal(c.attempt(a.id).state, 'UNKNOWN');
      assert.equal(f.c.unresolvedClaims().filter(row => row.holderId === a.id && row.kind === 'INTENT').length, 1);
    } else assert.equal(f.c.unresolvedClaims().filter(row => row.holderId === a.id && row.kind === 'INTENT').length, 0);
    return a;
  } finally { c.config.routingPolicy = adaptivePolicy; }
}
async function consumingWorker(f: Project, remote: ReturnType<typeof fakeDrive>, op: 'read' | 'list' | 'search') {
  await checkpoint(f);
  const a = f.c.reserve('A', { projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
  const provider = new MockProvider({ output: 'SIMULATION: observed the Drive scope without copying its bytes' });
  const execute = provider.execute.bind(provider);
  provider.execute = async request => {
    const gateway = new DriveGateway({ credentials: credentials(f), policy: { read: 'ANY', update: [], createIn: [] },
      workspace: a.workspace, auditDir: join(f.root, 'drive-audit', a.id), runId: a.id, fetcher: remote.fetcher as any });
    try {
      await (gateway as any).operate(op, [op === 'read' ? FILE : op === 'list' ? FOLDER : 'notes']);
      assert.ok(gateway.finalize().copied);
    } finally { await gateway.close(); }
    return execute(request);
  };
  assert.equal((await f.c.execute(a, provider, f.c.localActor())).status, 'SUCCEEDED');
  return a;
}

for (const op of ['list', 'search'] as const) test(`R7-A: a zero-call launch refusal with real Drive claims does not poison a later ${op}`, async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }] }), remote = fakeDrive();
  try {
    const prior = await priorGateway(f, remote, 'refused-empty');
    assert.equal(existsSync(join(f.root, 'drive-audit', prior.id, 'log.jsonl')), false);
    const reader = await consumingWorker(f, remote, op);
    const reviewer = f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.notEqual(reviewer.provider, reader.provider);
  } finally { f.close(); }
});

for (const kind of ['reported-empty', 'missing-called-log', 'truncated-log', 'blank-log', 'whitespace-log', 'malformed-reference', 'unlogged-bytes', 'open-intent'] as const)
  test(`R7-A: ${kind} record classification preserves independence and damaged-record holds`, async () => {
    const f = project({ tasks: [{ id: 'A', drive: true }] }), remote = fakeDrive();
    try {
      await priorGateway(f, remote, kind);
      await consumingWorker(f, remote, kind === 'open-intent' ? 'list' : 'read');
      const reserve = () => f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
      if (kind === 'reported-empty') assert.equal(reserve().provider, 'claude');
      else assert.throws(reserve, /ADAPTIVE_AUTHORSHIP_UNKNOWN/);
    } finally { f.close(); }
  });

test('R7-A: a zero-call Claude review can be followed by rework and another independent review', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }] }), remote = fakeDrive();
  try {
    await checkpoint(f);
    await work(f);
    const a = f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.equal(a.provider, 'claude');
    const task = f.c.task('A'), evidenceIds = f.c.evidenceFor('A').map(e => e.id);
    const report: Review = { id: 'review-' + a.id, taskId: 'A', runId: a.id, artifactRevision: task.artifactRevision,
      specDigest: specDigest(task), reviewerSession: 'pending', provider: a.provider,
      authorshipDisclosure: 'Scripted independent reviewer', availableEvidence: evidenceIds,
      findings: [{ materiality: 'MAJOR', evidenceIds: [], description: 'The output needs a revision' }],
      testsExecuted: [], testsNotExecuted: ['Scripted fixture'], conflictingEvidence: [], remediation: ['Revise the output'],
      residualHolds: [], verdict: 'FAIL', scope: 'Fixture A', nextAuthorizedStep: 'Rework',
      auditAssessments: ['ACCURACY', 'LOCAL_ANTI_DRIFT', 'MACRO_ANTI_DRIFT'].map(kind => ({ kind, result: 'PASS', evidenceIds, assessment: 'Scripted', limitations: [] })) as Review['auditAssessments'] };
    const provider = new MockProvider({ output: canonical(reviewPayload(report)) }), execute = provider.execute.bind(provider);
    provider.execute = async request => {
      const gateway = new DriveGateway({ credentials: credentials(f), policy: { read: 'ANY', update: [], createIn: [] },
        workspace: a.workspace, auditDir: join(f.root, 'drive-audit', a.id), runId: a.id, fetcher: remote.fetcher as any });
      try {
        await gateway.prepare();
        assert.equal(gateway.log.length, 0);
        // Read-only reviewers retain their record on the host, as LiveRunner does.
        return { ...await execute(request), provenance: runEvidence(f, a, 0) };
      } finally { await gateway.close(); }
    };
    const result = await f.c.execute(a, provider, f.c.localActor());
    f.c.review({ ...JSON.parse(result.output), id: report.id, runId: a.id, reviewerSession: result.sessionId }, f.c.localActor());
    assert.ok(f.c.reworkPending('A'));
    await checkpoint(f);
    const revised = await work(f, 'SIMULATION: corrected output after the zero-call review');
    const next = f.c.reserve('A', { role: 'reviewer', projectRequestId: f.id, requestKey: randomUUID() }, f.c.localActor());
    assert.notEqual(next.provider, revised.attempt.provider);
    assert.equal((f.c as any).lineageSources(a.id, (f.c as any).lineageCache()).some((s: any) => s.producerRunId === 'UNKNOWN'), false);
  } finally { f.close(); }
});

function watchFileReads(f: Project, t: TestContext) {
  const calls: Array<{ path: string; locked: boolean }> = [], original = fs.readFileSync;
  const wrapped = t.mock.method(fs, 'readFileSync', (...args: any[]) => {
    calls.push({ path: String(args[0]), locked: f.db.inWriteTransaction() });
    return Reflect.apply(original, fs, args);
  });
  // The controller imports the built-in's named binding; keep that binding
  // instrumented as well as the default object used to install the spy.
  syncBuiltinESMExports();
  return { calls, restore: () => { wrapped.mock.restore(); syncBuiltinESMExports(); } };
}
function assertEmptyRecord(record: any) {
  assert.ok(record, 'the prepared gateway directory remains observable');
  assert.equal(record.unreadable, undefined, 'a proven no-call gateway is readable');
  assert.deepEqual(record.entries, []);
}

for (const kind of ['reported-empty', 'unknown-empty'] as const)
  test(`R7-A: ${kind} can use warmed no-call evidence inside a write without reading file bytes`, async t => {
    const f = project({ tasks: [{ id: 'A', drive: true }] });
    let spy: ReturnType<typeof watchFileReads> | undefined;
    try {
      const prior = await priorGateway(f, fakeDrive(), kind);
      f.restart();
      const c = f.c as any, a = c.attempt(prior.id), identityFile = join(f.root, 'run-' + a.id + '.json');
      assert.equal(a.state, kind === 'reported-empty' ? 'SUCCEEDED' : 'UNKNOWN');
      spy = watchFileReads(f, t);
      assertEmptyRecord(c.gatewayRecord(a));
      assert.ok(spy.calls.some(x => x.path === identityFile && !x.locked), 'cold preparation authenticates the run record outside a write');
      f.db.transaction(() => assertEmptyRecord(c.gatewayRecord(c.attempt(a.id))));
      assert.deepEqual(spy.calls.filter(x => x.locked), [], 'a warmed empty classification requires metadata checks only');
    } finally { spy?.restore(); f.close(); }
  });

for (const changed of ['identity record', 'new call log', 'retained bytes'] as const)
  test(`R7-A: changing the ${changed} after no-call preparation invalidates its write-lock cache`, async t => {
    const f = project({ tasks: [{ id: 'A', drive: true }] });
    let spy: ReturnType<typeof watchFileReads> | undefined;
    try {
      const prior = await priorGateway(f, fakeDrive(), 'reported-empty');
      f.restart();
      const c = f.c as any, a = c.attempt(prior.id), dir = join(f.root, 'drive-audit', a.id);
      spy = watchFileReads(f, t);
      assertEmptyRecord(c.gatewayRecord(a));
      if (changed === 'identity record') {
        const path = join(f.root, 'run-' + a.id + '.json');
        writeFileSync(path, readFileSync(path, 'utf8') + '\n'); // Same JSON, invalid authenticated bytes.
      } else if (changed === 'new call log') writeFileSync(join(dir, 'log.jsonl'), '{"op":');
      else writeFileSync(join(dir, 'reads', 'late.md'), 'unlogged retained bytes');
      f.db.transaction(() => assert.throws(() => c.gatewayRecord(c.attempt(a.id)), /ADAPTIVE_LINEAGE_NOT_PREWARMED/));
      assert.deepEqual(spy.calls.filter(x => x.locked), [], 'changed evidence is refused before reading file bytes under the lock');
      assert.equal(c.gatewayRecord(c.attempt(a.id))?.unreadable, true, 'outside-lock revalidation preserves the damaged-record hold');
      f.db.transaction(() => assert.equal(c.gatewayRecord(c.attempt(a.id))?.unreadable, true));
      assert.deepEqual(spy.calls.filter(x => x.locked), []);
    } finally { spy?.restore(); f.close(); }
  });

test('R7-A: a warmed UNKNOWN run with an existing call log does not hash its identity record under a write lock', async t => {
  const f = project({ tasks: [{ id: 'A', drive: true }] });
  let spy: ReturnType<typeof watchFileReads> | undefined;
  try {
    const prior = await priorGateway(f, fakeDrive(), 'unknown-called');
    f.restart();
    const c = f.c as any, a = c.attempt(prior.id), identityFile = join(f.root, 'run-' + a.id + '.json');
    assert.equal(a.state, 'UNKNOWN');
    spy = watchFileReads(f, t);
    assert.equal(c.gatewayRecord(a).entries.length, 1);
    f.db.transaction(() => {
      const record = c.gatewayRecord(a);
      assert.equal(record?.unreadable, undefined);
      assert.equal(record.entries.length, 1);
      assert.equal(record.entries[0].op, 'meta');
    });
    // This control specifically excludes the newly introduced identity-file
    // authentication path when existing log entries establish the record.
    assert.ok(spy.calls.some(x => !x.locked && x.path.endsWith('/log.jsonl')));
    assert.equal(spy.calls.some(x => x.path === identityFile), false);
  } finally { spy?.restore(); f.close(); }
});

test('R7-A: a symlink-named identity file cannot authenticate a no-call record', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }] });
  try {
    const prior = await priorGateway(f, fakeDrive(), 'reported-empty');
    const path = join(f.root, 'run-' + prior.id + '.json'), target = path + '.target';
    writeFileSync(target, readFileSync(path));
    unlinkSync(path);
    symlinkSync(target, path);
    f.restart();
    const c = f.c as any;
    assert.equal(c.gatewayRecord(c.attempt(prior.id))?.unreadable, true);
  } finally { f.close(); }
});

test('R7-A: identity changes during no-call authentication cannot be cached under a newer stamp', async () => {
  const f = project({ tasks: [{ id: 'A', drive: true }] });
  try {
    const prior = await priorGateway(f, fakeDrive(), 'reported-empty');
    f.restart();
    const c = f.c as any, a = c.attempt(prior.id), original = c.hostGatewayDir.bind(c);
    const path = join(f.root, 'run-' + prior.id + '.json');
    // Fault injection at the authentication boundary, before gatewayRecord
    // would install its prepared classification. No journal/attempt is forged.
    c.hostGatewayDir = (...args: any[]) => {
      const result = original(...args);
      writeFileSync(path, readFileSync(path, 'utf8') + '\n');
      return result;
    };
    try { assert.throws(() => c.gatewayRecord(a), /ADAPTIVE_LINEAGE_FILES_CHANGED/); }
    finally { c.hostGatewayDir = original; }
    assert.equal(c.gatewayRecord(a)?.unreadable, true);
  } finally { f.close(); }
});
