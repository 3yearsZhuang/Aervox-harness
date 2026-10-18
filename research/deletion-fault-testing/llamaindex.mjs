import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const metadata = {
  project: 'LlamaIndex.TS VectorStoreIndex with file-backed Simple stores',
  version: 'llamaindex@0.12.1 / @llamaindex/core@0.6.22',
  repository: 'https://github.com/run-llama/LlamaIndexTS',
  evidenceClass: 'application-contract',
  rootCause: 'late-ingest-after-delete',
  discoveryFiles: ['llamaindex/indices', 'llamaindex/vector-store', '@llamaindex/core/storage/doc-store'],
  limitations: [
    'Pinned historical package. The inspected upstream main package declares that it is no longer maintained; the installed 0.12.1 npm metadata itself does not declare deprecation.',
    'Planner-held-out subject, not an independent or blind replication: adapter API debugging is permitted and disclosed; planner selection rules must not be tuned against its oracle outcomes.',
    'The no-late-writes deletion contract belongs to this research application. Upstream delete methods do not promise to cancel pending ingestion, so counterexamples are not confirmed upstream bugs.',
    'The embedding model is a deterministic local synthetic implementation. The actual upstream insertNodes, vector/document/index stores, JSON persistence and public deletion methods are executed.',
    'The application composes VectorStoreIndex.deleteRefDoc and docStore.deleteRefDoc to remove both index/vector entries and referenced document nodes. It does not test a single public API as a standalone deletion guarantee.',
    'Ownership is manually supplied through deterministic fixture identifiers. Observation reloads the three JSON stores and excludes physical erasure, arbitrary raw writes, multiple writer processes and retrieval quality.',
  ],
};

const event = (site, operation, kind, phase, result) => ({
  site, actor: 'producer', operation, kind, phase, entity: 'target',
  ...(result ? { result } : {}),
});
const json = value => JSON.parse(JSON.stringify(value));
const selected = (record, keys) => Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => keys.has(key)));

