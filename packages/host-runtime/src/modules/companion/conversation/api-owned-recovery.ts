import type { SqliteConversationRepository } from "@aervox/repositories";
import type { ConversationTurnInput } from "./execution.js";
import type { LocalContext } from "@aervox/repositories";
import type { Observability } from "@aervox/observability";
import { turnStreamHub } from "./stream-hub.js";

const terminal = new Set(["Completed", "Failed", "Interrupted", "Cancelled"]);

/** Reconcile durable execution state without replaying a previously claimed attempt. */
export async function recoverApiOwnedTurn(repo: SqliteConversationRepository, turnId: string): Promise<"unclaimed" | "active" | "settled"> {
  const ctx = { workspaceId: "local", subjectUserId: "local" };
  const attempt = (await repo.listTurnAttempts(ctx, turnId))[0];
  if (!attempt) return "active";
  let settled = false;
  if (terminal.has(attempt.status)) {
    await repo.synchronizeTurnWithLatestAttempt(turnId);
    settled = true;
  } else {
    if (attempt.leaseExpiresAt && attempt.leaseExpiresAt >= new Date().toISOString()) return "active";
    if (!attempt.leaseId && attempt.fencingToken === 0 && attempt.status === "Running") return "unclaimed";
    settled = await repo.retireExpiredApiOwnedAttempt(turnId, attempt.id, attempt.fencingToken);
  }
  if (!settled) return "active";
  const turn = await repo.getTurn(ctx, turnId);
  if (!turn || !terminal.has(turn.status)) return "active";
  const events = await repo.getStreamEvents(ctx, turnId, Math.max(0, (turn?.lastSequence ?? 1) - 1));
  for (const event of events) turnStreamHub.publishEvent(turnId, event);
  turnStreamHub.publishSettled(turnId, turn.status);
  return "settled";
}

/** Workbench turns on Bot sessions use the full API executor after a restart as well. */
export class ApiOwnedTurnRecovery {
  private readonly before: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private closed = false;
  private readonly active = new Map<string, string>();

  constructor(private readonly repo: SqliteConversationRepository,
    private readonly execute: (ctx: LocalContext, input: ConversationTurnInput) => Promise<void>,
    private readonly options: { before?: string; observability?: Observability } = {},
  ) { this.before = options.before ?? new Date().toISOString(); }


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
        this.options.observability?.log.error({ event: "turn.api_recovery_failed", message: "API Turn recovery failed", fields: { turnId: turn.id } });
      }));
    }
    await Promise.all(work);
  }

  private async recover(turnId: string) {
    const ctx = { workspaceId: "local", subjectUserId: "local" };
    const turn = await this.repo.getTurn(ctx, turnId);
    if (!turn || this.closed) return;
    if (await recoverApiOwnedTurn(this.repo, turnId) !== "unclaimed") return;
    const attempt = (await this.repo.listTurnAttempts(ctx, turnId))[0];
    if (!attempt) return;
    if (attempt.status !== "Running" || this.closed) return;
    this.active.set(turnId, attempt.id);
    try {
      await this.execute(ctx, {
        turnId, sessionId: turn.sessionId, attemptId: attempt.id, userMessage: "",
      });
    } finally { this.active.delete(turnId); }
  }
}
