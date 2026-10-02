/**
 * Aervox｜思隅 @aervox/core — 工具调用去重键稳定性测试
 *
 * 背景（缺陷 D-KEY）：去重键原为 `${name}:${JSON.stringify(args)}`，对对象键序敏感。
 * `{query:"x",limit:10}` 与 `{limit:10,query:"x"}` 语义完全相同，但序列化结果不同，
 * 于是同一逻辑调用被当作两次不同调用执行 —— 幂等账本被绕过，副作用可能重复发生。
 *
 * 本文件锁定稳定序列化契约：
 * - 键序无关：同一语义参数无论书写顺序如何，去重键必须一致；
 * - 嵌套结构：嵌套对象的键序同样无关；
 * - 数组保序：`[1,2]` 与 `[2,1]` 语义不同，必须是不同去重键。
 *
 * 已知独立缺陷（不在D-KEY 范围，另记于executor 侧）：
 * 循环引用 arguments 会在写 `tool_request` 事件时被 `JSON.stringify` 抛
 * （"Converting circular structure to JSON"），导致整 Turn 收敛为 execution error。
 * 那是事件序列化路径的问题，与去重键无关，故此处不对其行为作断言。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const turn = { turnId: "turn_key", sessionId: "sess_key", attemptId: "atp_key", userMessage: "查笔记" };

const toolProvider = (executionLog: { name: string }[]): ToolProviderPort => ({
  tools: [{ name: "notes_search", description: "x", readOnly: true }],
  async execute(input) {
    executionLog.push({ name: input.name });
    return { ok: true, output: { hits: 1 } };
  },
});

/** 一次 Step 内以不同键序发出两次语义相同的工具调用 */
const reorderedArgsProvider = (): ModelProviderPort => ({
  id: "reordered-args",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [
        { id: "call_1", name: "notes_search", arguments: { query: "复习", limit: 10 } },
        { id: "call_2", name: "notes_search", arguments: { limit: 10, query: "复习" } },
      ],
    };
  },
});

/** 嵌套对象的键序差异 */
const nestedReorderProvider = (): ModelProviderPort => ({
  id: "nested-reorder",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [
        { id: "call_1", name: "notes_search", arguments: { filter: { tag: "x", page: 1 } } },
        { id: "call_2", name: "notes_search", arguments: { filter: { page: 1, tag: "x" } } },
      ],
    };
  },
});

/** 数组顺序不同 → 语义不同，必须各自执行 */
const arrayOrderProvider = (): ModelProviderPort => ({
  id: "array-order",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: [
        { id: "call_1", name: "notes_search", arguments: { ids: [1, 2] } },
        { id: "call_2", name: "notes_search", arguments: { ids: [2, 1] } },
      ],
    };
  },
});

const runOnce = async (provider: ModelProviderPort): Promise<{ log: { name: string }[]; store: InMemoryExecutionStore }> => {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
  const log: { name: string }[] = [];
  await executeTurn(
    { execution: store, provider, contextBuilder: defaultContextBuilder, tools: toolProvider(log), options: { maxSteps: 1 } },
    turn,
  );
  return { log, store };
};

describe("工具调用去重键：稳定序列化（缺陷 D-KEY）", () => {
  it("键序不同的等价参数被识别为重复调用，只执行一次", async () => {
    const { log, store } = await runOnce(reorderedArgsProvider());

    expect(log).toHaveLength(1);
    const records = store.toolExecutionRecords();
    expect(records.map((r) => r.status).sort()).toEqual(["duplicate", "executed"]);
  });

  it("嵌套对象键序不同同样被识别为重复调用", async () => {
    const { log, store } = await runOnce(nestedReorderProvider());

    expect(log).toHaveLength(1);
    const records = store.toolExecutionRecords();
    expect(records.map((r) => r.status).sort()).toEqual(["duplicate", "executed"]);
  });

  it("数组顺序不同视为不同调用（保序不被归一化掉）", async () => {
    const { log, store } = await runOnce(arrayOrderProvider());

    expect(log).toHaveLength(2);
    const records = store.toolExecutionRecords();
    expect(records.map((r) => r.status)).toEqual(["executed", "executed"]);
  });
});
