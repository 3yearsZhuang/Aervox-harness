import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const metadata = {
  project: 'LangChain.js community LibSQLVectorStore',
  version: '@langchain/community@1.1.29',
  repository: 'https://github.com/langchain-ai/langchainjs-community',
  evidenceClass: 'application-contract',
  rootCause: 'late-ingest-after-delete',
  discoveryFiles: ['@langchain/community/vectorstores/libsql'],
  limitations: [
    'Pinned historical community integration; its upstream repository was archived on 2026-05-27.',
    'The research application requires no later writes for a deleted owner. The upstream delete(ids) API does not promise to cancel pending ingestion or install a tombstone; violations are application-contract counterexamples, not confirmed upstream bugs.',
    'Embeddings are deterministic local synthetic vectors. No language-model service, semantic forgetting, retrieval-quality evaluation or arbitrary process/crash interleaving is exercised.',
    'Ownership is fixture metadata, supplied manually by this adapter. Observation covers committed rows in the local vectors table, not WAL bytes, backups or third-party stores.',
  ],
};

const event = (site, operation, kind, phase, result) => ({
  site, actor: 'producer', operation, kind, phase, entity: 'target',
  ...(result ? { result } : {}),
});

export async function createAdapter() {
  const [{ createClient }, { LibSQLVectorStore }, { Document }] = await Promise.all([
    import('@libsql/client'),
    import('@langchain/community/vectorstores/libsql'),
    import('@langchain/core/documents'),
  ]);
  return {
    id: 'langchain-libsql',
    checkedStores: ['vectorRows'],
    async open(seed, { signal } = {}) {
      const directory = await mkdtemp(path.join(tmpdir(), 'deletion-fault-langchain-'));
      const db = createClient({ url: `file:${path.join(directory, 'vectors.db')}` });
      const state = { directory, db, signal, checkpoint: null, owner: `target:${seed}`, keepOwner: `keep:${seed}` };
      try {
        signal?.throwIfAborted();
        await db.execute('CREATE TABLE vectors (content TEXT NOT NULL, metadata TEXT NOT NULL, embedding F32_BLOB(3))');
        const embeddings = {
          async embedDocuments(texts) {
            if (state.checkpoint) {
              await state.checkpoint(event('langchain.embedding.captured', 'addDocuments', 'read', 'after'));
              await state.checkpoint(event('langchain.embedding.await', 'addDocuments', 'yield', 'before'));
            }
            // Real library ingestion is retained; only the external model is replaced.
            await Promise.resolve();
            const vectors = texts.map(text => [1, text.length / 1000, 0.5]);
            if (state.checkpoint) await state.checkpoint(event('langchain.embedding.await', 'addDocuments', 'yield', 'after'));
            return vectors;
          },
          async embedQuery(text) { return [1, text.length / 1000, 0.5]; },
        };
        state.store = new LibSQLVectorStore(embeddings, { db, table: 'vectors' });
        const addVectors = state.store.addVectors.bind(state.store);
        state.store.addVectors = async (vectors, documents) => {
          if (state.checkpoint) await state.checkpoint(event('langchain.addVectors', 'addVectors', 'write', 'before'));
          const result = await addVectors(vectors, documents);
          if (state.checkpoint) await state.checkpoint(event('langchain.addVectors', 'addVectors', 'write', 'after', 'accepted'));
          return result;
        };
        await state.store.addDocuments([
          new Document({ pageContent: `synthetic target ${seed}`, metadata: { owner: state.owner, generation: 'source' } }),
          new Document({ pageContent: `synthetic keep ${seed}`, metadata: { owner: state.keepOwner, generation: 'source' } }),
        ]);
        signal?.throwIfAborted();
        return state;
      } catch (error) {
        db.close();
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    async produce(state, checkpoint) {
      state.signal?.throwIfAborted();
      const rows = await state.db.execute({
        sql: "SELECT content FROM vectors WHERE json_extract(metadata, '$.owner') = :owner ORDER BY rowid LIMIT 1",
        args: { owner: state.owner },
      });
      if (!rows.rows[0]) throw new Error('missing synthetic source');
      const captured = String(rows.rows[0].content);
      state.checkpoint = checkpoint;
      try {
        await checkpoint(event('langchain.source.captured', 'execute', 'read', 'after'));
        await state.store.addDocuments([new Document({
          pageContent: `${captured}; synthetic derived`,
          metadata: { owner: state.owner, generation: 'derived' },
        })]);
      } finally { state.checkpoint = null; }
    },
    async remove(state) {
      state.signal?.throwIfAborted();
      const existing = await state.db.execute({
        sql: "SELECT rowid AS id FROM vectors WHERE json_extract(metadata, '$.owner') = :owner ORDER BY rowid",
        args: { owner: state.owner },
      });
      await state.store.delete({ ids: existing.rows.map(row => String(row.id)) });
    },
    async observe(state) {
      state.signal?.throwIfAborted();
      const result = await state.db.execute('SELECT rowid AS id, content, metadata, hex(embedding) AS vector FROM vectors ORDER BY rowid');
      const rows = result.rows.map(row => ({
        id: String(row.id), content: String(row.content), metadata: JSON.parse(String(row.metadata)), vector: String(row.vector),
      }));
      return {
        residue: { vectorRows: rows.filter(row => row.metadata.owner === state.owner).length },
        keepSnapshot: rows.filter(row => row.metadata.owner === state.keepOwner),
      };
    },
    async close(state) {
      state.checkpoint = null;
      state.db.close();
      await rm(state.directory, { recursive: true, force: true });
    },
  };
}
