/** Native PostgreSQL execution for the shared Drizzle query frontend. This is
 * neither a LibSQL Client nor a SQL text translator. Backend-specific raw
 * expressions are constructed explicitly by the repository dialect helpers. */
import { Buffer } from "node:buffer";
import { fillPlaceholders, Param, SQL, sql, type Query, type SQLChunk } from "drizzle-orm/sql/sql";
import { Column, getTableColumns, is } from "drizzle-orm";
import * as drizzleUtils from "drizzle-orm/utils";
import type { Logger } from "drizzle-orm/logger";
import { createTableRelationsHelpers, extractTablesRelationalConfig, type ExtractTablesWithRelations, type RelationalSchemaConfig } from "drizzle-orm/relations";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { SQLitePreparedQuery, SQLiteSession, SQLiteTransaction, type PreparedQueryConfig, type SQLiteExecuteMethod, type SQLiteTransactionConfig } from "drizzle-orm/sqlite-core/session";
import type { SelectedFieldsOrdered } from "drizzle-orm/sqlite-core/query-builders/select.types";
import * as schema from "@aervox/schema";
import { type AervoxDatabase, type RepositoryCommandResult } from "../database.js";
import { registerDatabaseBackend } from "../database-backend.js";
import { registerPostgresqlStorageLocality, type PostgresqlStorageLocality } from "../storage-policy.js";

export interface PostgresArrayResult {
  rows: unknown[][];
  fields: Array<{ name: string; dataTypeID: number }>;
  rowCount: number | null;
  command: string;
}

/** The native pg Pool/PoolClient structurally satisfy these host-owned ports. */
export interface PostgresConnection {
  query(config: { text: string; values: unknown[]; rowMode: "array" }): Promise<PostgresArrayResult>;
  release(error?: Error | boolean): void;
}
export interface PostgresPool {
  connect(): Promise<PostgresConnection>;
  end(): Promise<void>;
}
export interface PostgresRuntimeOptions {
  schema: string;
  instanceId: string;
  logger?: Logger;
  /** Host opener's checked same-device proof; direct runtime assembly defaults
   * to unverified, including pools addressed through TCP loopback. */
  storageLocality?: PostgresqlStorageLocality;
}
export interface PostgresObjectResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}
export interface PostgresQueryRuntime {
  db: AervoxDatabase;
  /** Native PostgreSQL syntax and positional $n parameters; no schema/control SQL. */
  query(text: string, values?: readonly unknown[]): Promise<PostgresObjectResult>;
  /** Host-only raw readers use a genuinely read-only PostgreSQL transaction. */
  readTransaction<T>(callback: (tx: AervoxDatabase) => Promise<T>): Promise<T>;
  /** Ownership of the supplied dedicated pool transfers to this runtime. */
  closeAsync(): Promise<void>;
}

export class PostgresCommitOutcomeUnknownError extends Error {
  readonly code = "POSTGRES_COMMIT_OUTCOME_UNKNOWN";
  constructor(cause: unknown) {
    super("PostgreSQL commit acknowledgement was lost; verify the durable receipt before retrying", { cause });
    this.name = "PostgresCommitOutcomeUnknownError";
  }
}
export class PostgresConnectionUncertainError extends Error {
  readonly code = "POSTGRES_CONNECTION_OUTCOME_UNCERTAIN";
  constructor(cause: unknown) {
    super("PostgreSQL connection state is uncertain; this handle cannot admit further work", { cause });
    this.name = "PostgresConnectionUncertainError";
  }
}

/** PostgreSQL uses the common statement AST and native parameter grammar. */
export class PostgresQueryDialect extends SQLiteAsyncDialect {
  override escapeParam(index: number): string { return `$${index + 1}`; }

