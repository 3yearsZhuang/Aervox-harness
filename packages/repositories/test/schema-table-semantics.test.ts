import { createClient, type Client } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@aervox/schema", async () => {
  const { sql } = await import("drizzle-orm");
  const { sqliteTable, text, integer, primaryKey, foreignKey, unique, check } = await import("drizzle-orm/sqlite-core");
  const parent = sqliteTable("parent_semantics", { a: text("a").notNull(), b: text("b").notNull() }, table => [
    primaryKey({ columns: [table.a, table.b] }), unique().on(table.a), unique().on(table.b),
  ]);
  const child = sqliteTable("child_semantics", {
    id: integer("id").primaryKey().notNull(), left: text("left"), right: text("right"),
    other: text("other").references(() => parent.a), token: text("token").notNull(),
  }, table => [
    foreignKey({ columns: [table.left, table.right], foreignColumns: [parent.a, parent.b] }).onDelete("cascade").onUpdate("cascade"),
    unique().on(table.token),
    check("token_guard", sql`coalesce(length("token"), 0) > 0 AND "token" <> 'CHECK ( ) , )'`),
  ]);
  return { parent, child };
});

import { inspectSchemaParity, schemaManifest } from "../src/schema/manifest.js";
import { tableDefinitionSemantics } from "../src/schema/table-semantics.js";

const compositeForeignKey = 'FOREIGN KEY ("left", "right") REFERENCES "parent_semantics" ("a", "b") ON DELETE cascade ON UPDATE cascade';
const otherForeignKey = 'FOREIGN KEY ("other") REFERENCES "parent_semantics" ("a") ON DELETE no action ON UPDATE no action';
async function withFixture(run: (client: Client) => Promise<void>, transform: (sql: string, name: string) => string = sql => sql) {
  const client = createClient({ url: ":memory:" });
  try {
    await client.batch(schemaManifest("main").flatMap(table => [transform(table.sql, table.name), ...table.indexes.map(index => index.sql)]), "write");
    await run(client);
  } finally { client.close(); }
}
const childSql = (transform: (sql: string) => string) => (sql: string, name: string) => name === "child_semantics" ? transform(sql) : sql;

