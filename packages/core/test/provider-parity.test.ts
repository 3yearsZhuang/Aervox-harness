/**
 * Aervox｜思隅 @aervox/core — Provider 终止语义 parity（AVX-HAR-001 §16.1 agent-loop-provider-parity）
 *
 * 覆盖 §14 适配边界与 §5.3 终止原因映射的「规约面」：
 * - 不同 Loop/Provider 实现必须把终止原因规范化为 Aervox 语义（parity 表）；
 * - 当前以 Native（Replay）为基线断言终止语义；DSH/pi 适配器落地后对照本表（插槽预留）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createFauxProvider,
  createOpenAICompatProvider,
  createReplayProvider,
  executeTurn,
  InMemoryExecutionStore,
} from "../src/index.js";
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

  it("阶段 4 退出条件：切换 Loop Driver 不改客户端事件流契约骨架", async () => {
    // AVX-HAR-001 §13 阶段 4 退出条件：切换 Driver 不改变客户端契约。
    // 不论 provider 是 Replay（原生回退）还是注入式 custom，事件流骨架一致：
    // 首事件 message（assistant 身份）→ 中间 0..N 个 delta（文本片段）→ 末事件 done（终态）。
    // 事件类型集合 ⊆ 契约枚举 {message, delta, tool_request, tool_result, done, error}。
    const ctxBuilder = { build: (c: { turnId: string; sessionId: string; messages: { role: string; content: string }[] }) => ({ turnId: c.turnId, sessionId: c.sessionId, messages: c.messages }) };

    const replayStore = new InMemoryExecutionStore();
    replayStore.seedAttempt({ id: "atp_exit_replay", turnId: "turn_exit_replay" });
    await executeTurn(
      { execution: replayStore, provider: createReplayProvider(), contextBuilder: ctxBuilder },
      { turnId: "turn_exit_replay", sessionId: "sess_exit", attemptId: "atp_exit_replay", userMessage: "hi" },
    );
    const replayEvents = await replayStore.listEvents("turn_exit_replay");

    const custom: ModelProviderPort = {
      id: "exit-custom",
      async *stream(): AsyncIterable<ModelChunk> {
        yield { text: "a", isFinal: false };
        yield { text: "b", isFinal: true };
      },
    };
    const customStore = new InMemoryExecutionStore();
    customStore.seedAttempt({ id: "atp_exit_custom", turnId: "turn_exit_custom" });
    await executeTurn(
      { execution: customStore, provider: custom, contextBuilder: ctxBuilder },
      { turnId: "turn_exit_custom", sessionId: "sess_exit", attemptId: "atp_exit_custom", userMessage: "hi" },
    );
    const customEvents = await customStore.listEvents("turn_exit_custom");

    // 契约枚举（AVX-HAR-001 流式协议）
    const ALLOWED = new Set(["message", "delta", "tool_request", "tool_result", "done", "error"]);
    const assertContract = (events: { eventType: string }[]) => {
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => ALLOWED.has(e.eventType))).toBe(true);
      expect(events[0].eventType).toBe("message");
      expect(events.at(-1)?.eventType).toBe("done");
    };
    assertContract(replayEvents);
    assertContract(customEvents);
    // 两侧骨架同构：首 message / 末 done / 中间全为 delta（本例无工具调用）
    expect(replayEvents.filter((e) => e.eventType === "delta").length).toBeGreaterThan(0);
    expect(customEvents.filter((e) => e.eventType === "delta").length).toBeGreaterThan(0);
  });

  it("Faux and OpenAICompat normalize length and retain persisted usage", async () => {
    const ctxBuilder = { build: (c: { turnId: string; sessionId: string; messages: { role: string; content: string }[] }) => ({ turnId: c.turnId, sessionId: c.sessionId, messages: c.messages }) };

    // 1. FauxProvider 路径
    const fauxUsage = {
      totalTokens: 100,
      promptTokens: 80,
      completionTokens: 20,
      cacheReadTokens: 15,
      cacheWriteTokens: 5,
    };
    const fauxProvider = createFauxProvider({
      steps: [
        {
          text: "Truncated output...",
          isFinal: true,
          stopReason: "length",
          usage: fauxUsage,
        },
      ],
    });

    const fauxStore = new InMemoryExecutionStore();
    fauxStore.seedAttempt({ id: "atp_faux", turnId: "turn_faux" });
    const fauxResult = await executeTurn(
      { execution: fauxStore, provider: fauxProvider, contextBuilder: ctxBuilder },
      { turnId: "turn_faux", sessionId: "sess_faux", attemptId: "atp_faux", userMessage: "test length" },
    );

    expect(fauxResult.status).toBe("interrupted");
    if (fauxResult.status === "interrupted") {
      expect(fauxResult.reason).toBe("model_length");
    }

    // 2. OpenAICompatProvider 路径（模拟 finish_reason: "length" 与 usage）
    const sseLines = [
      `data: ${JSON.stringify({ id: "1", choices: [{ delta: { content: "Truncated output..." }, finish_reason: "length" }] })}\n\n`,
      `data: ${JSON.stringify({ usage: { total_tokens: 100, prompt_tokens: 80, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 15 }, cache_creation_input_tokens: 5 } })}\n\n`,
      `data: [DONE]\n\n`,
    ];

    const openAiProvider = createOpenAICompatProvider({
      baseUrl: "http://mock-api/v1",
      modelId: "test-model",
    });

    // 拦截全局 fetch 返回 sseLines
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of sseLines) {
              controller.enqueue(new TextEncoder().encode(line));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    try {
      const openAiStore = new InMemoryExecutionStore();
      openAiStore.seedAttempt({ id: "atp_openai", turnId: "turn_openai" });
      const openAiResult = await executeTurn(
        { execution: openAiStore, provider: openAiProvider, contextBuilder: ctxBuilder },
        { turnId: "turn_openai", sessionId: "sess_openai", attemptId: "atp_openai", userMessage: "test length" },
      );

      expect(openAiResult.status).toBe("interrupted");
      if (openAiResult.status === "interrupted") {
        expect(openAiResult.reason).toBe("model_length");
      }

      // 两侧终态语义完全等价
      expect(fauxResult.status).toBe(openAiResult.status);
      expect(fauxStore.modelRunRecords()[0]?.usage).toEqual(fauxUsage);
      expect(openAiStore.modelRunRecords()[0]?.usage).toEqual(fauxUsage);
      expect(openAiStore.modelRunRecords()[0]?.usage?.totalTokens).toBe(100);
      if (fauxResult.status === "interrupted" && openAiResult.status === "interrupted") {
        expect(fauxResult.reason).toBe(openAiResult.reason);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("Faux and OpenAICompat normalize content_filter and persist cache usage", async () => {
    const ctxBuilder = { build: (c: { turnId: string; sessionId: string; messages: { role: string; content: string }[] }) => ({ turnId: c.turnId, sessionId: c.sessionId, messages: c.messages }) };

    const fauxProvider = createFauxProvider({
      steps: [
        {
          text: "sensitive text should be discarded",
          isFinal: true,
          stopReason: "content_filter",
          usage: { totalTokens: 15, promptTokens: 10, completionTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2 },
        },
      ],
    });

    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_cf", turnId: "turn_cf" });
    const result = await executeTurn(
      { execution: store, provider: fauxProvider, contextBuilder: ctxBuilder },
      { turnId: "turn_cf", sessionId: "sess_cf", attemptId: "atp_cf", userMessage: "test filter" },
    );

    expect(result.status).toBe("interrupted");
    if (result.status === "interrupted") {
      expect(result.reason).toBe("model_content_filter");
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"sensitive text should be discarded"},"finish_reason":"content_filter"}]}\n\n'
      + 'data: {"usage":{"total_tokens":15,"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4},"cache_creation_input_tokens":2}}\n\n'
      + 'data: [DONE]\n\n',
    )));
    try {
      const openaiStore = new InMemoryExecutionStore();
      openaiStore.seedAttempt({ id: "atp_cf_compat", turnId: "turn_cf_compat" });
      const compatResult = await executeTurn(
        { execution: openaiStore, provider: createOpenAICompatProvider({ baseUrl: "http://mock-api/v1", modelId: "test" }), contextBuilder: ctxBuilder },
        { turnId: "turn_cf_compat", sessionId: "sess_cf", attemptId: "atp_cf_compat", userMessage: "test filter" },
      );
      expect(compatResult).toMatchObject({ status: "interrupted", reason: "model_content_filter" });
      expect(openaiStore.modelRunRecords()[0]?.usage).toEqual(store.modelRunRecords()[0]?.usage);
      expect(openaiStore.modelRunRecords()[0]?.usage).toEqual({ totalTokens: 15, promptTokens: 10, completionTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 2 });
    } finally { vi.unstubAllGlobals(); }
  });
});
