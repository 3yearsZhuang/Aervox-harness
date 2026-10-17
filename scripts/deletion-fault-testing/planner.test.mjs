import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlans } from './planner.mjs';

const event = (changes = {}) => ({ site: 'read:1', actor: 'producer', operation: 'fetch', kind: 'read', phase: 'after', entity: 'target', occurrence: 1, ...changes });
const write = (changes = {}) => event({ site: 'write:1', operation: 'saveDerived', kind: 'write', phase: 'before', ...changes });
const candidates = [{ kind: 'write', method: 'run', enclosingMethod: 'saveDerived' }];

test('generic selects all producer boundaries, including unknown ownership', () => {
  const trace = [event(), write(), event({ site: 'keep', entity: 'keep' }), event({ site: 'unknown', entity: 'unknown', kind: 'yield' }), event({ actor: 'other' })];
  assert.deepEqual(generatePlans(trace, { strategy: 'generic' }).map(plan => plan.trigger.site), ['read:1', 'write:1', 'keep', 'unknown']);
});

test('trace-only is target read-after and write-before in observed order', () => {
  const trace = [event({ phase: 'before' }), event(), write(), write({ phase: 'after' }), write({ entity: 'keep' }),
    write({ entity: 'unknown' }), event({ kind: 'yield' }), event({ site: 'last-read' })];
  assert.deepEqual(generatePlans(trace, { strategy: 'trace-only' }).map(plan => plan.trigger.site), ['read:1', 'write:1', 'last-read']);
});

test('guided read requires a later target write backed by a static candidate', () => {
  const trace = [event(), write({ entity: 'keep' }), write({ entity: 'unknown' }), write({ operation: 'unrecognized' }),
    write(), event({ site: 'last-read' })];
  assert.deepEqual(generatePlans(trace, { candidates }).map(plan => plan.trigger.site), ['read:1', 'write:1']);
  assert.deepEqual(generatePlans([event(), write({ actor: 'other' })], { candidates }), []);
  assert.deepEqual(generatePlans([event(), write({ entity: 'unknown' })], { candidates }), []);
});

test('guided supports candidate method and enclosingMethod but excludes nonwrite and aliases', () => {
  assert.equal(generatePlans([write()], { candidates }).length, 1);
  assert.equal(generatePlans([write({ operation: 'run' })], { candidates }).length, 1);
  assert.deepEqual(generatePlans([write()], { candidates: [{ kind: 'read', method: 'saveDerived' }] }), []);
  assert.deepEqual(generatePlans([write({ operation: 'aliasOfSave' })], { candidates }), []);
  assert.deepEqual(generatePlans([write()], { candidates: [] }), []);
  assert.deepEqual(generatePlans([write({ operation: '<anonymous>' })], { candidates: [{ kind: 'write', enclosingMethod: '<anonymous>' }] }), []);
});

test('trigger occurrence and actor identity are preserved without duplicate plans', () => {
  const trace = [event(), event({ actor: 'other' }), event(), event({ occurrence: 2 }), event({ phase: 'before' })];
  const plans = generatePlans(trace, { strategy: 'generic' });
  assert.deepEqual(plans.map(plan => plan.trigger), [
    { site: 'read:1', actor: 'producer', phase: 'after', occurrence: 1 },
    { site: 'read:1', actor: 'producer', phase: 'after', occurrence: 2 },
    { site: 'read:1', actor: 'producer', phase: 'before', occurrence: 1 },
  ]);
  assert.equal(new Set(plans.map(plan => plan.id)).size, 3);
});

test('random is a seeded permutation without replacement and the budget is exact', () => {
  const trace = Array.from({ length: 20 }, (_, i) => event({ site: `read:${i}` }));
  const all = generatePlans(trace, { strategy: 'random', seed: 12, budget: 20 });
  assert.deepEqual(all, generatePlans(trace, { strategy: 'random', seed: 12, budget: 20 }));
  assert.notDeepEqual(all, generatePlans(trace, { strategy: 'random', seed: 13, budget: 20 }));
  assert.equal(new Set(all.map(plan => plan.trigger.site)).size, 20);
  assert.deepEqual(generatePlans(trace, { strategy: 'random', seed: 12, budget: 3 }), all.slice(0, 3));
  assert.deepEqual(generatePlans(trace, { strategy: 'generic', budget: 0 }), []);
});

test('IDs depend on plan contents, never seed or result labels', () => {
  const plain = generatePlans([event()], { strategy: 'generic', seed: 1 });
  const labeled = generatePlans([event({ result: 'accepted', falseCompletion: true })], { strategy: 'generic', seed: 2 });
  assert.deepEqual(plain, labeled);
  assert.match(plain[0].id, /^delete:[a-f0-9]{64}$/);
  assert.notEqual(plain[0].id, generatePlans([event({ occurrence: 2 })], { strategy: 'generic' })[0].id);
  assert.notEqual(plain[0].id, generatePlans([event()], { strategy: 'trace-only' })[0].id);
});

test('validation rejects malformed traces and budgets rather than silently dropping them', () => {
  for (const options of [{ strategy: 'oracle-ranked' }, { budget: -1 }, { budget: .5 }, { seed: NaN }, { candidates: null }]) {
    assert.throws(() => generatePlans([], options));
  }
  for (const bad of [{ ...event(), occurrence: 0 }, { ...event(), kind: 'delete' }, { ...event(), entity: undefined }]) {
    assert.throws(() => generatePlans([bad]));
  }
});
