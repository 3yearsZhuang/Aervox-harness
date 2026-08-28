/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 2b 用户取消闭环测试
 *
 * 覆盖 AVX-HAR-001 §5.1/§11.1：
 * - RequestCancel 仅 Running 可写（已终态拒绝，CAS）；
 * - executor 检查点（Step 首部 / 工具批次前 / 终态提交前）中止并写 Cancelled 终态；
 * - 单一终态在取消与完成之间仍唯一（先提交者胜）；finalize 被抢占时不写不一致事件。
 */
import { describe, expect, it } from "vitest";
import {
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
  createReplayProvider,
} from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const deps = (store: InMemoryExecutionStore) => ({
  execution: store,
  provider: createReplayProvider(),
  contextBuilder: defaultContextBuilder,
});

/** 工具 Provider：记录是否被调用（断言取消避免副作用） */
const recordingTools = (called: { invoked: boolean }) =>
  ({
    tools: [{ name: "notes_search", description: "x", readOnly: true }],
    async execute() {
      called.invoked = true;
      return { ok: true, output: "ok" };
    },
  }) satisfies ToolProviderPort;

/** 首个 chunk 后触发的取消 Provider：模拟运行中用户取消 */
const cancelDuringStream =
  (store: InMemoryExecutionStore, attemptId: string): ModelProviderPort => ({
    id: "cancel-during-stream",
    async *stream(): AsyncIterable<ModelChunk> {
      yield { text: "我先查一下。", isFinal: false };
      await store.requestCancelAttempt({ turnId: "turn_1", attemptId });
      yield {
        text: "",
        isFinal: true,
        toolCalls: [{ id: "call_1", name: "notes_search", arguments: { query: "x" } }],
      };
    },
  });

describe("阶段 2b CancelRequested 闭环", () => {
  it("运行中取消：claim 成功后置取消位，executor 在 Step 首部检查点中止，终态 Cancelled 且事件为 message + done", async () => {
    // claim 成功后立即置取消位（模拟用户取消在领取之后、Step 首部检查之前到达）
    class CancelAfterClaimStore extends InMemoryExecutionStore {
      override async claimTurnAttempt(input: {
        turnId: string;
        attemptId: string;
        expectedFencingToken: number;
      }) {
        const res = await super.claimTurnAttempt(input);
        if (res.ok) {
          await this.requestCancelAttempt({ turnId: input.turnId, attemptId: input.attemptId });
        }
        return res;
      }
    }
    const store = new CancelAfterClaimStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    const result = await executeTurn(deps(store), {
      turnId: "turn_1",
      sessionId: "sess_1",
      attemptId: "atp_1",
      userMessage: "你好",
    });

    expect(result.status).toBe("cancelled");
    expect(store.attemptStatus("atp_1")).toBe("Cancelled");
    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message", "done"]);
    const done = events[1].data as { status: string; isComplete: boolean };
    expect(done.status).toBe("Cancelled");
    expect(done.isComplete).toBe(false);
  });

  it("已取消的 Attempt 不可领取（claim 返回 skipped, not_runnable）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });
    await store.requestCancelAttempt({ turnId: "turn_1", attemptId: "atp_1" });

    const result = await executeTurn(deps(store), {
      turnId: "turn_1",
      sessionId: "sess_1",
      attemptId: "atp_1",
      userMessage: "你好",
    });
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).toBe("not_runnable");
    expect(store.attemptStatus("atp_1")).toBe("CancelRequested");
  });

  it("工具批次前取消：不产生 tool_request/tool_result，工具副作用零执行", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });
    const called = { invoked: false };

    const result = await executeTurn(
      { execution: store, provider: cancelDuringStream(store, "atp_1"), contextBuilder: defaultContextBuilder, tools: recordingTools(called) },
      { turnId: "turn_1", sessionId: "sess_1", attemptId: "atp_1", userMessage: "查笔记" },
    );

    expect(result.status).toBe("cancelled");
    expect(called.invoked).toBe(false);
    expect(store.toolExecutionRecords()).toHaveLength(0);
    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "done"]);
    expect((events[2].data as { status: string }).status).toBe("Cancelled");
    expect(store.attemptStatus("atp_1")).toBe("Cancelled");
  });

  it("已终态拒绝取消：Completed 之后 requestCancel 返回 already_finalized，不覆盖", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });
    await executeTurn(deps(store), {
      turnId: "turn_1",
      sessionId: "sess_1",
      attemptId: "atp_1",
      userMessage: "帮我安排复习",
    });

    expect(store.attemptStatus("atp_1")).toBe("Completed");
    const cancelled = await store.requestCancelAttempt({ turnId: "turn_1", attemptId: "atp_1" });
    expect(cancelled).toEqual({ ok: false, reason: "already_finalized" });
    expect(store.attemptStatus("atp_1")).toBe("Completed");
  });

  it("终态竞态：Cancelled finalize 被抢占时返回 failed 且不写 done 事件", async () => {
    class ContestedStore extends InMemoryExecutionStore {
      override async finalizeAttempt(input: { turnId: string; attemptId: string; status: string; expectedFencingToken?: number }) {
        if (input.status === "Cancelled") return { ok: false };
        return super.finalizeAttempt(input as never);
      }
      override async isCancelRequested(): Promise<boolean> {
        return true;
      }
    }
    const store = new ContestedStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    const result = await executeTurn(deps(store), {
      turnId: "turn_1",
      sessionId: "sess_1",
      attemptId: "atp_1",
      userMessage: "你好",
    });

    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("cancelled_finalize_contested");
    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message"]); // 无 done：终态未获得不写
  });

  it("store 契约：不存在 Attempt 返回 not_found", async () => {
    const store = new InMemoryExecutionStore();
    expect(await store.requestCancelAttempt({ turnId: "turn_x", attemptId: "atp_missing" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});