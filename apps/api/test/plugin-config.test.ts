/**
 * Aervox｜思隅 @aervox/api — 插件 Config / Page API 集成测试（CR-006）
 *
 * 覆盖：安装插件 → 注册 Schema → 保存配置（secret 不回显）→ CAS 冲突 →
 * 重置 → Page 注册/资源写入/读取（含路径穿越拒绝）→ Bridge SDK → 卸载清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_pcfg",
  "x-user-id": "usr_pcfg",
} as const;

const CONFIG_SCHEMA = {
  apiVersion: "aervox.dev/v1",
  kind: "PluginConfigSchema",
  schemaVersion: 1,
  fields: [
    { key: "endpoint", type: "string", label: "服务地址", default: "", validation: { maxLength: 64 } },
    { key: "enabled", type: "boolean", label: "启用", default: true },
    { key: "apiKey", type: "secret", label: "API 密钥", description: "不会回显" },
  ],
};

describe("CAP-020 插件 Config / Page API", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let pluginsRoot: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    pluginsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox_plugins_"));
    const built = await buildApp({ db, client, pluginsRoot });
    app = built.app;
    await app.ready();

    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      payload: { id: "cfg-demo", publisher: "aervox-labs", version: "1.0.0" },
    });
    expect(install.statusCode).toBe(201);
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(pluginsRoot, { recursive: true, force: true }).catch(() => undefined);
    await cleanup();
  });

  it("注册/读取 Schema，非法 Schema 被拒绝", async () => {
    const register = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config/schema",
      payload: CONFIG_SCHEMA,
    });
    expect(register.statusCode).toBe(200);
    expect(register.json().fields).toHaveLength(3);

    const read = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/config/schema" });
    expect(read.statusCode).toBe(200);
    expect(read.json().schemaVersion).toBe(1);

    const bad = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config/schema",
      payload: { apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields: [{ key: "x", type: "select", label: "x" }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("保存配置：secret 不回显，revision CAS 冲突返回 409", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config/schema",
      payload: CONFIG_SCHEMA,
    });

    const save = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 0, values: { endpoint: "https://example.test", enabled: true }, secretValues: { apiKey: "topsecret" } },
    });
    expect(save.statusCode).toBe(200);
    const snapshot = save.json();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.values.endpoint).toBe("https://example.test");
    expect(snapshot.secretFields.apiKey).toEqual({ configured: true });
    expect(JSON.stringify(snapshot)).not.toContain("topsecret");

    // secret 保持：不传 secretValues 时已配置状态不变
    const save2 = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 1, values: { endpoint: "https://new.test", enabled: true } },
    });
    expect(save2.statusCode).toBe(200);
    expect(save2.json().secretFields.apiKey).toEqual({ configured: true });

    // 旧 revision 冲突
    const stale = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 1, values: { endpoint: "x", enabled: false } },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("PLUGIN_CONFIG_REVISION_CONFLICT");

    // 清除 secret
    const clear = await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 2, values: { endpoint: "https://new.test", enabled: true }, secretValues: { apiKey: null } },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().secretFields.apiKey).toEqual({ configured: false });
  });

  it("重置配置恢复默认值并清空 secret", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config/schema",
      payload: CONFIG_SCHEMA,
    });
    await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 0, values: { endpoint: "https://x.test" }, secretValues: { apiKey: "abc" } },
    });
    const reset = await app.inject({
      method: "POST",
      url: "/v1/plugins/cfg-demo/config/reset",
      headers,
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().values.endpoint).toBe("");
    expect(reset.json().values.enabled).toBe(true);
    expect(reset.json().secretFields.apiKey).toEqual({ configured: false });
  });

  it("Page：注册 → 写入资源 → 读取入口与静态资源 → 路径穿越拒绝", async () => {
    const page = await app.inject({
      method: "POST",
      url: "/v1/plugins/cfg-demo/pages",
      payload: {
        id: "dashboard",
        title: "面板",
        entry: "pages/dashboard/index.html",
        capabilities: ["config.read", "config.write"],
      },
    });
    expect(page.statusCode).toBe(201);

    const assets = await app.inject({
      method: "POST",
      url: "/v1/plugins/cfg-demo/pages/dashboard/assets",
      payload: {
        files: [
          { path: "index.html", contentBase64: Buffer.from("<!doctype html><h1>Hi</h1>").toString("base64") },
          { path: "app.js", contentBase64: Buffer.from("console.log('page')").toString("base64") },
        ],
      },
    });
    expect(assets.statusCode).toBe(201);

    const entry = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/pages/dashboard/assets/index.html" });
    expect(entry.statusCode).toBe(200);
    expect(entry.body).toContain("<h1>Hi</h1>");
    expect(entry.headers["content-security-policy"]).toContain("frame-ancestors 'self'");

    const js = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/pages/dashboard/assets/app.js" });
    expect(js.statusCode).toBe(200);

    const traversal = await app.inject({
      method: "GET",
      url: "/v1/plugins/cfg-demo/pages/dashboard/assets/..%2F..%2Fsecret.txt",
    });
    expect([400, 404, 500]).toContain(traversal.statusCode);

    const list = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/pages" });
    expect(list.statusCode).toBe(200);
    expect(list.json().pages).toHaveLength(1);
  });

  it("Bridge SDK 可访问且禁用插件后配置/Page 被拒绝", async () => {
    const bridge = await app.inject({ method: "GET", url: "/v1/plugin-pages/bridge.js" });
    expect(bridge.statusCode).toBe(200);
    expect(bridge.body).toContain("AervoxPluginPageBridge");

    await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config/schema",
      payload: CONFIG_SCHEMA,
    });
    await app.inject({ method: "PATCH", url: "/v1/plugins/cfg-demo", payload: { enabled: false } });
    const config = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/config", headers });
    expect(config.statusCode).toBe(409);
    expect(config.json().error).toBe("PLUGIN_DISABLED");
  });

  it("卸载插件后配置/secret/Page 清理，重新安装可重建", async () => {
    await app.inject({ method: "PUT", url: "/v1/plugins/cfg-demo/config/schema", payload: CONFIG_SCHEMA });
    await app.inject({
      method: "PUT",
      url: "/v1/plugins/cfg-demo/config",
      headers,
      payload: { revision: 0, values: { endpoint: "x" }, secretValues: { apiKey: "s" } },
    });
    await app.inject({ method: "POST", url: "/v1/plugins/cfg-demo/pages", payload: { id: "p", title: "P", entry: "pages/p/index.html" } });

    const uninstall = await app.inject({ method: "DELETE", url: "/v1/plugins/cfg-demo" });
    expect(uninstall.statusCode).toBe(204);

    const reinstall = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      payload: { id: "cfg-demo", publisher: "aervox-labs", version: "1.0.0" },
    });
    expect(reinstall.statusCode).toBe(201);

    const config = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/config", headers });
    expect(config.statusCode).toBe(404); // schema 已随插件删除
    const pages = await app.inject({ method: "GET", url: "/v1/plugins/cfg-demo/pages" });
    expect(pages.json().pages).toHaveLength(0);
  });
});
