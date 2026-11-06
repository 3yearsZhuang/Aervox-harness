import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { askUserQuestionItemSchema, askUserQuestionAnswerItemSchema } from "@aervox/contracts";
import { pendingUserQuestions, turnAttempts, turns, turnStreamEvents, deletionRequests } from "@aervox/schema";
import type { AervoxDatabase } from "../../../client.js";
import type { LocalContext } from "../../../local-context.js";
import { FencingMismatchError } from "../../../errors.js";
import { unverifiedDeletionRequest } from "../privacy-repository.js";
import { assertConversationBodyWritable } from "./message-history.js";
import { disclosableTurn } from "./source-visibility.js";
import { insertStreamEventRow, streamEventId } from "./stream-event-store.js";
import type { CancelUserQuestionInput, PendingUserQuestionState, RequireUserQuestionInput,
  RequireUserQuestionResult, UserQuestionIdentity, UserQuestionAnswerReceipt, UserQuestionExecutionProof } from "../../types/user-question.js";
import type { TurnStreamEventModel } from "../../types/conversation.js";
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from "@aervox/contracts";

type Writer = Parameters<Parameters<AervoxDatabase["transaction"]>[0]>[0];
type Reader = Pick<AervoxDatabase, "select">;
const identityWhere = (identity: UserQuestionIdentity) => and(
  eq(turnStreamEvents.turnId, identity.turnId), eq(turnStreamEvents.attemptId, identity.attemptId),
  sql`json_extract(${turnStreamEvents.data}, '$.invocationId') = ${identity.invocationId}`,
  sql`json_extract(${turnStreamEvents.data}, '$.step') = ${identity.step}`,
);
const pendingIdentityWhere = (identity: Omit<CancelUserQuestionInput, "reason" | "proof">) => and(
  eq(pendingUserQuestions.turnId, identity.turnId), eq(pendingUserQuestions.attemptId, identity.attemptId),
  eq(pendingUserQuestions.step, identity.step), identity.invocationId === null
    ? isNull(pendingUserQuestions.invocationId) : eq(pendingUserQuestions.invocationId, identity.invocationId),
);
const toPending = (row: typeof pendingUserQuestions.$inferSelect): PendingUserQuestionState => ({
  turnId: row.turnId, attemptId: row.attemptId, invocationId: row.invocationId, step: row.step,
  questions: row.questionsJson as AskUserQuestionItem[], timeoutMs: row.timeoutMs,
  createdAt: row.createdAt, expiresAt: row.expiresAt,
  identityStatus: row.invocationId === null ? "identity_unavailable" : "available",
});
function requireIdentity(identity: UserQuestionIdentity) {
  if (!identity.turnId || !identity.attemptId || !identity.invocationId || !Number.isSafeInteger(identity.step) || identity.step < 1) {
    throw new Error("QUESTION_IDENTITY_REQUIRED");
  }
}
async function assertOwner(tx: Writer, turnId: string, attemptId: string, proof: UserQuestionExecutionProof, allowCancel = false) {
  const [attempt] = await tx.select().from(turnAttempts).where(and(eq(turnAttempts.id, attemptId), eq(turnAttempts.turnId, turnId))).limit(1);
  if (!attempt || !proof.leaseId || !Number.isSafeInteger(proof.expectedFencingToken)
    || attempt.fencingToken !== proof.expectedFencingToken || attempt.leaseId !== proof.leaseId
    || !attempt.leaseExpiresAt || attempt.leaseExpiresAt <= new Date().toISOString()
    || !(attempt.status === "Running" || (allowCancel && attempt.status === "CancelRequested"))) {
    throw new FencingMismatchError("question_execution_expired");
  }
}
async function findEvent(reader: Reader, identity: UserQuestionIdentity, eventType: string) {
  const [row] = await reader.select().from(turnStreamEvents).where(and(identityWhere(identity), eq(turnStreamEvents.eventType, eventType)))
    .orderBy(desc(turnStreamEvents.sequence)).limit(1);
  return (row as TurnStreamEventModel | undefined) ?? null;
}
const toReceipt = (identity: UserQuestionIdentity, event: TurnStreamEventModel): UserQuestionAnswerReceipt => ({
  turnId: identity.turnId, attemptId: identity.attemptId, invocationId: identity.invocationId, step: identity.step,
  accepted: true, answers: (event.data as { answers: AskUserQuestionAnswerItem[] }).answers, event,
});
async function appendQuestionEvent(tx: Writer, identity: UserQuestionIdentity, eventType: string, data: unknown) {
  const [last] = await tx.select({ sequence: turnStreamEvents.sequence }).from(turnStreamEvents)
    .where(eq(turnStreamEvents.turnId, identity.turnId)).orderBy(desc(turnStreamEvents.sequence)).limit(1);
  const [turn] = await tx.select({ sequence: turns.lastSequence }).from(turns).where(eq(turns.id, identity.turnId)).limit(1);
  const sequence = Math.max(last?.sequence ?? 0, turn?.sequence ?? 0) + 1;
  return insertStreamEventRow(tx, { id: streamEventId(identity.turnId, sequence), turnId: identity.turnId,
    attemptId: identity.attemptId, sequence, eventType, payloadVersion: 1, data, occurredAt: new Date().toISOString() });
}
function normalizeAnswers(questions: AskUserQuestionItem[], answers: AskUserQuestionAnswerItem[]) {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error("QUESTION_ANSWERS_REQUIRED");
  const parsed = answers.map(answer => askUserQuestionAnswerItemSchema.parse(answer));
  if (new Set(parsed.map(answer => answer.id)).size !== parsed.length) throw new Error("QUESTION_ANSWER_INVALID");
  return questions.map(question => {
    const answer = parsed.find(candidate => candidate.id === question.id);
    if (!answer || new Set(answer.selected).size !== answer.selected.length
      || (!question.multiSelect && answer.selected.length > 1)
      || answer.selected.some(label => !question.options?.some(option => option.label === label))
      || (!answer.selected.length && !answer.custom?.trim())) throw new Error("QUESTION_ANSWER_INVALID");
    const selected = (question.options ?? []).filter(option => answer.selected.includes(option.label)).map(option => option.label);
    return { id: answer.id, selected, ...(answer.custom === undefined ? {} : { custom: answer.custom }) };
  });
}

