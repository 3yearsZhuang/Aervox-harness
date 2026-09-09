import { and, desc, eq, inArray, isNull, lt, notLike, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { messages, messageVersions, turns, turnStreamEvents } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { SessionHistoryMessage } from "../types.js";

const MAX_HISTORY_TURNS = 20;
const MAX_HISTORY_CHARACTERS = 32_000;

function payload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 当前 Turn 之前的已完成对话。SQLite rowid 提供插入顺序，避免同毫秒时间戳
 * 与非单调字符串 ID 导致当前轮、未来轮混入；不把子任务当作用户对话。
 * 仅取已批准的助手正文，工具输出和 reasoning 永不进入跨轮历史。
 */
export async function readSessionHistory(
  db: AervoxDatabase,
  inputOrTenant: TenantContext | { sessionId: string; beforeTurnId: string },
  maybeInput?: { sessionId: string; beforeTurnId: string },
): Promise<SessionHistoryMessage[]> {
  const input = "sessionId" in inputOrTenant ? inputOrTenant : maybeInput!;
  const [current] = await db.select({
    position: sql<number>`rowid`,
    idempotencyKey: turns.idempotencyKey,
  }).from(turns).where(and(
    eq(turns.id, input.beforeTurnId),
    eq(turns.sessionId, input.sessionId),
  ));
  if (!current || current.idempotencyKey.startsWith("subagent:")) return [];

  const previous = await db.select({ id: turns.id }).from(turns).where(and(
    eq(turns.sessionId, input.sessionId),
    eq(turns.status, "Completed"),
    notLike(turns.idempotencyKey, "subagent:%"),
    lt(sql`rowid`, current.position),
  )).orderBy(desc(sql`rowid`)).limit(MAX_HISTORY_TURNS);
  if (previous.length === 0) return [];
  const turnIds = previous.map((turn) => turn.id);

  // 最新版本必须先选出再判断脱敏，不能退回旧版本泄漏已删除内容。
  const versions = await db.select().from(messageVersions).where(and(
    inArray(messageVersions.turnId, turnIds),
    eq(messageVersions.role, "user"),
    isNull(messageVersions.supersededAt),
  )).orderBy(desc(messageVersions.version));
  const events = await db.select().from(turnStreamEvents).where(and(
    inArray(turnStreamEvents.turnId, turnIds),
    inArray(turnStreamEvents.eventType, ["message", "delta", "done", "redacted"]),
  )).orderBy(turnStreamEvents.sequence);
  const identityIds = new Set<string>();
  for (const version of versions) identityIds.add(version.messageId ?? version.id);
  for (const event of events) {
    const messageId = payload(event.data).messageId;
    if (typeof messageId === "string") identityIds.add(messageId);
  }
  const identities = identityIds.size > 0
    ? await db.select().from(messages).where(and(
        eq(messages.sessionId, input.sessionId),
        inArray(messages.id, [...identityIds]),
      ))
    : [];
  const identityById = new Map(identities.map((message) => [message.id, message]));
  const result: SessionHistoryMessage[][] = [];
  let remaining = MAX_HISTORY_CHARACTERS;
  for (const turn of previous) {
    const user = versions.find((version) => version.turnId === turn.id);
    if (!user || user.isRedacted !== 0 || !user.content.trim()) continue;
    const userIdentity = identityById.get(user.messageId ?? user.id);
    if (userIdentity?.deletedAt || (user.messageId && !userIdentity)) continue;
    if (userIdentity?.currentVersionId && userIdentity.currentVersionId !== user.id) continue;
    const turnEvents = events.filter((event) => event.turnId === turn.id);
    // 撤回/脱敏整个历史轮，避免助手复述让已删除信息重新进入上下文。
    if (turnEvents.some((event) => event.eventType === "redacted"
      || event.safetyDecision === "blocked" || event.safetyDecision === "redacted")) continue;
    const done = turnEvents.findLast((event) => event.eventType === "done");
    if (!done || done.safetyDecision !== "approved"
      || payload(done.data).status !== "Completed" || payload(done.data).isComplete !== true) continue;
    const messageId = payload(done.data).messageId;
    if (typeof messageId !== "string" || identityById.get(messageId)?.deletedAt) continue;
    const deltas = turnEvents.filter((event) => event.eventType === "delta"
      && event.sequence < done.sequence && event.attemptId === done.attemptId
      && payload(event.data).messageId === messageId);
    if (deltas.length === 0 || deltas.some((event) => event.safetyDecision !== "approved")) continue;
    const assistant = deltas.map((event) => payload(event.data).text)
      .filter((text): text is string => typeof text === "string").join("");
    if (!assistant.trim()) continue;
    const size = user.content.length + assistant.length;
    // 保留完整对话轮；预算不足即停止，不伪造摘要或截断半条事实。
    if (size > remaining) break;
    remaining -= size;
    result.push([
      { role: "user", content: user.content },
      { role: "assistant", content: assistant },
    ]);
  }
  return result.reverse().flat();
}
