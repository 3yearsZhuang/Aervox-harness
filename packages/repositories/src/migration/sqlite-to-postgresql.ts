/** Offline preparation only. Source admission stays closed until the host explicitly
 * activates or aborts the durable migration; this module never changes config. */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { promisify } from "node:util";
import type { Client, InStatement } from "@libsql/client";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as declarations from "@aervox/schema";
import { Pool, type PoolClient } from "pg";
import { postgresqlPoolConfig } from "../driver/create-postgresql-database.js";
import { proveLocalPostgresqlStorage } from "../driver/postgresql-locality.js";
import { isDerivedSearchTable } from "../backup-scope.js";
import { CURRENT_SCHEMA_VERSION, SCHEMA_RELEASES, inspectSchemaParity, quoteSqlIdentifier as quote, schemaFingerprint, schemaManifest } from "../schema/manifest.js";
import { FTS_SCHEMA_STATEMENTS } from "../schema/fts-definition.js";
import { initializePostgresqlSchema, inspectPostgresqlSchema, postgresqlSchemaFingerprint, postgresqlSchemaManifest, reseedPostgresqlPositions,
  POSTGRESQL_POSITION_COLUMN, POSTGRESQL_POSITION_TABLES, assertPostgresqlSchemaName, assertPostgresqlServerVersion, type PostgresqlQueryPort } from "../schema/postgresql.js";
import { rebuildSearchProjections } from "../search/fts.js";
import { assertVerifiedBackup, createVerifiedBackup } from "./backup-manifest.js";

const execFileAsync = promisify(execFile);
const positions = new Set<string>(POSTGRESQL_POSITION_TABLES);
const qualified = (schema: string, table: string) => `${quote(schema)}.${quote(table)}`;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
type Cell = null | string | number | bigint | Uint8Array;
interface Field { name: string; type: string; notNull: boolean; json: boolean; }
interface Table { name: string; fields: Field[]; }
export interface PostgresqlMigrationTableReceipt { rows: number; sha256: string; }
export interface PostgresqlMigrationPositionReceipt { lastValue: string; isCalled: boolean; maximum: string | null; nextValue: string; }
export interface PostgresqlMigrationFileEvidence { path: string; present: boolean; sha256: string | null; size: number | null; device: number | null; inode: number | null; }
export interface SqliteToPostgresqlMigrationReceipt {
  format: "aervox-sqlite-to-postgresql";
  formatVersion: 1;
  phase: "verified";
  migrationId: string;
  verifiedAt: string;
  lockPath: string;
  receiptPath: string;
  backupPath: string;
  backupManifestPath: string;
  source: PostgresqlMigrationFileEvidence;
  vault: PostgresqlMigrationFileEvidence | null;
  controlLedger: PostgresqlMigrationFileEvidence | null;
  sourceSchemaVersion: number;
  sourceSchemaFingerprint: string;
  target: { connectionFingerprint: string; database: string; databaseOid: string; schema: string; schemaOid: string; instanceId: string; locality: "verified-local" | "remote-or-unverified"; schemaFingerprint: string; };
  tables: Record<string, PostgresqlMigrationTableReceipt>;
  projections: Record<string, PostgresqlMigrationTableReceipt>;
  positionSequences: Record<string, PostgresqlMigrationPositionReceipt>;
  searchVerified: true;
}
export interface SqliteToPostgresqlMigrationInput {
  sourcePath: string;
  connectionString: string;
  targetSchema: string;
  instanceId: string;
  backupDirectory: string;
  protectedVaultPath?: string;
  controlLedgerPath?: string;
  /** Host coordinator must have stopped every source/Vault/ledger connection. */
  assertSourceQuiescent?: () => Promise<void>;
  /** Executes within the pinned import transaction. Verification is independent. */
  rebuildSearchProjections?: (target: { client: PostgresqlQueryPort; schema: string }) => Promise<void>;
}

