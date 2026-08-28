/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 7（ADR-017）Step 级 ModelRun + Manifest 快照写入测试
 *
 * 覆盖：executeTurn 的可追溯副作用（不影响控制流）——
 * - 每 Step 写一条 ModelRun（含 attemptId/stepId/status completed，runId 形如 mr_<turn>_<step>）；
 * - 每 Turn 首个 Step 写一条 ContextManifest（snapshot = 该 Step 上下文 messages，modelRunId 关联首条 run）；
 * - 多 Step 场景：每 Step 一条 run、manifest 仅首条；无工具/无 modelRunMeta 均兼容。
 */
import { describe, expect, it } from "vitest";
import { createScriptedProvider, createReplayProvider, defaultContextBuilder, executeTurn } from "../src/index.js";
import { InMemoryExecutionStore } from "../src/index.js";
import type { ExecuteTurnDeps } from "../src/index.js";

const input = { turnId: "turn_cm", sessionId: "session_cm", attemptId: "attempt_cm", userMessage: "帮我总结" };

const makeStore = (): InMemoryExecutionStore => {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: input.attemptId, turnId: input.turnId });
  return store;
};

const run = async (store: InMemoryExecutionStore, overrides: Partial<ExecuteTurnDeps> = {}) =>
  executeTurn(
    {
      execution: store,
      provider: overrides.provider ?? createReplayProvider(),
      contextBuilder: defaultContextBuilder,
      ...overrides,
    },
    input,
  );

describe("阶段 7 Step 级 ModelRun / Manifest 快照（ADR-017）", () => {
  it("单 Step 完成：1 条 ModelRun（含 attemptId/stepId）+ 1 条 ContextManifest（snapshot=messages）", async () => {
    const store = makeStore();
    const result = await run(store, {
      provider: createScriptedProvider([{ text: "总结完成", toolCalls: [] }]),
      modelRunMeta: { provider: "openai", modelId: "deepseek-chat", purpose: "agent.loop" },
    });

    expect(result.status).toBe("completed");
    const runs = store.modelRunRecords();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      turnId: "turn_cm",
      attemptId: "attempt_cm",
      stepId: 1,
      provider: "openai",
      modelId: "deepseek-chat",
      purpose: "agent.loop",
      status: "completed",
      runId: "mr_turn_cm_1",
    });
    expect(runs[0]?.latencyMs).toBeGreaterThanOrEqual(0);

    const manifests = store.contextManifestRecords();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      manifestId: "mcm_turn_cm",
      attemptId: "attempt_cm",
      stepId: 1,
      modelRunId: "mr_turn_cm_1",
      purpose: "agent.loop",
    });
    // 快照 = 该 Step 上下文 messages（首条即用户输入）
    expect((manifests[0]?.snapshot[0]).content).toBe("帮我总结");
  });

  it("多 Step（工具往返）：每 Step 一条 ModelRun，Manifest 仅首 Step 一条", async () => {
    const store = makeStore();
    const provider = createScriptedProvider([
      { text: "让我查一下。", toolCalls: [{ id: "c1", name: "notes_search", arguments: { q: "x" } }] },
      { text: "查到了。", toolCalls: [] },
    ]);
    const tools = {
      tools: [{ name: "notes_search", description: "笔记检索", readOnly: true }],
      async execute() {
        return { ok: true, output: { notes: [] } };
      },
    };
    const result = await run(store, { provider, tools });

    expect(result.status).toBe("completed");
    const runs = store.modelRunRecords();
    expect(runs.map((r) => r.stepId)).toEqual([1, 2]);
    expect(runs.every((r) => r.attemptId === "attempt_cm" && r.status === "completed")).toBe(true);
    const manifests = store.contextManifestRecords();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]?.stepId).toBe(1);
  });

  it("无 modelRunMeta：缺省 provider.id / 占位 modelId（兼容）", async () => {
    const store = makeStore();
    await run(store, { provider: createReplayProvider() });
    const runRecord = store.modelRunRecords()[0];
    expect(runRecord?.provider).toBe("replay");
    expect(runRecord?.modelId).toBe("n/a");
  });
});