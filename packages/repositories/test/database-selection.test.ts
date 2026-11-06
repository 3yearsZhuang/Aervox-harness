import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activatePostgresqlMigration, abortSqliteToPostgresqlMigration, createDefaultDatabase, getDatabaseSelectionStatus, preparePostgresqlDatabaseMigration, recoverDatabaseActivation } from "../src/database-selection.js";
import { createDatabase } from "../src/client.js";
import { CURRENT_SCHEMA_VERSION, quoteSqlIdentifier as quote, schemaFingerprint, schemaManifest } from "../src/schema/manifest.js";
import { FTS_SCHEMA_STATEMENTS } from "../src/schema/fts-definition.js";

const connectionString = process.env.AERVOX_PG_TEST_URL;
let root: string, source: string, selectionPath: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-selection-"));
  source = path.join(root, "source.db"); selectionPath = path.join(root, "selection.json");
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

function fixture(installed = true): void {
  const db = new DatabaseSync(source);
  try {
    for (const table of schemaManifest("main")) db.exec(table.sql);
    for (const table of schemaManifest("main")) for (const index of table.indexes) db.exec(index.sql);
    for (const sql of FTS_SCHEMA_STATEMENTS) db.exec(sql);
    db.prepare("INSERT INTO _aervox_schema_versions(scope,version,fingerprint,applied_at) VALUES ('main',?,?,?)").run(CURRENT_SCHEMA_VERSION, schemaFingerprint("main"), "now");
    if (installed) db.exec("INSERT INTO plugins(id,publisher,version,checksum,created_at,updated_at) VALUES ('ap-tool-postgresql','3yearsZ','1','fixture','now','now')");
  } finally { db.close(); }
}
async function deadClaim(filename: string): Promise<void> {
  const claim = JSON.parse(await fs.readFile(filename, "utf8"));
  await fs.writeFile(filename, JSON.stringify({ ...claim, processId: 2147483647 }), { mode: 0o600 });
}

