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

  it("专注模式综合插件 (study-mode)：整合启发式教学与概念下钻，Bundle 结构完整且可成功安装并注册 Config Schema", async () => {
    const root = path.resolve(__dirname, "../../..");
    const manifestPath = path.resolve(root, "plugins/study-mode/plugin.manifest.json");
    const schemaPath = path.resolve(root, "plugins/study-mode/config.schema.json");
    const skillPath = path.resolve(root, "plugins/study-mode/SKILL.md");

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
    const skillContent = await fs.readFile(skillPath, "utf-8");

    // 1. 验证 Manifest 符合 Zod 契约
    const parsedManifest = pluginManifestSchema.parse(manifest);
    expect(parsedManifest.metadata.id).toBe("study-mode");

    // 2. 验证 Config Schema 符合 Zod 契约，整合启发式教学与概念下钻全部 6 项字段
    const parsedSchema = pluginConfigSchema.parse(schema);
    expect(parsedSchema.fields.length).toBe(6);

    // 3. 验证启动内置插件已预装 study-mode
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ items: Array<{ id: string }> }>();
    expect(list.items.some((p) => p.id === "study-mode")).toBe(true);
    // 旧拆分插件已下线，不存在多余残留
    expect(list.items.some((p) => p.id === "aervox-study-companion")).toBe(false);
    expect(list.items.some((p) => p.id === "aervox-term-explorer")).toBe(false);

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
    expect(snapshot.values.maxExtractedTerms).toBe(8);

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
          maxExtractedTerms: 6,
          enableJudgePass: true,
          defaultExploreKind: "related",
        },
      },
    });
    expect(saveCfg.statusCode).toBe(200);
    expect(saveCfg.json().values.scaffoldingSteps).toBe(4);
    expect(saveCfg.json().values.maxExtractedTerms).toBe(6);
  });
});
