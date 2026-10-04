/**
 * Aervox｜思隅 plugins/focus-mode — record_practice_attempt 工具贡献（CAP-016 刷题闭环）
 *
 * CR-060：自 `packages/core/src/practice-attempt-tool.ts` 迁入。迁移要点：
 * 1. 工具规格、模型侧参数校验与面向模型的 `guidance` 全部归本插件——
 *    内核基础提示词不再硬编码本工具的使用指南（改经 `customGuidance` 注入位合入）；
 * 2. 落库经 `PluginLearningFactPort` 窄端口，插件不接触 `questions` / `question_attempts`
 *    表结构与仓储；
 * 3. 工具是否进入模型工具面由宿主按**插件启用状态**门控（不再仅看端口是否存在）。
 */
import { z } from "zod";
import type {
  ReplayStep,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolGuidance,
  ToolProviderPort,
  ToolSpec,
} from "@aervox/core";
import type { PluginLearningFactPort, PluginToolContribution } from "@aervox/host-plugin-api";

export const RECORD_PRACTICE_ATTEMPT_TOOL = "record_practice_attempt";

/** 本插件 id（同时作为作答证据的来源标签，由插件自述） */
export const PLUGIN_ID = "focus-mode";

const JUDGEMENTS = ["correct", "incorrect", "partial"] as const;

/**
 * 作答落库工具结果的**对外白名单字段**。
 *
 * CR-060 §B7：投影随工具贡献声明，由宿主在为该工具登记投影时校验归属，
 * 因此插件不能借投影泄露内核工具或他人工具的原始载荷。
 */
export const RECORD_PRACTICE_ATTEMPT_RESULT_PROJECTION = z.object({
  questionId: z.string(),
  attemptId: z.string(),
  judgement: z.enum(["correct", "incorrect", "partial"]),
  enteredMistakeNotebook: z.boolean(),
});

export const RECORD_PRACTICE_ATTEMPT_SPEC: ToolSpec = {
  name: RECORD_PRACTICE_ATTEMPT_TOOL,
  description:
    "记录一次用户作答与判定结果（每题必调）。参数: { prompt: 题干, questionType?: 'choice'|'short_answer'|'fill_blank', userAnswer: 用户原始回答, correctAnswer: 标准答案, judgement: 'correct'|'incorrect'|'partial', explanation?: 解析, knowledgeConcept?: 知识点概念 }。judgement 为 incorrect 的作答会自动进入错题本。",
  /**
   * `readOnly: true` 表示免逐次审批门、可直接执行（宿主 `tool-providers` 对只读工具
   * 不创建授权请求，见 `apps/api/src/modules/companion/conversation/tool-providers.ts`）。
   *
   * CR-060 评审**显式复核结论：保留**（不再作为迁移期默认继承）：
   * 1. 写入的是「用户自己作答」这一学习事实（questions / question_attempts），非破坏性，
   *    不触及用户资产（与内核 `ask_user_question` 持久化先例同款）；
   * 2. 该工具只在插件**生效**（启用且可用）时进入模型工具面，停用后模型不可见；
   * 3. 落库经 `PluginLearningFactPort` 窄端口，字段与来源标签由插件自述，宿主不做语义解释。
   *
   * 残余风险（已记录、暂不处理）：模型可被诱导反复写入作答记录形成垃圾数据，当前无频次限制。
   * 该风险与内核既有持久化工具同级；若产品要求逐次授权，应统一调整宿主对 `readOnly` 的
   * 判据，而不是就地改本工具（否则会出现同级别工具判据分叉）。
   */
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "题干" },
      questionType: { type: "string", enum: ["choice", "short_answer", "fill_blank"], description: "题型（可选）" },
      userAnswer: { type: "string", description: "用户原始回答" },
      correctAnswer: { type: "string", description: "标准答案" },
      judgement: { type: "string", enum: ["correct", "incorrect", "partial"], description: "判定结果" },
      explanation: { type: "string", description: "解析（可选）" },
      knowledgeConcept: { type: "string", description: "知识点概念（可选）" },
    },
    required: ["prompt", "userAnswer", "correctAnswer", "judgement"],
  },
};

