import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertPostgresqlSchemaName, initializePostgresqlSchema, inspectPostgresqlSchema,
  POSTGRESQL_POSITION_COLUMN, POSTGRESQL_POSITION_TABLES, POSTGRESQL_SCHEMA_RELEASES, POSTGRESQL_SCHEMA_VERSION, postgresqlSchemaFingerprint,
  postgresqlSchemaManifest, postgresqlSchemaStatements, reseedPostgresqlPositions,
  type PostgresqlQueryPort, type PostgresqlSchemaTarget,
} from "../src/schema/postgresql.js";
import { schemaManifest } from "../src/schema/manifest.js";

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

describe("PostgreSQL canonical schema compiler", () => {
  it("covers canonical business declarations with explicit backend types and insertion positions", () => {
    const target = postgresqlSchemaManifest();
    const source = schemaManifest("main");
    for (const table of source) {
      const mapped = target.find(candidate => candidate.name === table.name)!;
      expect(mapped).toBeDefined();
      expect(mapped.columns.slice(0, table.columns.length).map(column => column.name)).toEqual(table.columns.map(column => column.name));
      for (const column of table.columns) {
        const mappedColumn = mapped.columns.find(candidate => candidate.name === column.name)!;
        expect(mappedColumn.type).toBe({ integer: "bigint", real: "double precision", text: "text", blob: "bytea" }[column.type]);
      }
    }
    expect(target.some(table => table.name === "recovery_control_ledger")).toBe(false);
    expect(target.filter(table => table.columns.some(column => column.identity)).map(table => table.name).sort()).toEqual([...POSTGRESQL_POSITION_TABLES].sort());
    expect(postgresqlSchemaFingerprint()).toMatch(/^[a-f0-9]{64}$/);
    expect(postgresqlSchemaFingerprint()).toBe(POSTGRESQL_SCHEMA_RELEASES[POSTGRESQL_SCHEMA_VERSION]);
    expect(postgresqlSchemaStatements("aervox_test").some(statement => statement.includes("randomblob"))).toBe(false);
  });

  it.each(["public", "pg_catalog", "information_schema", "aervox;drop schema public", "", "a".repeat(64)])("rejects shared or invalid target %s before SQL", async schema => {
    const query = vi.fn();
    expect(() => assertPostgresqlSchemaName(schema)).toThrow();
    await expect(initializePostgresqlSchema({ client: { query }, schema, instanceId: "instance" })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects unsupported server versions before creating any physical object", async () => {
    const query = vi.fn(async () => ({ rows: [{ version: "150010", encoding: "UTF8" }] }));
    await expect(initializePostgresqlSchema({ client: { query }, schema: "aervox_old_server", instanceId: "instance" })).rejects.toThrow("PostgreSQL 16 or newer");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("server_version_num");
  });
});

const connectionString = process.env.AERVOX_PG_TEST_URL;
describe.skipIf(!connectionString)("PostgreSQL physical schema and startup ownership", () => {
  let pool: Pool;
  const opened: Array<{ schema: string; client: PoolClient }> = [];
  beforeAll(() => { pool = new Pool({ connectionString, max: 4 }); });
  afterEach(async () => {
    for (const item of opened.splice(0)) {
      await item.client.query("ROLLBACK");
      await item.client.query(`DROP SCHEMA ${quote(item.schema)} CASCADE`);
      item.client.release();
    }
  });
  afterAll(async () => { await pool.end(); });
  async function fresh(): Promise<PostgresqlSchemaTarget> {
    const schema = `aervox_pg_test_${randomUUID().replaceAll("-", "")}`;
    const client = await pool.connect();
    opened.push({ schema, client });
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    const port: PostgresqlQueryPort = { query: (text, values) => client.query(text, values) };
    return { client: port, schema, instanceId: `instance_${randomUUID()}` };
  }

  it("initializes and independently verifies every physical table, key, index and receipt", async () => {
    const target = await fresh();
    const first = await initializePostgresqlSchema(target);
    expect(first).toEqual({ created: true, fingerprint: postgresqlSchemaFingerprint() });
    expect(await inspectPostgresqlSchema(target)).toEqual([]);
    expect(await initializePostgresqlSchema(target)).toEqual({ created: false, fingerprint: first.fingerprint });
    const result = await target.client.query(`INSERT INTO ${quote(target.schema)}.plugins(id,publisher,version,checksum,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING lifecycle_generation`, ["test", "test", "1", "sum", new Date().toISOString()]);
    expect(result.rows[0]?.lifecycle_generation).toMatch(/^[a-f0-9]{32}$/);
  }, 30_000);

  it("refuses nonempty unowned schemas without creating or repairing application objects", async () => {
    const target = await fresh();
    await target.client.query(`CREATE TABLE ${quote(target.schema)}.unrelated (id bigint primary key)`);
    await target.client.query(`INSERT INTO ${quote(target.schema)}.unrelated VALUES (7)`);
    await expect(initializePostgresqlSchema(target)).rejects.toThrow();
    expect((await target.client.query(`SELECT id FROM ${quote(target.schema)}.unrelated`)).rows.map(row => String(row.id))).toEqual(["7"]);
    const tables = await target.client.query("SELECT tablename FROM pg_tables WHERE schemaname=$1", [target.schema]);
    expect(tables.rows.map(row => row.tablename)).toEqual(["unrelated"]);
  });

  it("serializes two first initializers without accepting partial schema state", async () => {
    const target = await fresh();
    const second = await pool.connect();
    try {
      const results = await Promise.all([
        initializePostgresqlSchema(target),
        initializePostgresqlSchema({ ...target, client: { query: (text, values) => second.query(text, values) } }),
      ]);
      expect(results.map(result => result.created).sort()).toEqual([false, true]);
      expect(await inspectPostgresqlSchema(target)).toEqual([]);
    } finally { second.release(); }
  }, 30_000);

  it("rejects another instance, altered receipts and undeclared tables without rewriting them", async () => {
    const target = await fresh();
    await initializePostgresqlSchema(target);
    await expect(initializePostgresqlSchema({ ...target, instanceId: "different-instance" })).rejects.toThrow("instance/version receipt differs");
    await target.client.query(`UPDATE ${quote(target.schema)}._aervox_postgresql_instance SET fingerprint='changed'`);
    await expect(initializePostgresqlSchema(target)).rejects.toThrow("instance/version receipt differs");
    expect((await target.client.query(`SELECT fingerprint FROM ${quote(target.schema)}._aervox_postgresql_instance`)).rows[0]?.fingerprint).toBe("changed");
    await target.client.query(`CREATE TABLE ${quote(target.schema)}.unknown_data(id bigint)`);
    expect(await inspectPostgresqlSchema(target)).toContain("unknown_data: undeclared relation");
  }, 30_000);

  it("detects defaults, nullability, foreign-key timing and index-predicate drift", async () => {
    const target = await fresh();
    await initializePostgresqlSchema(target);
    await target.client.query(`ALTER TABLE ${quote(target.schema)}.turns ALTER COLUMN last_sequence SET DEFAULT 99`);
    await target.client.query(`ALTER TABLE ${quote(target.schema)}.sessions ALTER COLUMN title DROP NOT NULL`);
    const table = postgresqlSchemaManifest().find(item => item.indexes.some(index => index.where))!;
    const index = table.indexes.find(item => item.where)!;
    await target.client.query(`DROP INDEX ${quote(target.schema)}.${quote(index.name)}`);
    await target.client.query(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(target.schema)}.${quote(table.name)} (${index.columns.join(", ")}) WHERE false`);
    const foreign = (await target.client.query("SELECT constraint_name FROM information_schema.table_constraints WHERE constraint_schema=$1 AND table_name='turns' AND constraint_type='FOREIGN KEY'", [target.schema])).rows[0]!;
    await target.client.query(`ALTER TABLE ${quote(target.schema)}.turns ALTER CONSTRAINT ${quote(String(foreign.constraint_name))} DEFERRABLE INITIALLY DEFERRED`);
    const issues = await inspectPostgresqlSchema(target);
    expect(issues).toContain("turns.last_sequence: column semantics differ");
    expect(issues).toContain("sessions.title: column semantics differ");
    expect(issues).toContain(`${table.name}: indexes differ`);
    expect(issues).toContain("turns: constraint timing, validity or target differs");
    await expect(initializePostgresqlSchema(target)).rejects.toThrow();
  }, 30_000);

  it("rejects added access policies, triggers and incompatible identity sequences", async () => {
    const target = await fresh();
    await initializePostgresqlSchema(target);
    await target.client.query(`ALTER TABLE ${quote(target.schema)}.sessions ENABLE ROW LEVEL SECURITY`);
    await target.client.query(`CREATE SEQUENCE ${quote(target.schema)}.extra_sequence`);
    await target.client.query(`CREATE FUNCTION ${quote(target.schema)}.extra_trigger_function() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await target.client.query(`CREATE TRIGGER extra_trigger BEFORE INSERT ON ${quote(target.schema)}.sessions FOR EACH ROW EXECUTE FUNCTION ${quote(target.schema)}.extra_trigger_function()`);
    const issues = await inspectPostgresqlSchema(target);
    expect(issues).toContain("sessions: table storage or access semantics differ");
    expect(issues).toContain("extra_sequence: undeclared or incompatible sequence");
    expect(issues).toContain("sessions.extra_trigger: undeclared trigger");
    expect(issues).toContain("extra_trigger_function: undeclared function");
  }, 30_000);

  it("preserves imported insertion positions and reseeds subsequent identities", async () => {
    const target = await fresh();
    await initializePostgresqlSchema(target);
    await target.client.query(`INSERT INTO ${quote(target.schema)}.sessions(id,title,created_at,updated_at) VALUES ('s','test','now','now')`);
    await target.client.query(`INSERT INTO ${quote(target.schema)}.turns(id,session_id,idempotency_key,created_at,updated_at,${quote(POSTGRESQL_POSITION_COLUMN)}) VALUES ('old','s','old','now','now',910)`);
    await reseedPostgresqlPositions(target.client, target.schema);
    const result = await target.client.query(`INSERT INTO ${quote(target.schema)}.turns(id,session_id,idempotency_key,created_at,updated_at) VALUES ('new','s','new','now','now') RETURNING ${quote(POSTGRESQL_POSITION_COLUMN)}`);
    expect(String(result.rows[0]?.[POSTGRESQL_POSITION_COLUMN])).toBe("911");
    await expect(target.client.query(`INSERT INTO ${quote(target.schema)}.turns(id,session_id,idempotency_key,created_at,updated_at,${quote(POSTGRESQL_POSITION_COLUMN)}) VALUES ('duplicate','s','duplicate','now','now',910)`)).rejects.toThrow();
  }, 30_000);
});
