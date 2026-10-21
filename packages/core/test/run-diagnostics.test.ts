import { describe, expect, it } from "vitest";
import {
  exportSanitizedEvalFixture,
  createScriptedProvider,
  executeTurn,
  defaultContextBuilder,
  InMemoryExecutionStore,
  type RunDiagnosticsManifest,
} from "../src/index.js";

describe("Unified Run Diagnostics & Trace-to-Eval (Core)", () => {
  it("导出脱敏单测夹具并无缝喂入 createScriptedProvider 回放", async () => {
    const manifest: RunDiagnosticsManifest = {
      runId: "run_sample_1",
      turnId: "turn_prod_99",
      sessionId: "sess_user_alpha",
      attemptId: "att_prod_99_0",
      startedAt: "2026-10-20T10:00:00.000Z",
      finishedAt: "2026-10-20T10:00:02.500Z",
      durationMs: 2500,
      status: "completed",
      configuration: {
        persona: { name: "Aervox", source: "preset" },
        skills: [{ name: "notes", loaded: true }],
        tools: {
          declared: ["aervox_save_note"],
          active: [{ name: "aervox_save_note", safetyLevel: "read_only", readOnly: true }],
        },
        modelRouting: { provider: "deepseek", modelId: "deepseek-chat", tier: "standard", reason: "default" },
      },
      timeBreakdown: {
        modelLatencyMs: 1800,
        toolExecutionMs: 400,
        pluginHookMs: 50,
      },
      modelSteps: [
        {
          step: 1,
          modelRunId: "mr_1",
          latencyMs: 900,
          responseText: "我需要记录日记，正在保存中……",
          toolCallsRequested: ["aervox_save_note"],
        },
        {
          step: 2,
          modelRunId: "mr_2",
          latencyMs: 900,
          responseText: "日记已保存完毕，祝你有美好的一天！",
        },
      ],
      toolExecutions: [
        {
          invocationId: "att_prod_99_0:1:1",
          toolName: "aervox_save_note",
          status: "executed",
          durationMs: 380,
          output: { saved: true },
        },
      ],
    };

    // 1. 导出脱敏测试夹具（默认脱敏用户与私密文本）
    const fixture = exportSanitizedEvalFixture(manifest, {
      name: "prod_diary_flow_regression",
      scrubUserContent: true,
    });

    expect(fixture.name).toBe("prod_diary_flow_regression");
    expect(fixture.script).toHaveLength(2);
    // 第一步请求工具，文本已脱敏
    expect(fixture.script[0].text).toBe("(sanitized model response)");
    expect(fixture.script[0].toolCalls?.[0].name).toBe("aervox_save_note");
    // 第二步返回最终回复
    expect(fixture.script[1].text).toBe("(sanitized model response)");
    expect(fixture.expectedToolsExecuted).toEqual(["aervox_save_note"]);

    // 2. 将导出的 fixture.script 直接作为 ReplayProvider 运行回归测试
    const replayProvider = createScriptedProvider(fixture.script);
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "att_eval_1", turnId: "turn_eval_1" });

    let toolExecuted = false;
    const tools = {
      tools: [{ name: "aervox_save_note", description: "Save note", readOnly: true }],
      async execute() {
        toolExecuted = true;
        return { ok: true, output: { saved: true } };
      },
    };

    const runResult = await executeTurn(
      {
        execution: store,
        provider: replayProvider,
        contextBuilder: defaultContextBuilder,
        tools,
      },
      {
        turnId: "turn_eval_1",
        attemptId: "att_eval_1",
        sessionId: "sess_eval",
        userMessage: "脱敏重放测试",
      },
    );

    expect(runResult.status).toBe(fixture.expectedFinalStatus);
    expect(toolExecuted).toBe(true);

    const events = await store.listEvents("turn_eval_1");
    expect(events.map((e) => e.eventType)).toContain("tool_result");
  });
});
