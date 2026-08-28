/**
 * Aervox｜思隅 @aervox/agent-loop — 工具策略测试（AVX-HAR-001 §16.1 agent-loop-tool-policy）
 *
 * 覆盖 §9 工具执行管线权限面：read_only 自主执行 / write_with_approval 需授权
 * （未授权 → pending_approval 收敛）/ privileged 一律拒绝（fail-closed）。
 * 权限裁决由 ToolProviderPort 宿主实现（API 适配器）；executor 只负责行为收敛与账本。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const turn = { turnId: "turn_pol", sessionId: "sess_pol", attemptId: "atp_pol", userMessage: "x" };

const singleToolProvider = (name: string): ModelProviderPort => ({
  id: "tool-policy",
  async *stream(): AsyncIterable<ModelChunk> {
    yield { text: "", isFinal: true, toolCalls: [{ id: "call_p", name, arguments: {} }] };
  },
});

/** 按工具名裁决：read_only / write_with_approval（需授权）/ privileged */
const scoringTools = (name: string, policy: "read_only" | "needs_approval" | "privileged"): ToolProviderPort => ({
  tools: [{ name, description: "x", readOnly: policy === "read_only" }],
  async execute(input) {
    if (policy === "privileged") {
      return { ok: false, error: `requires_approval: ${input.name}（privileged 仅管理员通道）` };
    }
    if (policy === "needs_approval") {
      return { ok: false, needsApproval: { approvalId: "apv_1", toolName: input.name, argumentsHash: "h" } };
    }
    return { ok: true, output: "ok" };
  },
});

describe("工具策略（agent-loop-tool-policy）", () => {
  it("read_only：自主执行 → 账本 executed", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    await executeTurn(
      { execution: store, provider: singleToolProvider("notes_search"), contextBuilder: defaultContextBuilder, tools: scoringTools("notes_search", "read_only"), options: { maxSteps: 1 } },
      turn,
    );
    const records = store.toolExecutionRecords();
    expect(records[0]?.status).toBe("executed");
  });

  it("write_with_approval 未授权：pending_approval + 收敛 Interrupted", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    const result = await executeTurn(
      { execution: store, provider: singleToolProvider("save_note"), contextBuilder: defaultContextBuilder, tools: scoringTools("save_note", "needs_approval") },
      turn,
    );
    expect((result as { reason?: string }).reason).toBe("pending_approval");
    expect(store.attemptStatus(turn.attemptId)).toBe("Interrupted");
    expect(store.toolExecutionRecords()[0]?.status).toBe("pending_approval");
  });

  it("privileged：一律拒绝，账本 timeout/error → rejected，fail-closed", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    await executeTurn(
      { execution: store, provider: singleToolProvider("admin_op"), contextBuilder: defaultContextBuilder, tools: scoringTools("admin_op", "privileged"), options: { maxSteps: 1 } },
      turn,
    );
    const records = store.toolExecutionRecords();
    expect(records[0]?.status).toBe("rejected");
    expect(records[0]?.error).toContain("privileged");
  });
});