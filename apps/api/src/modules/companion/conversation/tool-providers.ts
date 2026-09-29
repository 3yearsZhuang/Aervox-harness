/**
 * Aervox｜思隅 @aervox/api — Agent Loop 工具提供者（Contribution 授权门 + ToolRuntime 适配）
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * 静态 Contribution 工具的通用写授权门（PET-05 / 阶段 3a / CR-022 full_access
 * 预授权）与动态 tool_registrations 运行时适配（CAP-033 主动动作授权）逐字节迁移。
 */
import { inspectToolInput, withApprovalPolicy } from "@aervox/agent-loop";
import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
} from "@aervox/agent-loop";
import type {
  LocalContext,
  SqliteConversationRepository,
} from "@aervox/repositories";
import type { Observability } from "@aervox/observability";
import type { ProactiveActionAuthorizer } from "../../proactive/proactive/index.js";
import type { ToolRuntimePort as ToolRuntime } from "../../ecosystem/tools/index.js";
import { stableStringify } from "./llm-adapter.js";
import {
  EventDrivenApprovalPolicy,
  FULL_ACCESS_DECIDER_PREFIX,
  findExplicitToolApproval,
  recordAutomaticApproval,
  executeAuthorizedProactiveAction,
  type ToolApprovalRepository,
} from "./approval-policy.js";

export {
  EventDrivenApprovalPolicy,
  FULL_ACCESS_DECIDER_PREFIX,
  findExplicitToolApproval,
  recordAutomaticApproval,
  executeAuthorizedProactiveAction,
  type ToolApprovalRepository,
};

/**
 * 给静态 Contribution 工具补齐通用写工具授权门：
 * readOnly 直接执行；写工具命中显式授权或本 Turn 完全访问后执行。
 * 现已重构为基于标准 ApprovalPolicyPort 的 EventDrivenApprovalPolicy 驱动。
 */
export function createApprovalGatedToolProvider(
  provider: ToolProviderPort,
  tenant: LocalContext,
  repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionAuthorizer,
  observability?: Observability,
): ToolProviderPort {
  const policy = new EventDrivenApprovalPolicy(repo, tenant, {
    proactiveActionAuthorizer,
    observability,
  });
  const wrapped = withApprovalPolicy(provider, policy);

  return {
    get tools() {
      return wrapped.tools;
    },
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const emitResult = (res: ToolExecutionResult): ToolExecutionResult => {
        if (res.ok) {
          observability?.metrics.emit({ type: "counter", name: "agent.tool.executed", value: 1 });
        } else {
          observability?.metrics.emit({ type: "counter", name: "agent.tool.blocked", value: 1 });
        }
        return res;
      };

      const inspection = inspectToolInput({ name: input.name, arguments: input.arguments });
      if (!inspection.safe) {
        return emitResult({ ok: false, error: `unsafe_tool_arguments: ${inspection.reason ?? "validation_failed"}` });
      }

      return emitResult(await wrapped.execute(input));
    },
  };
}

/**
 * 把主仓 ToolRuntime（tool_registrations + handler）适配为 agent-loop 的 ToolProviderPort：
 * - read_only：AI 可自主调用（PET-05）；
 * - write_with_approval：需已授权（toolName+参数哈希匹配 granted）才执行，否则生成 pending 授权并返回 needsApproval（阶段 3a）；
 * - 未注册 / privileged 一律拒绝（fail-closed）；工具停用由 registry enabled 拦截。
 */
