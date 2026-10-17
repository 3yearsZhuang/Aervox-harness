#!/usr/bin/env node
import { writeFile, mkdir, mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDatabase, SqliteMemoryDeletionStore, MEMORY_DELETION_VERIFIER } from '../../packages/repositories/dist/index.js';
import { fixture, write, clean, oracle, close, query, snapshot } from './fixture.mjs';
import { SCHEMA_VERSION, ARMS, CHANNELS, WRITERS, OTHER_WRITERS, WRITE_BOUNDARY, VERIFIED_ARMS, GUARDED_ARMS, manifest } from './protocol.mjs';
export { manifest } from './protocol.mjs';
import { csvColumns, REQUIRED_SOURCE_FILES, validateReport, validateCsv } from './validate-report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function parseArgs(args) {
  const options = { out: path.join(ROOT, 'artifacts/memory-deletion-study'), repetitions: 12, overwrite: false };
  for (const arg of args) {
    if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else if (arg.startsWith('--repetitions=')) options.repetitions = Number(arg.slice(14));
    else if (arg === '--overwrite') options.overwrite = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 100) throw new Error('repetitions must be 1..100');
  return options;
}

export async function runCase(spec, arm) {
  let f;
  const row = { caseId: spec.id, arm, writer: spec.writer, channel: spec.channel, position: spec.position, omission: spec.omission, completed: false, writerRejected: false, error: null };
  try {
    f = await fixture();
    const guarded = GUARDED_ARMS.includes(arm);
    const lateWrite = async () => {
      try {
        const result = await write(f, spec.writer, 'target', 'late', guarded);
        if (result === false) row.writerRejected = true;
      } catch (e) {
        if (['memory_compaction_target_unavailable', 'memory_write_target_unavailable'].includes(e.message)) row.writerRejected = true;
        else throw e;
      }
    };
    if (spec.position === 'before-clean') await lateWrite();
    let start = performance.now();
    await clean(f, arm, spec.omission);
    row.cleanupMs = performance.now() - start;
    if (spec.position === 'before-complete') await lateWrite();
    row.verificationMs = 0;
    if (VERIFIED_ARMS.includes(arm)) {
      start = performance.now();
      try { row.proof = JSON.parse(await f.store.verify('target')); row.completed = true; }
      catch (e) { if (e.message !== 'deletion_memory_verification_failed') throw e; row.verificationBlocked = true; }
      row.verificationMs = performance.now() - start;
    } else row.completed = true;
    row.atCompletion = await oracle(f);
    if (spec.position === 'after-complete') await lateWrite();
    row.final = await oracle(f);
    row.falseCompletion = row.completed && !row.atCompletion.clean;
    row.resurrection = row.completed && row.atCompletion.clean && !row.final.clean;
    row.safeCompletion = row.completed && row.atCompletion.clean && row.final.clean && row.final.keepIntact;
  } catch (e) { row.error = `${e.name}: ${e.message}`; }
  finally { if (f) await close(f); }
  return row;
}

async function errorSinkCases() {
  const rows = [];
  for (const method of ['markFailed', 'markDeadLetter']) for (const implementation of ['legacy-sql', 'patched-production']) {
    const row = { method, implementation, error: null };
    let f;
    try {
      f = await fixture();
      await f.store.clean('target'); await f.store.verify('target');
      row.before = await oracle(f);
      const text = `failed processing ${f.fetched.summaryText}`;
      if (implementation === 'legacy-sql') {
        // Faithful reconstruction of the pre-patch UPDATE, not a competing framework.
        await query(f.client, method === 'markFailed'
          ? "UPDATE outbox_events SET retry_count=retry_count+1,status=CASE WHEN retry_count+1>=3 THEN 'dead_letter' ELSE 'failed' END,last_error=? WHERE id=?"
          : "UPDATE outbox_events SET status='dead_letter',last_error=? WHERE id=?", [text, 'outbox_target_seed']);
      } else await f.outbox[method]('outbox_target_seed', text);
      row.after = await oracle(f);
      const event = await f.outbox.getEventById('outbox_target_seed');
      row.status = event.status; row.retryCount = event.retryCount;
      row.resurrection = row.before.clean && !row.after.clean;
    } catch (e) { row.error = e.message; }
    finally { if (f) await close(f); }
    rows.push(row);
  }
  return rows;
}

