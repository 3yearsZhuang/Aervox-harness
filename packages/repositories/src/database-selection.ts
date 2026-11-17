/** Host-owned bootstrap selection, independent of the database being selected. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDatabase } from "./client.js";
import { defaultDataDirectory } from "./data-directory.js";
import { createPostgresqlDatabase, postgresqlPoolConfig } from "./driver/create-postgresql-database.js";
import type { RepositoryConnection } from "./driver/repository-connection.js";
import type { AervoxDatabase } from "./database.js";
import { postgresqlSchemaFingerprint } from "./schema/postgresql.js";
import { prepareSqliteToPostgresqlMigration, verifySqliteToPostgresqlMigrationReceipt, type SqliteToPostgresqlMigrationInput, type SqliteToPostgresqlMigrationReceipt } from "./migration/sqlite-to-postgresql.js";
import { assertMigrationFilesQuiescent } from "./migration/sqlite-to-postgresql.js";
import { registerDatabaseBackend } from "./database-backend.js";
import { rebuildSearchProjections, type ProjectionWriter } from "./search/fts.js";
import { quoteSqlIdentifier } from "./schema/manifest.js";

export const POSTGRESQL_PROVIDER_PLUGIN_ID = "ap-tool-postgresql";
interface SealedConnection { iv: string; tag: string; ciphertext: string; }
export interface PostgresqlDatabaseSelection {
  format: "aervox-database-selection";
  version: 1;
  backend: "postgresql";
  generation: string;
  instanceId: string;
  schema: string;
  schemaFingerprint: string;
  activatedAt: string;
  migrationReceiptPath: string;
  sourcePath: string;
  connection: SealedConnection;
}
export interface DatabaseSelectionStatus {
  backend: "sqlite" | "postgresql";
  generation: string | null;
  schema: string | null;
  target: string | null;
  migrationReceiptPath: string | null;
  repairRequired: boolean;
}
export class DatabaseSelectionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DatabaseSelectionError"; }
}
export function databaseSelectionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.AERVOX_DATABASE_SELECTION_PATH ?? path.join(defaultDataDirectory(), "database-selection.json"));
}
const keyPath = (selectionPath: string): string => `${selectionPath}.key`;

async function readPrivateFile(filename: string, maximum = 64 * 1024): Promise<Buffer> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw new DatabaseSelectionError("DATABASE_SELECTION_FILE_UNSAFE");
    return await handle.readFile();
  } finally { await handle.close(); }
}
/** Independent local control plane. SQLite's OS lock survives async work and
 * is released on process exit; no stale PID-file takeover or callback replay. */
