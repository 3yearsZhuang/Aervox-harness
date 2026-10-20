import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { runSchedule, validateObservation } from './engine.mjs';

const event = (changes = {}) => ({ site: 'worker:read', actor: 'producer', operation: 'fetch', kind: 'read', phase: 'after', entity: 'target', ...changes });
const plan = (changes = {}) => ({ id: 'test-plan', strategy: 'generic', action: 'delete', trigger: { site: 'worker:read', actor: 'producer', phase: 'after', occurrence: 1, ...changes } });

function fixture(overrides = {}) {
  const calls = { opens: 0, closes: 0, removes: 0, seeds: [] };
  return {
    id: 'test-adapter', checkedStores: ['source', 'derived'], calls,
    async open(seed, { signal }) {
      calls.opens++; calls.seeds.push(seed);
      return { source: 1, derived: 1, keep: { content: 'retained', nested: [1, 2] }, signal };
    },
    async produce(_state, checkpoint) { await checkpoint(event()); },
    async remove(state) { calls.removes++; state.source = 0; state.derived = 0; },
    async observe(state) { return { residue: { source: state.source, derived: state.derived }, keepSnapshot: state.keep }; },
    async close() { calls.closes++; },
    ...overrides,
  };
}

test('observation requires every declared store and an actual JSON keep snapshot', () => {
  const valid = { residue: { a: 0 }, keepSnapshot: null };
  assert.equal(validateObservation(['a'], valid), valid);
  for (const observation of [null, {}, { residue: { a: 0 } }, { residue: {}, keepSnapshot: {} },
    { residue: { a: -1 }, keepSnapshot: {} }, { residue: { a: .5 }, keepSnapshot: {} },
    { residue: { a: 0 }, keepSnapshot: undefined }, { residue: { a: 0 }, keepSnapshot: { key: NaN } },
    { residue: { a: 0 }, keepSnapshot: new Map() }, { residue: { a: 0 }, keepSnapshot: [, 1] }]) {
    assert.throws(() => validateObservation(['a'], observation));
  }
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateObservation(['a'], { residue: { a: 0 }, keepSnapshot: cyclic }));
  for (const stores of [[], [''], ['a', 'a'], 'a']) assert.throws(() => validateObservation(stores, valid));
});

test('learning run records events then deletes once on a fresh seeded fixture', async () => {
  const adapter = fixture();
  const first = await runSchedule(adapter, { seed: 2 });
  const second = await runSchedule(adapter, { seed: 3 });
  for (const evidence of [first, second]) {
    assert.equal(evidence.status, 'completed');
    assert.deepEqual(evidence.violations, []);
    assert.deepEqual(evidence.final.residue, { source: 0, derived: 0 });
    assert.equal(evidence.trace[0].occurrence, 1);
    assert.equal(evidence.triggerReached, true);
    assert.equal(evidence.error, null);
  }
  assert.deepEqual(adapter.calls, { opens: 2, closes: 2, removes: 2, seeds: [2, 3] });
});

test('selected checkpoint is removed before producer resumes, exposing resurrection', async () => {
  let deleted = false;
  const adapter = fixture({
    async produce(state, checkpoint) {
      await checkpoint(event());
      assert.equal(deleted, true);
      state.derived = 1;
    },
    async remove(state) { deleted = true; state.source = 0; state.derived = 0; },
  });
  const evidence = await runSchedule(adapter, { plan: plan() });
  assert.equal(evidence.status, 'completed');
  assert.deepEqual(evidence.atCompletion.residue, { source: 0, derived: 0 });
  assert.deepEqual(evidence.violations, ['resurrection']);
});

test('false completion, distinct store resurrection and keep damage can coexist', async () => {
  const adapter = fixture({
    async remove(state) { state.derived = 0; state.keep.nested[0] = 9; },
    async produce(state, checkpoint) { await checkpoint(event()); state.derived = 2; },
  });
  const evidence = await runSchedule(adapter, { plan: plan() });
  assert.equal(evidence.status, 'completed');
  assert.deepEqual(evidence.violations, ['false-completion', 'resurrection', 'retained-data-changed']);
  assert.deepEqual(evidence.keepBefore, { content: 'retained', nested: [1, 2] });
});

