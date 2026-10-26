#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORES } from './protocol.mjs';
import { COST_SCHEMA_VERSION, COST_KIND, COST_REPETITIONS, COST_BASELINE, COST_CONFIGURATIONS, COST_GUARD_MODES, COST_BOUNDARY, COST_REQUIRED_SOURCE_FILES, COST_RUNTIME_ROLES, COST_RUNTIME_PACKAGES, costSchedule } from './cost-protocol.mjs';
import { readCostRuntimeInputs } from './cost-runtime.mjs';

const finite = (value, name) => assert.ok(Number.isFinite(value) && value >= 0, `${name}: invalid timing`);
const sha = value => assert.match(value, /^[0-9a-f]{64}$/);
const observation = (value, label, mustBeClean = true) => {
  assert.ok(value && value.keepIntact === true, `${label}: retained object changed`);
  assert.deepEqual(Object.keys(value.residue).sort(), [...STORES].sort(), `${label}: missing logical store`);
  for (const count of Object.values(value.residue)) assert.ok(Number.isSafeInteger(count) && count >= 0, `${label}: invalid residue count`);
  assert.equal(value.clean, Object.values(value.residue).every(count => count === 0), `${label}: residue disagrees`);
  if (mustBeClean) assert.equal(value.clean, true, `${label}: residue remains`);
};
const proof = value => {
  assert.equal(value.verifier, 'memory-local-v3', 'wrong completion verifier');
  assert.ok(Number.isFinite(Date.parse(value.verifiedAt)), 'missing verification time');
  for (const key of ['contentRows', 'ftsRows', 'vectorRows']) assert.equal(value[key], 0, 'proof reports residue');
};

function quantiles(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = p => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p, lower = Math.floor(position), upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { n: values.length, p25Ms: at(.25), medianMs: at(.5), p75Ms: at(.75), p95Ms: at(.95) };
}

// Recalculate groups and quantiles from individual rows, never report summaries.
export function recomputeCostSummary(rows) {
  const group = (kind, id) => {
    const selected = rows.filter(row => row.kind === kind && (kind === 'scale' ? row.configuration : row.mode) === id);
    const completed = selected.filter(row => row.status === 'completed');
    return { id, samples: selected.length, completed: completed.length,
      blocked: selected.filter(row => row.status === 'blocked').length,
      failed: selected.filter(row => row.status === 'failed').length,
      ...(kind === 'scale' ? {
        cleanup: quantiles(completed.map(row => row.cleanupMs)),
        verification: quantiles(completed.map(row => row.verificationMs)),
      } : { write: quantiles(completed.map(row => row.writeMs)) }),
    };
  };
  return { scale: COST_CONFIGURATIONS.map(value => group('scale', value.id)), guard: COST_GUARD_MODES.map(mode => group('guard', mode)) };
}

