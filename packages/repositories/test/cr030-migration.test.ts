import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../src/client.js";
import {
  Cr030MigrationStateStore,
  assertSafeStartup,
  scanLegacyScopes,
  selectLegacyScope,
} from "../src/migration/cr030-migration.js";

describe("CR-030 D1 migration primitives", () => {
  it("scans scopes without mutating source and requires explicit selection for multiple scopes", async () => {
    const database = await createInMemoryDatabase();
    try {
      await database.client.execute(`CREATE TABLE legacy_items (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL, payload TEXT
      )`);
      await database.client.execute(`INSERT INTO legacy_items VALUES
        ('a', 'w1', 'u1', 'a'), ('b', 'w1', 'u1', 'b'), ('c', 'w2', 'u2', 'c')`);

      const scan = await scanLegacyScopes(database.client);
      expect(scan.issues).toEqual([]);
      expect(scan.tables).toEqual(["legacy_items"]);
      expect(scan.scopes).toHaveLength(2);
      expect(() => selectLegacyScope(scan)).toThrow(/explicit selection/);
      expect(() => selectLegacyScope(scan, { workspaceId: "w1", subjectUserId: "u1" })).toThrow(
        /destructive acknowledgement/,
      );
      expect(
        selectLegacyScope(scan, { workspaceId: "w1", subjectUserId: "u1" }, true),
      ).toMatchObject({ mode: "explicit", scope: { workspaceId: "w1", subjectUserId: "u1" } });
    } finally {
      await database.cleanup();
    }
  });

  it("fails closed on incomplete state and allows an untouched planned database", () => {
    expect(() => assertSafeStartup(undefined)).not.toThrow();
    expect(() => assertSafeStartup({ phase: "planned", sourceReplaced: false, updatedAt: "now" })).not.toThrow();
    expect(() => assertSafeStartup({ phase: "validated", sourceReplaced: false, updatedAt: "now" })).toThrow(
      /fail closed/,
    );
    expect(() => assertSafeStartup({ phase: "swapped", sourceReplaced: true, updatedAt: "now" })).toThrow(
      /fail closed/,
    );
    expect(() => assertSafeStartup({ phase: "completed", sourceReplaced: true, updatedAt: "now" })).not.toThrow();
  });

  it("auto-selects zero or one scope and rejects malformed tenant columns", async () => {
    const database = await createInMemoryDatabase();
    try {
      expect(selectLegacyScope(await scanLegacyScopes(database.client))).toEqual({ mode: "system-only" });
      await database.client.execute(`CREATE TABLE legacy_single (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL
      )`);
      await database.client.execute("INSERT INTO legacy_single VALUES ('a', 'w1', 'u1')");
      expect(selectLegacyScope(await scanLegacyScopes(database.client))).toMatchObject({
        mode: "single",
        scope: { workspaceId: "w1", subjectUserId: "u1" },
      });

      await database.client.execute("CREATE TABLE legacy_broken (id TEXT PRIMARY KEY, workspace_id TEXT)");
      const brokenScan = await scanLegacyScopes(database.client);
      expect(brokenScan.issues).toContain(
        "legacy_broken: legacy tenant columns must include workspace_id and subject_user_id",
      );
      expect(() => selectLegacyScope(brokenScan)).toThrow(/scope scan failed/);
    } finally {
      await database.cleanup();
    }
  });

  it("persists atomic state and rejects out-of-order transitions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cr030-"));
    const store = new Cr030MigrationStateStore(path.join(directory, "migration.json"));
    try {
      expect((await store.initialize()).phase).toBe("planned");
      await expect(store.transition("validated")).rejects.toThrow(/planned -> validated/);
      await store.transition("quiesced");
      const state = await store.read();
      expect(state?.phase).toBe("quiesced");
      expect(state?.sourceReplaced).toBe(false);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