test('retained damage observed at completion remains a violation after producer restores it', async () => {
  const adapter = fixture({
    async remove(state) { state.source = 0; state.derived = 0; state.keep.content = 'changed'; },
    async produce(state, checkpoint) { await checkpoint(event()); state.keep.content = 'retained'; },
  });
  const evidence = await runSchedule(adapter, { plan: plan() });
  assert.deepEqual(evidence.violations, ['retained-data-changed']);
  assert.equal(evidence.atCompletion.keepSnapshot.content, 'changed');
  assert.equal(evidence.final.keepSnapshot.content, 'retained');
});

test('snapshot equality is independent of object property insertion order', async () => {
  let observes = 0;
  const adapter = fixture({ async observe(state) {
    return { residue: { source: state.source, derived: state.derived },
      keepSnapshot: ++observes % 2 ? { a: 1, b: [2] } : { b: [2], a: 1 } };
  } });
  assert.deepEqual((await runSchedule(adapter)).violations, []);
});

test('unreached plans are ineligible and do not perform a substitute deletion', async () => {
  const adapter = fixture();
  const evidence = await runSchedule(adapter, { plan: plan({ occurrence: 2 }) });
  assert.equal(evidence.status, 'ineligible');
  assert.equal(evidence.triggerReached, false);
  assert.equal(evidence.atCompletion, null);
  assert.deepEqual(evidence.final.residue, { source: 1, derived: 1 });
  assert.deepEqual(evidence.violations, []);
  assert.equal(adapter.calls.removes, 0);
  assert.equal(adapter.calls.closes, 1);
});

test('occurrences count actor, site and phase independently and deletion happens once', async () => {
  let observedCount;
  const adapter = fixture({
    async produce(_state, checkpoint) {
      await checkpoint(event({ phase: 'before' }));
      await checkpoint(event());
      await checkpoint(event({ site: 'other' }));
      await checkpoint(event());
      await checkpoint(event());
    },
    async remove(state) { adapter.calls.removes++; observedCount = state; state.source = 0; state.derived = 0; },
  });
  const evidence = await runSchedule(adapter, { plan: plan({ occurrence: 2 }) });
  assert.ok(observedCount);
  assert.equal(adapter.calls.removes, 1);
  assert.deepEqual(evidence.trace.map(row => row.occurrence), [1, 1, 1, 2, 3]);
});

test('concurrent checkpoints wait for the one selected deletion barrier', async () => {
  let resumed = 0, deleting = false;
  const adapter = fixture({
    async produce(_state, checkpoint) {
      await Promise.all([event(), event({ site: 'other' })].map(async input => {
        await checkpoint(input);
        assert.equal(deleting, false);
        resumed++;
      }));
    },
    async remove(state) {
      adapter.calls.removes++; deleting = true;
      await Promise.resolve();
      assert.equal(resumed, 0);
      state.source = 0; state.derived = 0; deleting = false;
    },
  });
  const evidence = await runSchedule(adapter, { plan: plan() });
  assert.equal(evidence.status, 'completed');
  assert.equal(resumed, 2);
  assert.equal(adapter.calls.removes, 1);
});

test('unexpected producer, removal and observation errors are infrastructure failures', async () => {
  const adapters = [
    fixture({ async produce() { throw new Error('producer failed'); } }),
    fixture({ async remove() { throw new Error('deletion failed'); } }),
    fixture({ async observe() { return { residue: { source: 0 }, keepSnapshot: {} }; } }),
    fixture({ async produce(_state, checkpoint) { await checkpoint(event({ contents: 'forbidden body' })); } }),
  ];
  for (const adapter of adapters) {
    const evidence = await runSchedule(adapter);
    assert.equal(evidence.status, 'infrastructure-error');
    assert.deepEqual(evidence.violations, []);
    assert.equal(typeof evidence.error, 'string');
    assert.equal(adapter.calls.closes, 1);
    assert.equal(JSON.stringify(evidence.trace).includes('forbidden body'), false);
  }
});

