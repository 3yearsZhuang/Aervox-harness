import { recoverApiOwnedTurn } from "./api-owned-recovery.js";
import { snapshotExecutionConfig } from "@aervox/config";
import type { IConversationRepository, LocalContext, SqliteConversationRepository } from "@aervox/repositories";
import { assertConversationExecutionPolicy, normalizeTurnIntent } from "@aervox/repositories";
import { decideConversationApproval, ConversationCommandError } from "./approval-command.js";
import { turnStreamHub } from "./stream-hub.js";
import { executeConversationTurn, type ConversationRouteDeps, type ConversationTurnInput } from "./execution.js";

/** HTTP and platform ingress share policy-aware atomic acceptance. */
export async function acceptConversationTurn(
  repo: SqliteConversationRepository, ctx: LocalContext,
  input: Parameters<SqliteConversationRepository["acceptTurn"]>[1],
) {
  const session = await repo.getSession(ctx, input.sessionId);
  if (!session) throw new Error("session_not_found");
  assertConversationExecutionPolicy(session.executionPolicy);
  const bot = session.executionPolicy !== "local-v1";
  const intent = normalizeTurnIntent(input, session.executionPolicy, ctx.actorId);
  return repo.acceptTurn(ctx, {
    ...input, metadata: intent.metadata, toolApprovalMode: intent.toolApprovalMode,
    actorId: ctx.actorId, executionPolicy: session.executionPolicy,
    ...(bot ? { execution: "api" as const } : {}),
    consumeInbox: !bot && input.consumeInbox,
  });
}