export function createRuntimeToolProvider(
  runtime: ToolRuntime,
  tenant: LocalContext,
  deps: {
    conversationRepo: SqliteConversationRepository;
    proactiveActionAuthorizer?: ProactiveActionAuthorizer;
    observability?: Observability;
    capabilityTier?: string;
  },
): ToolProviderPort {
  return {
    // 工具清单随注册表动态变化，不在此静态缓存（execute 时实时校验）
    tools: [],
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const emitResult = (res: ToolExecutionResult): ToolExecutionResult => {
        if (res.ok) {
          deps.observability?.metrics.emit({ type: "counter", name: "agent.tool.executed", value: 1 });
        } else {
          deps.observability?.metrics.emit({ type: "counter", name: "agent.tool.blocked", value: 1 });
        }
        return res;
      };

      const inspection = inspectToolInput({ name: input.name, arguments: input.arguments });
      if (!inspection.safe) {
        return emitResult({ ok: false, error: `unsafe_tool_arguments: ${inspection.reason ?? "validation_failed"}` });
      }

      const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : "tool_execution_error");
      const registrations = await runtime.listTools();
      const tool = registrations.find((t) => t.name === input.name && t.enabled === 1);
      if (!tool) {
        return emitResult({ ok: false, error: `unregistered_tool: ${input.name}` });
      }

      // 只读工具：自主执行
      if (tool.safetyLevel === "read_only") {
        try {
          const output = await runtime.callTool(tenant, tool.id, input.arguments, { signal: input.signal, controlContext: input.controlContext, approval: false });
          return emitResult({ ok: true, output });
        } catch (err) {
          return emitResult({ ok: false, error: errorMessage(err) });
        }
      }

      // CR-043: L1 降级限制层禁止执行写工具与特权工具
      if (deps.capabilityTier === "restricted") {
        return emitResult({
          ok: false,
          error: `tool_restricted_in_tier_l1: 工具 ${tool.name} 属于写操作，在 L1 本地降级阶梯下被安全收紧拦截`,
        });
      }

      // 写工具（write_with_approval / privileged）：统一委托 EventDrivenApprovalPolicy 进行判定
      if (tool.safetyLevel === "write_with_approval" || tool.safetyLevel === "privileged") {
        const policy = new EventDrivenApprovalPolicy(deps.conversationRepo, tenant, {
          proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
          observability: deps.observability,
          toolVersion: tool.updatedAt,
          category: tool.category,
          requiredPermissionsJson: typeof tool.requiredPermissionsJson === "string" ? tool.requiredPermissionsJson : null,
        });

        const decision = await policy.evaluate({
          turnId: input.turnId,
          attemptId: input.attemptId,
          invocationId: input.invocationId,
          toolName: tool.name,
          arguments: input.arguments,
          safetyLevel: tool.safetyLevel,
        });

        if (decision.action === "allow") {
          const proactiveActionId = decision.metadata?.proactiveActionId as string | undefined;
          if (proactiveActionId && deps.proactiveActionAuthorizer) {
            return emitResult(await executeAuthorizedProactiveAction(
              deps.proactiveActionAuthorizer,
              tenant,
              proactiveActionId,
              async () => {
                try {
                  const output = await runtime.callTool(tenant, tool.id, input.arguments, {
                    signal: input.signal,
                    controlContext: input.controlContext,
                    approval: true,
                    proactiveAuthorization: true,
                  });
                  return { ok: true, output };
                } catch (error) {
                  return { ok: false, error: errorMessage(error) };
                }
              },
            ));
          }

          try {
            const output = await runtime.callTool(tenant, tool.id, input.arguments, {
              signal: input.signal,
              controlContext: input.controlContext,
              approval: true,
            });
            return emitResult({ ok: true, output });
          } catch (err) {
            return emitResult({ ok: false, error: errorMessage(err) });
          }
        }

        if (decision.action === "deny") {
          return emitResult({ ok: false, error: decision.reason ?? "permission_denied" });
        }

        return emitResult({
          ok: false,
          needsApproval: {
            approvalId: decision.approvalId!,
            toolName: tool.name,
            argumentsHash: decision.argumentsHash ?? stableStringify(input.arguments),
          },
        });
      }

      // 其它（含不可识别的 safetyLevel）：fail-closed 拒绝
      return emitResult({ ok: false, error: `requires_approval: ${tool.id}（未支持的安全级别）` });
    },
  };
}
