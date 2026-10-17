#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, ARMS, CHANNELS, STORES, WRITERS, OTHER_WRITERS, WRITE_BOUNDARY, VERIFIED_ARMS, GUARDED_ARMS, manifest } from './protocol.mjs';

const LEGACY_ARMS = ['soft-delete', 'cleanup-only', 'guarded-cleanup', 'verified-guarded'];
const LEGACY_CSV_COLUMNS = ['caseId', 'arm', 'channel', 'position', 'omission', 'completed', 'falseCompletion', 'resurrection', 'safeCompletion', 'cleanupMs', 'verificationMs', 'error'];
export const CSV_COLUMNS = ['caseId', 'arm', 'writer', ...LEGACY_CSV_COLUMNS.slice(2)];
export const csvColumns = report => report.schemaVersion >= 3 ? CSV_COLUMNS : LEGACY_CSV_COLUMNS;
// Required measurement inputs, rather than an arbitrary number of reported
// hashes. Include fixture/schema construction and the executed JS artifacts.
const LEGACY_REQUIRED_SOURCE_FILES = [
  ...['client', 'write-retry', 'conversation-execution-policy', 'repositories/sqlite/memory-repository',
    'repositories/sqlite/memory-deletion-store', 'repositories/sqlite/outbox-repository',
    'repositories/sqlite/memory-compaction-guard', 'repositories/sqlite/memory-compaction-repository',
    'repositories/sqlite/memory-embedding-repository', 'search/fts',
    ...['index', 'common', 'memories', 'provenance', 'memory-compaction', 'embeddings', 'outbox', 'fts', 'conversations'].map(name => `schema/ddl/${name}`),
  ].flatMap(file => [`packages/repositories/src/${file}.ts`, `packages/repositories/dist/${file}.js`]),
  ...['index', 'common', 'memories', 'provenance', 'memory-compaction', 'embeddings', 'outbox', 'conversations']
    .flatMap(file => [`packages/schema/src/${file}.ts`, `packages/schema/dist/${file}.js`]),
  'packages/repositories/package.json', 'packages/schema/package.json',
  'scripts/memory-deletion-research/fixture.mjs', 'scripts/memory-deletion-research/runner.mjs',
  'scripts/memory-deletion-research/crash-child.mjs', 'scripts/memory-deletion-research/validate-report.mjs',
  'pnpm-lock.yaml', 'mise.toml',
];
export const REQUIRED_SOURCE_FILES = [
  ...LEGACY_REQUIRED_SOURCE_FILES,
  ...['memory-deletion-protocol', 'repositories/sqlite/provenance-repository',
    'repositories/sqlite/memory-write-guard', 'repositories/sqlite/privacy-repository',
    'repositories/sqlite/skill-lifecycle-repository', 'repositories/sqlite/platform-repository',
    'schema/ddl/privacy', 'schema/ddl/platform', 'index', 'repositories/sqlite/index']
    .flatMap(file => [`packages/repositories/src/${file}.ts`, `packages/repositories/dist/${file}.js`]),
  ...['privacy', 'platform'].flatMap(file => [`packages/schema/src/${file}.ts`, `packages/schema/dist/${file}.js`]),
  'scripts/memory-deletion-research/protocol.mjs',
  'scripts/memory-deletion-research/supplement.mjs',
  'scripts/memory-deletion-research/supplement-child.mjs',
  'scripts/memory-deletion-research/supplement.test.mjs',
  'scripts/memory-deletion-research/validate-supplement.mjs',
  'package.json',
  ...['deletion-worker', 'compaction-marker'].flatMap(file => [`apps/worker/src/${file}.ts`, `apps/worker/dist/${file}.js`]),
];

