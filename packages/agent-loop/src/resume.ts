/**
 * Aervox｜思隅 @aervox/agent-loop — 恢复裁决（AVX-HAR-001 §11.3「工具结果已权威提交但尚未注入」）
 *
 * 纯函数：给定持久事件流与工具执行账本，裁决「原 Attempt 是否可从权威工具结果安全续跑」。
 * - 仅当最后一工具结果批次全部 `executed` 且无终态事件 → 可续（resume）：
 *   由阶段 4 host-agent 恢复器读取权威结果回填并继续，禁止重复副作用；
 * - 其余情况（终态已提交、混合批次、结果未知、无工具结果）一律保持收敛：
 *   释放 → 新 Attempt（现有语义），不自动重放未知结果。
 *
 * 注意：本模块只提供裁决，不实现续跑执行；续跑接线属阶段 4 `host-agent`。
 */
import type { LoopEventType } from "./types.js";
import type { PromptMessage } from "./types.js";

/** 裁决输入的最小事件面（持久事件流） */
export interface ResumeEventLike {
  eventType: LoopEventType | string;
  sequence: number;
  data?: {
    /** tool_request/tool_result 的 Host executionId（attempt:step:seq） */
    executionId?: string;
    [key: string]: unknown;
  };
}

/** 裁决输入的最小工具账本面 */
export interface ResumeExecutionLike {
  invocationId: string;
  status: string;
}

/** 裁决结果（resume=true 表示可在 lastSequence 后继续） */
export interface ResumeDecision {
  resume: boolean;
  reason: "resumable" | "terminal_event" | "mixed_batch" | "no_committed_tool" | "outcome_unknown";
  lastSequence?: number;
}

const NOT_RESUMABLE_STATUSES = new Set(["pending", "outcome_unknown", "pending_approval"]);

/** 从 Host executionId（attempt:step:seq）提取 step 段；非法返回空串 */
const stepOf = (executionId: string): string => executionId.split(":")[1] ?? "";

/**
 * 裁决 Attempt 是否可在权威工具结果后安全续跑（§11.3 首范式）。
 */
export function decideResume(
  events: ResumeEventLike[],
  executions: ResumeExecutionLike[],
): ResumeDecision {
  // 1) 已存在终态（done）→ 不得续跑
  const done = events.find((e) => e.eventType === "done");
  if (done) {
    return { resume: false, reason: "terminal_event", lastSequence: done.sequence };
  }

  // 2) 无已提交工具结果 → 没有可读取的权威结果
  const toolResults = events.filter(
    (e) => e.eventType === "tool_result" && typeof e.data?.executionId === "string",
  );
  if (toolResults.length === 0) {
    return { resume: false, reason: "no_committed_tool" };
  }

  // 3) 取最后一工具结果批次（同 step 的 tool_result 集）并核对账本
  const lastResult = toolResults[toolResults.length - 1]!; // 上方已保证非空
  const step = stepOf(lastResult.data!.executionId!);
  const batch = toolResults.filter((t) => stepOf(t.data!.executionId!) === step && t.sequence <= lastResult.sequence);
  if (batch.length === 0) {
    return { resume: false, reason: "outcome_unknown" };
  }
  const batchExecutionIds = new Set(batch.map((t) => t.data!.executionId!));
  const statuses = executions.filter((x) => batchExecutionIds.has(x.invocationId)).map((x) => x.status);

  // 4) 结果未知 / 待决 → 不自动重放（§11.3）
  if (statuses.length === 0 || statuses.some((s) => NOT_RESUMABLE_STATUSES.has(s))) {
    return { resume: false, reason: "outcome_unknown" };
  }

  // 5) 全部已权威执行 → 可在该批结果后继续；否则混合批次按严格批次语义收敛
  if (statuses.every((s) => s === "executed")) {
    return { resume: true, reason: "resumable", lastSequence: lastResult.sequence };
  }
  return { resume: false, reason: "mixed_batch" };
}

/**
 * 4b：从持久事件流重建续跑上下文（§11.3 首范式「从 ToolExecution 读取权威结果并继续」）。
 *
 * 产出：
 * - `history`：PromptMessage[]（user + 已提交 assistant 文本 + 权威 tool 结果），供 executor 续跑复用；
 * - `messageId`：已提交的助手消息身份（续跑 delta/done 沿用）；无则回退空串（由 executor 补默认）。
 *
 * 事件到消息的映射（与 executor 写入顺序一致）：
 * - `message`：仅取 messageId；
 * - `delta`：累积文本（续跑前已提交的 assistant 文本）；
 * - `tool_request`：闭合上一文本段为 assistant 消息（携带 toolCallId），并登记请求以关联结果；
 * - `tool_result`：按请求登记补 tool 消息（executionId 对齐；输出以事件 data 为准）。
 */
export function buildResumeHistory(input: {
  userMessage: string;
  events: ResumeEventLike[];
}): { history: PromptMessage[]; messageId: string } {
  const history: PromptMessage[] = [{ role: "user", content: input.userMessage }];
  let messageId = "";
  let assistantText = "";
  let pendingToolCall: { id: string; name: string } | null = null;
  let assistantEmitted = false;

  for (const ev of input.events) {
    const data = ev.data ?? {};
    if (ev.eventType === "message") {
      if (typeof data.messageId === "string") messageId = data.messageId;
      continue;
    }
    if (ev.eventType === "delta") {
      if (typeof data.text === "string") assistantText += data.text;
      continue;
    }
    if (ev.eventType === "tool_request") {
      // 闭合已提交文本为 assistant 消息（携带即将注入的工具调用）
      if (assistantText) {
        history.push({
          role: "assistant",
          content: assistantText,
          toolCallId: pendingToolCall?.id,
          name: pendingToolCall?.name,
        });
        assistantText = "";
      }
      pendingToolCall = {
        id: typeof data.invocationId === "string" ? data.invocationId : "",
        name: typeof data.name === "string" ? data.name : "",
      };
      assistantEmitted = false;
      continue;
    }
    if (ev.eventType === "tool_result") {
      // 该工具批次的 assistant 消息尚未闭合 → 先补发
      if (!assistantEmitted && assistantText) {
        history.push({
          role: "assistant",
          content: assistantText,
          toolCallId: pendingToolCall?.id,
          name: pendingToolCall?.name,
        });
        assistantText = "";
      }
      assistantEmitted = true;
      const ok = typeof data.ok === "boolean" ? data.ok : false;
      history.push({
        role: "tool",
        content: JSON.stringify({
          ok,
          output: data.output,
          error: data.error,
        }),
        toolCallId: pendingToolCall?.id,
        name: pendingToolCall?.name,
      });
      continue;
    }
    // 其它事件（done/error/approval 等）：不参与上下文重建
  }
  // 尾部残留文本（无后续工具请求）：闭合为纯 assistant 消息
  if (assistantText) {
    history.push({
      role: "assistant",
      content: assistantText,
      toolCallId: pendingToolCall?.id,
      name: pendingToolCall?.name,
    });
  }
  return { history, messageId };
}