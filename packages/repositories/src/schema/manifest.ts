/** Canonical physical schema compiled from the shared declarations. Historical DDL is never replayed on a live legacy database. */
import { createHash } from "node:crypto";
import { createClient, type Client } from "@libsql/client";
import { SQL, is } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as schema from "@aervox/schema";
import { tableDefinitionSemantics } from "./table-semantics.js";

export type SchemaScope = "main" | "ledger";
export const CURRENT_SCHEMA_VERSION = 1;
/** Immutable release ledger: change target declarations only with a new version and staged upgrade. */
export const SCHEMA_RELEASES: Readonly<Record<number, Readonly<Record<SchemaScope, string>>>> = {
  1: { main: "c749a41cf2155d0b070c08746bd353e77479d6766b113d8e4f78bcaeda5961b4", ledger: "a14fd3df3feaf5a736b112f3d65c731a26e0689b90583c3ae9030840f308d8eb" },
};
const VERSION_TABLE = "_aervox_schema_versions";
/** Shared parameterized receipt. applied_at is supplied only after initialization verification. */
export const SCHEMA_VERSION_JOURNAL_SQL = `INSERT INTO "${VERSION_TABLE}" (scope, version, fingerprint, applied_at) VALUES (:scope, :version, :fingerprint, :applied_at) ON CONFLICT(scope) DO NOTHING`;
const LEDGER_TABLE = "recovery_control_ledger";
const isDerivedSearchTable = (name: string): boolean => /^(messages|memories)_fts(?:_(?:data|idx|content|docsize|config))?$/.test(name);
export const quoteSqlIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const dialect = new SQLiteSyncDialect();

function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("unsupported physical schema literal");
}
function expression(value: SQL): string {
  const query = dialect.sqlToQuery(value);
  let index = 0;
  return query.sql.replace(/\?/g, () => literal(query.params[index++]));
}
function columnDefault(column: SQLiteColumn): string | null {
  if (column.default === undefined) return null;
  return is(column.default, SQL) ? expression(column.default) : literal(column.mapToDriverValue(column.default as never));
}
function normalizeSql(value: string | null): string | null {
  if (value === null) return null;
  const literals: string[] = [];
  let normalized = value.replace(/'(?:''|[^'])*'/g, (literal) => { literals.push(literal); return `__literal_${literals.length - 1}__`; })
    .replace(/["`\[\]]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.startsWith("(") && normalized.endsWith(")")) {
    let depth = 0, whole = true;
    for (let index = 0; index < normalized.length - 1; index++) {
      if (normalized[index] === "(") depth++;
      else if (normalized[index] === ")") depth--;
      if (depth === 0) { whole = false; break; }
    }
    if (whole) normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/__literal_(\d+)__/g, (_match, index) => literals[Number(index)]!);
}

