/**
 * Aervox｜思隅 @aervox/agent-loop — 上下文组装器（阶段 1 最小实现 + 阶段 5a Inbox 注入）
 *
 * 把 Turn 输入组装为 Provider 上下文；历史消息、记忆投影与 Skill 渐进式披露
 * 在阶段 2/5 经 ContextBuilderPort 逐步扩展。§7.1 Context 组装顺序第 7 项：
 * 「当前可消费 inbox item」——阶段 5a 起 inbox 项可作为追加输入注入。
 */
import type { AgentInboxItem, PromptContext, PromptMessage } from "./types.js";
import type { ContextBuilderPort } from "./ports.js";

/** 默认 builder：仅透传原始输入（inbox 项不注入，由宿主按需开启） */
export const defaultContextBuilder: ContextBuilderPort = {
  build(input: {
    turnId: string;
    sessionId: string;
    messages: PromptMessage[];
    inboxItems?: AgentInboxItem[];
  }): PromptContext {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      messages: input.messages,
    };
  },
};

/** 从 inbox 项构造追加输入消息（§7.1 第 7 项；附来源与用途标注） */
export function inboxItemsToMessages(items: AgentInboxItem[]): PromptMessage[] {
  const messages: PromptMessage[] = [];
  for (const item of items) {
    const prefix = `[inbox:${item.type}@${item.sourceActor}]`;
    let content = `${prefix} ${typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload)}`;
    if (item.type === "steer") content = `${content}\n（这用于调整当前任务的下一步方向。）`;
    messages.push({ role: "user", content });
  }
  return messages;
}

/**
 * 阶段 5a：启用 Inbox 注入的 builder。
 * - 透传 base 的组装逻辑；
 * - 在构建时将本次 Step 可消费的 inbox 项作为追加 user 消息（§7.1 第 7 项）注入。
 * 使用方（宿主）负责 claim/ack 与幂等边界。
 */
export function createInboxAwareContextBuilder(
  base: ContextBuilderPort = defaultContextBuilder,
): ContextBuilderPort {
  return {
    build(input: {
      turnId: string;
      sessionId: string;
      messages: PromptMessage[];
      inboxItems?: AgentInboxItem[];
    }): PromptContext {
      const inboxMessages = inboxItemsToMessages(input.inboxItems ?? []);
      const baseInput = {
        turnId: input.turnId,
        sessionId: input.sessionId,
        messages: [...inboxMessages, ...input.messages],
      };
      return base.build(baseInput);
    },
  };
}