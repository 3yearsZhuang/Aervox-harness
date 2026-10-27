/** M0 adapter for an already prepared, private native SQLite writer. The host
 * transport owns SQL admission, one-statement preparation, native quotas and
 * cleanup. It must reject transaction-control/ATTACH/extension SQL submitted as
 * execute; those capabilities are never inferred from a JS queue or parser.
 * This module opens no database and is not a general libsql replacement.
 */
import type { Client, InStatement, IntMode, Replicated, ResultSet, Transaction, TransactionMode } from "@libsql/client";
import { decodeNativeSqliteResult, encodeNativeSqliteValue, type NativeSqliteValue, type NativeSqliteResult } from "./native-sqlite-values.js";

export interface NativeSqliteStatement {
  sql: string;
  args: NativeSqliteValue[] | Record<string, NativeSqliteValue>;
}
export type NativeSqliteRequest =
  | { operation: "execute"; connectionEpoch: string; transactionId: string | null; statement: NativeSqliteStatement }
  | { operation: "begin"; connectionEpoch: string; mode: "write" }
  | { operation: "commit" | "rollback"; connectionEpoch: string; transactionId: string };
export type NativeSqliteRejectionCode = "SQLITE_BUSY" | "SQLITE_CONSTRAINT" | "SQLITE_ERROR" | "SQLITE_ABORT";
export type NativeSqliteResponse =
  | { kind: "result"; connectionEpoch: string; transactionId: string | null; result: NativeSqliteResult }
  | { kind: "begun"; connectionEpoch: string; transactionId: string }
  | { kind: "terminal"; connectionEpoch: string; transactionId: string; outcome: "committed" | "rolledBack" }
  | { kind: "rejected"; connectionEpoch: string; transactionId: string | null; state: "none" | "active"; code: NativeSqliteRejectionCode };
export interface NativeSqliteDisposed { kind: "disposed"; connectionEpoch: string }
/** A resolved rejection is definitive: the statement ended, no transaction
 * transition happened, and the stated owner remains unchanged. A thrown error,
 * malformed reply or missing acknowledgement means unknown outcome. The native
 * implementation must enforce the epoch/transaction owner independently.
 */
export interface NativeSqliteTransport {
  request(request: NativeSqliteRequest): Promise<unknown>;
  /** Resolves only after every native operation has drained, any active
   * transaction has rolled back and this epoch's writer/handles are released.
   * It cannot report whether an earlier unacknowledged commit took effect.
   */
  dispose(connectionEpoch: string): Promise<unknown>;
}
export type NativeSqliteClientErrorCode = "CLIENT_CLOSED" | "TRANSACTION_CLOSED" | "UNSUPPORTED_OPERATION"
  | "QUEUE_FULL" | "OUTCOME_UNKNOWN" | NativeSqliteRejectionCode;
