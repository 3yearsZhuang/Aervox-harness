/**
 * Aervox｜思隅 @aervox/agent-loop — record_practice_attempt 工具提供者（CAP-016 刷题闭环）
 *
 * 刷题模式下 AI 判定用户作答后，通过本工具将不可变学习事实落库：
 * - 声明 record_practice_attempt 工具（readOnly: true，与 ask_user_question 同款先例——
 *   持久化的是用户自己作答产生的学习事实，非破坏性写，无需逐次审批门）；
 * - 模型侧参数：prompt / questionType? / userAnswer / correctAnswer / judgement / explanation? / knowledgeConcept?；
 * - 校验必填字段与 judgement 三值枚举后委托 PracticeAttemptPort.recordAttempt()；
 * - incorrect 作答由宿主错题本派生逻辑自动收录，结果回填 enteredMistakeNotebook 供模型循环节奏参考。
 */
import type {
  PracticeAttemptPort,
  PracticeAttemptPortRequest,
} from "./ports.js";
import type { ToolExecutionInput, ToolExecutionResult, ToolProviderPort } from "./ports.js";
import type { ToolSpec } from "./types.js";

export const RECORD_PRACTICE_ATTEMPT_TOOL = "record_practice_attempt";

const JUDGEMENTS = ["correct", "incorrect", "partial"] as const;

export const RECORD_PRACTICE_ATTEMPT_SPEC: ToolSpec = {
  name: RECORD_PRACTICE_ATTEMPT_TOOL,
  description:
    "刷题模式下记录一次用户作答与判定结果（每题必调）。参数: { prompt: 题干, questionType?: 'choice'|'short_answer'|'fill_blank', userAnswer: 用户原始回答, correctAnswer: 标准答案, judgement: 'correct'|'incorrect'|'partial', explanation?: 解析, knowledgeConcept?: 知识点概念 }。judgement 为 incorrect 的作答会自动进入错题本。",
  // 学习事实（用户自己作答产生）持久化，非破坏性；与 ask_user_question 持久化事件的先例一致，免逐次审批门。
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

export interface CreatePracticeAttemptToolOptions {
  practiceAttemptPort: PracticeAttemptPort;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createPracticeAttemptToolProvider(
  options: CreatePracticeAttemptToolOptions,
): ToolProviderPort {
  const { practiceAttemptPort } = options;

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

      const req: PracticeAttemptPortRequest = {
        turnId: input.turnId,
        prompt,
        questionType: str(args.questionType),
        userAnswer,
        correctAnswer,
        judgement: judgement as PracticeAttemptPortRequest["judgement"],
        explanation: str(args.explanation),
        knowledgeConcept: str(args.knowledgeConcept),
      };

      try {
        const res = await practiceAttemptPort.recordAttempt(req);
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
