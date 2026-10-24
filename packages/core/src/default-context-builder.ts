import type { ContextBuilderPort } from "./ports.js";
import type { PromptContext } from "./types.js";

/** 默认 builder：仅透传原始输入（inbox 项不注入，由宿主按需开启） */
export const defaultContextBuilder: ContextBuilderPort = {
  build(input: Parameters<ContextBuilderPort["build"]>[0]): PromptContext {
    return {
      turnId: input.turnId,
      sessionId: input.sessionId,
      messages: input.messages,
    };
  },
};
