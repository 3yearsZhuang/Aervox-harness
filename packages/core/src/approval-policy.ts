/**
 * Aervox｜思隅 @aervox/core — 人机回环与工具审批策略 (ApprovalPolicyPort & Decorator)
 *
 * 依据 aervox_core_decoupling_plan.md Phase 2：
 * 统一提供开箱即用的审批策略规范与装饰器，使核心循环与工具提供者解耦“如何向用户索取权限”。
 */

import type {
  ApprovalPolicyPort,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
  ToolSafetyLevel,
} from "./ports.js";
import { decideToolCall } from "./approval-decision.js";

export interface AutoApprovalPolicyOptions {
  /**
   * 自动审批模式：
   * - full_access: 全自动放行（测试或完全受信模式）
   * - read_only: 仅放行只读工具，写工具直接拒执行
   * - ask_user: 只读自动放行，写工具一律要求审批 (ask_user)
   */
  mode?: "full_access" | "read_only" | "ask_user";
  defaultReason?: string;
}

/**
 * 自动审批策略实现（测试与纯自主模式）
 */
export class AutoApprovalPolicy implements ApprovalPolicyPort {
  private readonly mode: "full_access" | "read_only" | "ask_user";
  private readonly defaultReason?: string;

  constructor(options: AutoApprovalPolicyOptions = {}) {
    this.mode = options.mode ?? "ask_user";
    this.defaultReason = options.defaultReason;
  }

  async evaluate(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const isReadOnly = req.safetyLevel === "read_only";

    if (this.mode === "full_access" || isReadOnly) {
      return { action: "allow" };
    }

    if (this.mode === "read_only") {
      return {
        action: "deny",
        reason: this.defaultReason ?? `tool_restricted_in_read_only_mode: ${req.toolName} requires write permission`,
      };
    }

    // ask_user
    return {
      action: "ask_user",
      approvalId: `apv_${req.invocationId}`,
      reason: this.defaultReason,
    };
  }
}

/**
 * 将任意 ToolProviderPort 包装为受 ApprovalPolicy 保护的装饰器
 *
 * ITER-041：裁决映射已收敛至 `decideToolCall`（approval-decision.ts），
 * 与 executor 内联路径共用同一实现，避免两侧映射分叉。
 */
export function withApprovalPolicy(
  provider: ToolProviderPort,
  policy: ApprovalPolicyPort,
): ToolProviderPort {
  const specs = new Map((provider.tools || []).map((t) => [t.name, t]));

  return {
    get tools() {
      return provider.tools;
    },
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const spec = specs.get(input.name);
      const safetyLevel: ToolSafetyLevel = spec?.readOnly ? "read_only" : "write_with_approval";

      const decision = await policy.evaluate({
        turnId: input.turnId,
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        toolName: input.name,
        arguments: input.arguments,
        safetyLevel,
      });

      const blocked = decideToolCall(decision, {
        call: { id: input.invocationId, name: input.name, arguments: input.arguments },
        safetyLevel,
        invocationId: input.invocationId,
      });
      if (blocked) {
        return blocked.ok
          ? { ok: true, output: blocked.output }
          : { ok: false, error: blocked.error, needsApproval: blocked.needsApproval };
      }

      return provider.execute(input);
    },
  };
}