  override buildInsertQuery(config: Parameters<SQLiteAsyncDialect["buildInsertQuery"]>[0]): SQL {
    // The shared insert builder represents each conflict target as its second
    // AST chunk. PostgreSQL index inference requires unqualified target column
    // names; predicates, update expressions and RETURNING retain their Columns.
    const onConflict = config.onConflict?.map(clause => {
      const chunks = [...clause.queryChunks];
      if (is(chunks[1], SQL)) chunks[1] = unqualifiedConflictTarget(chunks[1]);
      return new SQL(chunks);
    });
    config = { ...config, onConflict };
    if (!Array.isArray(config.values)) return super.buildInsertQuery(config);
    const columns = getTableColumns(config.table);
    const values = config.values.map(value => {
      const row = { ...value };
      for (const [key, column] of Object.entries(columns)) {
        const supplied = row[key];
        // Physical SQL defaults have already been compiled and verified by the
        // canonical backend schema. Use PostgreSQL DEFAULT rather than inline
        // a SQLite function from the common declaration into the data query.
        if (is(column.default, SQL) && (supplied === undefined || is(supplied, Param) && supplied.value === undefined)) {
          row[key] = sql`DEFAULT`;
        }
      }
      return row;
    });
    return super.buildInsertQuery({ ...config, values });
  }

  override buildDeleteQuery(config: Parameters<SQLiteAsyncDialect["buildDeleteQuery"]>[0]): SQL {
    if (config.limit !== undefined || config.orderBy?.length) throw new Error("POSTGRES_DELETE_LIMIT_ORDER_UNSUPPORTED");
    return super.buildDeleteQuery(config);
  }
  override buildUpdateQuery(config: Parameters<SQLiteAsyncDialect["buildUpdateQuery"]>[0]): SQL {
    if (config.limit !== undefined || config.orderBy?.length || config.joins?.length) {
      throw new Error("POSTGRES_UPDATE_LIMIT_ORDER_JOIN_UNSUPPORTED");
    }
    const query = super.buildUpdateQuery({ ...config, returning: undefined });
    // SQLite strips qualification in RETURNING even with UPDATE FROM; PostgreSQL
    // treats matching source/target names as ambiguous. Preserve AST Columns.
    if (!config.returning) return query;
    const selection = config.returning.map(({ field }) => is(field, SQL.Aliased)
      ? Reflect.get(field, "isSelectionField") === true ? sql.identifier(field.fieldAlias) : sql`${field.sql} as ${sql.identifier(field.fieldAlias)}`
      : sql`${field}`);
    return sql`${query} returning ${sql.join(selection, sql`, `)}`;
  }
  override buildRelationalQuery(_config: Parameters<SQLiteAsyncDialect["buildRelationalQuery"]>[0]): ReturnType<SQLiteAsyncDialect["buildRelationalQuery"]> {
    throw new Error("POSTGRES_RELATIONAL_QUERY_UNSUPPORTED");
  }
}

function unqualifiedConflictTarget(target: SQL): SQL {
  const visit = (chunk: SQLChunk): SQLChunk => {
    if (is(chunk, Column)) return sql.identifier(chunk.name);
    if (is(chunk, SQL)) return new SQL(chunk.queryChunks.map(visit));
    if (Array.isArray(chunk)) return chunk.map(visit);
    return chunk;
  };
  return new SQL(target.queryChunks.map(visit));
}

