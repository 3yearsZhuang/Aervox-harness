import { describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { buildPortableSchemaArtifact } from "../src/schema/portable-artifact.js";
import * as manifest from "../src/schema/manifest.js";

function assertPlainJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { expect(Number.isFinite(value)).toBe(true); return; }
  expect(typeof value).toBe("object");
  if (Array.isArray(value)) { for (const item of value) assertPlainJson(item); return; }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const item of Object.values(value as Record<string, unknown>)) assertPlainJson(item);
}

describe("build-time portable schema artifact", () => {
  it.each(["main", "ledger"] as const)("produces deterministic frozen JSON for %s without runtime handles or initialization time", scope => {
    const artifact = buildPortableSchemaArtifact(scope);
    expect(artifact).toEqual(buildPortableSchemaArtifact(scope));
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    assertPlainJson(artifact);
    expect(artifact).toMatchObject({ formatVersion: 1, scope,
      schemaVersion: manifest.CURRENT_SCHEMA_VERSION, fingerprint: manifest.SCHEMA_RELEASES[manifest.CURRENT_SCHEMA_VERSION]![scope],
      initialization: { requiredDatabaseState: "empty", journal: { parameters: {
        scope, version: String(manifest.CURRENT_SCHEMA_VERSION), fingerprint: artifact.fingerprint,
      }, requiredRuntimeParameters: ["applied_at"] } },
    });
    expect(Object.keys(artifact.initialization.journal.parameters).sort()).toEqual(["fingerprint", "scope", "version"]);
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.initialization.statements)).toBe(true);
    expect(Object.isFrozen(artifact.initialization.journal.parameters)).toBe(true);
    expect(artifact.initialization.statements.every(sql => /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) /u.test(sql))).toBe(true);
  });

  it.each(["main", "ledger"] as const)("compiles %s DDL into a separate empty database with the full existing physical contract", async scope => {
    const client = createClient({ url: ":memory:" });
    try {
      const artifact = buildPortableSchemaArtifact(scope);
      await client.execute("PRAGMA foreign_keys=ON");
      await client.batch(artifact.initialization.statements, "write");
      expect(await manifest.inspectSchemaParity(client, scope)).toEqual([]);
      const journal = artifact.initialization.journal;
      await client.execute({ sql: journal.sql, args: { ...journal.parameters, applied_at: "2026-10-26T00:00:00.000Z" } });
      const receipt = await client.execute("SELECT scope, version, fingerprint, applied_at FROM _aervox_schema_versions");
      expect(receipt.rows.map(row => ({ ...row }))).toEqual([{ ...journal.parameters, applied_at: "2026-10-26T00:00:00.000Z" }]);
      // A generated target is compatible with the unchanged bootstrap gate; it
      // does not establish a new version or alter the physical release ledger.
      await expect(manifest.initializeCanonicalSchema(client, scope)).resolves.toBeUndefined();
      expect(await manifest.inspectSchemaParity(client, scope)).toEqual([]);
      const names = (await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(row => row.name);
      if (scope === "ledger") {
        expect(names.sort()).toEqual(["_aervox_schema_versions", "recovery_control_ledger"]);
        expect(artifact.projections.statements).toEqual([]);
      } else {
        expect(names).not.toContain("recovery_control_ledger");
        for (const sql of artifact.projections.statements) await client.execute(sql);
        await client.execute("INSERT INTO messages_fts(id, content) VALUES('projection', 'portablecanary')");
        const found = await client.execute("SELECT id FROM messages_fts WHERE messages_fts MATCH 'portablecanary'");
        expect(found.rows.map(row => row.id)).toEqual(["projection"]);
      }
    } finally { client.close(); }
  });

  it("refuses to emit a target whose fingerprint has no registered release", () => {
    const fingerprint = vi.spyOn(manifest, "schemaFingerprint").mockReturnValue("0".repeat(64));
    try { expect(() => buildPortableSchemaArtifact("main")).toThrow(manifest.SchemaMigrationRequiredError); }
    finally { fingerprint.mockRestore(); }
    expect(() => buildPortableSchemaArtifact("other" as never)).toThrow("Unsupported schema scope");
  });

  it("does not make an unknown populated database eligible for bootstrap or silently migrate it", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("CREATE TABLE unknown_owned_data(id TEXT PRIMARY KEY, body TEXT)");
      await client.execute("INSERT INTO unknown_owned_data VALUES('keep', 'preserve')");
      const before = await client.execute("SELECT name, sql FROM sqlite_master ORDER BY name");
      buildPortableSchemaArtifact("main");
      await expect(manifest.initializeCanonicalSchema(client, "main")).rejects.toThrow(manifest.SchemaMigrationRequiredError);
      expect((await client.execute("SELECT name, sql FROM sqlite_master ORDER BY name")).rows).toEqual(before.rows);
      expect((await client.execute("SELECT * FROM unknown_owned_data")).rows.map(row => ({ ...row }))).toEqual([{ id: "keep", body: "preserve" }]);
    } finally { client.close(); }
  });

  it("keeps a mismatched version receipt unchanged even when the emitted target DDL matches", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      const artifact = buildPortableSchemaArtifact("ledger");
      await client.batch(artifact.initialization.statements, "write");
      await client.execute({ sql: artifact.initialization.journal.sql, args: {
        ...artifact.initialization.journal.parameters, fingerprint: "old-release", applied_at: "old-time",
      } });
      await expect(manifest.initializeCanonicalSchema(client, "ledger")).rejects.toThrow("version/fingerprint mismatch");
      expect((await client.execute("SELECT fingerprint, applied_at FROM _aervox_schema_versions")).rows.map(row => ({ ...row })))
        .toEqual([{ fingerprint: "old-release", applied_at: "old-time" }]);
    } finally { client.close(); }
  });
});
