import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runSupplement } from './supplement.mjs';
import { validateSupplement } from './validate-supplement.mjs';

test('production crash, worker races and fresh-process size probes preserve raw evidence', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-supplement-test-'));
  const out = path.join(directory, 'report.json');
  try {
    const report = await runSupplement({ out, repetitions: 1 });
    assert.deepEqual(validateSupplement(report), { crashProbes: 12, concurrencySchedules: 5, scaleSamples: 3, writerSamples: 24 });
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), report);
    await assert.rejects(runSupplement({ out, repetitions: 1 }), /refusing to overwrite/);
    for (const mutate of [
      r => { r.crashes[0].rollbackIntact = false; },
      r => { r.crashes.pop(); },
      r => { r.concurrency[0].final.clean = false; },
      r => { r.scale[0].backgroundIntact = 0; },
      r => { r.writerTiming[0].persisted = false; },
      r => { r.sourceConsistency.afterHashes = {}; },
    ]) {
      const changed = structuredClone(report); mutate(changed);
      assert.throws(() => validateSupplement(changed));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
