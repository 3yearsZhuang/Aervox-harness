import { expect, it, onTestFinished } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, SqliteExtensionRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

it("offers optional sources without preinstalling them and preserves install, disable and uninstall across restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-optional-plugin-"));
  const database = await createInMemoryDatabase();
  const id = "ap-tool-optional-fixture";
  const source = path.join(root, "source");
  const directory = path.join(source, "plugins/tool/optional-fixture");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "plugin.manifest.json"), JSON.stringify({
    apiVersion: "aervox.dev/v1", kind: "PluginManifest",
    requires: { hostApiVersion: { min: "1.2.0", maxExclusive: "2.0.0" } },
    metadata: { id, publisher: "fixture", displayName: "Optional fixture", version: "1.0.0", category: "tool", installation: "optional" },
    spec: { config: { schemaVersion: 1, entry: "config.schema.json" } },
  }));
  await fs.writeFile(path.join(directory, "config.schema.json"), JSON.stringify({
    apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1,
    fields: [{ key: "label", type: "string", label: "Label", default: "retained" }],
  }));
  await fs.writeFile(path.join(directory, "SKILL.md"), "# Optional fixture\nAn explicitly installed fixture.\n");
  const repository = new SqliteExtensionRepository(database.db);
  const options = { db: database.db, client: database.client, builtinPluginsSourceRoot: source,
    skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "installed"), pluginRegistryOptions: null };
  let app = (await buildApp(options)).app;
  onTestFinished(async () => { await app.close(); await database.cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  const marketItem = async () => {
    const response = await app.inject({ method: "GET", url: "/v1/plugins/market" });
    expect(response.statusCode).toBe(200);
    return response.json().items.find((item: { id: string }) => item.id === id);
  };
  expect(await repository.getPlugin(id)).toBeNull();
  expect(await marketItem()).toMatchObject({ id, installed: false });
  expect((await database.client.execute({ sql: "SELECT * FROM plugin_configs WHERE plugin_id = ?", args: [id] })).rows).toEqual([]);
  expect((await database.client.execute({ sql: "SELECT * FROM skill_registrations WHERE plugin_id = ?", args: [id] })).rows).toEqual([]);

  const installed = await app.inject({ method: "POST", url: `/v1/plugins/market/${id}/install` });
  expect(installed.statusCode).toBe(201);
  expect((await repository.getPlugin(id))?.enabled).toBe(1);
  expect(await marketItem()).toMatchObject({ installed: true });
  const config = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` });
  expect(config.statusCode).toBe(200);
  expect(config.json().values).toMatchObject({ label: "retained" });
  const saved = await app.inject({ method: "PUT", url: `/v1/plugins/${id}/config`,
    payload: { revision: config.json().revision, values: { label: "saved by user" } } });
  expect(saved.statusCode).toBe(200);

  expect((await app.inject({ method: "PATCH", url: `/v1/plugins/${id}`, payload: { enabled: false } })).statusCode).toBe(200);
  const disabled = await repository.getPlugin(id);
  await app.close();
  app = (await buildApp(options)).app;
  expect(await repository.getPlugin(id)).toMatchObject({ enabled: 0, lifecycleGeneration: disabled!.lifecycleGeneration, bundleGeneration: disabled!.bundleGeneration });
  expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(409);
  expect((await app.inject({ method: "PATCH", url: `/v1/plugins/${id}`, payload: { enabled: true } })).statusCode).toBe(200);
  const reopened = await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` });
  expect(reopened.statusCode).toBe(200);
  expect(reopened.json().values).toMatchObject({ label: "saved by user" });

  expect((await app.inject({ method: "DELETE", url: `/v1/plugins/${id}` })).statusCode).toBe(204);
  await app.close();
  app = (await buildApp(options)).app;
  expect(await repository.getPlugin(id)).toBeNull();
  expect(await marketItem()).toMatchObject({ id, installed: false });
  expect((await app.inject({ method: "GET", url: `/v1/plugins/${id}/config` })).statusCode).toBe(404);
});

it("does not automatically install a source targeting an incompatible host", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-incompatible-source-"));
  const database = await createInMemoryDatabase();
  const directory = path.join(root, "future");
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "plugin.manifest.json"), JSON.stringify({
    apiVersion: "aervox.dev/v1", kind: "PluginManifest",
    requires: { hostApiVersion: { min: "2.0.0", maxExclusive: "3.0.0" } },
    metadata: { id: "future", publisher: "fixture", displayName: "Future", version: "1.0.0" }, spec: {},
  }));
  const { app } = await buildApp({ db: database.db, client: database.client, builtinPluginsSourceRoot: root,
    skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "installed"), pluginRegistryOptions: null });
  onTestFinished(async () => { await app.close(); await database.cleanup(); await fs.rm(root, { recursive: true, force: true }); });
  expect(await new SqliteExtensionRepository(database.db).getPlugin("future")).toBeNull();
});