const provenance = report => {
  assert.ok(report.hashes && typeof report.hashes === 'object', 'missing provenance hashes');
  if (report.schemaVersion >= 2) {
    for (const file of report.schemaVersion >= 3 ? REQUIRED_SOURCE_FILES : LEGACY_REQUIRED_SOURCE_FILES) {
      assert.ok(Object.hasOwn(report.hashes, file), `missing required provenance hash: ${file}`);
    }
  } else assert.ok(Object.keys(report.hashes).length >= 10, 'missing legacy provenance hashes');
  for (const [file, hash] of Object.entries(report.hashes)) {
    assert.ok(!path.isAbsolute(file) && !file.split(/[\\/]/).includes('..'), `hash path outside repository: ${file}`);
    assert.match(hash, /^[0-9a-f]{64}$/, `invalid SHA256: ${file}`);
  }
  if (report.schemaVersion >= 2) {
    assert.match(report.commit, /^[0-9a-f]{40}$/, 'missing measured commit');
    assert.equal(typeof report.workingTree, 'string', 'missing measured working tree');
    assert.deepEqual(Object.keys(report.sourceConsistency.afterHashes).sort(), Object.keys(report.hashes).sort(), 'after-measurement provenance coverage');
    const changedFiles = Object.keys(report.hashes).filter(file => report.hashes[file] !== report.sourceConsistency.afterHashes[file]);
    assert.deepEqual(report.sourceConsistency.changedFiles, changedFiles, 'source drift inventory disagrees with hashes');
    assert.deepEqual(report.sourceConsistency.readErrors, {}, 'source unavailable after measurement');
    assert.deepEqual(changedFiles, [], 'source changed during experiment; rerun after edits and builds finish');
  }
};

// Recompute from raw samples rather than trusting the reported aggregates.
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * p;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
};
const finiteMs = (value, label) => assert.ok(Number.isFinite(value) && value >= 0, `${label}: expected finite nonnegative milliseconds`);
const observation = (value, label) => {
  assert.ok(value && typeof value === 'object', `${label}: missing observation`);
  assert.deepEqual(Object.keys(value.residue).sort(), [...STORES].sort(), `${label}: logical stores`);
  for (const [store, count] of Object.entries(value.residue)) assert.ok(Number.isSafeInteger(count) && count >= 0, `${label}.${store}: invalid residue count`);
  assert.equal(value.clean, Object.values(value.residue).every(n => n === 0), `${label}: clean flag disagrees with residue`);
  assert.equal(typeof value.keepIntact, 'boolean', `${label}: missing keep observation`);
};

