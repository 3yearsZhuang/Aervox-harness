#!/usr/bin/env node
import { fork, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, SqliteMemoryDeletionStore, SqlitePrivacyRepository, SqlitePlatformRepository } from '../../packages/repositories/dist/index.js';
import { runDeletionCycle } from '../../apps/worker/dist/deletion-worker.js';
import { fixture, close, oracle, snapshot, query, LOCAL } from './fixture.mjs';
import { REQUIRED_SOURCE_FILES } from './validate-report.mjs';
import { CRASH_STAGES, CONCURRENT_SCHEDULES, SCALE_PROFILES, validateSupplement } from './validate-supplement.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./supplement-child.mjs', import.meta.url));

function childSession(args) {
  const child = fork(CHILD, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', failure, waiting, exited;
  const messages = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => { child.once('exit', (code, signal) => { exited = { code, signal }; resolve(exited); }); });
  child.on('error', error => { failure = error; waiting?.reject(error); });
  child.on('message', message => {
    if (message.type === 'failure') { failure = new Error(message.error); waiting?.reject(failure); }
    else if (waiting?.type === message.type) { const current = waiting; waiting = null; current.resolve(message); }
    else messages.push(message);
  });
  child.on('exit', () => {
    if (waiting) { waiting.reject(failure ?? new Error(`child exited ${JSON.stringify(exited)}: ${stderr}`)); waiting = null; }
  });
  return {
    child, exit,
    next(type) {
      if (failure) return Promise.reject(failure);
      const index = messages.findIndex(message => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (exited) return Promise.reject(new Error(`child exited before ${type}: ${stderr}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting = null; child.kill('SIGKILL'); reject(new Error(`child ${type} timeout: ${stderr}`)); }, 30_000);
        waiting = { type, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      });
    },
    resume() { child.send({ type: 'continue' }); },
    async stop() { if (!exited) child.kill('SIGKILL'); await exit; },
  };
}

function workerContext(f) {
  return { memoryDeletion: new SqliteMemoryDeletionStore(f.db), privacyRepo: new SqlitePrivacyRepository(f.db), platformRepo: new SqlitePlatformRepository(f.db), workerId: 'supplement' };
}
async function request(f) {
  await new SqlitePrivacyRepository(f.db).createDeletionRequest(LOCAL, {
    id: 'request', idempotencyKey: 'request', scope: 'memory', ownerModule: 'memory',
    targets: [{ targetType: 'memory', targetId: 'target', ownerModule: 'memory' }],
  });
}
async function reopen(url, state) {
  const f = await createDatabase({ url, busyTimeoutMs: 40, busyRetry: { enabled: false } });
  Object.assign(f, state, { store: new SqliteMemoryDeletionStore(f.db) });
  return f;
}

export async function crashProbe(stage) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-production-crash-'));
  const url = `file:${path.join(directory, 'probe.db')}`;
  const row = { stage, error: null };
  let f, session;
  try {
    f = await fixture(url); await request(f);
    const state = { keepBefore: f.keepBefore, outboxIds: f.outboxIds };
    const before = JSON.stringify(await snapshot(f, 'target'));
    await close(f); f = null;
    session = childSession(['crash', url, stage]);
    row.barrier = (await session.next('barrier')).name;
    session.child.kill('SIGKILL'); Object.assign(row, await session.exit);
    f = await reopen(url, state);
    row.reopened = await oracle(f);
    row.rollbackIntact = JSON.stringify(await snapshot(f, 'target')) === before;
    const ctx = workerContext(f);
    row.pendingBeforeRetry = await ctx.privacyRepo.hasPendingDeletionRequest(LOCAL);
    row.retried = await runDeletionCycle(ctx);
    row.afterRetry = await oracle(f);
    row.pendingAfterRetry = await ctx.privacyRepo.hasPendingDeletionRequest(LOCAL);
    row.passed = row.afterRetry.clean && row.afterRetry.keepIntact && !row.pendingAfterRetry &&
      (stage.startsWith('clean-mutation-') ? row.rollbackIntact : row.reopened.clean);
  } catch (error) { row.error = `${error.name}: ${error.message}`; row.passed = false; }
  finally { if (session) await session.stop(); if (f) await close(f); await rm(directory, { recursive: true, force: true }); }
  return row;
}

export async function concurrentProbe(schedule) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-worker-race-'));
  const url = `file:${path.join(directory, 'probe.db')}`;
  const row = { schedule, error: null, workerProcesses: schedule === 'two-cached-workers' ? 2 : 1 };
  const sessions = [];
  let f;
  try {
    f = await fixture(url); await request(f);
    const state = { keepBefore: f.keepBefore, outboxIds: f.outboxIds };
    await close(f); f = await reopen(url, state);
    for (let i = 0; i < row.workerProcesses; i++) {
      const session = childSession(['concurrent', url, schedule]); sessions.push(session);
      const { name } = await session.next('barrier');
      if (name !== (schedule === 'marker-before-delete' ? 'marker' : schedule === 'guard-holds-writer' ? schedule : 'fetched')) throw new Error(`wrong concurrency barrier ${name}`);
    }
    const ctx = workerContext(f);
    if (schedule === 'guard-holds-writer') {
      // A real guarded transaction has read its source and still owns SQLite's
      // writer lock. Probe a competing production clean() without timer races.
      try { await f.store.clean('target'); throw new Error('competing cleanup unexpectedly acquired writer'); }
      catch (error) {
        if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/.test(String(error))) throw error;
        row.writerLockObserved = true;
      }
      row.firstDeletion = 0;
    } else row.firstDeletion = await runDeletionCycle(ctx);
    for (const session of sessions) session.resume();
    row.workers = [];
    for (const session of sessions) {
      row.workers.push((await session.next('result')).result);
      const exited = await session.exit;
      if (exited.code !== 0) throw new Error(`worker exit ${JSON.stringify(exited)}`);
    }
    row.deletionsCompleted = row.firstDeletion + await runDeletionCycle(ctx);
    row.final = await oracle(f);
    row.pending = await ctx.privacyRepo.hasPendingDeletionRequest(LOCAL);
    row.passed = row.deletionsCompleted === 1 && row.final.clean && row.final.keepIntact && !row.pending;
  } catch (error) { row.error = `${error.name}: ${error.message}`; row.passed = false; }
  finally { for (const session of sessions) await session.stop(); if (f) await close(f); await rm(directory, { recursive: true, force: true }); }
  return row;
}

async function writerTiming() {
  const f = await fixture(), rows = [];
  try {
    for (let repetition = 0; repetition < 12; repetition++) {
      const order = repetition % 2 ? ['guarded-production', 'legacy-select-insert'] : ['legacy-select-insert', 'guarded-production'];
      for (const mode of order) {
        const id = `timed-${mode}-${repetition}`;
        const start = performance.now();
        if (mode === 'guarded-production') await f.provenance.appendMemoryRevision(LOCAL, { id, memoryId: 'target', content: 'cached private text' });
        else {
          // Reconstruct the old public method, including SELECT and RETURNING.
          const [memory] = await query(f.client, "SELECT * FROM memory_records WHERE id='target'");
          if (!memory) throw new Error('legacy source missing');
          await query(f.client, 'INSERT INTO memory_revisions(id,memory_id,content,confidence,importance,algorithm_version,created_at) VALUES(?,?,?,0,0,NULL,?) RETURNING *', [id, 'target', 'cached private text', new Date().toISOString()]);
        }
        const ms = performance.now() - start;
        const [persisted] = await query(f.client, 'SELECT * FROM memory_revisions WHERE id=?', [id]);
        rows.push({ mode, repetition, ms, persisted: persisted?.content === 'cached private text' });
      }
    }
  } finally { await close(f); }
  return rows;
}

export async function runSupplement({ out, repetitions = 3 }) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('repetitions must be 1..10');
  try { await access(out); throw new Error('refusing to overwrite supplement report'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hashSources = async () => Object.fromEntries(await Promise.all(REQUIRED_SOURCE_FILES.map(async file => [file, createHash('sha256').update(await readFile(path.join(ROOT, file))).digest('hex')])));
  const hashes = await hashSources();
  const report = { schemaVersion: 1, kind: 'memory-deletion-production-probes', generatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    repetitions, profiles: SCALE_PROFILES, hashes, crashes: [], concurrency: [], scale: [], writerTiming: [],
    limitations: ['Named production boundaries and five schedules only; no exhaustive interleavings or power-loss test.',
      'Three synthetic size profiles change background size, target fanout and content length together; they do not isolate each factor.',
      'Fresh scale processes on one machine; file-system caches are uncontrolled.',
      'Writer timings compare reconstructed legacy SQL with the production API, including JavaScript abstraction and transaction overhead; they do not isolate the guard predicate cost.'],
  };
  for (const stage of CRASH_STAGES) report.crashes.push(await crashProbe(stage));
  for (const schedule of CONCURRENT_SCHEDULES) report.concurrency.push(await concurrentProbe(schedule));
  for (const profile of SCALE_PROFILES) for (let repetition = 0; repetition < repetitions; repetition++) {
    const session = childSession(['scale', JSON.stringify(profile), String(repetition)]);
    try {
      report.scale.push((await session.next('result')).result);
      const exited = await session.exit;
      if (exited.code !== 0) throw new Error(`scale exit ${JSON.stringify(exited)}`);
    } catch (error) { report.scale.push({ profile: profile.id, repetition, error: `${error.name}: ${error.message}` }); }
    finally { await session.stop(); }
  }
  report.writerTiming = await writerTiming();
  const readErrors = {};
  let afterHashes = {};
  try { afterHashes = await hashSources(); } catch (error) { readErrors.source = error.message; }
  report.sourceConsistency = { afterHashes, readErrors, changedFiles: REQUIRED_SOURCE_FILES.filter(file => hashes[file] !== afterHashes[file]) };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  try { validateSupplement(report); } catch (error) { error.message += `; raw evidence saved at ${out}`; throw error; }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = { repetitions: 3 };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--out=')) options.out = path.resolve(arg.slice(6));
    else if (arg.startsWith('--repetitions=')) options.repetitions = Number(arg.slice(14));
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.out) throw new Error('--out=<new-report.json> required');
  console.log(JSON.stringify(validateSupplement(await runSupplement(options)), null, 2));
}
