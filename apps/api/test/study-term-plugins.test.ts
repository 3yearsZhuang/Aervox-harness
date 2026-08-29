import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/database";
import { pluginManifestSchema, pluginConfigSchema } from "@aervox/contracts";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_plugin_test",
  "x-user-id": "usr_plugin_test",
} as const;

describe("CAP-002 / CAP-007 插件规范化验证（AVX-PLUG-001）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("专注模式插件 (aervox-study-companion)：Bundle 结构完整且可成功安装并注册 Config Schema", async () => {
    const root = path.resolve(__dirname, "../../..");
    const manifestPath = path.resolve(root, "plugins/study-companion/plugin.manifest.json");
    const schemaPath = path.resolve(root, "plugins/study-companion/config.schema.json");
    const skillPath = path.resolve(root, "plugins/study-companion/SKILL.md");

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
    const skillContent = await fs.readFile(skillPath, "utf-8");

    // 1. 验证 Manifest 符合 Zod 契约
    const parsedManifest = pluginManifestSchema.parse(manifest);
    expect(parsedManifest.metadata.id).toBe("aervox-study-companion");

    // 2. 验证 Config Schema 符合 Zod 契约
    const parsedSchema = pluginConfigSchema.parse(schema);
    expect(parsedSchema.fields.length).toBeGreaterThanOrEqual(3);

    // 3. 验证启动内置插件已预装
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ items: Array<{ id: string }> }>();
    expect(list.items.some((p) => p.id === "aervox-study-companion")).toBe(true);

    // 4. 注册/更新 Config Schema
    const schemaRes = await app.inject({
      method: "PUT",
      url: `/v1/plugins/${manifest.metadata.id}/config/schema`,
      payload: schema,
    });
    expect(schemaRes.statusCode).toBe(200);

    // 5. 读取默认配置并保存新配置
    const getCfg = await app.inject({
      method: "GET",
      url: `/v1/plugins/${manifest.metadata.id}/config`,
      headers,
    });
    expect(getCfg.statusCode).toBe(200);
    const snapshot = getCfg.json();
    expect(snapshot.values.autoEnableStudyMode).toBe(true);

    const saveCfg = await app.inject({
      method: "PUT",
      url: `/v1/plugins/${manifest.metadata.id}/config`,
      headers,
      payload: {
        revision: snapshot.revision,
        values: {
          autoEnableStudyMode: false,
          strictAntiSpoiler: true,
          scaffoldingSteps: 4,
        },
      },
    });
    expect(saveCfg.statusCode).toBe(200);
    expect(saveCfg.json().values.scaffoldingSteps).toBe(4);
  });

  it("术语探索插件 (aervox-term-explorer)：Bundle 结构完整且可成功安装并注册 Config Schema", async () => {
    const root = path.resolve(__dirname, "../../..");
    const manifestPath = path.resolve(root, "plugins/term-explorer/plugin.manifest.json");
    const schemaPath = path.resolve(root, "plugins/term-explorer/config.schema.json");
    const skillPath = path.resolve(root, "plugins/term-explorer/SKILL.md");

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
    const skillContent = await fs.readFile(skillPath, "utf-8");

    // 1. 验证 Manifest 与 Schema 符合 Zod 契约
    const parsedManifest = pluginManifestSchema.parse(manifest);
    expect(parsedManifest.metadata.id).toBe("aervox-term-explorer");
    const parsedSchema = pluginConfigSchema.parse(schema);
    expect(parsedSchema.fields.length).toBeGreaterThanOrEqual(3);

    // 2. 验证启动内置插件已预装
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ items: Array<{ id: string }> }>();
    expect(list.items.some((p) => p.id === "aervox-term-explorer")).toBe(true);

    // 3. 注册/更新 Config Schema
    const schemaRes = await app.inject({
      method: "PUT",
      url: `/v1/plugins/${manifest.metadata.id}/config/schema`,
      payload: schema,
    });
    expect(schemaRes.statusCode).toBe(200);

    // 4. 读取配置
    const getCfg = await app.inject({
      method: "GET",
      url: `/v1/plugins/${manifest.metadata.id}/config`,
      headers,
    });
    expect(getCfg.statusCode).toBe(200);
    expect(getCfg.json().values.maxExtractedTerms).toBe(8);
  });
});
