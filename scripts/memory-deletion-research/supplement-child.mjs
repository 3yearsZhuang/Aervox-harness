import { performance } from 'node:perf_hooks';
import { release, cpus, tmpdir } from 'node:os';
import { statfs, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createDatabase, SqliteMemoryDeletionStore, SqlitePrivacyRepository,
  SqlitePlatformRepository, SqliteMemoryCompactionRepository, SqliteOutboxRepository,
} from '../../packages/repositories/dist/index.js';
import { runDeletionCycle } from '../../apps/worker/dist/deletion-worker.js';
import { runCompactionMarkerCycle } from '../../apps/worker/dist/compaction-marker.js';
import { fixture, query, oracle, close, LOCAL } from './fixture.mjs';

// Instrument only this research process. Production source and transaction
// boundaries are unchanged; barriers wait after the actual awaited operation.
async function barrier(name) {
  process.send({ type: 'barrier', name });
  await new Promise(resolve => process.once('message', message => {
    if (message?.type === 'continue') resolve();
  }));
}

function observedQuery(builder, after) {
  return new Proxy(builder, { get(target, property) {
    if (property === 'then') return (resolve, reject) => target.then(async value => { await after(); return value; }).then(resolve, reject);
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? (...args) => observedQuery(value.apply(target, args), after) : value;
  } });
}

