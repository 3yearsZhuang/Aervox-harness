/**
 * Aervox｜思隅 @aervox/api — DiaryWriteTool 运行时实现（CAP-009 对话触发）
 *
 * 用户在对话中表达「写篇日记给我」时，模型经 aervox_diary_write 工具触发生成。
 * 行为与契约对齐 packages/contracts diaryWriteToolInputSchema/Output；
 * 全部生成/发布逻辑收敛到 DiaryApplicationService（REST 首开路径复用同源能力）。
 */
import type { TenantContext } from "@aervox/database";
import type { DiaryWriteToolInput, DiaryWriteToolOutput } from "@aervox/contracts";
import type { DiaryApplicationService } from "./application.js";

export interface DiaryWriteToolDeps {
  service: DiaryApplicationService;
}

export class DiaryWriteTool {
  constructor(private readonly deps: DiaryWriteToolDeps) {}

  async run(tenant: TenantContext, input: DiaryWriteToolInput): Promise<DiaryWriteToolOutput> {
    // 对话触发语义 = 手动改写：当日已有 → rewrite 版本推进主行；无 → 新建
    const result = await this.deps.service.rewriteTodayDiary(tenant, input?.focus);
    return {
      diaryId: result.diaryId,
      localDate: result.localDate,
      title: result.title,
      content: result.content,
      mode: result.mode === "created" ? "created" : "rewritten",
      materialCount: result.materialCount,
      generatedBy: result.generatedBy,
    };
  }
}