/** Durable questions are commands of the existing Conversation writer. */
export class UserQuestionStore {
  constructor(private readonly db: AervoxDatabase) {}

  async require(_ctx: LocalContext, input: RequireUserQuestionInput): Promise<RequireUserQuestionResult> {
    requireIdentity(input);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647) throw new Error("QUESTION_TIMEOUT_INVALID");
    const questions = input.questions.map(question => askUserQuestionItemSchema.parse(question));
    if (!questions.length || new Set(questions.map(question => question.id)).size !== questions.length) throw new Error("QUESTION_INVALID");
    return this.db.transaction(async tx => {
      await assertOwner(tx, input.turnId, input.attemptId, input);
      await assertConversationBodyWritable(tx, input.turnId);
      const original = await findEvent(tx, input, "user_question_required");
      if (original) {
        const data = original.data as { questions: AskUserQuestionItem[]; timeoutMs: number };
        if (JSON.stringify(data.questions) !== JSON.stringify(questions) || data.timeoutMs !== input.timeoutMs) throw new Error("QUESTION_IDENTITY_CONFLICT");
        const answered = await findEvent(tx, input, "user_question_answered");
        if (answered) return { event: original, pending: null, receipt: toReceipt(input, answered) };
        const [pending] = await tx.select().from(pendingUserQuestions).where(pendingIdentityWhere(input)).limit(1);
        if (!pending || pending.expiresAt <= new Date().toISOString()) throw new Error("QUESTION_CLOSED");
        return { event: original, pending: toPending(pending), receipt: null };
      }
      const [existing] = await tx.select({ turnId: pendingUserQuestions.turnId }).from(pendingUserQuestions).where(eq(pendingUserQuestions.turnId, input.turnId)).limit(1);
      if (existing) throw new Error("QUESTION_PENDING");
      const createdAt = new Date().toISOString(), expiresAt = new Date(Date.parse(createdAt) + input.timeoutMs).toISOString();
      const event = await appendQuestionEvent(tx, input, "user_question_required", {
        turnId: input.turnId, attemptId: input.attemptId, invocationId: input.invocationId, step: input.step,
        questions, timeoutMs: input.timeoutMs, expiresAt, identityStatus: "available",
      });
      const [pending] = await tx.insert(pendingUserQuestions).values({ turnId: input.turnId, attemptId: input.attemptId,
        invocationId: input.invocationId, step: input.step, questionsJson: questions, timeoutMs: input.timeoutMs, createdAt, expiresAt }).returning();
      return { event, pending: toPending(pending!), receipt: null };
    }, { behavior: "immediate" });
  }

  async getPending(_ctx: LocalContext, turnId: string): Promise<PendingUserQuestionState | null> {
    const [row] = await this.db.select().from(pendingUserQuestions).where(and(eq(pendingUserQuestions.turnId, turnId),
      sql`${pendingUserQuestions.expiresAt} > ${new Date().toISOString()}`, disclosableTurn(turnId),
      sql`not exists (select 1 from ${deletionRequests} where ${unverifiedDeletionRequest})`,
    )).limit(1);
    return row ? toPending(row) : null;
  }

  async getReceipt(_ctx: LocalContext, identity: UserQuestionIdentity): Promise<UserQuestionAnswerReceipt | null> {
    requireIdentity(identity);
    const [row] = await this.db.select().from(turnStreamEvents).where(and(identityWhere(identity),
      eq(turnStreamEvents.eventType, "user_question_answered"), disclosableTurn(identity.turnId),
      sql`not exists (select 1 from ${deletionRequests} where ${unverifiedDeletionRequest})`,
    )).orderBy(desc(turnStreamEvents.sequence)).limit(1);
    return row ? toReceipt(identity, row as TurnStreamEventModel) : null;
  }

  async answer(_ctx: LocalContext, identity: UserQuestionIdentity, answers: AskUserQuestionAnswerItem[]): Promise<UserQuestionAnswerReceipt> {
    return this.db.transaction(async tx => {
      await assertConversationBodyWritable(tx, identity.turnId);
      const [current] = await tx.select().from(pendingUserQuestions).where(eq(pendingUserQuestions.turnId, identity.turnId)).limit(1);
      if (current?.invocationId === null) throw new Error("QUESTION_IDENTITY_UNAVAILABLE");
      requireIdentity(identity);
      const original = await findEvent(tx, identity, "user_question_required");
      if (!original) throw new Error("QUESTION_NOT_PENDING");
      const questions = (original.data as { questions: AskUserQuestionItem[] }).questions;
      const normalized = normalizeAnswers(questions, answers);
      const answered = await findEvent(tx, identity, "user_question_answered");
      if (answered) {
        if (JSON.stringify((answered.data as { answers: unknown }).answers) !== JSON.stringify(normalized)) throw new Error("QUESTION_ANSWER_CONFLICT");
        return toReceipt(identity, answered);
      }
      if (!current || current.attemptId !== identity.attemptId || current.invocationId !== identity.invocationId || current.step !== identity.step) throw new Error("QUESTION_NOT_PENDING");
      if (current.expiresAt <= new Date().toISOString()) throw new Error("QUESTION_EXPIRED");
      const event = await appendQuestionEvent(tx, identity, "user_question_answered", {
        turnId: identity.turnId, attemptId: identity.attemptId, invocationId: identity.invocationId, step: identity.step, answers: normalized,
      });
      await tx.delete(pendingUserQuestions).where(pendingIdentityWhere(identity));
      return toReceipt(identity, event);
    }, { behavior: "immediate" });
  }

  async cancel(_ctx: LocalContext, input: CancelUserQuestionInput): Promise<boolean> {
    return this.db.transaction(async tx => {
      if (input.proof) await assertOwner(tx, input.turnId, input.attemptId, input.proof, true);
      const [pending] = await tx.select().from(pendingUserQuestions).where(pendingIdentityWhere(input)).limit(1);
      if (!pending) return false;
      if (input.reason === "expired" && pending.expiresAt > new Date().toISOString()) return false;
      const deleted = await tx.delete(pendingUserQuestions).where(pendingIdentityWhere(input)).returning({ turnId: pendingUserQuestions.turnId });
      return deleted.length === 1;
    }, { behavior: "immediate" });
  }
}