export async function createAdapter({ deleteMode = 'composed' } = {}) {
  if (!['composed', 'index-api-only'].includes(deleteMode)) throw new TypeError('unknown LlamaIndex delete mode');
  const [llama, { BaseEmbedding }, { SimpleIndexStore }] = await Promise.all([
    import('llamaindex'),
    import('@llamaindex/core/embeddings'),
    import('@llamaindex/core/storage/index-store'),
  ]);
  const { Settings, VectorStoreIndex, SimpleVectorStore, SimpleDocumentStore, storageContextFromDefaults, TextNode, NodeRelationship, ModalityType } = llama;
  const logger = { log() {}, warn() {}, error() {} };
  return {
    id: deleteMode === 'composed' ? 'llamaindex-simple' : 'llamaindex-simple-index-api-only',
    deleteMode,
    checkedStores: ['vectors', 'documents', 'indexNodes'],
    async open(seed, { signal } = {}) {
      const directory = await mkdtemp(path.join(tmpdir(), 'deletion-fault-llamaindex-'));
      const state = {
        directory, signal, checkpoint: null,
        owner: `target:${seed}`, keepOwner: `keep:${seed}`,
        targetNodeId: `target-node:${seed}`, derivedNodeId: `target-derived:${seed}`, keepNodeId: `keep-node:${seed}`,
      };
      try {
        signal?.throwIfAborted();
        class SyntheticEmbedding extends BaseEmbedding {
          async getTextEmbedding(text) {
            if (state.checkpoint) {
              await state.checkpoint(event('llamaindex.embedding.captured', 'insertNodes', 'read', 'after'));
              await state.checkpoint(event('llamaindex.embedding.await', 'insertNodes', 'yield', 'before'));
            }
            await Promise.resolve();
            if (state.checkpoint) await state.checkpoint(event('llamaindex.embedding.await', 'insertNodes', 'yield', 'after'));
            return [1, text.length / 1000, 0.5];
          }
        }
        state.embeddings = new SyntheticEmbedding();
        state.makeNode = (id, owner, text) => new TextNode({
          id_: id, text, metadata: { owner },
          relationships: { [NodeRelationship.SOURCE]: { nodeId: owner } },
        });
        await Settings.withEmbedModel(state.embeddings, async () => {
          const [docStore, indexStore, vectorStore] = await Promise.all([
            SimpleDocumentStore.fromPersistDir(directory, undefined, { logger }),
            SimpleIndexStore.fromPersistDir(directory, { logger }),
            SimpleVectorStore.fromPersistDir(directory, state.embeddings, { logger }),
          ]);
          state.storage = await storageContextFromDefaults({ persistDir: directory, docStore, indexStore, vectorStore });
          state.vectorStore = state.storage.vectorStores[ModalityType.TEXT];
          if (!state.vectorStore) throw new Error('missing LlamaIndex text vector store');
          const add = state.vectorStore.add.bind(state.vectorStore);
          state.vectorStore.add = async nodes => {
            if (state.checkpoint) await state.checkpoint(event('llamaindex.vector.add', 'insertNodes', 'write', 'before'));
            const ids = await add(nodes);
            if (state.checkpoint) await state.checkpoint(event('llamaindex.vector.add', 'insertNodes', 'write', 'after', 'accepted'));
            return ids;
          };
          state.index = await VectorStoreIndex.init({
            storageContext: state.storage,
            nodes: [
              state.makeNode(state.targetNodeId, state.owner, `synthetic target ${seed}`),
              state.makeNode(state.keepNodeId, state.keepOwner, `synthetic keep ${seed}`),
            ],
          });
        });
        signal?.throwIfAborted();
        return state;
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    async produce(state, checkpoint) {
      state.signal?.throwIfAborted();
      const node = await state.storage.docStore.getDocument(state.targetNodeId);
      const captured = node.text;
      state.checkpoint = checkpoint;
      try {
        await checkpoint(event('llamaindex.document.captured', 'getDocument', 'read', 'after'));
        await state.index.insertNodes([
          state.makeNode(state.derivedNodeId, state.owner, `${captured}; synthetic derived`),
        ]);
      } finally { state.checkpoint = null; }
    },
    async remove(state) {
      state.signal?.throwIfAborted();
      await state.index.deleteRefDoc(state.owner, true);
      if (deleteMode === 'composed') await state.storage.docStore.deleteRefDoc(state.owner, false);
    },
    async observe(state) {
      state.signal?.throwIfAborted();
      const [vectorStore, docStore, indexStore] = await Promise.all([
        SimpleVectorStore.fromPersistDir(state.directory, state.embeddings, { logger }),
        SimpleDocumentStore.fromPersistDir(state.directory, undefined, { logger }),
        SimpleIndexStore.fromPersistDir(state.directory, { logger }),
      ]);
      const vectors = vectorStore.toDict();
      const documents = docStore.toDict();
      const structures = await indexStore.getIndexStructs();
      const targetNodeIds = new Set([state.targetNodeId, state.derivedNodeId]);
      const targetKeys = new Set([...targetNodeIds, state.owner]);
      const keepNodeIds = new Set([state.keepNodeId]);
      const keepKeys = new Set([state.keepNodeId, state.keepOwner]);
      const documentEntries = Object.values(documents).flatMap(collection => Object.keys(collection));
      return json({
        residue: {
          vectors: Object.keys(vectors.embeddingDict).filter(id => targetNodeIds.has(id)).length,
          documents: documentEntries.filter(id => targetKeys.has(id)).length,
          indexNodes: structures.reduce((count, structure) => count + Object.keys(structure.nodesDict ?? {}).filter(id => targetNodeIds.has(id)).length, 0),
        },
        keepSnapshot: {
          vectors: Object.fromEntries(Object.entries(vectors).map(([name, entries]) => [name, selected(entries, keepNodeIds)])),
          documents: Object.fromEntries(Object.entries(documents).map(([name, entries]) => [name, selected(entries, keepKeys)])),
          indexNodes: structures.map(structure => selected(structure.nodesDict, keepNodeIds)),
        },
      });
    },
    async close(state) {
      state.checkpoint = null;
      await rm(state.directory, { recursive: true, force: true });
    },
  };
}