async function killAtBarrier(url, stage) {
  const child = fork(fileURLToPath(new URL('./crash-child.mjs', import.meta.url)), [url, stage], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  return new Promise((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child barrier timeout')); }, 15_000);
    child.on('message', message => { if (message === 'barrier') { ready = true; child.kill('SIGKILL'); } });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!ready || signal !== 'SIGKILL') reject(new Error(`child exited before kill: ${code}/${signal}: ${stderr}`));
      else resolve({ signal, stage });
    });
  });
}

async function crashCases() {
  const rows = [];
  for (const stage of ['inside-transaction', 'after-clean-commit']) {
    const directory = await mkdtemp(path.join(tmpdir(), 'aervox-deletion-crash-'));
    const row = { stage, error: null };
    let f;
    try {
      const url = `file:${path.join(directory, 'probe.db')}`;
      f = await fixture(url);
      const keepBefore = f.keepBefore;
      const outboxIds = f.outboxIds;
      const targetBefore = await snapshot(f, 'target');
      await close(f); f = null;
      Object.assign(row, await killAtBarrier(url, stage));
      f = await createDatabase({ url }); f.keepBefore = keepBefore; f.outboxIds = outboxIds; f.store = new SqliteMemoryDeletionStore(f.db);
      row.reopened = await oracle(f);
      const [record] = await query(f.client, "SELECT content,is_deleted FROM memory_records WHERE id='target'");
      row.rollbackObserved = record.is_deleted === 0 && record.content === 'privateword target';
      row.rollbackIntact = JSON.stringify(await snapshot(f, 'target')) === JSON.stringify(targetBefore);
      await f.store.clean('target'); await f.store.verify('target');
      row.afterRetry = await oracle(f);
      row.passed = row.afterRetry.clean && row.afterRetry.keepIntact && row.reopened.keepIntact && (stage === 'inside-transaction' ? row.rollbackObserved && row.rollbackIntact : row.reopened.clean);
    } catch (e) { row.error = e.message; row.passed = false; }
    finally { if (f) await close(f); await rm(directory, { recursive: true, force: true }); }
    rows.push(row);
  }
  return rows;
}

export const quantile = (values, p) => {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y), index = (a.length - 1) * p;
  return a[Math.floor(index)] + (a[Math.ceil(index)] - a[Math.floor(index)]) * (index % 1);
};

/** Preserve observations before refusing an unexpected or incomplete result. */
export async function persistReport(report, options) {
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const columns = csvColumns(report);
  const csv = [columns.join(','), ...report.cases.map(r => columns.map(k => cell(r[k])).join(','))].join('\n') + '\n';
  await mkdir(options.out, { recursive: true });
  const flag = options.overwrite ? 'w' : 'wx';
  await writeFile(path.join(options.out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag });
  await writeFile(path.join(options.out, 'cases.csv'), csv, { flag });
  try { validateReport(report); validateCsv(report, csv); }
  catch (error) {
    error.message += `; raw evidence preserved at ${path.resolve(options.out)}`;
    throw error;
  }
  return report;
}