/** The application owns execution, cancellation and policy; transports only adapt commands and projections. */
export function createConversationApplication(
  repo: SqliteConversationRepository, deps: ConversationRouteDeps,
  execute?: (ctx: LocalContext, input: ConversationTurnInput) => Promise<void>,
) {
  if (!deps.executionConfig) throw new Error("execution_config_required");
  const executionConfig = snapshotExecutionConfig(deps.executionConfig);
  const executionDeps = () => ({ ...deps, executionConfig });
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("conversation_host_closed"); };
  const active = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const run = (ctx: LocalContext, input: ConversationTurnInput): Promise<void> => {
    if (closed) return Promise.reject(new Error("conversation_host_closed"));
    const key = JSON.stringify([input.turnId, input.sessionId, input.attemptId]);
    const existing = active.get(key); if (existing) return existing;
    const controller = new AbortController(); controllers.set(key, controller);
    const task = repo.getAcceptedTurnParameters(ctx, input.turnId).then(parameters => {
      const accepted = { ...input, ...parameters, signal: input.signal
        ? AbortSignal.any([input.signal, controller.signal]) : controller.signal };
      const acceptedContext = { ...ctx, actorId: parameters.actorId };
      return execute ? execute(acceptedContext, accepted) : executeConversationTurn(repo, acceptedContext, accepted, executionDeps());
    }).finally(() => { active.delete(key); controllers.delete(key); controller.abort(); });
    active.set(key, task); return task;
  };
  const requestCancel: IConversationRepository["requestCancelTurnAttempt"] = async (ctx, input) => {
    const result = await repo.requestCancelTurnAttempt(ctx, input);
    if (result.ok) {
      controllers.get(JSON.stringify([input.turnId, (await repo.getTurn(ctx, input.turnId))?.sessionId, input.attemptId]))
        ?.abort(new Error("turn_cancel_requested"));
      const state = await repo.getStreamReplayState(ctx, input.turnId);
      if (state.settled) {
        for (const event of await repo.getStreamEvents(ctx, input.turnId, Math.max(0, state.highWaterSequence - 1))) turnStreamHub.publishEvent(input.turnId, event);
        turnStreamHub.publishSettled(input.turnId, "Cancelled");
      }
    }
    return result;
  };
  const commands = {
    ensureSession: repo.getOrCreateSession.bind(repo),
    createSession: repo.createSession.bind(repo), renameSession: repo.renameSession.bind(repo), deleteSession: repo.deleteSession.bind(repo),
    createMessage: repo.createMessage.bind(repo), editMessage: repo.editMessage.bind(repo),
    deleteMessage: repo.softDeleteMessage.bind(repo), restoreMessage: repo.restoreMessage.bind(repo),
    accept: (ctx: LocalContext, input: Parameters<IConversationRepository["acceptTurn"]>[1]) => {
      assertOpen(); return acceptConversationTurn(repo, ctx, input);
    },
    async createTurn(ctx: LocalContext, input: Omit<Parameters<IConversationRepository["acceptTurn"]>[1], "consumeInbox" | "execution">) {
      assertOpen();
      await repo.getOrCreateSession(ctx, input.sessionId, "Aervox 会话");
      const execution = executionConfig.turnExecution === "inline" ? "api" : executionConfig.loopDispatch;
      const accepted = await acceptConversationTurn(repo, ctx, { ...input, execution, consumeInbox: Boolean(deps.inboxRepo) });
      if (accepted.created && !(execution === "worker" && accepted.turn.dispatchTarget !== "api")) {
        const task = run(ctx, { turnId: accepted.turn.id, sessionId: accepted.turn.sessionId,
          attemptId: accepted.attempt!.id, userMessage: accepted.message.content });
        if (executionConfig.turnExecution === "inline") await task;
        else void task.catch(error => deps.observability?.log.error({ event: "turn.dispatch_failed", message: String(error) }));
      }
      return accepted;
    },
    execute: run, requestCancel,
    async cancelTurn(ctx: LocalContext, turnId: string) {
      const attempts = await repo.listTurnAttempts(ctx, turnId);
      const running = attempts.find(attempt => ["Running", "CancelRequested"].includes(attempt.status));
      if (!running) {
        if (attempts[0]?.status === "Cancelled") return { turnId, status: "Cancelled", cancelled: true };
        throw new ConversationCommandError(attempts.length ? 409 : 404, { error: attempts.length ? "turn_already_finalized" : "turn_not_found" });
      }
      const result = await requestCancel(ctx, { turnId, attemptId: running.id });
      if (!result.ok) throw new ConversationCommandError(409, { error: result.reason ?? "request_cancel_failed" });
      const attempt = (await repo.listTurnAttempts(ctx, turnId)).find(candidate => candidate.id === running.id)!;
      return { turnId, status: attempt.status, cancelled: true };
    },
    async answerQuestions(ctx: LocalContext, turnId: string, answers: Parameters<NonNullable<ConversationRouteDeps["userQuestionCoordinator"]>["submitAnswers"]>[2]) {
      if (!deps.userQuestionCoordinator) throw new ConversationCommandError(404, { error: "user_questions_disabled" });
      return deps.userQuestionCoordinator.submitAnswers(ctx, turnId, answers);
    },
    approve: (ctx: LocalContext, turnId: string, input: Parameters<typeof decideConversationApproval>[5]) => {
      assertOpen(); return decideConversationApproval(repo, executionDeps(), run, ctx, turnId, input);
    },
    recover: (turnId: string) => recoverApiOwnedTurn(repo, turnId),
  };
  const queries = {
    getTurn: repo.getTurn.bind(repo), listTurnAttempts: repo.listTurnAttempts.bind(repo), getTurnDiagnostics: repo.getTurnDiagnostics.bind(repo),
    listSessions: repo.listSessions.bind(repo), listMessageVersions: repo.listMessageVersions.bind(repo),
    async messageDeleteImpact(ctx: LocalContext, messageId: string) {
      if (!(await repo.getMessage(ctx, messageId))) return null;
      const versions = await repo.listMessageVersions(ctx, messageId);
      const impacts = [...new Set(versions.map(version => version.turnId))].map(turnId => ({
        type: "summary" as const, id: turnId, description: `Turn ${turnId} 的摘要可能引用此消息`,
      }));
      return { messageId, impacts, totalAffected: impacts.length };
    },
    getStreamEvents: repo.getStreamEvents.bind(repo), getStreamEventById: repo.getStreamEventById.bind(repo),
    getStreamEventForDisclosure: repo.getStreamEventForDisclosure.bind(repo), isTurnStreamDisclosable: repo.isTurnStreamDisclosable.bind(repo),
    getStreamEventHighWater: repo.getStreamEventHighWater.bind(repo), getStreamReplayState: repo.getStreamReplayState.bind(repo), getStreamEventsPage: repo.getStreamEventsPage.bind(repo),
    async pendingQuestions(ctx: LocalContext, turnId: string) {
      if (!deps.userQuestionCoordinator) throw new ConversationCommandError(404, { error: "user_questions_disabled" });
      return deps.userQuestionCoordinator.getPending(ctx, turnId);
    },
    async subagents(ctx: LocalContext, turnId: string) {
      if (!deps.subagentRunRepo) throw new ConversationCommandError(404, { error: "subagent_runs_disabled" });
      return deps.subagentRunRepo.listRunsByTurn(ctx, turnId);
    },
    workflows: () => (deps.workflows ?? []).map(workflow => ({ name: workflow.name, description: workflow.description,
      steps: workflow.steps.map(step => step.description) })),
    async loadDelegatedTurn(turnId: string, eventId?: string): Promise<ConversationTurnInput | null> {
      if (!(await repo.hasWorkerDelegation(turnId, eventId))) return null;
      const ctx = { workspaceId: "local", subjectUserId: "local" };
      const turn = await repo.getTurn(ctx, turnId);
      if (!turn || !["Created", "Running"].includes(turn.status) || turn.dispatchTarget !== "default" || turn.executionPolicy !== "local-v1") return null;
      const attempt = (await repo.listTurnAttempts(ctx, turnId)).find(candidate => candidate.attempt === 1 && candidate.status === "Running" && candidate.fencingToken === 0 && !candidate.leaseId);
      if (!attempt) return null;
      return { turnId, sessionId: turn.sessionId, attemptId: attempt.id, ...await repo.getAcceptedTurnParameters(ctx, turnId) };
    },
  };
  return { commands, queries, async close() {
    closed = true;
    for (const controller of controllers.values()) controller.abort(new Error("host_shutdown"));
    await Promise.allSettled(active.values());
  } };
}
export type ConversationApplication = ReturnType<typeof createConversationApplication>;
export type ConversationCommandPort = ConversationApplication["commands"];
export type ConversationQueryPort = ConversationApplication["queries"];
