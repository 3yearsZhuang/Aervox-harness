/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 2c 幂等预留与未知结果测试
 *
 * 覆盖 AVX-HAR-001 §9（idempotency reservation）与 §11.3（unknown outcome）：
 * - 工具执行前写入 pending 预留，执行后以权威结果收口（同一行）；
 * - 重复调用不重复执行（duplicate 独立留痕）；
 * - 崩溃释放后遗留 pending → outcome_unknown（合成结果语义，不自动重放）。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const turn = { turnId: "turn_2c", sessionId: "sess_2c", attemptId: "atp_2c", userMessage: "查笔记" };

const toolProvider = (executionLog: { name: string }[]): ToolProviderPort => ({
  tools: [{ name: "notes_search", description: "x", readOnly: true }],
  async execute(input) {
    executionLog.push({ name: input.name });
    return { ok: true, output: { hits: 1 } };
  },
});

const singleToolProvider = (): ModelProviderPort => ({
  id: "single-tool",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [{ id: "call_1", name: "notes_search", arguments: { query: "复习" } }],
    };
  },
});

/** 同一 callId 请求两次的 Provider */
const dupCallProvider = (): ModelProviderPort => ({
  id: "dup-call",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [
        { id: "call_1", name: "notes_search", arguments: { query: "复习" } },
        { id: "call_1", name: "notes_search", arguments: { query: "复习" } },
      ],
    };
  },
});

describe("阶段 2c 工具幂等预留与未知结果", () => {
  it("预留→执行→收口：账本仅一行且为 executed（§9 权威结果）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    const log: { name: string }[] = [];

    const result = await executeTurn(
      { execution: store, provider: singleToolProvider(), contextBuilder: defaultContextBuilder, tools: toolProvider(log), options: { maxSteps: 1 } },
      turn,
    );

    expect(result.status).toBe("failed"); // 单批工具后无后续 Step → 预算收敛
    const records = store.toolExecutionRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("executed");
    expect(records[0]?.invocationId).toBe("call_1");
  });

  it("同一 callId 重复不留痕执行：只执行一次，重复以 duplicate 独立留痕", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    const log: { name: string }[] = [];

    await executeTurn(
      { execution: store, provider: dupCallProvider(), contextBuilder: defaultContextBuilder, tools: toolProvider(log), options: { maxSteps: 1 } },
      turn,
    );

    expect(log).toHaveLength(1); // 工具只执行一次
    const records = store.toolExecutionRecords();
    expect(records.map((r) => r.status).sort()).toEqual(["duplicate", "executed"]);
  });

  it("崩溃释放后遗留 pending → outcome_unknown（不自动重放）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    // 直接模拟：预留后未收口（进程崩溃），恢复器标记未知
    await store.reserveToolExecution({
      turnId: turn.turnId,
      attemptId: turn.attemptId,
      invocationId: "call_crash",
      name: "notes_search",
      arguments: {},
    });
    store.markAllPendingUnknown(turn.attemptId);
    const records = store.toolExecutionRecords();
    expect(records[0]?.status).toBe("outcome_unknown");
  });
});