export function schemaManifest(scope: SchemaScope) {
  const configs: ReturnType<typeof getTableConfig>[] = [];
  for (const value of Object.values(schema)) {
    try {
      const config = getTableConfig(value as never);
      if (!config?.name || configs.some((other) => other.name === config.name)) continue;
      if (config.name !== VERSION_TABLE && ((config.name === LEDGER_TABLE) !== (scope === "ledger"))) continue;
      configs.push(config);
    } catch { /* Non-table exports. */ }
  }
  return configs.sort((a, b) => a.name.localeCompare(b.name)).map((config) => {
    const fields = config.columns.map((column) => {
      const defaultSql = columnDefault(column);
      return `${quoteSqlIdentifier(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}${column.primary ? " PRIMARY KEY" : ""}${defaultSql === null ? "" : ` DEFAULT ${defaultSql}`}`;
    });
    for (const primary of config.primaryKeys) fields.push(`PRIMARY KEY (${primary.columns.map((column) => quoteSqlIdentifier(column.name)).join(", ")})`);
    for (const unique of config.uniqueConstraints) fields.push(`UNIQUE (${unique.columns.map((column) => quoteSqlIdentifier(column.name)).join(", ")})`);
    const foreignKeys = config.foreignKeys.flatMap((foreign) => {
      const ref = foreign.reference();
      const target = getTableConfig(ref.foreignTable).name;
      fields.push(`FOREIGN KEY (${ref.columns.map((column) => quoteSqlIdentifier(column.name)).join(", ")}) REFERENCES ${quoteSqlIdentifier(target)} (${ref.foreignColumns.map((column) => quoteSqlIdentifier(column.name)).join(", ")}) ON DELETE ${foreign.onDelete ?? "no action"} ON UPDATE ${foreign.onUpdate ?? "no action"}`);
      return ref.columns.map((column, index) => `${column.name}->${target}.${ref.foreignColumns[index]!.name}|${foreign.onDelete ?? "no action"}|${foreign.onUpdate ?? "no action"}`.toLowerCase());
    });
    for (const check of config.checks) fields.push(`CONSTRAINT ${quoteSqlIdentifier(check.name)} CHECK (${expression(check.value)})`);
    const indexes = config.indexes.map((index) => {
      const columns = index.config.columns.map((column) => "name" in column ? quoteSqlIdentifier(column.name) : expression(column as SQL));
      const where = index.config.where ? expression(index.config.where) : null;
      return { name: index.config.name, unique: Boolean(index.config.unique), columns: columns.map((column) => normalizeSql(column)), where: normalizeSql(where),
        sql: `CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX ${quoteSqlIdentifier(index.config.name)} ON ${quoteSqlIdentifier(config.name)} (${columns.join(", ")})${where ? ` WHERE ${where}` : ""}` };
    });
    return { name: config.name, sql: `CREATE TABLE ${quoteSqlIdentifier(config.name)} (${fields.join(", ")})`, indexes, foreignKeys: foreignKeys.sort(),
      columns: config.columns.map((column) => ({ name: column.name, type: column.getSQLType().toLowerCase(), notNull: column.notNull,
        default: normalizeSql(columnDefault(column)), primaryKey: column.primary ? 1 : Math.max(0, ...config.primaryKeys.map((primary) => primary.columns.indexOf(column) + 1)) })),
      uniques: config.uniqueConstraints.map((unique) => unique.columns.map((column) => column.name).join(",")).sort() };
  });
}
export function schemaFingerprint(scope: SchemaScope): string {
  return createHash("sha256").update(JSON.stringify(schemaManifest(scope))).digest("hex");
}

/** SQLite exposes expression keys as cid=-2; retain their SQL as well as xinfo's physical ordering. */
function indexSqlParts(definition: string): { terms: string[]; where: string | null } {
  const terms: string[] = [];
  let depth = 0, start = -1;
  let quote: string | null = null;
  for (let offset = 0; offset < definition.length; offset++) {
    const char = definition[offset]!;
    if (quote !== null) {
      if (char === quote) {
        if (quote !== "]" && definition[offset + 1] === quote) offset++;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      quote = char === "[" ? "]" : char;
      continue;
    }
    if (char === "-" && definition[offset + 1] === "-") {
      const end = definition.indexOf("\n", offset + 2);
      if (end < 0) break;
      offset = end;
      continue;
    }
    if (char === "/" && definition[offset + 1] === "*") {
      const end = definition.indexOf("*/", offset + 2);
      if (end < 0) break;
      offset = end + 1;
      continue;
    }
    if (char === "(") {
      if (depth++ === 0) start = offset + 1;
    } else if (char === "," && depth === 1) {
      terms.push(definition.slice(start, offset).trim());
      start = offset + 1;
    } else if (char === ")" && --depth === 0) {
      terms.push(definition.slice(start, offset).trim());
      const suffix = definition.slice(offset + 1).replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "").trim().replace(/;\s*$/, "");
      return { terms, where: /^WHERE\b/i.test(suffix) ? normalizeSql(suffix.replace(/^WHERE\b/i, "").trim()) : null };
    }
  }
  return { terms, where: null };
}