describe("SQLite table constraint semantics", () => {
  it("matches CHECK, composite PK/FK and independent FK declarations", async () => {
    await withFixture(async client => { expect(await inspectSchemaParity(client, "main")).toEqual([]); });
  });

  it("accepts renamed CHECK constraints, identifier quoting, comments and redundant outer parentheses", async () => {
    await withFixture(async client => { expect(await inspectSchemaParity(client, "main")).toEqual([]); }, childSql(sql => sql
      .replace('CONSTRAINT "token_guard" CHECK (', 'CONSTRAINT renamed CHECK (( /* CHECK ignored ( ) */ ')
      .replace('length("token")', 'length([token])')
      .replace("'CHECK ( ) , )'))", "'CHECK ( ) , )')))")));
  });

  it.each([
    ["removed", (sql: string) => sql.replace(/, CONSTRAINT "token_guard" CHECK \([\s\S]*\)\)$/, ")")],
    ["expression", (sql: string) => sql.replace('coalesce(length("token"), 0) > 0', 'coalesce(length("token"), 0) > 1')],
    ["literal case", (sql: string) => sql.replace("'CHECK ( ) , )'", "'check ( ) , )'")],
  ])("detects a %s CHECK", async (_kind, transform) => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: checks differ");
    }, childSql(transform));
  });

  it("preserves CHECK parentheses and punctuation inside quoted literals", () => {
    expect(tableDefinitionSemantics("CREATE TABLE sample(id TEXT CHECK (id <> '(' AND id <> '-- CHECK )'))").checks).toHaveLength(1);
    expect(tableDefinitionSemantics("CREATE TABLE sample(id TEXT CHECK ('('))").checks).toHaveLength(1);
  });

  it("ignores FK numeric ids and declaration order", async () => {
    await withFixture(async client => { expect(await inspectSchemaParity(client, "main")).toEqual([]); }, childSql(sql => sql
      .replace(otherForeignKey, "temporary_foreign_key_marker").replace(compositeForeignKey, otherForeignKey)
      .replace("temporary_foreign_key_marker", compositeForeignKey)));
  });

  it("detects a composite FK split into individually valid independent references", async () => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: foreign keys differ");
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute("INSERT INTO parent_semantics VALUES('a1','b1'),('a2','b2')");
      // Each value exists, but their pair does not. The altered schema accepts it.
      await client.execute("INSERT INTO child_semantics(id,left,right,token) VALUES(1,'a1','b2','allowed-by-split')");
    }, childSql(sql => sql.replace(compositeForeignKey,
      'FOREIGN KEY ("left") REFERENCES "parent_semantics" ("a") ON DELETE cascade ON UPDATE cascade, FOREIGN KEY ("right") REFERENCES "parent_semantics" ("b") ON DELETE cascade ON UPDATE cascade')));
  });

  it.each([
    ["target pairing", compositeForeignKey.replace('("a", "b")', '("b", "a")')],
    ["delete action", compositeForeignKey.replace("ON DELETE cascade", "ON DELETE restrict")],
    ["update action", compositeForeignKey.replace("ON UPDATE cascade", "ON UPDATE restrict")],
  ])("detects changed FK %s", async (_kind, replacement) => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: foreign keys differ");
    }, childSql(sql => sql.replace(compositeForeignKey, replacement)));
  });

  it.each(["DEFERRABLE INITIALLY DEFERRED", "DEFERRABLE INITIALLY IMMEDIATE", "NOT DEFERRABLE INITIALLY DEFERRED", "MATCH FULL"])("detects FK timing/match not exposed by PRAGMA: %s", async modifier => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: foreignModifiers differ");
    }, childSql(sql => sql.replace(compositeForeignKey, `${compositeForeignKey} ${modifier}`)));
  });

  it("accepts explicit immediate, non-deferrable FK behavior", async () => {
    await withFixture(async client => { expect(await inspectSchemaParity(client, "main")).toEqual([]); }, childSql(sql => sql
      .replace(compositeForeignKey, `${compositeForeignKey} NOT DEFERRABLE INITIALLY IMMEDIATE`)));
  });

  it("detects composite PK order", async () => {
    await withFixture(async client => {
      const issues = await inspectSchemaParity(client, "main");
      expect(issues).toContain("parent_semantics: primary key indexes differ");
      expect(issues.some(issue => issue.startsWith("parent_semantics.a:"))).toBe(true);
    }, (sql, name) => name === "parent_semantics" ? sql.replace('PRIMARY KEY ("a", "b")', 'PRIMARY KEY ("b", "a")') : sql);
  });

  it("detects collation on an unindexed column", async () => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: collations differ");
    }, childSql(sql => sql.replace('"left" text', '"left" text COLLATE NOCASE')));
  });

  it.each([
    ["primary key conflict", (sql: string) => sql.replace('"id" integer NOT NULL PRIMARY KEY', '"id" integer NOT NULL PRIMARY KEY ON CONFLICT REPLACE'), "conflicts"],
    ["not null conflict", (sql: string) => sql.replace('"token" text NOT NULL', '"token" text NOT NULL ON CONFLICT IGNORE'), "conflicts"],
    ["unique conflict", (sql: string) => sql.replace('UNIQUE ("token")', 'UNIQUE ("token") ON CONFLICT REPLACE'), "conflicts"],
    ["autoincrement", (sql: string) => sql.replace('"id" integer NOT NULL PRIMARY KEY', '"id" integer NOT NULL PRIMARY KEY AUTOINCREMENT'), "autoIncrement"],
  ])("detects changed %s behavior", async (_kind, transform, issue) => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain(`child_semantics: ${issue} differ`);
    }, childSql(transform));
  });

  it("accepts explicit default conflict and column collation", async () => {
    await withFixture(async client => { expect(await inspectSchemaParity(client, "main")).toEqual([]); }, childSql(sql => sql
      .replace('"token" text NOT NULL', '"token" text COLLATE BINARY NOT NULL ON CONFLICT ABORT')));
  });

  it("detects ordinary column order changes even when named column attributes match", async () => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics: column order differs");
    }, childSql(sql => sql.replace('"left" text, "right" text', '"right" text, "left" text')));
  });

  it.each(["VIRTUAL", "STORED"])("detects a generated replacement for an existing ordinary column (%s)", async storage => {
    await withFixture(async client => {
      expect(await inspectSchemaParity(client, "main")).toContain("child_semantics.left: undeclared hidden or generated column");
    }, childSql(sql => sql.replace('"left" text', `"left" text GENERATED ALWAYS AS ("token") ${storage}`)));
  });

  it("preserves the case of SQLite's double-quoted string fallback", () => {
    const first = tableDefinitionSemantics('CREATE TABLE sample(id TEXT CHECK (id <> "CaseLiteral"))');
    const changed = tableDefinitionSemantics('CREATE TABLE sample(id TEXT CHECK (id <> "caseliteral"))');
    expect(first.checks).not.toEqual(changed.checks);
    expect(tableDefinitionSemantics(`CREATE TABLE sample(id TEXT CHECK ("ID" <> 'x'))`).checks)
      .toEqual(tableDefinitionSemantics("CREATE TABLE sample(id TEXT CHECK (id <> 'x'))").checks);
  });

  it("attaches conflict policies to the specific constraint on a shared column", () => {
    const first = tableDefinitionSemantics("CREATE TABLE sample(id TEXT NOT NULL ON CONFLICT IGNORE UNIQUE ON CONFLICT REPLACE)");
    const swapped = tableDefinitionSemantics("CREATE TABLE sample(id TEXT NOT NULL ON CONFLICT REPLACE UNIQUE ON CONFLICT IGNORE)");
    expect(first.conflicts).not.toEqual(swapped.conflicts);
    const reordered = tableDefinitionSemantics("CREATE TABLE sample(id TEXT UNIQUE ON CONFLICT REPLACE NOT NULL ON CONFLICT IGNORE)");
    expect(first).toEqual(reordered);
  });

  it("keeps a foreign key modifier attached to its target for multiple inline references", () => {
    const first = tableDefinitionSemantics("CREATE TABLE sample(id TEXT REFERENCES parent(a) DEFERRABLE INITIALLY DEFERRED REFERENCES other(a))");
    const swapped = tableDefinitionSemantics("CREATE TABLE sample(id TEXT REFERENCES parent(a) REFERENCES other(a) DEFERRABLE INITIALLY DEFERRED)");
    expect(first.foreignModifiers).not.toEqual(swapped.foreignModifiers);
    const reordered = tableDefinitionSemantics("CREATE TABLE sample(id TEXT REFERENCES other(a) REFERENCES parent(a) DEFERRABLE INITIALLY DEFERRED)");
    expect(first).toEqual(reordered);
  });

  it("preserves the grouping of timing modifiers for repeated references", () => {
    const first = tableDefinitionSemantics("CREATE TABLE sample(id TEXT REFERENCES parent(a) DEFERRABLE INITIALLY DEFERRED REFERENCES parent(a) NOT DEFERRABLE INITIALLY IMMEDIATE)");
    const swapped = tableDefinitionSemantics("CREATE TABLE sample(id TEXT REFERENCES parent(a) DEFERRABLE INITIALLY IMMEDIATE REFERENCES parent(a) NOT DEFERRABLE INITIALLY DEFERRED)");
    expect(first.foreignModifiers).not.toEqual(swapped.foreignModifiers);
  });

  it("fails closed for an unsupported table definition instead of guessing its semantics", () => {
    expect(() => tableDefinitionSemantics("CREATE VIRTUAL TABLE sample USING fts5(content)")).toThrow("unsupported table definition");
    expect(() => tableDefinitionSemantics("CREATE TABLE sample(id TEXT) unknown_option")).toThrow("unsupported table option");
  });
});