export async function run(options) {
  if (!options.overwrite) for (const filename of ['report.json', 'cases.csv']) {
    try { await access(path.join(options.out, filename)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`refusing to overwrite ${filename}; choose a new --out or explicitly pass --overwrite`);
  }
  const sourceFiles = REQUIRED_SOURCE_FILES;
  const hashSources = async (readErrors) => Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
    try { return [file, createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex')]; }
    catch (error) {
      if (!readErrors) throw error;
      readErrors[file] = `${error.code ?? error.name}: ${error.message}`;
      return [file, null];
    }
  })));
  const hashes = await hashSources();
  const environmentFixture = await fixture();
  let sqlite;
  try {
    const [version] = await query(environmentFixture.client, 'SELECT sqlite_version() AS version');
    sqlite = { version: version.version };
    for (const name of ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout']) {
      const [value] = await query(environmentFixture.client, `PRAGMA ${name}`);
      sqlite[name] = Object.values(value)[0];
    }
  } finally { await close(environmentFixture); }
  const cases = [], latency = [];
  // One deterministic correctness run per predeclared combination; repeats are timing only.
  for (const spec of manifest()) for (const arm of ARMS) cases.push(await runCase(spec, arm));
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    const order = ARMS.map((_, i) => ARMS[(i + repetition) % ARMS.length]);
    for (const arm of order) {
      const r = await runCase(manifest()[0], arm);
      latency.push({ repetition, arm, caseId: r.caseId, completed: r.completed, final: r.final,
        cleanupMs: r.cleanupMs, verificationMs: r.verificationMs, totalMs: r.cleanupMs + r.verificationMs, error: r.error });
    }
  }
  const sinks = await errorSinkCases(), crashes = await crashCases();
  const readErrors = {}, afterHashes = await hashSources(readErrors);
  const sourceConsistency = { afterHashes, readErrors, changedFiles: sourceFiles.filter(file => hashes[file] !== afterHashes[file]) };
  const summary = ARMS.map(arm => {
    const selected = cases.filter(r => r.arm === arm), times = latency.filter(r => r.arm === arm && !r.error).map(r => r.totalMs);
    return { arm, cases: selected.length, completed: selected.filter(r => r.completed).length,
      falseCompletions: selected.filter(r => r.falseCompletion).length,
      resurrections: selected.filter(r => r.resurrection).length,
      safeCompletions: selected.filter(r => r.safeCompletion).length,
      finalResidues: selected.filter(r => r.final && !r.final.clean).length,
      keepViolations: selected.filter(r => r.final && !r.final.keepIntact).length,
      errors: selected.filter(r => r.error).length,
      latencySamples: times.length, p25Ms: quantile(times, .25), medianMs: quantile(times, .5), p75Ms: quantile(times, .75), p95Ms: quantile(times, .95) };
  });
  const report = {
    schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(),
    baselineCommit: '99c82924', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).trim(), hashes, sourceConsistency,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, sqlite },
    protocol: { casesPerArm: manifest().length, channels: CHANNELS, writers: WRITERS, otherWriters: OTHER_WRITERS, writeBoundary: WRITE_BOUNDARY,
      verifier: MEMORY_DELETION_VERIFIER, arms: ARMS, repetitions: options.repetitions, manifest: manifest(),
      latency: 'Fresh file/connection cloned from initialized schema; same loaded process. Excludes schema, fixture, late write and oracle, including all writer guards. Includes cleanup plus optional verification. Cleanup-only and guarded-cleanup execute the identical timed cleanup path. Rotating arm order, no process or disk-cache cold-start claim.',
      oracle: 'Independent SQL observations of 8 logical stores, including exactly one scrubbed target tombstone, evidence across all target revisions, an allowlisted Outbox tombstone payload, and exact keep-row snapshots; not physical-page erasure or model behavior.',
      statistics: 'Linear interpolation at index (n-1)*p (Hyndman-Fan type 7). Descriptive local timing quantiles; no confidence intervals or iid correctness interpretation.',
      crashProbes: 'SIGKILL after two manual uncommitted SQL writes, or after production clean() commits; first probe tests a representative SQLite transaction, not interruption inside production clean().' },
    summary, cases, latency, errorSinks: sinks, crashes,
    limitations: ['Finite deterministic schedules, not exhaustive concurrency or model checking.', WRITE_BOUNDARY, 'Arms are component ablations, not measured competing frameworks.', 'Synthetic two-record fixture; no real model, semantic unlearning, cache, backup, or secure page erasure.', 'Omission mutations are deliberate research SQL, not normal product operations.', 'Two SIGKILL barriers probe selected committed/uncommitted boundaries, not general crash consistency.', 'Timing excludes writer guards; cleanup-only and guarded-cleanup have the identical timed path.', 'Timing samples are local descriptive measurements; correctness schedules are not iid statistical samples.'],
  };
  return persistReport(report, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await run(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ summary: report.summary, errorSinks: report.errorSinks.map(r => ({ method: r.method, implementation: r.implementation, resurrection: r.resurrection, error: r.error })), crashes: report.crashes }, null, 2));
  const unexpected = report.cases.some(r =>
    r.error || (r.arm === 'verified-guarded' && (r.falseCompletion || r.resurrection)) ||
    (['guarded-cleanup', 'verified-guarded'].includes(r.arm) && !r.omission && !r.safeCompletion));
  if (unexpected || report.latency.some(r => r.error) || report.errorSinks.some(r => r.error || (r.implementation === 'patched-production' && r.resurrection)) || report.crashes.some(r => !r.passed)) process.exitCode = 1;
}
