import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "@aervox/repositories";
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
    process.env.AERVOX_LOOP_PROVIDER = "replay";
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
    delete process.env.AERVOX_LOOP_PROVIDER;
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

  it("服务端门控：study-mode 停用时服务端拦截专注模式，不生成 terms_extracted 事件；启用时正常生成", async () => {
    const sessionId = "ses_study_gate";

    // 1. 初始状态 study-mode 默认已启用，发送带专注模式前缀消息
    const turn1Res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: {
        message: { content: "[模式：专注模式] 请讲解 Dijkstra 算法与 React 架构", contentType: "text" },
        clientVersion: "it-study",
        references: [],
      },
    });
    expect(turn1Res.statusCode).toBe(201);
    const turn1Id = turn1Res.json().turnId;

    const events1Res = await app.inject({
      method: "GET",
      url: `/v1/turns/${turn1Id}/events`,
      headers,
    });
    expect(events1Res.statusCode).toBe(200);
    // 应当包含 terms_extracted 事件
    expect(events1Res.body).toContain("terms_extracted");

    // 2. 停用 study-mode 插件
    const disableRes = await app.inject({
      method: "PATCH",
      url: "/v1/plugins/study-mode",
      headers,
      payload: { enabled: false },
    });
    expect(disableRes.statusCode).toBe(200);

    // 3. 在插件停用状态下，外部请求即便带 [模式：专注模式] 前缀，服务端也必须拒绝激活专注模式
    const turn2Res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: {
        message: { content: "[模式：专注模式] 请讲解 TypeScript 与 JWT 鉴权", contentType: "text" },
        clientVersion: "it-study",
        references: [],
      },
    });
    expect(turn2Res.statusCode).toBe(201);
    const turn2Id = turn2Res.json().turnId;

    const events2Res = await app.inject({
      method: "GET",
      url: `/v1/turns/${turn2Id}/events`,
      headers,
    });
    expect(events2Res.statusCode).toBe(200);
    // 专注模式未被激活，不应当产出 terms_extracted 事件
    expect(events2Res.body).not.toContain("terms_extracted");
  });

  it("配置与提示词默认值对齐：未配置时正确回退 schema 规范默认值，且 prompt 默认开启严格防剧透", async () => {
    const { loadStudyModeRuntimeConfig, DEFAULT_STUDY_MODE_CONFIG } = await import(
      "../src/modules/conversation/agent-executor.js"
    );
    const { buildStudyModePrompt } = await import("@aervox/agent-loop");

    // 1. 无记录时回退默认配置
    const tenant = { workspaceId: "ws_default_test", subjectUserId: "usr_default_test" };
    const config = await loadStudyModeRuntimeConfig(tenant, null);
    expect(config).toEqual(DEFAULT_STUDY_MODE_CONFIG);
    expect(config.strictAntiSpoiler).toBe(true);
    expect(config.scaffoldingSteps).toBe(3);
    expect(config.maxExtractedTerms).toBe(3);
    expect(config.defaultExploreKind).toBe("socratic");
    expect(config.showTermTips).toBe(true);
    expect(config.enableJudgePass).toBe(false);

    // 2. buildStudyModePrompt 当 config 为空或 strictAntiSpoiler 为 undefined 时默认开启严格防剧透
    const defaultPrompt = buildStudyModePrompt();
    expect(defaultPrompt).toContain("【严格防剧透模式开启】");

    const undefinedConfigPrompt = buildStudyModePrompt({ scaffoldingSteps: 4 });
    expect(undefinedConfigPrompt).toContain("【严格防剧透模式开启】");
    expect(undefinedConfigPrompt).toContain("拆解为 4 个连贯的小步骤");

    const relaxedPrompt = buildStudyModePrompt({ strictAntiSpoiler: false });
    expect(relaxedPrompt).not.toContain("【严格防剧透模式开启】");
    expect(relaxedPrompt).toContain("优先识别用户的卡点");
  });

  it("二阶段术语质检裁决：enableJudgePass 开启且候选数 > 5 时，LLM 成功执行初提与复核两阶段调用", async () => {
    const { extractTerms } = await import("@aervox/practice-review");

    const calls: Array<{ prompt: string; options?: unknown }> = [];
    const mockLlm = {
      async generate(prompt: string, options?: { systemPrompt?: string; temperature?: number }): Promise<string> {
        calls.push({ prompt, options });
        if (calls.length === 1) {
          // 阶段 1: 初提返回 6 个候选
          return JSON.stringify([
            { text: "Dijkstra", relation: "background", description: "最短路径" },
            { text: "A*搜索", relation: "related", description: "启发搜索" },
            { text: "Bellman-Ford", relation: "related", description: "负权图" },
            { text: "Floyd", relation: "related", description: "多源最短路" },
            { text: "SPFA", relation: "related", description: "队列优化" },
            { text: "拓扑排序", relation: "background", description: "有向无环图" },
          ]);
        }
        // 阶段 2: 复核筛选过滤为 3 个高价值术语
        return JSON.stringify([
          { text: "Dijkstra", relation: "background", description: "最短路径" },
          { text: "A*搜索", relation: "related", description: "启发搜索" },
          { text: "Bellman-Ford", relation: "related", description: "负权图" },
        ]);
      },
    };

    const terms = await extractTerms("关于图论中寻找最短路径的算法说明...", {
      llm: mockLlm,
      enableJudgePass: true,
      maxTerms: 5,
    });

    expect(calls.length).toBe(2);
    expect(terms.length).toBe(3);
    expect(terms.map((t) => t.text)).toEqual(["Dijkstra", "A*搜索", "Bellman-Ford"]);
  });
});
