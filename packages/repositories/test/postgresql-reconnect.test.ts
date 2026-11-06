import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPostgresqlDatabase, type OpenedPostgresqlDatabase } from "../src/driver/create-postgresql-database.js";
import { databaseStoragePolicyFor } from "../src/storage-policy.js";

const observed = vi.hoisted(() => ({ pools: [] as Pool[], denyLocality: false }));
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  class ObservedPool extends actual.Pool {
    constructor(config?: PoolConfig) {
      super(config);
      if (config?.application_name === "aervox") observed.pools.push(this);
    }
  }
  return { ...actual, Pool: ObservedPool };
});
vi.mock("../src/driver/postgresql-locality.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/driver/postgresql-locality.js")>();
  return { ...actual, proveLocalPostgresqlStorage: async (...args: Parameters<typeof actual.proveLocalPostgresqlStorage>) =>
    observed.denyLocality ? false : actual.proveLocalPostgresqlStorage(...args) };
});

const connectionString = process.env.AERVOX_PG_TEST_URL ?? process.env.AERVOX_TEST_POSTGRES_URL;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
describe.skipIf(!connectionString)("PostgreSQL physical connection admission", () => {
  let admin: Pool, schema: string;
  let opened: OpenedPostgresqlDatabase | undefined;
  beforeEach(async () => {
    observed.pools.length = 0; observed.denyLocality = false;
    admin = new Pool({ connectionString }); schema = `aervox_reconnect_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    opened = await createPostgresqlDatabase({ connectionString: connectionString!, schema, instanceId: "reconnect-owner", initializeEmpty: true });
  });
  afterEach(async () => {
    try { await opened?.closeAsync(); }
    finally {
      opened = undefined; observed.denyLocality = false;
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); await admin.end(); }
    }
  });
  const retireAdmittedConnection = async () => {
    const admitted = Number((await opened!.client.execute("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
    expect(observed.pools).toHaveLength(1);
    const physical = await observed.pools[0]!.connect();
    try { expect(Number((await physical.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid)).toBe(admitted); }
    finally { physical.release(true); }
    expect(observed.pools[0]!.totalCount).toBe(0);
    return admitted;
  };
  const blockedInsert = "INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('blocked','must not persist','now','now')";
  const expectNoBlockedWrite = async () => {
    expect((await admin.query(`SELECT id FROM ${quote(schema)}.sessions WHERE id='blocked'`)).rows).toEqual([]);
    expect(observed.pools[0]!.totalCount).toBe(0);
  };

  it("admits an actual new connection to the unchanged target and preserves committed facts", async () => {
    await opened!.client.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('saved','Committed before reconnect','now','now')");
    const retiredPid = await retireAdmittedConnection();
    const row = (await opened!.client.execute("SELECT pg_backend_pid() AS pid,title FROM sessions WHERE id='saved'")).rows[0];
    expect(Number(row?.pid)).not.toBe(retiredPid);
    expect(row?.title).toBe("Committed before reconnect");
  }, 60_000);

  it("rejects a changed instance marker on a new physical connection before business writes", async () => {
    await retireAdmittedConnection();
    await admin.query(`UPDATE ${quote(schema)}._aervox_postgresql_instance SET instance_id='another-owner' WHERE singleton=1`);
    await expect(opened!.client.execute(blockedInsert)).rejects.toMatchObject({ code: "POSTGRESQL_SCHEMA_MIGRATION_REQUIRED" });
    await expectNoBlockedWrite();
  }, 60_000);

  it("rejects canonical structure drift on a new physical connection before business writes", async () => {
    await retireAdmittedConnection();
    await admin.query(`ALTER TABLE ${quote(schema)}.sessions ALTER COLUMN title DROP NOT NULL`);
    await expect(opened!.client.execute(blockedInsert)).rejects.toMatchObject({ code: "POSTGRESQL_SCHEMA_MIGRATION_REQUIRED" });
    await expectNoBlockedWrite();
  }, 60_000);

  it("refuses to inherit verified locality when the next connection cannot prove it", async () => {
    expect(databaseStoragePolicyFor(opened!.db).localOnlyAllowed).toBe(true);
    await retireAdmittedConnection(); observed.denyLocality = true;
    await expect(opened!.client.execute(blockedInsert)).rejects.toMatchObject({ code: "POSTGRESQL_DATABASE_OPEN_FAILED", reasonCode: "POSTGRESQL_STORAGE_LOCALITY_CHANGED" });
    await expectNoBlockedWrite();
    observed.denyLocality = false;
    expect((await opened!.client.execute("SELECT 1 AS available")).rows[0]?.available).toBe(1);
  }, 60_000);
});
