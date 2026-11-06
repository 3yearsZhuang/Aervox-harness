import { describe, expect, it } from "vitest";
import { backendFor } from "../src/database-backend.js";
import { createPostgresQueryRuntime, PostgresQueryDialect, type PostgresArrayResult, type PostgresConnection, type PostgresPool } from "../src/driver/postgres-session.js";
import { bindRepositoryStatement, createPostgresRepositoryConnection } from "../src/driver/repository-connection.js";

const empty = (): PostgresArrayResult => ({ rows: [], fields: [], rowCount: 0, command: "SELECT" });
function fixture(reply?: (text: string, values: unknown[]) => Promise<PostgresArrayResult> | PostgresArrayResult) {
  const commands: Array<{ text: string; values: unknown[] }> = [];
  const releases: Array<Error | boolean | undefined> = [];
  let ends = 0;
  const connection: PostgresConnection = {
    async query(config) { commands.push(config); return await reply?.(config.text, config.values) ?? empty(); },
    release(error) { releases.push(error); },
  };
  const pool: PostgresPool = { async connect() { return connection; }, async end() { ends++; } };
  const runtime = createPostgresQueryRuntime(pool, { schema: "raw_data", instanceId: "owner" });
  return { client: createPostgresRepositoryConnection(runtime), commands, releases, ended: () => ends };
}
const compile = (statement: Parameters<typeof bindRepositoryStatement>[0]) => new PostgresQueryDialect().sqlToQuery(bindRepositoryStatement(statement));

describe("repository raw command binding", () => {
  it("preserves literals, nested comments, escaped strings, dollar quotes and PostgreSQL casts", () => {
    const text = String.raw`SELECT '?', "@name", E'\'?still literal', $tag$:name ? $tag$, ?::bigint /* ? /* :name */ */ -- @name
      , :name`;
    const compiled = compile({ sql: text, args: [7, "last"] });
    expect(compiled.sql).toBe(text.replace("?::bigint", "$1::bigint").replace(", :name", ", $2"));
    expect(compiled.params).toEqual([7, "last"]);
  });
  it("binds numbered, reordered and repeated parameters without rewriting SQL expressions", () => {
    const compiled = compile({ sql: "SELECT ?2, ?, ?1, :same, :same, $2, $1", args: [10, 20, 30, 40] });
    expect(compiled.sql).toBe("SELECT $1, $2, $3, $4, $5, $6, $7");
    expect(compiled.params).toEqual([20, 30, 10, 40, 40, 20, 10]);
    expect(compile({ sql: "SELECT :id, @value, $value", args: { id: "one", "@value": 3, "$value": 4 } }).params).toEqual(["one", 3, 4]);
  });
  it("rejects missing, ambiguous, extra and invalid parameters before database admission", () => {
    expect(() => compile({ sql: "SELECT ?", args: [] })).toThrow("REPOSITORY_PARAMETER_MISSING");
    expect(() => compile({ sql: "SELECT :id", args: { id: 1, ":id": 2 } })).toThrow("REPOSITORY_PARAMETER_AMBIGUOUS");
    expect(() => compile({ sql: "SELECT 1", args: [2] })).toThrow("REPOSITORY_PARAMETER_COUNT_MISMATCH");
    expect(() => compile({ sql: "SELECT ?0", args: [2] })).toThrow("REPOSITORY_INVALID_PARAMETER_INDEX");
    expect(() => compile("SELECT /* unterminated")).toThrow("REPOSITORY_UNTERMINATED_SQL_COMMENT");
    expect(() => compile("SELECT $tag$unterminated")).toThrow("REPOSITORY_UNTERMINATED_SQL_LITERAL");
  });
});

