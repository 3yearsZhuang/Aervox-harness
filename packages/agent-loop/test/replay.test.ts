/**
 * Aervox｜思隅 @aervox/agent-loop — 固定回放确定性测试（AVX-HAR-001 §16.1 agent-loop-replay）
 *
 * 覆盖 §15 阶段 0/1 退出条件：同一回放输入（固定模型流/工具流）产出确定的事件序列与终态；
 * 重放（同一 store 再次读事件）幂等且与首次一致。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, createReplayProvider, createScriptedProvider, executeTurn, InMemoryExecutionStore } from "../src/index.js";

/** 两步工具链固定回放（同 API_TOOL_SCRIPT 形状） */
const twoStepScript = [
  { text: "我先查一下。", toolCalls: [{ id: "call_r1", name: "notes_search", arguments: { query: "复习" } }] },
  { text: "查到了：今天复习三角函数。", toolCalls: [] },
] as const;

const twoStepTools = {
  tools: [{ name: "notes_search", description: "x", readOnly: true }],
  async execute() {
    return { ok: true, output: "memo" };
  },
};

describe("固定回放确定性（agent-loop-replay）", () => {
  it("同一回放输入两次执行产出完全一致的事件序列与终态", async () => {
    const runOnce = async (): Promise<{ events: string[]; terminal: string }> => {
      const store = new InMemoryExecutionStore();
      store.seedAttempt({ id: "atp_r", turnId: "turn_r" });
      await executeTurn(
        { execution: store, provider: createScriptedProvider(twoStepScript), contextBuilder: defaultContextBuilder, tools: twoStepTools },
        { turnId: "turn_r", sessionId: "sess_r", attemptId: "atp_r", userMessage: "查笔记" },
      );
      const events = await store.listEvents("turn_r");
      return { events: events.map((e) => `${e.eventType}:${e.sequence}`), terminal: store.attemptStatus("atp_r")! };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(second).toEqual(first);
    expect(first.events).toEqual(["message:1", "delta:2", "tool_request:3", "tool_result:4", "delta:5", "done:6"]);
    expect(first.terminal).toBe("Completed");
  });

  it("Replay Provider 为固定夹具：导入即确定性（阶段 0 fixture 版本化基线）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_r2", turnId: "turn_r2" });
    const result = await executeTurn(
      { execution: store, provider: createReplayProvider(), contextBuilder: defaultContextBuilder },
      { turnId: "turn_r2", sessionId: "sess_r2", attemptId: "atp_r2", userMessage: "帮我安排复习" },
    );
    expect(result.status).toBe("completed");
    // 重连重放：重新读事件与增量流结构稳定
    const events = await store.listEvents("turn_r2");
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "delta", "done"]);
  });
});