import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, initLedgerSchema, inspectSchemaParity, schemaFingerprint, SchemaMigrationRequiredError } from "../src/index.js";

describe("complete physical schema contract", () => {
  it("matches all declared columns/defaults/nullability/PK/FK/indexes and rejects NULL primary keys", async () => {
    const database = await createInMemoryDatabase();
    try {
      await initLedgerSchema(database.client);
      expect(await inspectSchemaParity(database.client, "main")).toEqual([]);
      expect(await inspectSchemaParity(database.client, "ledger")).toEqual([]);
      await expect(database.client.execute("INSERT INTO learning_goals (id, topic, created_at, updated_at) VALUES (NULL,'dirty','t','t')")).rejects.toThrow(/NOT NULL/);
      expect((await database.client.execute("SELECT fingerprint FROM _aervox_schema_versions WHERE scope='main'")).rows[0]?.fingerprint).toBe(schemaFingerprint("main"));
    } finally { await database.cleanup(); }
  });
  it("rejects legacy drift before creating any table or writing data", async () => {
    const database = await createInMemoryDatabase({ empty: true });
    try {
      await database.client.execute("CREATE TABLE learning_goals (id TEXT PRIMARY KEY, topic TEXT)");
      await database.client.execute("INSERT INTO learning_goals VALUES(NULL, 'legacy')");
      const before = await database.client.execute("SELECT * FROM sqlite_master");
      await expect(initDatabaseSchema(database.client)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
      expect((await database.client.execute("SELECT * FROM sqlite_master")).rows).toEqual(before.rows);
      expect((await database.client.execute("SELECT * FROM learning_goals")).rows).toEqual([{id: null, topic: "legacy"}]);
    } finally { await database.cleanup(); }
  });
  it("refuses a recorded fingerprint mismatch without changing version or creating tables", async () => {
    const database = await createInMemoryDatabase();
    try {
      await database.client.execute("UPDATE _aervox_schema_versions SET fingerprint='tampered' WHERE scope='main'");
      await expect(initDatabaseSchema(database.client)).rejects.toThrow("fingerprint mismatch");
      expect((await database.client.execute("SELECT fingerprint FROM _aervox_schema_versions WHERE scope='main'")).rows[0]?.fingerprint).toBe("tampered");
    } finally { await database.cleanup(); }
  });
  it.each(["CREATE TABLE unknown_data(id TEXT)", "CREATE VIRTUAL TABLE unknown_search USING fts5(content)"])("rejects an unrelated nonempty database before bootstrap writes: %s", async (definition) => {
    const database = await createInMemoryDatabase({ empty: true });
    try {
      await database.client.execute(definition);
      const original = (await database.client.execute("SELECT * FROM sqlite_master ORDER BY name")).rows;
      await expect(initDatabaseSchema(database.client)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
      expect((await database.client.execute("SELECT * FROM sqlite_master ORDER BY name")).rows).toEqual(original);
    } finally { await database.cleanup(); }
  });
  it("registers an exact unversioned schema without replacing its data", async () => {
    const database = await createInMemoryDatabase();
    try {
      await database.client.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES('retained','legacy','t','t')");
      await database.client.execute("DROP TABLE _aervox_schema_versions");
      await initDatabaseSchema(database.client);
      expect((await database.client.execute("SELECT id,title FROM sessions")).rows).toEqual([{ id: "retained", title: "legacy" }]);
      expect((await database.client.execute("SELECT fingerprint FROM _aervox_schema_versions WHERE scope='main'")).rows[0]?.fingerprint).toBe(schemaFingerprint("main"));
    } finally { await database.cleanup(); }
  });
  it("detects partial index predicate drift", async () => {
    const database = await createInMemoryDatabase();
    try {
      await database.client.execute("DROP INDEX review_items_active_due_idx");
      await database.client.execute("CREATE INDEX review_items_active_due_idx ON review_items(due_at) WHERE status='paused'");
      expect(await inspectSchemaParity(database.client, "main")).toContain("review_items: indexes or partial predicates differ");
      await expect(initDatabaseSchema(database.client)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
    } finally { await database.cleanup(); }
  });
  it.each([
    "idempotency_key COLLATE NOCASE",
    "idempotency_key DESC",
    "idempotency_key COLLATE NOCASE DESC",
    "lower(idempotency_key)",
  ])("blocks idempotency index drift without changing the database: %s", async (key) => {
    const database = await createInMemoryDatabase();
    try {
      await database.client.execute("DROP INDEX learning_goals_local_idempotency_idx");
      await database.client.execute(`CREATE UNIQUE INDEX learning_goals_local_idempotency_idx ON learning_goals(${key})`);
      await database.client.execute("INSERT INTO learning_goals(id, topic, idempotency_key, created_at, updated_at) VALUES('retained', 'keep', 'CaseSensitiveKey', 't', 't')");
      const original = (await database.client.execute("SELECT * FROM sqlite_master ORDER BY name")).rows;
      expect(await inspectSchemaParity(database.client, "main")).toContain("learning_goals: indexes or partial predicates differ");
      await expect(initDatabaseSchema(database.client)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
      expect((await database.client.execute("SELECT * FROM sqlite_master ORDER BY name")).rows).toEqual(original);
      expect((await database.client.execute("SELECT id,idempotency_key FROM learning_goals")).rows).toEqual([{ id: "retained", idempotency_key: "CaseSensitiveKey" }]);
    } finally { await database.cleanup(); }
  });
});
