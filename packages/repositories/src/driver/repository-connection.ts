/** Host-owned data commands. LibSQL data shapes are retained for existing raw
 * consumers; no LibSQL transport, URL, driver lifecycle or remote API is used. */
import { Buffer } from "node:buffer";
import type { InArgs, InStatement, InValue, ResultSet, Row, TransactionMode, Value } from "@libsql/client";
import { sql, type SQL, type SQLChunk } from "drizzle-orm";
import type { AervoxDatabase } from "../database.js";
import { registerDatabaseBackend } from "../database-backend.js";
import { databaseStoragePolicyFor, registerPostgresqlStorageLocality } from "../storage-policy.js";
import { executePostgresDataCommand, type PostgresArrayResult, type PostgresQueryRuntime } from "./postgres-session.js";

export interface RepositoryTransaction {
  execute(statement: InStatement): Promise<ResultSet>;
  batch(statements: InStatement[]): Promise<ResultSet[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  close(): void | Promise<void>;
  readonly closed: boolean;
}
export interface RepositoryConnection {
  execute(statement: InStatement): Promise<ResultSet>;
  batch(statements: InStatement[], mode?: TransactionMode): Promise<ResultSet[]>;
  transaction(mode?: TransactionMode): Promise<RepositoryTransaction>;
  close(): void | Promise<void>;
  readonly closed: boolean;
}

/** Parameter binding only: literal SQL syntax is preserved, and SQL expressions
 * remain native to the backend selected by their owning repository. */
export function bindRepositoryStatement(statement: InStatement): SQL {
  const text = typeof statement === "string" ? statement : statement.sql;
  const args: InArgs = typeof statement === "string" ? [] : statement.args;
  const chunks: SQLChunk[] = [];
  const namedSlots = new Map<string, number>();
  let nextSlot = 0;
  let cursor = 0;
  let start = 0;
  const valueFor = (token: string, explicit?: number): InValue => {
    if (Array.isArray(args)) {
      let slot = explicit;
      if (slot === undefined) {
        if (token !== "?") slot = namedSlots.get(token);
        if (slot === undefined) { slot = ++nextSlot; if (token !== "?") namedSlots.set(token, slot); }
      }
      if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error("REPOSITORY_INVALID_PARAMETER_INDEX");
      nextSlot = Math.max(nextSlot, slot);
      if (slot > args.length) throw new Error("REPOSITORY_PARAMETER_MISSING");
      return args[slot - 1]!;
    }
    const name = token.slice(1);
    const bare = Object.hasOwn(args, name), exact = Object.hasOwn(args, token);
    if (bare && exact) throw new Error("REPOSITORY_PARAMETER_AMBIGUOUS");
    if (!bare && !exact) throw new Error("REPOSITORY_PARAMETER_MISSING");
    return args[bare ? name : token]!;
  };
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (text.startsWith("--", cursor)) { const end = text.indexOf("\n", cursor + 2); cursor = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith("/*", cursor)) {
      let depth = 1; cursor += 2;
      while (depth && cursor < text.length) {
        if (text.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (text.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      if (depth) throw new Error("REPOSITORY_UNTERMINATED_SQL_COMMENT");
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const quote = char === "[" ? "]" : char;
      const escapes = char === "'" && /[eE]/.test(text[cursor - 1] ?? "") && !/[a-zA-Z0-9_$]/.test(text[cursor - 2] ?? "");
      cursor++;
      let closed = false;
      while (cursor < text.length) {
        if (escapes && text[cursor] === "\\") { cursor += 2; continue; }
        if (text[cursor] === quote) {
          if (quote !== "]" && text[cursor + 1] === quote) { cursor += 2; continue; }
          cursor++; closed = true; break;
        }
        cursor++;
      }
      if (!closed) throw new Error("REPOSITORY_UNTERMINATED_SQL_LITERAL");
      continue;
    }
    if (char === "$") {
      const tag = text.slice(cursor).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = text.indexOf(tag, cursor + tag.length);
        if (end < 0) throw new Error("REPOSITORY_UNTERMINATED_SQL_LITERAL");
        cursor = end + tag.length; continue;
      }
    }
    let token: string | undefined;
    let explicit: number | undefined;
    if (char === "?") {
      let end = cursor + 1;
      while (/\d/.test(text[end] ?? "")) end++;
      token = text.slice(cursor, end);
      if (end > cursor + 1) explicit = Number(token.slice(1));
    } else if ((char === ":" && text[cursor - 1] !== ":" && text[cursor + 1] !== ":") || char === "@" || char === "$") {
      const name = text.slice(cursor + 1).match(/^[a-zA-Z0-9_]+/)?.[0];
      if (name) {
        token = char + name;
        if (char === "$" && /^\d+$/.test(name)) explicit = Number(name);
      }
    }
    if (token) {
      chunks.push(sql.raw(text.slice(start, cursor)), sql.param(valueFor(token, explicit)));
      cursor += token.length; start = cursor; continue;
    }
    cursor++;
  }
  chunks.push(sql.raw(text.slice(start)));
  if (Array.isArray(args) && nextSlot !== args.length) throw new Error("REPOSITORY_PARAMETER_COUNT_MISMATCH");
  return sql.join(chunks, sql.raw(""));
}

function scalar(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return Uint8Array.from(value).buffer;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  throw new Error("REPOSITORY_RESULT_VALUE_UNSUPPORTED");
}
function dataResult(result: PostgresArrayResult): ResultSet {
  const columns = result.fields.map(field => field.name);
  const types: Record<number, string> = { 16: "INTEGER", 17: "BLOB", 20: "INTEGER", 21: "INTEGER", 23: "INTEGER", 25: "TEXT", 700: "REAL", 701: "REAL", 1043: "TEXT" };
  const rows = result.rows.map(values => {
    const row = { length: values.length } as Row;
    values.forEach((value, index) => {
      const data = scalar(value);
      Object.defineProperty(row, String(index), { value: data, enumerable: false, configurable: true });
      if (!Object.hasOwn(row, columns[index]!)) Object.defineProperty(row, columns[index]!, { value: data, enumerable: true, configurable: true });
    });
    return row;
  });
  const output: ResultSet = {
    columns, columnTypes: result.fields.map(field => types[field.dataTypeID] ?? ""), rows,
    rowsAffected: ["INSERT", "UPDATE", "DELETE"].includes(result.command) ? result.rowCount ?? 0 : 0,
    lastInsertRowid: undefined,
    toJSON() {
      return { columns, columnTypes: output.columnTypes, rows: rows.map(row => columns.map((_column, index) => {
        const value = row[index];
        if (typeof value === "bigint") return value.toString();
        return value instanceof ArrayBuffer ? Buffer.from(value).toString("base64") : value;
      })), rowsAffected: output.rowsAffected, lastInsertRowid: undefined };
    },
  };
  return output;
}
const rollbackSignal = Symbol("repository-explicit-rollback");

/** A raw writer holds the same genuine Session transaction until an explicit
 * terminal request. Its terminal promise resolves only after native ack/drain. */
export function createPostgresRepositoryConnection(runtime: PostgresQueryRuntime): RepositoryConnection {
  let closed = false;
  let closing: Promise<void> | undefined;
  const handles = new Set<RepositoryTransaction>();
  const pending = new Set<Promise<RepositoryTransaction>>();
  const execute = async (database: AervoxDatabase, statement: InStatement): Promise<ResultSet> => dataResult(await executePostgresDataCommand(database, bindRepositoryStatement(statement)));
  const start = (mode: TransactionMode = "write"): Promise<RepositoryTransaction> => {
    if (closed) return Promise.reject(new Error("REPOSITORY_CONNECTION_CLOSED"));
    if (!["write", "read", "deferred"].includes(mode)) return Promise.reject(new Error("REPOSITORY_TRANSACTION_MODE_UNSUPPORTED"));
    let readyResolve!: (handle: RepositoryTransaction) => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<RepositoryTransaction>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let finish!: (value: "commit" | "rollback") => void;
    const requested = new Promise<"commit" | "rollback">(resolve => { finish = resolve; });
    let terminal: Promise<void> | undefined;
    let terminalAction: "commit" | "rollback" | undefined;
    let accepting = true;
    let handle: RepositoryTransaction | undefined;
    const begin = mode === "read" ? runtime.readTransaction : runtime.db.transaction.bind(runtime.db);
    const completion = begin(async tx => {
      const terminate = (action: "commit" | "rollback"): Promise<void> => {
        if (terminal) {
          if (terminalAction !== action) return Promise.reject(new Error("REPOSITORY_TRANSACTION_TERMINAL_CONFLICT"));
          return terminal;
        }
        accepting = false; terminalAction = action; finish(action);
        terminal = completion.then(() => undefined, error => {
          if (action === "rollback" && error === rollbackSignal) return;
          throw error;
        });
        return terminal;
      };
      handle = {
        get closed() { return !accepting; },
        async execute(statement) {
          if (!accepting) throw new Error("REPOSITORY_TRANSACTION_CLOSED");
          return execute(tx, statement);
        },
        async batch(statements) { const results: ResultSet[] = []; for (const statement of statements) results.push(await this.execute(statement)); return results; },
        commit() { return terminate("commit"); },
        rollback() { return terminate("rollback"); },
        close() { return terminal ?? terminate("rollback"); },
      };
      registerDatabaseBackend(handle, "postgresql");
      registerPostgresqlStorageLocality(handle, databaseStoragePolicyFor(runtime.db).localOnlyAllowed ? "verified-local" : "remote-or-unverified");
      handles.add(handle);
      readyResolve(handle);
      if (closed) { accepting = false; finish("rollback"); }
      if (await requested === "rollback") throw rollbackSignal;
    });
    // Keep early connection/setup failure observable without an unhandled
    // rejection while the caller is still waiting for the writer handle.
    void completion.then(() => { if (handle) handles.delete(handle); }, error => { readyReject(error); if (handle) handles.delete(handle); });
    pending.add(ready);
    void ready.then(() => pending.delete(ready), () => pending.delete(ready));
    return ready;
  };
  const connection: RepositoryConnection = {
    get closed() { return closed; },
    async execute(statement) { if (closed) throw new Error("REPOSITORY_CONNECTION_CLOSED"); return execute(runtime.db, statement); },
    async batch(statements, mode) {
      const tx = await start(mode);
      try { const results = await tx.batch(statements); await tx.commit(); return results; }
      catch (error) { if (!tx.closed) await tx.rollback(); throw error; }
    },
    transaction: start,
    close() {
      if (!closing) {
        closed = true;
        const writers = [...handles].map(handle => handle.close());
        const waiting = [...pending].map(work => work.then(handle => handle.close()));
        closing = (async () => {
          const outcomes = await Promise.allSettled([...writers, ...waiting]);
          await runtime.closeAsync();
          const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
          if (failures.length) throw new AggregateError(failures, "Repository writer cleanup was not acknowledged");
        })();
      }
      return closing;
    },
  };
  registerDatabaseBackend(connection, "postgresql");
  registerPostgresqlStorageLocality(connection, databaseStoragePolicyFor(runtime.db).localOnlyAllowed ? "verified-local" : "remote-or-unverified");
  return connection;
}
