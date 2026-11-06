/** PostgreSQL physical schema is compiled from the canonical declarations. The
 * host supplies one dedicated native connection; this module never opens one. */
import { createHash } from "node:crypto";
import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as declarations from "@aervox/schema";
import { CURRENT_SCHEMA_VERSION, SCHEMA_RELEASES, schemaFingerprint } from "./manifest.js";

export interface PostgresqlQueryPort {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}
export interface PostgresqlSchemaTarget {
  client: PostgresqlQueryPort;
  schema: string;
  instanceId: string;
}
export const POSTGRESQL_SCHEMA_VERSION = 1;
export const MIN_POSTGRESQL_VERSION = 16;
/** A physical mapping change requires a new release and explicit staging plan. */
export const POSTGRESQL_SCHEMA_RELEASES: Readonly<Record<number, string>> = {
  1: "e4a5ba85f4f62d8fb6afe0af911ef1c2b424e77f1aaedfcd63d36d515aa364b4",
};
export const POSTGRESQL_INSTANCE_TABLE = "_aervox_postgresql_instance";
export const POSTGRESQL_POSITION_COLUMN = "_aervox_rowid";
export const POSTGRESQL_POSITION_TABLES = ["turns", "bot_inbox", "bot_deliveries", "persona_switch_logs"] as const;
const positionTables = new Set<string>(POSTGRESQL_POSITION_TABLES);
const dialect = new PgDialect();
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const qualified = (schema: string, name: string): string => `${quote(schema)}.${quote(name)}`;

export class PostgresqlSchemaError extends Error {
  readonly code = "POSTGRESQL_SCHEMA_MIGRATION_REQUIRED";
  constructor(readonly issues: readonly string[]) {
    super(`PostgreSQL schema requires explicit staging migration: ${issues.join("; ")}`);
  }
}

/** Keep the configured namespace distinct from PostgreSQL/system/shared schemas. */
export function assertPostgresqlSchemaName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name) || name === "public" || name === "information_schema" || name.startsWith("pg_")) {
    throw new PostgresqlSchemaError(["a dedicated PostgreSQL schema name is required"]);
  }
}
export async function assertPostgresqlServerVersion(client: PostgresqlQueryPort): Promise<void> {
  const result = await client.query("SELECT current_setting('server_version_num') AS version,current_setting('server_encoding') AS encoding");
  const version = Number(result.rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < MIN_POSTGRESQL_VERSION * 10_000 || result.rows[0]?.encoding !== "UTF8") throw new PostgresqlSchemaError([`PostgreSQL ${MIN_POSTGRESQL_VERSION} or newer with UTF8 encoding is required`]);
}
function assertTarget(target: PostgresqlSchemaTarget): void {
  assertPostgresqlSchemaName(target.schema);
  if (!target.instanceId.trim() || target.instanceId.length > 256 || target.instanceId.includes("\0")) {
    throw new PostgresqlSchemaError(["a valid application instance identity is required"]);
  }
}
function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PostgresqlSchemaError(["non-finite schema default"]);
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") {
    if (value.includes("\0")) throw new PostgresqlSchemaError(["NUL is not representable in PostgreSQL text"]);
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array) return `decode('${Buffer.from(value).toString("hex")}', 'hex')`;
  throw new PostgresqlSchemaError(["unsupported canonical schema default"]);
}
function expression(value: SQL): string {
  // This compiles the AST with native PostgreSQL parameter/identifier rules.
  // SQL text is never rewritten. Defaults/index predicates cannot contain binds.
  const compiled = dialect.sqlToQuery(value);
  if (compiled.params.length) throw new PostgresqlSchemaError(["bound parameters are not allowed in schema expressions"]);
  return compiled.sql;
}
function columnType(column: SQLiteColumn): string {
  switch (column.getSQLType().toLowerCase()) {
    case "integer": return "bigint";
    case "real": return "double precision";
    case "text": return "text";
    case "blob": return "bytea";
    default: throw new PostgresqlSchemaError([`unsupported canonical column type: ${column.getSQLType()}`]);
  }
}
function defaultExpression(table: string, column: SQLiteColumn): string | null {
  if (column.default === undefined) return null;
  if (is(column.default, SQL)) {
    // The sole canonical SQLite-only default is intentionally mapped by owner,
    // with an exact source check. A future SQL default must be reviewed explicitly.
    if (table === "plugins" && column.name === "lifecycle_generation"
      && expression(column.default) === "(lower(hex(randomblob(16))))") {
      return "replace(gen_random_uuid()::text, '-', '')";
    }
    throw new PostgresqlSchemaError([`unmapped SQL default: ${table}.${column.name}`]);
  }
  return literal(column.mapToDriverValue(column.default as never));
}

