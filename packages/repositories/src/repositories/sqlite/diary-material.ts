import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { learningGoals, memoryRecords, messageVersions, questionAttempts } from "@aervox/schema";
import type { DiaryMaterial, DiaryMaterialPort, LocalContext } from "@aervox/contracts";
import type { AervoxDatabase } from "../../client.js";

export function createSqliteDiaryMaterialPort(db: AervoxDatabase): DiaryMaterialPort {
  return { collect: (context, window) => collectDiaryMaterial(db, context, window) };
}

/** 收集 [windowStartIso, windowEndIso] 窗口内的日记素材（跨会话，按租户） */
export async function collectDiaryMaterial(
  db: AervoxDatabase,
  ctx: LocalContext,
  window: { startIso: string; endIso: string },
): Promise<DiaryMaterial> {
  // 1. 当日聊天消息：message_versions 当前版本（supersededAt 为空）且未脱敏
  const messageRows = await db
    .select({
      role: messageVersions.role,
      content: messageVersions.content,
      createdAt: messageVersions.createdAt,
    })
    .from(messageVersions)
    .where(
      and(
        inArray(messageVersions.role, ["user", "assistant"]),
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
    })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.isDeleted, 0),
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

  return {
    messages: messageRows.map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
      occurredAt: row.createdAt,
    })),
    memories: memoryRows.map((row) => ({
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

