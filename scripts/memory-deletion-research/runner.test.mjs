import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, parseArgs, runCase, quantile, run, persistReport } from './runner.mjs';
import { fixture, close, oracle, query, snapshot } from './fixture.mjs';
import { REQUIRED_SOURCE_FILES, validateReport, validateCsv, validateSourceHashes, parseCsv } from './validate-report.mjs';

test('protocol freezes twenty unique schedules and rejects invalid sample counts', () => {
  assert.equal(manifest().length, 20);
  assert.equal(new Set(manifest().map(c => c.id)).size, 20);
  for (const n of ['0', '-1', '2.5', 'NaN', '101']) assert.throws(() => parseArgs([`--repetitions=${n}`]));
  assert.throws(() => parseArgs(['--unknown']));
  assert.equal(parseArgs(['--repetitions=3']).repetitions, 3);
  assert.equal(parseArgs(['--overwrite']).overwrite, true);
  assert.equal(quantile([1, 2, 3, 4], .5), 2.5);
});

test('oracle refuses a missing target tombstone instead of passing an empty filter', async () => {
  const f = await fixture();
  try {
    await f.store.clean('target');
    await query(f.client, 'PRAGMA foreign_keys=OFF');
    await query(f.client, "DELETE FROM memory_records WHERE id='target'");
    const result = await oracle(f);
    assert.equal(result.clean, false);
    assert.equal(result.residue.record, 1);
    assert.equal(result.keepIntact, true);
  } finally { await close(f); }
});

test('independent oracle catches residual corruption in every logical store after valid verification', async () => {
  const mutations = {
    record: "UPDATE memory_records SET keywords_json='[\"private residual\"]' WHERE id='target'",
    revisions: "UPDATE memory_revisions SET content='private residual' WHERE id='rev_target'",
    evidence: "UPDATE memory_evidence SET source_range='private residual' WHERE id='ev_target'",
    fts: "INSERT INTO memories_fts(id,content) VALUES('target','private residual')",
    vector: "INSERT INTO memory_embeddings(id,memory_id,dimension,model_id,embedding_json,created_at,updated_at) VALUES('residual','target',2,'residual','[1,0]','2026-10-15','2026-10-15')",
    summary: "UPDATE memory_compaction_markers SET summary_text='private residual' WHERE memory_id='target'",
    audit: "UPDATE memory_events SET reason='private residual' WHERE memory_id='target'",
    outbox: "UPDATE outbox_events SET payload=json_set(payload,'$.extraContent','private residual') WHERE id='outbox_target_seed'",
  };
  for (const [store, sql] of Object.entries(mutations)) {
    const f = await fixture();
    try {
      await f.store.clean('target'); await f.store.verify('target');
      assert.equal((await oracle(f)).clean, true, store);
      await query(f.client, sql);
      const result = await oracle(f);
      assert.equal(result.clean, false, store);
      assert.equal(result.residue[store], 1, store);
      assert.equal(result.keepIntact, true, store);
    } finally { await close(f); }
  }
});

test('oracle follows all target and keep revisions instead of a seed revision naming convention', async () => {
  const f = await fixture();
  try {
    await f.store.clean('target'); await f.store.verify('target');
    for (const id of ['target', 'keep']) {
      await query(f.client, 'INSERT INTO memory_revisions(id,memory_id,content,created_at) VALUES(?,?,?,?)', [`other_revision_${id}`, id, '', '2026-10-15']);
      await query(f.client, 'INSERT INTO memory_evidence(id,memory_revision_id,source_artifact_id,source_revision_id,source_range,created_at) VALUES(?,?,?,?,?,?)', [`other_evidence_${id}`, `other_revision_${id}`, `artifact_${id}`, `source_${id}`, 'private residual', '2026-10-15']);
    }
    f.keepBefore = await snapshot(f, 'keep');
    assert.equal((await oracle(f)).residue.evidence, 1);
    await query(f.client, "UPDATE memory_evidence SET source_range='changed' WHERE id='other_evidence_keep'");
    assert.equal((await oracle(f)).keepIntact, false);
  } finally { await close(f); }
});

test('oracle rejects unsanitized target links and active derivative tombstones', async () => {
  const mutations = [
    ["UPDATE memory_records SET source_turn_id='private-turn' WHERE id='target'", 'record'],
    ["UPDATE memory_compaction_markers SET status='active' WHERE memory_id='target'", 'summary'],
    ["UPDATE outbox_events SET status='pending' WHERE id='outbox_target_seed'", 'outbox'],
  ];
  for (const [sql, store] of mutations) {
    const f = await fixture();
    try {
      await f.store.clean('target');
      await query(f.client, sql);
      const result = await oracle(f);
      assert.equal(result.clean, false, store);
      assert.equal(result.residue[store], 1, store);
    } finally { await close(f); }
  }
});

test('oracle retains known Outbox ownership when a malformed payload loses its memoryId', async () => {
  for (const payload of ['{"deleted":true,"extraContent":"private residual"}', 'null', '{malformed',
    '{"memoryId":"target","deleted":true,"snapshotId":{"content":"private residual"}}']) {
    const f = await fixture();
    try {
      await f.store.clean('target');
      await query(f.client, "UPDATE outbox_events SET payload=? WHERE id='outbox_target_seed'", [payload]);
      const result = await oracle(f);
      assert.equal(result.clean, false, payload);
      assert.equal(result.residue.outbox, 1, payload);
      assert.equal(result.keepIntact, true, payload);
    } finally { await close(f); }
  }
});

