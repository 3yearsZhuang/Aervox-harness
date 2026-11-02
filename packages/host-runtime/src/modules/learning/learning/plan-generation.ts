/**
 * Aervox｜思隅 @aervox/api — 学习规划生成核心（参考 OpenMAIC planner 单次结构化生成）
 *
 * 单次 LLM 调用产出完整「规划 + 里程碑 + 任务」路线图：
 * 一次调用 → JSON 解析 → 结构校验（gaps）→ 带 gaps 重试一次 → hydrate（分配 id/order/status）→ 落库。
 * Provider 缝隙：PlanModelPort 由装配层注入——llm 模式走 OpenAI 兼容 provider，
 * replay/scripted 等非 LLM 模式走确定性模板（诚实降级，输出标注 template）。
 */
import type { LocalContext, LearningPlanModel } from "@aervox/repositories";
import type { LearningPlanPort } from "@aervox/repositories";
import type { ModelGenerationPort } from "../../ecosystem/llm/index.js";
import { runPlanGeneration } from "@aervox/practice-review";

export type PlanModelPort = ModelGenerationPort;


// Pure pipeline lives in @aervox/practice-review so every host shares one
// generation semantics; re-exported for tests and existing importers.
export {
  buildPlanSystemPrompt, buildPlanUserPrompt, extractJsonObject, validatePlanOutput,
  hydratePlan, renderTemplatePlan, type PlanLLMOutput,
} from "@aervox/practice-review";

export interface LearningPlanGenerationResult {
  plan: LearningPlanModel;
  generatedBy: "llm" | "template";
}

export class LearningPlanGenerationService {
  constructor(
    private readonly deps: {
      learningRepo: Pick<LearningPlanPort, "createLearningPlan">;
      model: PlanModelPort | null;
      useModel?: boolean;
    },
  ) {}

  /** 生成学习规划并落库（共享纯管线：单次调用 → 校验 → 带 gaps 重试一次 → hydrate → 事务写入） */
  async generate(
    tenant: LocalContext,
    input: { topic: string; level?: string; dailyMinutes?: number },
  ): Promise<LearningPlanGenerationResult> {
    const model = this.deps.useModel === false || !this.deps.model
      ? null
      : (system: string, user: string) => this.deps.model!.generate({ context: tenant, system, user });
    const { draft, generatedBy } = await runPlanGeneration(input, model);
    const plan = await this.deps.learningRepo.createLearningPlan(tenant, draft);
    return { plan, generatedBy };
  }
}
