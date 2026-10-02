/**
 * Aervox｜思隅 @aervox/core — 工具审批裁决归一（ITER-041）
 *
 * 缺陷 D-APPROVAL：审批裁决此前有两份等价实现 ——
 * 1. `executor.ts` 在工具执行前内联 `approvalPolicy.evaluate(...)`，自行把决策映射为
 *    `ToolCallResult`（deny → error；ask_user → needsApproval）；
 * 2. `approval-policy.ts` 的 `withApprovalPolicy` 装饰器做完全相同的映射。
 * 两条路径同时生效（宿主既传 `approvalPolicy` 又用装饰器包裹 tools 时会双重裁决），
 * 且映射逻辑各写一份，改一处漏另一处即产生语义分叉。
 *
 * 本模块把「决策 → 工具结果」的映射收敛为唯一实现 `decideToolCall`，
 * 供 executor 内联路径与 `withApprovalPolicy` 装饰器共同调用。
 * 两侧的差异只在上下文装配（executor 传 executionId 作为幂等键、装饰器传原始 invocationId），
 * 裁决与映射规则本身保持单一真源。
 */
import type { ToolCallRequest, ToolCallResult } from "./types.js";
import type { ToolApprovalDecision, ToolSafetyLevel } from "./ports.js";

/** 裁决所需的最小输入（两侧各自装配后传入） */
export interface ToolCallDecisionInput {
  /** 模型原始工具请求（提供 id / name / arguments） */
  call: ToolCallRequest;
  /** 工具安全级别：只读自主放行 / 写类需授权 */
  safetyLevel: ToolSafetyLevel;
  /** Host 幂等键（executor 用 executionId；装饰器用 invocationId） */
  invocationId: string;
}

/**
 * 把审批决策映射为工具调用结果。
 *
 * 返回 `undefined` 表示「准予执行」——调用方应继续真实执行；
 * 非 undefined 则为拦截结果（拒绝或需用户授权），调用方直接收口，不再执行。
 *
 * 映射规则（单一真源）：
 * - `allow` → undefined（放行）
 * - `deny`  → `ok:false` + reason（不执行、无needsApproval）
 * - `ask_user` → `ok:false` + `needsApproval`（宿主未执行，等待授权）
 */
export function decideToolCall(
  decision: ToolApprovalDecision,
  input: ToolCallDecisionInput,
): ToolCallResult | undefined {
  const { call, invocationId } = input;
  if (decision.action === "deny") {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      error: decision.reason ?? `tool_approval_denied: ${call.name}`,
    };
  }
  if (decision.action === "ask_user") {
    return {
      id: call.id,
      name: call.name,
      ok: false,
      needsApproval: {
        approvalId: decision.approvalId ?? `apv_${invocationId}`,
        toolName: call.name,
        argumentsHash: decision.argumentsHash ?? JSON.stringify(call.arguments),
      },
    };
  }
  return undefined;
}
