import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, SqliteExtensionRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

describe("production assembly of exact Manifest metadata tools", () => {
  it("returns the same catalog as HTTP domain routes and keeps write declarations unbound", async () => {
    const memory = await createInMemoryDatabase();
    const { app, toolRuntime } = await buildApp({ db: memory.db, client: memory.client });
    try {
      const plugins = new SqliteExtensionRepository(memory.db);
      const names = [
        ["ap-tool-anki-sync", "anki_list_providers", "learning.read", "/v1/questions/import/providers"],
        ["ap-workflow-diary-distillers", "diary_list_styles", "diary.read", "/v1/diaries/styles"],
      ] as const;
      for (const [pluginId, name, permission, route] of names) {
        const record = await plugins.getPlugin(pluginId);
        expect(record?.version).toBe("1.1.0");
        await plugins.setPluginEnabled(pluginId, true);
        const denied = await app.inject({ method: "POST", url: `/v1/tools/${pluginId}.${name}/call`, payload: { arguments: {} } });
        expect(denied.statusCode).toBe(400);
        expect(denied.json().isError).toBe(true);
        await plugins.grantPlugin({ workspaceId: "local", subjectUserId: "local" }, { id: name, pluginId, permission, scope: "*" });
        const result = await app.inject({ method: "POST", url: `/v1/tools/${pluginId}.${name}/call`, payload: { arguments: {} } });
        expect(result.statusCode).toBe(200);
        const catalog = await app.inject({ method: "GET", url: route });
        expect(catalog.statusCode).toBe(200);
        expect(JSON.parse(result.json().content[0].text)).toEqual(catalog.json());
        await plugins.revokePluginGrant({ workspaceId: "local", subjectUserId: "local" }, name);
        expect((await app.inject({ method: "POST", url: `/v1/tools/${pluginId}.${name}/call`, payload: { arguments: {} } })).statusCode).toBe(400);
      }
      const exported = (await toolRuntime.exportRegistry()).filter(tool => names.some(([id]) => tool.pluginId === id));
      expect(exported.map(tool => tool.name).sort()).toEqual(["anki_list_providers", "diary_list_styles"]);
    } finally { await app.close(); await memory.cleanup(); }
  });
});
