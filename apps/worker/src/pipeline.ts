/**
 * Aervox｜思隅 @aervox/worker — Pipeline Stage 显式顺序（AST-05 接线）
 *
 * 参照 AstrBot 的 STAGES_ORDER 显式阶段顺序 + 短路语义（返回 null 即中止）自研：
 * - 本 Worker 各后台任务以显式顺序表声明执行次序，避免隐性依赖；
 * - stage 返回「处理数量」，≥0 即继续；如需短路（如检测到迁移未完成）返回 null。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §4.8。
 */

/** 阶段标识（显式顺序事实源） */
export const PIPELINE_STAGES = [
  "outbox",
  "review_notification",
  "diary_generation",
  "deletion",
  "compaction_markers",
  "embedding_migration",
] as const;

export type PipelineStageId = (typeof PIPELINE_STAGES)[number];

export interface PipelineStageRunResult {
  stage: PipelineStageId;
  /** 处理数量；null = 短路（中止后续阶段） */
  processed: number | null;
}

/** 单次流水线执行：按 STAGES_ORDER 依序执行；任一阶段返回 null 即短路 */
export async function runPipeline<TExecutor extends Record<PipelineStageId, () => Promise<number | null>>>(
  executors: TExecutor,
): Promise<PipelineStageRunResult[]> {
  const results: PipelineStageRunResult[] = [];
  for (const stage of PIPELINE_STAGES) {
    const processed = await executors[stage]();
    results.push({ stage, processed });
    if (processed === null) break; // 短路
  }
  return results;
}