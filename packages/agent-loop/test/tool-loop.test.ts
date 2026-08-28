/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 2 契约测试（只读工具多 Step Loop）
 *
 * 覆盖 AVX-HAR-001 §15 阶段 2 退出条件：
 * - 固定回放覆盖两步工具链 / 工具失败 / 未注册拒绝 / 重复调用 / 超时 / maxSteps；
 * - 工具请求与结果以内部事件落库（tool_request → tool_result），结果回填下一 Step；
 * - 未配置工具时工具请求 fail-closed。
 */
import { describe, expect, it } from "vitest";
import {
  createMockToolProvider,
  createScriptedProvider,
  executeTurn,
  InMemoryExecutionStore,
  defaultContextBuilder,
} from "../src/index.js";

function makeStore(turnId = "turn_t", attemptId = "atp_t") {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: attemptId, turnId });
  return store;
}

function run(store: InMemoryExecutionStore, extra: { maxSteps?: number; toolTimeoutMs?: number } = {}) {
  return executeTurn(
    {
      execution: store,
      provider: createScriptedProvider([
        { text: "让我查一下笔记。", toolCalls: [{ id: "call_1", name: "search_notes", arguments: { q: "复习计划" } }] },
        { text: "查到啦：今天复习三角函数。", toolCalls: [] },
      ]),
      contextBuilder: defaultContextBuilder,
      tools: createMockToolProvider(),
      options: extra,
    },
    { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "今天的复习计划？" },
  );
}

describe("executeTurn 阶段 2：只读工具多 Step Loop", () => {
  it("两步工具链：message → delta → tool_request → tool_result(ok) → delta(final) → done(Completed)", async () => {
    const store = makeStore();
    const result = await run(store);

    expect(result).toMatchObject({ status: "completed", stepsTaken: 2 });
    const events = await store.listEvents("turn_t");
    expect(events.map((e) => e.eventType)).toEqual([
      "message",
      "delta",
      "tool_request",
      "tool_result",
      "delta",
      "done",
    ]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

    const toolResult = events[3].data as { name: string; ok: boolean; output: unknown };
    expect(toolResult.name).toBe("search_notes");
    expect(toolResult.ok).toBe(true);
    expect(toolResult.output).toBeTruthy();

    // 工具结果已回填下一轮上下文（provider 第二轮能感知）→ 断言第二条 delta 为最终正文
    const finalDelta = events[4].data as { isFinal: boolean };
    expect(finalDelta.isFinal).toBe(true);
    expect(store.attemptStatus("atp_t")).toBe("Completed");

    // 副作用证据账本：一条 executed 记录
    const log = store.toolExecutionRecords();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      turnId: "turn_t",
      attemptId: "atp_t",
      name: "search_notes",
      status: "executed",
    });
    expect(log[0].output).toBeTruthy();
  });

  it("工具执行失败不终止 Loop：tool_result(ok:false) 后继续下一轮并正常完成", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { text: "试试工具。", toolCalls: [{ id: "call_f", name: "search_notes", arguments: {} }] },
          { text: "工具没成功，我换个说法回答。", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider({
          search_notes: () => ({ ok: false, error: "index_unavailable" }),
        }),
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_t");
    const toolResults = events.filter((e) => e.eventType === "tool_result").map((e) => e.data) as Array<{
      ok: boolean;
      error?: string;
    }>;
    expect(toolResults[0]).toMatchObject({ ok: false, error: "index_unavailable" });
    expect(events.some((e) => e.eventType === "done")).toBe(true);
  });

  it("未注册工具 fail-closed：白名单外拒绝，不进入执行", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { toolCalls: [{ id: "call_x", name: "rm_rf", arguments: {} }] },
          { text: "完成", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider(),
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_t");
    const toolResults = events.filter((e) => e.eventType === "tool_result").map((e) => e.data) as Array<{
      ok: boolean;
      error: string;
    }>;
    expect(toolResults[0]).toMatchObject({ ok: false, error: "unregistered_tool: rm_rf" });
  });

  it("重复工具调用检测：同 name+arguments 第二次被拒绝", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { text: "a", toolCalls: [{ id: "call_1", name: "search_notes", arguments: { q: "x" } }] },
          { text: "b", toolCalls: [{ id: "call_2", name: "search_notes", arguments: { q: "x" } }] },
          { text: "c", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider(),
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_t");
    const toolResults = events.filter((e) => e.eventType === "tool_result").map((e) => e.data) as Array<{
      ok: boolean;
      error: string;
    }>;
    expect(toolResults[0].ok).toBe(true);
    expect(toolResults[1]).toMatchObject({ ok: false, error: "duplicate_tool_call" });
  });

  it("工具超时：tool_timeout 记为失败结果且 Loop 继续", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { text: "start", toolCalls: [{ id: "call_t", name: "search_notes", arguments: {} }] },
          { text: "超时后完成", toolCalls: [] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider({
          search_notes: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: {} }), 200)),
        }),
        options: { toolTimeoutMs: 5 },
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_t");
    const toolResults = events.filter((e) => e.eventType === "tool_result").map((e) => e.data) as Array<{
      ok: boolean;
      error: string;
    }>;
    expect(toolResults[0]).toMatchObject({ ok: false, error: "tool_timeout" });
  });

  it("maxSteps 内始终请求工具 → done(Interrupted) + finalize Interrupted", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          { toolCalls: [{ id: "call_1", name: "search_notes", arguments: {} }] },
          { toolCalls: [{ id: "call_2", name: "search_notes", arguments: { q: "b" } }] },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider(),
        options: { maxSteps: 1 },
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "failed", reason: "max_steps" });
    const events = await store.listEvents("turn_t");
    const done = events.find((e) => e.eventType === "done")?.data as { status: string; isComplete: boolean } | undefined;
    expect(done).toMatchObject({ status: "Interrupted", isComplete: false });
    expect(store.attemptStatus("atp_t")).toBe("Interrupted");
  });

  it("未配置工具却收到工具请求 → fail-closed：failed(tools_disabled)", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([{ toolCalls: [{ id: "call_d", name: "search_notes", arguments: {} }] }]),
        contextBuilder: defaultContextBuilder,
        // 不传 tools
      },
      { turnId: "turn_t", sessionId: "sess_t", attemptId: "atp_t", userMessage: "x" },
    );

    expect(result).toMatchObject({ status: "failed", reason: "tools_disabled" });
    const events = await store.listEvents("turn_t");
    const toolResults = events.filter((e) => e.eventType === "tool_result").map((e) => e.data) as Array<{
      ok: boolean;
      error: string;
    }>;
    expect(toolResults[0]).toMatchObject({ ok: false, error: "tools_disabled" });
    expect(store.attemptStatus("atp_t")).toBe("Failed");

    // 未配置工具时同样留下 rejected 证据
    const log = store.toolExecutionRecords();
    expect(log[0]).toMatchObject({ name: "search_notes", status: "rejected", error: "tools_disabled" });
  });
});