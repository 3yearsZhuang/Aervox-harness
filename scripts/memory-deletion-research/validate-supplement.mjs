#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CRASH_STAGES = [
  ...Array.from({ length: 8 }, (_, i) => `clean-mutation-${i + 1}`),
  'after-clean-commit', 'before-target-proof', 'after-target-proof', 'after-request-complete',
];
export const CONCURRENT_SCHEDULES = ['fetched-before-delete', 'marker-before-delete', 'guard-holds-writer', 'two-cached-workers', 'cached-worker-error'];
export const SCALE_PROFILES = [
  { id: 'small', backgroundRecords: 10, targetRevisions: 1, contentBytes: 128 },
  { id: 'medium', backgroundRecords: 1000, targetRevisions: 100, contentBytes: 1024 },
  { id: 'large', backgroundRecords: 10000, targetRevisions: 1000, contentBytes: 4096 },
];
const finite = (value, name) => assert.ok(Number.isFinite(value) && value >= 0, name);
const clean = (value, label) => {
  assert.ok(value && value.keepIntact === true, `${label}: keep changed`);
  assert.equal(value.clean, Object.values(value.residue).every(n => n === 0), `${label}: residue disagrees`);
  assert.equal(value.clean, true, `${label}: residue remains`);
};

export function validateSupplement(report) {
  assert.equal(report.schemaVersion, 1, 'supplement schema');
  assert.equal(report.kind, 'memory-deletion-production-probes');
  assert.ok(Number.isInteger(report.repetitions) && report.repetitions >= 1 && report.repetitions <= 10);
  assert.deepEqual(report.profiles, SCALE_PROFILES);
  assert.equal(report.crashes.length, CRASH_STAGES.length);
  for (const stage of CRASH_STAGES) {
    const rows = report.crashes.filter(row => row.stage === stage);
    assert.equal(rows.length, 1, `unique crash ${stage}`);
    const row = rows[0];
    assert.equal(row.error, null, stage);
    assert.equal(row.signal, 'SIGKILL', stage);
    assert.equal(row.barrier, stage, `${stage}: wrong barrier`);
    assert.equal(row.reopened.keepIntact, true, stage);
    assert.equal(row.reopened.clean, !stage.startsWith('clean-mutation-'), `${stage}: commit boundary`);
    if (stage.startsWith('clean-mutation-')) assert.equal(row.rollbackIntact, true, `${stage}: rollback`);
    clean(row.afterRetry, stage);
    assert.equal(row.pendingAfterRetry, false, `${stage}: completion gate`);
    assert.equal(row.retried, stage === 'after-request-complete' ? 0 : 1, `${stage}: retry count`);
    assert.equal(row.passed, true, stage);
  }
  assert.equal(report.concurrency.length, CONCURRENT_SCHEDULES.length);
  for (const schedule of CONCURRENT_SCHEDULES) {
    const rows = report.concurrency.filter(row => row.schedule === schedule);
    assert.equal(rows.length, 1, `unique schedule ${schedule}`);
    const row = rows[0];
    assert.equal(row.error, null, schedule);
    assert.equal(row.workerProcesses, schedule === 'two-cached-workers' ? 2 : 1, schedule);
    assert.ok(row.firstDeletion === 0 || row.firstDeletion === 1, schedule);
    if (schedule === 'guard-holds-writer') assert.equal(row.writerLockObserved, true, 'writer lock not observed');
    assert.equal(row.deletionsCompleted, 1, schedule);
    clean(row.final, schedule);
    assert.equal(row.pending, false, schedule);
    assert.equal(row.passed, true, schedule);
  }
  assert.equal(report.scale.length, SCALE_PROFILES.length * report.repetitions);
  const pids = new Set();
  for (const profile of SCALE_PROFILES) for (let repetition = 0; repetition < report.repetitions; repetition++) {
    const rows = report.scale.filter(row => row.profile === profile.id && row.repetition === repetition);
    assert.equal(rows.length, 1, `scale ${profile.id}/${repetition}`);
    const row = rows[0];
    assert.equal(row.error, null, profile.id);
    assert.equal(row.backgroundIntact, profile.backgroundRecords, profile.id);
    assert.match(row.backgroundBefore, /^[0-9a-f]{64}$/);
    assert.equal(row.backgroundAfter, row.backgroundBefore, 'background rows changed');
    assert.equal(row.revisionsBefore, profile.targetRevisions, profile.id);
    assert.ok(Number.isInteger(row.pid) && !pids.has(row.pid), 'scale must use fresh processes'); pids.add(row.pid);
    finite(row.cleanupMs, 'cleanup timing'); finite(row.verificationMs, 'verification timing');
    clean(row.final, profile.id);
    assert.ok(row.environment.sqliteVersion && row.environment.clientVersion && row.environment.kernel, 'environment incomplete');
    assert.equal(row.environment.pragmas.journal_mode, 'wal');
  }
  assert.equal(report.writerTiming.length, 24);
  for (const mode of ['legacy-select-insert', 'guarded-production']) for (let repetition = 0; repetition < 12; repetition++) {
    const rows = report.writerTiming.filter(row => row.mode === mode && row.repetition === repetition);
    assert.equal(rows.length, 1, `writer ${mode}/${repetition}`);
    finite(rows[0].ms, 'writer timing');
    assert.equal(rows[0].persisted, true, 'writer must actually insert');
  }
  assert.equal(report.sourceConsistency.changedFiles.length, 0, 'source drift');
  assert.deepEqual(report.sourceConsistency.readErrors, {});
  assert.deepEqual(report.hashes, report.sourceConsistency.afterHashes, 'source changed');
  assert.ok(Object.keys(report.hashes).length >= 62, 'source coverage');
  return { crashProbes: report.crashes.length, concurrencySchedules: report.concurrency.length, scaleSamples: report.scale.length, writerSamples: report.writerTiming.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length >= 1 && args.slice(1).every(flag => flag === '--check-source'), 'usage: validate-supplement.mjs <report.json> [--check-source]');
  const report = JSON.parse(await readFile(args[0], 'utf8'));
  const result = validateSupplement(report);
  if (args.includes('--check-source')) {
    const { validateSourceHashes } = await import('./validate-report.mjs');
    result.sourceHashes = await validateSourceHashes({ ...report, schemaVersion: 3 }, fileURLToPath(new URL('../../', import.meta.url)));
  }
  console.log(JSON.stringify({ valid: true, ...result }, null, 2));
}
