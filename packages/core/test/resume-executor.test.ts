/**
 * Aervox｜思隅 @aervox/core — 续跑执行测试（AVX-HAR-001 §11.3 首范式、阶段 4b）
 *
 * 场景：Attempt 在工具结果已权威提交但尚未注入时崩溃（无终态事件）。
 * 恢复器重建上下文后以「抢占续跑」在原 Attempt 上继续：
 * - 跳过 message 身份事件、复用原 messageId，事件从 lastSequence+1 追加；
 * - Step/executionId（attempt:step:seq）从 lastStep 之后继续，不与已提交冲突；
 * - 不重复已提交副作用；终态以新 fencing（续跑 claim 后）提交。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import { buildResumeHistory, decideResume } from "../src/index.js";
import type { AgentStreamEvent, ExecutionStorePort, ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

/** 崩溃前已提交的事件流（message + delta + tool_request + tool_result，无 done），对应一个已完成 Step */
async function seedCommittedStep(store: InMemoryExecutionStore): Promise<{ lastSequence: number; messageId: string; fencingToken: number }> {
  const event = (sequence: number, eventType: string, data: unknown): AgentStreamEvent =>
    ({ turnId: "turn_r", attemptId: "atp_r", sequence, eventType, data, safetyDecision: "approved", eventId: `tev_${sequence}`, payloadVersion: 1, occurredAt: new Date(0).toISOString() });

  await store.appendEvent(event(1, "message", { messageId: "msg_turn_r_assistant", role: "assistant", contentType: "text", isComplete: false }));
  await store.appendEvent(event(2, "delta", { messageId: "msg_turn_r_assistant", text: "让我查一下。", isFinal: false }));
  await store.appendEvent(event(3, "tool_request", { invocationId: "call_1", executionId: "atp_r:1:1", name: "notes_search", arguments: {} }));
  await store.appendEvent(event(4, "tool_result", { invocationId: "call_1", executionId: "atp_r:1:1", name: "notes_search", ok: true, output: "三角函数" }));

  // 崩溃前已 claim（fencing 0→1），工具结果已权威收口
  const claim = await store.claimTurnAttempt({ turnId: "turn_r", attemptId: "atp_r", expectedFencingToken: 0 });
  if (!claim.ok) throw new Error("seed claim failed");
  await store.reserveToolExecution({ turnId: "turn_r", attemptId: "atp_r", invocationId: "atp_r:1:1", name: "notes_search", arguments: {} });
  await store.updateToolExecutionResult({ turnId: "turn_r", attemptId: "atp_r", invocationId: "atp_r:1:1", status: "executed", output: "三角函数" });

  return { lastSequence: 4, messageId: "msg_turn_r_assistant", fencingToken: claim.fencingToken };
}

const finalTextProvider = (text: string): ModelProviderPort => ({
  id: "final",
  async *stream(): AsyncIterable<ModelChunk> {
    yield { text, isFinal: true };
  },
});

const toolProvider: ToolProviderPort = {
  tools: [{ name: "notes_search", description: "x", readOnly: true }],
  async execute(input) {
    return { ok: true, output: "水印" };
  },
};

