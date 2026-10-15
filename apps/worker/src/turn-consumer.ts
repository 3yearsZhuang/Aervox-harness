import type { OutboxEventHandler } from "./outbox-worker.js";
import type { ConversationHost } from "@aervox/host-runtime";

/** Only explicitly delegated events enter the complete shared product host. */
export function createTurnConsumerHandler(host: Pick<ConversationHost, "repo" | "execute">): OutboxEventHandler {
  return async event => {
    if (event.eventType !== "agent.turn.requested") return;
    const raw: unknown = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    if (!raw || typeof raw !== "object") throw new Error("Invalid delegated turn payload");
    const payload = raw as { execution?: unknown; turnId?: unknown; metadata?: unknown; toolApprovalMode?: unknown; actorId?: unknown };
    if (payload.execution !== "worker" || typeof payload.turnId !== "string") throw new Error("Invalid delegated turn owner");
    const local = { workspaceId: "local", subjectUserId: "local" };
    const turn = await host.repo.getTurn(local, payload.turnId);
    if (!turn || !["Created", "Running"].includes(turn.status)) return;
    const attempts = await host.repo.listTurnAttempts(local, turn.id);
    const attempt = attempts.find(a => a.status === "Running" && a.fencingToken === 0 && !a.leaseId);
    if (!attempt) return;
    // Read the authoritative accepted input instead of replaying an event copy.
    const userMessage = await host.repo.getTurnUserMessage(local, turn.id);
    if (userMessage === null) throw new Error("Delegated turn has no persisted input");
    await host.execute({
      turnId: turn.id, sessionId: turn.sessionId, attemptId: attempt.id, userMessage,
      toolApprovalMode: payload.toolApprovalMode === "full_access" ? "full_access" : "ask",
      actorId: typeof payload.actorId === "string" ? payload.actorId : undefined,
      metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown> : undefined,
    });
  };
}