function identifier(value: string): string {
  if (!value || value.includes("\0") || Buffer.byteLength(value) > 63) throw new Error("POSTGRES_INVALID_SCHEMA_IDENTIFIER");
  return `"${value.replaceAll('"', '""')}"`;
}
function inputValue(value: unknown): unknown {
  if (typeof value === "string" && value.includes("\0")) throw new Error("POSTGRES_TEXT_NUL_UNSUPPORTED");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) throw new Error("POSTGRES_UNREPRESENTABLE_DATE");
    return milliseconds;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("POSTGRES_UNREPRESENTABLE_NUMBER");
  }
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value !== null && typeof value === "object") throw new Error("POSTGRES_UNSUPPORTED_PARAMETER_VALUE");
  return value;
}
function normalizeValue(value: unknown, oid: number): unknown {
  // pg's default int8 parser returns strings. Shared INTEGER models are numbers;
  // reject precision loss instead of silently changing their runtime type.
  if (oid === 20 && value !== null) {
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
      || !/^-?\d+$/.test(String(value))) throw new Error("POSTGRES_INVALID_INT8_RESULT");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || BigInt(parsed) !== BigInt(value)) throw new Error("POSTGRES_UNREPRESENTABLE_INT8_RESULT");
    return parsed;
  }
  return value;
}
function normalizedRows(result: PostgresArrayResult): unknown[][] {
  return result.rows.map(row => {
    if (row.length !== result.fields.length) throw new Error("POSTGRES_RESULT_COLUMN_MISMATCH");
    return row.map((value, index) => normalizeValue(value, result.fields[index]!.dataTypeID));
  });
}
function objectRows(result: PostgresArrayResult): Record<string, unknown>[] {
  return normalizedRows(result).map(row => {
    const record: Record<string, unknown> = {};
    result.fields.forEach((field, index) => {
      // Match the existing Client's first duplicate column-name projection.
      if (!Object.hasOwn(record, field.name)) record[field.name] = row[index];
    });
    return record;
  });
}

/** Reject explicit transaction/DDL commands; repository execution cannot escape
 * the Session's ownership. This recognizes the leading keyword only and never
 * rewrites or attempts to interpret SQL expressions. */
