import { createClient, type Client } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";

// A focused declaration fixture exercises expression keys without changing the immutable product schema release.
vi.mock("@aervox/schema", async () => {
  const { sql } = await import("drizzle-orm");
  const { sqliteTable, text, integer, index, unique, uniqueIndex } = await import("drizzle-orm/sqlite-core");
  return {
    indexSemantics: sqliteTable("index_semantics", {
      id: text("id").primaryKey().notNull(),
      token: text("token").notNull(),
      active: integer("active").notNull(),
    }, (table) => [
      unique("token_constraint").on(table.token),
      uniqueIndex("token_unique").on(table.token),
      index("expression_key").on(
        sql`coalesce(lower("token"), 'where ) , ''ok''') COLLATE NOCASE DESC`,
        sql`substr("token", 1, 2)`,
      ).where(sql`"active" = 1 AND "token" <> 'WHERE , )'`),
    ]),
  };
});

import { inspectSchemaParity, schemaManifest } from "../src/schema/manifest.js";

async function withFixture(run: (client: Client) => Promise<void>, tableSql?: (sql: string) => string) {
  const client = createClient({ url: ":memory:" });
  try {
    const [table] = schemaManifest("main");
    await client.batch([tableSql?.(table!.sql) ?? table!.sql, ...table!.indexes.map((index) => index.sql)], "write");
    await run(client);
  } finally { client.close(); }
}

describe("SQLite physical index semantics", () => {
  it("compares matching expression keys with nested commas, quoted parentheses, modifiers and predicates", async () => {
    await withFixture(async (client) => {
      expect(await inspectSchemaParity(client, "main")).toEqual([]);
    });
  });

  it.each([
    ["expression body", 'coalesce(upper("token"), \'where ) , \'\'ok\'\'\') COLLATE NOCASE DESC, substr("token", 1, 2)', '"active" = 1 AND "token" <> \'WHERE , )\''],
    ["expression literal", 'coalesce(lower("token"), \'WHERE ) , \'\'ok\'\'\') COLLATE NOCASE DESC, substr("token", 1, 2)', '"active" = 1 AND "token" <> \'WHERE , )\''],
    ["expression order", 'substr("token", 1, 2), coalesce(lower("token"), \'where ) , \'\'ok\'\'\') COLLATE NOCASE DESC', '"active" = 1 AND "token" <> \'WHERE , )\''],
    ["collation", 'coalesce(lower("token"), \'where ) , \'\'ok\'\'\') COLLATE BINARY DESC, substr("token", 1, 2)', '"active" = 1 AND "token" <> \'WHERE , )\''],
    ["direction", 'coalesce(lower("token"), \'where ) , \'\'ok\'\'\') COLLATE NOCASE ASC, substr("token", 1, 2)', '"active" = 1 AND "token" <> \'WHERE , )\''],
    ["predicate", 'coalesce(lower("token"), \'where ) , \'\'ok\'\'\') COLLATE NOCASE DESC, substr("token", 1, 2)', '"active" = 2 AND "token" <> \'WHERE , )\''],
  ])("detects drift in %s", async (_kind, terms, predicate) => {
    await withFixture(async (client) => {
      await client.execute("DROP INDEX expression_key");
      await client.execute(`CREATE INDEX expression_key ON index_semantics (${terms}) WHERE ${predicate}`);
      expect(await inspectSchemaParity(client, "main")).toContain("index_semantics: indexes or partial predicates differ");
    });
  });

  it("accepts explicit default collation and ascending order for column keys", async () => {
    await withFixture(async (client) => {
      await client.execute("DROP INDEX token_unique");
      await client.execute("CREATE UNIQUE INDEX token_unique ON index_semantics (token COLLATE BINARY ASC)");
      expect(await inspectSchemaParity(client, "main")).toEqual([]);
    });
  });

  it("locates a partial predicate after comments and without whitespace following WHERE", async () => {
    await withFixture(async (client) => {
      await client.execute("DROP INDEX expression_key");
      await client.execute(`CREATE INDEX expression_key ON index_semantics (
        coalesce(lower("token"), 'where ) , ''ok''') COLLATE NOCASE DESC, substr("token", 1, 2)
      ) /* WHERE ignored, ) */ -- WHERE ignored\nWHERE("active" = 1 AND "token" <> 'WHERE , )')`);
      expect(await inspectSchemaParity(client, "main")).toEqual([]);
    });
  });

  it("detects an added partial predicate even when comments contain WHERE", async () => {
    await withFixture(async (client) => {
      await client.execute("DROP INDEX token_unique");
      await client.execute("CREATE UNIQUE INDEX token_unique ON index_semantics (token) /* WHERE ignored */ WHERE(active = 1)");
      expect(await inspectSchemaParity(client, "main")).toContain("index_semantics: indexes or partial predicates differ");
    });
  });

  it("detects a lost unique constraint on an otherwise identical declared index", async () => {
    await withFixture(async (client) => {
      await client.execute("DROP INDEX token_unique");
      await client.execute("CREATE INDEX token_unique ON index_semantics (token)");
      expect(await inspectSchemaParity(client, "main")).toContain("index_semantics: indexes or partial predicates differ");
    });
  });

  it("checks inherited collation on UNIQUE constraint indexes", async () => {
    await withFixture(async (client) => {
      expect(await inspectSchemaParity(client, "main")).toContain("index_semantics: unique constraints differ");
    }, (sql) => sql.replace('"token" text NOT NULL', '"token" text COLLATE NOCASE NOT NULL'));
  });

  it("checks collation on primary key indexes", async () => {
    await withFixture(async (client) => {
      expect(await inspectSchemaParity(client, "main")).toContain("index_semantics: primary key indexes differ");
    }, (sql) => sql.replace('"id" text NOT NULL PRIMARY KEY', '"id" text COLLATE NOCASE NOT NULL PRIMARY KEY'));
  });
});
