import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, statfs } from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryRevisions } from '../../packages/schema/dist/index.js';
import { assertMemoryWriteAvailable } from '../../packages/repositories/dist/repositories/sqlite/memory-write-guard.js';
import { fixture, query, oracle, close, LOCAL } from './fixture.mjs';
import { COST_CONFIGURATIONS, COST_GUARD_MODES } from './cost-protocol.mjs';

const NOW = '2026-10-26T00:00:00.000Z';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Both arms share this entire wrapper, transaction, values and RETURNING path.
// The enabled arm calls the production guard. The production API is untouched.
export async function appendCostRevision(db, ctx, revisionData, guardEnabled) {
  void ctx;
  return db.transaction(async tx => {
    if (guardEnabled) await assertMemoryWriteAvailable(tx, revisionData.memoryId);
    const [created] = await tx.insert(memoryRevisions).values({
      id: revisionData.id, memoryId: revisionData.memoryId, content: revisionData.content,
      confidence: revisionData.confidence ?? 0, importance: revisionData.importance ?? 0,
      algorithmVersion: revisionData.algorithmVersion ?? null, createdAt: new Date().toISOString(),
    }).returning();
    return created;
  });
}

async function environment(client, directory) {
  const pragmas = {};
  for (const name of ['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout']) {
    pragmas[name] = Object.values((await query(client, `PRAGMA ${name}`))[0])[0];
  }
  return { node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, kernel: release(), filesystemType: (await statfs(directory)).type,
    sqliteVersion: (await query(client, 'SELECT sqlite_version() AS version'))[0].version,
    clientVersion: JSON.parse(await readFile(new URL('../../packages/repositories/node_modules/@libsql/client/package.json', import.meta.url), 'utf8')).version,
    pragmas };
}

async function backgrounds(f) {
  const specs = {
    record: "SELECT * FROM memory_records WHERE id GLOB 'cost-background-*' ORDER BY id",
    revisions: "SELECT * FROM memory_revisions WHERE memory_id GLOB 'cost-background-*' ORDER BY id",
    evidence: "SELECT * FROM memory_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id GLOB 'cost-background-*') ORDER BY id",
    fts: "SELECT id,content FROM memories_fts WHERE id GLOB 'cost-background-*' ORDER BY id,content",
    vector: "SELECT * FROM memory_embeddings WHERE memory_id GLOB 'cost-background-*' ORDER BY id",
    summary: "SELECT * FROM memory_compaction_markers WHERE memory_id GLOB 'cost-background-*' ORDER BY id",
    audit: "SELECT * FROM memory_events WHERE memory_id GLOB 'cost-background-*' ORDER BY id",
    outbox: "SELECT * FROM outbox_events WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.memoryId') END GLOB 'cost-background-*' ORDER BY id",
  };
  const rows = Object.fromEntries(await Promise.all(Object.entries(specs).map(async ([key, sql]) => [key, await query(f.client, sql)])));
  return { hash: digest(rows), counts: Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.length])) };
}

async function seedScale(f, configuration) {
  const content = 'x'.repeat(configuration.contentBytes);
  const statements = [
    { sql: "UPDATE memory_records SET content=? WHERE id='target'", args: [content] },
    { sql: "UPDATE memory_revisions SET content=? WHERE id='rev_target'", args: [content] },
    { sql: "UPDATE memory_evidence SET source_range=? WHERE id='ev_target'", args: [content] },
  ];
  for (let i = 0; i < configuration.backgroundRecords; i++) statements.push({
    sql: 'INSERT INTO memory_records(id,layer,type,content,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    args: [`cost-background-${i}`, 'long_term', 'user_fact', content, NOW, NOW],
  });
  for (let i = 1; i < configuration.targetRevisions; i++) {
    statements.push({ sql: 'INSERT INTO memory_revisions(id,memory_id,content,created_at) VALUES(?,?,?,?)', args: [`cost-revision-${i}`, 'target', content, NOW] });
    statements.push({ sql: 'INSERT INTO memory_evidence(id,memory_revision_id,source_artifact_id,source_revision_id,source_range,created_at) VALUES(?,?,?,?,?,?)', args: [`cost-evidence-${i}`, `cost-revision-${i}`, 'source', 'source-rev', content, NOW] });
  }
  for (let i = 0; i < statements.length; i += 200) await f.client.batch(statements.slice(i, i + 200), 'write');
  return { backgrounds: await backgrounds(f),
    revisions: Number((await query(f.client, "SELECT count(*) AS n FROM memory_revisions WHERE memory_id='target'"))[0].n),
    evidence: Number((await query(f.client, "SELECT count(*) AS n FROM memory_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id='target')"))[0].n),
    contentLengths: (await query(f.client, "SELECT min(length(CAST(content AS BLOB))) AS minimum,max(length(CAST(content AS BLOB))) AS maximum FROM memory_revisions WHERE memory_id='target'"))[0],
  };
}

