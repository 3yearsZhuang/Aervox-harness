import { recoverApiOwnedTurn } from "./api-owned-recovery.js";
import type { IConversationRepository, LocalContext, SqliteConversationRepository } from "@aervox/repositories";
import { assertConversationExecutionPolicy, normalizeTurnIntent } from "@aervox/repositories";
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

const activeExecutions = new WeakMap<SqliteConversationRepository, Map<string, Promise<void>>>();

/** Platform dispatch and restart recovery use the same admission and product executor as HTTP/Worker. */
export function executeAcceptedConversationTurn(
  repo: SqliteConversationRepository, ctx: LocalContext, input: ConversationTurnInput, deps: ConversationRouteDeps,
  execute?: (ctx: LocalContext, input: ConversationTurnInput) => Promise<void>,
): Promise<void> {
  let active = activeExecutions.get(repo);
  if (!active) { active = new Map(); activeExecutions.set(repo, active); }
  const key = JSON.stringify([input.turnId, input.sessionId, input.attemptId]);
  const existing = active.get(key);
  if (existing) return existing;
  const execution = repo.getAcceptedTurnParameters(ctx, input.turnId).then(parameters =>
    execute ? execute({ ...ctx, actorId: parameters.actorId }, { ...input, ...parameters })
      : executeConversationTurn(repo, { ...ctx, actorId: parameters.actorId }, { ...input, ...parameters }, deps),
  ).finally(() => active!.delete(key));
  active.set(key, execution);
  return execution;
}

export interface ConversationCommandPort {
  ensureSession: IConversationRepository["getOrCreateSession"];
  accept: (ctx: LocalContext, input: Parameters<IConversationRepository["acceptTurn"]>[1]) => ReturnType<IConversationRepository["acceptTurn"]>;
  execute(ctx: LocalContext, input: ConversationTurnInput): Promise<void>;
  requestCancel: IConversationRepository["requestCancelTurnAttempt"];
  recover(turnId: string): Promise<"unclaimed" | "active" | "settled">;
}
export interface ConversationQueryPort {
  getTurn: IConversationRepository["getTurn"];
  listTurnAttempts: IConversationRepository["listTurnAttempts"];
  getStreamEvents: IConversationRepository["getStreamEvents"];
  loadDelegatedTurn(turnId: string): Promise<ConversationTurnInput | null>;
}

/** The application owns repositories and execution assembly; adapters see only commands and projections. */
export function createConversationApplication(
  repo: SqliteConversationRepository, deps: ConversationRouteDeps,
  execute?: (ctx: LocalContext, input: ConversationTurnInput) => Promise<void>,
): { commands: ConversationCommandPort; queries: ConversationQueryPort } {
  return {
    commands: {
      ensureSession: repo.getOrCreateSession.bind(repo),
      accept: (ctx, input) => acceptConversationTurn(repo, ctx, input),
      execute: (ctx, input) => executeAcceptedConversationTurn(repo, ctx, input, deps, execute),
      requestCancel: repo.requestCancelTurnAttempt.bind(repo),
      recover: turnId => recoverApiOwnedTurn(repo, turnId),
    },
    queries: {
      getTurn: repo.getTurn.bind(repo), listTurnAttempts: repo.listTurnAttempts.bind(repo),
      getStreamEvents: repo.getStreamEvents.bind(repo),
      async loadDelegatedTurn(turnId) {
        const ctx = { workspaceId: "local", subjectUserId: "local" };
        const turn = await repo.getTurn(ctx, turnId);
        if (!turn || !["Created", "Running"].includes(turn.status) || turn.dispatchTarget !== "default" || turn.executionPolicy !== "local-v1") return null;
        const attempt = (await repo.listTurnAttempts(ctx, turnId)).find(candidate => candidate.status === "Running" && candidate.fencingToken === 0 && !candidate.leaseId);
        if (!attempt) return null;
        const parameters = await repo.getAcceptedTurnParameters(ctx, turnId);
        return { turnId, sessionId: turn.sessionId, attemptId: attempt.id, ...parameters };
      },
    },
  };
}