describe("repository raw PostgreSQL connection", () => {
  it("retains exact native affected counts, metadata, duplicate columns and BLOB bytes", async () => {
    const f = fixture(text => text.startsWith("UPDATE raw_table") ? {
      rows: [["9", "first", "second", new Uint8Array([0, 128, 255])]],
      fields: [{ name: "id", dataTypeID: 20 }, { name: "value", dataTypeID: 25 }, { name: "value", dataTypeID: 25 }, { name: "bytes", dataTypeID: 17 }],
      rowCount: 3, command: "UPDATE",
    } : empty());
    const result = await f.client.execute({ sql: "UPDATE raw_table SET value = ? RETURNING *", args: ["new"] });
    expect(result.rowsAffected).toBe(3);
    expect(result.columns).toEqual(["id", "value", "value", "bytes"]);
    expect(result.columnTypes).toEqual(["INTEGER", "TEXT", "TEXT", "BLOB"]);
    const row = result.rows[0]!;
    expect(row.id).toBe(9); expect(row[0]).toBe(9); expect(row.value).toBe("first"); expect(row[2]).toBe("second");
    expect(row.length).toBe(4); expect([...new Uint8Array(row.bytes as ArrayBuffer)]).toEqual([0, 128, 255]);
    expect(result.toJSON()).toEqual({ columns: result.columns, columnTypes: result.columnTypes, rows: [[9, "first", "second", "AID/"]], rowsAffected: 3, lastInsertRowid: undefined });
    expect(backendFor(f.client)).toBe("postgresql");
    await f.client.close();
  });
  it("holds one native transaction and waits for commit acknowledgement", async () => {
    let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const f = fixture(async text => { if (text === "COMMIT") { entered(); await blocked; } return empty(); });
    const tx = await f.client.transaction();
    await tx.execute("UPDATE target SET value=1");
    let acknowledged = false;
    const committing = tx.commit().then(() => { acknowledged = true; });
    await started;
    expect(tx.closed).toBe(true); expect(acknowledged).toBe(false);
    await expect(tx.execute("SELECT 1")).rejects.toThrow("REPOSITORY_TRANSACTION_CLOSED");
    await expect(tx.rollback()).rejects.toThrow("REPOSITORY_TRANSACTION_TERMINAL_CONFLICT");
    unblock(); await committing; await tx.commit();
    expect(acknowledged).toBe(true);
    expect(f.commands.filter(command => command.text.startsWith("BEGIN"))).toHaveLength(1);
    expect(f.commands.filter(command => command.text === "COMMIT")).toHaveLength(1);
    await f.client.close();
  });
  it("propagates unknown commits and unacknowledged rollbacks without reporting success", async () => {
    const commit = fixture(text => { if (text === "COMMIT") throw new Error("lost ack"); return empty(); });
    const tx = await commit.client.transaction();
    await tx.execute("UPDATE target SET value=1");
    await expect(tx.commit()).rejects.toMatchObject({ code: "POSTGRES_COMMIT_OUTCOME_UNKNOWN" });
    expect(commit.releases[0]).toBeInstanceOf(Error);
    await commit.client.close();
    const rollback = fixture(text => { if (text === "ROLLBACK") throw new Error("lost rollback ack"); return empty(); });
    const failed = await rollback.client.transaction();
    await expect(failed.rollback()).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_OUTCOME_UNCERTAIN" });
    expect(rollback.releases[0]).toBeInstanceOf(Error);
    await rollback.client.close();
  });
  it("closes current and queued transactions with acknowledged rollbacks before pool shutdown", async () => {
    const f = fixture();
    const first = await f.client.transaction();
    await first.execute("UPDATE target SET value=1");
    const pending = f.client.transaction();
    const closing = f.client.close();
    expect(f.client.closed).toBe(true);
    await expect(f.client.transaction()).rejects.toThrow("REPOSITORY_CONNECTION_CLOSED");
    const second = await pending;
    await closing;
    expect(first.closed).toBe(true); expect(second.closed).toBe(true);
    expect(f.commands.filter(command => command.text === "ROLLBACK")).toHaveLength(2);
    expect(f.commands.some(command => command.text === "COMMIT")).toBe(false);
    expect(f.ended()).toBe(1);
    await f.client.close(); expect(f.ended()).toBe(1);
  });
  it("uses actual read-only transactions and reports failed close cleanup", async () => {
    const f = fixture();
    const reader = await f.client.transaction("read");
    await reader.execute("SELECT 1"); await reader.commit();
    expect(f.commands[0]?.text).toBe("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await f.client.close();
    const failed = fixture(text => { if (text === "ROLLBACK") throw new Error("transport failure"); return empty(); });
    await failed.client.transaction();
    await expect(failed.client.close()).rejects.toThrow("Repository writer cleanup was not acknowledged");
    expect(failed.ended()).toBe(1);
  });
  it("drains accepted commands during close and rejects new commands", async () => {
    let entered!: () => void, unblock!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const f = fixture(async text => { if (text === "SELECT waiting") { entered(); await blocked; } return empty(); });
    const work = f.client.execute("SELECT waiting"); await started;
    const closing = f.client.close();
    expect(f.ended()).toBe(0);
    await expect(f.client.execute("SELECT late")).rejects.toThrow("REPOSITORY_CONNECTION_CLOSED");
    unblock(); await work; await closing;
    expect(f.ended()).toBe(1);
  });
});
