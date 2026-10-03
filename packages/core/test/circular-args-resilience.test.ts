/**
 * Aervox｜思隅 @aervox/core — 循环引用工具参数不致命（缺陷 D-CIRC）
 *
 * 背景：模型可能返回自引用的 `arguments`（`{self:{...self}}`）。原实现里
 * 预算计量一行 `JSON.stringify(chunk.toolCalls)` 位于 `for await` 流式循环内，
 * 遇循环引用直接抛 `Converting circular structure to JSON`，逃出 collectStep，
 * 整 Turn 收敛为 `execution error` —— 一个**计量偏差**被放大成了**整轮执行失败**。
 *
 * 更糟的是：tool_request 事件与工具账本都会携带 `arguments`，若用同样的直接
 * 序列化落事件，崩溃点会前移到写事件之前，工具账本留下不了任何痕迹
 * （`inspectToolInput` 虽能判`circular_reference_detected`，但它在校验之前就已崩）。
 *
 * 本文件锁定：循环引用参数是**可降级的输入异常**，不是致命错误 ——
 * - 不抛异常、不使 Turn 崩溃；
 * - 工具不被执行（入参不安全，本就不应执行）；
 * - 事件与账本仍留痕（可审计），而非静默丢弃。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const turn = { turnId: "turn_circ", sessionId: "sess_circ", attemptId: "atp_circ", userMessage: "写点东西" };

/** 返回自引用 arguments 的 Provider（模拟模型输出畸形参数） */
const circularArgsProvider = (): ModelProviderPort => ({
  id: "circular-args",
  async *stream(): AsyncIterable<ModelChunk> {
    const circular: Record<string, unknown> = { content: "x" };
    circular.self = circular;
    yield {
      text: "",
      isFinal: true,
      toolCalls: [{ id: "call_circ", name: "save_memory_note", arguments: circular }],
    };
  },
});

/** 深度自引用（对象套对象再套回来），验证不只是单层自引用被处理 */
const deepCircularProvider = (): ModelProviderPort => ({
  id: "deep-circular",
  async *stream(): AsyncIterable<ModelChunk> {
    const inner: Record<string, unknown> = { value: 1 };
    const outer: Record<string, unknown> = { child: inner };
    inner.parent = outer;
    yield {
      text: "",
      isFinal: true,
      toolCalls: [{ id: "call_deep", name: "save_memory_note", arguments: outer }],
    };
  },
});

const runWithCircular = async (
  provider: ModelProviderPort,
): Promise<{ log: string[]; store: InMemoryExecutionStore; result: Awaited<ReturnType<typeof executeTurn>> }> => {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
  const log: string[] = [];
  const tools: ToolProviderPort = {
    tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
    async execute(input) {
      log.push(input.name);
      return { ok: true, output: { saved: true } };
    },
  };
  const result = await executeTurn(
    { execution: store, provider, contextBuilder: defaultContextBuilder, tools, options: { maxSteps: 1 } },
    turn,
  );
  return { log, store, result };
};

describe("循环引用工具参数：可降级输入异常（缺陷 D-CIRC）", () => {
  it("单层自引用：不抛异常，Turn 不收敛为 execution error", async () => {
    const { result } = await runWithCircular(circularArgsProvider());
    expect(result.reason).not.toBe("execution error");
  });

  it("单层自引用：工具不被执行（入参不安全本就不应执行）", async () => {
    const { log } = await runWithCircular(circularArgsProvider());
    expect(log).toEqual([]);
  });

  it("单层自引用：tool_request 事件仍留痕（可审计，非静默丢弃）", async () => {
    const { store } = await runWithCircular(circularArgsProvider());
    const events = await store.listEvents(turn.turnId);
    expect(events.some((e) => e.eventType === "tool_request")).toBe(true);
  });

  it("深度自引用同样被降级，不崩溃", async () => {
    const { result, log } = await runWithCircular(deepCircularProvider());
    expect(result.reason).not.toBe("execution error");
    expect(log).toEqual([]);
  });

  it("正常参数不受影响（回归护栏：非循环引用路径行为不变）", async () => {
    const normal: ModelProviderPort = {
      id: "normal",
      async *stream(): AsyncIterable<ModelChunk> {
        yield {
          text: "",
          isFinal: true,
          toolCalls: [{ id: "call_ok", name: "save_memory_note", arguments: { content: "正常" } }],
        };
      },
    };
    const { log, store, result } = await runWithCircular(normal);
    expect(log).toEqual(["save_memory_note"]);
    const records = store.toolExecutionRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("executed");
    expect(result.reason).toBe("max_steps");
  });
});
