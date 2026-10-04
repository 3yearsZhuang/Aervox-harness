/**
 * Aervox｜思隅 @aervox/core — ExecuteResult 终态命名对齐（ITER-042）
 *
 * ITER-041 遗留交付项③：`ExecuteResult` 原以 `failed` 承载库内 `Interrupted` 终态，
 * 命名与数据模型不一致。本文件锁定收敛后的对齐契约 —— **返回值 status 与 Attempt
 * 收敛的库内终态一一镜像，分界以 DB 收敛状态为准，不按「是否出错」**：
 * - 库内 `Interrupted`（预算 / 截止 / 删除水位 / turn 超时 / max_steps / 待授权）→ `interrupted`；
 * - 库内 `Failed`（tools_disabled / execution error）或本 runner 未能终态化
 *   （lease_lost、finalize contested，另见 executor-fencing / lease-guard 用例）→ `failed`。
 */
import { describe, expect, it } from "vitest";
import { createControlContext, defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort } from "../src/index.js";

const toolCallProvider = (): ModelProviderPort => ({
  id: "tool-caller",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [{ id: "call_1", name: "notes_search", arguments: { query: "x" } }],
    };
  },
});

describe("ExecuteResult 终态命名对齐（ITER-042）", () => {
  it("库内 Interrupted ↔ 返回 interrupted：预算耗尽收敛，reason 保留", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_it42a", turnId: "turn_it42a" });
    const control = createControlContext({ tokenBudget: { maxTokens: 1, usedTokens: 0 } });
    const result = await executeTurn(
      { execution: store, provider: toolCallProvider(), contextBuilder: defaultContextBuilder, controlContext: control },
      { turnId: "turn_it42a", sessionId: "sess_it42", attemptId: "atp_it42a", userMessage: "x" },
    );
    control.dispose();
    expect(result).toMatchObject({ status: "interrupted", reason: "budget_exhausted" });
    expect(store.attemptStatus("atp_it42a")).toBe("Interrupted");
  });

  it("库内 Failed ↔ 返回 failed：未配置工具却收到工具请求（fail-closed）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_it42b", turnId: "turn_it42b" });
    const result = await executeTurn(
      { execution: store, provider: toolCallProvider(), contextBuilder: defaultContextBuilder },
      { turnId: "turn_it42b", sessionId: "sess_it42", attemptId: "atp_it42b", userMessage: "x" },
    );
    expect(result).toMatchObject({ status: "failed", reason: "tools_disabled" });
    expect(store.attemptStatus("atp_it42b")).toBe("Failed");
  });
});