export function validateCostReport(report, { requireFormal = true } = {}) {
  assert.equal(report.schemaVersion, COST_SCHEMA_VERSION, 'cost schema 2 required; schema 1 remains checkable with the frozen cea6b687 validator');
  assert.equal(report.kind, COST_KIND);
  assert.equal(report.status, 'completed', 'failed or incomplete measurement');
  assert.equal(report.error, null, 'measurement error');
  assert.ok(Number.isSafeInteger(report.repetitions) && report.repetitions >= 1 && report.repetitions <= COST_REPETITIONS);
  assert.equal(report.purpose, report.repetitions === COST_REPETITIONS ? 'formal' : 'smoke');
  if (requireFormal) assert.equal(report.repetitions, COST_REPETITIONS, 'formal measurement needs 30 repetitions');
  assert.deepEqual(report.baseline, COST_BASELINE);
  assert.deepEqual(report.configurations, COST_CONFIGURATIONS);
  assert.deepEqual(report.guardModes, COST_GUARD_MODES);
  assert.deepEqual(report.boundary, COST_BOUNDARY);
  assert.match(report.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof report.workingTree, 'string');
  assert.ok(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.completedAt)));
  assert.ok(Date.parse(report.completedAt) >= Date.parse(report.startedAt));
  assert.ok(typeof report.rawFile === 'string' && path.basename(report.rawFile) === report.rawFile && report.rawFile.endsWith('.raw.jsonl'), 'raw file must be a sibling file');
  sha(report.rawSha256);
  assert.deepEqual(Object.keys(report.hashes).sort(), [...COST_REQUIRED_SOURCE_FILES].sort(), 'measurement inputs missing');
  for (const hash of Object.values(report.hashes)) sha(hash);
  assert.deepEqual(report.sourceConsistency.beforeReadErrors, {}, 'initial source read errors');
  assert.deepEqual(report.sourceConsistency.readErrors, {}, 'final source read errors');
  assert.deepEqual(report.sourceConsistency.changedFiles, [], 'source input drift');
  assert.deepEqual(report.hashes, report.sourceConsistency.afterHashes, 'source hashes changed');
  assert.deepEqual(report.runtimeInputs.map(value => value.role), COST_RUNTIME_ROLES, 'selected runtime roles missing or duplicated');
  for (const input of report.runtimeInputs) {
    const expectedPackage = COST_RUNTIME_PACKAGES[input.role];
    if (expectedPackage === null) assert.match(input.packageName, /^@libsql\/[a-z0-9-]+$/);
    else assert.equal(input.packageName, expectedPackage, 'runtime package role mismatch');
    assert.match(input.packageVersion, /^\d+\.\d+\.\d+(?:[+-][A-Za-z0-9.-]+)?$/, 'runtime version missing');
    assert.ok(typeof input.path === 'string' && input.path.startsWith('node_modules/.pnpm/') && !input.path.includes('\\') && !input.path.split('/').some(part => ['', '.', '..'].includes(part)) && path.posix.normalize(input.path) === input.path, 'runtime path must be normalized inside the repository install');
    sha(input.sha256);
    if (input.role.endsWith('-package')) assert.ok(input.path.endsWith('/package.json'));
    if (input.role === 'native-addon') assert.ok(input.path.endsWith('/index.node'));
  }
  const native = report.runtimeInputs.find(value => value.role === 'native-addon'), packageVersions = new Map();
  for (const input of report.runtimeInputs) {
    if (packageVersions.has(input.packageName)) assert.equal(input.packageVersion, packageVersions.get(input.packageName), 'runtime package versions disagree');
    else packageVersions.set(input.packageName, input.packageVersion);
    if (input.role.startsWith('native-')) {
      assert.equal(input.packageName, native.packageName, 'native package disagrees');
      assert.equal(input.packageVersion, native.packageVersion, 'native package version disagrees');
    }
  }
  assert.equal(native.packageVersion, report.runtimeInputs.find(value => value.role === 'libsql-entry').packageVersion, 'libsql wrapper and addon versions disagree');
  assert.equal(report.runtimeConsistency.beforeReadError, null, 'initial runtime read failure');
  assert.equal(report.runtimeConsistency.readError, null, 'final runtime read failure');
  assert.deepEqual(report.runtimeConsistency.changedRoles, [], 'selected runtime input drift');
  assert.deepEqual(report.runtimeInputs, report.runtimeConsistency.afterInputs, 'selected runtime changed');
  const schedule = costSchedule(report.repetitions);
  assert.equal(report.samples.length, schedule.length, 'missing or duplicate observations');
  const pids = new Set(), databases = new Set();
  for (const [ordinal, unit] of schedule.entries()) {
    const row = report.samples[ordinal];
    for (const [key, value] of Object.entries(unit)) assert.equal(row[key], value, `schedule mismatch at ${ordinal}/${key}`);
    assert.equal(row.ordinal, ordinal, 'execution order changed');
    assert.equal(row.status, 'completed', `${unit.id}: incomplete sample`);
    assert.equal(row.error, null, `${unit.id}: sample error`);
    assert.equal(row.execution.code, 0, `${unit.id}: child exit`);
    assert.equal(row.execution.signal, null, `${unit.id}: child signal`);
    assert.equal(row.execution.stderr, '', `${unit.id}: unexpected child stderr`);
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && !pids.has(row.pid), 'each sample needs a fresh child'); pids.add(row.pid);
    assert.match(row.databaseId, /^aervox-deletion-cost-[A-Za-z0-9]+$/);
    assert.ok(!databases.has(row.databaseId), 'each sample needs a fresh database'); databases.add(row.databaseId);
    for (const key of ['node', 'platform', 'arch', 'cpu', 'kernel', 'sqliteVersion', 'clientVersion']) assert.ok(typeof row.environment[key] === 'string' && row.environment[key], `missing environment ${key}`);
    assert.equal(typeof row.environment.filesystemType, 'number');
    assert.equal(row.environment.pragmas.journal_mode, 'wal');
    assert.equal(row.environment.pragmas.foreign_keys, 1);
    assert.ok(Number.isFinite(row.environment.pragmas.synchronous) && Number.isFinite(row.environment.pragmas.busy_timeout));
    observation(row.final, unit.id);
    proof(row.proof);
    if (unit.kind === 'scale') {
      const configuration = COST_CONFIGURATIONS.find(value => value.id === unit.configuration);
      assert.deepEqual(row.parameters, configuration);
      assert.equal(row.before.revisions, configuration.targetRevisions);
      assert.equal(row.before.evidence, configuration.targetRevisions);
      assert.equal(row.before.contentLengths.minimum, configuration.contentBytes);
      assert.equal(row.before.contentLengths.maximum, configuration.contentBytes);
      const before = row.before.backgrounds, after = row.after.backgrounds;
      sha(before.hash); assert.equal(after.hash, before.hash, 'background data changed');
      assert.deepEqual(Object.keys(before.counts).sort(), [...STORES].sort(), 'background stores incomplete');
      assert.equal(before.counts.record, configuration.backgroundRecords);
      for (const key of STORES.filter(key => key !== 'record')) assert.equal(before.counts[key], 0, 'unexpected background fixture');
      assert.deepEqual(after.counts, before.counts, 'background counts changed');
      finite(row.cleanupMs, unit.id); finite(row.verificationMs, unit.id);
    } else {
      finite(row.writeMs, unit.id);
      assert.equal(row.persisted, true, 'timed write did not persist');
      assert.equal(row.returned.id, 'cost-timed-revision');
      assert.equal(row.returned.memoryId, 'target');
      assert.equal(row.returned.content, 'x'.repeat(1024));
      assert.equal(row.returned.confidence, 0); assert.equal(row.returned.importance, 0);
      assert.equal(row.returned.algorithmVersion, null);
      assert.ok(Number.isFinite(Date.parse(row.returned.createdAt)));
      observation(row.atCompletion, unit.id);
      observation(row.afterLate, unit.id, false);
      observation(row.afterRecleanup, unit.id);
      assert.equal(row.lateRejected, unit.mode === 'guard-enabled');
      assert.equal(row.afterLate.clean, unit.mode === 'guard-enabled', 'guard calibration disagrees');
      assert.equal(row.afterLate.residue.revisions, unit.mode === 'guard-enabled' ? 0 : 1);
      for (const key of STORES.filter(key => key !== 'revisions')) assert.equal(row.afterLate.residue[key], 0, 'unexpected calibration residue');
    }
  }
  assert.deepEqual(report.summary, recomputeCostSummary(report.samples), 'summary not derived from raw rows');
  return { valid: true, purpose: report.purpose, scaleSamples: report.repetitions * COST_CONFIGURATIONS.length, guardSamples: report.repetitions * COST_GUARD_MODES.length, sourceInputs: COST_REQUIRED_SOURCE_FILES.length, runtimeInputs: COST_RUNTIME_ROLES.length };
}

