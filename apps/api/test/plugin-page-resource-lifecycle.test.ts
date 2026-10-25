import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInMemoryDatabase,
  SqliteExtensionRepository,
  SqlitePluginPageRepository,
} from "@aervox/repositories";
import { PluginBundleStore } from "@aervox/host-runtime-test/modules/ecosystem/plugins/bundle-store";
import { buildApp } from "./app-fixture.js";

describe("Page resource lifecycle during file reads", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>["app"];
  let root: string;
  let extension: SqliteExtensionRepository;
  let pages: SqlitePluginPageRepository;
  const pluginId = "page-resource-lifecycle";
  const pageId = "settings";
  const declaration = {
    pluginId, pageId, title: "Settings", entry: "pages/settings/nested/start.html",
    capabilities: ["config.read", "config.write"], checksum: "fixture-assets",
  };
  const canary = "PAGE_RESOURCE_BODY_MUST_NOT_ESCAPE_AFTER_REVOCATION";
  const resources = [
    { request: "index.html", relative: "nested/start.html", content: `<html>${canary}</html>`, mime: "text/html" },
    { request: "nested/main.js", relative: "nested/main.js", content: `globalThis.resourceCanary = '${canary}';`, mime: "javascript" },
  ] as const;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-page-resource-"));
    ({ app } = await buildApp({ db: database.db, client: database.client, pluginsRoot: root }));
    await app.ready();
    extension = new SqliteExtensionRepository(database.db);
    pages = new SqlitePluginPageRepository(database.db);
    await extension.createPlugin({ id: pluginId, publisher: "test", version: "1", checksum: "fixture" });
    await pages.upsertPage(declaration);
    const store = new PluginBundleStore(root);
    for (const resource of resources) await store.writeAsset(pluginId, pageId, resource.relative, Buffer.from(resource.content));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const url = (resource: string) => `/v1/plugins/${pluginId}/pages/${pageId}/assets/${resource}`;

  async function transition(change: string): Promise<void> {
    if (change === "disabled" || change === "reenabled") {
      await extension.setPluginEnabled(pluginId, false);
      if (change === "reenabled") await extension.setPluginEnabled(pluginId, true);
    } else if (change === "missing" || change === "restored") {
      await extension.setPluginAvailability(pluginId, "missing");
      if (change === "restored") await extension.setPluginAvailability(pluginId, "available");
    } else if (change === "deleted" || change === "recreated" || change === "other-plugin") {
      await pages.deletePagesForPlugin(pluginId);
      if (change === "recreated") await pages.upsertPage(declaration);
      if (change === "other-plugin") {
        await extension.createPlugin({ id: "other-resource-plugin", publisher: "other", version: "1", checksum: "other" });
        await pages.upsertPage({ ...declaration, pluginId: "other-resource-plugin" });
      }
    } else if (change === "reregistered" || change === "reauthorized") {
      if (change === "reauthorized") await pages.upsertPage({ ...declaration, capabilities: [] });
      await pages.upsertPage(declaration);
    } else if (change === "checksum") {
      const page = (await pages.getPage(pluginId, pageId))!;
      expect(await pages.updatePageChecksum(pluginId, pageId, page.id, "replacement-assets")).not.toBeNull();
    } else if (change === "bundle") {
      await database.client.execute({ sql: "UPDATE plugins SET bundle_generation = ? WHERE id = ?",
        args: ["10000000-0000-4000-8000-000000000001", pluginId] });
    } else if (change === "entry") {
      await database.client.execute({ sql: "UPDATE plugin_pages SET entry = ? WHERE plugin_id = ? AND page_id = ?",
        args: ["pages/settings/nested/replaced.html", pluginId, pageId] });
    } else {
      throw new Error(`unknown transition: ${change}`);
    }
  }

  describe.each(resources)("$request", resource => {
    it("returns the real resource with the existing security headers", async () => {
      const read = vi.spyOn(PluginBundleStore.prototype, "readAsset");
      const response = await app.inject({ method: "GET", url: url(resource.request) });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(resource.content);
      expect(response.headers["content-type"]).toContain(resource.mime);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).toContain("connect-src 'none'");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(read).toHaveBeenCalledWith(pluginId, pageId, resource.relative);
    });

    it.each(["disabled", "reenabled", "missing", "restored", "deleted", "reregistered", "recreated", "reauthorized", "checksum", "other-plugin", "bundle", "entry"])(
      "withholds bytes after %s changes while file I/O is in flight", async change => {
        const original = PluginBundleStore.prototype.readAsset;
        const read = vi.spyOn(PluginBundleStore.prototype, "readAsset").mockImplementationOnce(async function (...args) {
          const asset = await original.apply(this, args);
          expect(asset.content.toString()).toBe(resource.content);
          await transition(change);
          return asset;
        });
        const response = await app.inject({ method: "GET", url: url(resource.request) });
        expect(read).toHaveBeenCalledExactlyOnceWith(pluginId, pageId, resource.relative);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe("PLUGIN_PAGE_REVISION_CONFLICT");
        expect(response.body).not.toContain(canary);
      },
    );

    it.each([
      { change: "disabled", status: 409, code: "PLUGIN_DISABLED" },
      { change: "missing", status: 409, code: "PLUGIN_UNAVAILABLE" },
      { change: "deleted", status: 404, code: "PLUGIN_PAGE_NOT_FOUND" },
    ])("rejects $change before reading any file", async ({ change, status, code }) => {
      await transition(change);
      const read = vi.spyOn(PluginBundleStore.prototype, "readAsset");
      const response = await app.inject({ method: "GET", url: url(resource.request) });
      expect(response.statusCode).toBe(status);
      expect(response.json().code).toBe(code);
      expect(response.body).not.toContain(canary);
      expect(read).not.toHaveBeenCalled();
    });
  });
});
