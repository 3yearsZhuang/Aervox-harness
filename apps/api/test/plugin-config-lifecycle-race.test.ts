import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteExtensionRepository, SqlitePluginConfigRepository, SqlitePluginSecretRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

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