export async function runCostSample(unit) {
  const row = { ...unit, pid: process.pid, status: 'failed', error: null };
  let directory, f;
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'aervox-deletion-cost-'));
    row.databaseId = path.basename(directory);
    f = await fixture(`file:${path.join(directory, 'sample.db')}`);
    row.environment = await environment(f.client, directory);
    if (unit.kind === 'scale') {
      const configuration = COST_CONFIGURATIONS.find(value => value.id === unit.configuration);
      if (!configuration) throw new Error('unknown scale configuration');
      row.parameters = configuration;
      row.before = await seedScale(f, configuration);
      let start = performance.now();
      await f.store.clean('target');
      row.cleanupMs = performance.now() - start;
      start = performance.now();
      try { row.proof = JSON.parse(await f.store.verify('target')); }
      catch (error) {
        if (error.message !== 'deletion_memory_verification_failed') throw error;
        row.status = 'blocked'; row.error = error.message;
      } finally { row.verificationMs = performance.now() - start; }
      row.after = { backgrounds: await backgrounds(f) };
      row.final = await oracle(f);
      if (row.error === null && row.final.clean && row.final.keepIntact && row.before.backgrounds.hash === row.after.backgrounds.hash) row.status = 'completed';
      else if (row.error === null) throw new Error('scale deletion or preservation observation failed');
    } else if (unit.kind === 'guard') {
      if (!COST_GUARD_MODES.includes(unit.mode)) throw new Error('unknown guard mode');
      const enabled = unit.mode === 'guard-enabled';
      const data = { id: 'cost-timed-revision', memoryId: 'target', content: 'x'.repeat(1024) };
      const start = performance.now();
      row.returned = await appendCostRevision(f.db, LOCAL, data, enabled);
      row.writeMs = performance.now() - start;
      const [persisted] = await query(f.client, 'SELECT * FROM memory_revisions WHERE id=?', [data.id]);
      row.persisted = persisted?.content === data.content && persisted?.memory_id === data.memoryId;
      await f.store.clean('target');
      row.proof = JSON.parse(await f.store.verify('target'));
      row.final = await oracle(f);
      // A separate calibration outside the measured interval confirms that the
      // enabled reconstruction rejects a tombstone; disabled mode may write and
      // is then cleaned again. This is not a production deletion safety claim.
      row.atCompletion = row.final;
      row.lateRejected = false;
      try { await appendCostRevision(f.db, LOCAL, { ...data, id: 'cost-late-revision' }, enabled); }
      catch (error) {
        if (enabled && error.message === 'memory_write_target_unavailable') row.lateRejected = true;
        else throw error;
      }
      row.afterLate = await oracle(f);
      await f.store.clean('target');
      await f.store.verify('target');
      row.afterRecleanup = await oracle(f);
      if (!row.persisted || !row.final.clean || !row.final.keepIntact || !row.afterRecleanup.clean || !row.afterRecleanup.keepIntact || row.lateRejected !== enabled || row.afterLate.clean !== enabled) throw new Error('guard calibration or persistence failed');
      row.status = 'completed';
    } else throw new Error('unknown sample kind');
  } catch (error) { row.status = row.status === 'blocked' ? 'blocked' : 'failed'; row.error = `${error.name}: ${error.message}`; row.stack = error.stack; }
  finally {
    try { if (f) await close(f); if (directory) await rm(directory, { recursive: true, force: true }); }
    catch (error) { row.status = 'failed'; row.error = `cleanup: ${error.name}: ${error.message}`; }
  }
  return row;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const row = await runCostSample(JSON.parse(process.argv[2]));
  if (process.send) process.send({ type: 'result', row }, () => { process.disconnect(); process.exitCode = row.status === 'completed' ? 0 : 1; });
  else { console.log(JSON.stringify(row)); process.exitCode = row.status === 'completed' ? 0 : 1; }
}
