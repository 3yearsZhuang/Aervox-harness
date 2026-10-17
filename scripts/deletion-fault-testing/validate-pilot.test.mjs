import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPilot } from './pilot.mjs';
import { validatePilot, validatePilotDirectory, verifyPilotSources } from './validate-pilot.mjs';
import { discoverCandidates } from './discovery.mjs';
import { PRODUCTION_DESCRIPTORS, assertProductionDescriptor, loadProductionSubjects, resolveDiscoveryFiles, REPOSITORY_ROOT } from './subjects.mjs';

// Standalone mocks keep importing this test free of real external fixtures.
const ids = ['aervox-guarded', 'aervox-historical-provenance', 'langchain-libsql', 'llamaindex-simple'];
async function evidence(directory) {
  await writeFile(path.join(directory, 'input.js'), 'function save() { store.run(); }\n');
  const adapter = id => ({
    id, checkedStores: ['rows'], async open() { return { rows: 1 }; },
    async produce(state, checkpoint) {
      await checkpoint({ site: 'read', actor: 'producer', operation: 'fetch', kind: 'read', phase: 'after', entity: 'target' });
      await checkpoint({ site: 'write', actor: 'producer', operation: 'save', kind: 'write', phase: 'before', entity: 'target' });
      if (id !== 'aervox-guarded') state.rows++;
    },
    async remove(state) { state.rows = 0; },
    async observe(state) { return { residue: { rows: state.rows }, keepSnapshot: ['kept'] }; }, async close() {},
  });
  const out = path.join(directory, 'result');
  const report = await runPilot({ out, budgets: [1], seeds: [1], replayRepetitions: 2 }, {
    root: directory, sourceFiles: ['input.js'],
    async loadSubjects() { return { subjects: ids.map(id => ({ adapter: adapter(id), metadata: { project: id, evidenceClass: 'mock', rootCause: 'mock', discoveryFiles: ['input'] } })), audit: adapter('llamaindex-simple-index-api-only') }; },
    async discover() { return discoverCandidates({ root: directory, files: ['input.js'] }); },
  });
  const rows = (await readFile(path.join(out, 'raw.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { report, rows, out };
}

test('validator rejects missing evidence, changed plans, invented labels and forged summaries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deletion-validation-'));
  try {
    const { report, rows } = await evidence(directory);
    const validate = (copyReport = report, copyRows = rows) => validatePilot(copyReport, copyRows, { allowTestFixture: true });
    validate();
    assert.throws(() => validate(report, []), /empty/);
    for (const mutate of [
      r => { r.subjects.pop(); },
      r => { r.config.strategies.pop(); },
      r => { r.protocol.minimumSuccessfulReplays = 0; },
      r => { r.config.timeoutMs = 1; },
      r => { r.config.cleanupTimeoutMs = 1; },
      r => { r.sourceManifest.after['input.js'] = 'a'.repeat(64); },
      r => { r.summary.groups[0].safeCompleted++; },
      r => { r.go.decision = 'GO'; },
      r => { r.rawRows++; },
    ]) {
      const copy = structuredClone(report); mutate(copy); assert.throws(() => validate(copy));
    }
    for (const mutate of [
      r => { r.find(row => row.type === 'schedule').plan.trigger.occurrence++; },
      r => { r.find(row => row.type === 'schedule').run.violations = ['resurrection']; },
      r => { r.find(row => row.type === 'schedule').subject = 'unexpected-project'; },
      r => { r.find(row => row.type === 'replay').plan.id = 'wrong-plan'; },
      r => { r.find(row => row.type === 'reference').run.trace[0].occurrence = 3; },
      r => { r.find(row => row.type === 'schedule').run.trace = []; },
      r => { r.find(row => row.type === 'schedule').run.trace[0].site = 'unrelated-site'; },
      r => { r.find(row => row.type === 'reference').run.seed = 9; },
      r => { r.find(row => row.type === 'audit').run.seed = 9; },
      r => { r.find(row => row.type === 'replay').run.seed = 9; },
      r => { r.find(row => row.type === 'schedule').run.seed = 9; },
      r => { r.find(row => row.type === 'schedule').run.cleanupTimeoutMs = 1; },
      r => { r.find(row => row.type === 'reference').run.cleanupTimeoutMs = 1; },
      r => { r.find(row => row.type === 'audit').run.cleanupTimeoutMs = 1; },
      r => { r.find(row => row.type === 'replay').run.cleanupTimeoutMs = 1; },
    ]) {
      const copy = structuredClone(rows); mutate(copy); assert.throws(() => validate(report, copy));
    }
    for (const type of ['reference', 'allocation', 'schedule', 'replay', 'audit']) {
      const copy = structuredClone(rows); copy.splice(copy.findIndex(row => row.type === type), 1);
      const copyReport = structuredClone(report); copyReport.rawRows = copy.length;
      assert.throws(() => validate(copyReport, copy), type);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('directory validation checks raw presence, truncation and optionally current input hashes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deletion-validation-files-'));
  try {
    const { out } = await evidence(directory);
    await writeFile(path.join(directory, 'input.js'), 'changed');
    await assert.rejects(validatePilotDirectory(out, { allowTestFixture: true, verifySources: true }), /current source changed/);
    await validatePilotDirectory(out, { allowTestFixture: true });
    await writeFile(path.join(out, 'raw.jsonl'), '{"type":"reference"}');
    await assert.rejects(validatePilotDirectory(out, { allowTestFixture: true }), /newline-terminated/);
    await rm(path.join(out, 'raw.jsonl'));
    await assert.rejects(validatePilotDirectory(out, { allowTestFixture: true }), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('candidate metadata is bound to declared files, hashes, identities and locations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deletion-candidate-validation-'));
  try {
    const { report, rows } = await evidence(directory);
    for (const mutate of [
      candidate => { candidate.file = 'not-discovered.ts'; },
      candidate => { candidate.sourceSha256 = 'a'.repeat(64); },
      candidate => { candidate.id = 'invented'; },
      candidate => { candidate.line = -1; },
      candidate => { candidate.column = 0; },
      candidate => { candidate.classification = 'confirmed-write'; },
    ]) {
      const copy = structuredClone(report); mutate(copy.subjects[0].discovery.candidates[0]);
      assert.throws(() => validatePilot(copy, rows, { allowTestFixture: true }));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production descriptors reject fixture promotion, invented stores and changed contracts', () => {
  for (const [id, expected] of Object.entries(PRODUCTION_DESCRIPTORS)) {
    const subject = { id, ...structuredClone(expected) };
    assertProductionDescriptor(subject);
    assert.throws(() => assertProductionDescriptor({ ...subject, checkedStores: ['inventedRows'] }));
    for (const key of ['project', 'evidenceClass', 'rootCause', 'discoveryFiles']) {
      assert.throws(() => assertProductionDescriptor({ ...subject, metadata: { ...subject.metadata, [key]: 'invented' } }));
    }
    if ('publicApiIntegration' in expected.metadata) {
      assert.throws(() => assertProductionDescriptor({ ...subject, metadata: { ...subject.metadata, publicApiIntegration: false } }));
    }
  }
});

test('source verification reloads actual descriptors and rescans candidates in the current checkout', async () => {
  // Read-only integration check: createAdapter loads APIs, but open/produce/remove
  // are never called. This cannot count as an experiment or a real-system run.
  const loaded = await loadProductionSubjects();
  const subjects = [];
  for (const actual of loaded.subjects) {
    const files = await resolveDiscoveryFiles(REPOSITORY_ROOT, actual.metadata);
    subjects.push({ id: actual.adapter.id, metadata: actual.metadata, checkedStores: actual.adapter.checkedStores,
      discovery: await discoverCandidates({ root: REPOSITORY_ROOT, files, allowDependencies: true }) });
  }
  const report = { kind: 'feasibility-pilot', subjects, sourceManifest: {
    root: '/unavailable/original/machine/checkout', files: ['package.json'],
    before: { 'package.json': createHash('sha256').update(await readFile(path.join(REPOSITORY_ROOT, 'package.json'))).digest('hex') },
  } };
  await verifyPilotSources(report);
  for (const mutate of [
    copy => { copy.subjects[2].discovery.candidates[0].line++; },
    copy => { copy.subjects[3].discovery.files = copy.subjects[3].discovery.files.slice(1); },
    copy => { copy.subjects[2].metadata.version = 'invented version'; },
    copy => { copy.subjects[0].checkedStores = ['inventedRows']; },
  ]) {
    const copy = structuredClone(report); mutate(copy);
    await assert.rejects(verifyPilotSources(copy), /differ/);
  }
});
