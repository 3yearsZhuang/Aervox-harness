/**
 * Aervox｜思隅 @aervox/core — 上下文投影与可见性控制（ITER-032 / PI-01 context_edit）
 *
 * 核心设计：
 * 1. 模型可见上下文是从权威历史重建的投影，原始聊天历史、计费记录与存储完全保留；
 * 2. 隐藏或过滤不等于物理删除；
 * 3. 工具调用与工具结果成组处理，严格保障 tool_calls 与 tool 结果的成对性，严禁产生孤立 tool 消息；
 * 4. 超大工具输出有界截断保护，防止单个大输出击穿 LLM 上下文窗口。
 */
import type { ContextProjectionOptions, PromptMessage } from "./types.js";

const DEFAULT_MAX_TOOL_RESULT_CHARS = 16_384;
const DEFAULT_TOOL_RESULT_HEAD_CHARS = 2_048;
const DEFAULT_TOOL_RESULT_TAIL_CHARS = 1_024;

/**
 * 将消息按工具调用边界分组（system 消息单独处理，非 system 消息成组）。
 * 一个带有 toolCalls 的 assistant 消息与紧随其后且 toolCallId 匹配的全部 tool 消息构成一个不可分割的原子组。
 */
export function groupMessagesByToolBoundary(messages: PromptMessage[]): PromptMessage[][] {
  const groups: PromptMessage[][] = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "system") {
      groups.push([msg]);
      i++;
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const group: PromptMessage[] = [msg];
      const callIds = new Set(msg.toolCalls.map((c) => c.id));
      let j = i + 1;

      while (j < messages.length) {
        const next = messages[j]!;
        if (next.role === "tool" && next.toolCallId && callIds.has(next.toolCallId)) {
          group.push(next);
          j++;
        } else {
          break;
        }
      }

      groups.push(group);
      i = j;
      continue;
    }

    // 单独的 tool 消息（未紧跟对应 assistant），单独成组，在后续严格配对检查中会被剔除
    groups.push([msg]);
    i++;
  }

  return groups;
}

/**
 * 截断超大工具结果，保留首尾结构与审计标注。
 */
export function truncateToolMessage(
  msg: PromptMessage,
  options: ContextProjectionOptions = {},
): PromptMessage {
  if (msg.role !== "tool") return msg;

  const maxChars = options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const headChars = options.toolResultHeadChars ?? DEFAULT_TOOL_RESULT_HEAD_CHARS;
  const tailChars = options.toolResultTailChars ?? DEFAULT_TOOL_RESULT_TAIL_CHARS;

  if (msg.content.length <= maxChars) {
    return msg;
  }

  const total = msg.content.length;
  const head = msg.content.slice(0, headChars);
  const tail = msg.content.slice(-tailChars);

  const notice = `\n\n... [Tool result truncated: retained first ${headChars} and last ${tailChars} of ${total} total characters. Authoritative complete output preserved in execution store.] ...\n\n`;

  return {
    ...msg,
    content: `${head}${notice}${tail}`,
  };
}

/**
 * 将原始消息历史投影为模型可见的消息列表。
 *
 * 保证：
 * 1. 过滤被标记隐藏的消息（hiddenMessageIds 或 filter）；
 * 2. 级联隐藏：如果 assistant 包含 tool_calls 被隐藏，其工具结果亦被隐藏；
 * 3. 严格配对（默认开启）：剔除孤立的 tool 消息，剔除缺少对应 tool 响应的不完整 assistant 调用；
 * 4. 超大工具结果截断保护；
 * 5. 纯函数操作，不修改原输入数组。
 */
export function projectContextToModelVisible(
  messages: PromptMessage[],
  options: ContextProjectionOptions = {},
): PromptMessage[] {
  const {
    hiddenMessageIds,
    filter,
    enforceStrictToolPairing = true,
  } = options;

  const isVisible = (m: PromptMessage, idx: number): boolean => {
    if (m.id && hiddenMessageIds?.has(m.id)) return false;
    if (filter && !filter(m, idx)) return false;
    return true;
  };

  const groups = groupMessagesByToolBoundary(messages);
  const projected: PromptMessage[] = [];

  for (const group of groups) {
    // 检查组内第一条消息是否可见
    const lead = group[0]!;
    if (!isVisible(lead, messages.indexOf(lead))) {
      // 头部隐藏（例如 assistant 被隐藏），整组放弃（包括下游 tool 消息）
      continue;
    }

    if (lead.role === "assistant" && lead.toolCalls && lead.toolCalls.length > 0) {
      if (enforceStrictToolPairing) {
        const callIds = new Set(lead.toolCalls.map((c) => c.id));
        const toolMessages = group.slice(1);
        const presentToolCallIds = new Set(
          toolMessages
            .filter((m) => m.role === "tool" && m.toolCallId && isVisible(m, messages.indexOf(m)))
            .map((m) => m.toolCallId!),
        );

        // 如果并非所有 tool_calls 都有可见的 tool 响应，则丢弃该不完整调用组以防 Provider 400
        const isComplete = Array.from(callIds).every((id) => presentToolCallIds.has(id));
        if (!isComplete) {
          continue;
        }

        // 仅保留可见并截断的 tool 消息
        const sanitizedTools = toolMessages
          .filter((m) => isVisible(m, messages.indexOf(m)))
          .map((m) => truncateToolMessage(m, options));

        projected.push(lead, ...sanitizedTools);
      } else {
        const sanitizedTools = group.slice(1)
          .filter((m) => isVisible(m, messages.indexOf(m)))
          .map((m) => truncateToolMessage(m, options));
        projected.push(lead, ...sanitizedTools);
      }
      continue;
    }

    // 孤立的 tool 消息（未挂载在包含 toolCalls 的 assistant 下）
    if (lead.role === "tool") {
      if (enforceStrictToolPairing) {
        // 孤立 tool 消息直接丢弃
        continue;
      }
      projected.push(truncateToolMessage(lead, options));
      continue;
    }

    // 普通消息 (system, user, 普通 assistant)
    projected.push(lead);
  }

  return projected;
}