export async function validateCostFiles(file, { checkSource = false, requireFormal = true } = {}) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  const result = validateCostReport(report, { requireFormal });
  const raw = await readFile(path.join(path.dirname(file), report.rawFile), 'utf8');
  assert.equal(createHash('sha256').update(raw).digest('hex'), report.rawSha256, 'raw evidence hash mismatch');
  assert.ok(raw.endsWith('\n'), 'truncated raw evidence');
  assert.deepEqual(raw.trimEnd().split('\n').map(line => JSON.parse(line)), report.samples, 'report rows differ from raw evidence');
  if (checkSource) {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    for (const name of COST_REQUIRED_SOURCE_FILES) {
      const hash = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
      assert.equal(hash, report.hashes[name], `current source changed: ${name}`);
    }
    // Reading saved paths alone would miss a switched dependency symlink while
    // the old package remained installed. Resolve the currently selected chain.
    assert.deepEqual(await readCostRuntimeInputs(root), report.runtimeInputs, 'currently selected execution dependencies differ from the measurement');
    result.sourceChecked = true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...flags] = process.argv.slice(2);
  assert.ok(file && flags.every(value => ['--check-source', '--allow-smoke'].includes(value)), 'usage: cost-validator.mjs <report.json> [--check-source] [--allow-smoke]');
  console.log(JSON.stringify(await validateCostFiles(file, { checkSource: flags.includes('--check-source'), requireFormal: !flags.includes('--allow-smoke') }), null, 2));
}