async function fileEvidence(filename: string): Promise<PostgresqlMigrationFileEvidence> {
  const resolved = path.resolve(filename);
  let stat;
  try { stat = await fs.lstat(resolved); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: resolved, present: false, sha256: null, size: null, device: null, inode: null }; throw error; }
  if (!stat.isFile()) throw new Error(`migration input must be a regular file: ${resolved}`);
  const handle = await fs.open(resolved, "r");
  const digest = createHash("sha256");
  try { for await (const chunk of handle.readableWebStream()) digest.update(Buffer.from(chunk)); }
  finally { await handle.close(); }
  return { path: resolved, present: true, sha256: digest.digest("hex"), size: stat.size, device: stat.dev, inode: stat.ino };
}
async function assertEvidence(evidence: PostgresqlMigrationFileEvidence): Promise<void> {
  if (JSON.stringify(await fileEvidence(evidence.path)) !== JSON.stringify(evidence)) throw new Error(`migration input changed: ${evidence.path}`);
}
async function assertCheckpointed(filename: string): Promise<void> {
  for (const suffix of ["-wal", "-journal"]) {
    try { if ((await fs.lstat(`${filename}${suffix}`)).size > 0) throw new Error(`source has uncheckpointed ${suffix}; stop and checkpoint all connections first`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export async function assertMigrationFilesQuiescent(filenames: readonly string[]): Promise<void> {
  const existing: string[] = [];
  for (const filename of filenames.flatMap(name => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`])) {
    try { await fs.lstat(filename); existing.push(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!existing.length) return;
  try {
    const result = await execFileAsync("lsof", ["-t", "--", ...existing], { timeout: 15_000, maxBuffer: 64 * 1024 });
    if (result.stdout.trim()) throw new Error("source database has active file handles; stop every host first");
    throw new Error("source quiescence could not be proved");
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: string | number };
    if (result.code === 1 && !result.stdout?.trim() && !result.stderr?.trim()) return;
    throw new Error("source quiescence could not be proved; close every connection or supply the host coordinator", { cause: error });
  }
}
async function durableJson(filename: string, value: unknown): Promise<void> {
  const temporary = `${filename}.tmp-${randomUUID()}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, filename);
  if (process.platform !== "win32") { const directory = await fs.open(path.dirname(filename), "r"); try { await directory.sync(); } finally { await directory.close(); } }
}
function sourcePort(database: DatabaseSync): Pick<Client, "execute"> {
  return { execute: async (input: InStatement) => {
    const sql = typeof input === "string" ? input : input.sql;
    const args = typeof input === "string" ? [] : input.args ?? [];
    if (!Array.isArray(args)) throw new Error("named source parameters are unsupported");
    return { rows: database.prepare(sql).all(...args as SQLInputValue[]) } as Awaited<ReturnType<Client["execute"]>>;
  } };
}
function businessTables(): Table[] {
  const json = new Set<string>();
  for (const declaration of Object.values(declarations)) {
    try { const config = getTableConfig(declaration as never); for (const column of config.columns) if (column.dataType === "json") json.add(`${config.name}.${column.name}`); }
    catch { /* Non-table exports. */ }
  }
  return schemaManifest("main").filter(table => table.name !== "_aervox_schema_versions").map(table => ({ name: table.name,
    fields: [...table.columns.map(column => ({ name: column.name, type: column.type, notNull: column.notNull || column.primaryKey > 0, json: json.has(`${table.name}.${column.name}`) })),
      ...(positions.has(table.name) ? [{ name: POSTGRESQL_POSITION_COLUMN, type: "integer", notNull: true, json: false }] : [])] }));
}
function checkedCell(field: Field, value: unknown, actualType?: string): Cell {
  if (value === null) { if (field.notNull) throw new Error(`${field.name}: NULL violates canonical key/nullability`); return null; }
  if (field.type === "integer") {
    if (actualType && actualType !== "integer") throw new Error(`${field.name}: incompatible SQLite integer affinity`);
    if (typeof value === "string" && /^-?\d+$/.test(value)) value = BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) value = BigInt(value);
    if (typeof value !== "bigint" || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field.name}: unsafe integer precision`);
    return value;
  }
  if (field.type === "real") {
    if (actualType && actualType !== "real" && actualType !== "integer") throw new Error(`${field.name}: incompatible SQLite real affinity`);
    if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field.name}: non-finite or incompatible real`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (field.type === "text") {
    if (actualType && actualType !== "text") throw new Error(`${field.name}: incompatible SQLite text affinity`);
    if (actualType && value instanceof Uint8Array) value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field.name}: text contains NUL or incompatible encoding`);
    if (field.json) { try { JSON.parse(value); } catch { throw new Error(`${field.name}: invalid serialized JSON`); } }
    return value;
  }
  if (field.type === "blob" && value instanceof Uint8Array && (!actualType || actualType === "blob")) return value;
  throw new Error(`${field.name}: incompatible SQLite blob affinity`);
}
function* sourceRows(database: DatabaseSync, table: Table): Generator<Cell[]> {
  const fields = table.fields.map((field, index) => { const name = positions.has(table.name) && field.name === POSTGRESQL_POSITION_COLUMN ? "rowid" : quote(field.name);
    return `typeof(${name}) AS ${quote(`t${index}`)}, CASE WHEN typeof(${name})='text' THEN CAST(${name} AS BLOB) ELSE ${name} END AS ${quote(`v${index}`)}`; });
  const statement = database.prepare(`SELECT ${fields.join(",")} FROM ${quote(table.name)}`); statement.setReadBigInts(true);
  let position = 0;
  for (const row of statement.iterate()) {
    try { yield table.fields.map((field, index) => checkedCell(field, row[`v${index}`], String(row[`t${index}`]))); }
    catch (error) { throw new Error(`migration preflight ${table.name}[${position}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    position++;
  }
}
function rowDigest(row: readonly Cell[]): string {
  const digest = createHash("sha256");
  for (const cell of row) {
    let type: string, bytes: Buffer;
    if (cell === null) { type = "null"; bytes = Buffer.alloc(0); }
    else if (typeof cell === "bigint") { type = "integer"; bytes = Buffer.from(cell.toString()); }
    else if (typeof cell === "number") { type = "real"; bytes = Buffer.alloc(8); bytes.writeDoubleBE(cell); }
    else if (typeof cell === "string") { type = "text"; bytes = Buffer.from(cell, "utf8"); }
    else { type = "blob"; bytes = Buffer.from(cell); }
    digest.update(`${type}:${bytes.length}:`); digest.update(bytes); digest.update(";");
  }
  return digest.digest("hex");
}
function tableDigest(rows: Iterable<readonly Cell[]>): PostgresqlMigrationTableReceipt {
  const hashes = Array.from(rows, rowDigest).sort();
  return { rows: hashes.length, sha256: hash(hashes.join("\n")) };
}
async function targetTableDigest(client: PostgresqlQueryPort, schema: string, table: Table): Promise<PostgresqlMigrationTableReceipt> {
  const hashes: string[] = [];
  await client.query(`DECLARE aervox_migration_verify NO SCROLL CURSOR FOR SELECT ${table.fields.map(field => quote(field.name)).join(",")} FROM ${qualified(schema, table.name)}`);
  try {
    while (true) {
      const result = await client.query("FETCH 512 FROM aervox_migration_verify");
      if (!result.rows.length) break;
      for (const row of result.rows) hashes.push(rowDigest(table.fields.map(field => checkedCell(field, row[field.name]))));
    }
  } finally { await client.query("CLOSE aervox_migration_verify"); }
  hashes.sort(); return { rows: hashes.length, sha256: hash(hashes.join("\n")) };
}
const projectionTables: Table[] = ["messages_fts", "memories_fts"].map(name => ({ name, fields: ["id", "content"].map(name => ({ name, type: "text", notNull: true, json: false })) }));
// Skill payloads, lifecycle history and imported workspace content can be
// derived from local-only sources; their table names do not prove eligibility.
const remoteSafeTables = new Set(["plugins", "plugin_grants", "plugin_configs", "plugin_config_secrets", "plugin_pages", "llm_configs", "voice_configs", "voice_input_configs", "voice_remote_configs", "mcp_servers", "mcp_tools", "tool_policies", "tool_registrations", "skill_registrations"]);
async function inspectSource(database: DatabaseSync): Promise<void> {
  const issues = await inspectSchemaParity(sourcePort(database) as Client, "main");
  if (issues.length) throw new Error(`source schema requires canonical staging first: ${issues.join("; ")}`);
  const receipt = database.prepare("SELECT scope,version,fingerprint FROM _aervox_schema_versions ORDER BY scope").all();
  if (receipt.length !== 1 || receipt[0]?.scope !== "main" || Number(receipt[0]?.version) !== CURRENT_SCHEMA_VERSION || receipt[0]?.fingerprint !== schemaFingerprint("main")
    || SCHEMA_RELEASES[CURRENT_SCHEMA_VERSION]?.main !== schemaFingerprint("main")) throw new Error("source canonical version/fingerprint is not current");
  if (database.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')").all().length) throw new Error("source has undeclared triggers or views");
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("source integrity_check failed");
  if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("source foreign_key_check failed");
  for (const table of database.prepare("PRAGMA table_list").all()) {
    if (isDerivedSearchTable(String(table.name))) {
      const name = String(table.name);
      if ((name === "messages_fts" || name === "memories_fts") ? table.type !== "virtual" : table.type !== "shadow") throw new Error(`source search projection contains undeclared primary data: ${name}`);
      if (table.type === "virtual") {
        const sql = String(database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name)?.sql);
        const normalize = (value: string) => value.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/[\s;"`\[\]]/g, "").toLowerCase();
        const expected = FTS_SCHEMA_STATEMENTS.find(statement => statement.includes(name));
        if (!expected || normalize(sql) !== normalize(expected)) throw new Error(`source search projection definition is undeclared: ${name}`);
      }
    }
    if (table.name === "recovery_control_ledger" && Number(database.prepare("SELECT count(*) AS n FROM recovery_control_ledger").get()?.n)) throw new Error("main source contains independent ledger data; separate and verify its ownership first");
  }
}
function importOrder(tables: Table[]): { tables: Table[]; cyclic: boolean } {
  const manifest = postgresqlSchemaManifest(), names = new Set(tables.map(table => table.name));
  const dependencies = new Map(manifest.map(table => [table.name, new Set(table.constraints.filter(item => item.kind === "f" && names.has(item.target!)).map(item => item.target!))]));
  const remaining = new Map(tables.map(table => [table.name, table])), ordered: Table[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(table => [...(dependencies.get(table.name) ?? [])].every(name => !remaining.has(name)));
    if (!ready.length) return { tables: [...ordered, ...remaining.values()], cyclic: true };
    for (const table of ready) { remaining.delete(table.name); ordered.push(table); }
  }
  return { tables: ordered, cyclic: false };
}
async function targetIdentity(client: PostgresqlQueryPort, schema: string): Promise<{ database: string; databaseOid: string; schemaOid: string }> {
  const result = await client.query("SELECT current_database() AS database, (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid, (SELECT oid::text FROM pg_namespace WHERE nspname=$1) AS schema_oid", [schema]);
  const row = result.rows[0];
  if (!row || typeof row.database !== "string" || typeof row.database_oid !== "string" || typeof row.schema_oid !== "string") throw new Error("target identity cannot be verified");
  return { database: row.database, databaseOid: row.database_oid, schemaOid: row.schema_oid };
}
async function positionSequences(client: PostgresqlQueryPort, schema: string): Promise<Record<string, PostgresqlMigrationPositionReceipt>> {
  const positions: Record<string, PostgresqlMigrationPositionReceipt> = {};
  for (const table of POSTGRESQL_POSITION_TABLES) {
    const sequence = (await client.query("SELECT c.relname AS name, n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,$2)::regclass", [qualified(schema, table), POSTGRESQL_POSITION_COLUMN])).rows[0];
    if (!sequence || sequence.schema !== schema || typeof sequence.name !== "string") throw new Error(`insertion sequence owner differs: ${table}`);
    const row = (await client.query(`SELECT last_value::text AS value,is_called FROM ${qualified(schema, sequence.name)}`)).rows[0];
    const maximum = (await client.query(`SELECT max(${quote(POSTGRESQL_POSITION_COLUMN)})::text AS maximum FROM ${qualified(schema, table)}`)).rows[0]?.maximum;
    if (!row || typeof row.value !== "string" || typeof row.is_called !== "boolean" || maximum !== null && typeof maximum !== "string") throw new Error(`insertion sequence state cannot be verified: ${table}`);
    const next = BigInt(row.value) + (row.is_called ? 1n : 0n);
    if (next < 1n || next > BigInt(Number.MAX_SAFE_INTEGER) || maximum !== null && next <= BigInt(maximum)) throw new Error(`insertion sequence does not follow imported positions: ${table}`);
    positions[table] = { lastValue: row.value, isCalled: row.is_called, maximum, nextValue: next.toString() };
  }
  return positions;
}
async function verifyTarget(client: PostgresqlQueryPort, receipt: SqliteToPostgresqlMigrationReceipt): Promise<void> {
  const schema = receipt.target.schema;
  const identity = await targetIdentity(client, schema);
  if (identity.database !== receipt.target.database || identity.databaseOid !== receipt.target.databaseOid || identity.schemaOid !== receipt.target.schemaOid) throw new Error("migration target identity changed");
  const issues = await inspectPostgresqlSchema({ client, schema, instanceId: receipt.target.instanceId });
  if (issues.length || receipt.target.schemaFingerprint !== postgresqlSchemaFingerprint()) throw new Error(`target schema verification failed: ${issues.join("; ")}`);
  for (const table of [...businessTables(), ...projectionTables]) {
    const expected = receipt.tables[table.name] ?? receipt.projections[table.name];
    if (!expected || JSON.stringify(await targetTableDigest(client, schema, table)) !== JSON.stringify(expected)) throw new Error(`target content verification failed: ${table.name}`);
  }
  if (JSON.stringify(await positionSequences(client, schema)) !== JSON.stringify(receipt.positionSequences)) throw new Error("target insertion sequence state changed");
}

export async function prepareSqliteToPostgresqlMigration(input: SqliteToPostgresqlMigrationInput): Promise<SqliteToPostgresqlMigrationReceipt> {
  assertPostgresqlSchemaName(input.targetSchema);
  if (!input.instanceId.trim() || input.instanceId.length > 256 || input.instanceId.includes("\0")) throw new Error("valid instance identity is required");
  const sourcePath = path.resolve(input.sourcePath), backupDirectory = path.resolve(input.backupDirectory), lockPath = `${sourcePath}.aervox-migration.lock`;
  const evidencePaths = [sourcePath, input.protectedVaultPath, input.controlLedgerPath].filter((name): name is string => !!name).map(name => path.resolve(name));
  if (new Set([...evidencePaths, backupDirectory]).size !== evidencePaths.length + 1) throw new Error("migration source, Vault, ledger and backup paths must differ");
  const source = await fileEvidence(sourcePath);
  if (!source.present) throw new Error("source database does not exist");
  const migrationId = randomUUID();
  const claim = await fs.open(lockPath, "wx", 0o600);
  await claim.writeFile(`${JSON.stringify({ format: "aervox-database-migration-lock", migrationId, phase: "claimed", sourcePath, processId: process.pid })}\n`); await claim.sync(); await claim.close();
  const phase = async (state: string, details: Record<string, unknown> = {}) => {
    const previous = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (previous.migrationId !== migrationId) throw new Error("migration lock owner changed");
    await durableJson(lockPath, { ...previous, ...details, phase: state, updatedAt: new Date().toISOString() });
  };
  let database: DatabaseSync | undefined, pool: Pool | undefined, client: PoolClient | undefined;
  let transaction = false, committed = false, commitAttempted = false, connectionFailed = false;
  try {
    await (input.assertSourceQuiescent ? input.assertSourceQuiescent() : assertMigrationFilesQuiescent(evidencePaths));
    for (const filename of evidencePaths) await assertCheckpointed(filename);
    await assertEvidence(source);
    const vault = input.protectedVaultPath ? await fileEvidence(input.protectedVaultPath) : null;
    const controlLedger = input.controlLedgerPath ? await fileEvidence(input.controlLedgerPath) : null;
    await fs.mkdir(backupDirectory, { mode: 0o700 });
    const backup = await createVerifiedBackup({ destinationDir: backupDirectory, schemaVersion: String(CURRENT_SCHEMA_VERSION), artifacts: [
      { role: "database", sourcePath, relativePath: "source.db" },
      ...(vault?.present ? [{ role: "vault" as const, sourcePath: vault.path, relativePath: "vault.db" }] : []),
      ...(controlLedger?.present ? [{ role: "recovery-ledger" as const, sourcePath: controlLedger.path, relativePath: "control-ledger.db" }] : []),
    ] });
    for (const artifact of backup.manifest.artifacts) await fs.chmod(path.join(backupDirectory, artifact.relativePath), 0o600);
    for (const artifact of backup.manifest.artifacts) {
      const handle = await fs.open(path.join(backupDirectory, artifact.relativePath), "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await assertVerifiedBackup(backup.manifestPath);
    for (const evidence of [source, vault, controlLedger]) if (evidence) await assertEvidence(evidence);
    await phase("backed-up", { backupManifestPath: backup.manifestPath });
    const inspectionPath = path.join(backupDirectory, "source-inspection.db");
    await fs.copyFile(path.join(backupDirectory, "source.db"), inspectionPath, fs.constants.COPYFILE_EXCL); await fs.chmod(inspectionPath, 0o600);
    database = new DatabaseSync(inspectionPath); database.exec("PRAGMA foreign_keys=ON");
    await inspectSource(database);
    const tables = businessTables(), tableReceipts = Object.fromEntries(tables.map(table => [table.name, tableDigest(sourceRows(database!, table))]));
    // Rebuild in the expendable SQLite inspection copy to independently qualify
    // eligible current history. Primary source and verified backup are untouched.
    for (const statement of FTS_SCHEMA_STATEMENTS) database.exec(statement);
    await rebuildSearchProjections(sourcePort(database));
    const projections = Object.fromEntries(projectionTables.map(table => [table.name, tableDigest(sourceRows(database!, table))]));
    if (!input.rebuildSearchProjections && Object.values(projections).some(table => table.rows)) throw new Error("a host search projection rebuild callback is required for nonempty search sources");
    pool = new Pool(postgresqlPoolConfig(input.connectionString)); client = await pool.connect();
    client.on("error", () => { connectionFailed = true; });
    await assertPostgresqlServerVersion(client);
    const locality = await proveLocalPostgresqlStorage(client, input.connectionString) ? "verified-local" : "remote-or-unverified";
    if (locality !== "verified-local") {
      const unknown = Object.entries(tableReceipts).filter(([table, receipt]) => receipt.rows && !remoteSafeTables.has(table)).map(([table]) => table);
      // Vault history can have influenced ordinary main rows without retaining a
      // local_only tag. No automatic reclassification or deletion is allowed.
      if (vault?.present) {
        const vaultDatabase = new DatabaseSync(path.join(backupDirectory, "vault.db"), { readOnly: true });
        try { for (const item of vaultDatabase.prepare("PRAGMA table_list").all()) if (item.schema === "main" && item.type === "table" && !String(item.name).startsWith("sqlite_") && item.name !== "_aervox_schema_versions"
          && Number(vaultDatabase.prepare(`SELECT count(*) AS n FROM ${quote(String(item.name))}`).get()?.n)) unknown.push(`Vault:${String(item.name)}`); }
        finally { vaultDatabase.close(); }
      }
      if (unknown.length) throw new Error(`remote migration blocked by local-only or unclassified protected history: ${unknown.join(", ")}`);
    }
    await phase("preflight-verified", { targetSchema: input.targetSchema, instanceId: input.instanceId, locality });
    await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [input.targetSchema, input.instanceId]);
    const namespace = await client.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [input.targetSchema]);
    if (!namespace.rows.length) await client.query(`CREATE SCHEMA ${quote(input.targetSchema)}`);
    const initialized = await initializePostgresqlSchema({ client, schema: input.targetSchema, instanceId: input.instanceId });
    if (!initialized.created) throw new Error("migration target must be an unused dedicated empty schema");
    const identity = await targetIdentity(client, input.targetSchema);
    await phase("target-initialized", { target: identity });
    await client.query("BEGIN"); transaction = true;
    const order = importOrder(tables), deferred: Array<{ table: string; name: string }> = [];
    if (order.cyclic) {
      const keys = await client.query("SELECT c.relname AS table, con.conname AS name FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND con.contype='f'", [input.targetSchema]);
      for (const key of keys.rows) { const item = { table: String(key.table), name: String(key.name) }; deferred.push(item); await client.query(`ALTER TABLE ${qualified(input.targetSchema, item.table)} ALTER CONSTRAINT ${quote(item.name)} DEFERRABLE INITIALLY DEFERRED`); }
    }
    await phase("importing");
    for (const table of order.tables) {
      const sql = `INSERT INTO ${qualified(input.targetSchema, table.name)} (${table.fields.map(field => quote(field.name)).join(",")}) VALUES (${table.fields.map((_field, index) => `$${index + 1}`).join(",")})`;
      for (const row of sourceRows(database, table)) await client.query(sql, row.map(cell => typeof cell === "bigint" ? cell.toString() : cell instanceof Uint8Array ? Buffer.from(cell) : cell));
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const key of deferred) await client.query(`ALTER TABLE ${qualified(input.targetSchema, key.table)} ALTER CONSTRAINT ${quote(key.name)} NOT DEFERRABLE INITIALLY IMMEDIATE`);
    await reseedPostgresqlPositions(client, input.targetSchema);
    if (input.rebuildSearchProjections) await input.rebuildSearchProjections({ client, schema: input.targetSchema });
    const receipt: SqliteToPostgresqlMigrationReceipt = { format: "aervox-sqlite-to-postgresql", formatVersion: 1, phase: "verified", migrationId, verifiedAt: new Date().toISOString(), lockPath,
      receiptPath: path.join(backupDirectory, "postgresql-migration-receipt.json"), backupPath: path.join(backupDirectory, "source.db"), backupManifestPath: backup.manifestPath,
      source, vault, controlLedger, sourceSchemaVersion: CURRENT_SCHEMA_VERSION, sourceSchemaFingerprint: schemaFingerprint("main"),
      target: { connectionFingerprint: hash(input.connectionString), ...identity, schema: input.targetSchema, instanceId: input.instanceId, locality, schemaFingerprint: postgresqlSchemaFingerprint() },
      tables: tableReceipts, projections, positionSequences: await positionSequences(client, input.targetSchema), searchVerified: true };
    await verifyTarget(client, receipt);
    for (const evidence of [source, vault, controlLedger]) if (evidence) { await assertEvidence(evidence); await assertCheckpointed(evidence.path); }
    await assertVerifiedBackup(backup.manifestPath);
    await phase("commit-pending", { receiptPath: receipt.receiptPath, target: receipt.target });
    commitAttempted = true;
    await client.query("COMMIT"); transaction = false; committed = true;
    await durableJson(receipt.receiptPath, receipt);
    await phase("verified", { receiptPath: receipt.receiptPath, receiptSha256: hash(await fs.readFile(receipt.receiptPath)) });
    return receipt;
  } catch (error) {
    let rollbackConfirmed = !transaction;
    if (transaction && client) { try { await client.query("ROLLBACK"); rollbackConfirmed = true; } catch { /* Unknown outcome keeps admission closed. */ } }
    await phase(committed || commitAttempted || connectionFailed || !rollbackConfirmed ? "outcome-unknown" : "failed", { failure: error instanceof Error ? error.message : String(error), rollbackConfirmed }).catch(() => undefined);
    throw new Error(`PostgreSQL migration preparation failed; source, backup, staging and lock are retained: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { database?.close(); client?.release(connectionFailed ? new Error("POSTGRESQL_MIGRATION_CONNECTION_FAILED") : undefined); await pool?.end(); }
}

/** Recheck the immutable preparation evidence immediately before activation.
 * Caller still owns source admission and config/plugin consistency checks. */
export async function verifySqliteToPostgresqlMigrationReceipt(receiptPath: string, input: { connectionString: string }): Promise<SqliteToPostgresqlMigrationReceipt> {
  const raw = await fs.readFile(receiptPath), receipt = JSON.parse(raw.toString("utf8")) as SqliteToPostgresqlMigrationReceipt;
  if (receipt.format !== "aervox-sqlite-to-postgresql" || receipt.formatVersion !== 1 || receipt.phase !== "verified" || receipt.searchVerified !== true
    || path.resolve(receipt.receiptPath) !== path.resolve(receiptPath) || receipt.target.connectionFingerprint !== hash(input.connectionString)
    || receipt.sourceSchemaFingerprint !== schemaFingerprint("main") || receipt.sourceSchemaVersion !== CURRENT_SCHEMA_VERSION) throw new Error("invalid PostgreSQL migration receipt");
  const lock = JSON.parse(await fs.readFile(receipt.lockPath, "utf8"));
  if (lock.migrationId !== receipt.migrationId || lock.phase !== "verified" || lock.receiptSha256 !== hash(raw)) throw new Error("migration lock/receipt evidence differs");
  await assertVerifiedBackup(receipt.backupManifestPath);
  const backup = await fileEvidence(receipt.backupPath);
  if (backup.sha256 !== receipt.source.sha256 || backup.size !== receipt.source.size) throw new Error("migration backup differs from source receipt");
  for (const evidence of [receipt.source, receipt.vault, receipt.controlLedger]) if (evidence) { await assertEvidence(evidence); await assertCheckpointed(evidence.path); }
  const pool = new Pool(postgresqlPoolConfig(input.connectionString));
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    client.on("error", () => { /* The next query rejects; do not turn a network failure into an unhandled process event. */ });
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [receipt.target.schema, receipt.target.instanceId]);
    if (receipt.target.locality === "verified-local" && !(await proveLocalPostgresqlStorage(client, input.connectionString))) throw new Error("local target storage ownership changed");
    await verifyTarget(client, receipt); await client.query("COMMIT");
    return receipt;
  } catch (error) { await client?.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client?.release(); await pool.end(); }
}
