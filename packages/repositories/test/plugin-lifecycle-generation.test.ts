import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteExtensionRepository } from "../src/index.js";
import { exportSnapshot, restoreSnapshotToEmptyStaging } from "../src/sync/git-snapshot.js";

describe("persistent plugin lifecycle generations", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let extensions: SqliteExtensionRepository;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    extensions = new SqliteExtensionRepository(database.db);
  });
  afterEach(async () => { vi.useRealTimers(); await database.cleanup(); });

  it("changes on every off/on transition even with a frozen wall clock, but not on unchanged state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
    const initial = await extensions.createPlugin({ id: "probe", publisher: "test", version: "1", checksum: "test" });
    const off = await extensions.setPluginEnabled("probe", false);
    const on = await extensions.setPluginEnabled("probe", true);
    expect(initial.updatedAt).toBe(on!.updatedAt);
    expect(new Set([initial.lifecycleGeneration, off!.lifecycleGeneration, on!.lifecycleGeneration]).size).toBe(3);
    const unchanged = await extensions.setPluginEnabled("probe", true);
    await extensions.setPluginAvailability("probe", "available");
    expect(unchanged!.lifecycleGeneration).toBe(on!.lifecycleGeneration);
    expect((await extensions.getPlugin("probe"))!.lifecycleGeneration).toBe(on!.lifecycleGeneration);
    await extensions.setPluginAvailability("probe", "missing");
    const missing = (await extensions.getPlugin("probe"))!;
    await extensions.setPluginAvailability("probe", "available");
    const restored = (await extensions.getPlugin("probe"))!;
    expect(new Set([on!.lifecycleGeneration, missing.lifecycleGeneration, restored.lifecycleGeneration]).size).toBe(3);
  });

  it("does not reuse an identity when replaced or deleted and reinstalled", async () => {
    const input = { id: "probe", publisher: "test", version: "1", checksum: "test" };
    const initial = await extensions.createPlugin(input);
    const replaced = await extensions.createPlugin(input);
    await extensions.deletePlugin("probe");
    const reinstalled = await extensions.createPlugin(input);
    expect(new Set([initial.lifecycleGeneration, replaced.lifecycleGeneration, reinstalled.lifecycleGeneration]).size).toBe(3);
  });

  it("requires staging for a pre-generation database and preserves plugin data during the explicit upgrade", async () => {
    await extensions.createPlugin({ id: "legacy", publisher: "test", version: "1", checksum: "legacy-checksum" });
    await database.client.execute("ALTER TABLE plugins DROP COLUMN lifecycle_generation");
    const original = await database.client.execute("SELECT * FROM plugins");
    await expect(initDatabaseSchema(database.client)).rejects.toThrow("explicit staging migration");
    expect((await database.client.execute("SELECT * FROM plugins")).rows).toEqual(original.rows);
    const staging = await createInMemoryDatabase();
    try {
      await restoreSnapshotToEmptyStaging(staging.client, await exportSnapshot(database.client, 1));
      const upgradedRepository = new SqliteExtensionRepository(staging.db);
      const upgraded = (await upgradedRepository.getPlugin("legacy"))!;
      expect(upgraded.lifecycleGeneration).toMatch(/^[a-f0-9]{32}$/);
      expect(upgraded.checksum).toBe("legacy-checksum");
      await initDatabaseSchema(staging.client);
      expect((await upgradedRepository.getPlugin("legacy"))!.lifecycleGeneration).toBe(upgraded.lifecycleGeneration);
    } finally { await staging.cleanup(); }
  });
});
