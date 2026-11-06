import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { plugins, sessions, personaPreferences } from "@aervox/schema";
import { backendFor } from "../src/database-backend.js";
import { createPostgresQueryRuntime, type PostgresArrayResult, type PostgresConnection, type PostgresPool } from "../src/driver/postgres-session.js";

const empty = (): PostgresArrayResult => ({ rows: [], fields: [], rowCount: 0, command: "SELECT" });
function fixture(reply?: (text: string, values: unknown[]) => Promise<PostgresArrayResult> | PostgresArrayResult) {
  const commands: Array<{ text: string; values: unknown[] }> = [];
  const releases: Array<Error | boolean | undefined> = [];
  let ends = 0;
  const connection: PostgresConnection = {
    async query(config) {
      commands.push({ text: config.text, values: config.values });
      return (await reply?.(config.text, config.values)) ?? empty();
    },
    release(error) { releases.push(error); },
  };
  const pool: PostgresPool = { async connect() { return connection; }, async end() { ends++; } };
  const runtime = createPostgresQueryRuntime(pool, { schema: "host-data", instanceId: "instance-1" });
  return { runtime, commands, releases, ended: () => ends };
}

describe("native PostgreSQL query Session", () => {
  it("admits each physical connection before business and reuses only successful admission", async () => {
    const commands: string[] = [];
    const makeConnection = (id: string): PostgresConnection => ({
      async query(config) { commands.push(`${id}:${config.text}`); return empty(); },
      release() {},
    });
    const first = makeConnection("first"), second = makeConnection("second");
    const clients = [first, first, second];
    const admitConnection = vi.fn(async (connection: PostgresConnection) => {
      commands.push(connection === first ? "first:ADMITTED" : "second:ADMITTED");
    });
    const runtime = createPostgresQueryRuntime({ async connect() { return clients.shift()!; }, async end() {} },
      { schema: "host-data", instanceId: "instance-1", admitConnection });
    try {
      await runtime.query("SELECT 1"); await runtime.query("SELECT 2");
      await runtime.readTransaction(async tx => { await tx.run(sql`SELECT 3`); });
      expect(admitConnection.mock.calls.map(([connection]) => connection)).toEqual([first, second]);
      expect(commands[0]).toBe("first:ADMITTED");
      const secondAdmission = commands.indexOf("second:ADMITTED");
      expect(commands[secondAdmission + 1]).toBe("second:BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    } finally { await runtime.closeAsync(); }
  });

  it("discards failed admission without starting, replaying or caching business work", async () => {
    const query = vi.fn(async () => empty());
    const release = vi.fn();
    const connection: PostgresConnection = { query, release };
    const connect = vi.fn(async () => connection);
    const denied = new Error("target admission denied");
    const admitConnection = vi.fn(async () => { throw denied; });
    const runtime = createPostgresQueryRuntime({ connect, async end() {} },
      { schema: "host-data", instanceId: "instance-1", admitConnection });
    try {
      await expect(runtime.query("INSERT INTO sessions(id) VALUES ('blocked')")).rejects.toBe(denied);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(expect.any(Error));
      await expect(runtime.query("SELECT 1")).rejects.toBe(denied);
      expect(admitConnection).toHaveBeenCalledTimes(2);
      expect(query).not.toHaveBeenCalled();
    } finally { await runtime.closeAsync(); }
  });

  it("uses PostgreSQL index inference for conflict targets while retaining qualified update expressions", async () => {
    const f = fixture();
    const upsert = f.runtime.db.insert(personaPreferences).values({ id: "pref_local" })
      .onConflictDoUpdate({ target: personaPreferences.id,
        set: { version: sql`${personaPreferences.version} + 1` },
        setWhere: sql`${personaPreferences.version} < 10`,
      }).returning().toSQL();
    expect(upsert.sql).toContain('on conflict ("id") do update set "version" = "persona_preferences"."version" + 1');
    expect(upsert.sql).toContain('where "persona_preferences"."version" < 10');
    const conflictNothing = f.runtime.db.insert(sessions).values({ id: "session" })
      .onConflictDoNothing({ target: [sessions.id, sessions.title] }).toSQL();
    expect(conflictNothing.sql).toContain('on conflict ("id", "title") do nothing');
    expect(f.runtime.db.insert(sessions).values({ id: "session" }).onConflictDoNothing().toSQL().sql).toContain("on conflict do nothing");
    await f.runtime.closeAsync();
  });
  it("uses native physical SQL defaults and preserves explicit lifecycle values", async () => {
    const f = fixture();
    const input = { id: "plugin", publisher: "owner", version: "1", checksum: "sum" };
    const generated = f.runtime.db.insert(plugins).values(input).toSQL();
    expect(generated.sql).toContain("DEFAULT");
    expect(generated.sql).not.toContain("randomblob");
    expect(generated.params.filter(value => typeof value === "string" && /^\d{4}-/.test(value))).toHaveLength(2);
    const explicit = f.runtime.db.insert(plugins).values({ ...input, lifecycleGeneration: "fixed-lifecycle" }).toSQL();
    expect(explicit.params).toContain("fixed-lifecycle");
    expect(explicit.sql).not.toContain("DEFAULT");
    await f.runtime.closeAsync();
  });
  it("uses native positional parameters and the canonical column decoder", async () => {
    const f = fixture((text, values) => text.startsWith("select ")
      ? { rows: [[values[0], "Saved"]], fields: [{ name: "id", dataTypeID: 25 }, { name: "title", dataTypeID: 25 }], rowCount: 1, command: "SELECT" }
      : empty());
    const row = await f.runtime.db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, "session-a")).get();
    expect(row).toEqual({ id: "session-a", title: "Saved" });
    const query = f.commands.find(command => command.text.startsWith("select "))!;
    expect(query.text).toContain('"id" = $1');
    expect(query.text).not.toContain("?");
    expect(query.values).toEqual(["session-a"]);
    expect(f.commands[1]?.text).toBe('SET LOCAL search_path TO "host-data", pg_catalog');
    expect(f.commands.find(command => command.text.includes("pg_advisory_xact_lock"))?.values).toEqual(["host-data", "instance-1"]);
    expect(backendFor(f.runtime.db)).toBe("postgresql");
    await f.runtime.closeAsync();
  });

  it("normalizes exact int8 values and rejects unrepresentable results", async () => {
    const f = fixture(text => text.startsWith("SELECT value")
      ? { rows: [["9007199254740991"]], fields: [{ name: "value", dataTypeID: 20 }], rowCount: 1, command: "SELECT" }
      : empty());
    expect((await f.runtime.query("SELECT value")).rows).toEqual([{ value: Number.MAX_SAFE_INTEGER }]);
    await f.runtime.closeAsync();
    const overflow = fixture(text => text.startsWith("SELECT value")
      ? { rows: [["9007199254740992"]], fields: [{ name: "value", dataTypeID: 20 }], rowCount: 1, command: "SELECT" }
      : empty());
    await expect(overflow.runtime.query("SELECT value")).rejects.toThrow("POSTGRES_UNREPRESENTABLE_INT8_RESULT");
    await overflow.runtime.closeAsync();
  });

  it("rejects NUL and unsafe numbers before admitting a connection operation", async () => {
    const f = fixture();
    await expect(f.runtime.query("SELECT $1", ["before\0after"])).rejects.toThrow("POSTGRES_TEXT_NUL_UNSUPPORTED");
    await expect(f.runtime.query("SELECT $1", [Number.MAX_SAFE_INTEGER + 1])).rejects.toThrow("POSTGRES_UNREPRESENTABLE_NUMBER");
    expect(f.commands).toEqual([]);
    await f.runtime.closeAsync();
  });

  it("keeps neutral boolean/date binding and snapshots binary arguments at admission", async () => {
    const f = fixture();
    const bytes = new Uint8Array([0, 255]);
    const work = f.runtime.query("SELECT $1, $2, $3", [true, new Date("2026-11-06T00:00:00.000Z"), bytes]);
    bytes[0] = 10;
    await work;
    const values = f.commands.find(command => command.text === "SELECT $1, $2, $3")!.values;
    expect(values[0]).toBe(1);
    expect(values[1]).toBe(Date.parse("2026-11-06T00:00:00.000Z"));
    expect([...values[2] as Uint8Array]).toEqual([0, 255]);
    await expect(f.runtime.query("SELECT $1", [{ unknown: "object" }])).rejects.toThrow("POSTGRES_UNSUPPORTED_PARAMETER_VALUE");
    await f.runtime.closeAsync();
  });

  it("keeps a caught statement failure inside its savepoint and allows subsequent statements", async () => {
    const duplicate = Object.assign(new Error("duplicate fixture"), { code: "23505" });
    const f = fixture(text => {
      if (text.startsWith("UPDATE failing")) throw duplicate;
      return empty();
    });
    await f.runtime.db.transaction(async tx => {
      expect(backendFor(tx)).toBe("postgresql");
      await expect(tx.run(sql`UPDATE failing SET value = 1`)).rejects.toBe(duplicate);
      await tx.run(sql`UPDATE successful SET value = 2`);
    });
    const names = f.commands.map(command => command.text);
    expect(names).toContain("ROLLBACK TO SAVEPOINT aervox_statement_1");
    expect(names.indexOf("RELEASE SAVEPOINT aervox_statement_1")).toBeLessThan(names.indexOf("UPDATE successful SET value = 2"));
    expect(names.at(-1)).toBe("COMMIT");
    expect(names.filter(text => text.startsWith("BEGIN"))).toHaveLength(1);
    expect(f.releases).toEqual([undefined]);
    await f.runtime.closeAsync();
  });

  it("isolates failed savepoint cleanup and never commits the poisoned transaction", async () => {
    const f = fixture(text => {
      if (text.startsWith("UPDATE failing") || text.startsWith("ROLLBACK TO SAVEPOINT")) throw new Error("transport failure");
      return empty();
    });
    await expect(f.runtime.db.transaction(async tx => {
      await tx.run(sql`UPDATE failing SET value = 1`).catch(() => undefined);
      await expect(tx.run(sql`UPDATE next SET value = 2`)).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_OUTCOME_UNCERTAIN" });
    })).rejects.toMatchObject({ code: "POSTGRES_CONNECTION_OUTCOME_UNCERTAIN" });
    expect(f.commands.some(command => command.text === "COMMIT")).toBe(false);
    expect(f.commands.some(command => command.text === "UPDATE next SET value = 2")).toBe(false);
    expect(f.releases[0]).toBeInstanceOf(Error);
    await f.runtime.closeAsync();
  });

  it("marks a lost commit acknowledgement unknown and never replays the callback", async () => {
    const f = fixture(text => { if (text === "COMMIT") throw new Error("connection reset"); return empty(); });
    let callbacks = 0;
    await expect(f.runtime.db.transaction(async tx => { callbacks++; await tx.run(sql`UPDATE target SET value = 1`); }))
      .rejects.toMatchObject({ code: "POSTGRES_COMMIT_OUTCOME_UNKNOWN" });
    expect(callbacks).toBe(1);
    expect(f.commands.filter(command => command.text === "UPDATE target SET value = 1")).toHaveLength(1);
    expect(f.commands.at(-1)?.text).toBe("ROLLBACK");
    expect(f.releases[0]).toBeInstanceOf(Error);
    await f.runtime.closeAsync();
  });

  it("rejects nested transactions and unsupported SQLite update/delete grammar", async () => {
    const f = fixture();
    await expect(f.runtime.db.transaction(async tx => tx.transaction(async () => undefined)))
      .rejects.toThrow("DATABASE_NESTED_TRANSACTION_UNSUPPORTED");
    expect(() => f.runtime.db.delete(sessions).limit(1).toSQL()).toThrow("POSTGRES_DELETE_LIMIT_ORDER_UNSUPPORTED");
    expect(() => f.runtime.db.update(sessions).set({ title: "x" }).limit(1).toSQL()).toThrow("POSTGRES_UPDATE_LIMIT_ORDER_JOIN_UNSUPPORTED");
    await expect(f.runtime.query("COMMIT")).rejects.toThrow("POSTGRES_REPOSITORY_STATEMENT_UNSUPPORTED");
    await f.runtime.closeAsync();
  });

  it("recognizes quoted semicolons while blocking a second statement before BEGIN", async () => {
    const f = fixture();
    await expect(f.runtime.query("SELECT 'safe;value'; /* trailing */ COMMIT"))
      .rejects.toThrow("POSTGRES_MULTIPLE_STATEMENTS_UNSUPPORTED");
    await expect(f.runtime.query("SELECT $tag$; COMMIT; $tag$; ROLLBACK"))
      .rejects.toThrow("POSTGRES_MULTIPLE_STATEMENTS_UNSUPPORTED");
    expect(f.commands).toEqual([]);
    await f.runtime.query("SELECT 'safe;value', $tag$; data $tag$; /* trailing ; */");
    expect(f.commands.some(command => command.text.startsWith("SELECT 'safe;value'"))).toBe(true);
    await f.runtime.closeAsync();
  });

  it("drains accepted work before releasing pool ownership and rejects new work during close", async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const f = fixture(async text => {
      if (text === "UPDATE waiting SET value = 1") { entered(); await blocked; }
      return empty();
    });
    const work = f.runtime.query("UPDATE waiting SET value = 1");
    await started;
    const closing = f.runtime.closeAsync();
    expect(f.ended()).toBe(0);
    await expect(f.runtime.query("SELECT late")).rejects.toThrow("POSTGRES_RUNTIME_CLOSED");
    unblock();
    await work;
    await closing;
    expect(f.ended()).toBe(1);
    await f.runtime.closeAsync();
    expect(f.ended()).toBe(1);
  });
});
