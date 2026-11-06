import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { learningGoals, memoryRecords, messages, messageVersions, questionAttempts, sessions, turns } from "@aervox/schema";
import type { DiaryMaterial, DiaryMaterialPort, LocalContext } from "@aervox/contracts";
import type { AervoxDatabase } from "../../client.js";
import { derivableConversationTurn } from "./conversation/source-visibility.js";
import { admitsSourceTurn, unverifiedAttachmentTurn } from "../../attachment-source-admission.js";
import type { ConversationCryptoPort } from "../../conversation-host-port.js";
import { jsonQuote } from "../../sql-dialect.js";

export function createSqliteDiaryMaterialPort(db: AervoxDatabase, crypto: Pick<ConversationCryptoPort, "sha256Utf8">): DiaryMaterialPort {
  return { collect: (context, window) => collectDiaryMaterial(db, context, window, crypto) };
}

/** 收集 [windowStartIso, windowEndIso] 窗口内的日记素材（本地实例内跨会话） */
export async function collectDiaryMaterial(
  db: AervoxDatabase,
  ctx: LocalContext,
  window: { startIso: string; endIso: string },
  crypto: Pick<ConversationCryptoPort, "sha256Utf8">,
): Promise<DiaryMaterial> {
  return db.transaction(tx => collectSnapshot(tx, ctx, window, crypto));
}

async function collectSnapshot(
  db: Pick<AervoxDatabase, "select">,
  ctx: LocalContext,
  window: { startIso: string; endIso: string },
  crypto: Pick<ConversationCryptoPort, "sha256Utf8">,
): Promise<DiaryMaterial> {
  // 1. 当日聊天消息：message_versions 当前版本（supersededAt 为空）且未脱敏
  const messageRows = await db
    .select({
      role: messageVersions.role,
      content: jsonQuote(db, messageVersions.content).mapWith(value => JSON.parse(value) as string),
      createdAt: messageVersions.createdAt,
      sourceTurnId: jsonQuote(db, messageVersions.turnId).mapWith(value => JSON.parse(value) as string),
    })
    .from(messageVersions)
    .innerJoin(turns, eq(turns.id, messageVersions.turnId))
    .innerJoin(sessions, eq(sessions.id, turns.sessionId))
    .where(
      and(
        inArray(turns.executionPolicy, ["local-v1", "bot-owner-v1"]),
        eq(turns.executionPolicy, sessions.executionPolicy),
        inArray(messageVersions.role, ["user", "assistant"]),
        derivableConversationTurn(db, turns.id),
        sql`${messageVersions.content} <> ''`,
        sql`(${messageVersions.messageId} IS NULL OR EXISTS (
          SELECT 1 FROM ${messages} WHERE ${messages.id} = ${messageVersions.messageId}
            AND ${messages.sessionId} = ${turns.sessionId} AND ${messages.role} = ${messageVersions.role}
            AND ${messages.deletedAt} IS NULL AND ${messages.currentVersionId} = ${messageVersions.id}
        ))`,
        isNull(messageVersions.supersededAt),
        eq(messageVersions.isRedacted, 0),
        gte(messageVersions.createdAt, window.startIso),
        lte(messageVersions.createdAt, window.endIso),
      ),
    )
    .orderBy(messageVersions.createdAt)
    .limit(200);

  // 2. 当日记忆：memory_records 中 created_at 落在窗口且未删除（含 short_term/long_term 等层）
  const memoryRows = await db
    .select({
      layer: memoryRecords.layer,
      category: memoryRecords.category,
      content: memoryRecords.content,
      createdAt: memoryRecords.createdAt,
      sourceTurnId: jsonQuote(db, memoryRecords.sourceTurnId).mapWith(value => JSON.parse(value) as string | null),
    })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.isDeleted, 0),
        sql`${unverifiedAttachmentTurn(db, memoryRecords.sourceTurnId)} = 0`,
        sql`(${memoryRecords.sourceTurnId} IS NULL OR EXISTS (
          SELECT 1 FROM turns source_turn JOIN sessions source_session ON source_session.id = source_turn.session_id
          WHERE source_turn.id = ${memoryRecords.sourceTurnId}
            AND source_turn.execution_policy IN ('local-v1', 'bot-owner-v1')
            AND source_session.execution_policy = source_turn.execution_policy
        ))`,
        gte(memoryRecords.createdAt, window.startIso),
        lte(memoryRecords.createdAt, window.endIso),
      ),
    )
    .orderBy(memoryRecords.createdAt)
    .limit(50);

  // 3. 学习目标（排除已归档）
  const goalRows = await db
    .select({
      topic: learningGoals.topic,
      level: learningGoals.level,
      status: learningGoals.status,
    })
    .from(learningGoals)
    .where(
      and(
        inArray(learningGoals.status, ["active", "paused", "completed"]),
      ),
    )
    .limit(20);

  // 4. 当日练习判定（正确率素材）
  const attemptRows = await db
    .select({ judgement: questionAttempts.judgement })
    .from(questionAttempts)
    .where(
      and(
        gte(questionAttempts.createdAt, window.startIso),
        lte(questionAttempts.createdAt, window.endIso),
      ),
    )
    .limit(500);

  const admittedMessages: typeof messageRows = [];
  for (const row of messageRows) if (await admitsSourceTurn(db, row.sourceTurnId, crypto)) admittedMessages.push(row);
  const admittedMemories: typeof memoryRows = [];
  for (const row of memoryRows) if (await admitsSourceTurn(db, row.sourceTurnId, crypto)) admittedMemories.push(row);
  return {
    messages: admittedMessages.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
      occurredAt: row.createdAt,
    })),
    memories: admittedMemories.map((row) => ({
      layer: row.layer,
      category: row.category,
      content: row.content,
      createdAt: row.createdAt,
    })),
    goals: goalRows,
    attemptsToday: {
      total: attemptRows.length,
      correct: attemptRows.filter((row) => row.judgement === "correct").length,
    },
  };
}
