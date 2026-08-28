/**
 * Aervox｜思隅 @aervox/agent-loop — Replay / 脚本化 Provider（阶段 1+2）
 *
 * - 纯文本夹具（阶段 1）：多 chunk 文本流，末块 isFinal=true，确定性；
 * - 脚本化夹具（阶段 2）：按 Step 编写「文本 + toolCalls」，用于验证
 *   多 Step Loop 的两步工具链、工具失败、maxSteps 等固定场景；
 * - 真实模型 Provider 在后续阶段经 ModelProviderPort 接入，Loop 控制流不变。
 */
import type { ModelProviderPort } from "./ports.js";
import type { ModelChunk, ToolCallRequest } from "./types.js";

/** 阶段 1 纯文本固定夹具：每个元素一块文本，末块 isFinal=true */
export const REPLAY_FIXTURE: readonly string[] = [
  "收到！这个问题我记下了。",
  "（阶段 1 回放回答）我会帮你把复习计划排好。",
];

/** 阶段 2 脚本 Step：一次模型输出 = 可选文本 + 可选工具请求 */
export interface ReplayStep {
  text?: string;
  toolCalls?: ToolCallRequest[];
}

export const TEXT_ONLY_STEP: ReplayStep = { text: "（无工具回答）完成。" };

/** 以文本数组构造确定性 Provider（阶段 1 兼容） */
export function createReplayProvider(fixture: readonly string[] = REPLAY_FIXTURE): ModelProviderPort {
  return {
    id: "replay",
    async *stream(): AsyncIterable<ModelChunk> {
      for (let i = 0; i < fixture.length; i += 1) {
        const part = fixture[i];
        if (part === undefined) return;
        yield { text: part, isFinal: i === fixture.length - 1 };
      }
    },
  };
}

/** 以 Step 脚本构造多轮 Provider：每次 stream 按 request.step 返回对应 Step，末轮携带工具请求 */
export function createScriptedProvider(script: readonly ReplayStep[]): ModelProviderPort {
  return {
    id: "scripted",
    async *stream(request: import("./types.js").ModelRequest): AsyncIterable<ModelChunk> {
      const step = script[request.step - 1];
      if (!step) return;
      yield {
        text: step.text ?? "",
        isFinal: true,
        toolCalls: step.toolCalls,
      };
    },
  };
}