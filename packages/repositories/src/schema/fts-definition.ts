/** Rebuildable search projection DDL, shared by bootstrap and build artifacts. */
export const FTS_SCHEMA_STATEMENTS: readonly string[] = Object.freeze([
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    id UNINDEXED,
    content,
    tokenize = 'unicode61'
  );`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    id UNINDEXED,
    content,
    tokenize = 'unicode61'
  );`,
]);