function assertRepositoryStatement(text: string): void {
  if (text.includes("\0")) throw new Error("POSTGRES_QUERY_NUL_UNSUPPORTED");
  let cursor = 0;
  while (cursor < text.length) {
    if (/\s/.test(text[cursor]!)) { cursor++; continue; }
    if (text.startsWith("--", cursor)) {
      const end = text.indexOf("\n", cursor + 2);
      cursor = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      let depth = 1;
      cursor += 2;
      while (depth && cursor < text.length) {
        if (text.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (text.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth) throw new Error("POSTGRES_INVALID_SQL_COMMENT");
      continue;
    }
    break;
  }
  const start = cursor;
  while (cursor < text.length && /[a-zA-Z]/.test(text[cursor]!)) cursor++;
  const keyword = text.slice(start, cursor).toUpperCase();
  if (!["SELECT", "WITH", "INSERT", "UPDATE", "DELETE"].includes(keyword)) throw new Error("POSTGRES_REPOSITORY_STATEMENT_UNSUPPORTED");
  let ended = false;
  // A native query may contain semicolons inside literals, identifiers, comments
  // or dollar-quoted bodies, but never a second top-level statement. Keeping
  // transaction control behind this gate preserves Session ownership.
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (/\s/.test(char)) { cursor++; continue; }
    if (text.startsWith("--", cursor)) {
      const end = text.indexOf("\n", cursor + 2);
      cursor = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      let depth = 1;
      cursor += 2;
      while (depth && cursor < text.length) {
        if (text.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (text.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth) throw new Error("POSTGRES_INVALID_SQL_COMMENT");
      continue;
    }
    if (ended) throw new Error("POSTGRES_MULTIPLE_STATEMENTS_UNSUPPORTED");
    if (char === ";") { ended = true; cursor++; continue; }
    if (char === "'" || char === '"') {
      const quote = char;
      const escapes = quote === "'" && /[eE]/.test(text[cursor - 1] ?? "")
        && !/[a-zA-Z0-9_$]/.test(text[cursor - 2] ?? "");
      cursor++;
      let closed = false;
      while (cursor < text.length) {
        if (escapes && text[cursor] === "\\") { cursor += 2; continue; }
        if (text[cursor] === quote) {
          if (text[cursor + 1] === quote) { cursor += 2; continue; }
          cursor++; closed = true; break;
        }
        cursor++;
      }
      if (!closed) throw new Error("POSTGRES_INVALID_SQL_LITERAL");
      continue;
    }
    if (char === "$") {
      const tag = text.slice(cursor).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = text.indexOf(tag, cursor + tag.length);
        if (end < 0) throw new Error("POSTGRES_INVALID_SQL_LITERAL");
        cursor = end + tag.length;
        continue;
      }
    }
    cursor++;
  }
}

interface TransactionState {
  connection: PostgresConnection;
  tail: Promise<void>;
  nextSavepoint: number;
  admitting: boolean;
  poisoned: unknown | undefined;
}
type SchemaRelations = ExtractTablesWithRelations<typeof schema>;
type RelationConfig = RelationalSchemaConfig<SchemaRelations>;
type ExecuteQuery = (text: string, params: readonly unknown[], state?: TransactionState) => Promise<PostgresArrayResult>;
const rawExecutors = new WeakMap<object, (query: SQL) => Promise<PostgresArrayResult>>();

/** Exact native data receipt for the host's narrow raw-command adapter. */
export async function executePostgresDataCommand(database: object, query: SQL): Promise<PostgresArrayResult> {
  const execute = rawExecutors.get(database);
  if (!execute) throw new Error("POSTGRES_DATABASE_HANDLE_NOT_REGISTERED");
  const result = await execute(query);
  return { ...result, rows: normalizedRows(result) };
}

/** Locked Drizzle exports this mapper at runtime for its own driver Sessions,
 * but omits the internal function from utils.d.ts. Keep the seam checked and
 * local, as with the existing injected LibSQLSession constructors. */
function mapResultRow(fields: SelectedFieldsOrdered, row: unknown[], joins?: Record<string, boolean>): Record<string, unknown> {
  const mapper: unknown = Reflect.get(drizzleUtils, "mapResultRow");
  if (typeof mapper !== "function") throw new Error("POSTGRES_DRIZZLE_RESULT_MAPPER_UNAVAILABLE");
  const result: unknown = Reflect.apply(mapper, undefined, [fields, row, joins]);
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new Error("POSTGRES_DRIZZLE_RESULT_MAPPER_INVALID");
  return result as Record<string, unknown>;
}

class PostgresPreparedQuery extends SQLitePreparedQuery<PreparedQueryConfig & { type: "async"; run: RepositoryCommandResult; all: unknown[]; get: unknown; values: unknown[][] }> {
  joinsNotNullableMap?: Record<string, boolean>;
  constructor(query: Query, executeMethod: SQLiteExecuteMethod,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly executor: ExecuteQuery,
    private readonly state: TransactionState | undefined,
    private readonly logger: Logger | undefined,
    private readonly customMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown) {
    super("async", executeMethod, query);
  }
  private async result(placeholders: Record<string, unknown> = {}): Promise<PostgresArrayResult> {
    const params = fillPlaceholders(this.query.params, placeholders);
    this.logger?.logQuery(this.query.sql, params);
    return this.executor(this.query.sql, params, this.state);
  }
  override async run(placeholders?: Record<string, unknown>): Promise<RepositoryCommandResult> {
    const result = await this.result(placeholders);
    return { rowsAffected: result.rowCount ?? 0 };
  }
  override async all(placeholders?: Record<string, unknown>): Promise<unknown[]> {
    const result = await this.result(placeholders);
    const rows = normalizedRows(result);
    if (this.customMapper) return this.customMapper(rows, value => value) as unknown[];
    if (!this.fields) return objectRows(result);
    return rows.map(row => mapResultRow(this.fields!, row, this.joinsNotNullableMap));
  }
  override async get(placeholders?: Record<string, unknown>): Promise<unknown> {
    const result = await this.result(placeholders);
    if (!result.rows.length) return undefined;
    const rows = normalizedRows(result);
    if (this.customMapper) return this.customMapper(rows, value => value);
    if (!this.fields) return objectRows(result)[0];
    return mapResultRow(this.fields, rows[0]!, this.joinsNotNullableMap);
  }
  override async values(placeholders?: Record<string, unknown>): Promise<unknown[][]> {
    return normalizedRows(await this.result(placeholders));
  }
}

class PostgresSession extends SQLiteSession<"async", RepositoryCommandResult, typeof schema, SchemaRelations> {
  constructor(private readonly dialect: PostgresQueryDialect, private readonly relations: RelationConfig,
    private readonly executor: ExecuteQuery,
    private readonly transact: <T>(callback: (state: TransactionState) => Promise<T>) => Promise<T>,
    private readonly logger?: Logger, private readonly state?: TransactionState,
    private readonly locality: PostgresqlStorageLocality = "remote-or-unverified") { super(dialect); }
  override prepareQuery(query: Query, fields: SelectedFieldsOrdered | undefined, executeMethod: SQLiteExecuteMethod,
    _arrayMode: boolean, customMapper?: (rows: unknown[][], mapColumnValue?: (value: unknown) => unknown) => unknown) {
    return new PostgresPreparedQuery(query, executeMethod, fields, this.executor, this.state, this.logger, customMapper);
  }
  override async transaction<T>(callback: (tx: SQLiteTransaction<"async", RepositoryCommandResult, typeof schema, SchemaRelations>) => Promise<T>, _config?: SQLiteTransactionConfig): Promise<T> {
    if (this.state) throw new Error("DATABASE_NESTED_TRANSACTION_UNSUPPORTED");
    return this.transact(async state => {
      const session = new PostgresSession(this.dialect, this.relations, this.executor, this.transact, this.logger, state, this.locality);
      const tx = new PostgresTransaction("async", this.dialect, session, this.relations);
      registerDatabaseBackend(tx, "postgresql");
      registerPostgresqlStorageLocality(tx, this.locality);
      rawExecutors.set(tx, query => { const compiled = this.dialect.sqlToQuery(query); return this.executor(compiled.sql, compiled.params, state); });
      return callback(tx);
    });
  }
}
class PostgresTransaction extends SQLiteTransaction<"async", RepositoryCommandResult, typeof schema, SchemaRelations> {
  async transaction<T>(_callback: (tx: SQLiteTransaction<"async", RepositoryCommandResult, typeof schema, SchemaRelations>) => Promise<T>): Promise<T> {
    throw new Error("DATABASE_NESTED_TRANSACTION_UNSUPPORTED");
  }
}

/** The caller must have initialized and verified this target's canonical Schema
 * and instance identity before transferring its dedicated Pool to the runtime. */
export function createPostgresQueryRuntime(pool: PostgresPool, options: PostgresRuntimeOptions): PostgresQueryRuntime {
  const qualifiedSchema = identifier(options.schema);
  if (!options.instanceId || options.instanceId.includes("\0")) throw new Error("POSTGRES_INVALID_INSTANCE_IDENTITY");
  const dialect = new PostgresQueryDialect();
  const extracted = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relations: RelationConfig = { fullSchema: schema, schema: extracted.tables as SchemaRelations, tableNamesMap: extracted.tableNamesMap };
  let admitting = true;
  let operationTail = Promise.resolve();
  let closing: Promise<void> | undefined;

  const control = (connection: PostgresConnection, text: string, values: unknown[] = []) => connection.query({ text, values, rowMode: "array" });
  const withSlot = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!admitting) return Promise.reject(new Error("POSTGRES_RUNTIME_CLOSED"));
    const execution = operationTail.then(operation);
    operationTail = execution.then(() => undefined, () => undefined);
    return execution;
  };
  const transact = <T>(callback: (state: TransactionState) => Promise<T>, readOnly = false): Promise<T> => withSlot(async () => {
    const connection = await pool.connect();
    const state: TransactionState = { connection, tail: Promise.resolve(), nextSavepoint: 0, admitting: true, poisoned: undefined };
    let began = false;
    let commitStarted = false;
    let discard: Error | undefined;
    try {
      await control(connection, `BEGIN ISOLATION LEVEL READ COMMITTED${readOnly ? " READ ONLY" : ""}`);
      began = true;
      await control(connection, `SET LOCAL search_path TO ${qualifiedSchema}, pg_catalog`);
      await control(connection, "SET LOCAL standard_conforming_strings = on");
      // Recreate the canonical single-writer sequence across API/Worker clients.
      // Reads also take this conservative gate so they cannot observe a partial
      // source/deny transition during the first backend implementation.
      await control(connection, "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1), pg_catalog.hashtext($2))", [options.schema, options.instanceId]);
      const result = await callback(state);
      state.admitting = false;
      await state.tail;
      if (state.poisoned !== undefined) throw new PostgresConnectionUncertainError(state.poisoned);
      commitStarted = true;
      try { await control(connection, "COMMIT"); }
      catch (error) { throw new PostgresCommitOutcomeUnknownError(error); }
      return result;
    } catch (error) {
      state.admitting = false;
      await state.tail;
      if (commitStarted || state.poisoned !== undefined || !began) discard = new Error("POSTGRES_DISCARD_UNCERTAIN_CONNECTION");
      try { if (began) await control(connection, "ROLLBACK"); }
      catch (cleanupError) {
        discard = new Error("POSTGRES_DISCARD_ROLLBACK_FAILURE");
        if (!commitStarted) throw new PostgresConnectionUncertainError(new AggregateError([error, cleanupError], "PostgreSQL rollback was not acknowledged"));
      }
      throw error;
    } finally {
      connection.release(discard);
    }
  });
  const executeInTransaction = (text: string, params: readonly unknown[], state: TransactionState): Promise<PostgresArrayResult> => {
    if (!state.admitting) return Promise.reject(new Error("POSTGRES_TRANSACTION_CLOSED"));
    const run = state.tail.then(async () => {
      if (state.poisoned !== undefined) throw new PostgresConnectionUncertainError(state.poisoned);
      const name = `aervox_statement_${++state.nextSavepoint}`;
      try { await control(state.connection, `SAVEPOINT ${name}`); }
      catch (error) { state.poisoned = error; throw new PostgresConnectionUncertainError(error); }
      try {
        const result = await control(state.connection, text, params.map(inputValue));
        await control(state.connection, `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        try {
          await control(state.connection, `ROLLBACK TO SAVEPOINT ${name}`);
          await control(state.connection, `RELEASE SAVEPOINT ${name}`);
        } catch (cleanupError) { state.poisoned = cleanupError; }
        throw error;
      }
    });
    state.tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const executor: ExecuteQuery = (text, params, state) => {
    assertRepositoryStatement(text);
    // Validate before BEGIN; a locally unsupported value creates no DB writes.
    const values = params.map(inputValue);
    return state ? executeInTransaction(text, values, state) : transact(tx => executeInTransaction(text, values, tx));
  };
  const locality = options.storageLocality ?? "remote-or-unverified";
  const session = new PostgresSession(dialect, relations, executor, transact, options.logger, undefined, locality);
  const db = new BaseSQLiteDatabase<"async", RepositoryCommandResult, typeof schema>("async", dialect, session, relations);
  registerDatabaseBackend(db, "postgresql");
  registerPostgresqlStorageLocality(db, locality);
  rawExecutors.set(db, query => { const compiled = dialect.sqlToQuery(query); return executor(compiled.sql, compiled.params); });
  return {
    db,
    async query(text, values = []) {
      const result = await executor(text, values);
      return { rows: objectRows(result), rowCount: result.rowCount };
    },
    readTransaction(callback) {
      const reader = new PostgresSession(dialect, relations, executor, operation => transact(operation, true), options.logger, undefined, locality);
      return reader.transaction(callback);
    },
    closeAsync() {
      if (!closing) {
        admitting = false;
        closing = operationTail.then(() => pool.end());
      }
      return closing;
    },
  };
}
