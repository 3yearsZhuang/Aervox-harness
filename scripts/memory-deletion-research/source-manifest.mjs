// Fixed measurement inputs shared by both independent archive validators.
export const LEGACY_REQUIRED_SOURCE_FILES = [
  ...['client', 'write-retry', 'conversation-execution-policy', 'repositories/sqlite/memory-repository',
    'repositories/sqlite/memory-deletion-store', 'repositories/sqlite/outbox-repository',
    'repositories/sqlite/memory-compaction-guard', 'repositories/sqlite/memory-compaction-repository',
    'repositories/sqlite/memory-embedding-repository', 'search/fts',
    'schema/manifest', 'schema/ddl/index', 'schema/ddl/fts',
  ].flatMap(file => [`packages/repositories/src/${file}.ts`, `packages/repositories/dist/${file}.js`]),
  ...['index', 'common', 'memories', 'provenance', 'memory-compaction', 'embeddings', 'outbox', 'conversations', 'schema-version']
    .flatMap(file => [`packages/schema/src/${file}.ts`, `packages/schema/dist/${file}.js`]),
  'packages/repositories/package.json', 'packages/schema/package.json',
  'scripts/memory-deletion-research/fixture.mjs', 'scripts/memory-deletion-research/runner.mjs',
  'scripts/memory-deletion-research/crash-child.mjs', 'scripts/memory-deletion-research/validate-report.mjs',
  'pnpm-lock.yaml', 'mise.toml',
];
export const REQUIRED_SOURCE_FILES = [
  ...LEGACY_REQUIRED_SOURCE_FILES,
  ...['data-directory', 'memory-deletion-protocol', 'repositories/sqlite/provenance-repository',
    'repositories/sqlite/memory-write-guard', 'repositories/sqlite/privacy-repository',
    'repositories/sqlite/skill-lifecycle-repository', 'repositories/sqlite/platform-repository',
    'index', 'repositories/sqlite/index']
    .flatMap(file => [`packages/repositories/src/${file}.ts`, `packages/repositories/dist/${file}.js`]),
  ...['privacy', 'platform'].flatMap(file => [`packages/schema/src/${file}.ts`, `packages/schema/dist/${file}.js`]),
  'scripts/memory-deletion-research/protocol.mjs',
  'scripts/memory-deletion-research/supplement.mjs',
  'scripts/memory-deletion-research/supplement-child.mjs',
  'scripts/memory-deletion-research/supplement.test.mjs',
  'scripts/memory-deletion-research/validate-supplement.mjs',
  'package.json',
  'scripts/memory-deletion-research/source-manifest.mjs',
  ...['deletion-worker', 'compaction-marker'].flatMap(file => [`apps/worker/src/${file}.ts`, `apps/worker/dist/${file}.js`]),
];
