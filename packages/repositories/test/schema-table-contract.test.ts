import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { initDatabaseSchema, inspectSchemaParity, schemaFingerprint, schemaManifest, SchemaMigrationRequiredError, SCHEMA_RELEASES } from "../src/index.js";

describe("table semantics before schema registration", () => {
  it("keeps the released schema fingerprints when inspection is strengthened", () => {
    expect(schemaFingerprint("main")).toBe("c749a41cf2155d0b070c08746bd353e77479d6766b113d8e4f78bcaeda5961b4");
    expect(schemaFingerprint("ledger")).toBe("a14fd3df3feaf5a736b112f3d65c731a26e0689b90583c3ae9030840f308d8eb");
    expect(schemaFingerprint("main")).toBe(SCHEMA_RELEASES[1]?.main);
    expect(schemaFingerprint("ledger")).toBe(SCHEMA_RELEASES[1]?.ledger);
  });

  it.each(["CHECK", "STRICT", "WITHOUT ROWID"].flatMap(variant => [
    { variant, versioned: false }, { variant, versioned: true },
  ]))("rejects $variant drift (versioned=$versioned) without changing source bytes, data or version metadata", async ({ variant, versioned }) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-table-semantics-"));
    const databasePath = path.join(directory, "source.db");
    const creator = createClient({ url: `file:${databasePath}` });
    try {
      await creator.batch(schemaManifest("main").filter(table => versioned || table.name !== "_aervox_schema_versions").flatMap(table => {
        let sql = table.sql;
        if (table.name === "learning_goals") sql = variant === "CHECK"
          ? `${sql.slice(0, -1)}, CHECK (id <> 'blocked-by-extra-check'))` : `${sql} ${variant}`;
        return [sql, ...table.indexes.map(index => index.sql)];
      }), "write");
      if (versioned) await creator.execute({
        sql: "INSERT INTO _aervox_schema_versions(scope,version,fingerprint,applied_at) VALUES('main','1',?,'retained-version-time')",
        args: [schemaFingerprint("main")],
      });
      await creator.execute("INSERT INTO learning_goals(id,topic,created_at,updated_at) VALUES('retained','keep','t','t')");
      if (variant === "CHECK") {
        await expect(creator.execute("INSERT INTO learning_goals(id,topic,created_at,updated_at) VALUES('blocked-by-extra-check','test','t','t')")).rejects.toThrow(/CHECK constraint failed/);
      } else if (variant === "STRICT") {
        await expect(creator.execute("UPDATE learning_goals SET available_minutes='not an integer'")).rejects.toThrow(/cannot store TEXT value/);
      } else {
        await expect(creator.execute("SELECT rowid FROM learning_goals")).rejects.toThrow(/no such column/);
      }
      creator.close();
      const originalBytes = await fs.readFile(databasePath);
      const inspected = createClient({ url: `file:${databasePath}` });
      try {
        const execute = inspected.execute.bind(inspected);
        vi.spyOn(inspected, "execute").mockImplementation(statement => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          expect(sql).toMatch(/^\s*(SELECT|PRAGMA)\b/i);
          return execute(statement);
        });
        expect(await inspectSchemaParity(inspected, "main", { allowUnversioned: true })).toContain(
          `learning_goals: ${variant === "CHECK" ? "checks" : "table options"} differ`,
        );
        await expect(initDatabaseSchema(inspected)).rejects.toBeInstanceOf(SchemaMigrationRequiredError);
        expect((await inspected.execute("SELECT id,topic FROM learning_goals")).rows).toEqual([{ id: "retained", topic: "keep" }]);
        expect((await inspected.execute("SELECT name FROM sqlite_master WHERE name='_aervox_schema_versions'")).rows)
          .toEqual(versioned ? [{ name: "_aervox_schema_versions" }] : []);
        if (versioned) expect((await inspected.execute("SELECT * FROM _aervox_schema_versions")).rows).toEqual([
          { scope: "main", version: "1", fingerprint: schemaFingerprint("main"), applied_at: "retained-version-time" },
        ]);
      } finally { inspected.close(); }
      expect(await fs.readFile(databasePath)).toEqual(originalBytes);
    } finally { creator.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
