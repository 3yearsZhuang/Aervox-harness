import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { asc } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../src/client.js";
import { createPostgresQueryRuntime, type PostgresQueryRuntime } from "../src/driver/postgres-session.js";
import { ascendingNullsFirst, descendingNullsLast, textLike } from "../src/sql-dialect.js";

const databaseUrl = process.env.AERVOX_TEST_POSTGRES_URL;
const entries = sqliteTable("expression_entries", { id: text("id").primaryKey(), title: text("title"), count: integer("count") });
describe.skipIf(!databaseUrl)("SQLite and PostgreSQL expression parity", () => {
  let sqlite: Awaited<ReturnType<typeof createInMemoryDatabase>>, admin: Pool, runtime: PostgresQueryRuntime;
  const schema = `aervox_expression_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    sqlite = await createInMemoryDatabase();
    await sqlite.client.execute("CREATE TABLE expression_entries(id text PRIMARY KEY,title text,count integer)");
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE TABLE "${schema}".expression_entries(id text PRIMARY KEY,title text,count bigint)`);
    runtime = createPostgresQueryRuntime(new Pool({ connectionString: databaseUrl }), { schema, instanceId: "expression-owner" });
    const rows = [
      { id: "null", title: null, count: null }, { id: "slash-wildcard", title: String.raw`A\XB`, count: 1 },
      { id: "slash-underscore", title: String.raw`a\_b`, count: 2 }, { id: "underscore", title: "A_B", count: 3 },
      { id: "unicode-upper", title: "É", count: 4 }, { id: "unicode-lower", title: "é", count: null },
      { id: "percent", title: "%", count: 6 },
    ];
    await sqlite.db.insert(entries).values(rows); await runtime.db.insert(entries).values(rows);
  });
  afterAll(async () => {
    await runtime?.closeAsync(); await sqlite?.cleanup();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  it("keeps SQLite ASCII folding and treats backslashes literally instead of PostgreSQL's default escape", async () => {
    for (const pattern of [String.raw`a\_b`, "a_b", String.raw`%\_%`, "É", "é", "_", "a%", "%"]) {
      const query = (db: typeof runtime.db) => db.select({ id: entries.id }).from(entries).where(textLike(db, entries.title, pattern)).orderBy(asc(entries.id));
      expect(await query(runtime.db), pattern).toEqual(await query(sqlite.db));
    }
    expect((await runtime.db.select({ id: entries.id }).from(entries).where(textLike(runtime.db, entries.title, String.raw`a\_b`)).orderBy(asc(entries.id))).map(row => row.id))
      .toEqual(["slash-underscore", "slash-wildcard"]);
  });
  it("keeps nullable ASC and DESC ordering identical across engines", async () => {
    for (const order of [ascendingNullsFirst, descendingNullsLast]) {
      const query = (db: typeof runtime.db) => db.select({ id: entries.id }).from(entries).orderBy(order(db, entries.count), asc(entries.id));
      expect(await query(runtime.db)).toEqual(await query(sqlite.db));
    }
    // Confirm the fix belongs to the query rather than globally changing PG's
    // own ordering, which remains NULLS LAST for ordinary native ASC.
    expect((await runtime.db.select({ id: entries.id }).from(entries).orderBy(asc(entries.count), asc(entries.id)))[0]?.id).toBe("slash-wildcard");
  });
});
