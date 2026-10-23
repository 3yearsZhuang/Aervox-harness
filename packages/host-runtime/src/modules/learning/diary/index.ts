import { createSqliteDiaryMaterialPort } from "@aervox/repositories";
/**
 * Aervox｜思隅 @aervox/api — 日记模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * CAP-009 对话触发：依赖 tools/llm 模块先注册（装配顺序见 app.ts），
 * 经 ctx.toolRuntime 登记 aervox_diary_write（PET-05 write_with_approval）。
 * 生成能力统一来自 @aervox/diary（与 Worker 定时路径共用单源）。
 */
import type { ModuleDependencies } from "../../context.js";
import { SqliteDiaryRepository } from "@aervox/repositories";
import { registerDiaryRoutes } from "./routes.js";
import { DiaryWriteTool } from "./diary-write-tool.js";
import { DiaryApplicationService } from "./application.js";
import {
  DiaryGenerationService,
} from "@aervox/diary";

export async function registerDiaryModule(ctx: ModuleDependencies<"app" | "db" | "modelGeneration" | "executionConfig" | "toolRuntime">): Promise<void> {
  const { app, db } = ctx;
  const diaryRepo = new SqliteDiaryRepository(db);

  const generation = new DiaryGenerationService({
    materials: createSqliteDiaryMaterialPort(db),
    useModel: ctx.executionConfig?.loopProvider === "llm",
    model: ctx.modelGeneration ?? null,
  });
  const service = new DiaryApplicationService({ diaryRepo, generation });

  registerDiaryRoutes(app, { diaryRepo, service });

  // CAP-009 对话触发：handler + 注册表同步登记（幂等；enabled 保持既有开关）
  const toolRuntime = ctx.toolRuntime;
  if (toolRuntime) {
    const tool = new DiaryWriteTool({ service });
    await toolRuntime.registerContribution({
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
    }, { call: (ctx, args) => tool.run(ctx, (args ?? {}) as never) });
  }
}
export { publishGeneratedDiary, type DiaryPublicationInput } from "./publication.js";