describe("4b 续跑执行（executor resume）", () => {
  it("裁决可续（decideResume）→ buildResumeHistory 重建上下文 → 抢占续跑直到自然完成", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_r", turnId: "turn_r" });
    const committed = await seedCommittedStep(store);

    // 恢复器裁决：无终态事件 + 最后批次全 executed → 可续
    const events = await store.listEvents("turn_r");
    const executions = store.toolExecutionRecords().map((r) => ({ invocationId: r.invocationId, status: r.status }));
    const decision = decideResume(events as never, executions as never);
    expect(decision).toEqual({ resume: true, reason: "resumable", lastSequence: 4 });

    // 重建上下文：user + assistant 文本 + 权威 tool 结果
    const rebuilt = buildResumeHistory({ userMessage: "你好", events: events as never });
    expect(rebuilt.messageId).toBe("msg_turn_r_assistant");
    expect(rebuilt.history).toHaveLength(3); // user + assistant + tool

    // 崩溃后租约过期：续跑以抢占语义重新 claim
    store.simulateLeaseLoss("atp_r");

    // 抢占续跑：预期 fencing = 崩溃前 claim 后的值；lastStep=1（已完成一个 Step）
    const result = await executeTurn(
      {
        execution: store,
        provider: finalTextProvider("查到了：今天复习三角函数。"),
        contextBuilder: defaultContextBuilder,
        tools: toolProvider,
        options: { resume: { expectedFencingToken: committed.fencingToken, lastSequence: committed.lastSequence, lastStep: 1, history: rebuilt.history, messageId: rebuilt.messageId }, maxSteps: 8 },
      },
      { turnId: "turn_r", sessionId: "sess_r", attemptId: "atp_r", userMessage: "你好" },
    );
    expect(result.status).toBe("completed");

    // 事件序列：5 = delta（续跑文本）、6 = done；无重复 message 身份事件
    const all = await store.listEvents("turn_r");
    expect(all.map((e) => e.eventType)).toEqual(["message", "delta", "tool_request", "tool_result", "delta", "done"]);
    expect(all[4]?.sequence).toBe(5);
    expect(all[4]?.data).toMatchObject({ messageId: "msg_turn_r_assistant", text: "查到了：今天复习三角函数。", isFinal: true });
    expect(all[5]?.data).toMatchObject({ status: "Completed" });
    expect(all[5]?.sequence).toBe(6);
    // 终态成功（续跑后 fencing 提交）
    expect(await store.attemptStatus("atp_r")).toBe("Completed");
  });

  // 回归：executor 改为逐项配对 tool_calls 后，resume 重建必须同形。
  // 否则 assistant 消息缺 tool_calls、其后 tool 消息却带 tool_call_id → 严格端 400。
  it("重建的 assistant 消息以 tool_calls 逐项配对，tool 消息前必有声明（单Step / 多调用 / 跨 Step）", () => {
    const ev = (sequence: number, eventType: string, data: unknown): never =>
      ({ sequence, eventType, data, safetyDecision: "approved" }) as never;

    // 单 Step 单调用
    const single = buildResumeHistory({
      userMessage: "查一下",
      events: [
        ev(1, "message", { messageId: "m1" }),
        ev(2, "delta", { text: "我先查" }),
        ev(3, "tool_request", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", arguments: { q: "三角" } }),
        ev(4, "tool_result", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", ok: true, output: "ok" }),
      ],
    });
    expect(single.history).toHaveLength(3);
    expect(single.history[1]).toEqual({
      role: "assistant",
      content: "我先查",
      toolCalls: [{ id: "call_1", name: "notes_search", arguments: { q: "三角" } }],
    });
    // 旧形状的 toolCallId/name 不得再出现在 assistant 上
    expect(single.history[1]).not.toHaveProperty("toolCallId");
    expect(single.history[1]).not.toHaveProperty("name");
    expect(single.history[2]).toMatchObject({ role: "tool", toolCallId: "call_1" });

    // 单 Step 多调用 → 必须聚合成**一条** assistant 消息（与 executor 同形），而非逐调用一条
    const multi = buildResumeHistory({
      userMessage: "查两个",
      events: [
        ev(1, "message", { messageId: "m2" }),
        ev(2, "delta", { text: "并行查" }),
        ev(3, "tool_request", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", arguments: {} }),
        ev(4, "tool_request", { invocationId: "call_2", executionId: "a:1:2", name: "deck_review", arguments: {} }),
        ev(5, "tool_result", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", ok: true, output: "x" }),
        ev(6, "tool_result", { invocationId: "call_2", executionId: "a:1:2", name: "deck_review", ok: true, output: "y" }),
      ],
    });
    expect(multi.history).toHaveLength(4); // user + assistant(2 calls) + tool + tool
    expect(multi.history[1]?.toolCalls).toHaveLength(2);
    expect(multi.history[1]?.toolCalls?.map((c) => c.id)).toEqual(["call_1", "call_2"]);
    expect(multi.history[2]).toMatchObject({ role: "tool", toolCallId: "call_1" });
    expect(multi.history[3]).toMatchObject({ role: "tool", toolCallId: "call_2" });

    // 跨 Step：第二个 delta 触发上一 Step 闭合，不得把两批工具混进同一条 assistant
    const twoSteps = buildResumeHistory({
      userMessage: "再查一次",
      events: [
        ev(1, "message", { messageId: "m3" }),
        ev(2, "delta", { text: "第一步" }),
        ev(3, "tool_request", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", arguments: {} }),
        ev(4, "tool_result", { invocationId: "call_1", executionId: "a:1:1", name: "notes_search", ok: true, output: "x" }),
        ev(5, "delta", { text: "第二步" }),
        ev(6, "tool_request", { invocationId: "call_2", executionId: "a:2:1", name: "deck_review", arguments: {} }),
        ev(7, "tool_result", { invocationId: "call_2", executionId: "a:2:1", name: "deck_review", ok: true, output: "y" }),
      ],
    });
    const assistants = twoSteps.history.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.toolCalls?.map((c) => c.id)).toEqual(["call_1"]);
    expect(assistants[1]?.toolCalls?.map((c) => c.id)).toEqual(["call_2"]);

    // 配对不变量：每条 tool 消息的 tool_call_id 都能在其所属 assistant（向上最近的一条）
    // 的 tool_calls 中找到——多条 tool 消息共享同一条 assistant 是合法的。
    for (const { history } of [single, multi, twoSteps]) {
      history.forEach((message, index) => {
        if (message.role !== "tool") return;
        let owner: (typeof history)[number] | undefined;
        for (let i = index - 1; i >= 0; i--) {
          if (history[i]?.role === "assistant") { owner = history[i]; break; }
        }
        expect((owner?.toolCalls ?? []).some((c) => c.id === message.toolCallId)).toBe(true);
      });
    }
  });

  // 回归：tool_result 无对应 tool_request（事件被截断）时不得产出孤立 tool 消息
  it("结果缺对应请求时跳过该Step，不生成孤立 tool 消息", () => {
    const rebuilt = buildResumeHistory({
      userMessage: "查一下",
      events: [
        { sequence: 1, eventType: "message", data: { messageId: "m1" }, safetyDecision: "approved" } as never,
        { sequence: 2, eventType: "delta", data: { text: "正文" }, safetyDecision: "approved" } as never,
        { sequence: 3, eventType: "tool_result", data: { invocationId: "call_x", ok: true, output: "孤儿" }, safetyDecision: "approved" } as never,
      ],
    });
    expect(rebuilt.history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(rebuilt.history.every((m) => m.role !== "tool")).toBe(true);
  });

  it("续跑 Step 从 lastStep 之后继续：executionId 不与已提交冲突（attemptId:2:1）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_r2", turnId: "turn_r2" });
    const e2 = (sequence: number, eventType: string, data: unknown): AgentStreamEvent =>
      ({ turnId: "turn_r2", attemptId: "atp_r2", sequence, eventType, data, safetyDecision: "approved", eventId: `tev_${sequence}`, payloadVersion: 1, occurredAt: new Date(0).toISOString() });
    await store.appendEvent(e2(1, "message", { messageId: "msg_turn_r2_assistant", role: "assistant", contentType: "text", isComplete: false }));
    await store.appendEvent(e2(2, "tool_request", { invocationId: "call_1", executionId: "atp_r2:1:1", name: "notes_search", arguments: {} }));
    await store.appendEvent(e2(3, "tool_result", { invocationId: "call_1", executionId: "atp_r2:1:1", name: "notes_search", ok: true, output: "数据" }));
    const claim = await store.claimTurnAttempt({ turnId: "turn_r2", attemptId: "atp_r2", expectedFencingToken: 0 });
    if (!claim.ok) throw new Error("seed claim failed");
    await store.reserveToolExecution({ turnId: "turn_r2", attemptId: "atp_r2", invocationId: "atp_r2:1:1", name: "notes_search", arguments: {} });
    await store.updateToolExecutionResult({ turnId: "turn_r2", attemptId: "atp_r2", invocationId: "atp_r2:1:1", status: "executed", output: "数据" });

    // 续跑请求新工具（step=2）：executionId 必须是 atp_r2:2:1
    const toolCallProvider: ModelProviderPort = {
      id: "toolcall",
      async *stream(): AsyncIterable<ModelChunk> {
        yield { text: "继续查", isFinal: true, toolCalls: [{ id: "call_2", name: "notes_search", arguments: {} }] };
      },
    };
    store.simulateLeaseLoss("atp_r2");
    const result = await executeTurn(
      {
        execution: store,
        provider: toolCallProvider,
        contextBuilder: defaultContextBuilder,
        tools: toolProvider,
        options: { resume: { expectedFencingToken: claim.fencingToken, lastSequence: 3, lastStep: 1, history: [{ role: "user", content: "x" }, { role: "assistant", content: "继续查", toolCallId: "call_2", name: "notes_search" }], messageId: "msg_turn_r2_assistant" }, maxSteps: 8 },
      },
      { turnId: "turn_r2", sessionId: "sess_r2", attemptId: "atp_r2", userMessage: "x" },
    );
    // 第二 Step 单工具后预算收敛：Interrupted（maxSteps 内终工具循环）
    expect(["interrupted", "completed"]).toContain(result.status);

    const records = store.toolExecutionRecords();
    const resumed = records.find((r) => r.invocationId === "atp_r2:2:1");
    expect(resumed).toBeDefined();
    expect(resumed?.status).toBe("executed");
    // 旧 executionId 未被覆盖（无重复副作用）
    const original = records.find((r) => r.invocationId === "atp_r2:1:1");
    expect(original?.status).toBe("executed");
  });
});