function indexExpression(term: string): string | null {
  // These suffixes are represented by index_xinfo. Keep modifiers inside an expression intact.
  return normalizeSql(term.replace(/\s+(?:ASC|DESC)\s*$/i, "")
    .replace(/\s+COLLATE\s+(?:"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\w]+)\s*$/i, ""));
}

async function physicalIndexes(client: Client, table: string) {
  const listed = await client.execute(`PRAGMA index_list(${quoteSqlIdentifier(table)})`);
  const indexes = [];
  for (const listedIndex of listed.rows) {
    const name = String(listedIndex.name);
    const [details, master] = await Promise.all([
      client.execute(`PRAGMA index_xinfo(${quoteSqlIdentifier(name)})`),
      client.execute({ sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", args: [name] }),
    ]);
    const parts = indexSqlParts(String(master.rows[0]?.sql ?? ""));
    const keys = details.rows.filter((key) => Boolean(key.key)).sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((key) => {
      const term = parts.terms[Number(key.seqno)];
      if (Number(key.cid) === -2 && term === undefined) throw new Error(`cannot inspect expression key in index ${name}`);
      return {
        column: key.name === null ? null : String(key.name),
        expression: Number(key.cid) === -2 ? indexExpression(term!) : null,
        descending: Boolean(key.desc),
        collation: String(key.coll ?? "BINARY").toLowerCase(),
      };
    });
    indexes.push({ name, origin: String(listedIndex.origin), unique: Boolean(listedIndex.unique), partial: Boolean(listedIndex.partial), keys, where: parts.where });
  }
  return indexes;
}

type PhysicalIndexes = Awaited<ReturnType<typeof physicalIndexes>>;

async function physicalForeignKeys(client: Client, table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA foreign_key_list(${quoteSqlIdentifier(table)})`);
  const groups = new Map<number, typeof result.rows>();
  for (const row of result.rows) {
    const group = groups.get(Number(row.id)) ?? [];
    group.push(row);
    groups.set(Number(row.id), group);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => Number(a.seq) - Number(b.seq));
    const first = group[0]!;
    return JSON.stringify({ table: String(first.table).toLowerCase(),
      columns: group.map(row => [String(row.from).toLowerCase(), row.to === null ? null : String(row.to).toLowerCase()]),
      onDelete: String(first.on_delete).toLowerCase(), onUpdate: String(first.on_update).toLowerCase(), match: String(first.match).toLowerCase() });
  }).sort();
}

async function physicalTable(client: Client, table: string) {
  const [listed, definition, indexes, foreignKeys, columnInfo] = await Promise.all([
    client.execute(`PRAGMA table_list(${quoteSqlIdentifier(table)})`),
    client.execute({ sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] }),
    physicalIndexes(client, table), physicalForeignKeys(client, table),
    client.execute(`PRAGMA table_xinfo(${quoteSqlIdentifier(table)})`),
  ]);
  const row = listed.rows.find(value => value.schema === "main" && value.name === table);
  if (!row || typeof definition.rows[0]?.sql !== "string") throw new Error("cannot inspect table definition");
  const columns = columnInfo.rows.map(column => ({ name: String(column.name), type: String(column.type).toLowerCase(),
    notNull: Boolean(column.notnull), default: normalizeSql(column.dflt_value === null ? null : String(column.dflt_value)),
    primaryKey: Number(column.pk), hidden: Number(column.hidden) }));
  return { indexes, foreignKeys, columns, options: { type: String(row.type), withoutRowid: Boolean(row.wr), strict: Boolean(row.strict) },
    definition: tableDefinitionSemantics(definition.rows[0].sql) };
}

type PhysicalTable = Awaited<ReturnType<typeof physicalTable>>;
const canonicalTables = new Map<SchemaScope, Promise<Map<string, PhysicalTable>>>();
function canonicalPhysicalTables(scope: SchemaScope): Promise<Map<string, PhysicalTable>> {
  const cached = canonicalTables.get(scope);
  if (cached) return cached;
  const compiled = (async () => {
    // Compile declarations in an independent disposable database. Never create temporary objects in the inspected database.
    const isolated = createClient({ url: ":memory:" });
    try {
      const tables = schemaManifest(scope);
      await isolated.batch(tables.flatMap((table) => [table.sql, ...table.indexes.map((index) => index.sql)]), "write");
      const result = new Map<string, PhysicalTable>();
      for (const table of tables) result.set(table.name, await physicalTable(isolated, table.name));
      return result;
    } finally { isolated.close(); }
  })();
  canonicalTables.set(scope, compiled);
  void compiled.catch(() => { canonicalTables.delete(scope); });
  return compiled;
}

function comparableIndexes(indexes: PhysicalIndexes, origin: string): string[] {
  return indexes.filter((index) => index.origin === origin).map(({ name, origin: _origin, ...index }) => JSON.stringify({
    ...(origin === "c" ? { name } : {}), ...index,
  })).sort();
}

/** Full physical comparison, including columns, defaults, nullability, keys and partial indexes. */
export async function inspectSchemaParity(client: Client, scope: SchemaScope, options: { allowUnversioned?: boolean } = {}): Promise<string[]> {
  const issues: string[] = [];
  const manifest = schemaManifest(scope);
  const expectedTables = await canonicalPhysicalTables(scope);
  const existing = await client.execute("PRAGMA table_list");
  const actualTables = new Set(existing.rows.filter((row) => row.schema === "main" && (row.type === "table" || row.type === "virtual") && !String(row.name).startsWith("sqlite_") && !isDerivedSearchTable(String(row.name))).map((row) => String(row.name)));
  const allowedOtherScope = scope === "main" ? new Set([LEDGER_TABLE]) : new Set(schemaManifest("main").map((table) => table.name));
  for (const actual of actualTables) if (!manifest.some((table) => table.name === actual) && !allowedOtherScope.has(actual)) issues.push(`${actual}: undeclared table`);
  for (const table of manifest) {
    if (!actualTables.has(table.name) && table.name === VERSION_TABLE && options.allowUnversioned) continue;
    if (!actualTables.has(table.name)) { issues.push(`${table.name}: missing table`); continue; }
    let actualTable: PhysicalTable;
    try { actualTable = await physicalTable(client, table.name); }
    catch { issues.push(`${table.name}: cannot inspect table semantics`); continue; }
    const expectedTable = expectedTables.get(table.name)!;
    for (const expected of expectedTable.columns) {
      const actual = actualTable.columns.find(column => column.name === expected.name);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) issues.push(`${table.name}.${expected.name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    for (const actual of actualTable.columns) {
      const expected = expectedTable.columns.find(column => column.name === actual.name);
      if (!expected) issues.push(`${table.name}.${actual.name}: undeclared column`);
      if (actual.hidden !== (expected?.hidden ?? 0)) issues.push(`${table.name}.${actual.name}: undeclared hidden or generated column`);
    }
    if (JSON.stringify(actualTable.columns.map(column => column.name)) !== JSON.stringify(expectedTable.columns.map(column => column.name))) issues.push(`${table.name}: column order differs`);
    if (JSON.stringify(actualTable.options) !== JSON.stringify(expectedTable.options)) issues.push(`${table.name}: table options differ`);
    if (JSON.stringify(actualTable.foreignKeys) !== JSON.stringify(expectedTable.foreignKeys)) issues.push(`${table.name}: foreign keys differ`);
    for (const key of ["checks", "collations", "conflicts", "autoIncrement", "foreignModifiers"] as const) {
      if (JSON.stringify(actualTable.definition[key]) !== JSON.stringify(expectedTable.definition[key])) issues.push(`${table.name}: ${key} differ`);
    }
    const actualIndexes = actualTable.indexes;
    const expectedIndexes = expectedTable.indexes;
    if (JSON.stringify(comparableIndexes(expectedIndexes, "c")) !== JSON.stringify(comparableIndexes(actualIndexes, "c"))) issues.push(`${table.name}: indexes or partial predicates differ`);
    if (JSON.stringify(comparableIndexes(expectedIndexes, "u")) !== JSON.stringify(comparableIndexes(actualIndexes, "u"))) issues.push(`${table.name}: unique constraints differ`);
    if (JSON.stringify(comparableIndexes(expectedIndexes, "pk")) !== JSON.stringify(comparableIndexes(actualIndexes, "pk"))) issues.push(`${table.name}: primary key indexes differ`);
  }
  return issues;
}

export class SchemaMigrationRequiredError extends Error {
  readonly code = "SCHEMA_STAGING_MIGRATION_REQUIRED";
  constructor(readonly issues: readonly string[], sourceUnmodified = true) {
    super(`Database requires explicit staging migration; ${sourceUnmodified ? "source was not modified" : "concurrent initialization failed verification; retain database files for inspection"}:\n${issues.join("\n")}`);
  }
}

export async function initializeCanonicalSchema(client: Client, scope: SchemaScope): Promise<void> {
  const listed = await client.execute("PRAGMA table_list");
  const existing = { rows: listed.rows.filter((row) => row.schema === "main" && (row.type === "table" || row.type === "virtual") && !String(row.name).startsWith("sqlite_") && !isDerivedSearchTable(String(row.name))) };
  const owned = new Set(schemaManifest(scope).map((table) => table.name));
  const versionTableExists = existing.rows.some((row) => row.name === VERSION_TABLE);
  const fingerprint = schemaFingerprint(scope);
  if (SCHEMA_RELEASES[CURRENT_SCHEMA_VERSION]?.[scope] !== fingerprint) throw new SchemaMigrationRequiredError([`${scope}: target changed without a versioned migration`]);
  if (versionTableExists) {
    const version = await client.execute({ sql: `SELECT version, fingerprint FROM ${quoteSqlIdentifier(VERSION_TABLE)} WHERE scope = ?`, args: [scope] });
    if (version.rows[0] && (String(version.rows[0].version) !== String(CURRENT_SCHEMA_VERSION) || version.rows[0].fingerprint !== fingerprint)) throw new SchemaMigrationRequiredError([`${scope}: migration version/fingerprint mismatch`]);
  }
  const ownedTables = existing.rows.map((row) => String(row.name)).filter((name) => owned.has(name) && name !== VERSION_TABLE);
  const foreignTables = existing.rows.map((row) => String(row.name)).filter((name) => name !== VERSION_TABLE && !owned.has(name) && !schemaManifest(scope === "main" ? "ledger" : "main").some((table) => table.name === name));
  const otherScope = scope === "main" ? "ledger" : "main";
  const otherNames = new Set(schemaManifest(otherScope).map((table) => table.name));
  const hasOtherScope = existing.rows.some((row) => row.name !== VERSION_TABLE && otherNames.has(String(row.name)));
  if (!ownedTables.length && hasOtherScope) {
    const issues = await inspectSchemaParity(client, otherScope, { allowUnversioned: !versionTableExists });
    if (issues.length) throw new SchemaMigrationRequiredError(issues);
    if (versionTableExists) {
      const otherVersion = await client.execute({ sql: `SELECT version, fingerprint FROM ${quoteSqlIdentifier(VERSION_TABLE)} WHERE scope = ?`, args: [otherScope] });
      if (otherVersion.rows[0] && (String(otherVersion.rows[0].version) !== String(CURRENT_SCHEMA_VERSION) || otherVersion.rows[0].fingerprint !== schemaFingerprint(otherScope))) throw new SchemaMigrationRequiredError([`${otherScope}: migration version/fingerprint mismatch`]);
    }
  }
  if (ownedTables.length || foreignTables.length) {
    const issues = await inspectSchemaParity(client, scope, { allowUnversioned: !versionTableExists });
    if (issues.length) throw new SchemaMigrationRequiredError(issues);
  } else {
    // API and Worker can both inspect a fresh file before either commits its DDL.
    // Both tables and indexes must tolerate the other initializer winning the batch.
    const statements = schemaManifest(scope).flatMap((table) => [
      table.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
      ...table.indexes.map((index) => index.sql.replace(/^(CREATE (?:UNIQUE )?INDEX) /, "$1 IF NOT EXISTS ")),
    ]);
    await client.batch(statements, "write");
    // IF NOT EXISTS alone cannot certify an object created by a concurrent writer.
    const issues = await inspectSchemaParity(client, scope);
    if (issues.length) throw new SchemaMigrationRequiredError(issues, false);
  }
  if (!versionTableExists) await client.execute(schemaManifest(scope).find((table) => table.name === VERSION_TABLE)!.sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  await client.execute({ sql: SCHEMA_VERSION_JOURNAL_SQL, args: { scope, version: String(CURRENT_SCHEMA_VERSION), fingerprint, applied_at: new Date().toISOString() } });
  const receipt = await client.execute({ sql: `SELECT version, fingerprint FROM ${quoteSqlIdentifier(VERSION_TABLE)} WHERE scope = ?`, args: [scope] });
  if (String(receipt.rows[0]?.version) !== String(CURRENT_SCHEMA_VERSION) || receipt.rows[0]?.fingerprint !== fingerprint) {
    throw new SchemaMigrationRequiredError([`${scope}: migration version/fingerprint mismatch`], false);
  }
}
