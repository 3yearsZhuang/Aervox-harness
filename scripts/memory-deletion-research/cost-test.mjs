import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { COST_SCHEMA_VERSION, COST_KIND, COST_BASELINE, COST_CONFIGURATIONS, COST_GUARD_MODES, COST_BOUNDARY, COST_REQUIRED_SOURCE_FILES, costSchedule } from './cost-protocol.mjs';
import { validateCostReport, validateCostFiles, recomputeCostSummary } from './cost-validator.mjs';
import { appendCostRevision } from './cost-child.mjs';
import { runCostStudy, finalizeCostChild } from './cost-runner.mjs';
import { fixture, query, oracle, close, LOCAL } from './fixture.mjs';
import { STORES } from './protocol.mjs';

test('single-factor configurations, separate baselines and rotated schedule are fixed', () => {
  assert.equal(COST_CONFIGURATIONS.length, 9);
  assert.equal(COST_CONFIGURATIONS.filter(value => value.isBaseline).length, 3);
  for (const value of COST_CONFIGURATIONS) for (const key of Object.keys(COST_BASELINE)) {
    assert.equal(value[key], key === value.axis ? value.level : COST_BASELINE[key]);
  }
  const full = costSchedule();
  assert.equal(full.filter(value => value.kind === 'scale').length, 270);
  assert.equal(full.filter(value => value.kind === 'guard').length, 60);
  assert.equal(new Set(full.map(value => value.id)).size, 330);
  assert.equal(full[0].configuration, COST_CONFIGURATIONS[0].id);
  assert.equal(full[9].configuration, COST_CONFIGURATIONS[1].id);
  assert.equal(full[270].mode, 'guard-disabled');
  assert.equal(full[272].mode, 'guard-enabled');
  for (const value of [0, 31, NaN, 1.5]) assert.throws(() => costSchedule(value));
});

test('guard reconstruction matches production insert values and calibrated tombstone behavior', async () => {
  const f = await fixture();
  try {
    const data = { memoryId: 'target', content: 'controlled payload', confidence: 0.3, importance: 0.8, algorithmVersion: 'cost-test' };
    const production = await f.provenance.appendMemoryRevision(LOCAL, { ...data, id: 'production' });
    for (const enabled of [false, true]) {
      const returned = await appendCostRevision(f.db, LOCAL, { ...data, id: `research-${enabled}` }, enabled);
      for (const key of ['memoryId', 'content', 'confidence', 'importance', 'algorithmVersion']) assert.equal(returned[key], production[key]);
      assert.equal(returned.id, `research-${enabled}`);
      assert.ok(Number.isFinite(Date.parse(returned.createdAt)));
      assert.equal((await query(f.client, 'SELECT content FROM memory_revisions WHERE id=?', [returned.id]))[0].content, data.content);
    }
    await f.store.clean('target');
    await assert.rejects(appendCostRevision(f.db, LOCAL, { ...data, id: 'denied' }, true), /memory_write_target_unavailable/);
    await assert.rejects(f.provenance.appendMemoryRevision(LOCAL, { ...data, id: 'production-denied' }), /memory_write_target_unavailable/);
    assert.equal((await oracle(f)).clean, true);
    await appendCostRevision(f.db, LOCAL, { ...data, id: 'unguarded-late' }, false);
    assert.equal((await oracle(f)).residue.revisions, 1);
    await f.store.clean('target'); await f.store.verify('target');
    assert.deepEqual(await oracle(f), { residue: Object.fromEntries(STORES.map(key => [key, 0])), clean: true, keepIntact: true });
  } finally { await close(f); }
});

