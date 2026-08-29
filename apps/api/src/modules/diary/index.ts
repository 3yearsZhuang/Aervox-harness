/**
 * Aervox｜思隅 @aervox/api — 日记模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * CAP-009 对话触发：依赖 tools/llm 模块先注册（装配顺序见 app.ts），
 * 经 ctx.toolRuntime 登记 aervox_diary_write（PET-05 write_with_approval）。
 * 生成能力统一来自 @aervox/diary（与 Worker 定时路径共用单源）。
 */
import type { ModuleContext } from "../context.js";
import { SqliteDiaryRepository } from "@aervox/database";
import { registerDiaryRoutes } from "./routes.js";
import { DiaryWriteTool } from "./diary-write-tool.js";
import { DiaryApplicationService } from "./application.js";
import {
  DiaryGenerationService,
  createLlmDiaryModelPort,
  type DiaryLlmConfigPort,
} from "@aervox/diary";

export function registerDiaryModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const diaryRepo = new SqliteDiaryRepository(db);

  // 生成服务：LLM 模式经 llmConfigService 解析租户配置；未接线/供应商不支持 → 模板降级
  const llmConfigPort: DiaryLlmConfigPort = {
    async getConfig(tenant) {
      if (!ctx.llmConfigService) return null;
      const cfg = await ctx.llmConfigService.getConfig(tenant);
      if (!cfg.enabled) return null;
      if (cfg.providerType === "anthropic") return null; // 日记生成仅支持 OpenAI 兼容协议
      return {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        modelId: cfg.modelId,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
      };
    },
  };
  const generation = new DiaryGenerationService({
    db,
    model: ctx.llmConfigService ? createLlmDiaryModelPort(llmConfigPort) : null,
  });
  const service = new DiaryApplicationService({ diaryRepo, generation });

  registerDiaryRoutes(app, { diaryRepo, service });

  // CAP-009 对话触发：handler + 注册表同步登记（幂等；enabled 保持既有开关）
  const toolRuntime = ctx.toolRuntime;
  if (toolRuntime) {
    const tool = new DiaryWriteTool({ service });
    toolRuntime.registerHandler("aervox_diary_write", {
      call: (tenant, args) => tool.run(tenant, (args ?? {}) as never),
    });
    void toolRuntime.registerTool({
      id: "aervox_diary_write",
      name: "aervox_diary_write",
      description:
        "为用户写一篇今天的日记（桌宠视角、第一人称）：当用户表达「写篇日记给我」「记录一下今天」等意图时调用。内容基于当日真实聊天、记忆与学习素材生成，不虚构；当日已有日记时生成改写版本。",
      category: "diary",
      safetyLevel: "write_with_approval",
      requiredPermissions: [],
      inputSchema: {
        type: "object",
        properties: {
          focus: { type: "string", description: "用户希望日记额外强调的内容（可选）" },
        },
      },
      builtin: true,
      gatingConditions: [],
      priority: 100,
    });
  }
}