/** 面向模型的工具使用指南（经宿主 `customGuidance` 注入位合入基础提示词） */
export const RECORD_PRACTICE_ATTEMPT_GUIDANCE: ToolGuidance = {
  name: RECORD_PRACTICE_ATTEMPT_TOOL,
  whenToUse:
    "当用户在练习、测验或自测作答中提交回答且完成判定后立即调用，记录该次作答的不可变学习事实（含判定结果），使答错题目自动进入错题本。",
  whenNotToUse: "非练习或答题场景禁止调用；同一道题的用户作答禁止重复记录。",
  constraints: [
    "`prompt`（题干）、`userAnswer`（用户原始回答）、`correctAnswer`（标准答案）必填。",
    "`judgement` 只能是 `correct` | `incorrect` | `partial` 三值枚举。",
    "答错的题目应在 `explanation` 中提供纠正解析。",
  ],
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 构造作答落库工具提供者；`learningFacts` 已按当前本地上下文绑定 */
export function createPracticeAttemptToolProvider(
  learningFacts: PluginLearningFactPort,
): ToolProviderPort {
  return {
    tools: [RECORD_PRACTICE_ATTEMPT_SPEC],
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      if (input.name !== RECORD_PRACTICE_ATTEMPT_TOOL) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }

      const args = (input.arguments ?? {}) as Record<string, unknown>;
      const prompt = str(args.prompt);
      const userAnswer = str(args.userAnswer);
      const correctAnswer = str(args.correctAnswer);
      const judgement = str(args.judgement);

      if (!prompt) {
        return { ok: false, error: "INVALID_ATTEMPT: `prompt` must be a non-empty string" };
      }
      if (!userAnswer) {
        return { ok: false, error: "INVALID_ATTEMPT: `userAnswer` must be a non-empty string" };
      }
      if (!correctAnswer) {
        return { ok: false, error: "INVALID_ATTEMPT: `correctAnswer` must be a non-empty string" };
      }
      if (!judgement || !JUDGEMENTS.includes(judgement as (typeof JUDGEMENTS)[number])) {
        return {
          ok: false,
          error: `INVALID_ATTEMPT: \`judgement\` must be one of ${JUDGEMENTS.join(" | ")}`,
        };
      }
      if (!input.turnId) {
        return { ok: false, error: "INVALID_ATTEMPT: missing turnId" };
      }

      try {
        const res = await learningFacts.recordJudgedAnswer({
          turnId: input.turnId,
          prompt,
          questionType: str(args.questionType),
          userAnswer,
          correctAnswer,
          judgement: judgement as (typeof JUDGEMENTS)[number],
          explanation: str(args.explanation),
          knowledgeConcept: str(args.knowledgeConcept),
          source: PLUGIN_ID,
        });
        return {
          ok: true,
          output: {
            questionId: res.questionId,
            attemptId: res.attemptId,
            judgement: res.judgement,
            enteredMistakeNotebook: res.enteredMistakeNotebook,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "PRACTICE_ATTEMPT_FAILED",
        };
      }
    },
  };
}

/**
 * 本插件自带确定性回放脚本（键为 `AERVOX_LOOP_PROVIDER=scripted-plugin`）。
 * 与其把插件领域工具名写进宿主夹具，不如由插件自带夹具、宿主只做模式分发（CR-060）。
 */
export const FOCUS_MODE_REPLAY_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我来记录本次作答。",
    toolCalls: [
      {
        id: "call_focus_1",
        name: RECORD_PRACTICE_ATTEMPT_TOOL,
        arguments: {
          prompt: "1 + 1 等于几？",
          questionType: "short_answer",
          userAnswer: "3",
          correctAnswer: "2",
          judgement: "incorrect",
          explanation: "基础加法：1 + 1 = 2。",
        },
      },
    ],
  },
  { text: "答错了，正确答案是 2。", toolCalls: [] },
];

/** 构造本插件的作答落库工具贡献 */
export function createFocusModeToolContributions(
  learningFacts: PluginLearningFactPort,
): PluginToolContribution[] {
  return [
    {
      id: RECORD_PRACTICE_ATTEMPT_TOOL,
      provider: createPracticeAttemptToolProvider(learningFacts),
      guidance: [RECORD_PRACTICE_ATTEMPT_GUIDANCE],
      // CR-060 §B7：结果投影**随工具贡献**声明，由宿主代登记——
      // 插件因此无法为内核工具或他人工具登记投影（归属由结构保证，而非命名约定）。
      resultProjection: RECORD_PRACTICE_ATTEMPT_RESULT_PROJECTION,
    },
  ];
}
