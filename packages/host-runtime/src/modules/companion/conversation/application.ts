import type { LocalContext, SqliteConversationRepository } from "@aervox/repositories";
import { assertConversationExecutionPolicy } from "@aervox/repositories";
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
  return repo.acceptTurn(ctx, {
    ...input,
    ...(bot ? { execution: "api" as const, metadata: undefined, toolApprovalMode: "ask" as const } : {}),
    consumeInbox: !bot && input.consumeInbox,
  });
}

const activeExecutions = new WeakMap<SqliteConversationRepository, Map<string, Promise<void>>>();

/** Platform dispatch and restart recovery use the same admission and product executor as HTTP/Worker. */
export function executeAcceptedConversationTurn(
  repo: SqliteConversationRepository, ctx: LocalContext, input: ConversationTurnInput, deps: ConversationRouteDeps,
): Promise<void> {
  let active = activeExecutions.get(repo);
  if (!active) { active = new Map(); activeExecutions.set(repo, active); }
  const key = JSON.stringify([input.turnId, input.sessionId, input.attemptId]);
  const existing = active.get(key);
  if (existing) return existing;
  const execution = executeConversationTurn(repo, ctx, input, deps).finally(() => active!.delete(key));
  active.set(key, execution);
  return execution;
}
