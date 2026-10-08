/**
 * Aervox｜思隅 @aervox/host-agent — SQLite 续跑候选源（阶段 4b）
 *
 * 实现 TurnSourcePort：从数据库收集「工具结果已权威提交但尚未注入」的过期 Attempt
 * （§11.3 首范式），逐候选裁决（decideResume）→ 重建上下文（buildResumeHistory）→
 * 产出携带 resume 上下文的 ClaimableTurn，交由 host 抢占续跑原 Attempt。
 *
 * 非候选（终态/混合批次/未知结果）保持原收敛语义（worker recoverExpiredAttempts 释放），
 * 不在此自动重放未知结果。
 */
import type { ClaimableTurn, TurnSourcePort } from "./agent-host.js";
import { decideResume } from "@aervox/core";
import { buildResumeHistory } from "@aervox/core";
import type { SqliteConversationRepository, LocalContext } from "@aervox/repositories";
import type { Client } from "@libsql/client";

export interface SqliteResumeSourceDeps {
  repo: SqliteConversationRepository;
  /** 本地候选查询连接（worker/client 语义：一次性 SQL 扫描） */
  client: Client;
}

const executionIdOf = (event: { data?: unknown }): string | undefined => {
  const data = event.data;
  if (!data || typeof data !== "object" || !("executionId" in data) || typeof data.executionId !== "string") return undefined;
  return data.executionId;
};

/** 从事件流提取最后工具结果批次的 Step 数（executionId = attempt:step:seq 的 step 段） */
const lastStepOf = (events: Array<{ data?: { executionId?: string } | null }>, attemptId: string): number => {
  let lastStep = 0;
  for (const ev of events) {
    const id = ev.data?.executionId ?? "";
    if (!id.startsWith(`${attemptId}:`)) continue;
    const step = Number(id.split(":").at(-2));
    if (Number.isFinite(step) && step > lastStep) lastStep = step;
  }
  return lastStep;
};

export function createSqliteResumeSource(deps: SqliteResumeSourceDeps): TurnSourcePort {
  const { repo, client } = deps;
  return {
    async listClaimable(limit: number): Promise<ClaimableTurn[]> {
      // Push the caller's backpressure limit into SQL; the repository also
      // applies a hard upper bound so this path never materializes the full
      // expired-attempt table in memory.
      const candidates = await repo.findResumeCandidates(client, limit);
      const turns: ClaimableTurn[] = [];
      for (const c of candidates) {
        const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
        const events = (await repo.getStreamEvents(ctx, c.turnId)).filter(e => e.attemptId === c.attemptId);
        const executions = (await repo.listToolExecutionsByTurn(ctx, c.turnId)).filter(r => r.attemptId === c.attemptId).map((r) => ({
          invocationId: r.invocationId,
          status: r.status,
          replay: r.replay === "safe" ? ("safe" as const) : r.replay === "never" ? ("never" as const) : null,
        }));
        // Every result must have exactly one preceding request; old or partial event trails are not resumable.
        const requests = events.filter(e => e.eventType === "tool_request");
        const results = events.filter(e => e.eventType === "tool_result");
        if (events.some(e => e.safetyDecision === "blocked" || e.safetyDecision === "redacted")) continue;
        if (requests.length !== results.length || executions.length !== requests.length) continue;
        if (new Set(events.map(e => e.sequence)).size !== events.length) continue;
        if (requests.some(request => !executionIdOf(request)?.startsWith(`${c.attemptId}:`))) continue;
        if (results.some(result => requests.filter(request => executionIdOf(request) === executionIdOf(result) && request.sequence < result.sequence).length !== 1)) continue;
        if (requests.some(request => results.filter(result => executionIdOf(request) === executionIdOf(result)).length !== 1)) continue;
        const decision = decideResume(events as never, executions as never);
        if (!decision.resume || decision.reason !== "resumable") continue; // 非可续 → 交由既有恢复语义收敛
        const rebuilt = buildResumeHistory({ userMessage: c.userMessage, events: events as never });
        const previous = await repo.getSessionHistory(ctx, {
          sessionId: c.sessionId,
          beforeTurnId: c.turnId,
        });
        rebuilt.history.unshift(...previous);
        turns.push({
          turnId: c.turnId,
          attemptId: c.attemptId,
          sessionId: c.sessionId,
          userMessage: c.userMessage,
          resume: {
            expectedFencingToken: c.fencingToken,
            lastSequence: Math.max(decision.lastSequence, c.lastSequence),
            lastStep: lastStepOf(events as never, c.attemptId),
            history: rebuilt.history,
            messageId: rebuilt.messageId || `msg_${c.turnId}_assistant`,
          },
        });
      }
      return turns;
    },
  };
}
