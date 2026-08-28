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
import { decideResume } from "@aervox/agent-loop";
import { buildResumeHistory } from "@aervox/agent-loop";
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";
import type { Client } from "@libsql/client";

export interface SqliteResumeSourceDeps {
  repo: SqliteConversationRepository;
  /** 跨租户候选查询连接（worker/client 语义：一次性 SQL 扫描） */
  client: Client;
}

/** 从事件流提取最后工具结果批次的 Step 数（executionId = attempt:step:seq 的 step 段） */
const lastStepOf = (events: Array<{ data?: { executionId?: string } | null }>, attemptId: string): number => {
  let lastStep = 0;
  for (const ev of events) {
    const id = ev.data?.executionId ?? "";
    if (!id.startsWith(`${attemptId}:`)) continue;
    const step = Number(id.split(":")[1]);
    if (Number.isFinite(step) && step > lastStep) lastStep = step;
  }
  return lastStep;
};

export function createSqliteResumeSource(deps: SqliteResumeSourceDeps): TurnSourcePort {
  const { repo, client } = deps;
  return {
    async listClaimable(limit: number): Promise<ClaimableTurn[]> {
      const candidates = await repo.findResumeCandidates(client);
      const turns: ClaimableTurn[] = [];
      for (const c of candidates.slice(0, limit)) {
        const tenant: TenantContext = { workspaceId: c.workspaceId, subjectUserId: c.subjectUserId };
        const events = await repo.getStreamEvents(tenant, c.turnId);
        const executions = (await repo.listToolExecutionsByTurn(tenant, c.turnId)).map((r) => ({
          invocationId: r.invocationId,
          status: r.status,
          replay: r.replay === "safe" ? ("safe" as const) : r.replay === "never" ? ("never" as const) : null,
        }));
        const decision = decideResume(events as never, executions as never);
        if (!decision.resume) continue; // 非可续 → 交由既有恢复语义收敛
        const rebuilt = buildResumeHistory({ userMessage: c.userMessage, events: events as never });
        // B3：结果未确定但工具声明 replay:safe → 注入合成结果（TOOL_NOT_STARTED /
        // TOOL_OUTCOME_UNKNOWN）为 tool 消息，指导模型不再重复执行副作用后继续原 Attempt。
        // 合成结果仅存在于重建上下文，不写事件/账本——保持事件流只含权威提交边界（§11.3）。
        if (decision.reason === "synthesized" && decision.synthesized.length > 0) {
          const lastRequest = [...events].reverse().find((e) => e.eventType === "tool_request") as
            | { data?: { invocationId?: unknown; name?: unknown } | null }
            | undefined;
          const toolCallId =
            typeof lastRequest?.data?.invocationId === "string"
              ? lastRequest.data.invocationId
              : decision.synthesized[0]!.executionId;
          const name = typeof lastRequest?.data?.name === "string" ? lastRequest.data.name : "";
          for (const item of decision.synthesized) {
            rebuilt.history.push({
              role: "tool",
              toolCallId,
              name,
              content: JSON.stringify({
                ok: true,
                error: undefined,
                output: {
                  synthetic: item.kind === "not_started" ? "TOOL_NOT_STARTED" : "TOOL_OUTCOME_UNKNOWN",
                  executionId: item.executionId,
                },
              }),
            });
          }
        }
        turns.push({
          turnId: c.turnId,
          attemptId: c.attemptId,
          sessionId: c.sessionId,
          userMessage: c.userMessage,
          resume: {
            expectedFencingToken: c.fencingToken,
            lastSequence: decision.lastSequence ?? c.lastSequence,
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