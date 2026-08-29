/**
 * Aervox｜思隅 @aervox/api — 日记素材收集（CAP-009 对话触发路径）
 *
 * 素材 = 当日用户行为：聊天消息（当前版本、未脱敏）+ 学习目标 + 当日练习记录。
 * 规则依据：PRD §6.7「日记仅使用…用户历史中仍获授权的学习记录」与反虚构约束——
 * 收集器只提供真实发生的事实，生成端不得引用素材之外的内容。
 */
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  learningGoals,
  messageVersions,
  questionAttempts,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";

export interface DiaryMaterialMessage {
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}

export interface DiaryMaterial {
  /** 当日窗口内的聊天消息（时间升序，截断上限 200 条） */
  messages: DiaryMaterialMessage[];
  /** 进行中的学习目标（topic/level/status） */
  goals: Array<{ topic: string; level: string; status: string }>;
  /** 当日练习统计 */
  attemptsToday: { total: number; correct: number };
}

/** 收集 [windowStartIso, windowEndIso] 窗口内的日记素材（跨会话，按租户） */
export async function collectDiaryMaterial(
  db: AervoxDatabase,
  tenant: TenantContext,
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
        eq(messageVersions.workspaceId, tenant.workspaceId),
        eq(messageVersions.subjectUserId, tenant.subjectUserId),
        inArray(messageVersions.role, ["user", "assistant"]),
        isNull(messageVersions.supersededAt),
        eq(messageVersions.isRedacted, 0),
        gte(messageVersions.createdAt, window.startIso),
        lte(messageVersions.createdAt, window.endIso),
      ),
    )
    .orderBy(messageVersions.createdAt)
    .limit(200);

  // 2. 学习目标（排除已归档）
  const goalRows = await db
    .select({
      topic: learningGoals.topic,
      level: learningGoals.level,
      status: learningGoals.status,
    })
    .from(learningGoals)
    .where(
      and(
        eq(learningGoals.workspaceId, tenant.workspaceId),
        eq(learningGoals.subjectUserId, tenant.subjectUserId),
        inArray(learningGoals.status, ["active", "paused", "completed"]),
      ),
    )
    .limit(20);

  // 3. 当日练习判定（正确率素材）
  const attemptRows = await db
    .select({ judgement: questionAttempts.judgement })
    .from(questionAttempts)
    .where(
      and(
        eq(questionAttempts.workspaceId, tenant.workspaceId),
        eq(questionAttempts.subjectUserId, tenant.subjectUserId),
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
    goals: goalRows,
    attemptsToday: {
      total: attemptRows.length,
      correct: attemptRows.filter((row) => row.judgement === "correct").length,
    },
  };
}

/** 当日素材总数（打点/输出用） */
export function diaryMaterialCount(material: DiaryMaterial): number {
  return (
    material.messages.length + material.goals.length + (material.attemptsToday.total > 0 ? 1 : 0)
  );
}
