import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const aervoxStores = ['record', 'revisions', 'evidence', 'fts', 'vector', 'summary', 'audit', 'outbox'];
const aervoxSource = ['packages/repositories/src/repositories/sqlite/provenance-repository.ts'];
export const PRODUCTION_DESCRIPTORS = {
  'aervox-guarded': {
    checkedStores: aervoxStores,
    metadata: { project: 'Aervox-harness', evidenceClass: 'guarded-calibration', rootCause: 'historical-unguarded-provenance', discoveryFiles: aervoxSource },
  },
  'aervox-historical-provenance': {
    checkedStores: aervoxStores,
    metadata: { project: 'Aervox-harness', evidenceClass: 'historical-reconstruction', rootCause: 'historical-unguarded-provenance', discoveryFiles: aervoxSource },
  },
  'langchain-libsql': {
    checkedStores: ['vectorRows'],
    metadata: { project: 'LangChain.js community LibSQLVectorStore', evidenceClass: 'application-contract', publicApiIntegration: true,
      rootCause: 'late-ingest-after-delete', discoveryFiles: ['@langchain/community/vectorstores/libsql'] },
  },
  'llamaindex-simple': {
    checkedStores: ['vectors', 'documents', 'indexNodes'],
    metadata: { project: 'LlamaIndex.TS VectorStoreIndex with file-backed Simple stores', evidenceClass: 'application-contract', publicApiIntegration: true,
      rootCause: 'late-ingest-after-delete', discoveryFiles: ['llamaindex/indices', 'llamaindex/vector-store', '@llamaindex/core/storage/doc-store'] },
  },
};

export function assertProductionDescriptor(subject) {
  const expected = PRODUCTION_DESCRIPTORS[subject.id];
  assert.ok(expected, 'unknown production subject');
  assert.deepEqual(subject.checkedStores, expected.checkedStores, `production checkedStores mismatch: ${subject.id}`);
  for (const [key, value] of Object.entries(expected.metadata)) {
    assert.deepEqual(subject.metadata[key], value, `production metadata mismatch: ${subject.id}.${key}`);
  }
}

/** Load actual adapters and metadata without opening any fixture or workload. */
export async function loadProductionSubjects() {
  const [aervox, langchain, llamaindex] = await Promise.all([
    import('./adapters/aervox.mjs'), import('./adapters/langchain.mjs'), import('./adapters/llamaindex.mjs'),
  ]);
  const subjects = [
    { adapter: await aervox.createAdapter(), metadata: { ...aervox.metadata, evidenceClass: 'guarded-calibration', rootCause: 'historical-unguarded-provenance' } },
    { adapter: await aervox.createAdapter({ historical: true }), metadata: { ...aervox.metadata, evidenceClass: 'historical-reconstruction', rootCause: 'historical-unguarded-provenance' } },
    { adapter: await langchain.createAdapter(), metadata: { ...langchain.metadata, publicApiIntegration: true } },
    { adapter: await llamaindex.createAdapter(), metadata: { ...llamaindex.metadata, publicApiIntegration: true } },
  ];
  for (const subject of subjects) assertProductionDescriptor({ id: subject.adapter.id, checkedStores: subject.adapter.checkedStores, metadata: subject.metadata });
  return { subjects, audit: await llamaindex.createAdapter({ deleteMode: 'index-api-only' }) };
}

export async function resolveDiscoveryFiles(root, metadata) {
  if (!Array.isArray(metadata.discoveryFiles) || !metadata.discoveryFiles.length) throw new Error('subject requires explicit discoveryFiles');
  const files = [];
  for (const input of metadata.discoveryFiles) {
    const absolute = /\.[cm]?[jt]sx?$/.test(input) && !input.startsWith('@')
      ? path.resolve(root, input) : fileURLToPath(import.meta.resolve(input));
    const canonicalFile = await realpath(absolute);
    const file = path.relative(root, canonicalFile).split(path.sep).join('/');
    if (file.startsWith('../') || path.isAbsolute(file)) throw new Error(`discovery source outside repository: ${input}`);
    files.push(file);
  }
  return [...new Set(files)].sort();
}