export function validateReport(report) {
  assert.ok([1, 2, SCHEMA_VERSION].includes(report.schemaVersion), 'unsupported report schema');
  provenance(report);
  assert.ok(Number.isFinite(Date.parse(report.generatedAt)), 'invalid generation timestamp');
  const arms = report.schemaVersion >= 3 ? ARMS : LEGACY_ARMS;
  const verifiedArms = report.schemaVersion >= 3 ? VERIFIED_ARMS : ['verified-guarded'];
  assert.deepEqual(report.protocol.arms, arms, 'protocol arms');
  assert.deepEqual(report.protocol.channels, CHANNELS, 'protocol channels');
  const schedules = report.schemaVersion >= 3 ? manifest() : CHANNELS.flatMap(channel => ['before-clean', 'before-complete', 'after-complete'].map(position => ({ id: `${channel}:${position}`, channel, position, omission: null })))
    .concat(CHANNELS.map(channel => ({ id: `omit:${channel}`, channel, position: 'omission', omission: channel })));
  if (report.schemaVersion >= 3) {
    assert.deepEqual(report.protocol.writers, WRITERS, 'public writer inventory');
    assert.deepEqual(report.protocol.otherWriters, OTHER_WRITERS, 'other writer coverage inventory');
    assert.equal(report.protocol.writeBoundary, WRITE_BOUNDARY, 'write boundary');
    assert.equal(report.protocol.verifier, 'memory-local-v3', 'current verifier contract');
    assert.match(report.environment.sqlite.version, /^\d+\.\d+\.\d+/, 'SQLite version');
    assert.equal(typeof report.environment.sqlite.journal_mode, 'string', 'journal mode');
    for (const name of ['synchronous', 'foreign_keys', 'busy_timeout']) {
      assert.ok(Number.isSafeInteger(report.environment.sqlite[name]) && report.environment.sqlite[name] >= 0, `SQLite ${name}`);
    }
  }
  assert.deepEqual(report.protocol.manifest, schedules, 'predeclared schedule manifest');
  assert.equal(report.protocol.casesPerArm, schedules.length, 'cases per arm');
  assert.ok(Number.isSafeInteger(report.protocol.repetitions) && report.protocol.repetitions > 0 && report.protocol.repetitions <= 100, 'timing repetitions');
  assert.equal(report.cases.length, arms.length * schedules.length, 'correctness matrix cardinality');
  const keys = new Set();
  for (const row of report.cases) {
    const key = `${row.arm}/${row.caseId}`;
    assert.ok(!keys.has(key), `duplicate correctness case ${key}`); keys.add(key);
    assert.ok(arms.includes(row.arm), `${key}: unknown arm`);
    const spec = schedules.find(s => s.id === row.caseId);
    assert.ok(spec, `${key}: unknown schedule`);
    for (const field of ['channel', 'position', 'omission']) assert.equal(row[field], spec[field], `${key}: ${field}`);
    if (report.schemaVersion >= 3) {
      assert.equal(row.writer, spec.writer, `${key}: writer`);
      assert.equal(typeof row.writerRejected, 'boolean', `${key}: writer rejection flag`);
      if (verifiedArms.includes(row.arm) && row.completed) {
        assert.equal(row.proof?.verifier, report.protocol.verifier, `${key}: proof verifier`);
        assert.ok(Number.isFinite(Date.parse(row.proof.verifiedAt)), `${key}: proof time`);
        for (const field of ['contentRows', 'ftsRows', 'vectorRows']) assert.equal(row.proof[field], 0, `${key}: proof ${field}`);
      } else assert.equal(row.proof, undefined, `${key}: unexpected completion proof`);
    }
    assert.equal(row.error, null, `${key}: experiment error`);
    assert.equal(typeof row.completed, 'boolean', `${key}: missing completion flag`);
    observation(row.atCompletion, `${key}.atCompletion`); observation(row.final, `${key}.final`);
    assert.equal(row.falseCompletion, row.completed && !row.atCompletion.clean, `${key}: false completion definition`);
    assert.equal(row.resurrection, row.completed && row.atCompletion.clean && !row.final.clean, `${key}: resurrection definition`);
    assert.equal(row.safeCompletion, row.completed && row.atCompletion.clean && row.final.clean && row.final.keepIntact, `${key}: safe completion definition`);
    assert.equal(row.atCompletion.keepIntact, true, `${key}: keep changed at completion`);
    assert.equal(row.final.keepIntact, true, `${key}: keep changed finally`);
    finiteMs(row.cleanupMs, `${key}.cleanupMs`); finiteMs(row.verificationMs, `${key}.verificationMs`);
    if (!verifiedArms.includes(row.arm)) assert.equal(row.verificationMs, 0, `${key}: ablation unexpectedly verified`);
    const expected = row.arm === 'soft-delete' ? 'falseCompletion'
      : row.omission ? (verifiedArms.includes(row.arm) ? 'blocked' : 'falseCompletion')
      : row.arm === 'verified-cleanup' && row.position === 'before-complete' ? 'blocked'
      : row.arm === 'cleanup-only' && row.position === 'before-complete' ? 'falseCompletion'
      : ['cleanup-only', 'verified-cleanup'].includes(row.arm) && row.position === 'after-complete' ? 'resurrection' : 'safeCompletion';
    if (expected === 'blocked') {
      assert.equal(row.completed, false, `${key}: residue must block completion`);
      assert.equal(row.verificationBlocked, true, `${key}: missing verification refusal`);
      assert.equal(row.final.clean, false, `${key}: residual store must remain visible to oracle`);
    } else assert.equal(row[expected], true, `${key}: expected ${expected}`);
    if (report.schemaVersion >= 3 && row.arm !== 'soft-delete' && !row.final.clean) {
      assert.ok(row.final.residue[spec.channel] > 0, `${key}: selected writer or omission did not leave its declared residue`);
      for (const [store, count] of Object.entries(row.final.residue)) {
        if (store !== spec.channel) assert.equal(count, 0, `${key}: unrelated residue in ${store}`);
      }
    }
  }
  assert.equal(report.latency.length, report.protocol.repetitions * arms.length, 'timing matrix cardinality');
  const timingKeys = new Set();
  for (const row of report.latency) {
    const key = `${row.arm}/${row.repetition}`;
    assert.ok(!timingKeys.has(key), `duplicate timing sample ${key}`); timingKeys.add(key);
    assert.ok(arms.includes(row.arm) && Number.isSafeInteger(row.repetition) && row.repetition >= 0 && row.repetition < report.protocol.repetitions, `${key}: invalid timing schedule`);
    assert.equal(row.error, null, `${key}: timing experiment error`);
    if (report.schemaVersion >= 2) {
      assert.equal(row.caseId, 'fts:before-clean', `${key}: timing workload`);
      assert.equal(row.completed, true, `${key}: timed operation did not complete`);
      observation(row.final, `${key}.final`);
      assert.equal(row.final.keepIntact, true, `${key}: timed operation changed keep`);
      assert.equal(row.final.clean, row.arm !== 'soft-delete', `${key}: timed operation has unexpected residue`);
    }
    for (const field of ['cleanupMs', 'verificationMs', 'totalMs']) finiteMs(row[field], `${key}.${field}`);
    assert.equal(row.totalMs, row.cleanupMs + row.verificationMs, `${key}: total timing`);
    if (!verifiedArms.includes(row.arm)) assert.equal(row.verificationMs, 0, `${key}: ablation timing includes verification`);
  }
  const summary = arms.map(arm => {
    const rows = report.cases.filter(row => row.arm === arm), times = report.latency.filter(row => row.arm === arm).map(row => row.totalMs);
    return { arm, cases: rows.length, completed: rows.filter(r => r.completed).length,
      falseCompletions: rows.filter(r => r.falseCompletion).length, resurrections: rows.filter(r => r.resurrection).length,
      safeCompletions: rows.filter(r => r.safeCompletion).length, finalResidues: rows.filter(r => !r.final.clean).length,
      keepViolations: rows.filter(r => !r.final.keepIntact).length, errors: rows.filter(r => r.error).length,
      latencySamples: times.length, p25Ms: quantile(times, .25), medianMs: quantile(times, .5), p75Ms: quantile(times, .75), p95Ms: quantile(times, .95) };
  });
  assert.deepEqual(report.summary, summary, 'summary disagrees with raw correctness or timing rows');
  assert.equal(report.errorSinks.length, 4, 'error sink matrix cardinality');
  for (const method of ['markFailed', 'markDeadLetter']) for (const implementation of ['legacy-sql', 'patched-production']) {
    const rows = report.errorSinks.filter(r => r.method === method && r.implementation === implementation);
    assert.equal(rows.length, 1, `error sink unique ${method}/${implementation}`);
    const row = rows[0], label = `${method}/${implementation}`;
    assert.equal(row.error, null, `${label}: experiment error`);
    observation(row.before, `${label}.before`); observation(row.after, `${label}.after`);
    assert.equal(row.before.clean, true, `${label}: unclean initial state`);
    assert.equal(row.before.keepIntact && row.after.keepIntact, true, `${label}: keep preservation`);
    assert.equal(row.resurrection, row.before.clean && !row.after.clean, `${label}: resurrection definition`);
    assert.equal(row.resurrection, implementation === 'legacy-sql', `${label}: expected sink behavior`);
    assert.equal(row.status, implementation === 'patched-production' ? 'published' : method === 'markFailed' ? 'failed' : 'dead_letter', `${label}: persisted status`);
    assert.equal(row.retryCount, implementation === 'legacy-sql' && method === 'markFailed' ? 1 : 0, `${label}: persisted retries`);
  }
  assert.equal(report.crashes.length, 2, 'crash barrier cardinality');
  for (const stage of ['inside-transaction', 'after-clean-commit']) {
    const rows = report.crashes.filter(r => r.stage === stage); assert.equal(rows.length, 1, `crash unique ${stage}`);
    const row = rows[0]; assert.equal(row.error, null, `${stage}: experiment error`); assert.equal(row.signal, 'SIGKILL', `${stage}: signal`);
    observation(row.reopened, `${stage}.reopened`); observation(row.afterRetry, `${stage}.afterRetry`);
    assert.equal(row.reopened.keepIntact && row.afterRetry.keepIntact, true, `${stage}: keep preservation`);
    assert.equal(row.afterRetry.clean, true, `${stage}: retry did not clean`);
    assert.equal(row.passed, true, `${stage}: probe failed`);
    if (stage === 'inside-transaction') {
      assert.equal(row.rollbackObserved, true, `${stage}: rollback absent`);
      if (report.schemaVersion >= 2) assert.equal(row.rollbackIntact, true, `${stage}: full target snapshot did not roll back`);
      assert.equal(row.reopened.clean, false, `${stage}: unexpected committed cleanup`);
    }
    else assert.equal(row.reopened.clean, true, `${stage}: committed cleanup absent`);
  }
  return { correctnessCases: report.cases.length, timingSamples: report.latency.length, errorSinkCases: report.errorSinks.length, crashProbes: report.crashes.length, summary };
}

