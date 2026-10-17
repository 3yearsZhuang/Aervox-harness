// Predeclared experiment units. Keep this module free of repository imports so
// archived evidence can be checked without installing or building the product.
export const SCHEMA_VERSION = 3;
export const CHANNELS = ['fts', 'vector', 'summary', 'audit', 'outbox'];
export const STORES = ['record', 'revisions', 'evidence', ...CHANNELS];
export const ARMS = ['soft-delete', 'cleanup-only', 'verified-cleanup', 'guarded-cleanup', 'verified-guarded'];
export const VERIFIED_ARMS = ['verified-cleanup', 'verified-guarded'];
export const GUARDED_ARMS = ['guarded-cleanup', 'verified-guarded'];
export const WRITERS = [
  { id: 'fts', channel: 'fts', api: 'indexMemoryFts' },
  { id: 'vector', channel: 'vector', api: 'SqliteMemoryEmbeddingRepository.insertBatch' },
  { id: 'summary', channel: 'summary', api: 'SqliteMemoryCompactionRepository.upsertMarker' },
  { id: 'audit', channel: 'audit', api: 'SqliteMemoryCompactionRepository.recordEvent' },
  { id: 'outbox', channel: 'outbox', api: 'SqliteOutboxRepository.insertEvent' },
  { id: 'revision', channel: 'revisions', api: 'SqliteProvenanceRepository.appendMemoryRevision' },
  { id: 'evidence', channel: 'evidence', api: 'SqliteProvenanceRepository.createMemoryEvidence' },
  { id: 'provenance-audit', channel: 'audit', api: 'SqliteProvenanceRepository.recordMemoryEvent' },
  { id: 'current-revision', channel: 'record', api: 'SqliteProvenanceRepository.setMemoryCurrentRevision' },
  { id: 'vector-adapter', channel: 'vector', api: 'SqliteMemoryVectorSearchAdapter.upsert' },
];
// Entrypoints outside the result-write matrix are listed with their actual
// evidence or exclusion, rather than silently claiming all public SQL is safe.
export const OTHER_WRITERS = [
  { api: 'SqliteOutboxRepository.markFailed', coverage: 'error-sink-matrix' },
  { api: 'SqliteOutboxRepository.markDeadLetter', coverage: 'error-sink-matrix' },
  { api: 'SqliteMemoryRepository.createRecord', coverage: 'retained-tombstone-primary-key-test' },
  { api: 'SqliteMemoryRepository.softDeleteRecord', coverage: 'monotone-delete-flag-test' },
  { api: 'SqliteMemoryDeletionStore.clean', coverage: 'cleanup-and-omission-matrix' },
  { api: 'SqliteMemoryRepository.createRecord(canonicalParentId)', coverage: 'outside-slice-shared-projection-owner' },
  { api: 'SqliteMemoryRepository.createEdgeEvidence', coverage: 'outside-slice-shared-projection-owner' },
  { api: 'SqliteSkillLifecycleRepository.createCandidate', coverage: 'outside-slice-shared-projection-owner' },
];
export const WRITE_BOUNDARY = 'Named public repository entrypoints and the vector adapter only. Excludes arbitrary raw SQL, plugins, external stores, and writes to shared projections owned by another lifecycle.';

export function manifest() {
  return [
    ...WRITERS.flatMap(({ id, channel }) => ['before-clean', 'before-complete', 'after-complete']
      .map(position => ({ id: `${id}:${position}`, writer: id, channel, position, omission: null }))),
    ...CHANNELS.map(channel => ({ id: `omit:${channel}`, writer: null, channel, position: 'omission', omission: channel })),
  ];
}
