// This study is separate from the frozen correctness and supplement protocols.
import { REQUIRED_SOURCE_FILES } from './source-manifest.mjs';

export const COST_SCHEMA_VERSION = 2;
export const COST_KIND = 'memory-deletion-single-factor-cost';
export const COST_REPETITIONS = 30;
export const COST_BASELINE = { backgroundRecords: 1000, targetRevisions: 100, contentBytes: 1024 };
export const COST_AXES = [
  { id: 'backgroundRecords', levels: [10, 1000, 10000] },
  { id: 'targetRevisions', levels: [1, 100, 1000] },
  { id: 'contentBytes', levels: [128, 1024, 4096] },
];
export const COST_CONFIGURATIONS = COST_AXES.flatMap(axis => axis.levels.map(level => ({
  id: `${axis.id}-${level}`, axis: axis.id, level,
  ...COST_BASELINE, [axis.id]: level,
  isBaseline: level === COST_BASELINE[axis.id],
})));
export const COST_GUARD_MODES = ['guard-disabled', 'guard-enabled'];
export const COST_BOUNDARY = {
  scale: 'Fresh file database and child process for each observation. Timed production clean and verify exclude fixture setup, oracle and process startup. Only the named axis changes from the baseline; vector and summary fan-out remain fixed.',
  guard: 'Both modes use the same research reconstruction of appendMemoryRevision, the same Drizzle transaction and INSERT RETURNING. Only the real assertMemoryWriteAvailable call is enabled or disabled. This is a research component ablation, not a measurement of a production mode without guards or a pure SQL predicate cost.',
  statistics: 'Type 7 interpolated descriptive quantiles. One local machine; OS and file-system caches uncontrolled. Rotated order does not establish independent identical distributions or a cross-device scalability guarantee.',
  baseline: 'The baseline appears once in each axis under distinct configuration IDs; its three groups are reported separately and are not pooled.',
  content: 'ASCII contentBytes applies to the target main record, all target revisions and their evidence ranges, and background main records. The retained control and seeded FTS, vectors, summaries, audit and Outbox fan-out remain fixed.',
  completion: 'completed describes a fully observed measurement sample. clean and verify are called directly; this study does not persist a deletion request or its completion record. The disabled-guard late-write calibration intentionally creates revision residue before recleanup.',
  provenance: 'Static key source fingerprints and dynamically resolved core, libsql, loader and native-addon inputs are checked before and after the run. These selected inputs do not represent every transitive module or all host state.',
};
export const COST_REQUIRED_SOURCE_FILES = [
  ...REQUIRED_SOURCE_FILES,
  ...['protocol', 'child', 'runner', 'validator', 'test', 'runtime'].map(name => `scripts/memory-deletion-research/cost-${name}.mjs`),
  ...['schema/table-semantics', 'errors'].flatMap(name => [`packages/repositories/src/${name}.ts`, `packages/repositories/dist/${name}.js`]),
  'packages/repositories/node_modules/drizzle-orm/package.json',
  'packages/repositories/node_modules/drizzle-orm/libsql/session.js',
  'packages/repositories/node_modules/drizzle-orm/libsql/driver-core.js',
  'packages/repositories/node_modules/drizzle-orm/sqlite-core/query-builders/insert.js',
  'packages/repositories/node_modules/drizzle-orm/sqlite-core/query-builders/select.js',
  'packages/repositories/node_modules/drizzle-orm/sqlite-core/query-builders/update.js',
  'packages/repositories/node_modules/drizzle-orm/sqlite-core/dialect.js',
  'packages/repositories/node_modules/drizzle-orm/sql/sql.js',
  'packages/repositories/node_modules/@libsql/client/package.json',
  'packages/repositories/node_modules/@libsql/client/lib-esm/node.js',
  'packages/repositories/node_modules/@libsql/client/lib-esm/sqlite3.js',
];
export const COST_RUNTIME_PACKAGES = {
  'core-package': '@libsql/core', 'core-api': '@libsql/core', 'core-config': '@libsql/core', 'core-util': '@libsql/core', 'core-uri': '@libsql/core',
  'base64-package': 'js-base64', 'base64-entry': 'js-base64',
  'libsql-package': 'libsql', 'libsql-entry': 'libsql', 'libsql-error': 'libsql',
  'loader-package': '@neon-rs/load', 'loader-entry': '@neon-rs/load',
  'libc-package': 'detect-libc', 'libc-entry': 'detect-libc',
  'native-package': null, 'native-addon': null,
};
export const COST_RUNTIME_ROLES = Object.keys(COST_RUNTIME_PACKAGES);

export function costSchedule(repetitions = COST_REPETITIONS) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > COST_REPETITIONS) throw new Error('repetitions must be 1..30');
  const rotate = (values, offset) => [...values.slice(offset), ...values.slice(0, offset)];
  const rows = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const configuration of rotate(COST_CONFIGURATIONS, repetition % COST_CONFIGURATIONS.length)) {
      rows.push({ kind: 'scale', id: `scale/${configuration.id}/${repetition}`, configuration: configuration.id, repetition });
    }
  }
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const mode of rotate(COST_GUARD_MODES, repetition % COST_GUARD_MODES.length)) {
      rows.push({ kind: 'guard', id: `guard/${mode}/${repetition}`, mode, repetition });
    }
  }
  return rows;
}
