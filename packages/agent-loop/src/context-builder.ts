/**
 * Aervox｜思隅 @aervox/agent-loop — 上下文组装器（阶段 1 最小实现）
 *
 * 把 Turn 输入组装为 Provider 上下文；历史消息、记忆投影与 Skill 渐进式披露
 * 在阶段 2/5 经 ContextBuilderPort 逐步扩展，本实现只透传原始输入。
 */
import type { ContextBuilderPort } from "./ports.js";
import type { PromptContext, PromptMessage } from "./types.js";

export const defaultContextBuilder: ContextBuilderPort = {
  build(input: { turnId: string; sessionId: string; messages: PromptMessage[] }): PromptContext {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      messages: input.messages,
    };
  },
};