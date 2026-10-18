import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPilot, resolveDiscoveryFiles } from './pilot.mjs';
import { validatePilotDirectory, SUBJECT_IDS } from './validate-pilot.mjs';
import { discoverCandidates } from './discovery.mjs';

export function mockAdapter(id, { fail = false } = {}) {
  let opens = 0;
  return {
    id, checkedStores: ['rows'], get opens() { return opens; },
    async open() { opens++; return { rows: 1 }; },
    async produce(state, checkpoint) {
      await checkpoint({ site: 'read', actor: 'producer', operation: 'select', kind: 'read', phase: 'after', entity: 'target' });
      if (fail) throw new Error('mock adapter failure');
      await checkpoint({ site: 'write', actor: 'producer', operation: 'save', kind: 'write', phase: 'before', entity: 'target' });
      // Guarded subject correctly rejects a late write; other mock subjects are
      // artificial counterexamples, not evidence about the external packages.
      if (id !== 'aervox-guarded' || state.rows > 0) state.rows++;
    },
    async remove(state) { state.rows = 0; },
    async observe(state) { return { residue: { rows: state.rows }, keepSnapshot: { kept: true } }; },
    async close() {},
  };
}

export async function mockRuntime(directory, overrides = {}) {
  await writeFile(path.join(directory, 'input.js'), 'function save() { store.run(); }\n');
  const adapters = SUBJECT_IDS.map(id => mockAdapter(id, { fail: overrides.failSubject === id }));
  return {
    root: directory, sourceFiles: ['input.js'],
    async loadSubjects() {
      return {
        subjects: adapters.map(adapter => ({ adapter, metadata: { project: adapter.id, evidenceClass: 'application-contract', rootCause: 'mock-late-write', publicApiIntegration: false, discoveryFiles: ['mock'] } })),
        audit: mockAdapter('llamaindex-simple-index-api-only'),
      };
    },
    async discover() { return discoverCandidates({ root: directory, files: ['input.js'] }); },
    adapters,
  };
}

test('unit pipeline executes every row fresh, saves raw JSONL and validates explicitly as a fixture', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deletion-pilot-unit-'));
  try {
    const runtime = await mockRuntime(directory);
    const out = path.join(directory, 'evidence');
    const report = await runPilot({ out, budgets: [1, 2], seeds: [1, 2], replayRepetitions: 2 }, runtime);
    assert.equal(report.status, 'complete');
    assert.equal(report.kind, 'unit-fixture');
    assert.equal(report.go.decision, 'NOT ESTABLISHED');
    assert.equal(report.summary.groups.length, 4 * 4 * 2 * 2);
    assert.equal(report.summary.witnesses.filter(witness => witness.plan).length, 3);
    const raw = (await readFile(path.join(out, 'raw.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const adapter of runtime.adapters) {
      assert.equal(adapter.opens, raw.filter(row => row.subject === adapter.id && row.run).length);
    }
    await assert.rejects(validatePilotDirectory(out), /test fixtures/);
    await validatePilotDirectory(out, { allowTestFixture: true, verifySources: true });
    await assert.rejects(runPilot({ out }, runtime), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('runtime failure preserves partial raw and failed report before rejecting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deletion-pilot-failure-'));
  try {
    const runtime = await mockRuntime(directory, { failSubject: 'langchain-libsql' });
    const out = path.join(directory, 'evidence');
    await assert.rejects(runPilot({ out, budgets: [1], seeds: [1], replayRepetitions: 1 }, runtime), /evidence preserved/);
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.ok((await readFile(path.join(out, 'raw.jsonl'), 'utf8')).includes('mock adapter failure'));
    await assert.rejects(validatePilotDirectory(out, { allowTestFixture: true }), /incomplete or failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('discovery resolution never silently skips an unresolved export', async () => {
  await assert.rejects(resolveDiscoveryFiles(process.cwd(), { discoveryFiles: ['@does-not-exist/deletion-research'] }));
  await assert.rejects(resolveDiscoveryFiles(process.cwd(), { discoveryFiles: [] }), /explicit discoveryFiles/);
});
