/**
 * Aervox｜思隅 @aervox/agent-loop — Provider 终止语义 parity（AVX-HAR-001 §16.1 agent-loop-provider-parity）
 *
 * 覆盖 §14 适配边界与 §5.3 终止原因映射的「规约面」：
 * - 不同 Loop/Provider 实现必须把终止原因规范化为 Aervox 语义（parity 表）；
 * - 当前以 Native（Replay）为基线断言终止语义；DSH/pi 适配器落地后对照本表（插槽预留）。
 */
import { describe, expect, it } from "vitest";
import { createReplayProvider, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort } from "../src/index.js";

/**
 * 终止语义 parity 表（§5.3）：Loop 终止原因 → Turn 映射 → done.status。
 * 任何 Loop Driver/对模型 Provider 的适配必须产出本表中的规范化结果。
 */
export const TERMINATION_PARITY = [
  { reason: "completed", turnStatus: "Completed", doneStatus: "Completed", isComplete: true },
  { reason: "cancelled", turnStatus: "Cancelled", doneStatus: "Cancelled", isComplete: false },
  { reason: "max_steps", turnStatus: "Interrupted", doneStatus: "Interrupted", isComplete: false },
  { reason: "turn_timeout", turnStatus: "Interrupted", doneStatus: "Interrupted", isComplete: false },
  { reason: "repeat_tool", turnStatus: "Interrupted", doneStatus: "Interrupted", isComplete: false },
  { reason: "deletion_blocked", turnStatus: "Interrupted", doneStatus: "Interrupted", isComplete: false },
] as const;

describe("Provider 终止语义 parity（agent-loop-provider-parity）", () => {
  it("parity 表自洽：5.3 终止原因均有规范化映射", () => {
    const reasons = TERMINATION_PARITY.map((t) => t.reason);
    expect(reasons).toEqual([
      "completed",
      "cancelled",
      "max_steps",
      "turn_timeout",
      "repeat_tool",
      "deletion_blocked",
    ]);
  });

  it("Native（Replay）基线：正常完成 → parity 表中 completed 语义", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_pa", turnId: "turn_pa" });
    const result = await executeTurn(
      { execution: store, provider: createReplayProvider(), contextBuilder: { build: (c) => ({ turnId: c.turnId, sessionId: c.sessionId, messages: c.messages }) } },
      { turnId: "turn_pa", sessionId: "sess_pa", attemptId: "atp_pa", userMessage: "hi" },
    );
    expect(result.status).toBe("completed");
    const done = (await store.listEvents("turn_pa")).find((e) => e.eventType === "done");
    const entry = TERMINATION_PARITY.find((t) => t.reason === "completed")!;
    expect((done?.data as { status: string }).status).toBe(entry.doneStatus);
  });

  it("第三方适配插槽：chunk 归一化契约（DSH/pi 实现须满足同构字段）", async () => {
    // DSH/pi Adapter（阶段 4/5）必须把外部事件规范化为 ModelChunk 面：
    // { text, isFinal, toolCalls? }。此处以结构化 Provider 验证契约形状被解析器接受。
    const custom: ModelProviderPort = {
      id: "external-parity",
      async *stream(): AsyncIterable<ModelChunk> {
        yield { text: "external", isFinal: true };
      },
    };
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_pb", turnId: "turn_pb" });
    const result = await executeTurn(
      { execution: store, provider: custom, contextBuilder: { build: (c) => ({ turnId: c.turnId, sessionId: c.sessionId, messages: c.messages }) } },
      { turnId: "turn_pb", sessionId: "sess_pb", attemptId: "atp_pb", userMessage: "x" },
    );
    expect(result.status).toBe("completed");
  });
});