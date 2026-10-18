import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverCandidates } from '../../scripts/deletion-fault-testing/discovery.mjs';
import { runSchedule } from '../../scripts/deletion-fault-testing/engine.mjs';
import { generatePlans } from '../../scripts/deletion-fault-testing/planner.mjs';
import { createAdapter as createAervox, metadata as aervoxMetadata } from '../../scripts/deletion-fault-testing/adapters/aervox.mjs';
import { createAdapter as createLangChain, metadata as langchainMetadata } from './langchain.mjs';
import { createAdapter as createLlamaIndex, metadata as llamaindexMetadata } from './llamaindex.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// These are integration/oracle validation runs, not protocol seeds, strategy
// rankings, replay evidence, or formal pilot results. No planner rules are tuned.
const TEST_SEED = 9_001;

function assertCompleted(evidence) {
  assert.equal(evidence.status, 'completed', evidence.error ?? JSON.stringify(evidence.plan));
  assert.equal(evidence.error, null);
  assert.equal(evidence.triggerReached, true);
}

function assertClean(adapter, observation) {
  assert.ok(observation);
  assert.deepEqual(Object.keys(observation.residue).sort(), [...adapter.checkedStores].sort());
  for (const store of adapter.checkedStores) assert.equal(observation.residue[store], 0, store);
}

async function actualSourceFiles(metadata) {
  return Promise.all(metadata.discoveryFiles.map(async (specifier) => {
    const absolute = specifier.startsWith('packages/')
      ? path.join(root, specifier)
      : fileURLToPath(import.meta.resolve(specifier));
    return path.relative(root, await realpath(absolute)).split(path.sep).join('/');
  }));
}

const subjects = [
  { label: 'guarded production Aervox', create: () => createAervox(), metadata: aervoxMetadata, safe: true },
  { label: 'historical Aervox reconstruction', create: () => createAervox({ historical: true }), metadata: aervoxMetadata, safe: false },
  { label: 'real LangChain LibSQL integration', create: createLangChain, metadata: langchainMetadata, safe: false },
  { label: 'real LlamaIndex composed deletion integration', create: createLlamaIndex, metadata: llamaindexMetadata, safe: false },
];

