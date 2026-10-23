/**
 * Aervox｜思隅 @aervox/repositories — Turn 生命周期与 Outbox 伴随写入 Store
 */
import { eq, and, or, isNull, gt, inArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { sessions, turns, messageVersions, outboxEvents, turnAttempts, agentInboxItems, type ConversationExecutionPolicy } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { TurnModel, MessageVersionModel, TurnAcceptanceInput, TurnAcceptanceResult, TurnAttemptModel } from "../../types/index.js";
import { withSessionLock } from "../../../session-lock.js";
import { notifyWorkerWakeup } from "@aervox/process-coordination";
import { normalizeTurnIntent, turnIntentHash, renderTurnIntentMessage, TurnIntentConflictError, type AcceptedTurnParameters, type NormalizedTurnIntent } from "../../../conversation-turn-intent.js";
import { assertConversationExecutionPolicy, conversationDispatchTarget } from "../../../conversation-execution-policy.js";

export class TurnStore {
  constructor(private readonly db: AervoxDatabase) {}

  async createTurnWithOutbox(
    ctx: LocalContext,
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string; requestHash?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const result = await this.db.transaction((tx) => this.insertTurn(tx, turnData, userMessage, outboxEventData));
    if (outboxEventData) void notifyWorkerWakeup("outbox");
    return result;
  }

  /** Acceptance is one writer commit: input consumption, Turn, Outbox and initial Attempt. */
  async acceptTurn(ctx: LocalContext, input: TurnAcceptanceInput): Promise<TurnAcceptanceResult> {
    const result = await withSessionLock(`turn-idempotency:${input.idempotencyKey}`, () => withSessionLock(`turn-accept:${input.sessionId}`, () => this.db.transaction(async (tx): Promise<TurnAcceptanceResult> => {
      const [existing] = await tx.select().from(turns).where(eq(turns.idempotencyKey, input.idempotencyKey));
      const policy = await this.readSessionPolicy(tx, input.sessionId, input.executionPolicy);
      const intent = normalizeTurnIntent(input, policy, ctx.actorId);
      const requestHash = turnIntentHash(intent);
      if (existing) {
        if (existing.sessionId !== input.sessionId) throw new TurnIntentConflictError("session_mismatch");
        this.assertTurnPolicy(existing, input.sessionId, policy);
        if (!existing.requestHash || !/^turn-intent-v1:[a-f0-9]{64}$/.test(existing.requestHash)) throw new TurnIntentConflictError("intent_unavailable");
        if (existing.requestHash !== requestHash) throw new TurnIntentConflictError("intent_mismatch");
        return { created: false, turn: existing as TurnModel };
      }
      const now = new Date().toISOString();
      const inbox = input.consumeInbox && policy === "local-v1" ? await tx.select().from(agentInboxItems).where(and(
        eq(agentInboxItems.sessionId, input.sessionId), eq(agentInboxItems.consumeBoundary, "next-turn"),
        eq(agentInboxItems.status, "pending"),
        or(isNull(agentInboxItems.expiresAt), gt(agentInboxItems.expiresAt, now)),
      )).orderBy(agentInboxItems.createdAt, agentInboxItems.id).limit(20) : [];
      const content = [...inbox.map((item) => typeof item.payloadJson === "string"
        ? item.payloadJson : JSON.stringify(item.payloadJson)), renderTurnIntentMessage(intent)].join("\n\n");
      const accepted = await this.insertTurn(tx, {
        id: input.turnId, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey, requestHash,
      }, { ...input.message, content }, {
        id: `outbox_${input.turnId}`, eventType: policy === "local-v1" && input.execution === "worker" ? "agent.turn.requested" : "turn.created", idempotencyKey: `idem_outbox_${input.turnId}`,
        payload: { turnId: input.turnId, sessionId: input.sessionId, execution: policy === "local-v1" ? input.execution ?? "api" : "api", metadata: intent.metadata, toolApprovalMode: intent.toolApprovalMode, actorId: intent.actorId ?? undefined, userMessage: content, intent, requestHash },
      });
      const [attempt] = await tx.insert(turnAttempts).values({
        id: input.attemptId, turnId: input.turnId, attempt: 1, fencingToken: 0, status: "Running", startedAt: now,
      }).returning();
      if (inbox.length) {
        const consumed = await tx.update(agentInboxItems).set({
          status: "acknowledged", claimedAt: now, ackedAt: now, updatedAt: now, attemptId: input.attemptId,
        }).where(and(inArray(agentInboxItems.id, inbox.map((item) => item.id)), eq(agentInboxItems.status, "pending"))).returning();
        if (consumed.length !== inbox.length) throw new Error("inbox_acceptance_conflict");
      }
      return { created: true, ...accepted, attempt: attempt as TurnAttemptModel, intent };
    })));
    if (result.created) void notifyWorkerWakeup("outbox");
    return result;
  }

  /**
   * 编程式接单（子任务/宿主内部）：Turn、消息与首个 Attempt 单写者事务。
   * 对齐 acceptTurn 的原子接单不变量，但不消费 Inbox、不写 Outbox；
   * 同幂等键命中既有 Turn 时返回 created:false（崩溃重试复用，不重复创建）。
   */
  async createTurnWithAttempt(
    ctx: LocalContext,
    input: {
      turnId: string;
      sessionId: string;
      idempotencyKey: string;
      message: { id: string; content: string };
      attemptId: string;
    },
  ): Promise<TurnAcceptanceResult> {
    return withSessionLock(`turn-accept:${input.sessionId}`, () => this.db.transaction(tx => this.createTurnWithAttemptInTransaction(tx, ctx, input)));
  }

  /** Internal composition seam: child linkage can share the same writer commit. */
  async createTurnWithAttemptInTransaction(
    tx: Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0],
    ctx: LocalContext,
    input: { turnId: string; sessionId: string; idempotencyKey: string; message: { id: string; content: string }; attemptId: string },
    metadata?: Record<string, unknown>,
  ): Promise<TurnAcceptanceResult> {
      const policy = await this.readSessionPolicy(tx, input.sessionId);
      const requestHash = turnIntentHash(normalizeTurnIntent({ ...input, metadata }, policy, ctx.actorId));
      const [existing] = await tx.select().from(turns).where(eq(turns.idempotencyKey, input.idempotencyKey));
      if (existing) {
        this.assertTurnPolicy(existing, input.sessionId, policy);
        if (!existing.requestHash) throw new TurnIntentConflictError("intent_unavailable");
        if (existing.requestHash !== requestHash) throw new TurnIntentConflictError("intent_mismatch");
        return { created: false, turn: existing as TurnModel };
      }
      const now = new Date().toISOString();
      const created = await this.insertTurn(tx, {
        id: input.turnId, sessionId: input.sessionId, idempotencyKey: input.idempotencyKey, requestHash,
      }, input.message);
      const [attempt] = await tx.insert(turnAttempts).values({
        id: input.attemptId, turnId: input.turnId, attempt: 1, fencingToken: 0, status: "Running", startedAt: now,
      }).returning();
      return { created: true, ...created, attempt: attempt as TurnAttemptModel };
  }

  private async insertTurn(
    tx: Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0],
    turnData: { id: string; sessionId: string; idempotencyKey: string; status?: string; requestHash?: string },
    userMessage: { id: string; content: string },
    outboxEventData?: { id: string; eventType: string; idempotencyKey: string; payload: unknown },
  ): Promise<{ turn: TurnModel; message: MessageVersionModel }> {
    const now = new Date().toISOString();
    const executionPolicy = await this.readSessionPolicy(tx, turnData.sessionId);
    const [turn] = await tx.insert(turns).values({
      ...turnData, status: turnData.status ?? "Created", lastSequence: 0, acceptedAt: now, createdAt: now, updatedAt: now,
      executionPolicy, dispatchTarget: conversationDispatchTarget(executionPolicy),
    }).returning();
    const [message] = await tx.insert(messageVersions).values({
      id: userMessage.id, turnId: turnData.id, role: "user", version: 1,
      content: userMessage.content, isRedacted: 0, createdAt: now,
    }).returning();
    if (outboxEventData) await tx.insert(outboxEvents).values({ ...outboxEventData, status: "pending", createdAt: now });
    return { turn: turn as TurnModel, message: message as MessageVersionModel };
  }

  async getTurn(ctx: LocalContext, turnId: string): Promise<TurnModel | null> {
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.id, turnId),
        ),
      );
    if (found) this.assertTurnPolicy(found, found.sessionId, await this.readSessionPolicy(this.db, found.sessionId));
    return (found as TurnModel) ?? null;
  }

  async getTurnUserMessage(ctx: LocalContext, turnId: string): Promise<string | null> {
    const [found] = await this.db
      .select({ content: messageVersions.content })
      .from(messageVersions)
      .where(and(eq(messageVersions.turnId, turnId), eq(messageVersions.role, "user")))
      .orderBy(messageVersions.version)
      .limit(1);
    return found?.content ?? null;
  }

  /** Resume from the accepted receipt only; caller parameters and missing legacy receipts are never substituted. */
  async getAcceptedTurnParameters(ctx: LocalContext, turnId: string): Promise<AcceptedTurnParameters> {
    const turn = await this.getTurn(ctx, turnId);
    if (!turn?.requestHash || !/^turn-intent-v1:[a-f0-9]{64}$/.test(turn.requestHash)) throw new TurnIntentConflictError("intent_unavailable");
    const [receipt] = await this.db.select({ payload: outboxEvents.payload }).from(outboxEvents).where(eq(outboxEvents.id, `outbox_${turnId}`));
    let intent: NormalizedTurnIntent;
    try {
      const payload = receipt?.payload as { intent?: NormalizedTurnIntent; requestHash?: string } | undefined;
      if (!payload?.intent || payload.requestHash !== turn.requestHash || payload.intent.version !== 1
        || payload.intent.sessionId !== turn.sessionId || payload.intent.executionPolicy !== turn.executionPolicy
        || turnIntentHash(payload.intent) !== turn.requestHash) throw new Error("invalid_acceptance_receipt");
      intent = payload.intent;
    } catch { throw new TurnIntentConflictError("intent_unavailable"); }
    const userMessage = await this.getTurnUserMessage(ctx, turnId);
    if (userMessage === null) throw new TurnIntentConflictError("intent_unavailable");
    return { userMessage, metadata: intent.metadata, toolApprovalMode: intent.toolApprovalMode, actorId: intent.actorId ?? undefined };
  }

  async getTurnByIdempotencyKey(
    ctx: LocalContext,
    idempotencyKey: string,
  ): Promise<TurnModel | null> {
    const [found] = await this.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.idempotencyKey, idempotencyKey),
        ),
      );
    if (found) this.assertTurnPolicy(found, found.sessionId, await this.readSessionPolicy(this.db, found.sessionId));
    return (found as TurnModel) ?? null;
  }

  private async readSessionPolicy(
    db: Pick<AervoxDatabase, "select">,
    sessionId: string,
    expected?: ConversationExecutionPolicy,
  ): Promise<ConversationExecutionPolicy> {
    if (expected !== undefined) assertConversationExecutionPolicy(expected);
    const [session] = await db.select({ policy: sessions.executionPolicy }).from(sessions).where(eq(sessions.id, sessionId));
    if (!session) throw new Error("conversation_session_unavailable");
    assertConversationExecutionPolicy(session.policy);
    if (expected !== undefined && expected !== session.policy) throw new Error("conversation_execution_policy_mismatch");
    return session.policy;
  }

  private assertTurnPolicy(turn: TurnModel, sessionId: string, policy: ConversationExecutionPolicy): void {
    assertConversationExecutionPolicy(turn.executionPolicy);
    if (turn.sessionId !== sessionId || turn.executionPolicy !== policy || turn.dispatchTarget !== conversationDispatchTarget(policy)) {
      throw new Error("conversation_execution_policy_mismatch");
    }
  }

  async updateTurnStatus(
    ctx: LocalContext,
    turnId: string,
    status: string,
    lastSequence?: number,
    error?: unknown,
  ): Promise<TurnModel | null> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {
      status,
      updatedAt: now,
    };
    if (lastSequence !== undefined) {
      updateData.lastSequence = lastSequence;
    }
    if (error !== undefined) {
      updateData.error = error;
    }

    const [updated] = await this.db
      .update(turns)
      .set(updateData)
      .where(
        and(
          eq(turns.id, turnId),
        ),
      )
      .returning();
    return (updated as TurnModel) ?? null;
  }
}