interface ColumnSpec { name: string; type: string; notNull: boolean; default: string | null; identity: boolean; generated: string | null; }
interface ConstraintSpec {
  kind: "p" | "u" | "f" | "c";
  columns: string[];
  target?: string;
  targetColumns?: string[];
  onDelete?: string;
  onUpdate?: string;
  expression?: string;
}
interface IndexSpec { name: string; unique: boolean; method: string; columns: string[]; where: string | null; }
export interface PostgresqlTableSpec {
  name: string;
  columns: ColumnSpec[];
  constraints: ConstraintSpec[];
  indexes: IndexSpec[];
  derived: boolean;
}
function identifier(name: string): string {
  if (Buffer.byteLength(name, "utf8") <= 63) return name;
  return `${name.slice(0, 48)}_${createHash("sha256").update(name).digest("hex").slice(0, 14)}`;
}
function canonicalTables(): ReturnType<typeof getTableConfig>[] {
  const tables = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const item of Object.values(declarations)) {
    try {
      const config = getTableConfig(item as SQLiteTable);
      if (config.name && config.name !== "recovery_control_ledger") tables.set(config.name, config);
    } catch { /* Exported constants and types are not table declarations. */ }
  }
  return [...tables.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Logical shape, independently fingerprinted from SQLite's physical manifest. */
export function postgresqlSchemaManifest(): PostgresqlTableSpec[] {
  const tables = canonicalTables().map((table): PostgresqlTableSpec => {
    const primary = table.columns.filter(column => column.primary).map(column => column.name);
    const constraints: ConstraintSpec[] = [];
    if (primary.length) constraints.push({ kind: "p", columns: primary });
    for (const key of table.primaryKeys) constraints.push({ kind: "p", columns: key.columns.map(column => column.name) });
    for (const unique of table.uniqueConstraints) constraints.push({ kind: "u", columns: unique.columns.map(column => column.name) });
    for (const foreign of table.foreignKeys) {
      const reference = foreign.reference();
      constraints.push({ kind: "f", columns: reference.columns.map(column => column.name),
        target: getTableConfig(reference.foreignTable).name, targetColumns: reference.foreignColumns.map(column => column.name),
        onDelete: foreign.onDelete ?? "no action", onUpdate: foreign.onUpdate ?? "no action" });
    }
    for (const check of table.checks) constraints.push({ kind: "c", columns: [], expression: expression(check.value) });
    const allPrimaryColumns = new Set(constraints.filter(key => key.kind === "p").flatMap(key => key.columns));
    const columns: ColumnSpec[] = table.columns.map(column => ({ name: column.name, type: columnType(column),
      notNull: column.notNull || allPrimaryColumns.has(column.name), default: defaultExpression(table.name, column), identity: false, generated: null }));
    if (positionTables.has(table.name)) {
      columns.push({ name: POSTGRESQL_POSITION_COLUMN, type: "bigint", notNull: true, default: null, identity: true, generated: null });
      constraints.push({ kind: "u", columns: [POSTGRESQL_POSITION_COLUMN] });
    }
    const indexes: IndexSpec[] = table.indexes.map(index => ({ name: identifier(index.config.name), unique: Boolean(index.config.unique), method: "btree",
      columns: index.config.columns.map(column => "name" in column ? quote(column.name) : expression(column as SQL)),
      where: index.config.where ? expression(index.config.where) : null }));
    return { name: table.name, columns, constraints, indexes, derived: false };
  });
  tables.push({ name: POSTGRESQL_INSTANCE_TABLE, derived: false,
    columns: [
      { name: "singleton", type: "bigint", notNull: true, default: null, identity: false, generated: null },
      ...["instance_id", "fingerprint", "applied_at"].map(name => ({ name, type: "text", notNull: true, default: null, identity: false, generated: null })),
      { name: "version", type: "bigint", notNull: true, default: null, identity: false, generated: null },
    ], constraints: [{ kind: "p", columns: ["singleton"] }, { kind: "c", columns: [], expression: "singleton = 1" }], indexes: [] });
  for (const name of ["messages_fts", "memories_fts"]) tables.push({ name, derived: true,
    columns: [
      { name: "id", type: "text", notNull: true, default: null, identity: false, generated: null },
      { name: "content", type: "text", notNull: true, default: null, identity: false, generated: null },
      { name: "search_vector", type: "tsvector", notNull: false, default: null, identity: false, generated: "to_tsvector('simple'::regconfig, content)" },
    ], constraints: [{ kind: "p", columns: ["id"] }],
    indexes: [{ name: `${name}_search_vector_idx`, unique: false, method: "gin", columns: [quote("search_vector")], where: null }] });
  return tables.sort((left, right) => left.name.localeCompare(right.name));
}
export function postgresqlSchemaFingerprint(): string {
  return createHash("sha256").update(JSON.stringify({ version: POSTGRESQL_SCHEMA_VERSION, canonicalVersion: CURRENT_SCHEMA_VERSION,
    canonicalFingerprint: schemaFingerprint("main"), tables: postgresqlSchemaManifest() })).digest("hex");
}
const columnList = (columns: readonly string[]): string => columns.map(quote).join(", ");
function constraintSql(constraint: ConstraintSpec, schema: string): string {
  switch (constraint.kind) {
    case "p": return `PRIMARY KEY (${columnList(constraint.columns)})`;
    case "u": return `UNIQUE (${columnList(constraint.columns)})`;
    case "c": return `CHECK (${constraint.expression})`;
    case "f": return `FOREIGN KEY (${columnList(constraint.columns)}) REFERENCES ${qualified(schema, constraint.target!)} (${columnList(constraint.targetColumns!)}) ON DELETE ${constraint.onDelete} ON UPDATE ${constraint.onUpdate}`;
  }
}
export function postgresqlSchemaStatements(schema: string): string[] {
  assertPostgresqlSchemaName(schema);
  const tables = postgresqlSchemaManifest();
  const creates = tables.map(table => {
    const columns = table.columns.map(column => `${quote(column.name)} ${column.type}${column.type === "text" ? ' COLLATE "C"' : ""}`
      + `${column.identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${column.generated ? ` GENERATED ALWAYS AS (${column.generated}) STORED` : ""}`
      + `${column.notNull ? " NOT NULL" : ""}${column.default === null ? "" : ` DEFAULT ${column.default}`}`);
    columns.push(...table.constraints.filter(constraint => constraint.kind !== "f").map(constraint => constraintSql(constraint, schema)));
    return `CREATE TABLE ${qualified(schema, table.name)} (${columns.join(", ")})`;
  });
  const foreignKeys = tables.flatMap(table => table.constraints.filter(constraint => constraint.kind === "f")
    .map((constraint, index) => `ALTER TABLE ${qualified(schema, table.name)} ADD CONSTRAINT ${quote(identifier(`${table.name}_aervox_fk_${index}`))} ${constraintSql(constraint, schema)}`));
  const indexes = tables.flatMap(table => table.indexes.map(index => `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${qualified(schema, table.name)} USING ${index.method} (${index.columns.join(", ")})${index.where ? ` WHERE ${index.where}` : ""}`));
  return [...creates, ...foreignKeys, ...indexes];
}

/** Token normalization only compares server-deparsed expressions. It never
 * converts SQLite SQL into PostgreSQL or removes meaningful inner grouping. */
function comparableExpression(input: string | null, tableName?: string): string | null {
  if (input === null) return null;
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) { index++; continue; }
    if (char === "'" || char === '"') {
      const start = index++;
      while (index < input.length) {
        if (input[index++] === char) {
          if (input[index] === char) { index++; continue; }
          break;
        }
      }
      const token = input.slice(start, index);
      tokens.push(char === '"' ? token.slice(1, -1).replaceAll('""', '"') : token);
      continue;
    }
    if (input.slice(index, index + 2) === "::") {
      const cast = input.slice(index + 2).match(/^(?:pg_catalog\.)?(?:text|bigint|integer|double precision|regconfig)\b/);
      if (cast) { index += 2 + cast[0].length; continue; }
      tokens.push("::"); index += 2; continue;
    }
    const word = input.slice(index).match(/^[a-zA-Z_][a-zA-Z_0-9$]*/);
    if (word) { tokens.push(word[0].toLowerCase()); index += word[0].length; continue; }
    const number = input.slice(index).match(/^(?:[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)/i);
    if (number) { tokens.push(number[0].toLowerCase()); index += number[0].length; continue; }
    tokens.push(char); index++;
  }
  if (tableName) for (let offset = tokens.length - 3; offset >= 0; offset--) {
    if (tokens[offset] === tableName && tokens[offset + 1] === ".") tokens.splice(offset, 2);
  }
  // PostgreSQL places grouping around cast operands. Removing a redundant pair
  // around a single atom/function call cannot change operator precedence.
  for (let start = tokens.length - 1; start >= 0; start--) {
    if (tokens[start] !== "(") continue;
    if (/^[a-z_][a-z_0-9$]*$/.test(tokens[start - 1] ?? "")) continue;
    let depth = 1, end = start + 1;
    for (; end < tokens.length; end++) {
      if (tokens[end] === "(") depth++;
      if (tokens[end] === ")" && --depth === 0) break;
    }
    const inner = tokens.slice(start + 1, end);
    let wholeCall = /^[a-z_][a-z_0-9$]*$/.test(inner[0] ?? "") && inner[1] === "(" && inner.at(-1) === ")";
    if (wholeCall) {
      let callDepth = 0;
      for (let offset = 1; offset < inner.length - 1; offset++) {
        if (inner[offset] === "(") callDepth++;
        if (inner[offset] === ")") callDepth--;
        if (callDepth === 0) { wholeCall = false; break; }
      }
    }
    if (inner.length === 1 || wholeCall) { tokens.splice(end, 1); tokens.splice(start, 1); }
  }
  while (tokens[0] === "(" && tokens.at(-1) === ")") {
    let depth = 0, whole = true;
    for (let offset = 0; offset < tokens.length - 1; offset++) {
      if (tokens[offset] === "(") depth++;
      if (tokens[offset] === ")") depth--;
      if (depth === 0) { whole = false; break; }
    }
    if (!whole) break;
    tokens.shift(); tokens.pop();
  }
  return tokens.join(" ");
}
const sortedJson = (values: unknown[]): string => JSON.stringify(values.map(value => JSON.stringify(value)).sort());
const actionNames: Record<string, string> = { a: "no action", r: "restrict", c: "cascade", n: "set null", d: "set default" };

