/**
 * 每次实际模型调用的 ModelRun / ContextManifest：多 Step、失败重试、输入不可变性。
 * 记录属于诊断侧写，不替代执行/授权/恢复账本。
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
      runId: "mr_attempt_cm_1_1",
    });
    expect(runs[0]?.latencyMs).toBeGreaterThanOrEqual(0);

    const manifests = store.contextManifestRecords();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      manifestId: "mcm_mr_attempt_cm_1_1",
      attemptId: "attempt_cm",
      stepId: 1,
      modelRunId: "mr_attempt_cm_1_1",
      purpose: "agent.loop",
    });
    // 快照 = 该 Step 上下文 messages（首条即用户输入）
    expect((manifests[0]?.snapshot[0]).content).toBe("帮我总结");
  });

  it("多 Step（工具往返）：每次模型调用都有独立 Manifest", async () => {
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
    expect(manifests.map((manifest) => manifest.stepId)).toEqual([1, 2]);
    expect(manifests[0]?.snapshot).toHaveLength(1);
    expect(manifests[1]?.snapshot).toHaveLength(3);
    expect(manifests[1]?.snapshot[2]?.role).toBe("tool");
    expect(manifests[1]?.requestSnapshot?.tools).toEqual(tools.tools);
    expect(manifests.map((manifest) => manifest.modelRunId)).toEqual(runs.map((record) => record.runId));
  });

  it("无 modelRunMeta：缺省 provider.id / 占位 modelId（兼容）", async () => {
    const store = makeStore();
    await run(store, { provider: createReplayProvider() });
    const runRecord = store.modelRunRecords()[0];
    expect(runRecord?.provider).toBe("replay");
    expect(runRecord?.modelId).toBe("n/a");
  });

  it("首次调用失败后重试各留一条记录，输入快照不受后续突变影响", async () => {
    const store = makeStore();
    let calls = 0;
    const result = await run(store, {
      provider: { id: "retry", async *stream(request) {
        calls += 1;
        request.context.messages[0]!.content = "mutated by provider";
        if (calls === 1) throw new Error("transient");
        yield { text: "done", isFinal: true };
      } },
    });
    expect(result.status).toBe("completed");
    const records = store.modelRunRecords();
    expect(records.map((record) => record.status)).toEqual(["failed", "completed"]);
    expect(new Set(records.map((record) => record.runId)).size).toBe(2);
    const manifests = store.contextManifestRecords();
    expect(manifests).toHaveLength(2);
    expect(manifests[0]?.snapshot[0]?.content).toBe("帮我总结");
  });
});
