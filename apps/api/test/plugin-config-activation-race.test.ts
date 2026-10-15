import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase, SqliteExtensionRepository, SqlitePluginConfigRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

describe("configuration writes racing with schema activation", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let extension: SqliteExtensionRepository;
  const id = "schema-race";
  const fields = [{key: "label", label: "Label", type: "string", default: "initial"},
    {key: "token", label: "Token", type: "secret"}];
  const newerFields = [...fields, {key: "added", label: "Added", type: "string", default: "new default"}];
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    ({ app } = await buildApp({db: database.db, client: database.client}));
    await app.ready();
    extension = new SqliteExtensionRepository(database.db);
    await extension.createPlugin({id, publisher: "test", version: "1.0.0", checksum: "fixture", configSchemaJson: fields});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await database.cleanup();
  });

  it("rejects the first save if its schema changed after validation, without writing Secrets", async () => {
    const save = SqlitePluginConfigRepository.prototype.saveConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "saveConfig").mockImplementationOnce(async function (...args) {
      await extension.setPluginConfigSchema(id, newerFields, 1);
      return save.apply(this, args);
    });
    const response = await app.inject({method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 0, values: {label: "stale"}, secretValues: {token: "stale secret"},
    }});
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    const current = (await app.inject({method: "GET", url: `/v1/plugins/${id}/config`})).json();
    expect(current.revision).toBe(0);
    expect(current.values).toEqual({label: "initial", added: "new default"});
    expect(current.secretFields.token.configured).toBe(false);
  });

  it("rejects a stale reset before deleting Secrets or changing saved values", async () => {
    const saved = await app.inject({method: "PUT", url: `/v1/plugins/${id}/config`, payload: {
      revision: 0, values: {label: "saved"}, secretValues: {token: "keep secret"},
    }});
    expect(saved.statusCode).toBe(200);
    const reset = SqlitePluginConfigRepository.prototype.resetConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, "resetConfig").mockImplementationOnce(async function (...args) {
      await extension.setPluginConfigSchema(id, newerFields, 1);
      return reset.apply(this, args);
    });
    const response = await app.inject({method: "POST", url: `/v1/plugins/${id}/config/reset`});
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");
    const current = (await app.inject({method: "GET", url: `/v1/plugins/${id}/config`})).json();
    expect(current.revision).toBe(1);
    expect(current.values).toEqual({label: "saved", added: "new default"});
    expect(current.secretFields.token.configured).toBe(true);
  });
});
