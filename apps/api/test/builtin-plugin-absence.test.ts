import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { createInMemoryDatabase, initDatabaseSchema, SqliteExtensionRepository, SqliteToolRegistryRepository, SqliteSkillRegistryRepository } from "@aervox/repositories";
import { registerPluginsModule, createServerPluginRegistry } from "../src/modules/ecosystem/plugins/index.js";
import type { ModuleContext } from "../src/modules/context.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });

it("缺包、非法清单、不可读根均保留配置/Secret/撤权与开关；恢复只恢复可用性", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-builtin-absence-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const res = await createInMemoryDatabase(); cleanups.push(res.cleanup);
  await initDatabaseSchema(res.client);
  const source = path.join(root, "source"); const bundle = path.join(source, "fixture");
  const manifest = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: { id: "fixture", publisher: "test", displayName: "Fixture", version: "1" }, spec: {} };
  async function restore() { await fs.mkdir(bundle, { recursive: true }); await fs.writeFile(path.join(bundle, "plugin.manifest.json"), JSON.stringify(manifest)); }
  const registry = createServerPluginRegistry();
  async function scan() {
    const app = Fastify();
    const ctx: ModuleContext = { app, db: res.db, client: res.client, skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "installed"), builtinPluginsSourceRoot: source, pluginRegistry: registry };
    await registerPluginsModule(ctx);
    expect(ctx.pluginRegistry).toBe(registry);
    await app.close();
  }
  await restore(); await scan();
  const ext = new SqliteExtensionRepository(res.db);
  const tools = new SqliteToolRegistryRepository(res.db);
  const skills = new SqliteSkillRegistryRepository(res.db);
  await tools.registerTool({ id: "fixture-tool", name: "fixture_tool", description: "fixture", category: "plugin", pluginId: "fixture", safetyLevel: "read_only" });
  await skills.registerSkill({ id: "fixture-skill", name: "fixture-skill", description: "fixture", pluginId: "fixture", active: true });
  const local = { workspaceId: "local", subjectUserId: "local" };
  await ext.grantPlugin(local, { id: "revoked", pluginId: "fixture", permission: "memory:read", scope: "*" });
  await ext.revokePluginGrant(local, "revoked");
  await res.client.execute("INSERT INTO plugin_configs (id,plugin_id,values_json,secret_keys_json,created_at,updated_at) VALUES ('cfg','fixture','{\"theme\":\"keep\"}','[\"token\"]','2026','2026')");
  await res.client.execute("INSERT INTO plugin_config_secrets (id,plugin_id,field_key,value_json,created_at,updated_at) VALUES ('secret','fixture','token','\"sentinel\"','2026','2026')");
  await res.client.execute("INSERT INTO plugin_pages (id,plugin_id,page_id,title,entry,capabilities_json,created_at,updated_at) VALUES ('page','fixture','main','Keep','index.html','[]','2026','2026')");
  const tableNames = ["plugin_configs", "plugin_config_secrets", "plugin_pages", "plugin_grants"];
  const snapshots = async () => Promise.all(tableNames.map(async (name) => (await res.client.execute(`SELECT * FROM ${name}`)).rows));
  const before = await snapshots();
  await fs.rm(bundle, { recursive: true }); await scan();
  expect((await ext.getPlugin("fixture"))?.availability).toBe("missing");
  expect((await ext.getPlugin("fixture"))?.enabled).toBe(1);
  expect(await tools.exportRegistry()).toEqual([]);
  expect(await skills.exportSkills()).toEqual([]);
  expect((await tools.getTool("fixture-tool"))?.enabled).toBe(0);
  expect(await snapshots()).toEqual(before);
  await restore(); await fs.writeFile(path.join(bundle, "plugin.manifest.json"), "{bad"); await scan();
  expect((await ext.getPlugin("fixture"))?.availability).toBe("invalid");
  await fs.rm(source, { recursive: true }); await fs.writeFile(source, "not a directory"); await scan();
  expect((await ext.getPlugin("fixture"))?.availability).toBe("unreadable");
  await fs.rm(source); await restore(); await scan();
  expect((await ext.getPlugin("fixture"))?.availability).toBe("available");
  expect((await tools.exportRegistry()).map((t) => t.id)).toContain("fixture-tool");
  expect(await ext.hasPluginPermission(local, "fixture", "memory:read")).toBe(false);
  await ext.setPluginEnabled("fixture", false);
  await fs.rm(bundle, { recursive: true }); await scan(); await restore(); await scan();
  expect((await ext.getPlugin("fixture"))?.enabled).toBe(0);
  expect(await snapshots()).toEqual(before);
});

it("默认注册表实例隔离，导入模块无隐式注册；旧释放不能影响替代实例", () => {
  const first = createServerPluginRegistry(); const second = createServerPluginRegistry();
  expect(first).not.toBe(second);
  expect(first.getAll().length).toBeGreaterThan(0);
  const releaseA = first.register({ id: "same", aliases: ["old"] });
  const newer = { id: "same", aliases: ["new"] };
  const releaseB = first.register(newer);
  releaseA(); releaseA(); expect(first.get("same")).toBe(newer);
  expect(first.get("old")).toBeUndefined();
  releaseB(); releaseB(); expect(first.get("same")).toBeUndefined();
  first.clear(); expect(second.getAll().length).toBeGreaterThan(0);
});