test('timeout aborts cooperating adapter, closes it, and never reports safety', async () => {
  let receivedSignal;
  const adapter = fixture({
    async produce(state) {
      receivedSignal = state.signal;
      await new Promise((_, reject) => state.signal.addEventListener('abort', () => reject(state.signal.reason), { once: true }));
    },
  });
  const evidence = await runSchedule(adapter, { timeoutMs: 20 });
  assert.equal(evidence.status, 'infrastructure-error');
  assert.match(evidence.error, /TimeoutError: schedule timeout/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(adapter.calls.closes, 1);
  assert.deepEqual(evidence.violations, []);
});

test('noncooperating workload and close waits are bounded', async () => {
  const adapter = fixture({ async produce() { await new Promise(() => {}); }, async close() { await new Promise(() => {}); } });
  const started = performance.now();
  const evidence = await runSchedule(adapter, { timeoutMs: 20 });
  assert.equal(evidence.status, 'infrastructure-error');
  assert.match(evidence.error, /schedule timeout.*close timeout/);
  assert.ok(performance.now() - started < 1_000);
});

test('cleanup can exceed the workload deadline within its independent budget', async () => {
  let closed = false;
  const adapter = fixture({ async close() {
    await new Promise(resolve => setTimeout(resolve, 50));
    closed = true;
  } });
  const evidence = await runSchedule(adapter, { timeoutMs: 20, cleanupTimeoutMs: 200 });
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.error, null);
  assert.equal(closed, true);
  assert.ok(evidence.durationMs >= 40);
  assert.equal(evidence.timeoutMs, 20);
  assert.equal(evidence.cleanupTimeoutMs, 200);
});

test('an unfinished close respects the explicit independent cleanup deadline', { timeout: 1_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closeStarted = Promise.withResolvers();
  const adapter = fixture({ async close() {
    closeStarted.resolve();
    await new Promise(() => {});
  } });
  let settled = false;
  const schedule = runSchedule(adapter, { timeoutMs: 100, cleanupTimeoutMs: 20 }).then(evidence => {
    settled = true;
    return evidence;
  });
  await closeStarted.promise;
  t.mock.timers.tick(19);
  // Drain promise continuations so an early return cannot hide behind a pending microtask.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup must still be pending before its deadline');
  t.mock.timers.tick(1);
  const evidence = await schedule;
  assert.equal(evidence.status, 'infrastructure-error');
  assert.equal(evidence.error, 'Error: adapter close timeout');
  assert.equal(evidence.cleanupTimeoutMs, 20);
});

test('cleanup defaults to the workload budget without an implicit short cap', async () => {
  const evidence = await runSchedule(fixture(), { timeoutMs: 2_000 });
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.cleanupTimeoutMs, 2_000);
});

test('late open completion receives cleanup and cannot mutate returned evidence', async () => {
  let resolveOpen;
  const adapter = fixture({ async open() { return new Promise(resolve => { resolveOpen = resolve; }); } });
  const evidence = await runSchedule(adapter, { timeoutMs: 10 });
  const saved = JSON.stringify(evidence);
  resolveOpen({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.calls.closes, 1);
  assert.equal(JSON.stringify(evidence), saved);
  assert.equal(evidence.status, 'infrastructure-error');
});

test('close errors invalidate a successful run, preserving raw observations', async () => {
  const evidence = await runSchedule(fixture({ async close() { throw new Error('close failed'); } }));
  assert.equal(evidence.status, 'infrastructure-error');
  assert.match(evidence.error, /close failed/);
  assert.deepEqual(evidence.final.residue, { source: 0, derived: 0 });
});

test('invalid configuration is classified without opening an adapter', async () => {
  const adapter = fixture();
  for (const options of [{ timeoutMs: 0 }, { cleanupTimeoutMs: 0 }, { cleanupTimeoutMs: -1 }, { cleanupTimeoutMs: .5 },
    { cleanupTimeoutMs: NaN }, { cleanupTimeoutMs: Infinity }, { cleanupTimeoutMs: '100' }, { seed: .5 }, { plan: { ...plan(), action: 'crash' } }]) {
    const evidence = await runSchedule(adapter, options);
    assert.equal(evidence.status, 'infrastructure-error');
  }
  assert.equal(adapter.calls.opens, 0);
});
