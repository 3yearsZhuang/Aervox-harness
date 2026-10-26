import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteExtensionRepository, SqlitePluginConfigRepository, SqlitePluginSecretRepository, SqlitePluginPageRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import { PluginConfigService } from "@aervox/host-runtime-test/modules/ecosystem/plugins/config-service";

describe("configuration lifecycle checks at the writer transaction", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let extension: SqliteExtensionRepository;
  const id = "config-lifecycle-race";
  const fields = [{ key: "label", label: "Label", type: "string", default: "initial" },
    { key: "token", label: "Token", type: "secret" }];

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    ({ app } = await buildApp({ db: database.db, client: database.client }));
    await app.ready();
    extension = new SqliteExtensionRepository(database.db);
    await extension.createPlugin({ id, publisher: "test", version: "1.0.0", checksum: "fixture", configSchemaJson: fields });
    const seed = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 0, values: { label: "saved" }, secretValues: { token: "keep secret" },
    } });
    expect(seed.statusCode).toBe(200);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await database.cleanup();
  });

  const state = async () => ({
    config: (await database.client.execute({ sql: "SELECT * FROM plugin_configs WHERE plugin_id = ?", args: [id] })).rows,
    secrets: (await database.client.execute({ sql: "SELECT * FROM plugin_config_secrets WHERE plugin_id = ?", args: [id] })).rows,
    audits: (await database.client.execute({ sql: "SELECT * FROM audit_records WHERE subject_id = ?", args: [id] })).rows,
  });

  async function registerPage(capabilities: unknown = ["config.write"]): Promise<string> {
    const saved = await new SqlitePluginPageRepository(database.db).upsertPage({
      pluginId: id, pageId: "settings", title: "Settings", entry: "pages/settings/index.html",
      capabilities: Array.isArray(capabilities) ? capabilities : [],
    });
    if (!Array.isArray(capabilities)) {
      await database.client.execute({ sql: "UPDATE plugin_pages SET capabilities_json = ? WHERE plugin_id = ? AND page_id = ?",
        args: [JSON.stringify(capabilities), id, "settings"] });
    }
    return saved.id;
  }

  it.each(["removed", "missing", "other-plugin", "read-only", "unknown", "string", "object", "null", "reregistered", "reauthorized", "recreated"] as const)(
    "refuses a Page save when %s changes after admission without config, Secret or audit mutations", async change => {
      const pageGeneration = await registerPage();
      const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
      const before = await state();
      const original = SqlitePluginConfigRepository.prototype.saveConfig;
      vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
        if (change === "missing" || change === "other-plugin" || change === "recreated") {
          const pages = new SqlitePluginPageRepository(database.db);
          await pages.deletePagesForPlugin(id);
          if (change === "other-plugin") {
            await extension.createPlugin({ id: "other", publisher: "test", version: "1", checksum: "other" });
            await pages.upsertPage({ pluginId: "other", pageId: "settings", title: "Other", entry: "pages/settings/index.html", capabilities: ["config.write"] });
          }
          if (change === "recreated") await registerPage();
        } else if (change === "reregistered" || change === "reauthorized") {
          if (change === "reauthorized") await registerPage([]);
          await registerPage();
        } else {
          const capabilities = change === "removed" ? [] : change === "read-only" ? ["config.read"] : change === "unknown" ? ["config.write", "unknown"]
            : change === "string" ? "config.write" : change === "object" ? { capability: "config.write" } : null;
          await registerPage(capabilities);
        }
        return original.apply(this, args);
      });
      const response = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
        revision: 1, expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration,
        values: { label: "revoked page" }, secretValues: { token: "revoked page secret" },
      } });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
      expect(await state()).toEqual(before);
      expect((await extension.getPlugin(id))!.lifecycleGeneration).toBe(generation);
    },
  );

  it("returns a host-owned Page generation on registration and listing, and accepts a freshly captured Page save", async () => {
    const url = `/v1/plugins/${id}/pages`;
    const declaration = { id: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["config.write"], pageGeneration: "forged" };
    const initial = await app.inject({ method: "POST", url, payload: declaration });
    expect(initial.statusCode).toBe(201);
    const first = initial.json().pageGeneration;
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe("forged");
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const second = await app.inject({ method: "POST", url, payload: declaration });
    expect(second.statusCode).toBe(201);
    const current = second.json().pageGeneration;
    expect(current).not.toBe(first);
    const listed = await app.inject({ method: "GET", url });
    expect(listed.json().pages[0]).toMatchObject({ id: "settings", pageGeneration: current });
    const before = await state();
    const payload = { revision: 1, expectedLifecycleGeneration: generation, expectedPageId: "settings", values: { label: "new Page" }, secretValues: { token: null } };
    const rejected = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: { ...payload, expectedPageGeneration: first } });
    expect(rejected.statusCode).toBe(409);
    expect(await state()).toEqual(before);
    const accepted = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: { ...payload, expectedPageGeneration: current } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ revision: 2, values: { label: "new Page" }, secretFields: { token: { configured: false } } });
  });

  it.each([undefined, "", null, 5, "x".repeat(129)])("rejects a direct service Page save with invalid Page generation %j before entering the writer", async expectedPageGeneration => {
    await registerPage();
    let service: PluginConfigService | undefined;
    const original = PluginConfigService.prototype.getConfig;
    vi.spyOn(PluginConfigService.prototype, "getConfig").mockImplementationOnce(function (...args) {
      service = this;
      return original.apply(this, args);
    });
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    const writer = vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig");
    const before = await state();
    const input = { revision: 1, expectedLifecycleGeneration: (await extension.getPlugin(id))!.lifecycleGeneration, expectedPageId: "settings", expectedPageGeneration,
      values: { label: "invalid generation" }, secretValues: { token: null } };
    await expect(service!.saveConfig({ workspaceId: "local", subjectUserId: "local" }, id,
      input as Parameters<PluginConfigService["saveConfig"]>[2])).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
    expect(writer).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it.each(["missing-generation", "", "nested/page", "x".repeat(65), null])(
    "rejects an invalid Page identity %j before entering the config writer", async identity => {
      const pageGeneration = await registerPage();
      const before = await state();
      const writer = vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig");
      const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
      const response = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
        revision: 1,
        ...(identity === "missing-generation" ? {} : { expectedLifecycleGeneration: generation }),
        expectedPageId: identity === "missing-generation" ? "settings" : identity, expectedPageGeneration: pageGeneration,
        values: { label: "invalid page" }, secretValues: { token: null },
      } });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_CONFIG");
      expect(writer).not.toHaveBeenCalled();
      expect(await state()).toEqual(before);
    },
  );

  it("commits an authorized Page save and preserves ordinary management writes without Page authority", async () => {
    const pageGeneration = await registerPage();
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const accepted = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 1, expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration,
      values: { label: "accepted page" }, secretValues: { token: "accepted page secret" },
    } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ revision: 2, values: { label: "accepted page" }, secretFields: { token: { configured: true } } });
    await registerPage([]);
    const managed = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 2, values: { label: "management" }, secretValues: { token: null },
    } });
    expect(managed.statusCode).toBe(200);
    expect(managed.json()).toMatchObject({ revision: 3, values: { label: "management" }, secretFields: { token: { configured: false } } });
  });

  it("refuses a direct service Page save without the caller's captured generation before any writer call", async () => {
    const pageGeneration = await registerPage();
    let service: PluginConfigService | undefined;
    const original = PluginConfigService.prototype.getConfig;
    vi.spyOn(PluginConfigService.prototype, "getConfig").mockImplementationOnce(function (...args) {
      service = this;
      return original.apply(this, args);
    });
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    expect(service).toBeDefined();
    const writer = vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig");
    const before = await state();
    await expect(service!.saveConfig({ workspaceId: "local", subjectUserId: "local" }, id, {
      revision: 1, expectedPageId: "settings", expectedPageGeneration: pageGeneration, values: { label: "no caller identity" }, secretValues: { token: null },
    })).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
    expect(writer).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("preserves an accepted Page save receipt when capability removal follows the commit, then rejects further Page saves", async () => {
    const pageGeneration = await registerPage();
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const original = SqlitePluginConfigRepository.prototype.saveConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
      const result = await original.apply(this, args);
      await registerPage([]);
      return result;
    });
    const accepted = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 1, expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration,
      values: { label: "committed page" }, secretValues: { token: "committed page secret" },
    } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ revision: 2, values: { label: "committed page" }, secretFields: { token: { configured: true } } });
    const beforeRetry = await state();
    const rejected = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 2, expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration,
      values: { label: "after revoke" }, secretValues: { token: null },
    } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    expect(await state()).toEqual(beforeRetry);
  });

  const pageQuery = (generation: string, pageGeneration: string) => new URLSearchParams({
    expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration,
  }).toString();

  describe.each(["read", "reset"] as const)("Page HTTP %s", operation => {
    it.each(["removed", "missing", "other-plugin", "wrong-capability", "malformed", "reregistered", "reauthorized", "recreated"] as const)("rejects %s after admission without disclosing or mutating configuration", async change => {
      const pageGeneration = await registerPage(["config.read", "config.write"]);
      const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
      const before = await state();
      async function revoke(): Promise<void> {
        if (change === "missing" || change === "other-plugin" || change === "recreated") {
          const pages = new SqlitePluginPageRepository(database.db);
          await pages.deletePagesForPlugin(id);
          if (change === "other-plugin") {
            await extension.createPlugin({ id: "other", publisher: "test", version: "1", checksum: "other" });
            await pages.upsertPage({ pluginId: "other", pageId: "settings", title: "Other", entry: "pages/settings/index.html", capabilities: ["config.read", "config.write"] });
          }
          if (change === "recreated") await registerPage(["config.read", "config.write"]);
        } else if (change === "reregistered" || change === "reauthorized") {
          if (change === "reauthorized") await registerPage([]);
          await registerPage(["config.read", "config.write"]);
        } else await registerPage(change === "removed" ? [] : change === "malformed" ? { capability: "config.read" }
          : operation === "read" ? ["config.write"] : ["config.read"]);
      }
      if (operation === "read") {
        const original = SqlitePluginConfigRepository.prototype.getConfig;
        vi.spyOn(SqlitePluginConfigRepository.prototype, "getConfig").mockImplementationOnce(async function (...args) {
          await revoke();
          return original.apply(this, args);
        });
      } else {
        const original = SqlitePluginConfigRepository.prototype.resetConfig;
        vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig").mockImplementationOnce(async function (...args) {
          await revoke();
          return original.apply(this, args);
        });
      }
      const response = await app.inject({ method: operation === "read" ? "GET" : "POST",
        url: `/v1/plugins/${id}/config${operation === "reset" ? "/reset" : ""}?${pageQuery(generation, pageGeneration)}` });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
      expect(response.body).not.toContain('"saved"');
      expect(await state()).toEqual(before);
    });

    it("rejects incomplete Page identity before configuration I/O", async () => {
      const pageGeneration = await registerPage(["config.read", "config.write"]);
      const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
      const before = await state();
      const query = { expectedLifecycleGeneration: generation, expectedPageId: "settings", expectedPageGeneration: pageGeneration };
      for (const key of Object.keys(query)) {
        const incomplete = { ...query };
        delete incomplete[key as keyof typeof incomplete];
        const response = await app.inject({ method: operation === "read" ? "GET" : "POST",
          url: `/v1/plugins/${id}/config${operation === "reset" ? "/reset" : ""}?${new URLSearchParams(incomplete)}` });
        expect(response.statusCode).toBe(400);
      }
      expect(await state()).toEqual(before);
    });
  });

  it.each(["page-generation", "read-capability", "plugin-generation", "schema"] as const)("rechecks %s after awaiting Secret state before releasing a Page configuration response", async phase => {
    const pageGeneration = await registerPage(["config.read", "config.write"]);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const before = await state();
    const original = SqlitePluginSecretRepository.prototype.listStates;
    vi.spyOn(SqlitePluginSecretRepository.prototype, "listStates").mockImplementationOnce(async function (...args) {
      const result = await original.apply(this, args);
      if (phase === "plugin-generation") { await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true); }
      else if (phase === "schema") await extension.setPluginConfigSchema(id, [...fields, { key: "new", label: "New", type: "string" }], 2);
      else if (phase === "read-capability") {
        await database.client.execute({ sql: "UPDATE plugin_pages SET capabilities_json = ? WHERE plugin_id = ?", args: [JSON.stringify(["config.write"]), id] });
      } else await registerPage(["config.read", "config.write"]);
      return result;
    });
    const response = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config?${pageQuery(generation, pageGeneration)}` });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('"saved"');
    expect(response.body).not.toContain('"configured"');
    expect(await state()).toEqual(before);
  });

  it("serves current Page reads without caching and resets only with current write authority", async () => {
    const pageGeneration = await registerPage(["config.read", "config.write"]);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const query = pageQuery(generation, pageGeneration);
    const read = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config?${query}` });
    expect(read.statusCode).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({ revision: 1, values: { label: "saved" }, secretFields: { token: { configured: true } } });
    const reset = await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset?${query}` });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ revision: 2, values: { label: "initial" }, secretFields: { token: { configured: false } } });
    await registerPage([]);
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset` })).statusCode).toBe(200);
  });

  it("returns defaults only for an authorized Page when no configuration exists", async () => {
    const pageGeneration = await registerPage(["config.read", "config.write"]);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    await database.client.execute({ sql: "DELETE FROM plugin_config_secrets WHERE plugin_id = ?", args: [id] });
    await database.client.execute({ sql: "DELETE FROM plugin_configs WHERE plugin_id = ?", args: [id] });
    const url = `/v1/plugins/${id}/config?${pageQuery(generation, pageGeneration)}`;
    const current = await app.inject({ method: "GET", url });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ revision: 0, values: { label: "initial" }, secretFields: { token: { configured: false } } });
    await registerPage([]);
    const revoked = await app.inject({ method: "GET", url });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.body).not.toContain('"initial"');
    expect(revoked.body).not.toContain('"configured"');
  });

  it.each(["read", "reset"] as const)("rejects malformed direct-service Page %s identities before configuration access", async operation => {
    const pageGeneration = await registerPage(["config.read", "config.write"]);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    let service: PluginConfigService | undefined;
    const original = PluginConfigService.prototype.getConfig;
    vi.spyOn(PluginConfigService.prototype, "getConfig").mockImplementationOnce(function (...args) {
      service = this;
      return original.apply(this, args);
    });
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    const reader = vi.spyOn(SqlitePluginConfigRepository.prototype, "getConfig");
    const writer = vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig");
    const before = await state();
    for (const identity of [
      { expectedPageId: "settings" }, { expectedPageGeneration: pageGeneration },
      { expectedPageId: "nested/page", expectedPageGeneration: pageGeneration },
      { expectedPageId: "settings", expectedPageGeneration: "" },
    ]) {
      const result = operation === "read" ? service!.getConfig({ workspaceId: "local", subjectUserId: "local" }, id, generation, identity)
        : service!.resetConfig({ workspaceId: "local", subjectUserId: "local" }, id, generation, identity);
      await expect(result).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
    }
    const identity = { expectedPageId: "settings", expectedPageGeneration: pageGeneration };
    const missingLifecycle = operation === "read" ? service!.getConfig({ workspaceId: "local", subjectUserId: "local" }, id, undefined, identity)
      : service!.resetConfig({ workspaceId: "local", subjectUserId: "local" }, id, undefined, identity);
    await expect(missingLifecycle).rejects.toMatchObject({ status: 400, code: "INVALID_CONFIG" });
    expect(reader).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });

  it("preserves a committed reset receipt when Page authority changes after commit", async () => {
    const pageGeneration = await registerPage(["config.read", "config.write"]);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const original = SqlitePluginConfigRepository.prototype.resetConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig").mockImplementationOnce(async function (...args) {
      const result = await original.apply(this, args);
      await registerPage([]);
      return result;
    });
    const accepted = await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset?${pageQuery(generation, pageGeneration)}` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ revision: 2, secretFields: { token: { configured: false } } });
  });

  const transitions = ["disabled", "reenabled", "missing", "restored", "schema-version"] as const;
  async function transition(change: typeof transitions[number]): Promise<void> {
    if (change === "disabled" || change === "reenabled") {
      await extension.setPluginEnabled(id, false);
      if (change === "reenabled") await extension.setPluginEnabled(id, true);
    } else if (change === "missing" || change === "restored") {
      await extension.setPluginAvailability(id, "missing");
      if (change === "restored") await extension.setPluginAvailability(id, "available");
    } else {
      await extension.setPluginConfigSchema(id, fields, 2);
    }
  }

  it.each(["disabled", "reenabled", "missing", "restored"] as const)("rechecks Page grants in the same read snapshot after %s during admission", async change => {
    const pages = new SqlitePluginPageRepository(database.db);
    await pages.upsertPage({ pluginId: id, pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["host.notify", "host.close"] });
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const before = await state();
    const original = SqlitePluginPageRepository.prototype.listPages;
    vi.spyOn(SqlitePluginPageRepository.prototype, "listPages").mockImplementationOnce(async function (...args) {
      await transition(change);
      return original.apply(this, args);
    });
    const response = await app.inject({ method: "GET", url: `/v1/plugins/${id}/pages?expectedLifecycleGeneration=${generation}` });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    expect(JSON.stringify(response.json())).not.toContain('"capabilities"');
    expect(await state()).toEqual(before);
  });

  it("serves only current Page capabilities, preserves nullable metadata and disables response caching", async () => {
    const pages = new SqlitePluginPageRepository(database.db);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const url = `/v1/plugins/${id}/pages?expectedLifecycleGeneration=${generation}`;
    expect((await app.inject({ method: "GET", url })).json()).toEqual({ pages: [] });
    await pages.upsertPage({ pluginId: id, pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["host.notify"] });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().pages[0]).toMatchObject({ capabilities: ["host.notify"], description: null, checksum: null });
    await pages.upsertPage({ pluginId: id, pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: [] });
    expect((await app.inject({ method: "GET", url })).json().pages[0].capabilities).toEqual([]);
    const ordinary = await app.inject({ method: "GET", url: `/v1/plugins/${id}/pages` });
    expect(ordinary.statusCode).toBe(200);
    for (const query of ['expectedLifecycleGeneration=', 'expectedLifecycleGeneration=' + 'x'.repeat(129), 'expectedLifecycleGeneration=a&expectedLifecycleGeneration=b']) {
      const invalid = await app.inject({ method: "GET", url: `/v1/plugins/${id}/pages?${query}` });
      expect(invalid.statusCode).toBe(400);
    }
  });

  describe.each(["save", "reset"] as const)("%s", (operation) => {
    it.each(transitions)("rejects %s after validation without changing configuration, Secrets or audit", async (change) => {
      const before = await state();
      if (operation === "save") {
        const original = SqlitePluginConfigRepository.prototype.saveConfig;
        vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
          await transition(change);
          return original.apply(this, args);
        });
      } else {
        const original = SqlitePluginConfigRepository.prototype.resetConfig;
        vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig").mockImplementationOnce(async function (...args) {
          await transition(change);
          return original.apply(this, args);
        });
      }
      const response = operation === "save"
        ? await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
          revision: 1, values: { label: "stale" }, secretValues: { token: "stale secret" },
        } })
        : await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset` });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
      expect(await state()).toEqual(before);
    });
  });

  it.each(["missing", "invalid", "unreadable"] as const)("refuses configuration writes while %s and preserves data-management reads", async (availability) => {
    await extension.setPluginAvailability(id, availability);
    const before = await state();
    for (const request of [
      { method: "PUT" as const, url: `/v1/plugins/${id}/config`, payload: { revision: 1, values: { label: "late" } } },
      { method: "POST" as const, url: `/v1/plugins/${id}/config/reset` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PLUGIN_UNAVAILABLE");
    }
    expect(await state()).toEqual(before);
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const pageRead = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config?expectedLifecycleGeneration=${generation}` });
    expect(pageRead.statusCode).toBe(409);
    expect(pageRead.json().code).toBe("PLUGIN_UNAVAILABLE");
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config/schema` })).statusCode).toBe(200);
  });

  it("rejects an old window's reads, saves and resets after disable/re-enable, while current and ordinary requests succeed", async () => {
    const oldGeneration = (await extension.getPlugin(id))!.lifecycleGeneration;
    await extension.setPluginEnabled(id, false);
    const current = await extension.setPluginEnabled(id, true);
    const before = await state();
    const oldQuery = `?expectedLifecycleGeneration=${oldGeneration}`;
    for (const request of [
      { method: "GET" as const, url: `/v1/plugins/${id}/config${oldQuery}` },
      { method: "PUT" as const, url: `/v1/plugins/${id}/config`, payload: {
        revision: 1, expectedLifecycleGeneration: oldGeneration, values: { label: "old window" }, secretValues: { token: null },
      } },
      { method: "POST" as const, url: `/v1/plugins/${id}/config/reset${oldQuery}` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    }
    expect(await state()).toEqual(before);
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(200);
    const query = `?expectedLifecycleGeneration=${current!.lifecycleGeneration}`;
    expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config${query}` })).statusCode).toBe(200);
    const saved = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 1, expectedLifecycleGeneration: current!.lifecycleGeneration, values: { label: "new window" },
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(2);
    const reset = await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset${query}` });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().revision).toBe(3);
  });

  it.each(["configuration", "secret-state"] as const)("rechecks the Page generation after awaiting %s before returning a snapshot", async (phase) => {
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const before = await state();
    if (phase === "configuration") {
      const original = SqlitePluginConfigRepository.prototype.getConfig;
      vi.spyOn(SqlitePluginConfigRepository.prototype, "getConfig").mockImplementationOnce(async function (...args) {
        const result = await original.apply(this, args);
        await transition("reenabled");
        return result;
      });
    } else {
      const original = SqlitePluginSecretRepository.prototype.listStates;
      vi.spyOn(SqlitePluginSecretRepository.prototype, "listStates").mockImplementationOnce(async function (...args) {
        const result = await original.apply(this, args);
        await transition("reenabled");
        return result;
      });
    }
    const response = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config?expectedLifecycleGeneration=${generation}` });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    expect(await state()).toEqual(before);
  });

  it("rejects a reset when a concurrent save changed the revision after the reset snapshot", async () => {
    const original = SqlitePluginConfigRepository.prototype.resetConfig;
    let concurrent: Awaited<ReturnType<typeof state>>;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig").mockImplementationOnce(async function (...args) {
      const saved = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
        revision: 1, values: { label: "concurrent" }, secretValues: { token: "concurrent secret" },
      } });
      expect(saved.statusCode).toBe(200);
      concurrent = await state();
      return original.apply(this, args);
    });
    const response = await app.inject({ method: "POST", url: `/v1/plugins/${id}/config/reset` });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    expect(await state()).toEqual(concurrent!);
  });

  it("returns the accepted save receipt when lifecycle changes after the writer transaction committed", async () => {
    const generation = (await extension.getPlugin(id))!.lifecycleGeneration;
    const original = SqlitePluginConfigRepository.prototype.saveConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
      const result = await original.apply(this, args);
      await transition("reenabled");
      return result;
    });
    const response = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 1, expectedLifecycleGeneration: generation, values: { label: "accepted" }, secretValues: { token: "accepted secret" },
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revision: 2, values: { label: "accepted" }, secretFields: { token: { configured: true } } });
    const stored = new SqlitePluginConfigRepository(database.db);
    expect(await stored.getConfig({ workspaceId: "local", subjectUserId: "local" }, id)).toMatchObject({ revision: 2, valuesJson: { label: "accepted" } });
  });
});
