import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteExtensionRepository } from "../src/index.js";

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

  it("backfills a pre-generation database once without replacing existing plugin data", async () => {
    await extensions.createPlugin({ id: "legacy", publisher: "test", version: "1", checksum: "legacy-checksum" });
    await database.client.execute("ALTER TABLE plugins DROP COLUMN lifecycle_generation");
    await initDatabaseSchema(database.client);
    const upgraded = (await extensions.getPlugin("legacy"))!;
    expect(upgraded.lifecycleGeneration).toMatch(/^[a-f0-9]{32}$/);
    expect(upgraded.checksum).toBe("legacy-checksum");
    await initDatabaseSchema(database.client);
    expect((await extensions.getPlugin("legacy"))!.lifecycleGeneration).toBe(upgraded.lifecycleGeneration);
  });
});
