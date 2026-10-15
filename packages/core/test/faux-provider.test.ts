import { describe, expect, it } from "vitest";
import { createFauxProvider, type ModelChunk, type ModelRequest } from "../src/index.js";

const baseRequest: ModelRequest = {
  turnId: "turn_test",
  attemptId: "atp_test",
  step: 1,
  context: {
    turnId: "turn_test",
    sessionId: "sess_test",
    messages: [{ role: "user", content: "hello" }],
  },
};

describe("createFauxProvider (PI-01 对照与标准化测试夹具)", () => {
  it("显式声明能力与容量", () => {
    const provider = createFauxProvider({
      capabilities: {
        toolCalls: true,
        reasoning: true,
        contextWindowTokens: 65536,
        maxOutputTokens: 8192,
      },
    });

    expect(provider.capabilities).toEqual({
      toolCalls: true,
      reasoning: true,
      contextWindowTokens: 65536,
      maxOutputTokens: 8192,
    });
  });

  it("声明式输出步骤并完整保留 reasoning、toolCalls、usage 与 stopReason", async () => {
    const provider = createFauxProvider({
      steps: [
        [
          { reasoning: "Thinking deeply...", isFinal: false },
          { text: "Here is ", isFinal: false },
          {
            text: "the answer.",
            isFinal: true,
            stopReason: "stop",
            usage: {
              totalTokens: 42,
              promptTokens: 30,
              completionTokens: 12,
              cacheReadTokens: 10,
            },
          },
        ],
      ],
    });

    const chunks: ModelChunk[] = [];
    for await (const chunk of provider.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ reasoning: "Thinking deeply...", isFinal: false, text: "" });
    expect(chunks[1]).toMatchObject({ text: "Here is ", isFinal: false });
    expect(chunks[2]).toMatchObject({
      text: "the answer.",
      isFinal: true,
      stopReason: "stop",
      usage: {
        totalTokens: 42,
        promptTokens: 30,
        completionTokens: 12,
        cacheReadTokens: 10,
      },
    });
  });

  it("支持工具请求输出与 tool_calls 终止原因", async () => {
    const provider = createFauxProvider({
      steps: [
        {
          text: "Let me check the weather.",
          isFinal: true,
          stopReason: "tool_calls",
          toolCalls: [
            { id: "call_1", name: "get_weather", arguments: { city: "Hangzhou" } },
          ],
        },
      ],
    });

    const chunks: ModelChunk[] = [];
    for await (const chunk of provider.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      isFinal: true,
      stopReason: "tool_calls",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Hangzhou" } }],
    });
  });

  it("在指定步骤注入错误", async () => {
    const provider = createFauxProvider({
      errorOnStep: 2,
      errorMessage: "step_2_failed",
      steps: [
        { text: "step 1 ok", isFinal: true },
        { text: "step 2 should fail", isFinal: true },
      ],
    });

    // Step 1: 正常
    const chunks: ModelChunk[] = [];
    for await (const chunk of provider.stream({ ...baseRequest, step: 1 })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);

    // Step 2: 注入错误
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.stream({ ...baseRequest, step: 2 })) {
        // should throw
      }
    }).rejects.toThrow("step_2_failed");
  });

  it("响应取消信号中断", async () => {
    const controller = new AbortController();
    const provider = createFauxProvider({
      steps: [
        [
          { text: "first", delayMs: 10 },
          { text: "second", delayMs: 50 },
        ],
      ],
    });

    setTimeout(() => controller.abort(), 20);

    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of provider.stream({ ...baseRequest, signal: controller.signal })) {
        // iterating
      }
    }).rejects.toThrow("model_aborted");
  });
});