test('the same late payload distinguishes cleanup from guarded cleanup', async () => {
  const spec = manifest().find(c => c.id === 'summary:after-complete');
  const unsafe = await runCase(spec, 'cleanup-only');
  const safe = await runCase(spec, 'verified-guarded');
  assert.equal(unsafe.error, null); assert.equal(safe.error, null);
  assert.equal(unsafe.resurrection, true);
  assert.equal(safe.safeCompletion, true);
  assert.equal(safe.writerRejected, true);
});

test('verification refuses completion on each omitted cleanup channel', async () => {
  for (const spec of manifest().filter(c => c.omission)) {
    const row = await runCase(spec, 'verified-guarded');
    assert.equal(row.error, null, spec.id);
    assert.equal(row.completed, false, spec.id);
    assert.equal(row.verificationBlocked, true, spec.id);
    assert.equal(row.final.clean, false, spec.id);
    assert.equal(row.final.keepIntact, true, spec.id);
  }
});

test('CSV parser preserves quotes and embedded newlines and rejects malformed cells', () => {
  assert.deepEqual(parseCsv('name,value\r\n"a,""b","line1\nline2"\r\n'), [['name', 'value'], ['a,"b', 'line1\nline2']]);
  for (const invalid of ['"unterminated', '"closed"trailing', 'unquoted"quote']) assert.throws(() => parseCsv(invalid));
});

test('an unexpected observation fails validation but preserves raw JSON and CSV without overwriting evidence', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'aervox-deletion-failed-report-'));
  try {
    const report = JSON.parse(await readFile(new URL('../../docs/explanation/memory-deletion-study/results/report.json', import.meta.url), 'utf8'));
    const failure = 'Error: observer failed with "unexpected" response\nretain this evidence';
    report.cases[0].error = failure;
    await assert.rejects(persistReport(report, { out }), /experiment error.*raw evidence preserved/s);
    const json = await readFile(path.join(out, 'report.json'), 'utf8');
    const csv = await readFile(path.join(out, 'cases.csv'), 'utf8');
    assert.equal(JSON.parse(json).cases[0].error, failure);
    assert.equal(validateCsv(JSON.parse(json), csv), 80);
    await assert.rejects(persistReport(report, { out }), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(out, 'report.json'), 'utf8'), json);
    assert.equal(await readFile(path.join(out, 'cases.csv'), 'utf8'), csv);
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('complete run validates every schedule, sink and crash; stale aggregates and overwritten evidence fail', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'aervox-deletion-report-test-'));
  try {
    const report = await run({ out, repetitions: 1 });
    assert.equal(validateReport(report).correctnessCases, 80);
    assert.equal(validateReport(report).timingSamples, 4);
    const csv = await readFile(path.join(out, 'cases.csv'), 'utf8');
    assert.equal(validateCsv(report, csv), 80);
    await validateSourceHashes(report, fileURLToPath(new URL('../../', import.meta.url)));
    const mutate = fn => { const copy = structuredClone(report); fn(copy); assert.throws(() => validateReport(copy)); };
    mutate(r => { r.cases[1] = r.cases[0]; });
    mutate(r => { r.summary[0].falseCompletions--; });
    mutate(r => { r.latency[0].totalMs++; });
    mutate(r => { r.latency.find(row => row.arm === 'verified-guarded').completed = false; });
    mutate(r => { r.latency[0].final.keepIntact = false; });
    mutate(r => { r.latency[0].caseId = 'summary:after-complete'; });
    mutate(r => { r.errorSinks[1].after.keepIntact = false; });
    mutate(r => { r.crashes[0].reopened.keepIntact = false; });
    mutate(r => { r.cases.find(c => c.arm === 'verified-guarded' && c.omission).completed = true; });
    mutate(r => { delete r.hashes[REQUIRED_SOURCE_FILES[0]]; });
    mutate(r => { r.hashes['../outside'] = '0'.repeat(64); });
    assert.throws(() => validateCsv(report, csv.replace('"fts:before-clean"', '"changed-case"')));
    await assert.rejects(run({ out, repetitions: 1 }), /refusing to overwrite/);
    const drift = structuredClone(report), file = REQUIRED_SOURCE_FILES[0];
    drift.sourceConsistency.afterHashes[file] = '0'.repeat(64);
    drift.sourceConsistency.changedFiles = [file];
    const driftOut = path.join(out, 'source-drift');
    await assert.rejects(persistReport(drift, { out: driftOut }), /source changed during experiment.*raw evidence preserved/s);
    assert.deepEqual(JSON.parse(await readFile(path.join(driftOut, 'report.json'), 'utf8')).sourceConsistency, drift.sourceConsistency);
    assert.equal(validateCsv(drift, await readFile(path.join(driftOut, 'cases.csv'), 'utf8')), 80);
  } finally { await rm(out, { recursive: true, force: true }); }
});