test('real adapters connect sequential references, actual source discovery and guided schedules', { timeout: 120_000 }, async (t) => {
  for (const [index, subject] of subjects.entries()) {
    await t.test(subject.label, async () => {
      const adapter = await subject.create();
      const seed = TEST_SEED + index;
      const reference = await runSchedule(adapter, { seed });
      assertCompleted(reference);
      assert.deepEqual(reference.violations, []);
      assertClean(adapter, reference.atCompletion);
      assertClean(adapter, reference.final);
      assert.deepEqual(reference.atCompletion.keepSnapshot, reference.keepBefore);
      assert.deepEqual(reference.final.keepSnapshot, reference.keepBefore);

      const files = await actualSourceFiles(subject.metadata);
      const discovery = await discoverCandidates({ root, files, allowDependencies: true });
      assert.equal(discovery.files.length, files.length);
      assert.ok(discovery.candidates.some(candidate => candidate.kind === 'write'));
      assert.ok(discovery.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
      const plans = generatePlans(reference.trace, {
        strategy: 'guided', budget: 64, seed, candidates: discovery.candidates,
      });
      assert.ok(plans.length > 0, 'actual source candidates must support observed writes');
      const evidence = [];
      for (const plan of plans) {
        const result = await runSchedule(adapter, { plan, seed });
        assertCompleted(result);
        assertClean(adapter, result.atCompletion);
        assert.deepEqual(result.atCompletion.keepSnapshot, result.keepBefore);
        assert.deepEqual(result.final.keepSnapshot, result.keepBefore);
        assert.ok(!result.violations.includes('retained-data-changed'));
        evidence.push(result);
      }
      if (subject.safe) {
        for (const result of evidence) {
          assert.deepEqual(result.violations, []);
          assertClean(adapter, result.final);
        }
      } else {
        assert.ok(evidence.some(result => result.violations.includes('resurrection')),
          'a generated schedule must expose the declared application-contract counterexample');
        assert.ok(evidence.some(result => adapter.checkedStores.some(store =>
          result.atCompletion.residue[store] === 0 && result.final.residue[store] > 0)),
        'counterexample must follow actual declared-store observations');
      }
    });
  }
});

test('LangChain observer detects target reinsertion in the real vectors table after clean removal', { timeout: 30_000 }, async () => {
  const adapter = await createLangChain();
  const state = await adapter.open(TEST_SEED + 101);
  try {
    const before = await adapter.observe(state);
    assert.ok(before.residue.vectorRows > 0);
    assert.ok(before.keepSnapshot.length > 0);
    await adapter.remove(state);
    const clean = await adapter.observe(state);
    assertClean(adapter, clean);
    assert.deepEqual(clean.keepSnapshot, before.keepSnapshot);

    const { Document } = await import('@langchain/core/documents');
    await state.store.addVectors([[1, 0, 0]], [new Document({
      pageContent: 'oracle positive control target', metadata: { owner: state.owner },
    })]);
    const stored = await state.db.execute({
      sql: "SELECT COUNT(*) AS count FROM vectors WHERE json_extract(metadata, '$.owner') = ?",
      args: [state.owner],
    });
    assert.equal(Number(stored.rows[0].count), 1);
    const contaminated = await adapter.observe(state);
    assert.equal(contaminated.residue.vectorRows, 1);
    assert.deepEqual(contaminated.keepSnapshot, before.keepSnapshot);
  } finally { await adapter.close(state); }
});

test('LlamaIndex observer reloads and detects real docstore target reinsertion after clean removal', { timeout: 30_000 }, async () => {
  const adapter = await createLlamaIndex();
  const state = await adapter.open(TEST_SEED + 102);
  try {
    const before = await adapter.observe(state);
    assert.ok(before.residue.documents > 0);
    await adapter.remove(state);
    const clean = await adapter.observe(state);
    assertClean(adapter, clean);
    assert.deepEqual(clean.keepSnapshot, before.keepSnapshot);

    await state.storage.docStore.addDocuments([
      state.makeNode(state.derivedNodeId, state.owner, 'oracle positive control target'),
    ], true);
    const contaminated = await adapter.observe(state);
    assert.ok(contaminated.residue.documents > 0);
    assert.equal(contaminated.residue.vectors, 0);
    assert.equal(contaminated.residue.indexNodes, 0);
    assert.deepEqual(contaminated.keepSnapshot, before.keepSnapshot);
  } finally { await adapter.close(state); }
});

test('engine detects actual retained-row corruption through the LangChain observer', { timeout: 30_000 }, async () => {
  const adapter = await createLangChain();
  let changedRows = 0;
  const corruptingAdapter = {
    ...adapter, id: `${adapter.id}-keep-positive-control`,
    async remove(state) {
      await adapter.remove(state);
      const result = await state.db.execute({
        sql: "UPDATE vectors SET content = ? WHERE json_extract(metadata, '$.owner') = ?",
        args: ['oracle positive control corrupted keep', state.keepOwner],
      });
      changedRows = result.rowsAffected;
    },
  };
  const evidence = await runSchedule(corruptingAdapter, { seed: TEST_SEED + 103 });
  assertCompleted(evidence);
  assert.equal(changedRows, 1);
  assertClean(adapter, evidence.atCompletion);
  assertClean(adapter, evidence.final);
  assert.notDeepEqual(evidence.atCompletion.keepSnapshot, evidence.keepBefore);
  assert.deepEqual(evidence.violations, ['retained-data-changed']);
});

test('engine detects actual persisted keep-document corruption through the LlamaIndex observer', { timeout: 30_000 }, async () => {
  const adapter = await createLlamaIndex();
  const corruptingAdapter = {
    ...adapter, id: `${adapter.id}-keep-positive-control`,
    async remove(state) {
      await adapter.remove(state);
      await state.storage.docStore.addDocuments([
        state.makeNode(state.keepNodeId, state.keepOwner, 'oracle positive control corrupted keep'),
      ], true);
    },
  };
  const evidence = await runSchedule(corruptingAdapter, { seed: TEST_SEED + 104 });
  assertCompleted(evidence);
  assertClean(adapter, evidence.atCompletion);
  assertClean(adapter, evidence.final);
  assert.notDeepEqual(evidence.atCompletion.keepSnapshot, evidence.keepBefore);
  assert.deepEqual(evidence.violations, ['retained-data-changed']);
  assert.ok(JSON.stringify(evidence.final.keepSnapshot).includes('oracle positive control corrupted keep'));
});
