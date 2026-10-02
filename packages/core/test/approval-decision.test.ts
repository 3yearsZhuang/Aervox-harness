/**
 * Aervox｜思隅 @aervox/core — 审批裁决单点收敛测试（ITER-041 / 缺陷 D-APPROVAL）
 *
 * 背景：审批裁决此前有两份等价实现（executor 内联段与 withApprovalPolicy 装饰器），
 * 各自把 `ToolApprovalDecision` 映射为工具结果。两侧同时生效时会双重裁决，
 * 且映射规则各写一份、改一处漏另一处即语义分叉。
 *
 * 本文件锁定：
 * - `decideToolCall` 是唯一映射实现，三种决策的映射结果符合契约；
 * - 装饰器路径与 executor 内联路径对同一决策产出**相同**裁决结果（防分叉回归）；
 * - `allow` 放行时装饰器确实穿透到下游 provider（不误拦截）。
 */
import { describe, expect, it } from "vitest";
import {
  AutoApprovalPolicy,
  decideToolCall,
  withApprovalPolicy,
} from "../src/index.js";
import type { ToolProviderPort } from "../src/index.js";

const call = { id: "call_1", name: "save_memory_note", arguments: { content: "x" } };

const makeProvider = (executed: string[]): ToolProviderPort => ({
  tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
  async execute(input) {
    executed.push(input.name);
    return { ok: true, output: { saved: true } };
  },
});

describe("审批裁决单点收敛（ITER-041）", () => {
  it("allow → undefined（放行，由调用方执行）", () => {
    const decision = { action: "allow" as const };
    expect(decideToolCall(decision, { call, safetyLevel: "write_with_approval", invocationId: "inv_1" })).toBeUndefined();
  });

  it("deny → ok:false + reason，且不携带 needsApproval", () => {
    const decision = { action: "deny" as const, reason: "policy_denied" };
    const result = decideToolCall(decision, { call, safetyLevel: "write_with_approval", invocationId: "inv_1" });
    expect(result).toEqual({ id: "call_1", name: "save_memory_note", ok: false, error: "policy_denied" });
    expect(result?.needsApproval).toBeUndefined();
  });

  it("deny 无 reason 时回落默认错误串", () => {
    const decision = { action: "deny" as const };
    const result = decideToolCall(decision, { call, safetyLevel: "write_with_approval", invocationId: "inv_1" });
    expect(result?.error).toBe("tool_approval_denied: save_memory_note");
  });

  it("ask_user → ok:false + needsApproval，缺省 approvalId 由 invocationId 派生", () => {
    const decision = { action: "ask_user" as const };
    const result = decideToolCall(decision, { call, safetyLevel: "write_with_approval", invocationId: "inv_9" });
    expect(result?.ok).toBe(false);
    expect(result?.needsApproval?.approvalId).toBe("apv_inv_9");
    expect(result?.needsApproval?.toolName).toBe("save_memory_note");
  });

  it("ask_user 保留策略给出的 approvalId 与 argumentsHash", () => {
    const decision = { action: "ask_user" as const, approvalId: "apv_custom", argumentsHash: "h1" };
    const result = decideToolCall(decision, { call, safetyLevel: "write_with_approval", invocationId: "inv_9" });
    expect(result?.needsApproval?.approvalId).toBe("apv_custom");
    expect(result?.needsApproval?.argumentsHash).toBe("h1");
  });

  it("两侧一致性：装饰器与 decideToolCall 对同一决策产出相同裁决", async () => {
    const executed: string[] = [];
    const policy = new AutoApprovalPolicy({ mode: "ask_user" });
    const guarded = withApprovalPolicy(makeProvider(executed), policy);

    const viaDecorator = await guarded.execute({
      turnId: "t",
      attemptId: "a",
      invocationId: "inv_1",
      name: "save_memory_note",
      arguments: { content: "x" },
    });

    const viaSingle = decideToolCall(
      { action: "ask_user", approvalId: `apv_inv_1` },
      { call, safetyLevel: "write_with_approval", invocationId: "inv_1" },
    );

    // 同一决策 → 同一 needsApproval 载荷（error 字段装饰器不设，故只比对关键面）
    expect(viaDecorator.ok).toBe(viaSingle?.ok);
    expect(viaDecorator.needsApproval).toEqual(viaSingle?.needsApproval);
    // ask_user 场景不得穿透到下游执行
    expect(executed).toEqual([]);
  });

  it("allow 时装饰器穿透到下游 provider（不误拦截）", async () => {
    const executed: string[] = [];
    const guarded = withApprovalPolicy(makeProvider(executed), new AutoApprovalPolicy({ mode: "full_access" }));
    const result = await guarded.execute({
      turnId: "t",
      attemptId: "a",
      invocationId: "inv_ok",
      name: "save_memory_note",
      arguments: { content: "x" },
    });
    expect(result.ok).toBe(true);
    expect(executed).toEqual(["save_memory_note"]);
  });
});
