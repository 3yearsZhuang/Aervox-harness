/**
 * Aervox｜思隅 @aervox/agent-loop — Replay Provider（阶段 1）
 *
 * 用固定夹具产出确定性文本流，供契约测试与 API 端到端验证；
 * 真实模型 Provider（内部 LLM / DeepSeek 等）在后续阶段经 ModelProviderPort 接入，
 * Agent Loop 核心控制流不变。
 */
import type { ModelProviderPort } from "./ports.js";

/** 固定回放夹具：每个元素一块文本，末块 isFinal=true */
export const REPLAY_FIXTURE: readonly string[] = [
  "收到！这个问题我记下了。",
  "（阶段 1 回放回答）我会帮你把复习计划排好。",
];

/** 以固定夹具构造一个确定性 Provider */
export function createReplayProvider(fixture: readonly string[] = REPLAY_FIXTURE): ModelProviderPort {
  return {
    id: "replay",
    async *stream(): AsyncIterable<{ text: string; isFinal: boolean }> {
      for (let i = 0; i < fixture.length; i += 1) {
        const part = fixture[i];
        if (part === undefined) return;
        yield { text: part, isFinal: i === fixture.length - 1 };
      }
    },
  };
}