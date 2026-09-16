/**
 * Aervox｜思隅 @aervox/api — Agent Loop 工具提供者（Contribution 授权门 + ToolRuntime 适配）
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * 静态 Contribution 工具的通用写授权门（PET-05 / 阶段 3a / CR-022 full_access
 * 预授权）与动态 tool_registrations 运行时适配（CAP-033 主动动作授权）逐字节迁移。
 */
import { inspectToolInput } from "@aervox/agent-loop";
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
import {
  getRequestToolApprovalMode,
  isToolAutoApprovable,
} from "../../shared/tool-approval-policy.js";
import {
  PROACTIVE_ACTION_DECIDER_PREFIX,
  type ProactiveActionAuthorizer,
} from "../proactive/action-authorizer.js";
import type { ToolRuntime } from "../tools/runtime.js";
import { stableStringify } from "./llm-adapter.js";

/** 自动授权决策人前缀；显式授权查询排除该类记录，避免关闭完全访问后泄漏。 */
export const FULL_ACCESS_DECIDER_PREFIX = "permission:full_access:";

type ToolApprovalRepository = Pick<
  SqliteConversationRepository,
  "recordToolApproval" | "decideToolApproval" | "findGrantedToolApproval"
>;

async function findExplicitToolApproval(
  repo: ToolApprovalRepository,
  tenant: LocalContext,
  input: { toolName: string; argumentsHash: string },
) {
  return repo.findGrantedToolApproval(tenant, {
    ...input,
    excludeDecidedByPrefixes: [FULL_ACCESS_DECIDER_PREFIX, PROACTIVE_ACTION_DECIDER_PREFIX],
  });
}

async function recordAutomaticApproval(
  repo: ToolApprovalRepository,
  tenant: LocalContext,
  input: {
    turnId: string;
    attemptId: string;
    toolName: string;
    argumentsHash: string;
    toolVersion?: string | null;
  },
  decidedBy: string,
): Promise<boolean> {
  const approval = await repo.recordToolApproval(tenant, {
    ...input,
    requester: tenant.subjectUserId,
    state: "pending",
  });
  const actor = tenant.actorId ?? tenant.subjectUserId;
  const granted = await repo.decideToolApproval(
    tenant,
    approval.id,
    "granted",
    decidedBy || `${FULL_ACCESS_DECIDER_PREFIX}${actor}`,
  );
  return granted !== null;
}

async function executeAuthorizedProactiveAction(
  authorizer: ProactiveActionAuthorizer,
  tenant: LocalContext,
  actionId: string,
  execute: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    await authorizer.markRunning(tenant, actionId);
    const result = await execute();
    if (result.ok) await authorizer.markExecuted(tenant, actionId, result.output);
    else await authorizer.markFailed(tenant, actionId, result.error ?? "tool_execution_failed");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await authorizer.markFailed(tenant, actionId, message).catch(() => undefined);
    return { ok: false, error: message };
  }
}

/**
 * 给静态 Contribution 工具补齐通用写工具授权门：
 * readOnly 直接执行；写工具命中显式授权或本 Turn 完全访问后执行。
 */