it("keeps SQLite default and rejects new and existing source operations after fencing", async () => {
  vi.stubEnv("DATABASE_URL", `file:${source}`);
  expect(await getDatabaseSelectionStatus(selectionPath)).toEqual({ backend: "sqlite", generation: null, schema: null, target: null, migrationReceiptPath: null, repairRequired: false });
  const opened = await createDefaultDatabase({ selectionPath });
  try {
    expect(opened.backend).toBe("sqlite");
    await opened.client.execute("CREATE TABLE example(value text)");
    await fs.writeFile(`${source}.aervox-migration.lock`, "claimed");
    await expect(opened.client.execute("INSERT INTO example VALUES ('blocked')")).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
    await expect(createDatabase({ url: `file:${source}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  } finally { opened.client.close(); }
});

it("rejects missing plugin before creating migration target or source claim", async () => {
  fixture(false);
  await expect(preparePostgresqlDatabaseMigration({ sourcePath: source, connectionString: "postgresql://invalid@localhost/missing", targetSchema: "unused", instanceId: "test", backupDirectory: path.join(root, "backup"), selectionPath })).rejects.toMatchObject({ code: "POSTGRESQL_PLUGIN_NOT_INSTALLED_OR_ENABLED" });
  expect(await fs.stat(`${source}.aervox-migration.lock`).catch(() => null)).toBeNull();
});

it("rejects an installed but disabled plugin before preparing a migration", async () => {
  fixture();
  const db = new DatabaseSync(source);
  try { db.exec("UPDATE plugins SET enabled=0 WHERE id='ap-tool-postgresql'"); }
  finally { db.close(); }
  const backupDirectory = path.join(root, "backup");
  await expect(preparePostgresqlDatabaseMigration({ sourcePath: source, connectionString: "postgresql://invalid@localhost/missing", targetSchema: "unused", instanceId: "test", backupDirectory, selectionPath })).rejects.toMatchObject({ code: "POSTGRESQL_PLUGIN_NOT_INSTALLED_OR_ENABLED" });
  expect(await fs.stat(`${source}.aervox-migration.lock`).catch(() => null)).toBeNull();
  expect(await fs.stat(backupDirectory).catch(() => null)).toBeNull();
  expect((await getDatabaseSelectionStatus(selectionPath)).backend).toBe("sqlite");
});

it("abort preserves staging evidence and refuses a live owner", async () => {
  new DatabaseSync(source).close();
  const lockPath = `${source}.aervox-migration.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ format: "aervox-database-migration-lock", migrationId: randomUUID(), sourcePath: source, processId: process.pid, phase: "outcome-unknown" }), { mode: 0o600 });
  await expect(abortSqliteToPostgresqlMigration({ sourcePath: source, selectionPath })).rejects.toMatchObject({ code: "DATABASE_CLAIM_OWNER_RUNNING" });
  await deadClaim(lockPath);
  const result = await abortSqliteToPostgresqlMigration({ sourcePath: source, selectionPath });
  expect(JSON.parse(await fs.readFile(result.archivedLockPath, "utf8")).phase).toBe("outcome-unknown");
  expect(await fs.stat(lockPath).catch(() => null)).toBeNull();
  const opened = await createDatabase({ url: `file:${source}` }); opened.client.close();
});

it("repairs interrupted unpublished claim writes while retaining the fenced source", async () => {
  new DatabaseSync(source).close();
  const sourceLock = `${source}.aervox-migration.lock`;
  await fs.writeFile(sourceLock, "", { mode: 0o600 });
  await fs.writeFile(`${selectionPath}.activation.lock`, '{"processId":', { mode: 0o600 });
  expect(await recoverDatabaseActivation(selectionPath)).toMatchObject({ backend: "sqlite", repairRequired: false });
  await expect(createDatabase({ url: `file:${source}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  const result = await abortSqliteToPostgresqlMigration({ sourcePath: source, selectionPath });
  expect(await fs.readFile(result.archivedLockPath, "utf8")).toBe("");
  const opened = await createDatabase({ url: `file:${source}` }); opened.client.close();
});

describe.skipIf(!connectionString)("verified PostgreSQL activation", () => {
  let pool: Pool, schema: string;
  beforeEach(() => { pool = new Pool({ connectionString, max: 1 }); schema = `aervox_selection_${randomUUID().replaceAll("-", "")}`; });
  afterEach(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); await pool.end(); });
  const migrate = () => preparePostgresqlDatabaseMigration({ sourcePath: source, connectionString: connectionString!, targetSchema: schema, instanceId: randomUUID(), backupDirectory: path.join(root, "backup"), selectionPath });

  it("activates only verified migration, encrypts credentials, persists selection and never reopens stale SQLite", async () => {
    fixture();
    const db = new DatabaseSync(source);
    db.exec("INSERT INTO memory_records(id,layer,type,content,created_at,updated_at) VALUES ('m','long_term','user_fact','Migration 中文','now','now')"); db.close();
    const receipt = await migrate();
    expect(receipt.projections.memories_fts.rows).toBe(1);
    const active = await activatePostgresqlMigration({ receiptPath: receipt.receiptPath, connectionString: connectionString!, selectionPath });
    expect(active).toMatchObject({ backend: "postgresql", schema, repairRequired: false });
    const selection = await fs.readFile(selectionPath, "utf8");
    expect(selection).not.toContain(connectionString!);
    expect((await fs.stat(selectionPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${selectionPath}.key`)).mode & 0o777).toBe(0o600);
    const opened = await createDefaultDatabase({ selectionPath });
    try { expect(opened.backend).toBe("postgresql"); expect((await opened.client.execute("SELECT content FROM memory_records")).rows[0]?.content).toBe("Migration 中文"); }
    finally { await opened.client.close(); }
    await expect(abortSqliteToPostgresqlMigration({ sourcePath: source, selectionPath })).rejects.toMatchObject({ code: "DATABASE_SELECTION_ALREADY_ACTIVE" });
    await fs.chmod(`${selectionPath}.key`, 0o644);
    await expect(createDefaultDatabase({ selectionPath })).rejects.toMatchObject({ code: "DATABASE_SELECTION_CREDENTIALS_UNAVAILABLE" });
    expect(await fs.stat(`${source}.aervox-migration.lock`)).toBeTruthy();
  }, 60_000);

  it.each(["disabled", "removed"] as const)("keeps activated PostgreSQL and new facts when the provider is %s and its declaration is unavailable", async state => {
    fixture(); const receipt = await migrate();
    const active = await activatePostgresqlMigration({ receiptPath: receipt.receiptPath, connectionString: connectionString!, selectionPath });
    const selectionBytes = await fs.readFile(selectionPath);
    const keyBytes = await fs.readFile(`${selectionPath}.key`);
    const opened = await createDefaultDatabase({ selectionPath });
    try {
      await opened.client.execute("INSERT INTO memory_records(id,layer,type,content,created_at,updated_at) VALUES ('after-switch','long_term','user_fact','Created after switching to PostgreSQL','now','now')");
      await opened.client.execute(state === "disabled"
        ? "UPDATE plugins SET enabled=0 WHERE id='ap-tool-postgresql'"
        : "DELETE FROM plugins WHERE id='ap-tool-postgresql'");
    } finally { await opened.client.close(); }

    // Model a missing declaration without removing the shared collection's
    // files. Selection, credentials and all other filesystem reads stay real.
    const readFile = fs.readFile.bind(fs);
    const unavailableDeclaration = vi.spyOn(fs, "readFile").mockImplementation(async (filename, options) => {
      if (String(filename).endsWith("/plugin.manifest.json")) {
        throw Object.assign(new Error("plugin declaration is unavailable"), { code: "ENOENT" });
      }
      return readFile(filename, options);
    });
    try {
      await expect(fs.readFile(path.join(root, "plugins/tool/postgresql/plugin.manifest.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const reopened = await createDefaultDatabase({ selectionPath });
      try {
        expect(reopened).toMatchObject({ backend: "postgresql", generation: active.generation });
        expect((await reopened.client.execute("SELECT content FROM memory_records WHERE id='after-switch'")).rows[0]?.content).toBe("Created after switching to PostgreSQL");
        const provider = await reopened.client.execute("SELECT enabled FROM plugins WHERE id='ap-tool-postgresql'");
        if (state === "disabled") expect(provider.rows[0]?.enabled).toBe(0);
        else expect(provider.rows).toEqual([]);
      } finally { await reopened.client.close(); }
    } finally { unavailableDeclaration.mockRestore(); }

    await expect(abortSqliteToPostgresqlMigration({ sourcePath: source, selectionPath })).rejects.toMatchObject({ code: "DATABASE_SELECTION_ALREADY_ACTIVE" });
    expect((await fs.readFile(selectionPath)).equals(selectionBytes)).toBe(true);
    expect((await fs.readFile(`${selectionPath}.key`)).equals(keyBytes)).toBe(true);
    await expect(createDatabase({ url: `file:${source}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
    expect(await getDatabaseSelectionStatus(selectionPath)).toMatchObject({ backend: "postgresql", generation: active.generation, repairRequired: false });
  }, 60_000);

  it("recovers a published selection only after the owner exits and the receipt revalidates", async () => {
    fixture(); const receipt = await migrate();
    await activatePostgresqlMigration({ receiptPath: receipt.receiptPath, connectionString: connectionString!, selectionPath });
    const lockPath = `${selectionPath}.activation.lock`;
    await fs.writeFile(lockPath, JSON.stringify({ receiptPath: receipt.receiptPath, processId: process.pid }), { mode: 0o600 });
    await expect(createDefaultDatabase({ selectionPath })).rejects.toMatchObject({ code: "DATABASE_ACTIVATION_REPAIR_REQUIRED" });
    await expect(recoverDatabaseActivation(selectionPath)).rejects.toMatchObject({ code: "DATABASE_CLAIM_OWNER_RUNNING" });
    await deadClaim(lockPath);
    expect(await recoverDatabaseActivation(selectionPath)).toMatchObject({ backend: "postgresql", repairRequired: false });
    expect(await fs.stat(receipt.lockPath)).toBeTruthy();
  }, 60_000);

  it("refuses activation when verified target rows change", async () => {
    fixture(); const receipt = await migrate();
    await pool.query(`UPDATE ${quote(schema)}.plugins SET enabled=0`);
    await expect(activatePostgresqlMigration({ receiptPath: receipt.receiptPath, connectionString: connectionString!, selectionPath })).rejects.toThrow("content verification failed");
    expect((await getDatabaseSelectionStatus(selectionPath)).backend).toBe("sqlite");
    await expect(createDatabase({ url: `file:${source}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  }, 60_000);

  it("retains a lost publication acknowledgement and repairs it without reverting the selected database", async () => {
    fixture(); const receipt = await migrate();
    const rename = fs.rename.bind(fs);
    const injected = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (to === selectionPath) throw new Error("lost publication acknowledgement");
    });
    await expect(activatePostgresqlMigration({ receiptPath: receipt.receiptPath, connectionString: connectionString!, selectionPath })).rejects.toThrow("lost publication acknowledgement");
    injected.mockRestore();
    expect(await getDatabaseSelectionStatus(selectionPath)).toMatchObject({ backend: "postgresql", repairRequired: true });
    await deadClaim(`${selectionPath}.activation.lock`);
    expect(await recoverDatabaseActivation(selectionPath)).toMatchObject({ backend: "postgresql", repairRequired: false });
    await pool.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    await expect(createDefaultDatabase({ selectionPath })).rejects.toMatchObject({ code: "POSTGRESQL_SCHEMA_MIGRATION_REQUIRED" });
    await expect(createDatabase({ url: `file:${source}` })).rejects.toMatchObject({ code: "DATABASE_MIGRATION_SOURCE_FENCED" });
  }, 60_000);
});
