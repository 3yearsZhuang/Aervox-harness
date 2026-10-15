import {
  createInMemoryDatabase, createDatabase, initDatabaseSchema,
  SqliteMemoryRepository, SqliteMemoryDeletionStore, SqliteMemoryEmbeddingRepository,
  SqliteMemoryCompactionRepository, SqliteOutboxRepository, indexMemoryFts,
} from '../../packages/repositories/dist/index.js';

export const LOCAL = { workspaceId: 'local', subjectUserId: 'local' };
export const CHANNELS = ['fts', 'vector', 'summary', 'audit', 'outbox'];
export const ARMS = ['soft-delete', 'cleanup-only', 'guarded-cleanup', 'verified-guarded'];
const NOW = '2026-10-15T00:00:00.000Z';
export const query = async (client, sql, args = []) => (await client.execute({ sql, args })).rows;

export async function fixture(url) {
  const f = url ? await createDatabase({ url }) : await createInMemoryDatabase();
  if (url) await initDatabaseSchema(f.client);
  f.memory = new SqliteMemoryRepository(f.db, f.client);
  f.store = new SqliteMemoryDeletionStore(f.db);
  f.embedding = new SqliteMemoryEmbeddingRepository(f.db);
  f.compaction = new SqliteMemoryCompactionRepository(f.db);
  f.outbox = new SqliteOutboxRepository(f.db);
  for (const id of ['target', 'keep']) {
    await f.memory.createRecord(LOCAL, { id, layer: 'long_term', type: 'user_fact', content: `privateword ${id}` });
    await query(f.client, 'INSERT INTO memory_revisions(id,memory_id,content,created_at) VALUES(?,?,?,?)', [`rev_${id}`, id, `revision ${id}`, NOW]);
    await query(f.client, 'INSERT INTO memory_evidence(id,memory_revision_id,source_artifact_id,source_revision_id,source_range,created_at) VALUES(?,?,?,?,?,?)', [`ev_${id}`, `rev_${id}`, `src_${id}`, `sr_${id}`, `range ${id}`, NOW]);
    for (const channel of CHANNELS) await write(f, channel, id, 'seed', true);
  }
  // The simulated worker has fetched these bytes before deletion begins.
  f.fetched = structuredClone((await f.outbox.getEventById('outbox_target_seed')).payload);
  f.keepBefore = await snapshot(f, 'keep');
  return f;
}

export async function write(f, channel, id, suffix, guarded) {
  const key = `${channel}_${id}_${suffix}`;
  // Keep observer ownership outside SQLite so malformed cleanup cannot hide an
  // already known event merely by removing memoryId from its payload.
  if (channel === 'outbox') {
    f.outboxIds ??= {};
    f.outboxIds[id] ??= [];
    if (!f.outboxIds[id].includes(key)) f.outboxIds[id].push(key);
  }
  const text = id === 'target' && suffix === 'late'
    ? `${f.fetched.summaryText} derived:${suffix}`
    : `privateword ${id} ${suffix}`;
  if (guarded) {
    if (channel === 'fts') return indexMemoryFts(f.client, LOCAL, { id, content: text });
    if (channel === 'vector') return f.embedding.insertBatch(LOCAL, [{ id: key, memoryId: id, vector: [1, 0], modelId: key }]);
    if (channel === 'summary') return f.compaction.upsertMarker(LOCAL, { id: key, memoryId: id, snapshotId: key, summaryText: text });
    if (channel === 'audit') return f.compaction.recordEvent(LOCAL, { id: key, memoryId: id, action: 'compressed', reason: text });
    if (channel === 'outbox') return f.outbox.insertEvent(LOCAL, { id: key, idempotencyKey: key, eventType: 'memory.compaction.requested', payload: { memoryId: id, snapshotId: key, summaryText: text } });
    throw new Error(`unknown channel: ${channel}`);
  }
  if (channel === 'fts') {
    await query(f.client, 'DELETE FROM memories_fts WHERE id=?', [id]);
    return query(f.client, 'INSERT INTO memories_fts(id,content) VALUES(?,?)', [id, text]);
  }
  if (channel === 'vector') return query(f.client, 'INSERT INTO memory_embeddings(id,memory_id,dimension,model_id,embedding_json,created_at,updated_at) VALUES(?,?,2,?,?,?,?)', [key, id, key, '[1,0]', NOW, NOW]);
  if (channel === 'summary') return query(f.client, 'INSERT INTO memory_compaction_markers(id,memory_id,snapshot_id,summary_text,created_at,updated_at) VALUES(?,?,?,?,?,?)', [key, id, key, text, NOW, NOW]);
  if (channel === 'audit') return query(f.client, 'INSERT INTO memory_events(id,memory_id,action,reason,created_at) VALUES(?,?,?,?,?)', [key, id, 'compressed', text, NOW]);
  if (channel === 'outbox') return query(f.client, 'INSERT INTO outbox_events(id,idempotency_key,event_type,payload,status,created_at) VALUES(?,?,?,?,?,?)', [key, key, 'memory.compaction.requested', JSON.stringify({ memoryId: id, snapshotId: key, summaryText: text }), 'pending', NOW]);
  throw new Error(`unknown channel: ${channel}`);
}

