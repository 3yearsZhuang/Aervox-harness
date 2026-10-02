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

  it("专注模式综合插件 (focus-mode)：整合启发式教学与概念下钻，Bundle 结构完整且可成功安装并注册 Config Schema", async () => {
    const root = path.resolve(__dirname, "../../..");
    const manifestPath = path.resolve(root, "plugins/focus-mode/plugin.manifest.json");
    const schemaPath = path.resolve(root, "plugins/focus-mode/config.schema.json");
    const skillPath = path.resolve(root, "plugins/focus-mode/SKILL.md");

    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    const schema = JSON.parse(await fs.readFile(schemaPath, "utf-8"));
    const skillContent = await fs.readFile(skillPath, "utf-8");

    // 1. 验证 Manifest 符合 Zod 契约
    const parsedManifest = pluginManifestSchema.parse(manifest);
    expect(parsedManifest.metadata.id).toBe("focus-mode");

    // 2. 验证 Config Schema 符合 Zod 契约，整合启发式教学与概念下钻全部 6 项字段
    const parsedSchema = pluginConfigSchema.parse(schema);
    expect(parsedSchema.fields.length).toBe(6);

    // 3. 验证启动内置插件已预装 focus-mode
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/plugins",
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json<{ items: Array<{ id: string }> }>();
    expect(list.items.some((p) => p.id === "focus-mode")).toBe(true);

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
    expect(snapshot.values.autoEnableFocusMode).toBe(true);
    expect(snapshot.values.maxExtractedTerms).toBe(8);

    const saveCfg = await app.inject({
      method: "PUT",
      url: `/v1/plugins/${manifest.metadata.id}/config`,
      headers,
      payload: {
        revision: snapshot.revision,
        values: {
          autoEnableFocusMode: false,
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

    // 6. CR-060：历史别名已移除 —— study-mode / quiz-mode 不再是 focus-mode 的注册别名，
    //    对别名发起配置操作必须 404，避免"以别名创建孤立配置"。
    const aliasReset = await app.inject({
      method: "POST",
      url: "/v1/plugins/study-mode/config/reset",
      headers,
    });
    expect(aliasReset.statusCode).toBe(404);

    const aliasGet = await app.inject({
      method: "GET",
      url: "/v1/plugins/quiz-mode/config",
      headers,
    });
    expect(aliasGet.statusCode).toBe(404);

    // 7. 主 id 重置生效，回到 Schema 规范默认值
    const resetCfg = await app.inject({
      method: "POST",
      url: "/v1/plugins/focus-mode/config/reset",
      headers,
    });
    expect(resetCfg.statusCode).toBe(200);
    expect(resetCfg.json().values.scaffoldingSteps).toBe(3);
    expect(resetCfg.json().values.maxExtractedTerms).toBe(8);

    const getAfterReset = await app.inject({
      method: "GET",
      url: "/v1/plugins/focus-mode/config",
      headers,
    });
    expect(getAfterReset.statusCode).toBe(200);
    expect(getAfterReset.json().values.scaffoldingSteps).toBe(3);
    expect(getAfterReset.json().values.maxExtractedTerms).toBe(8);
  });

  it("服务端门控：focus-mode 停用时服务端拦截专注模式，不生成 terms_extracted 事件；启用时正常生成", async () => {
    const sessionId = "ses_study_gate";

    // 1. 初始状态 focus-mode 默认已启用，发送带专注模式前缀消息
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

    // 2. 停用 focus-mode 插件（CR-060 后仅存在主 id，无历史别名）
    const disableRes = await app.inject({
      method: "PATCH",
      url: "/v1/plugins/focus-mode",
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

  it("配置与提示词默认值对齐：插件自带默认值解析与严格防剧透提示词", async () => {
    // CR-060：实现已内聚于 plugins/focus-mode；宿主不再提供配置加载辅助函数，
    // 插件由 Runner 注入已保存配置并用自带默认值兜底。
    const { parseFocusConfig, DEFAULT_FOCUS_MODE_CONFIG } = await import("@aervox/plugin-focus-mode/server");

    // 1. 无配置时回退 Schema 规范默认值
    expect(parseFocusConfig(null)).toEqual(DEFAULT_FOCUS_MODE_CONFIG);
    expect(DEFAULT_FOCUS_MODE_CONFIG.strictAntiSpoiler).toBe(true);
    expect(DEFAULT_FOCUS_MODE_CONFIG.scaffoldingSteps).toBe(3);
    expect(DEFAULT_FOCUS_MODE_CONFIG.maxExtractedTerms).toBe(8);
    expect(DEFAULT_FOCUS_MODE_CONFIG.defaultExploreKind).toBe("child");
    expect(DEFAULT_FOCUS_MODE_CONFIG.enableJudgePass).toBe(true);

    // 2. 非法/越界字段回退默认值，合法字段透传
    const merged = parseFocusConfig({ scaffoldingSteps: 5, defaultExploreKind: "bogus", strictAntiSpoiler: false });
    expect(merged.scaffoldingSteps).toBe(5);
    expect(merged.defaultExploreKind).toBe("child");
    expect(merged.strictAntiSpoiler).toBe(false);

    // 3. 提示词默认开启严格防剧透
    const { buildFocusModePrompt } = await import("@aervox/plugin-focus-mode/server");
    expect(buildFocusModePrompt()).toContain("【严格防剧透模式开启】");

    const undefinedConfigPrompt = buildFocusModePrompt({ scaffoldingSteps: 4 });
    expect(undefinedConfigPrompt).toContain("【严格防剧透模式开启】");
    expect(undefinedConfigPrompt).toContain("拆解为 4 个连贯的小步骤");

    const relaxedPrompt = buildFocusModePrompt({ strictAntiSpoiler: false });
    expect(relaxedPrompt).not.toContain("【严格防剧透模式开启】");
    expect(relaxedPrompt).toContain("优先识别用户的卡点");
  });

  it("二阶段术语质检裁决：enableJudgePass 开启且候选数 > 5 时，LLM 成功执行初提与复核两阶段调用", async () => {
    // CR-060：术语抽取管线随实现归插件（宿主不再经 practice-review 暴露）
    const { extractTerms } = await import("@aervox/plugin-focus-mode/server");

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

  it("结构化元数据 Turn（metadata.mode = focus）：无需消息前缀即可识别并注入提示词", async () => {
    const { focusModeTurnPlugin, isFocusModeMessage } = await import("@aervox/plugin-focus-mode/server");

    expect(isFocusModeMessage("纯净的用户提问", { mode: "focus" })).toBe(true);
    expect(isFocusModeMessage("纯净的用户提问", { mode: "focus-mode" })).toBe(true);
    // CR-060：历史语义 mode='study' 不再被识别（别名已移除）
    expect(isFocusModeMessage("纯净的用户提问", { mode: "study" })).toBe(false);
    expect(isFocusModeMessage("纯净的用户提问", {})).toBe(false);

    const dummyCtx = {
      turnId: "t_test",
      sessionId: "s_test",
      attemptId: "atp_test",
      userMessage: "请问什么是快速排序？",
      metadata: { mode: "focus" },
      stream: {
        readEvents: async () => [],
        appendEvent: async (input: { eventType: string }) => ({
          id: "evt_test",
          turnId: "t_test",
          sequence: 1,
          eventType: input.eventType,
          payloadVersion: 1,
          occurredAt: new Date().toISOString(),
          data: {},
        }),
      },
    };

    const result = await focusModeTurnPlugin.beforeTurn?.(dummyCtx, { scaffoldingSteps: 4 });
    expect(result?.extraSections).toBeDefined();
    expect(result?.extraSections?.[0]).toContain("专注模式核心教学原则");
    expect(result?.extraSections?.[0]).toContain("4 个连贯的小步骤");
    expect(result?.state?.isFocusMode).toBe(true);
  });

  it("createLLMCallable 适配器：正确透传 temperature 参数与 systemPrompt", async () => {
    const { createLLMCallable } = await import("../src/modules/companion/conversation/llm-adapter.js");
    let capturedRequest: any;
    const mockProvider = {
      id: "mock",
      async *stream(request: any) {
        capturedRequest = request;
        yield { text: "mock result", isFinal: true };
      },
    };

    const callable = createLLMCallable(mockProvider);
    const result = await callable.generate("user prompt", {
      systemPrompt: "system prompt",
      temperature: 0.2,
    });

    expect(result).toBe("mock result");
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest.temperature).toBe(0.2);
    expect(capturedRequest.context.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
  });

  it("ServerTurnPluginRegistry：注册别名插件与主插件时自动互斥去重，杜绝 getAll() 实例翻倍", async () => {
    const { ServerTurnPluginRegistry } = await import("../src/modules/ecosystem/plugins/turn-plugins/registry.js");
    const reg = new ServerTurnPluginRegistry();

    const focusPlugin = { id: "focus-mode", aliases: ["study-mode", "quiz-mode"] };
    const studyPlugin = { id: "study-mode" };
    const quizPlugin = { id: "quiz-mode" };

    // 先注册 focus-mode，再尝试注册别名 study-mode 与 quiz-mode
    reg.register(focusPlugin);
    reg.register(studyPlugin);
    reg.register(quizPlugin);

    expect(reg.getAll()).toHaveLength(1);
    expect(reg.getAll()[0].id).toBe("focus-mode");
    expect(reg.get("study-mode")?.id).toBe("focus-mode");
    expect(reg.get("quiz-mode")?.id).toBe("focus-mode");

    // 反向测试：若先注册 study-mode，后注册 focus-mode，自动清理旧别名
    const reg2 = new ServerTurnPluginRegistry();
    reg2.register(studyPlugin);
    expect(reg2.getAll()).toHaveLength(1);
    expect(reg2.getAll()[0].id).toBe("study-mode");

    reg2.register(focusPlugin);
    expect(reg2.getAll()).toHaveLength(1);
    expect(reg2.getAll()[0].id).toBe("focus-mode");
  });
});
