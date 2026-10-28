import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import {
  createInMemoryDatabase, SqliteExtensionRepository, SqlitePluginConfigRepository,
  SqlitePluginSecretRepository, SqlitePluginPageRepository, SqlitePlatformRepository,
} from "@aervox/repositories";
import type { PluginConfigurationPort } from "@aervox/host-plugin-api";
import {
  createPluginHostServicesFactory, PluginConfigurationConflictError,
} from "@aervox/host-runtime-test/plugin-host-services";
import { PluginConfigService } from "@aervox/host-runtime-test/modules/ecosystem/plugins/config-service";
import { PluginBundleStore } from "@aervox/host-runtime-test/modules/ecosystem/plugins/bundle-store";
import { mountPluginHttpEndpoints } from "@aervox/host-runtime-test/plugin-assembly";

const ctx = { workspaceId: "local", subjectUserId: "local" };
const fields = [{ key: "places", type: "array", label: "Places", items: {
  key: "entry", type: "object", label: "Place", required: true,
  children: [{ key: "name", type: "string", label: "Name", required: true },
    { key: "days", type: "array", label: "Days", items: { key: "day", type: "integer", label: "Day", required: true } }],
} }, { key: "token", type: "secret", label: "Token" }];

describe("host-bound plugin configuration port", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let extension: SqliteExtensionRepository;
  let service: PluginConfigService;
  let generation: string;
  const id = "configuration-port";

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    extension = new SqliteExtensionRepository(database.db);
    generation = (await extension.createPlugin({ id, publisher: "test", version: "1", checksum: "test", configSchemaJson: fields })).lifecycleGeneration!;
    service = new PluginConfigService({ extensionRepo: extension,
      configRepo: new SqlitePluginConfigRepository(database.db), secretRepo: new SqlitePluginSecretRepository(database.db),
      pageRepo: new SqlitePluginPageRepository(database.db), auditRepo: new SqlitePlatformRepository(database.db),
      bundleStore: new PluginBundleStore(path.join(os.tmpdir(), "unused-configuration-port-bundle")),
    });
  });
  afterEach(async () => { vi.restoreAllMocks(); await database.cleanup(); });

  const port = (pluginId = id, captured = generation, checkActive = async () => undefined): PluginConfigurationPort =>
    createPluginHostServicesFactory(database.db, () => service)(ctx, {
      checkActive, pluginGeneration: { pluginId, generation: captured },
    }).configuration!;
  const auditCount = async () => (await database.client.execute({ sql: "SELECT count(*) AS count FROM audit_records WHERE subject_id = ?", args: [id] })).rows[0]!.count;

  it("uses SQLite CAS and preserves complete object arrays in the stored row and snapshot", async () => {
    const configuration = port();
    const snapshot = await configuration.read();
    expect(snapshot).toEqual({ revision: 0, lifecycleGeneration: generation, values: { places: [] } });
    const values = { places: [{ name: "Library", days: [1, 3] }] };
    const results = await Promise.allSettled(["A", "B"].map(name => configuration.save({
      values: { places: [{ name, days: [1, 3] }] }, expectedRevision: 0, expectedLifecycleGeneration: generation,
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PluginConfigurationConflictError);
    await configuration.save({ values, expectedRevision: 1, expectedLifecycleGeneration: generation });
    const stored = await new SqlitePluginConfigRepository(database.db).getConfig(ctx, id);
    expect(stored!.valuesJson).toEqual(values);
    expect(await configuration.read()).toEqual({ revision: 2, lifecycleGeneration: generation, values });
    expect(await auditCount()).toBe(2);
  });

  it("refuses an old lifecycle after disable/re-enable without changing values or audit", async () => {
    const old = port();
    await old.save({ values: { places: [] }, expectedRevision: 0, expectedLifecycleGeneration: generation });
    await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true);
    await expect(old.read()).rejects.toBeInstanceOf(PluginConfigurationConflictError);
    await expect(old.save({ values: { places: [{ name: "Stale" }] }, expectedRevision: 1, expectedLifecycleGeneration: generation })).rejects.toBeInstanceOf(PluginConfigurationConflictError);
    const currentGeneration = (await extension.getPlugin(id))!.lifecycleGeneration!;
    await expect(port(id, currentGeneration).read()).resolves.toMatchObject({ revision: 1, values: { places: [] } });
    expect(await auditCount()).toBe(1);
  });

  it("rechecks lifecycle inside the writer transaction if admission races disable/re-enable", async () => {
    const original = SqlitePluginConfigRepository.prototype.saveConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
      await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true);
      return original.apply(this, args);
    });
    await expect(port().save({ values: { places: [{ name: "Late" }] }, expectedRevision: 0, expectedLifecycleGeneration: generation })).rejects.toBeInstanceOf(PluginConfigurationConflictError);
    expect(await new SqlitePluginConfigRepository(database.db).getConfig(ctx, id)).toBeNull();
    expect(await auditCount()).toBe(0);
  });

  it("keeps caller-supplied plugin ids from reading or writing another plugin", async () => {
    const other = await extension.createPlugin({ id: "other-port", publisher: "test", version: "1", checksum: "other", configSchemaJson: fields });
    await service.saveConfig(ctx, other.id, { revision: 0, values: { places: [{ name: "Private" }] }, expectedLifecycleGeneration: other.lifecycleGeneration! });
    const configuration = port();
    await expect(configuration.save({ values: { places: [] }, expectedRevision: 0, expectedLifecycleGeneration: other.lifecycleGeneration! })).rejects.toBeInstanceOf(PluginConfigurationConflictError);
    await configuration.save({ values: { places: [{ name: "Own" }] }, expectedRevision: 0, expectedLifecycleGeneration: generation, pluginId: other.id } as Parameters<PluginConfigurationPort["save"]>[0]);
    expect((await service.getConfig(ctx, other.id)).values).toEqual({ places: [{ name: "Private" }] });
    expect((await configuration.read()).values).toEqual({ places: [{ name: "Own" }] });
  });

  it("never exposes Secret state, orphaned fields or legacy secret values and cannot change credentials", async () => {
    await service.saveConfig(ctx, id, { revision: 0, values: { places: [] }, secretValues: { token: "credential" } });
    await database.client.execute({ sql: "UPDATE plugin_configs SET values_json = ?, orphaned_values_json = ? WHERE plugin_id = ?",
      args: [JSON.stringify({ places: [], token: "legacy-credential" }), JSON.stringify({ retired: "orphaned-private" }), id] });
    const configuration = port();
    expect(await configuration.read()).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [] } });
    const saved = await configuration.save({ values: { places: [], token: "replacement" }, expectedRevision: 1, expectedLifecycleGeneration: generation });
    expect(saved).toEqual({ revision: 2, lifecycleGeneration: generation, values: { places: [] } });
    const secret = (await database.client.execute({ sql: "SELECT value_json FROM plugin_config_secrets WHERE plugin_id = ?", args: [id] })).rows[0]!;
    expect(JSON.parse(String(secret.value_json))).toBe("credential");
  });

  it("fails closed without a host-bound identity and supports a late service getter", async () => {
    let current: PluginConfigService | undefined;
    const factory = createPluginHostServicesFactory(database.db, () => current);
    expect(factory(ctx).configuration).toBeUndefined();
    expect(factory(ctx, { checkActive: async () => undefined }).configuration).toBeUndefined();
    const configuration = factory(ctx, { checkActive: async () => undefined, pluginGeneration: { pluginId: id, generation } }).configuration!;
    await expect(configuration.read()).rejects.toMatchObject({ status: 503, code: "plugin_configuration_unavailable" });
    current = service;
    await expect(configuration.read()).resolves.toMatchObject({ revision: 0 });
  });

  it("refuses an obsolete read before releasing the response", async () => {
    const checkActive = vi.fn(async () => undefined).mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { throw new PluginConfigurationConflictError(); });
    await expect(port(id, generation, checkActive).read()).rejects.toBeInstanceOf(PluginConfigurationConflictError);
    expect(checkActive).toHaveBeenCalledTimes(2);
  });

  it("maps the existing tool scope's generation failure into a stable configuration conflict", async () => {
    const checkActive = async () => { throw new Error("plugin_generation_changed"); };
    await expect(port(id, generation, checkActive).read()).rejects.toMatchObject({ status: 409, code: "plugin_configuration_conflict" });
  });

  it("sanitizes a read against a schema that changed while the configuration was loading", async () => {
    await service.saveConfig(ctx, id, { revision: 0, values: { places: [] } });
    await database.client.execute({ sql: "UPDATE plugin_configs SET values_json = ? WHERE plugin_id = ?",
      args: [JSON.stringify({ places: [], token: "legacy-credential" }), id] });
    await extension.setPluginConfigSchema(id, fields.map(field => field.key === "token" ? { ...field, type: "string" } : field), 1);
    const original = service.getOrdinaryConfig.bind(service);
    vi.spyOn(service, "getOrdinaryConfig").mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      await extension.setPluginConfigSchema(id, fields, 1);
      return snapshot;
    });
    expect(await port().read()).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [] } });
  });

  it("filters after the final read admission changes an ordinary field into a Secret", async () => {
    await extension.setPluginConfigSchema(id, fields.map(field => field.key === "token" ? { ...field, type: "string" } : field), 1);
    await service.saveConfig(ctx, id, { revision: 0, values: { places: [], token: "legacy-credential" } });
    let checks = 0;
    const checkActive = async () => {
      if (++checks === 2) await extension.setPluginConfigSchema(id, fields, 1);
    };
    expect(await port(id, generation, checkActive).read()).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [] } });
    expect(checks).toBe(2);
  });

  it("does not release historical Secret values when final read admission makes the field ordinary", async () => {
    await service.saveConfig(ctx, id, { revision: 0, values: { places: [] } });
    await database.client.execute({ sql: "UPDATE plugin_configs SET values_json = ? WHERE plugin_id = ?",
      args: [JSON.stringify({ places: [], token: "legacy-credential" }), id] });
    let checks = 0;
    const checkActive = async () => {
      if (++checks === 2) await extension.setPluginConfigSchema(id, fields.map(field => field.key === "token" ? { ...field, type: "string" } : field), 1);
    };
    expect(await port(id, generation, checkActive).read()).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [] } });
  });

  it("rechecks the captured lifecycle in the same row snapshot used for final read filtering", async () => {
    const original = service.getOrdinaryConfigValues.bind(service);
    vi.spyOn(service, "getOrdinaryConfigValues").mockImplementationOnce(async (...args) => {
      await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true);
      return original(...args);
    });
    await expect(port().read()).rejects.toBeInstanceOf(PluginConfigurationConflictError);
  });

  it("returns ordinary values from the writer schema rather than an earlier port schema", async () => {
    const original = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementationOnce(async (...args) => {
      await extension.setPluginConfigSchema(id, fields.map(field => field.key === "token" ? { ...field, type: "string" } : field), 1);
      return original(...args);
    });
    const saved = await port().save({ values: { places: [], token: "ordinary-note" }, expectedRevision: 0, expectedLifecycleGeneration: generation });
    expect(saved).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [], token: "ordinary-note" } });
    expect((await new SqlitePluginConfigRepository(database.db).getConfig(ctx, id))!.valuesJson).toEqual(saved.values);
  });

  it("excludes fields classified as Secret by the writer even when the earlier schema was ordinary", async () => {
    await extension.setPluginConfigSchema(id, fields.map(field => field.key === "token" ? { ...field, type: "string" } : field), 1);
    const original = service.saveConfig.bind(service);
    vi.spyOn(service, "saveConfig").mockImplementationOnce(async (...args) => {
      await extension.setPluginConfigSchema(id, fields, 1);
      return original(...args);
    });
    const saved = await port().save({ values: { places: [], token: "must-not-be-a-credential" }, expectedRevision: 0, expectedLifecycleGeneration: generation });
    expect(saved).toEqual({ revision: 1, lifecycleGeneration: generation, values: { places: [] } });
  });

  it("preserves the committed receipt even when the lifecycle changes during post-commit auditing", async () => {
    const original = SqlitePlatformRepository.prototype.createAuditRecord;
    vi.spyOn(SqlitePlatformRepository.prototype, "createAuditRecord").mockImplementationOnce(async function (...args) {
      await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true);
      return original.apply(this, args);
    });
    await expect(port().save({ values: { places: [{ name: "Committed" }] }, expectedRevision: 0, expectedLifecycleGeneration: generation })).resolves.toMatchObject({ revision: 1 });
    expect((await new SqlitePluginConfigRepository(database.db).getConfig(ctx, id))!.revision).toBe(1);
    expect(await auditCount()).toBe(1);
  });

  it("binds HTTP requests to their captured lifecycle and maps safe validation/conflict failures", async () => {
    const app = Fastify();
    const factory = createPluginHostServicesFactory(database.db, () => service);
    const enabled = async () => (await extension.getPlugin(id))?.enabled === 1;
    const getGeneration = async () => (await extension.getPlugin(id))?.lifecycleGeneration ?? undefined;
    mountPluginHttpEndpoints(app, id, [
      { method: "GET", path: "/v1/port/read", handler: async (_request, services) => ({ payload: await services.configuration!.read() }) },
      { method: "PUT", path: "/v1/port/write", handler: async (request, services) => ({ payload: await services.configuration!.save(request.body as Parameters<PluginConfigurationPort["save"]>[0]) }) },
      { method: "GET", path: "/v1/port/stale", handler: async () => {
        await extension.setPluginEnabled(id, false); await extension.setPluginEnabled(id, true);
        return { payload: { secret: "must not escape" } };
      } },
    ], factory, enabled, vi.fn(), getGeneration);
    try {
      expect((await app.inject("/v1/port/read")).json()).toMatchObject({ revision: 0, lifecycleGeneration: generation });
      const invalid = await app.inject({ method: "PUT", url: "/v1/port/write", payload: { values: { places: [null] }, expectedRevision: 0, expectedLifecycleGeneration: generation } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ code: "plugin_configuration_invalid" });
      const stale = await app.inject("/v1/port/stale");
      expect(stale.statusCode).toBe(409); expect(stale.body).not.toContain("must not escape");
      const old = await app.inject({ method: "PUT", url: "/v1/port/write", payload: { values: { places: [] }, expectedRevision: 0, expectedLifecycleGeneration: generation } });
      expect(old.statusCode).toBe(409); expect(old.json()).toMatchObject({ code: "plugin_configuration_conflict" });
    } finally { await app.close(); }
  });

  it("keeps unknown internal failures behind the generic HTTP error", async () => {
    const app = Fastify();
    const warn = vi.fn();
    mountPluginHttpEndpoints(app, id, [{ method: "GET", path: "/v1/port/fault", handler: () => { throw new Error("SELECT credential FROM /private/internal.sqlite"); } }],
      createPluginHostServicesFactory(database.db), async () => true, warn);
    try {
      const response = await app.inject("/v1/port/fault");
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain("internal.sqlite"); expect(warn).toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