function observedTransactions(db, mode, stage) {
  let mutations = 0, selected = false;
  return new Proxy(db, { get(target, property) {
    if (property === 'transaction') return callback => target.transaction(tx => callback(new Proxy(tx, { get(writer, key) {
      if (key === 'run') return async (...args) => {
        const result = await writer.run(...args);
        if (mode === 'crash' && stage === `clean-mutation-${++mutations}`) await barrier(stage);
        return result;
      };
      if (key === 'update') return (...args) => observedQuery(writer.update(...args), async () => {
        if (mode === 'crash' && stage === `clean-mutation-${++mutations}`) await barrier(stage);
      });
      if (key === 'select' && mode === 'guard') return (...args) => observedQuery(writer.select(...args), async () => {
        if (!selected) { selected = true; await barrier('guard-holds-writer'); }
      });
      const value = Reflect.get(writer, key, writer);
      return typeof value === 'function' ? value.bind(writer) : value;
    } })));
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function environment(client, directory) {
  const sqliteVersion = (await query(client, 'SELECT sqlite_version() AS version'))[0].version;
  const pragmas = {};
  for (const name of ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout']) {
    pragmas[name] = Object.values((await query(client, `PRAGMA ${name}`))[0])[0];
  }
  return { node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, kernel: release(), sqliteVersion,
    clientVersion: JSON.parse(await readFile(new URL('../../packages/repositories/node_modules/@libsql/client/package.json', import.meta.url), 'utf8')).version,
    filesystemType: (await statfs(directory)).type, pragmas };
}

async function crash(url, stage) {
  const f = await createDatabase({ url });
  const db = observedTransactions(f.db, 'crash', stage);
  if (stage.startsWith('clean-mutation-') || stage === 'after-clean-commit') {
    await new SqliteMemoryDeletionStore(db).clean('target');
    if (stage === 'after-clean-commit') await barrier(stage);
    throw new Error(`unreached crash barrier ${stage}`);
  }
  const privacy = new SqlitePrivacyRepository(db);
  const targetStatus = privacy.updateDeletionTargetStatus.bind(privacy);
  privacy.updateDeletionTargetStatus = async (...args) => {
    if (stage === 'before-target-proof' && args[1] === 'completed') await barrier(stage);
    const result = await targetStatus(...args);
    if (stage === 'after-target-proof' && args[1] === 'completed') await barrier(stage);
    return result;
  };
  const requestStatus = privacy.updateDeletionRequestStatus.bind(privacy);
  privacy.updateDeletionRequestStatus = async (...args) => {
    const result = await requestStatus(...args);
    if (stage === 'after-request-complete' && args[2] === 'completed') await barrier(stage);
    return result;
  };
  await runDeletionCycle({ db, privacyRepo: privacy, platformRepo: new SqlitePlatformRepository(db), workerId: 'crash-probe' });
  throw new Error(`unreached worker crash barrier ${stage}`);
}

async function concurrent(url, schedule) {
  const f = await createDatabase({ url });
  try {
    const db = schedule === 'guard-holds-writer' ? observedTransactions(f.db, 'guard', schedule) : f.db;
    const outbox = new SqliteOutboxRepository(db);
    const compaction = new SqliteMemoryCompactionRepository(db);
    const fetch = outbox.fetchPendingEvents.bind(outbox);
    outbox.fetchPendingEvents = async options => {
      const events = (await fetch(options)).filter(event => event.payload.memoryId === 'target');
      if (schedule !== 'marker-before-delete' && schedule !== 'guard-holds-writer') await barrier('fetched');
      return events;
    };
    if (schedule === 'marker-before-delete') {
      const upsert = compaction.upsertMarker.bind(compaction);
      compaction.upsertMarker = async (...args) => { const value = await upsert(...args); await barrier('marker'); return value; };
    }
    if (schedule === 'cached-worker-error') compaction.upsertMarker = async (_ctx, marker) => {
      throw new Error(`provider failed with ${marker.summaryText}`);
    };
    return { markers: await runCompactionMarkerCycle({ outboxRepo: outbox, compactionRepo: compaction, workerId: `probe-${process.pid}` }) };
  } finally { f.client.close(); }
}

async function scale(profile, repetition) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aervox-deletion-scale-'));
  const f = await fixture(`file:${path.join(directory, 'scale.db')}`);
  try {
    const content = 'x'.repeat(profile.contentBytes);
    const statements = [];
    for (let i = 0; i < profile.backgroundRecords; i++) statements.push({
      sql: 'INSERT INTO memory_records(id,layer,type,content,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      args: [`background_${i}`, 'long_term', 'user_fact', content, '2026-10-18', '2026-10-18'],
    });
    for (let i = 1; i < profile.targetRevisions; i++) {
      statements.push({ sql: 'INSERT INTO memory_revisions(id,memory_id,content,created_at) VALUES(?,?,?,?)', args: [`scale_rev_${i}`, 'target', content, '2026-10-18'] });
      statements.push({ sql: 'INSERT INTO memory_evidence(id,memory_revision_id,source_artifact_id,source_revision_id,source_range,created_at) VALUES(?,?,?,?,?,?)', args: [`scale_ev_${i}`, `scale_rev_${i}`, 'source', 'source-rev', content, '2026-10-18'] });
    }
    for (let i = 0; i < statements.length; i += 200) await f.client.batch(statements.slice(i, i + 200), 'write');
    const backgrounds = () => query(f.client, "SELECT * FROM memory_records WHERE id LIKE 'background_%' ORDER BY id");
    const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const backgroundBefore = digest(await backgrounds());
    const revisionsBefore = Number((await query(f.client, "SELECT count(*) AS n FROM memory_revisions WHERE memory_id='target'"))[0].n);
    const start = performance.now(); await f.store.clean('target'); const cleaned = performance.now();
    await f.store.verify('target'); const verified = performance.now();
    const backgroundAfter = digest(await backgrounds());
    return { profile: profile.id, repetition, pid: process.pid, error: null,
      cleanupMs: cleaned - start, verificationMs: verified - cleaned, revisionsBefore,
      backgroundBefore, backgroundAfter, backgroundIntact: backgroundBefore === backgroundAfter ? profile.backgroundRecords : 0,
      final: await oracle(f), environment: await environment(f.client, directory) };
  } finally { await close(f); await rm(directory, { recursive: true, force: true }); }
}

const [mode, urlOrProfile, stage] = process.argv.slice(2);
try {
  const result = mode === 'crash' ? await crash(urlOrProfile, stage)
    : mode === 'concurrent' ? await concurrent(urlOrProfile, stage)
    : mode === 'scale' ? await scale(JSON.parse(urlOrProfile), Number(stage))
    : (() => { throw new Error('unknown child mode'); })();
  process.send({ type: 'result', result }, () => process.disconnect());
} catch (error) {
  process.send({ type: 'failure', error: `${error.name}: ${error.message}`, stack: error.stack }, () => { process.disconnect(); process.exitCode = 1; });
}