export function createApprovalGatedToolProvider(
  provider: ToolProviderPort,
  tenant: LocalContext,
  repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionAuthorizer,
  observability?: Observability,
): ToolProviderPort {
  const specs = new Map(provider.tools.map((tool) => [tool.name, tool]));
  return {
    tools: provider.tools,
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

      const spec = specs.get(input.name);
      if (!spec || spec.readOnly) return emitResult(await provider.execute(input));

      const argumentsHash = stableStringify(input.arguments);
      const granted = await findExplicitToolApproval(repo, tenant, {
        toolName: input.name,
        argumentsHash,
      });
      if (granted) return emitResult(await provider.execute(input));

      const autoApprovable = isToolAutoApprovable(
        {
          name: input.name,
          safetyLevel: spec?.readOnly ? "read_only" : "write_with_approval",
        },
        input.arguments,
      );

      if (getRequestToolApprovalMode(tenant) === "full_access" && autoApprovable) {
        if (proactiveActionAuthorizer) {
          const authorization = await proactiveActionAuthorizer.authorize(tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: input.invocationId,
            toolId: input.name,
            toolName: input.name,
            category: "system",
            safetyLevel: "write_with_approval",
            arguments: input.arguments,
          });
          if (authorization.authorized) {
            const recorded = await recordAutomaticApproval(repo, tenant, {
              turnId: input.turnId,
              attemptId: input.attemptId,
              toolName: input.name,
              argumentsHash,
            }, authorization.decidedBy);
            if (!recorded) {
              await proactiveActionAuthorizer.markFailed(
                tenant,
                authorization.action.id,
                "proactive_action_approval_not_recorded",
              );
              return emitResult({ ok: false, error: "proactive_action_approval_not_recorded" });
            }
            return emitResult(await executeAuthorizedProactiveAction(
              proactiveActionAuthorizer,
              tenant,
              authorization.action.id,
              () => provider.execute(input),
            ));
          }
        }
        const actor = tenant.actorId ?? tenant.subjectUserId;
        const recorded = await recordAutomaticApproval(repo, tenant, {
          turnId: input.turnId,
          attemptId: input.attemptId,
          toolName: input.name,
          argumentsHash,
        }, `${FULL_ACCESS_DECIDER_PREFIX}${actor}`);
        if (!recorded) return emitResult({ ok: false, error: "full_access_approval_not_recorded" });
        return emitResult(await provider.execute(input));
      }

      const approval = await repo.recordToolApproval(tenant, {
        turnId: input.turnId,
        attemptId: input.attemptId,
        toolName: input.name,
        argumentsHash,
        requester: tenant.subjectUserId,
        state: "pending",
      });
      return emitResult({
        ok: false,
        needsApproval: { approvalId: approval.id, toolName: input.name, argumentsHash },
      });
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
          const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: false });
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

      // 写工具（write_with_approval / privileged）：须已授权（参数哈希匹配 + granted），否则生成待决授权。
      // privileged 与 write 同流程；「仅管理员可批准」由路由 decideToolApproval 的管理员校验把关（3b）。
      if (tool.safetyLevel === "write_with_approval" || tool.safetyLevel === "privileged") {
        const hash = stableStringify(input.arguments);
        const granted = await findExplicitToolApproval(deps.conversationRepo, tenant, {
          toolName: tool.name,
          argumentsHash: hash,
        });
        if (granted) {
          try {
            const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: true });
            return emitResult({ ok: true, output });
          } catch (err) {
            return emitResult({ ok: false, error: errorMessage(err) });
          }
        }
        // 主动智能模式下，全动作授权包可覆盖普通写、外部、privileged 与不可逆动作；
        // 每次执行仍绑定当前画像修订/租约/scope 并写入本地动作账本。
        if (
          getRequestToolApprovalMode(tenant) === "full_access" &&
          deps.proactiveActionAuthorizer
        ) {
          const authorization = await deps.proactiveActionAuthorizer.authorize(tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            invocationId: input.invocationId,
            toolId: tool.id,
            toolName: tool.name,
            category: tool.category,
            safetyLevel: tool.safetyLevel,
            requiredPermissions: tool.requiredPermissionsJson,
            arguments: input.arguments,
          });
          if (authorization.authorized) {
            const recorded = await recordAutomaticApproval(deps.conversationRepo, tenant, {
              turnId: input.turnId,
              attemptId: input.attemptId,
              toolName: tool.name,
              argumentsHash: hash,
              toolVersion: tool.updatedAt,
            }, authorization.decidedBy);
            if (!recorded) {
              await deps.proactiveActionAuthorizer.markFailed(
                tenant,
                authorization.action.id,
                "proactive_action_approval_not_recorded",
              );
              return emitResult({ ok: false, error: "proactive_action_approval_not_recorded" });
            }
            return emitResult(await executeAuthorizedProactiveAction(
              deps.proactiveActionAuthorizer,
              tenant,
              authorization.action.id,
              async () => {
                try {
                  const output = await runtime.callTool(tenant, tool.id, input.arguments, {
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
        }
        // CR-022 fallback：普通写工具可由 Turn full_access 预授权；privileged 与高危非自动免审工具无主动授权时仍走管理员/普通通道。
        if (
          tool.safetyLevel === "write_with_approval" &&
          getRequestToolApprovalMode(tenant) === "full_access" &&
          isToolAutoApprovable(tool, input.arguments)
        ) {
          const actor = tenant.actorId ?? tenant.subjectUserId;
          const recorded = await recordAutomaticApproval(deps.conversationRepo, tenant, {
            turnId: input.turnId,
            attemptId: input.attemptId,
            toolName: tool.name,
            argumentsHash: hash,
            toolVersion: tool.updatedAt,
          }, `${FULL_ACCESS_DECIDER_PREFIX}${actor}`);
          if (!recorded) return emitResult({ ok: false, error: "full_access_approval_not_recorded" });
          try {
            const output = await runtime.callTool(tenant, tool.id, input.arguments, { approval: true });
            return emitResult({ ok: true, output });
          } catch (err) {
            return emitResult({ ok: false, error: errorMessage(err) });
          }
        }
        const approval = await deps.conversationRepo.recordToolApproval(tenant, {
          turnId: input.turnId,
          attemptId: input.attemptId,
          toolName: tool.name,
          argumentsHash: hash,
          requester: tenant.subjectUserId,
          state: "pending",
          toolVersion: tool.updatedAt,
        });
        return emitResult({ ok: false, needsApproval: { approvalId: approval.id, toolName: tool.name, argumentsHash: hash } });
      }

      // 其它（含不可识别的 safetyLevel）：fail-closed 拒绝
      return emitResult({ ok: false, error: `requires_approval: ${tool.id}（未支持的安全级别）` });
    },
  };
}