export async function clean(f, arm, omit = null) {
  if (arm === 'soft-delete') return query(f.client, 'UPDATE memory_records SET is_deleted=1 WHERE id=?', ['target']);
  if (!omit) return f.store.clean('target');
  // Explicit omission mutation: a research fixture, never installed in the product.
  const statements = [
    [null, "UPDATE memory_records SET is_deleted=1,content='',keywords_json=NULL,canonical_parent_id=NULL,source_turn_id=NULL,current_revision_id=NULL,verification_status='invalidated' WHERE id='target'"],
    [null, "UPDATE memory_revisions SET content='' WHERE memory_id='target'"],
    [null, "UPDATE memory_evidence SET status='tombstoned',source_range=NULL WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id='target')"],
    ['fts', "DELETE FROM memories_fts WHERE id='target'"],
    ['vector', "DELETE FROM memory_embeddings WHERE memory_id='target'"],
    ['summary', "UPDATE memory_compaction_markers SET summary_text=NULL,status='tombstoned' WHERE memory_id='target'"],
    ['audit', "UPDATE memory_events SET reason=NULL WHERE memory_id='target'"],
    ['outbox', "UPDATE outbox_events SET payload=json_object('memoryId','target','deleted',json('true')),status='published',last_error=NULL WHERE json_extract(payload,'$.memoryId')='target'"],
  ];
  await f.client.batch(statements.filter(([channel]) => channel !== omit).map(([, sql]) => sql), 'write');
}

export async function snapshot(f, id) {
  const outboxIds = f.outboxIds?.[id] ?? [];
  const groups = {
    record: ['SELECT * FROM memory_records WHERE id=? ORDER BY id', id],
    revisions: ['SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY id', id],
    evidence: ['SELECT * FROM memory_evidence WHERE memory_revision_id IN (SELECT id FROM memory_revisions WHERE memory_id=?) ORDER BY id', id],
    fts: ['SELECT id,content FROM memories_fts WHERE id=? ORDER BY content', id],
    vector: ['SELECT * FROM memory_embeddings WHERE memory_id=? ORDER BY id', id],
    summary: ['SELECT * FROM memory_compaction_markers WHERE memory_id=? ORDER BY id', id],
    audit: ['SELECT * FROM memory_events WHERE memory_id=? ORDER BY id', id],
    outbox: ["SELECT * FROM outbox_events WHERE CASE WHEN json_valid(payload) THEN json_extract(payload,'$.memoryId') END=?" +
      (outboxIds.length ? ` OR id IN (${outboxIds.map(() => '?').join(',')})` : '') + ' ORDER BY id', [id, ...outboxIds]],
  };
  return Object.fromEntries(await Promise.all(Object.entries(groups).map(async ([k, [sql, arg]]) => [k, await query(f.client, sql, Array.isArray(arg) ? arg : [arg])])));
}

/** Independent row observations: deliberately does not call production verify(). */
export async function oracle(f) {
  const s = await snapshot(f, 'target');
  const residue = {
    // This protocol retains one scrubbed identity tombstone. An accidentally
    // missing record must not pass vacuously merely because filter() is empty.
    record: Math.abs(s.record.length - 1) + s.record.filter(r => r.is_deleted !== 1 || r.content !== '' || r.keywords_json !== null || r.canonical_parent_id !== null || r.source_turn_id !== null || r.current_revision_id !== null || r.verification_status !== 'invalidated').length,
    revisions: s.revisions.filter(r => r.content !== '').length,
    evidence: s.evidence.filter(r => r.source_range !== null || r.status !== 'tombstoned').length,
    fts: s.fts.length,
    vector: s.vector.length,
    summary: s.summary.filter(r => r.summary_text !== null || r.status !== 'tombstoned').length,
    audit: s.audit.filter(r => r.reason !== null).length,
    // The deletion payload is a small identity tombstone. Checking only the
    // former summaryText key would miss content retained under another key.
    outbox: s.outbox.filter(r => {
      let p;
      try { p = JSON.parse(r.payload); } catch { return true; }
      if (!p || Array.isArray(p) || typeof p !== 'object') return true;
      return p.deleted !== true || p.memoryId !== 'target' ||
        Object.keys(p).some(key => !['memoryId', 'snapshotId', 'deleted'].includes(key)) ||
        (p.snapshotId !== undefined && p.snapshotId !== null && typeof p.snapshotId !== 'string') ||
        r.status !== 'published' || r.last_error !== null;
    }).length,
  };
  return {
    residue, clean: Object.values(residue).every(n => n === 0),
    keepIntact: JSON.stringify(await snapshot(f, 'keep')) === JSON.stringify(f.keepBefore),
  };
}

export async function close(f) {
  if (f.cleanup) await f.cleanup(); else f.client.close();
}