/** RFC 4180 cells, including escaped quotes and embedded newlines. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false, closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closedQuote = true; }
      else cell += c;
    } else if (c === '"') { assert.equal(cell, '', 'quote inside an unquoted CSV cell'); assert.equal(closedQuote, false, 'unexpected CSV quote'); quoted = true; }
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closedQuote = false;
      if (c !== ',') { rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else { assert.equal(closedQuote, false, 'text after closing CSV quote'); cell += c; }
  }
  assert.equal(quoted, false, 'unterminated CSV quote');
  if (cell !== '' || row.length || closedQuote) { row.push(cell); rows.push(row); }
  return rows;
}

export function validateCsv(report, csv) {
  const columns = csvColumns(report);
  const rows = parseCsv(csv); assert.deepEqual(rows.shift(), columns, 'CSV header');
  assert.deepEqual(rows, report.cases.map(row => columns.map(field => String(row[field] ?? ''))), 'CSV differs from JSON case rows');
  return rows.length;
}

export async function validateSourceHashes(report, root) {
  assert.ok(report.schemaVersion >= 2, 'legacy report lacks required provenance coverage; remeasure before checking source');
  provenance(report);
  for (const [file, expected] of Object.entries(report.hashes)) {
    const absolute = path.resolve(root, file);
    assert.ok(absolute.startsWith(path.resolve(root) + path.sep), `hash path outside repository: ${file}`);
    assert.match(expected, /^[0-9a-f]{64}$/, `invalid SHA256: ${file}`);
    assert.equal(createHash('sha256').update(await readFile(absolute)).digest('hex'), expected, `source changed since measurement: ${file}`);
  }
  return Object.keys(report.hashes).length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), flags = args.filter(arg => arg.startsWith('--'));
  assert.ok(flags.every(flag => flag === '--check-source'), 'usage: validate-report.mjs <results-directory> [--check-source]');
  const directory = args.find(arg => !arg.startsWith('--')); assert.ok(directory, 'results directory required');
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const checked = validateReport(report); checked.csvRows = validateCsv(report, await readFile(path.join(directory, 'cases.csv'), 'utf8'));
  if (report.schemaVersion >= 3) {
    const { validateSupplement } = await import('./validate-supplement.mjs');
    const supplement = JSON.parse(await readFile(path.join(directory, 'supplement.json'), 'utf8'));
    checked.supplement = validateSupplement(supplement);
    assert.deepEqual(supplement.hashes, report.hashes, 'main and supplement measured different source snapshots');
    if (flags.includes('--check-source')) await validateSourceHashes({ ...supplement, schemaVersion: 3 }, fileURLToPath(new URL('../../', import.meta.url)));
  }
  if (flags.includes('--check-source')) checked.sourceHashes = await validateSourceHashes(report, fileURLToPath(new URL('../../', import.meta.url)));
  console.log(JSON.stringify({ valid: true, ...checked }, null, 2));
}
