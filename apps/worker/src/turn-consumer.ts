import type { IOutboxRepository, OutboxEventModel } from "@aervox/repositories";
import type { ConversationHost } from "@aervox/host-runtime";
import type { OutboxEventHandler } from "./outbox-worker.js";

export const DELEGATED_TURN_EVENT = "agent.turn.requested";
type TurnConsumerHost = {
  queries: Pick<ConversationHost["queries"], "inspectDelegatedTurn">;
  commands: Pick<ConversationHost["commands"], "execute">;
};

class InvalidDelegationError extends Error {}
class AdmissionFailure extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}

/** A delivery locates the original receipt; it does not authorize execution. */
function delegatedTurnId(event: OutboxEventModel): string {
  let raw: unknown;
  try { raw = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload; }
  catch { throw new InvalidDelegationError("invalid_delegated_turn_payload"); }
  if (!raw || typeof raw !== "object") throw new InvalidDelegationError("invalid_delegated_turn_payload");
  const payload = raw as { execution?: unknown; turnId?: unknown };
  if (payload.execution !== "worker" || typeof payload.turnId !== "string") {
    throw new InvalidDelegationError("invalid_delegated_turn_owner");
  }
  return payload.turnId;
}

/** Only a settled original Attempt permits acknowledging its dispatch. */
async function consume(host: TurnConsumerHost, event: OutboxEventModel, signal?: AbortSignal): Promise<void | "deferred"> {
  if (signal?.aborted) return "deferred";
  const turnId = delegatedTurnId(event);
  const before = await host.queries.inspectDelegatedTurn(turnId, event.id);
  if (before.state === "unavailable") throw new InvalidDelegationError("delegated_turn_receipt_unavailable");
  if (before.state === "settled") return;
  if (before.state !== "ready" || signal?.aborted) return "deferred";
  let failure: { cause: unknown } | undefined;
  try {
    await host.commands.execute({ workspaceId: "local", subjectUserId: "local" }, {
      ...before.input, signal,
    });
  } catch (error) { failure = { cause: error }; }
  // Claim losers, live owners and unresolved outcomes must leave the receipt
  // pending. A resolved Promise alone is not a durable execution result.
  const after = await host.queries.inspectDelegatedTurn(turnId, event.id);
  if (after.state === "unavailable") throw new InvalidDelegationError("delegated_turn_receipt_unavailable");
  if (after.state === "settled") return;
  if (after.state === "ready" && failure && !signal?.aborted) throw new AdmissionFailure(failure.cause);
  return "deferred";
}

export function createTurnConsumerHandler(host: TurnConsumerHost): OutboxEventHandler {
  return event => event.eventType === DELEGATED_TURN_EVENT ? consume(host, event) : Promise.resolve();
}

/** A bounded batch remains owned by WorkerHost until execution and ack finish. */
export async function runDelegatedTurnCycle(input: {
  outboxRepo: IOutboxRepository;
  host: TurnConsumerHost;
  workerId: string;
  concurrency: number;
  signal?: AbortSignal;
}): Promise<number> {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 8) {
    throw new Error("invalid_worker_turn_concurrency");
  }
  if (input.signal?.aborted) return 0;
  const events = await input.outboxRepo.fetchPendingEvents({
    eventType: DELEGATED_TURN_EVENT, limit: input.concurrency, includeRetriable: true, maxRetries: 3,
  });
  const results = await Promise.allSettled(events.map(async event => {
    try {
      if (await consume(input.host, event, input.signal) === "deferred") return 0;
    } catch (error) {
      if (error instanceof InvalidDelegationError) {
        if (!input.outboxRepo.markDeadLetter) throw error;
        await input.outboxRepo.markDeadLetter(event.id, error.message);
        return 1;
      }
      if (input.signal?.aborted) return 0;
      // A failed observation cannot establish whether another owner is live.
      // Only a revalidated, never-claimed admission failure consumes retries.
      if (!(error instanceof AdmissionFailure)) throw error;
      await input.outboxRepo.markFailed(event.id, error.message, { maxRetries: 3 });
      return 1;
    }
    // Ack failures remain delivery failures, never execution retries.
    await input.outboxRepo.markPublished(event.id);
    return 1;
  }));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.reduce((sum, result) => sum + (result.status === "fulfilled" ? result.value : 0), 0);
}
