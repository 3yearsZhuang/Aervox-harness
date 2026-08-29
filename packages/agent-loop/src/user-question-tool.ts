/**
 * Aervox｜思隅 @aervox/agent-loop — ask_user_question 工具提供者 (UQ-01)
 *
 * 借鉴 reference/deepseek-harness dsh-tool-ask-user 与 dsh-user-questions 设计：
 * - 声明 ask_user_question 工具（read_only: true，AI 可主动提问）；
 * - 模型侧参数：questions 数组，含 id, question, header, detail, options, multiSelect, intent；
 * - 拦截与校验：Subagent 隔离（由外层组合剔除或执行期校验）；
 * - 挂起与等待：委托 UserQuestionPort.ask() 等待人类提交回答；
 * - 结果回填：将结构化回答序列化为 JSON 文本 `{ answers: [...] }` 送回模型循环。
 */
import type { AskUserQuestionItem } from "@aervox/contracts";
import type { ToolExecutionInput, ToolExecutionResult, ToolProviderPort, UserQuestionPort } from "./ports.js";
import type { ToolSpec } from "./types.js";

export const ASK_USER_QUESTION_TOOL = "ask_user_question";

export const ASK_USER_QUESTION_SPEC: ToolSpec = {
  name: ASK_USER_QUESTION_TOOL,
  description:
    "向用户提出简明问题，用于在需要确认、决策、补充缺失信息或计划审批时暂停并等待用户回答。参数: { questions: [{ id, question, header?, detail?, options?: [{ label, description? }], multiSelect?, intent?: { kind, approve? } }] }",
  readOnly: true,
  // 声明强类型 schema：部分兼容端点在 parameters 缺省（仅 {type:"object"}）时会把数组参数序列化为字符串
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        description: "要向用户提出的问题列表（1~4 个）",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "问题唯一标识" },
            question: { type: "string", description: "问题正文" },
            header: { type: "string", description: "问题标题（可选）" },
            detail: { type: "string", description: "补充说明（可选）" },
            options: {
              type: "array",
              description: "选项（可选；简答题不提供）",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项文案" },
                  description: { type: "string", description: "选项说明（可选）" },
                },
                required: ["label"],
              },
            },
            multiSelect: { type: "boolean", description: "是否多选（默认单选）" },
          },
          required: ["id", "question"],
        },
      },
    },
    required: ["questions"],
  },
};

/**
 * 模型容错：部分模型会把数组参数整体序列化为 JSON 字符串（schema 缺省时的真实 LLM 行为）。
 * 尝试解析字符串形态（含剥 markdown code fence），失败返回 undefined 走原校验报错。
 */
function coerceQuestionsArray(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface CreateAskUserQuestionToolOptions {
  userQuestionPort: UserQuestionPort;
  /** 是否为被委托的子 Agent（如果是子 Agent 则禁止提问，遵循 DELEGATED_CALLER 隔离原则） */
  isSubagent?: boolean;
  /** 单次提问超时时间（ms），默认 60000 */
  defaultTimeoutMs?: number;
}

export function createAskUserQuestionToolProvider(
  options: CreateAskUserQuestionToolOptions,
): ToolProviderPort {
  const { userQuestionPort, isSubagent = false, defaultTimeoutMs = 60000 } = options;

  return {
    tools: [ASK_USER_QUESTION_SPEC],
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      if (input.name !== ASK_USER_QUESTION_TOOL) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }

      // 1. Subagent 隔离原则（No Child Asking）
      if (isSubagent) {
        return {
          ok: false,
          error:
            "DELEGATED_CALLER: 子任务（Subagent）禁止直接向用户提问，请在子任务输出中列出未决问题供主 Agent 提问。",
        };
      }

      // 2. 参数结构校验与规范化（容错：字符串化的 JSON 数组自动解析）
      const args = (input.arguments ?? {}) as { questions?: unknown };
      const questionsInput = coerceQuestionsArray(args.questions);
      if (!Array.isArray(questionsInput) || questionsInput.length === 0) {
        return {
          ok: false,
          error: "EMPTY_QUESTIONS: ask_user_question requires a non-empty `questions` array",
        };
      }

      const questions: AskUserQuestionItem[] = [];
      for (const raw of questionsInput) {
        if (!raw || typeof raw !== "object") {
          return { ok: false, error: "INVALID_QUESTION: each question must be an object" };
        }
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== "string" || item.id.trim().length === 0) {
          return { ok: false, error: "INVALID_QUESTION: question `id` must be a non-empty string" };
        }
        if (typeof item.question !== "string" || item.question.trim().length === 0) {
          return { ok: false, error: "INVALID_QUESTION: question `question` must be a non-empty string" };
        }

        const q: AskUserQuestionItem = {
          id: item.id.trim(),
          question: item.question.trim(),
          header: typeof item.header === "string" ? item.header.trim() : undefined,
          detail: typeof item.detail === "string" ? item.detail.trim() : undefined,
          multiSelect: item.multiSelect === true || item.multi_select === true,
        };

        if (Array.isArray(item.options)) {
          q.options = item.options
            .filter((opt): opt is Record<string, unknown> => Boolean(opt) && typeof opt === "object")
            .map((opt) => ({
              label: String(opt.label ?? "").trim(),
              description: typeof opt.description === "string" ? opt.description.trim() : undefined,
            }))
            .filter((opt) => opt.label.length > 0);
        }

        if (item.intent && typeof item.intent === "object") {
          const intentObj = item.intent as Record<string, unknown>;
          if (intentObj.kind === "plan-review" || intentObj.kind === "choice" || intentObj.kind === "confirmation") {
            q.intent = {
              kind: intentObj.kind,
              approve: typeof intentObj.approve === "string" ? intentObj.approve.trim() : undefined,
            };
          }
        }

        // 3. 意图防御性校验 (DSH 契约对齐)
        if (q.intent) {
          if (q.intent.kind === "plan-review" && !q.detail) {
            return {
              ok: false,
              error: `BAD_INTENT: question "${q.id}" declares intent "plan-review" without the "detail" it reviews`,
            };
          }
          if (q.intent.approve && !(q.options ?? []).some((opt) => opt.label === q.intent?.approve)) {
            return {
              ok: false,
              error: `BAD_INTENT: question "${q.id}" approve label "${q.intent.approve}" is not in its options`,
            };
          }
        }

        questions.push(q);
      }

      // 4. 从 invocationId 中解析 step（形如 atp_xxx:1:1）
      const stepMatch = input.invocationId.match(/:(\d+):/);
      const step = stepMatch && stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;

      // 5. 委托 UserQuestionPort 挂起等待
      try {
        // 缺陷 D：把宿主超时/取消信号透传给协调器（协调器据此清理挂起并 reject），
        // 使「工具超时」能真正终止提问等待，而不是让底层挂到自然超时。
        const res = await userQuestionPort.ask({
          turnId: input.turnId,
          attemptId: input.attemptId,
          step,
          questions,
          timeoutMs: defaultTimeoutMs,
          signal: input.signal,
        });

        return {
          ok: true,
          output: {
            answers: res.answers,
          },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "QUESTION_FAILED",
        };
      }
    },
  };
}
