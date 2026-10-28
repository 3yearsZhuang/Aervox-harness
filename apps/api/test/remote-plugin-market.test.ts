import { describe, it, expect, onTestFinished } from "vitest";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { createInMemoryDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

describe("remote registry API integration", () => {
  it("keeps logical skill namespaces separate from plugin storage identities", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client });
    onTestFinished(async () => { await app.close(); await cleanup(); });
    for (const payload of [
      { id: "ap-tool-example:child", publisher: "test", version: "1.0.0" },
      { id: "focus-mode", publisher: "test", version: "1.0.0" },
      { id: "ap-tool-example", publisher: "test", version: "1.0.0", skills: [{ name: "ap-tool-other:child", content: "Instructions" }] },
    ]) {
      const result = await app.inject({ method: "POST", url: "/v1/plugins", payload });
      expect(result.statusCode).toBe(409);
    }
    expect((await app.inject({ method: "GET", url: "/v1/plugins" })).json().items.some((item: { id: string }) => item.id.startsWith("ap-tool-example"))).toBe(false);
  });
  it("keeps builtin browsing and installation available when the remote registry is offline", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const { app } = await buildApp({ db, client, pluginRegistryOptions: {
      url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json",
      fetch: (async () => { throw new Error("offline"); }) as typeof fetch,
    } });
    onTestFinished(async () => { await app.close(); await cleanup(); });
    const market = await app.inject({ method: "GET", url: "/v1/plugins/market" });
    expect(market.statusCode).toBe(200);
    expect(market.json().registryError).toContain("出厂插件");
    expect(market.json().items).toHaveLength(9);
    const install = await app.inject({ method: "POST", url: "/v1/plugins/market/ap-tool-home-assistant/install",
      payload: { expectedVersion: "1.0.0" } });
    expect(install.statusCode, install.body).toBe(201);
  });
  it("browses a published entry, verifies and installs it, then keeps its namespaced skill readable", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    const manifest = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: {
      id: "ap-tool-registry-test", displayName: "Registry test", publisher: "test", version: "1.0.0", category: "tool", tags: ["test"], breaking: false,
    }, spec: { skills: [{ name: "ap-tool-registry-test:help", content: "Registry skill content" }] } };
    const bytes = zipSync({ "plugin.manifest.json": strToU8(JSON.stringify(manifest)) });
    const entry = { ...manifest.metadata, latestVersion: "1.0.0", version: undefined, description: "Registry integration",
      downloadUrl: "https://github.com/Aervox-agent/Aervox-plugins/releases/download/test/test.aervox-plugin",
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
    const transport = (async (input: RequestInfo | URL) => new Response(String(input).endsWith("catalog.json")
      ? JSON.stringify({ version: 1, updatedAt: "2026-10-29T00:00:00Z", plugins: [entry] }) : bytes)) as typeof fetch;
    const { app } = await buildApp({ db, client, pluginRegistryOptions: {
      url: "https://raw.githubusercontent.com/Aervox-agent/Aervox-plugins/main/registry/catalog.json", fetch: transport,
    } });
    onTestFinished(async () => { await app.close(); await cleanup(); });
    const market = await app.inject({ method: "GET", url: "/v1/plugins/market" });
    expect(market.statusCode).toBe(200);
    expect(market.json().items.find((item: { id: string }) => item.id === entry.id)).toMatchObject({ source: "market", category: "tool", installed: false });
    const stale = await app.inject({ method: "POST", url: `/v1/plugins/market/${entry.id}/install`,
      payload: { expectedVersion: "0.9.0", expectedSha256: entry.sha256 } });
    expect(stale.statusCode).toBe(409);
    const installed = await app.inject({ method: "POST", url: `/v1/plugins/market/${entry.id}/install`,
      payload: { expectedVersion: entry.latestVersion, expectedSha256: entry.sha256 } });
    expect(installed.statusCode, installed.body).toBe(201);
    const skill = await app.inject({ method: "GET", url: `/v1/skills/${encodeURIComponent("ap-tool-registry-test:help")}/content` });
    expect(skill.statusCode, skill.body).toBe(200);
    expect(skill.body).toContain("Registry skill content");
  });
});
