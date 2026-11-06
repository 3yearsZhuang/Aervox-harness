import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareSqliteToPostgresqlMigration, verifySqliteToPostgresqlMigrationReceipt, type SqliteToPostgresqlMigrationInput } from "../src/migration/sqlite-to-postgresql.js";
import { CURRENT_SCHEMA_VERSION, quoteSqlIdentifier as quote, schemaFingerprint, schemaManifest } from "../src/schema/manifest.js";
import { FTS_SCHEMA_STATEMENTS } from "../src/schema/fts-definition.js";
import { inspectPostgresqlSchema } from "../src/schema/postgresql.js";

const connectionString = process.env.AERVOX_PG_TEST_URL;
describe.skipIf(!connectionString)("offline SQLite to PostgreSQL migration", () => {
  let pool: Pool, directory: string, template: string;
  const schemas: string[] = [], testDirectories: string[] = [];
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 2 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-pg-migrate-test-")); template = path.join(directory, "template.db");
    const db = new DatabaseSync(template);
    try {
      for (const table of schemaManifest("main")) db.exec(table.sql);
      for (const table of schemaManifest("main")) for (const index of table.indexes) db.exec(index.sql);
      for (const statement of FTS_SCHEMA_STATEMENTS) db.exec(statement);
      db.prepare("INSERT INTO _aervox_schema_versions(scope,version,fingerprint,applied_at) VALUES ('main',?,?,?)").run(CURRENT_SCHEMA_VERSION, schemaFingerprint("main"), "now");
    } finally { db.close(); }
    await fs.chmod(template, 0o600);
  });
  afterEach(async () => {
    for (const schema of schemas.splice(0)) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    for (const filename of testDirectories.splice(0)) await fs.rm(filename, { recursive: true, force: true });
  });
  afterAll(async () => { await pool.end(); await fs.rm(directory, { recursive: true, force: true }); });
  async function fixture(): Promise<SqliteToPostgresqlMigrationInput> {
    const testDirectory = await fs.mkdtemp(path.join(directory, "case-")); testDirectories.push(testDirectory);
    const sourcePath = path.join(testDirectory, "source.db"); await fs.copyFile(template, sourcePath);
    const schema = `aervox_migrate_test_${randomUUID().replaceAll("-", "")}`; schemas.push(schema);
    // Each fixture owns a new private source and closes every SQLite handle.
    // The active-source case below separately exercises native lsof proof.
    return { sourcePath, connectionString: connectionString!, targetSchema: schema, instanceId: randomUUID(), backupDirectory: path.join(testDirectory, "backup"), assertSourceQuiescent: async () => {} };
  }
  function change(filename: string, sql: string): void { const db = new DatabaseSync(filename); try { db.exec(sql); } finally { db.close(); } }
  async function useUnprovenSocketAlias(input: SqliteToPostgresqlMigrationInput): Promise<void> {
    const url = new URL(input.connectionString), alias = path.join("/tmp", `aervox-pg-alias-${randomUUID().slice(0, 8)}`); testDirectories.push(alias);
    await fs.symlink(url.searchParams.get("host")!, alias); url.searchParams.set("host", alias); input.connectionString = url.toString();
  }
  const conversation = `INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('s','历史 ✨','now','now');
    INSERT INTO turns(rowid,id,session_id,idempotency_key,error,created_at,updated_at) VALUES (910,'t','s','key',' { "kind": "example" } ','now','now');`;
  const memory = `INSERT INTO memory_records(id,layer,type,content,created_at,updated_at) VALUES ('m','long_term','user_fact','Migration 中文','now','now');`;
  const memoryProjection: SqliteToPostgresqlMigrationInput["rebuildSearchProjections"] = async ({ client, schema }) => {
    await client.query(`INSERT INTO ${quote(schema)}.memories_fts(id,content) SELECT id,content FROM ${quote(schema)}.memory_records WHERE is_deleted=0`);
  };

  it("verifies all business rows, exact JSON text, insertion positions and recovery evidence before activation", async () => {
    const input = await fixture(); change(input.sourcePath, `${conversation}${memory}`);
    change(input.sourcePath, "UPDATE sessions SET title=char(65279)||title");
    input.rebuildSearchProjections = memoryProjection;
    const before = await fs.readFile(input.sourcePath);
    const receipt = await prepareSqliteToPostgresqlMigration(input);
    expect(await fs.readFile(input.sourcePath)).toEqual(before);
    expect(await fs.readFile(receipt.backupPath)).toEqual(before);
    expect(receipt.tables.turns.rows).toBe(1);
    expect(receipt.projections.memories_fts.rows).toBe(1);
    expect(receipt.positionSequences.turns).toEqual({ lastValue: "910", isCalled: true, maximum: "910", nextValue: "911" });
    expect(receipt.target.locality).toBe("verified-local");
    expect(receipt.searchVerified).toBe(true);
    expect((await fs.stat(receipt.lockPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(receipt.lockPath, "utf8")).phase).toBe("verified");
    expect(await verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).toEqual(receipt);
    const row = await pool.query(`SELECT error,_aervox_rowid FROM ${quote(input.targetSchema)}.turns`);
    expect(row.rows).toEqual([{ error: ' { "kind": "example" } ', _aervox_rowid: "910" }]);
    expect((await pool.query(`SELECT title FROM ${quote(input.targetSchema)}.sessions`)).rows[0].title).toBe("\ufeff历史 ✨");
    const sequence = (await pool.query("SELECT pg_get_serial_sequence($1,'_aervox_rowid') AS name", [`${quote(input.targetSchema)}.turns`])).rows[0].name;
    await pool.query("SELECT setval($1::regclass,1,false)", [sequence]);
    await expect(verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).rejects.toThrow("does not follow imported positions");
    await pool.query("SELECT setval($1::regclass,910,true)", [sequence]);
    await pool.query(`INSERT INTO ${quote(input.targetSchema)}.turns(id,session_id,idempotency_key,created_at,updated_at) VALUES ('next','s','next','now','now')`);
    expect((await pool.query(`SELECT _aervox_rowid FROM ${quote(input.targetSchema)}.turns WHERE id='next'`)).rows[0]._aervox_rowid).toBe("911");
    await expect(verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).rejects.toThrow("content verification failed: turns");
  }, 60_000);

  it("binds independent Vault and control ledger evidence without importing either", async () => {
    const input = await fixture();
    input.controlLedgerPath = path.join(path.dirname(input.sourcePath), "ledger.db");
    input.protectedVaultPath = path.join(path.dirname(input.sourcePath), "vault.db");
    for (const filename of [input.controlLedgerPath, input.protectedVaultPath]) change(filename, "CREATE TABLE evidence(id text); INSERT INTO evidence VALUES ('private');");
    const receipt = await prepareSqliteToPostgresqlMigration(input);
    expect(receipt.vault?.present).toBe(true); expect(receipt.controlLedger?.present).toBe(true);
    expect(receipt.tables.evidence).toBeUndefined();
    expect(await verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).toEqual(receipt);
    change(input.controlLedgerPath, "INSERT INTO evidence VALUES ('later');");
    await expect(verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).rejects.toThrow("migration input changed");
  }, 60_000);

  it.each([
    ["unsafe integer", `${conversation} UPDATE turns SET last_sequence=9007199254740993;`, "unsafe integer precision"],
    ["integer affinity", `${conversation} UPDATE turns SET last_sequence='invalid';`, "integer affinity"],
    ["text affinity", `${conversation} UPDATE sessions SET title=X'4142';`, "text affinity"],
    ["NUL text", `${conversation} UPDATE sessions SET title=char(65)||char(0)||char(66);`, "NUL"],
    ["invalid UTF8", `${conversation} UPDATE sessions SET title=CAST(X'80' AS TEXT);`, "encoding"],
    ["invalid JSON", `${conversation} UPDATE turns SET error='{';`, "invalid serialized JSON"],
    ["nonfinite real", "INSERT INTO llm_configs(id,base_url,model_id,temperature,created_at,updated_at) VALUES ('bad','http://localhost','bad',1e999,'now','now');", "non-finite"],
  ])("refuses %s with exact source/backup bytes and no target writes", async (_name, sql, error) => {
    const input = await fixture(); change(input.sourcePath, sql);
    const source = await fs.readFile(input.sourcePath);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow(error);
    expect(await fs.readFile(input.sourcePath)).toEqual(source);
    expect(await fs.readFile(path.join(input.backupDirectory, "source.db"))).toEqual(source);
    expect((await pool.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema])).rows).toEqual([]);
    expect(JSON.parse(await fs.readFile(`${input.sourcePath}.aervox-migration.lock`, "utf8")).phase).toBe("failed");
  }, 30_000);

  it("fails closed for active source connections and prior migration locks", async () => {
    const input = await fixture(); delete input.assertSourceQuiescent;
    const db = new DatabaseSync(input.sourcePath);
    try { db.prepare("SELECT count(*) FROM sessions").get(); await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("quiescence"); }
    finally { db.close(); }
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("EEXIST");
    expect(await fs.stat(input.backupDirectory).catch(() => null)).toBeNull();
  });

  it("requires current schema, foreign keys, declared projections and a closed checkpoint", async () => {
    const cases = [
      "UPDATE _aervox_schema_versions SET fingerprint='old'",
      "CREATE TABLE undeclared_business(id text)",
      "CREATE VIEW unknown_view AS SELECT id FROM sessions",
      "DROP TABLE messages_fts; CREATE TABLE messages_fts(id text,content text); INSERT INTO messages_fts VALUES ('primary','do not lose');",
      "PRAGMA foreign_keys=OFF; INSERT INTO turns(id,session_id,idempotency_key,created_at,updated_at) VALUES ('orphan','missing','missing','now','now')",
    ];
    for (const sql of cases) {
      const input = await fixture(); change(input.sourcePath, sql);
      await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow();
      expect((await pool.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema])).rows).toEqual([]);
    }
    const input = await fixture(); await fs.writeFile(`${input.sourcePath}-wal`, "uncheckpointed");
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("uncheckpointed");
  }, 60_000);

  it("refuses protected or unclassified history when same-device storage is unproven", async () => {
    const input = await fixture(); change(input.sourcePath, conversation);
    // A socket reached through an unowned alias has not proved the server's
    // storage locality, even when it happens to reach this test PostgreSQL.
    await useUnprovenSocketAlias(input);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("protected history");
    expect((await pool.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema])).rows).toEqual([]);
  }, 30_000);

  it("admits factory-shaped plugin, skill and tool registrations without granting storage locality", async () => {
    const input = await fixture();
    change(input.sourcePath, `
      INSERT INTO plugins(id,publisher,version,checksum,created_at,updated_at) VALUES ('factory','aervox','1.0.0','${"a".repeat(64)}','now','now');
      INSERT INTO skill_registrations(id,name,description,source,readonly,plugin_id,created_at,updated_at) VALUES ('factory_skill','Factory skill','Shipped skill registration','plugin',1,'factory','now','now');
      INSERT INTO tool_registrations(id,name,description,category,builtin,plugin_id,created_at,updated_at) VALUES ('factory_tool','Factory tool','Shipped tool registration','system',1,'factory','now','now');
    `);
    const source = await fs.readFile(input.sourcePath);
    await useUnprovenSocketAlias(input);
    const receipt = await prepareSqliteToPostgresqlMigration(input);
    expect(receipt.target.locality).toBe("remote-or-unverified");
    expect(receipt.tables.plugins.rows).toBe(1);
    expect(receipt.tables.skill_registrations.rows).toBe(1);
    expect(receipt.tables.tool_registrations.rows).toBe(1);
    expect(await fs.readFile(input.sourcePath)).toEqual(source);
    expect(await verifySqliteToPostgresqlMigrationReceipt(receipt.receiptPath, { connectionString: input.connectionString })).toEqual(receipt);
  }, 60_000);

  it("does not treat a builtin persona label as evidence that its prompt can leave the device", async () => {
    const input = await fixture();
    change(input.sourcePath, `
      INSERT INTO personas(id,name,source,current_revision_id,created_at,updated_at) VALUES ('private','Persona','builtin','private_r1','now','now');
      INSERT INTO persona_revisions(id,persona_id,revision,config,checksum,created_at) VALUES ('private_r1','private',1,'{"systemPromptAppend":"private content"}','${"b".repeat(64)}','now');
    `);
    const source = await fs.readFile(input.sourcePath);
    await useUnprovenSocketAlias(input);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("protected history");
    expect(await fs.readFile(input.sourcePath)).toEqual(source);
    expect(await fs.readFile(path.join(input.backupDirectory, "source.db"))).toEqual(source);
    expect((await pool.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema])).rows).toEqual([]);
  }, 30_000);

  it.each([
    ["skill_payloads", `INSERT INTO skill_payloads(payload_ref,content_json,created_at,updated_at) VALUES ('private','{"skill_markdown":"private derived text"}','now','now');`],
    ["skill_candidates", `INSERT INTO skill_candidates(candidate_id,skill_key,source_evidence_json,created_at,updated_at) VALUES ('private','private','{"turnIds":["removed-private-source"]}','now','now');`],
    ["skill_releases", `INSERT INTO skill_releases(release_id,skill_key,stage,candidate_id,version,created_at,updated_at) VALUES ('private','private','stable','removed-private-candidate',1,'now','now');`],
    ["workspace_skills", `INSERT INTO workspace_skills(id,name,description,checksum,files_json,skill_markdown,imported_at,created_at,updated_at) VALUES ('private','private','Private derived skill','${"c".repeat(64)}','[]','private derived text','now','now','now');`],
  ])("refuses unclassified %s content even when its original history is absent", async (table, sql) => {
    const input = await fixture(); change(input.sourcePath, sql);
    const source = await fs.readFile(input.sourcePath);
    await useUnprovenSocketAlias(input);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow(`protected history: ${table}`);
    expect(await fs.readFile(input.sourcePath)).toEqual(source);
    expect(await fs.readFile(path.join(input.backupDirectory, "source.db"))).toEqual(source);
    expect((await pool.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema])).rows).toEqual([]);
  }, 30_000);

  it("refuses an incorrect search rebuild and retains a clean staging schema", async () => {
    const input = await fixture(); change(input.sourcePath, memory);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("projection rebuild callback");
    const other = await fixture(); change(other.sourcePath, memory);
    other.rebuildSearchProjections = async ({ client, schema }) => { await client.query(`INSERT INTO ${quote(schema)}.memories_fts(id,content) VALUES ('m','wrong')`); };
    await expect(prepareSqliteToPostgresqlMigration(other)).rejects.toThrow("content verification failed: memories_fts");
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${quote(other.targetSchema)}.memory_records`)).rows[0].n).toBe(0);
    expect(await inspectPostgresqlSchema({ client: pool, schema: other.targetSchema, instanceId: other.instanceId })).toEqual([]);
  }, 60_000);

  it("does not overwrite an unrelated namespace or reuse a successful target", async () => {
    const input = await fixture(); await pool.query(`CREATE SCHEMA ${quote(input.targetSchema)}; CREATE TABLE ${quote(input.targetSchema)}.unrelated(id text); INSERT INTO ${quote(input.targetSchema)}.unrelated VALUES ('retain')`);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("unrelated: undeclared relation");
    expect((await pool.query(`SELECT id FROM ${quote(input.targetSchema)}.unrelated`)).rows).toEqual([{ id: "retain" }]);
    const initial = await fixture(); await prepareSqliteToPostgresqlMigration(initial);
    const second = await fixture(); second.targetSchema = initial.targetSchema; second.instanceId = initial.instanceId;
    await expect(prepareSqliteToPostgresqlMigration(second)).rejects.toThrow("unused dedicated empty schema");
  }, 60_000);

  it("retains an unknown-outcome lock when the import COMMIT acknowledgement is lost", async () => {
    const input = await fixture(); change(input.sourcePath, conversation);
    const source = await fs.readFile(input.sourcePath), connect = Pool.prototype.connect;
    const intercepted = vi.spyOn(Pool.prototype, "connect").mockImplementation(async function (this: Pool) {
      const client = await (connect as () => Promise<PoolClient>).call(this), query = client.query.bind(client);
      let commits = 0;
      client.query = (async (...args: unknown[]) => {
        const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
        if (args[0] === "COMMIT" && ++commits === 2) throw new Error("injected missing commit acknowledgement");
        return result;
      }) as PoolClient["query"];
      return client;
    });
    try { await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("missing commit acknowledgement"); }
    finally { intercepted.mockRestore(); }
    const lock = JSON.parse(await fs.readFile(`${input.sourcePath}.aervox-migration.lock`, "utf8"));
    expect(lock.phase).toBe("outcome-unknown");
    expect(await fs.readFile(input.sourcePath)).toEqual(source);
    expect(await fs.readFile(path.join(input.backupDirectory, "source.db"))).toEqual(source);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${quote(input.targetSchema)}.turns`)).rows[0].n).toBe(1);
    await expect(prepareSqliteToPostgresqlMigration(input)).rejects.toThrow("EEXIST");
  }, 60_000);
});
