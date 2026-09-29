/**
 * Aervox｜思隅 @aervox/api — 事件驱动人机回环审批策略 (EventDrivenApprovalPolicy)
 *
 * 依据 aervox_core_decoupling_plan.md Phase 2：
 * 实现通用的 ApprovalPolicyPort，协调 Sqlite 仓储持久化、主动智能授权与 full_access 免审。
 */

import type {
  ApprovalPolicyPort,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@aervox/agent-loop";
import type {
  LocalContext,
  SqliteConversationRepository,
} from "@aervox/repositories";
import type { Observability } from "@aervox/observability";
import {
  getRequestToolApprovalMode,
  isToolAutoApprovable,
} from "../../../shared/tool-approval-policy.js";
import {
  PROACTIVE_ACTION_DECIDER_PREFIX,
  type ProactiveActionAuthorizer,
} from "../../proactive/proactive/index.js";
import { stableStringify } from "./llm-adapter.js";

/** 自动授权决策人前缀；显式授权查询排除该类记录，避免关闭完全访问后泄漏。 */
export const FULL_ACCESS_DECIDER_PREFIX = "permission:full_access:";

export type ToolApprovalRepository = Pick<
  SqliteConversationRepository,
  "recordToolApproval" | "decideToolApproval" | "findGrantedToolApproval"
>;

export async function findExplicitToolApproval(
  repo: ToolApprovalRepository,
  tenant: LocalContext,
  input: { toolName: string; argumentsHash: string },
) {
  return repo.findGrantedToolApproval(tenant, {
    ...input,
    excludeDecidedByPrefixes: [FULL_ACCESS_DECIDER_PREFIX, PROACTIVE_ACTION_DECIDER_PREFIX],
  });
}

export async function recordAutomaticApproval(
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

export interface EventDrivenApprovalPolicyOptions {
  proactiveActionAuthorizer?: ProactiveActionAuthorizer;
  observability?: Observability;
  toolVersion?: string | null;
  category?: string;
  requiredPermissionsJson?: string | null;
}

/**
 * Fastify / SQLite 事件驱动人机回环审批策略实现
 */
export class EventDrivenApprovalPolicy implements ApprovalPolicyPort {
  constructor(
    private readonly repo: ToolApprovalRepository,
    private readonly tenant: LocalContext,
    private readonly options: EventDrivenApprovalPolicyOptions = {},
  ) {}

  async evaluate(req: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    if (req.safetyLevel === "read_only") {
      return { action: "allow" };
    }

    const argumentsHash = stableStringify(req.arguments);
    const granted = await findExplicitToolApproval(this.repo, this.tenant, {
      toolName: req.toolName,
      argumentsHash,
    });
    if (granted) {
      return { action: "allow" };
    }

    const autoApprovable = isToolAutoApprovable(
      {
        name: req.toolName,
        category: this.options.category,
        safetyLevel: req.safetyLevel ?? "write_with_approval",
      },
      req.arguments,
    );

    if (getRequestToolApprovalMode(this.tenant) === "full_access") {
      if (this.options.proactiveActionAuthorizer) {
        const authorization = await this.options.proactiveActionAuthorizer.authorize(this.tenant, {
          turnId: req.turnId,
          attemptId: req.attemptId,
          invocationId: req.invocationId,
          toolId: req.toolName,
          toolName: req.toolName,
          category: this.options.category ?? "system",
          safetyLevel: req.safetyLevel ?? "write_with_approval",
          requiredPermissions: this.options.requiredPermissionsJson,
          arguments: req.arguments,
        });

        if (authorization.authorized) {
          const recorded = await recordAutomaticApproval(
            this.repo,
            this.tenant,
            {
              turnId: req.turnId,
              attemptId: req.attemptId,
              toolName: req.toolName,
              argumentsHash,
              toolVersion: this.options.toolVersion,
            },
            authorization.decidedBy,
          );
          if (!recorded) {
            await this.options.proactiveActionAuthorizer.markFailed(
              this.tenant,
              authorization.action.id,
              "proactive_action_approval_not_recorded",
            );
            return { action: "deny", reason: "proactive_action_approval_not_recorded" };
          }
          return { action: "allow", metadata: { proactiveActionId: authorization.action.id } };
        }
      }

      // CR-022 fallback：普通写工具可由 Turn full_access 预授权；privileged 与高危非自动免审工具无主动授权时仍走管理员/普通通道。
      if (
        (req.safetyLevel === "write_with_approval" || !req.safetyLevel) &&
        autoApprovable
      ) {
        const actor = this.tenant.actorId ?? this.tenant.subjectUserId;
        const recorded = await recordAutomaticApproval(
          this.repo,
          this.tenant,
          {
            turnId: req.turnId,
            attemptId: req.attemptId,
            toolName: req.toolName,
            argumentsHash,
            toolVersion: this.options.toolVersion,
          },
          `${FULL_ACCESS_DECIDER_PREFIX}${actor}`,
        );
        if (!recorded) {
          return { action: "deny", reason: "full_access_approval_not_recorded" };
        }
        return { action: "allow" };
      }
    }

    const approval = await this.repo.recordToolApproval(this.tenant, {
      turnId: req.turnId,
      attemptId: req.attemptId,
      toolName: req.toolName,
      argumentsHash,
      requester: this.tenant.subjectUserId,
      state: "pending",
      toolVersion: this.options.toolVersion,
    });

    return {
      action: "ask_user",
      approvalId: approval.id,
      argumentsHash,
    };
  }
}

export async function executeAuthorizedProactiveAction(
  authorizer: ProactiveActionAuthorizer,
  tenant: LocalContext,
  actionId: string,
  execute: () => Promise<import("@aervox/agent-loop").ToolExecutionResult>,
): Promise<import("@aervox/agent-loop").ToolExecutionResult> {
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