export class NativeSqliteClientError extends Error {
  constructor(readonly code: NativeSqliteClientErrorCode) { super(code); this.name = "NativeSqliteClientError"; }
}
const error = (code: NativeSqliteClientErrorCode) => new NativeSqliteClientError(code);
const failureCodes = new Set(["SQLITE_BUSY", "SQLITE_CONSTRAINT", "SQLITE_ERROR", "SQLITE_ABORT"]);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("OUTCOME_UNKNOWN");
  return value as Record<string, unknown>;
};
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw error("OUTCOME_UNKNOWN");
}
function token(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
interface Waiter { resolve: (release: () => void) => void; reject: (error: unknown) => void }

/** Only execute, write transaction and atomic write batch are supported. Default
 * transaction() is BEGIN IMMEDIATE, matching the locked Drizzle call. Explicit
 * read/deferred, migration, sync and SQL scripts fail before native dispatch.
 * close() ends admission immediately; only dispose()/drained prove cleanup.
 */
export class NativeSqliteClient implements Client {
  readonly protocol = "native-sqlite";
  private admissionClosed = false;
  private poisoned: NativeSqliteClientError | undefined;
  private busy = false;
  private waiters: Waiter[] = [];
  private disposal: Promise<void> | undefined;
  private cleanup: "open" | "pending" | "unknown" | "confirmed" = "open";
  readonly connectionEpoch: string;
  private readonly intMode: IntMode;
  private readonly maxQueue: number;
  constructor(private readonly transport: NativeSqliteTransport, options: { connectionEpoch: string; intMode?: IntMode; maxQueue?: number }) {
    if (!token(options.connectionEpoch)) throw new TypeError("INVALID_CONNECTION_EPOCH");
    this.connectionEpoch = options.connectionEpoch; this.intMode = options.intMode ?? "number";
    if (!["number", "bigint", "string"].includes(this.intMode)) throw new TypeError("INVALID_INTEGER_MODE");
    this.maxQueue = options.maxQueue ?? 32;
    if (!Number.isSafeInteger(this.maxQueue) || this.maxQueue < 1 || this.maxQueue > 256) throw new TypeError("INVALID_QUEUE_LIMIT");
  }
  get closed() { return this.admissionClosed; }
  get drained() { return this.cleanup === "confirmed"; }
  get cleanupState() { return this.cleanup; }
  private available() { if (this.poisoned) throw this.poisoned; if (this.admissionClosed) throw error("CLIENT_CLOSED"); }
  private failUnknown(): never {
    this.poisoned ??= error("OUTCOME_UNKNOWN"); this.admissionClosed = true; if (!this.drained) this.cleanup = "unknown";
    this.rejectWaiters(this.poisoned); throw this.poisoned;
  }
  private rejectWaiters(reason: unknown) { this.waiters.splice(0).forEach(waiter => waiter.reject(reason)); }
  private release = () => {
    if (!this.busy) return;
    const next = this.waiters.shift();
    if (next) next.resolve(this.release); else this.busy = false;
  };
  private async acquire(): Promise<() => void> {
    this.available();
    if (!this.busy) { this.busy = true; return this.release; }
    if (this.waiters.length >= this.maxQueue) throw error("QUEUE_FULL");
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  private statement(input: InStatement): NativeSqliteStatement {
    if (typeof input === "string") return { sql: input, args: [] };
    if (!input || typeof input.sql !== "string" || !input.args || typeof input.args !== "object") throw new TypeError("INVALID_STATEMENT");
    if (Array.isArray(input.args)) return { sql: input.sql, args: input.args.map(value => encodeNativeSqliteValue(value, this.intMode)) };
    const args: Record<string, NativeSqliteValue> = {};
    for (const key of Object.keys(input.args)) Object.defineProperty(args, key, {
      value: encodeNativeSqliteValue(input.args[key]!, this.intMode), enumerable: true, configurable: true, writable: true,
    });
    return { sql: input.sql, args };
  }
  /** Validates the complete envelope before decoding values. The transport must
   * not wrap an unknown native outcome in a definitive rejection response.
   */
  private async response(request: NativeSqliteRequest): Promise<Record<string, unknown>> {
    let response: Record<string, unknown>;
    try { response = object(await this.transport.request(request)); }
    catch { return this.failUnknown(); }
    try {
      if (response.connectionEpoch !== this.connectionEpoch) return this.failUnknown();
      if (response.kind === "rejected") {
        exact(response, ["kind", "connectionEpoch", "transactionId", "state", "code"]);
        const transactionId = request.operation === "begin" ? null : request.transactionId;
        if (response.transactionId !== transactionId || response.state !== (transactionId === null ? "none" : "active")
          || typeof response.code !== "string" || !failureCodes.has(response.code)) return this.failUnknown();
        throw error(response.code as NativeSqliteClientErrorCode);
      }
      return response;
    } catch (reason) {
      if (reason instanceof NativeSqliteClientError && reason.code !== "OUTCOME_UNKNOWN") throw reason;
      return this.failUnknown();
    }
  }
  private async executeStatement(statement: NativeSqliteStatement, transactionId: string | null): Promise<ResultSet> {
    this.available();
    const response = await this.response({ operation: "execute", connectionEpoch: this.connectionEpoch, transactionId, statement });
    try {
      exact(response, ["kind", "connectionEpoch", "transactionId", "result"]);
      if (response.kind !== "result" || response.transactionId !== transactionId) return this.failUnknown();
      return decodeNativeSqliteResult(response.result, this.intMode);
    } catch { return this.failUnknown(); }
  }
  async execute(input: InStatement): Promise<ResultSet> {
    this.available(); const statement = this.statement(input), release = await this.acquire();
    try { return await this.executeStatement(statement, null); }
    finally { if (!this.poisoned) release(); }
  }
  async transaction(mode?: TransactionMode): Promise<Transaction> {
    this.available(); if (mode !== undefined && mode !== "write") throw error("UNSUPPORTED_OPERATION");
    const release = await this.acquire();
    try {
      this.available();
      const response = await this.response({ operation: "begin", connectionEpoch: this.connectionEpoch, mode: "write" });
      exact(response, ["kind", "connectionEpoch", "transactionId"]);
      if (response.kind !== "begun" || !token(response.transactionId)) return this.failUnknown();
      return this.handle(response.transactionId, release);
    } catch (reason) {
      if (!(reason instanceof NativeSqliteClientError) || reason.code === "OUTCOME_UNKNOWN") return this.failUnknown();
      release(); throw reason;
    }
  }
  private handle(transactionId: string, release: () => void): Transaction {
    let state: "active" | "ending" | "closed" = "active", queue: Promise<unknown> = Promise.resolve(), pending = 0;
    let closeRequested = false;
    const client = this;
    const available = () => { client.available(); if (state !== "active") throw error("TRANSACTION_CLOSED"); };
    const append = <T>(operation: () => Promise<T>, terminal = false): Promise<T> => {
      if (!terminal && pending >= this.maxQueue) return Promise.reject(error("QUEUE_FULL"));
      pending++;
      const result = queue.then(operation);
      queue = result.then(() => { pending--; }, () => { pending--; });
      return result;
    };
    const execute = async (input: InStatement) => {
      available(); const statement = client.statement(input);
      return append(() => client.executeStatement(statement, transactionId));
    };
    const terminal = async (operation: "commit" | "rollback") => {
      available(); state = "ending";
      try {
        await append(async () => {
          client.available();
          const response = await client.response({ operation, connectionEpoch: client.connectionEpoch, transactionId });
          try {
            exact(response, ["kind", "connectionEpoch", "transactionId", "outcome"]);
            if (response.kind !== "terminal" || response.transactionId !== transactionId
              || response.outcome !== (operation === "commit" ? "committed" : "rolledBack")) return client.failUnknown();
          } catch { return client.failUnknown(); }
          state = "closed"; release();
        }, true);
      } catch (reason) {
        state = client.poisoned || closeRequested ? "closed" : "active";
        // A close while a terminal request is pending must not revive its owner
        // after a definitive rejection. Cleanup is now required; no handle or
        // queued root may resume until explicit native drain confirms release.
        if (closeRequested && !client.closed) return client.failUnknown();
        throw reason;
      }
    };
    return {
      execute,
      async batch(inputs) { available(); const results: ResultSet[] = []; for (const input of inputs) results.push(await execute(input)); return results; },
      async executeMultiple(_sql: string) { throw error("UNSUPPORTED_OPERATION"); },
      commit: () => terminal("commit"), rollback: () => terminal("rollback"),
      close() {
        closeRequested = true;
        if (state === "active" && !client.closed) void terminal("rollback").catch(() => {
          try { client.failUnknown(); } catch { /* Host must explicitly drain. */ }
        });
      },
      get closed() { return state !== "active" || client.closed; },
    };
  }
  async batch(inputs: InStatement[], mode?: TransactionMode): Promise<ResultSet[]> {
    this.available(); if (mode !== undefined && mode !== "write") throw error("UNSUPPORTED_OPERATION");
    // Validate all values before BEGIN, then keep one owner across the batch.
    inputs.forEach(input => this.statement(input));
    const tx = await this.transaction("write");
    try { const results = await tx.batch(inputs); await tx.commit(); return results; }
    catch (reason) {
      if (!tx.closed) {
        try { await tx.rollback(); }
        catch { return this.failUnknown(); } // No transaction handle escapes batch.
      }
      throw reason;
    }
  }
  async migrate(_inputs: InStatement[]): Promise<ResultSet[]> { throw error("UNSUPPORTED_OPERATION"); }
  async executeMultiple(_sql: string): Promise<void> { throw error("UNSUPPORTED_OPERATION"); }
  async sync(): Promise<Replicated> { throw error("UNSUPPORTED_OPERATION"); }
  close(): void { void this.dispose().catch(() => {}); }
  dispose(): Promise<void> {
    this.admissionClosed = true; this.rejectWaiters(this.poisoned ?? error("CLIENT_CLOSED"));
    if (this.drained) return Promise.resolve();
    if (this.disposal) return this.disposal;
    this.cleanup = "pending";
    const dispose = async () => {
      try {
        const response = object(await this.transport.dispose(this.connectionEpoch));
        exact(response, ["kind", "connectionEpoch"]);
        if (response.kind !== "disposed" || response.connectionEpoch !== this.connectionEpoch) throw error("OUTCOME_UNKNOWN");
        this.cleanup = "confirmed"; this.busy = false;
      } catch { this.cleanup = "unknown"; throw error("OUTCOME_UNKNOWN"); }
      finally { this.disposal = undefined; }
    };
    // Defer invocation until the tracked promise is assigned, including when
    // a miswired transport throws synchronously before its first await.
    this.disposal = Promise.resolve().then(dispose); return this.disposal;
  }
}
