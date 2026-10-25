import type { LocalContext, SqliteConversationRepository } from "@aervox/repositories";
import { TurnIntentConflictError } from "@aervox/repositories";
import { buildResumeHistory } from "@aervox/core";
import { readToolApprovalIdentity } from "./tool-approval-identity.js";
import { turnStreamHub } from "./stream-hub.js";
import type { ConversationRouteDeps, ConversationTurnInput } from "./execution.js";

export class ConversationCommandError extends Error {
  constructor(readonly statusCode: number, readonly body: { error: string }) { super(body.error); }
}

/** One approval command owns policy, transaction and execution continuation for every ingress. */
export async function decideConversationApproval(
  conversationRepo: SqliteConversationRepository, deps: ConversationRouteDeps,
  executeAccepted: (ctx: LocalContext, input: ConversationTurnInput) => Promise<void>,
  tenant: LocalContext, turnId: string,
  input: { approvalId: string; decision: "granted" | "denied"; adminId?: string },
) {
  const approval = await conversationRepo.getToolApproval(tenant, input.approvalId);
  if (!approval || approval.turnId !== turnId) throw new ConversationCommandError(404, { error: "approval not found" });
  if (approval.state !== "pending" && approval.state !== input.decision) {
    throw new ConversationCommandError(409, { error: "approval_already_decided" });
  }
  let pluginGeneration: { pluginId: string; generation: string } | undefined;
  if (input.decision === "granted" && approval.state === "pending") {
    // Every source persists the policy of its exact dispatch binding. Looking
    // only at runtime rows omits static/plugin contributions and fails open.
    const identity = readToolApprovalIdentity(approval.toolVersion);
    if (!identity || (identity.kind === "contribution" && identity.id !== approval.toolName)
      || !["write_with_approval", "privileged", "destructive"].includes(identity.safetyLevel)) {
      throw new ConversationCommandError(409, { error: "approval_binding_unavailable" });
    }
    if (identity.safetyLevel === "privileged") {
      const adminId = input.adminId;
      // 缺陷 E：管理员白名单经 @aervox/config 集中解析（AERVOX_ADMIN_IDS）
      const allowed = deps.executionConfig.adminIds;
      if (adminId === undefined || !allowed.includes(adminId)) {
        throw new ConversationCommandError(403, { error: "admin_required: privileged tool approval requires x-admin-user-id in AERVOX_ADMIN_IDS" });
      }
    }
    const mcp = identity.kind === "runtime" && identity.owner.startsWith("mcp:");
    if (identity.generation !== null || (identity.owner !== "host" && !mcp)) {
      const plugin = await deps.extensionRepo?.getPlugin(identity.owner);
      if (!identity.generation || !plugin || plugin.enabled !== 1
        || (plugin.availability ?? "available") !== "available" || plugin.lifecycleGeneration !== identity.generation) {
        throw new ConversationCommandError(409, { error: "approval_binding_expired" });
      }
      pluginGeneration = { pluginId: identity.owner, generation: identity.generation };
    }
    if (identity.kind === "runtime") {
      const tool = (await deps.toolRuntime?.exportRegistry())?.find(candidate => candidate.id === identity.id);
      if (!tool || tool.name !== approval.toolName || (tool.pluginId ?? "host") !== identity.owner
        || tool.approvalRevision !== identity.revision || (tool.safetyLevel ?? "write_with_approval") !== identity.safetyLevel
        || (tool.pluginId?.startsWith("mcp:") && !(await deps.isMcpToolAllowed?.(tool)))) {
        throw new ConversationCommandError(409, { error: "approval_binding_expired" });
      }
    }
  }
  // Verify the receipt before transferring ownership to a new Attempt. The
  // execution entry revalidates it again before dispatching any product work.
  if (approval.state === "pending") {
    try { await conversationRepo.getAcceptedTurnParameters(tenant, turnId); }
    catch (error) {
      if (error instanceof TurnIntentConflictError) throw new ConversationCommandError(409, {error: "turn_intent_unavailable"});
      throw error;
    }
  }
  let decided: Awaited<ReturnType<SqliteConversationRepository["decideToolApprovalAndResume"]>>;
  try {
    decided = await conversationRepo.decideToolApprovalAndResume(tenant, {
      turnId, approvalId: input.approvalId, decision: input.decision,
      decidedBy: tenant.actorId ?? tenant.subjectUserId,
      ...(input.decision === "granted" && approval.toolVersion ? { toolVersion: approval.toolVersion } : {}),
      pluginGeneration,
    });
  } catch (error) {
    if (error instanceof Error && ["plugin_generation_changed", "tool_approval_binding_changed"].includes(error.message)) {
      throw new ConversationCommandError(409, { error: "approval_binding_expired" });
    }
    throw error;
  }
  if (!decided) throw new ConversationCommandError(404, { error: "approval not found" });
  if (!decided.ready) throw new ConversationCommandError(409, { error: "approval_not_resumable" });
  if (decided.approval.state !== input.decision) throw new ConversationCommandError(409, { error: "approval_already_decided" });
  if (decided.event) turnStreamHub.publishEvent(turnId, decided.event);
  if (decided.continuation) {
    const { attempt, pending, turn, toolCallId, step } = decided.continuation;
    const userMessage = (await conversationRepo.getTurnUserMessage(tenant, turnId)) ?? "";
    const events = await conversationRepo.getStreamEvents(tenant, turnId, 0);
    const resumed = buildResumeHistory({ userMessage,
      events: events as unknown as import("@aervox/core").ResumeEventLike[] });
    void executeAccepted(tenant, { turnId, sessionId: turn.sessionId, attemptId: attempt.id, userMessage,
      resume: { expectedFencingToken: 0, lastSequence: decided.event!.sequence,
        lastStep: step, history: resumed.history, messageId: resumed.messageId,
        pendingApprovalResolution: { approvalId: decided.approval.id, decision: input.decision,
          invocationId: pending.invocationId,
          toolCall: { id: toolCallId, name: pending.name, arguments: pending.argumentsJson ?? {} } },
      },
    }).catch(err => deps.observability?.log.warn({ event: "turn.resume_failed", message: "Turn resume failed after approval decision", fields: { turnId, error: String(err) } }));
  }
  const attemptId = (decided.event?.data as { continuationAttemptId?: string } | undefined)?.continuationAttemptId;
  return { approvalId: decided.approval.id, state: decided.approval.state,
    ...(attemptId && decided.event ? { continuation: { attemptId, afterEventId: decided.event.id } } : {}),
  };
}