// Explicit synthetic validator fixture. These rows never serve as measurements.
function validatorFixture() {
  const clean = () => ({ residue: Object.fromEntries(STORES.map(key => [key, 0])), clean: true, keepIntact: true });
  const proof = () => ({ verifier: 'memory-local-v3', verifiedAt: '2026-10-26T00:00:01.000Z', contentRows: 0, ftsRows: 0, vectorRows: 0 });
  const environment = { node: 'v24', platform: 'darwin', arch: 'arm64', cpu: 'fixture', kernel: 'fixture', sqliteVersion: '3.45.1', clientVersion: '0.14.0', filesystemType: 25, pragmas: { journal_mode: 'wal', foreign_keys: 1, synchronous: 2, busy_timeout: 0 } };
  const rows = costSchedule(1).map((unit, ordinal) => {
    const common = { ...unit, ordinal, pid: 1000 + ordinal, databaseId: `aervox-deletion-cost-fixture${ordinal}`, status: 'completed', error: null,
      execution: { code: 0, signal: null, stderr: '' }, environment, proof: proof(), final: clean() };
    if (unit.kind === 'scale') {
      const parameters = COST_CONFIGURATIONS.find(value => value.id === unit.configuration);
      const backgrounds = { hash: 'a'.repeat(64), counts: Object.fromEntries(STORES.map(key => [key, key === 'record' ? parameters.backgroundRecords : 0])) };
      return { ...common, parameters, cleanupMs: 2 + ordinal, verificationMs: 1 + ordinal,
        before: { backgrounds, revisions: parameters.targetRevisions, evidence: parameters.targetRevisions, contentLengths: { minimum: parameters.contentBytes, maximum: parameters.contentBytes } },
        after: { backgrounds: structuredClone(backgrounds) } };
    }
    const enabled = unit.mode === 'guard-enabled';
    const afterLate = clean(); if (!enabled) { afterLate.clean = false; afterLate.residue.revisions = 1; }
    return { ...common, writeMs: 1, persisted: true, lateRejected: enabled, atCompletion: clean(), afterLate, afterRecleanup: clean(),
      returned: { id: 'cost-timed-revision', memoryId: 'target', content: 'x'.repeat(1024), confidence: 0, importance: 0, algorithmVersion: null, createdAt: '2026-10-26T00:00:00.000Z' } };
  });
  const hashes = Object.fromEntries(COST_REQUIRED_SOURCE_FILES.map(name => [name, 'a'.repeat(64)]));
  return { schemaVersion: COST_SCHEMA_VERSION, kind: COST_KIND, status: 'completed', error: null, purpose: 'smoke', repetitions: 1,
    baseline: COST_BASELINE, configurations: COST_CONFIGURATIONS, guardModes: COST_GUARD_MODES, boundary: COST_BOUNDARY,
    commit: 'a'.repeat(40), workingTree: '', startedAt: '2026-10-26T00:00:00.000Z', completedAt: '2026-10-26T00:01:00.000Z', rawFile: 'report.raw.jsonl', rawSha256: 'a'.repeat(64),
    hashes, sourceConsistency: { afterHashes: structuredClone(hashes), beforeReadErrors: {}, readErrors: {}, changedFiles: [] }, samples: rows, summary: recomputeCostSummary(rows) };
}

