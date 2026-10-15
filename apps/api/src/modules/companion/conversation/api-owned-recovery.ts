import type { SqliteConversationRepository } from "@aervox/repositories";
import { executeAcceptedConversationTurn } from "./application.js";
import type { ConversationRouteDeps } from "./routes.js";
import { turnStreamHub } from "./stream-hub.js";

const terminal = new Set(["Completed", "Failed", "Interrupted", "Cancelled"]);

/** Workbench turns on Bot sessions use the full API executor after a restart as well. */
export class ApiOwnedTurnRecovery {
  private readonly before: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private closed = false;
  private readonly active = new Map<string, string>();

  constructor(private readonly repo: SqliteConversationRepository, private readonly deps: ConversationRouteDeps,
    before = new Date().toISOString()) { this.before = before; }

  start() {
    if (this.closed || this.timer) return;
    void this.reconcile().catch(() => undefined);
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, 1000);
    this.timer.unref();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const [turnId, attemptId] of this.active) await this.repo.requestCancelTurnAttempt(
      { workspaceId: "local", subjectUserId: "local" }, { turnId, attemptId });
    await this.ticking;
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.ticking ??= this.tick().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async tick() {
    // Only turns predating this API process are recovery candidates. New requests
    // retain their existing request-scoped execution and approval context.
    const candidates = await this.repo.listApiOwnedRecoveryTurns(this.before);
    const sessions = new Set<string>();
    const work: Promise<void>[] = [];
    for (const turn of candidates) {
      if (this.closed || work.length >= 4) break;
      if (sessions.has(turn.sessionId)) continue;
      sessions.add(turn.sessionId);
      work.push(this.recover(turn.id).catch(() => {
        this.deps.observability?.log.error({ event: "turn.api_recovery_failed", message: "API Turn recovery failed", fields: { turnId: turn.id } });
      }));
    }
    await Promise.all(work);
  }

  private async recover(turnId: string) {
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    const turn = await this.repo.getTurn(ctx, turnId);
    if (!turn || this.closed) return;
    const attempt = (await this.repo.listTurnAttempts(ctx, turnId))[0];
    if (!attempt) return; // Acceptance commits the initial attempt atomically.
    if (terminal.has(attempt.status)) {
      await this.repo.synchronizeTurnWithLatestAttempt(turnId);
      return;
    }
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt >= new Date().toISOString()) return;
    if (attempt.leaseId || attempt.fencingToken > 0 || attempt.status === "CancelRequested") {
      if (await this.repo.retireExpiredApiOwnedAttempt(turnId, attempt.id, attempt.fencingToken)) {
        const latest = await this.repo.getTurn(ctx, turnId);
        const events = await this.repo.getStreamEvents(ctx, turnId, Math.max(0, (latest?.lastSequence ?? 1) - 1));
        for (const event of events) turnStreamHub.publishEvent(turnId, event);
        if (latest) turnStreamHub.publishSettled(turnId, latest.status);
      }
      return;
    }
    if (attempt.status !== "Running" || this.closed) return;
    this.active.set(turnId, attempt.id);
    try {
      await executeAcceptedConversationTurn(this.repo, ctx, {
        turnId, sessionId: turn.sessionId, attemptId: attempt.id, userMessage: "",
      }, this.deps);
    } finally { this.active.delete(turnId); }
  }
}
