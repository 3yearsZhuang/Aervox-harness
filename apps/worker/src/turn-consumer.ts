import type { OutboxEventHandler } from "./outbox-worker.js";
import type { ConversationHost } from "@aervox/host-runtime";

/** Only explicitly delegated events enter the complete shared product host. */
export function createTurnConsumerHandler(host: { queries: Pick<ConversationHost["queries"], "loadDelegatedTurn">; commands: Pick<ConversationHost["commands"], "execute"> }): OutboxEventHandler {
  return async event => {
    if (event.eventType !== "agent.turn.requested") return;
    const raw: unknown = typeof event.payload === "string" ? JSON.parse(event.payload) : event.payload;
    if (!raw || typeof raw !== "object") throw new Error("Invalid delegated turn payload");
    const payload = raw as { execution?: unknown; turnId?: unknown; metadata?: unknown; toolApprovalMode?: unknown; actorId?: unknown };
    if (payload.execution !== "worker" || typeof payload.turnId !== "string") throw new Error("Invalid delegated turn owner");
    const local = { workspaceId: "local", subjectUserId: "local" };
    const accepted = await host.queries.loadDelegatedTurn(payload.turnId);
    if (!accepted) return;
    await host.commands.execute(local, {
      ...accepted,
      toolApprovalMode: payload.toolApprovalMode === "full_access" ? "full_access" : "ask",
      actorId: typeof payload.actorId === "string" ? payload.actorId : undefined,
      metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown> : undefined,
    });
  };
}