test('validator refuses incomplete, forged, drifted and incorrectly summarized cost evidence', () => {
  const fixtureReport = validatorFixture();
  assert.equal(validateCostReport(fixtureReport, { requireFormal: false }).scaleSamples, 9);
  assert.throws(() => validateCostReport(fixtureReport), /30 repetitions/);
  const mutations = [
    report => { report.samples.pop(); },
    report => { report.samples[1] = report.samples[0]; },
    report => { report.samples[0].pid = report.samples[1].pid; },
    report => { report.samples[0].databaseId = report.samples[1].databaseId; },
    report => { report.samples[0].status = 'blocked'; },
    report => { report.samples[0].error = 'failure'; },
    report => { report.samples[0].execution.code = 1; },
    report => { report.samples[0].before.backgrounds.counts.record = 0; },
    report => { report.samples[0].after.backgrounds.hash = 'b'.repeat(64); },
    report => { report.samples[0].before.revisions = 1; },
    report => { report.samples[0].before.contentLengths.minimum = 0; },
    report => { report.samples[0].cleanupMs = -1; },
    report => { report.samples[0].verificationMs = NaN; },
    report => { delete report.samples[0].final.residue.vector; },
    report => { report.samples[0].final.keepIntact = false; },
    report => { report.samples[0].final.residue.vector = 1; },
    report => { report.samples[0].proof.verifier = 'memory-local-v2'; },
    report => { report.samples[9].persisted = false; },
    report => { report.samples[9].returned.content = ''; },
    report => { report.samples[9].afterRecleanup.clean = false; },
    report => { report.samples[10].lateRejected = false; },
    report => { report.summary.scale[0].cleanup.medianMs = 999; },
    report => { delete report.hashes[COST_REQUIRED_SOURCE_FILES[0]]; },
    report => { report.sourceConsistency.changedFiles.push(COST_REQUIRED_SOURCE_FILES[0]); },
    report => { report.sourceConsistency.beforeReadErrors.missing = 'failure'; },
    report => { report.sourceConsistency.afterHashes[COST_REQUIRED_SOURCE_FILES[0]] = 'b'.repeat(64); },
    report => { report.rawFile = '../raw.jsonl'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(fixtureReport); mutate(changed);
    assert.throws(() => validateCostReport(changed, { requireFormal: false }));
  }
});

test('blocked child observations remain visible and never count as completed evidence', () => {
  const unit = costSchedule(1)[0];
  const row = { ...unit, status: 'blocked', error: 'deletion_memory_verification_failed' };
  const blocked = finalizeCostChild(unit, row, { code: 1, signal: null, stderr: '' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.execution.code, 1);
  const summary = recomputeCostSummary([blocked]);
  assert.equal(summary.scale[0].blocked, 1);
  assert.equal(summary.scale[0].completed, 0);
  assert.equal(summary.scale[0].cleanup.n, 0);
  assert.equal(summary.scale[0].cleanup.medianMs, null);
  const report = validatorFixture();
  report.samples[0] = { ...report.samples[0], ...blocked };
  report.summary = recomputeCostSummary(report.samples);
  assert.throws(() => validateCostReport(report, { requireFormal: false }), /incomplete sample/);
  assert.equal(finalizeCostChild(unit, row, { code: null, signal: 'SIGKILL', stderr: '' }).status, 'failed');
  assert.equal(finalizeCostChild(unit, row, { code: 0, signal: null, stderr: '' }).status, 'failed');
});

test('fresh-process smoke preserves raw evidence, source hashes and isolated configurations', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-cost-test-'));
  const out = path.join(directory, 'report.json');
  try {
    const report = await runCostStudy({ out, repetitions: 1 });
    assert.equal(report.samples.length, 11);
    assert.equal(new Set(report.samples.map(row => row.pid)).size, 11);
    assert.equal((await validateCostFiles(out, { checkSource: true, requireFormal: false })).sourceChecked, true);
    await assert.rejects(validateCostFiles(out), /30 repetitions/);
    await assert.rejects(runCostStudy({ out, repetitions: 1 }), /refusing to overwrite/);
    const rawPath = path.join(directory, report.rawFile), raw = await readFile(rawPath, 'utf8');
    await writeFile(rawPath, raw.replace('"status":"completed"', '"status":"failed"'));
    await assert.rejects(validateCostFiles(out, { requireFormal: false }), /raw evidence hash mismatch/);
    const altered = JSON.parse(await readFile(out, 'utf8'));
    altered.rawSha256 = createHash('sha256').update(await readFile(rawPath)).digest('hex');
    await writeFile(out, JSON.stringify(altered));
    await assert.rejects(validateCostFiles(out, { requireFormal: false }), /report rows differ/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('child timeouts retain failed observations and cannot pass as completed measurement', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-cost-failure-test-'));
  const out = path.join(directory, 'failure.json');
  try {
    await assert.rejects(runCostStudy({ out, repetitions: 1, timeoutMs: 1 }), /raw evidence saved/);
    const report = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.samples.length, 11);
    assert.ok(report.samples.every(row => row.status === 'failed' && row.error));
    assert.equal((await readFile(path.join(directory, report.rawFile), 'utf8')).trimEnd().split('\n').length, 11);
    assert.throws(() => validateCostReport(report, { requireFormal: false }), /failed or incomplete/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
