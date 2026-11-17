import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { alias, sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";
import { createPostgresQueryRuntime, type PostgresQueryRuntime } from "../src/driver/postgres-session.js";

const databaseUrl = process.env.AERVOX_TEST_POSTGRES_URL;
const valuesTable = sqliteTable("driver_values", {
  id: text("id").primaryKey(),
  payload: text("payload", { mode: "json" }).$type<{ name: string; nullable: null }>().notNull(),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
  count: integer("count").notNull(),
});

describe.skipIf(!databaseUrl)("PostgreSQL Session real server contract", () => {
  const namespace = `aervox_driver_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let runtime: PostgresQueryRuntime;
  let second: PostgresQueryRuntime;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    await admin.query(`CREATE TABLE "${namespace}".driver_values (id text PRIMARY KEY, payload text NOT NULL, bytes bytea NOT NULL, count bigint NOT NULL)`);
    runtime = createPostgresQueryRuntime(new Pool({ connectionString: databaseUrl }), { schema: namespace, instanceId: "test-owner" });
    second = createPostgresQueryRuntime(new Pool({ connectionString: databaseUrl }), { schema: namespace, instanceId: "test-owner" });
  });
  afterAll(async () => {
    await Promise.all([runtime?.closeAsync(), second?.closeAsync()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.end(); }
  });

  it("round trips JSON and precise BLOB bytes through original column codecs", async () => {
    const input = { id: "中文-🌙", payload: { name: "值\0尾", nullable: null }, bytes: Buffer.from([0, 1, 127, 128, 255]), count: 9 };
    const [created] = await runtime.db.insert(valuesTable).values(input).returning();
    expect(created).toEqual(input);
    const loaded = await runtime.db.select().from(valuesTable).where(eq(valuesTable.id, input.id)).get();
    expect(loaded).toEqual(input);
    const flat = await runtime.db.select({ id: valuesTable.id, count: valuesTable.count }).from(valuesTable).where(eq(valuesTable.id, input.id)).all();
    expect(flat).toEqual([{ id: input.id, count: 9 }]);
  });

  it("rolls back a complete callback and recovers a caught unique conflict", async () => {
    await expect(runtime.db.transaction(async tx => {
      await tx.insert(valuesTable).values({ id: "rolled-back", payload: { name: "x", nullable: null }, bytes: Buffer.alloc(0), count: 1 });
      throw new Error("callback failure");
    })).rejects.toThrow("callback failure");
    expect(await runtime.db.select().from(valuesTable).where(eq(valuesTable.id, "rolled-back")).get()).toBeUndefined();
    await runtime.db.transaction(async tx => {
      await tx.insert(valuesTable).values({ id: "unique", payload: { name: "x", nullable: null }, bytes: Buffer.alloc(0), count: 1 });
      await expect(tx.insert(valuesTable).values({ id: "unique", payload: { name: "other", nullable: null }, bytes: Buffer.alloc(0), count: 2 }))
        .rejects.toMatchObject({ code: "23505" });
      await tx.update(valuesTable).set({ count: 3 }).where(eq(valuesTable.id, "unique"));
    });
    expect((await runtime.db.select().from(valuesTable).where(eq(valuesTable.id, "unique")).get())?.count).toBe(3);
  });

  it("preserves typed alias joins, null projections and PostgreSQL UPDATE FROM", async () => {
    const other = alias(valuesTable, "other_values");
    const input = { id: "join-source", payload: { name: "join", nullable: null }, bytes: Buffer.from([3]), count: 4 };
    await runtime.db.insert(valuesTable).values(input);
    const absent = await runtime.db.select({ source: valuesTable, other }).from(valuesTable)
      .leftJoin(other, eq(other.id, "absent")).where(eq(valuesTable.id, input.id)).get();
    expect(absent).toEqual({ source: input, other: null });
    const [updated] = await runtime.db.update(valuesTable).set({ count: sql`${other.count} + 1` }).from(other)
      .where(sql`${valuesTable.id} = ${other.id} AND ${valuesTable.id} = ${input.id}`).returning();
    expect(updated).toEqual({ ...input, count: 5 });
  });

  it("serializes same-instance transactions across two independent pools", async () => {
    const id = "concurrent";
    await runtime.db.insert(valuesTable).values({ id, payload: { name: "x", nullable: null }, bytes: Buffer.alloc(0), count: 0 });
    let firstHasLock!: () => void;
    const locked = new Promise<void>(resolve => { firstHasLock = resolve; });
    const order: string[] = [];
    const first = runtime.db.transaction(async tx => {
      order.push("first-enter"); firstHasLock();
      await tx.run(sql`SELECT pg_sleep(0.05)`);
      await tx.update(valuesTable).set({ count: sql`${valuesTable.count} + 1` }).where(eq(valuesTable.id, id));
      order.push("first-end");
    });
    await locked;
    const other = second.db.transaction(async tx => {
      order.push("second-enter");
      const row = await tx.select().from(valuesTable).where(eq(valuesTable.id, id)).get();
      expect(row?.count).toBe(1);
      await tx.update(valuesTable).set({ count: sql`${valuesTable.count} + 1` }).where(eq(valuesTable.id, id));
    });
    await Promise.all([first, other]);
    expect(order).toEqual(["first-enter", "first-end", "second-enter"]);
    expect((await runtime.db.select().from(valuesTable).where(eq(valuesTable.id, id)).get())?.count).toBe(2);
  });
});
