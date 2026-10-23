import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, DomainConflictError, SqliteExtensionRepository, SqlitePluginConfigRepository, SqlitePluginPageRepository } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("plugin configuration lifecycle transaction", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let extension: SqliteExtensionRepository;
  let configs: SqlitePluginConfigRepository;
  const id = "config-generation";
  const fields = [{ key: "label", type: "string", label: "Label" }, { key: "token", type: "secret", label: "Token" }];
  let generation: string;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    extension = new SqliteExtensionRepository(database.db);
    configs = new SqlitePluginConfigRepository(database.db);
    const plugin = await extension.createPlugin({ id, publisher: "test", version: "1", checksum: "fixture", configSchemaJson: fields });
    generation = plugin.lifecycleGeneration;
    await configs.saveConfig(ctx, {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
      expectedRevision: 0, values: { label: "saved" }, secretKeys: [], secretChanges: { token: "keep secret" },
    });
  });
  afterEach(async () => { await database.cleanup(); });
  const state = async () => ({
    config: await configs.getConfig(ctx, id),
    secrets: (await database.client.execute({ sql: "SELECT * FROM plugin_config_secrets WHERE plugin_id = ?", args: [id] })).rows,
  });

  const pageInput = (expectedPageId: unknown = "settings") => ({
    pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
    expectedRevision: 1, expectedPageId: expectedPageId as string,
    values: { label: "from page" }, secretKeys: [], secretChanges: { token: "page secret" },
  });
  async function registerPage(capabilities: unknown = ["config.write"]): Promise<void> {
    await new SqlitePluginPageRepository(database.db).upsertPage({
      pluginId: id, pageId: "settings", title: "Settings", entry: "pages/settings/index.html",
      capabilities: Array.isArray(capabilities) ? capabilities : [],
    });
    if (!Array.isArray(capabilities)) {
      await database.client.execute({ sql: "UPDATE plugin_pages SET capabilities_json = ? WHERE plugin_id = ? AND page_id = ?",
        args: [JSON.stringify(capabilities), id, "settings"] });
    }
  }

  it.each(["removed", "missing", "other-plugin", "read-only", "unknown", "string", "object", "null"] as const)(
    "refuses a Page save with %s capability state before config or Secret writes", async change => {
      await registerPage();
      if (change === "missing" || change === "other-plugin") {
        const pages = new SqlitePluginPageRepository(database.db);
        await pages.deletePagesForPlugin(id);
        if (change === "other-plugin") {
          await extension.createPlugin({ id: "other", publisher: "test", version: "1", checksum: "other" });
          await pages.upsertPage({ pluginId: "other", pageId: "settings", title: "Other", entry: "pages/settings/index.html", capabilities: ["config.write"] });
        }
      } else {
        const capabilities = change === "removed" ? [] : change === "read-only" ? ["config.read"] : change === "unknown" ? ["config.write", "unknown"]
          : change === "string" ? "config.write" : change === "object" ? { capability: "config.write" } : null;
        await registerPage(capabilities);
      }
      const before = await state();
      expect((await configs.saveConfig(ctx, pageInput())).conflict).toBe(true);
      expect(await state()).toEqual(before);
    },
  );

  it.each(["", "nested/page", "x".repeat(65), null])("refuses an invalid Page id %j before config or Secret writes", async pageId => {
    await registerPage();
    const before = await state();
    expect((await configs.saveConfig(ctx, pageInput(pageId))).conflict).toBe(true);
    expect(await state()).toEqual(before);
  });

  it("accepts an authorized Page save and preserves ordinary management saves after Page capability removal", async () => {
    await registerPage();
    const accepted = await configs.saveConfig(ctx, pageInput());
    expect(accepted.conflict).toBe(false);
    expect(accepted.saved).toMatchObject({ revision: 2, valuesJson: { label: "from page" }, secretKeysJson: ["token"] });
    await registerPage([]);
    const { expectedPageId: _pageId, ...management } = pageInput();
    const saved = await configs.saveConfig(ctx, { ...management, expectedRevision: 2, values: { label: "management" } });
    expect(saved.conflict).toBe(false);
    expect(saved.saved).toMatchObject({ revision: 3, valuesJson: { label: "management" } });
  });

  it.each(["disabled", "reenabled", "missing", "restored", "schema-version"] as const)("rejects stale save and reset for %s before Secret changes", async (transition) => {
    const before = await state();
    if (transition === "disabled" || transition === "reenabled") {
      await extension.setPluginEnabled(id, false);
      if (transition === "reenabled") await extension.setPluginEnabled(id, true);
    } else if (transition === "missing" || transition === "restored") {
      await extension.setPluginAvailability(id, "missing");
      if (transition === "restored") await extension.setPluginAvailability(id, "available");
    } else {
      await extension.setPluginConfigSchema(id, fields, 2);
    }
    const result = await configs.saveConfig(ctx, {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
      expectedRevision: 1, values: { label: "stale" }, secretKeys: [], secretChanges: { token: null },
    });
    expect(result.conflict).toBe(true);
    await expect(configs.resetConfig(ctx, id, 1, {}, fields, generation, 1)).rejects.toBeInstanceOf(DomainConflictError);
    expect(await state()).toEqual(before);
  });

  it("permits a newly captured generation after restoration", async () => {
    await extension.setPluginEnabled(id, false);
    const restored = await extension.setPluginEnabled(id, true);
    const result = await configs.saveConfig(ctx, {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: restored!.lifecycleGeneration,
      expectedRevision: 1, values: { label: "current" }, secretKeys: [], secretChanges: { token: "new secret" },
    });
    expect(result.conflict).toBe(false);
    expect(result.saved?.revision).toBe(2);
    expect((await configs.resetConfig(ctx, id, 1, { label: "default" }, fields, restored!.lifecycleGeneration, 2)).revision).toBe(3);
    expect((await state()).secrets).toEqual([]);
  });

  it("checks reset's captured revision before deleting Secrets", async () => {
    await configs.saveConfig(ctx, {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
      expectedRevision: 1, values: { label: "concurrent" }, secretKeys: [], secretChanges: { token: "concurrent secret" },
    });
    const before = await state();
    await expect(configs.resetConfig(ctx, id, 1, {}, fields, generation, 1)).rejects.toBeInstanceOf(DomainConflictError);
    expect(await state()).toEqual(before);
    expect((await configs.resetConfig(ctx, id, 1, {}, fields, generation, 2)).revision).toBe(3);
    expect((await state()).secrets).toEqual([]);
  });

  describe.each(["expectedSchema", "expectedLifecycleGeneration", "expectedRevision"] as const)("required %s", (missing) => {
    it.each([undefined, null])("rejects a JavaScript save/reset with %s before any Secret mutation", async (invalid) => {
      const before = await state();
      const input: Record<string, unknown> = {
        pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
        expectedRevision: 1, values: { label: "unqualified" }, secretKeys: [], secretChanges: { token: null },
      };
      if (invalid === undefined) delete input[missing];
      else input[missing] = invalid;
      // Deliberately bypass TypeScript to exercise an older JavaScript caller at runtime.
      const result = await configs.saveConfig(ctx, input as unknown as Parameters<SqlitePluginConfigRepository["saveConfig"]>[1]);
      expect(result.conflict).toBe(true);
      await expect(configs.resetConfig(ctx, id, 1, {}, input.expectedSchema,
        input.expectedLifecycleGeneration as string, input.expectedRevision as number)).rejects.toBeInstanceOf(DomainConflictError);
      expect(await state()).toEqual(before);
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.NaN, 1.5])("refuses an invalid revision %s before any Secret mutation", async (revision) => {
    const before = await state();
    const result = await configs.saveConfig(ctx, {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
      expectedRevision: revision, values: { label: "invalid revision" }, secretKeys: [], secretChanges: { token: null },
    });
    expect(result.conflict).toBe(true);
    await expect(configs.resetConfig(ctx, id, 1, {}, fields, generation, revision)).rejects.toBeInstanceOf(DomainConflictError);
    expect(await state()).toEqual(before);
  });

  it("refuses unconditional revision writes and writes for an absent plugin", async () => {
    const before = await state();
    const input = {
      pluginId: id, schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generation,
      expectedRevision: -1, values: { label: "unconditional" }, secretKeys: [], secretChanges: { token: null },
    };
    expect((await configs.saveConfig(ctx, input)).conflict).toBe(true);
    await expect(configs.resetConfig(ctx, id, 1, {}, fields, generation, -1)).rejects.toBeInstanceOf(DomainConflictError);
    expect((await configs.saveConfig(ctx, { ...input, pluginId: "absent", expectedRevision: 0 })).conflict).toBe(true);
    await expect(configs.resetConfig(ctx, "absent", 1, {}, fields, generation, 0)).rejects.toBeInstanceOf(DomainConflictError);
    expect(await configs.getConfig(ctx, "absent")).toBeNull();
    expect(await state()).toEqual(before);
  });

  it("applies lifecycle and revision checks before the first save or reset creates any rows", async () => {
    const fresh = await extension.createPlugin({ id: "fresh", publisher: "test", version: "1", checksum: "fixture", configSchemaJson: fields });
    await extension.setPluginEnabled("fresh", false);
    const active = await extension.setPluginEnabled("fresh", true);
    const input = {
      pluginId: "fresh", schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: fresh.lifecycleGeneration,
      expectedRevision: 0, values: { label: "stale initial" }, secretKeys: [], secretChanges: { token: "stale secret" },
    };
    expect((await configs.saveConfig(ctx, input)).conflict).toBe(true);
    await expect(configs.resetConfig(ctx, "fresh", 1, {}, fields, fresh.lifecycleGeneration, 0)).rejects.toBeInstanceOf(DomainConflictError);
    expect((await configs.saveConfig(ctx, { ...input, expectedLifecycleGeneration: active!.lifecycleGeneration, expectedRevision: 1 })).conflict).toBe(true);
    await expect(configs.resetConfig(ctx, "fresh", 1, {}, fields, active!.lifecycleGeneration, 1)).rejects.toBeInstanceOf(DomainConflictError);
    expect(await configs.getConfig(ctx, "fresh")).toBeNull();
    expect((await database.client.execute("SELECT * FROM plugin_config_secrets WHERE plugin_id = 'fresh'")).rows).toEqual([]);
    expect((await configs.resetConfig(ctx, "fresh", 1, { label: "initial" }, fields, active!.lifecycleGeneration, 0)).revision).toBe(1);
  });
});