async function schemaRelations(client: PostgresqlQueryPort, schema: string) {
  return (await client.query(`SELECT c.oid::text AS oid,c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,
    c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,c.relhasrules AS has_rules,
    c.reltablespace AS tablespace,am.amname AS access_method FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE n.nspname=$1 ORDER BY c.relname`, [schema])).rows;
}
/** Read-only verification of actual catalog structure and instance/version receipts. */
export async function inspectPostgresqlSchema(target: PostgresqlSchemaTarget): Promise<string[]> {
  assertTarget(target);
  const { client, schema, instanceId } = target;
  await assertPostgresqlServerVersion(client);
  const issues: string[] = [];
  const expected = postgresqlSchemaManifest();
  const relations = await schemaRelations(client, schema);
  const actualTables = relations.filter(row => row.kind === "r").map(row => String(row.name));
  for (const row of relations) {
    if (row.kind === "S") continue; // Sequence ownership and parameters are checked below.
    if (row.kind === "i") {
      // Includes the physical indexes backing PRIMARY KEY/UNIQUE constraints.
      if (String(row.tablespace) !== "0") issues.push(`${row.name}: index storage differs`);
      continue;
    }
    if (row.kind !== "r" || !expected.some(table => table.name === row.name)) issues.push(`${row.name}: undeclared relation`);
    if (row.kind === "r" && (row.persistence !== "p" || row.row_security || row.force_row_security || row.has_rules
      || row.access_method !== "heap" || String(row.tablespace) !== "0")) issues.push(`${row.name}: table storage or access semantics differ`);
  }
  // A child outside this namespace is still returned by SELECT on its parent,
  // and does not inherit the parent's keys/FKs. Bind both ends by actual OID so
  // cross-schema inheritance and attached partitions cannot escape inspection.
  const canonicalOids = new Set(relations.filter(row => row.kind === "r" && expected.some(table => table.name === row.name))
    .map(row => String(row.oid)));
  if (canonicalOids.size) {
    const inheritance = (await client.query(`SELECT child.oid::text AS child_oid,child.relname AS child_name,
      parent.oid::text AS parent_oid,parent.relname AS parent_name FROM pg_catalog.pg_inherits h
      JOIN pg_catalog.pg_class child ON child.oid=h.inhrelid JOIN pg_catalog.pg_class parent ON parent.oid=h.inhparent
      WHERE h.inhrelid=ANY($1::oid[]) OR h.inhparent=ANY($1::oid[]) ORDER BY parent.oid,child.oid`, [[...canonicalOids]])).rows;
    for (const relation of inheritance) {
      if (canonicalOids.has(String(relation.parent_oid))) issues.push(`${relation.parent_name}: undeclared inheritance or partition relationship`);
      if (canonicalOids.has(String(relation.child_oid))) issues.push(`${relation.child_name}: undeclared inheritance or partition relationship`);
    }
  }
  const columns = (await client.query(`SELECT c.relname AS table_name,a.attname AS name,a.attnum AS position,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression,a.attidentity AS identity,a.attgenerated AS generated,
    co.collname AS collation,cn.nspname AS collation_schema FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [schema])).rows;
  const constraints = (await client.query(`SELECT c.relname AS table_name,k.contype AS kind,k.condeferrable AS deferrable,
    k.condeferred AS deferred,k.convalidated AS validated,k.confdeltype AS on_delete,k.confupdtype AS on_update,k.confmatchtype AS match,
    t.relname AS target,tn.nspname AS target_schema,pg_catalog.pg_get_expr(k.conbin,k.conrelid) AS expression,
    ci.indnullsnotdistinct AS nulls_not_distinct,ci.indisvalid AS index_valid,ci.indisready AS index_ready,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY s(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=s.num ORDER BY s.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY s(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum=s.num ORDER BY s.ord) AS target_columns
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_class t ON t.oid=k.confrelid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=t.relnamespace LEFT JOIN pg_catalog.pg_index ci ON ci.indexrelid=k.conindid
    WHERE n.nspname=$1 AND k.contype IN ('p','u','f','c') ORDER BY c.relname,k.contype`, [schema])).rows;
  const indexes = (await client.query(`SELECT c.relname AS table_name,i.relname AS name,x.indisunique AS unique,
    x.indisvalid AS valid,x.indisready AS ready,x.indnullsnotdistinct AS nulls_not_distinct,am.amname AS method,pg_catalog.pg_get_expr(x.indpred,x.indrelid) AS predicate,
    ARRAY(SELECT pg_catalog.pg_get_indexdef(x.indexrelid,pos,true) FROM generate_series(1,x.indnkeyatts) pos) AS columns,
    x.indnatts=x.indnkeyatts AS no_include FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class c ON c.oid=x.indrelid
    JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_am am ON am.oid=i.relam LEFT JOIN pg_catalog.pg_constraint k ON k.conindid=i.oid
    WHERE n.nspname=$1 AND k.oid IS NULL ORDER BY c.relname,i.relname`, [schema])).rows;
  for (const table of expected) {
    if (!actualTables.includes(table.name)) { issues.push(`${table.name}: missing table`); continue; }
    const actualColumns = columns.filter(row => row.table_name === table.name);
    if (JSON.stringify(actualColumns.map(row => row.name)) !== JSON.stringify(table.columns.map(column => column.name))) issues.push(`${table.name}: column order or set differs`);
    for (const column of table.columns) {
      const actual = actualColumns.find(row => row.name === column.name);
      if (!actual) continue;
      if (actual.type !== column.type || actual.not_null !== column.notNull || (column.type === "text" && (actual.collation !== "C" || actual.collation_schema !== "pg_catalog"))
        || actual.identity !== (column.identity ? "d" : "") || actual.generated !== (column.generated ? "s" : "")
        || comparableExpression(actual.default_expression === null ? null : String(actual.default_expression)) !== comparableExpression(column.generated ?? column.default)) {
        issues.push(`${table.name}.${column.name}: column semantics differ`);
      }
    }
    const actualConstraints = constraints.filter(row => row.table_name === table.name).map(row => {
      if (row.deferrable || row.deferred || !row.validated || row.kind === "f" && (row.target_schema !== schema || row.match !== "s")) issues.push(`${table.name}: constraint timing, validity or target differs`);
      if ((row.kind === "p" || row.kind === "u") && (!row.index_valid || !row.index_ready || row.nulls_not_distinct)) issues.push(`${table.name}: key index semantics differ`);
      const base = { kind: row.kind, columns: row.columns };
      if (row.kind === "f") return { ...base, target: row.target, targetColumns: row.target_columns, onDelete: actionNames[String(row.on_delete)], onUpdate: actionNames[String(row.on_update)] };
      if (row.kind === "c") return { ...base, columns: [], expression: comparableExpression(String(row.expression), table.name) };
      return base;
    });
    const expectedConstraints = table.constraints.map(constraint => constraint.kind === "c" ? { ...constraint, expression: comparableExpression(constraint.expression!, table.name) } : constraint);
    if (sortedJson(actualConstraints) !== sortedJson(expectedConstraints)) issues.push(`${table.name}: constraints differ`);
    const actualIndexes = indexes.filter(row => row.table_name === table.name).map(row => {
      if (!row.valid || !row.ready || !row.no_include || row.nulls_not_distinct) issues.push(`${table.name}.${row.name}: index state or included columns differ`);
      return { name: row.name, unique: row.unique, method: row.method,
        columns: (row.columns as string[]).map(column => comparableExpression(column, table.name)), where: comparableExpression(row.predicate === null ? null : String(row.predicate), table.name) };
    });
    const expectedIndexes = table.indexes.map(index => ({ ...index, columns: index.columns.map(column => comparableExpression(column, table.name)), where: comparableExpression(index.where, table.name) }));
    if (sortedJson(actualIndexes) !== sortedJson(expectedIndexes)) issues.push(`${table.name}: indexes differ`);
  }
  const sequences = (await client.query(`SELECT s.relname AS name,c.relname AS table_name,a.attname AS column_name,
    q.seqincrement AS increment,q.seqmin AS minimum,q.seqmax AS maximum,q.seqcycle AS cycle
    FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    LEFT JOIN pg_catalog.pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass AND d.deptype='i'
    LEFT JOIN pg_catalog.pg_class c ON c.oid=d.refobjid LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.refobjsubid
    LEFT JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid WHERE n.nspname=$1 AND s.relkind='S'`, [schema])).rows;
  for (const row of sequences) if (!positionTables.has(String(row.table_name)) || row.column_name !== POSTGRESQL_POSITION_COLUMN
    || String(row.increment) !== "1" || String(row.minimum) !== "1" || String(row.maximum) !== "9223372036854775807" || row.cycle) issues.push(`${row.name}: undeclared or incompatible sequence`);
  if (JSON.stringify(sequences.map(row => row.table_name).sort()) !== JSON.stringify([...POSTGRESQL_POSITION_TABLES].sort())) issues.push("insertion position sequences differ");
  const triggers = (await client.query(`SELECT c.relname AS table_name,t.tgname AS name FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND NOT t.tgisinternal`, [schema])).rows;
  for (const trigger of triggers) issues.push(`${trigger.table_name}.${trigger.name}: undeclared trigger`);
  // Runtime uses this dedicated namespace in its search path. Extra executable
  // or text-processing objects could override canonical SQL without table drift.
  const objects = (await client.query(`SELECT p.proname AS name,'function' AS kind FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
    UNION ALL SELECT o.oprname,'operator' FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname=$1
    UNION ALL SELECT c.collname,'collation' FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname=$1
    UNION ALL SELECT c.cfgname,'search configuration' FROM pg_catalog.pg_ts_config c JOIN pg_catalog.pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname=$1
    UNION ALL SELECT d.dictname,'search dictionary' FROM pg_catalog.pg_ts_dict d JOIN pg_catalog.pg_namespace n ON n.oid=d.dictnamespace WHERE n.nspname=$1`, [schema])).rows;
  for (const object of objects) issues.push(`${object.name}: undeclared ${object.kind}`);
  if (actualTables.includes(POSTGRESQL_INSTANCE_TABLE)) {
    const receipts = (await client.query(`SELECT singleton,instance_id,version,fingerprint FROM ${qualified(schema, POSTGRESQL_INSTANCE_TABLE)}`)).rows;
    if (receipts.length !== 1 || String(receipts[0]?.singleton) !== "1" || receipts[0]?.instance_id !== instanceId
      || String(receipts[0]?.version) !== String(POSTGRESQL_SCHEMA_VERSION) || receipts[0]?.fingerprint !== postgresqlSchemaFingerprint()) issues.push("application instance/version receipt differs");
  }
  if (actualTables.includes("_aervox_schema_versions")) {
    const receipts = (await client.query(`SELECT scope,version,fingerprint FROM ${qualified(schema, "_aervox_schema_versions")}`)).rows;
    if (receipts.length !== 1 || receipts[0]?.scope !== "main" || String(receipts[0]?.version) !== String(CURRENT_SCHEMA_VERSION)
      || receipts[0]?.fingerprint !== schemaFingerprint("main")) issues.push("canonical schema receipt differs");
  }
  return issues;
}

/** Atomic first initialization. Existing targets are only verified, never repaired.
 * The dedicated schema must be created explicitly by the host before this call. */
export async function initializePostgresqlSchema(target: PostgresqlSchemaTarget): Promise<{ fingerprint: string; created: boolean }> {
  assertTarget(target);
  await assertPostgresqlServerVersion(target.client);
  if (SCHEMA_RELEASES[CURRENT_SCHEMA_VERSION]?.main !== schemaFingerprint("main")) throw new PostgresqlSchemaError(["canonical schema changed without a versioned migration"]);
  if (POSTGRESQL_SCHEMA_RELEASES[POSTGRESQL_SCHEMA_VERSION] !== postgresqlSchemaFingerprint()) throw new PostgresqlSchemaError(["PostgreSQL mapping changed without a versioned migration"]);
  const { client, schema, instanceId } = target;
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [schema, instanceId]);
    const namespace = (await client.query("SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1", [schema])).rows;
    if (namespace.length !== 1) throw new PostgresqlSchemaError(["dedicated target schema does not exist"]);
    const relations = await schemaRelations(client, schema);
    let created = false;
    if (!relations.length) {
      const functions = (await client.query("SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 LIMIT 1", [schema])).rows;
      if (functions.length) throw new PostgresqlSchemaError(["target schema is not empty"]);
      for (const statement of postgresqlSchemaStatements(schema)) await client.query(statement);
      const fingerprint = postgresqlSchemaFingerprint();
      const appliedAt = new Date().toISOString();
      await client.query(`INSERT INTO ${qualified(schema, POSTGRESQL_INSTANCE_TABLE)} (singleton,instance_id,version,fingerprint,applied_at) VALUES (1,$1,$2,$3,$4)`, [instanceId, POSTGRESQL_SCHEMA_VERSION, fingerprint, appliedAt]);
      await client.query(`INSERT INTO ${qualified(schema, "_aervox_schema_versions")} (scope,version,fingerprint,applied_at) VALUES ('main',$1,$2,$3)`, [String(CURRENT_SCHEMA_VERSION), schemaFingerprint("main"), appliedAt]);
      created = true;
    }
    const issues = await inspectPostgresqlSchema(target);
    if (issues.length) throw new PostgresqlSchemaError(issues);
    await client.query("COMMIT");
    return { fingerprint: postgresqlSchemaFingerprint(), created };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the original/unknown terminal result. */ }
    throw error;
  }
}

/** Used only after a migration has imported the exact source insertion positions. */
export async function reseedPostgresqlPositions(client: PostgresqlQueryPort, schema: string): Promise<void> {
  assertPostgresqlSchemaName(schema);
  for (const table of POSTGRESQL_POSITION_TABLES) {
    await client.query(`SELECT setval(pg_get_serial_sequence($1,$2),GREATEST(COALESCE(MAX(${quote(POSTGRESQL_POSITION_COLUMN)}),1),1),COALESCE(MAX(${quote(POSTGRESQL_POSITION_COLUMN)}),0)>=1) FROM ${qualified(schema, table)}`,
      [`${quote(schema)}.${quote(table)}`, POSTGRESQL_POSITION_COLUMN]);
  }
}