async function withDatabaseMaintenance<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const mutexPath = `${filename}.maintenance.db`;
  try { const created = await fs.open(mutexPath, "wx", 0o600); await created.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await readPrivateFile(mutexPath);
  const mutex = new DatabaseSync(mutexPath);
  try {
    try { mutex.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch { throw new DatabaseSelectionError("DATABASE_MAINTENANCE_BUSY"); }
    return await operation();
  } finally { mutex.close(); }
}
async function atomicPrivateWrite(filename: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(value, "utf8"); await handle.sync(); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  finally { await handle.close(); }
  try { await fs.rename(temporary, filename); }
  catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  const directory = await fs.open(path.dirname(filename), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function loadKey(filename: string, create: boolean): Promise<Buffer> {
  try {
    const existing = await readPrivateFile(filename, 32);
    if (existing.length !== 32) throw new DatabaseSelectionError("DATABASE_SELECTION_KEY_INVALID");
    return existing;
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  try {
    const handle = await fs.open(filename, "wx", 0o600);
    try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadKey(filename, false);
  }
}
function checkedSelection(value: unknown): PostgresqlDatabaseSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatabaseSelectionError("DATABASE_SELECTION_INVALID");
  const entry = value as Partial<PostgresqlDatabaseSelection>;
  if (entry.format !== "aervox-database-selection" || entry.version !== 1 || entry.backend !== "postgresql"
    || !entry.connection || typeof entry.connection !== "object"
    || ![entry.generation, entry.instanceId, entry.schema, entry.schemaFingerprint, entry.activatedAt,
      entry.migrationReceiptPath, entry.sourcePath, entry.connection.iv, entry.connection.tag, entry.connection.ciphertext]
      .every(item => typeof item === "string" && item.length > 0 && item.length <= 32 * 1024)
    || !/^[a-f0-9]{64}$/.test(entry.schemaFingerprint!)) throw new DatabaseSelectionError("DATABASE_SELECTION_INVALID");
  return entry as PostgresqlDatabaseSelection;
}
async function readSelection(filename: string): Promise<PostgresqlDatabaseSelection | null> {
  let source: Buffer;
  try { source = await readPrivateFile(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try { return checkedSelection(JSON.parse(source.toString("utf8"))); }
  catch (error) { if (error instanceof DatabaseSelectionError) throw error; throw new DatabaseSelectionError("DATABASE_SELECTION_INVALID"); }
}
const connectionContext = (selection: Pick<PostgresqlDatabaseSelection, "generation" | "instanceId" | "schema">): Buffer =>
  Buffer.from(JSON.stringify([selection.generation, selection.instanceId, selection.schema]), "utf8");
async function unsealConnection(selection: PostgresqlDatabaseSelection, filename: string): Promise<string> {
  try {
    const key = await loadKey(keyPath(filename), false);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(selection.connection.iv, "hex"));
    decipher.setAAD(connectionContext(selection));
    decipher.setAuthTag(Buffer.from(selection.connection.tag, "hex"));
    const value = Buffer.concat([decipher.update(Buffer.from(selection.connection.ciphertext, "hex")), decipher.final()]).toString("utf8");
    postgresqlPoolConfig(value);
    return value;
  } catch { throw new DatabaseSelectionError("DATABASE_SELECTION_CREDENTIALS_UNAVAILABLE"); }
}
function safeTarget(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.searchParams.get("host") ?? url.hostname}${url.port ? `:${url.port}` : ""}/${url.pathname.slice(1)}`;
}

export async function getDatabaseSelectionStatus(filename = databaseSelectionPath()): Promise<DatabaseSelectionStatus> {
  const selection = await readSelection(filename);
  const repairRequired = await fs.lstat(`${filename}.activation.lock`).then(() => true, error => {
    if (error.code === "ENOENT") return false; throw error;
  });
  if (!selection) return { backend: "sqlite", generation: null, schema: null, target: null, migrationReceiptPath: null, repairRequired };
  const connectionString = await unsealConnection(selection, filename);
  return { backend: selection.backend, generation: selection.generation, schema: selection.schema,
    target: safeTarget(connectionString), migrationReceiptPath: selection.migrationReceiptPath, repairRequired };
}

/** The first selection is activated only from a verified, offline migration.
 * Later backend changes need reconciliation rather than copying a sealed old source. */
export async function activatePostgresqlMigration(input: {
  receiptPath: string;
  connectionString: string;
  selectionPath?: string;
}): Promise<DatabaseSelectionStatus> {
  const filename = path.resolve(input.selectionPath ?? databaseSelectionPath());
  return withDatabaseMaintenance(filename, async () => {
  if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const activationLock = `${filename}.activation.lock`;
  const claim = await fs.open(activationLock, "wx", 0o600);
  try { await claim.writeFile(JSON.stringify({ receiptPath: path.resolve(input.receiptPath), processId: process.pid, startedAt: new Date().toISOString() })); await claim.sync(); }
  finally { await claim.close(); }
  let activated = false;
  let publicationStarted = false;
  try {
  if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
  const receipt = await verifySqliteToPostgresqlMigrationReceipt(input.receiptPath, { connectionString: input.connectionString });
  assertPostgresqlProviderInstalled(receipt.backupPath);
  const key = await loadKey(keyPath(filename), true);
  const metadata = { generation: randomUUID(), instanceId: receipt.target.instanceId, schema: receipt.target.schema };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(connectionContext(metadata));
  const ciphertext = Buffer.concat([cipher.update(input.connectionString, "utf8"), cipher.final()]);
  const selection: PostgresqlDatabaseSelection = {
    format: "aervox-database-selection", version: 1, backend: "postgresql", ...metadata,
    schemaFingerprint: receipt.target.schemaFingerprint, activatedAt: new Date().toISOString(),
    migrationReceiptPath: receipt.receiptPath, sourcePath: receipt.source.path,
    connection: { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") },
  };
  // Recheck all durable evidence after preparation and before the activation write.
  await verifySqliteToPostgresqlMigrationReceipt(input.receiptPath, { connectionString: input.connectionString });
  publicationStarted = true;
  await atomicPrivateWrite(filename, `${JSON.stringify(selection, null, 2)}\n`);
  activated = true;
  // Keep the source lock: old processes and explicit attempts to reopen SQLite
  // must not create a second writer. The receipt is retained for repair.
  return { ...await getDatabaseSelectionStatus(filename), repairRequired: false };
  } finally {
    // A published selection is authoritative even if a later acknowledgement
    // fails. Preserve uncertain activation claims for explicit repair.
    if (activated || !publicationStarted) await fs.unlink(activationLock);
  }
  });
}

function assertClaimOwnerStopped(claim: { processId?: unknown }): void {
  if (!Number.isSafeInteger(claim.processId) || Number(claim.processId) < 1) throw new DatabaseSelectionError("DATABASE_CLAIM_OWNER_UNKNOWN");
  try { process.kill(Number(claim.processId), 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  throw new DatabaseSelectionError("DATABASE_CLAIM_OWNER_RUNNING");
}

/** Recover an interrupted publication only after its owner has exited. A
 * published selection is verified and retained; an unpublished claim is cleared
 * so activation can be retried. This never reopens the fenced SQLite source. */
export async function recoverDatabaseActivation(filename = databaseSelectionPath()): Promise<DatabaseSelectionStatus> {
  filename = path.resolve(filename);
  return withDatabaseMaintenance(filename, async () => {
    const activationLock = `${filename}.activation.lock`;
    const rawClaim = await readPrivateFile(activationLock);
    const selection = await readSelection(filename);
    if (selection) {
      const claim = JSON.parse(rawClaim.toString("utf8")) as { processId?: unknown; receiptPath?: unknown };
      assertClaimOwnerStopped(claim);
      if (selection.migrationReceiptPath !== claim.receiptPath) throw new DatabaseSelectionError("DATABASE_ACTIVATION_EVIDENCE_DIFFERS");
      const receipt = await verifySqliteToPostgresqlMigrationReceipt(selection.migrationReceiptPath, { connectionString: await unsealConnection(selection, filename) });
      if (receipt.source.path !== selection.sourcePath || receipt.target.schema !== selection.schema || receipt.target.instanceId !== selection.instanceId
        || receipt.target.schemaFingerprint !== selection.schemaFingerprint) throw new DatabaseSelectionError("DATABASE_ACTIVATION_EVIDENCE_DIFFERS");
      assertPostgresqlProviderInstalled(receipt.backupPath);
    }
    // Before publication a killed writer may leave an empty or torn claim.
    // The held OS mutex proves no control operation is active. Clear only this
    // claim; keep the independently fenced source and all migration evidence.
    await fs.unlink(activationLock);
    return await getDatabaseSelectionStatus(filename);
  });
}

/** Explicitly abandon an unactivated attempt. Archive its source claim and
 * preserve the backup, receipt and PostgreSQL staging, including unknown commits.
 * Once PostgreSQL is selected this operation must never reopen stale SQLite. */
export async function abortSqliteToPostgresqlMigration(input: { sourcePath: string; selectionPath?: string }): Promise<{ archivedLockPath: string }> {
  const filename = path.resolve(input.selectionPath ?? databaseSelectionPath());
  return withDatabaseMaintenance(filename, async () => {
  if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const activationLock = `${filename}.activation.lock`;
  const claim = await fs.open(activationLock, "wx", 0o600);
  try {
    await claim.writeFile(JSON.stringify({ processId: process.pid, operation: "abort" })); await claim.sync();
    if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
    const sourcePath = path.resolve(input.sourcePath), lockPath = `${sourcePath}.aervox-migration.lock`;
    const rawLock = await readPrivateFile(lockPath);
    if (rawLock.length) {
      const lock = JSON.parse(rawLock.toString("utf8")) as { format?: string; sourcePath?: string; migrationId?: string; processId?: unknown };
      if (lock.format !== "aervox-database-migration-lock" || lock.sourcePath !== sourcePath || !/^[a-f0-9-]{36}$/.test(lock.migrationId ?? "")) throw new DatabaseSelectionError("DATABASE_MIGRATION_CLAIM_INVALID");
      assertClaimOwnerStopped(lock);
    }
    // An empty source claim can only precede the first metadata write. A live
    // creator still holds that claim's file descriptor and is rejected by lsof.
    await assertMigrationFilesQuiescent([sourcePath, lockPath]);
    const archivedLockPath = `${lockPath}.aborted-${randomUUID()}`;
    await fs.rename(lockPath, archivedLockPath);
    return { archivedLockPath };
  } finally { await claim.close(); await fs.unlink(activationLock); }
  });
}
export function assertPostgresqlProviderInstalled(filename: string): void {
  const backup = new DatabaseSync(filename, { readOnly: true });
  try {
    const provider = backup.prepare("select enabled from plugins where id = ?").get(POSTGRESQL_PROVIDER_PLUGIN_ID);
    if (provider?.enabled !== 1) throw new DatabaseSelectionError("POSTGRESQL_PLUGIN_NOT_INSTALLED_OR_ENABLED");
  } finally { backup.close(); }
}

/** The command coordinator owns selection admission and the pinned projection
 * rebuild. Installation is checked before the migrator creates any target. */
export async function preparePostgresqlDatabaseMigration(input: Omit<SqliteToPostgresqlMigrationInput, "assertSourceQuiescent" | "rebuildSearchProjections"> & { selectionPath?: string }): Promise<SqliteToPostgresqlMigrationReceipt> {
  const filename = path.resolve(input.selectionPath ?? databaseSelectionPath());
  return withDatabaseMaintenance(filename, async () => {
  if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const activationLock = `${filename}.activation.lock`;
  const claim = await fs.open(activationLock, "wx", 0o600);
  try {
    await claim.writeFile(JSON.stringify({ processId: process.pid, operation: "migrate" })); await claim.sync();
    if (await readSelection(filename)) throw new DatabaseSelectionError("DATABASE_SELECTION_ALREADY_ACTIVE");
    assertPostgresqlProviderInstalled(input.sourcePath);
    return await prepareSqliteToPostgresqlMigration({ ...input, rebuildSearchProjections: async ({ client, schema }) => {
      await client.query("SELECT set_config('search_path',$1,true)", [`${quoteSqlIdentifier(schema)},pg_catalog`]);
      const writer: ProjectionWriter = { execute: async entry => {
        const query = typeof entry === "string" ? entry : entry.sql;
        const args = typeof entry === "string" ? [] : entry.args ?? [];
        if (!Array.isArray(args)) throw new Error("Named projection parameters are unsupported");
        return client.query(query, args);
      } };
      registerDatabaseBackend(writer, "postgresql");
      await rebuildSearchProjections(writer);
    } });
  } finally { await claim.close(); await fs.unlink(activationLock); }
  });
}

export async function createDefaultDatabase(options: { selectionPath?: string } = {}): Promise<{
  db: AervoxDatabase; client: RepositoryConnection; backend: "sqlite" | "postgresql"; generation: string | null;
}> {
  const filename = path.resolve(options.selectionPath ?? databaseSelectionPath());
  try { await fs.lstat(`${filename}.activation.lock`); throw new DatabaseSelectionError("DATABASE_ACTIVATION_REPAIR_REQUIRED"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const selection = await readSelection(filename);
  if (!selection) {
    const opened = await createDatabase();
    return { db: opened.db, client: opened.client, backend: "sqlite", generation: null };
  }
  if (selection.schemaFingerprint !== postgresqlSchemaFingerprint()) throw new DatabaseSelectionError("DATABASE_SELECTION_SCHEMA_RELEASE_MISMATCH");
  const opened = await createPostgresqlDatabase({ connectionString: await unsealConnection(selection, filename),
    schema: selection.schema, instanceId: selection.instanceId });
  return { db: opened.db, client: opened.client, backend: "postgresql", generation: selection.generation };
}
