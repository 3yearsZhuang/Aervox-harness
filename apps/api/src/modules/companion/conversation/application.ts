import type { LocalContext, SqliteConversationRepository } from "@aervox/repositories";
import { assertConversationExecutionPolicy } from "@aervox/repositories";
import type { ConversationRouteDeps } from "./routes.js";
import { runLoopTurnOnce } from "./agent-executor.js";
import { createTenantInboxPort } from "../inbox/index.js";
import { acquireWorkerPressureLease, releaseWorkerPressureLease } from "../../../shared/worker-pressure-lease.js";
import { setRequestToolApprovalMode } from "../../../shared/tool-approval-policy.js";
import { turnStreamHub } from "./stream-hub.js";

/** HTTP and platform ingress share the same atomic Conversation command. */
export async function acceptConversationTurn(
  repo: SqliteConversationRepository, ctx: LocalContext,
  input: Parameters<SqliteConversationRepository["acceptTurn"]>[1],
) {
  const session = await repo.getSession(ctx, input.sessionId);
  if (!session) throw new Error("session_not_found");
  assertConversationExecutionPolicy(session.executionPolicy);
  return repo.acceptTurn(ctx, { ...input, consumeInbox: session.executionPolicy === "local-v1" && input.consumeInbox });
}

const activeExecutions = new WeakMap<SqliteConversationRepository, Map<string, Promise<void>>>();
type AcceptedExecutionInput = { turnId: string; sessionId: string; attemptId: string; userMessage: string; metadata?: Record<string, unknown> };

/** Share an in-process execution between dispatch and recovery; the Loop also claims its durable fencing token. */
export function executeAcceptedConversationTurn(
  repo: SqliteConversationRepository, ctx: LocalContext, input: AcceptedExecutionInput, deps: ConversationRouteDeps,
): Promise<void> {
  let active = activeExecutions.get(repo);
  if (!active) { active = new Map(); activeExecutions.set(repo, active); }
  const key = JSON.stringify([input.turnId, input.sessionId, input.attemptId]);
  const existing = active.get(key);
  if (existing) return existing;
  const execution = executeAcceptedOnce(repo, ctx, input, deps).finally(() => active!.delete(key));
  active.set(key, execution);
  return execution;
}

/** Resolve the persisted audience before loading any private dependency. */
async function executeAcceptedOnce(
  repo: SqliteConversationRepository, ctx: LocalContext,
  input: AcceptedExecutionInput,
  deps: ConversationRouteDeps,
): Promise<void> {
  const pressureLease = acquireWorkerPressureLease();
  let validated = false;
  let bot = false;
  try {
    const turn = await repo.getTurn(ctx, input.turnId);
    const session = await repo.getSession(ctx, input.sessionId);
    if (!turn || !session || turn.sessionId !== input.sessionId || turn.executionPolicy !== session.executionPolicy) throw new Error("conversation_policy_mismatch");
    assertConversationExecutionPolicy(turn.executionPolicy);
    const attempt = (await repo.listTurnAttempts(ctx, turn.id)).find(candidate => candidate.id === input.attemptId);
    if (!attempt) throw new Error("conversation_attempt_mismatch");
    if (!["Created", "Running"].includes(turn.status) || attempt.status !== "Running") return;
    validated = true;
    // Callers cannot substitute another platform member's text for the accepted input.
    const userMessage = await repo.getTurnUserMessage(ctx, turn.id);
    if (userMessage === null) throw new Error("conversation_input_unavailable");
    const group = turn.executionPolicy === "bot-group-member-v1";
    bot = turn.executionPolicy !== "local-v1";
    if (bot) setRequestToolApprovalMode(ctx, "ask");
    await runLoopTurnOnce(repo, ctx, { ...input, userMessage, metadata: bot ? undefined : input.metadata }, {
      llmConfigService: deps.llmConfigService, modelRoutingService: deps.modelRoutingService,
      safetyService: deps.safetyService, platformRepo: deps.platformRepo, observability: deps.observability,
      deletionGate: deps.privacyRepo ? { isBlocked: () => deps.privacyRepo!.hasPendingDeletionRequest(ctx) } : undefined,
      ...(!group ? {
        toolRuntime: deps.toolRuntime, persona: await deps.personaLoader?.(ctx),
        skills: await deps.skillLoader?.(), memoryRecall: deps.memoryRecall,
        pluginRegistrations: deps.pluginRegistrations?.(), pluginHostServices: deps.pluginHostServices,
        extensionRepo: deps.extensionRepo, pluginConfigRepo: deps.pluginConfigRepo, pluginRegistry: deps.pluginRegistry,
      } : {}),
      ...(!bot ? {
        inbox: deps.inboxRepo ? createTenantInboxPort(deps.inboxRepo, ctx) : undefined,
        subagentFactory: deps.subagentFactory, workflows: deps.workflows,
        userQuestionPort: deps.userQuestionCoordinator?.createPort(ctx),
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer, proactiveRepository: deps.proactiveRepository,
      } : {}),
    });
  } catch (error) {
    deps.observability?.log.error({ event: "turn.dispatch_failed", message: "Turn dispatch failed", fields: { turnId: input.turnId } });
    if (!validated) throw error;
    // A preload failure belongs to an unclaimed attempt only. Do not overwrite another
    // executor's lease or a terminal result (including a successful turn followed by hook failure).
    const attempt = (await repo.listTurnAttempts(ctx, input.turnId)).find(candidate => candidate.id === input.attemptId);
    if (attempt?.status === "Running" && attempt.fencingToken === 0) {
      const events = await repo.getStreamEvents(ctx, input.turnId);
      const sequence = Math.max(0, ...events.map(event => event.sequence)) + 1;
      const finalized = await repo.finalizeAttemptWithEventAtomically(ctx, {
        turnId: input.turnId, attemptId: input.attemptId, status: "Failed", expectedFencingToken: 0,
        sequence, eventType: "error", safetyDecision: "approved",
        eventData: { code: "MODEL_UNAVAILABLE", retryable: false, message: "会话执行失败，请在工作台重试。", lastSequence: sequence },
      });
      if (finalized) {
        await repo.updateTurnStatus(ctx, input.turnId, "Failed", sequence);
        const [event] = await repo.getStreamEvents(ctx, input.turnId, sequence - 1);
        if (event) turnStreamHub.publishEvent(input.turnId, event);
        turnStreamHub.publishSettled(input.turnId, "Failed");
        return;
      }
    }
    if (!attempt || attempt.status === "Running" || attempt.status === "CancelRequested") throw error;
  } finally {
    releaseWorkerPressureLease(pressureLease);
    if (validated && bot) await repo.synchronizeTurnWithLatestAttempt(input.turnId);
  }
}
