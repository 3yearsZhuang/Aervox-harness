/**
 * Aervox｜思隅 @aervox/api — Agent Loop SQLite 执行存储适配（阶段 1）
 *
 * 实现 @aervox/agent-loop 的 ExecutionStorePort，宿主为对话仓储；
 * 迁移期 native-agent-loop 在 API 进程内挂载（AVX-HAR-001 §13），
 * 阶段 4 抽出独立 Host 时仅替换接线，Loop 核心控制流不变。
 */
import {
  createReplayProvider,
  defaultContextBuilder,
  executeTurn,
} from "@aervox/agent-loop";
import type {
  AgentStreamEvent,
  AgentStreamEventInput,
  ExecutionStorePort,
} from "@aervox/agent-loop";
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";

const now = (): string => new Date().toISOString();
let seqCounter = 0;
const nextEventId = (turnId: string): string =>
  `tev_${turnId}_${(++seqCounter).toString(36)}`;

const toAgentEvent = (row: {
  id: string;
  turnId: string;
  sequence: number;
  eventType: string;
  payloadVersion: number;
  data: unknown;
  occurredAt: string;
  attemptId?: string | null;
  safetyDecision?: string | null;
}): AgentStreamEvent => ({
  eventId: row.id,
  turnId: row.turnId,
  attemptId: row.attemptId ?? "",
  sequence: row.sequence,
  eventType: row.eventType as AgentStreamEvent["eventType"],
  payloadVersion: row.payloadVersion,
  data: row.data,
  safetyDecision: (row.safetyDecision as AgentStreamEvent["safetyDecision"]) ?? "pending",
  occurredAt: row.occurredAt,
});

export class SqliteExecutionStore implements ExecutionStorePort {
  constructor(
    private readonly repo: SqliteConversationRepository,
    private readonly tenant: TenantContext,
  ) {}

  async claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<{ ok: true; fencingToken: number } | { ok: false; reason: "not_runnable" | "already_claimed" }> {
    const res = await this.repo.claimTurnAttempt(this.tenant, {
      ...input,
      leaseId: `lease_${Date.now().toString(36)}`,
    });
    if (!res.ok) return { ok: false, reason: "already_claimed" };
    return { ok: true, fencingToken: res.fencingToken };
  }

  async nextSequence(turnId: string): Promise<number> {
    const events = await this.repo.getStreamEvents(this.tenant, turnId, 0);
    return events.length + 1;
  }

  async appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent> {
    const created = await this.repo.appendStreamEvent(this.tenant, {
      id: nextEventId(input.turnId),
      turnId: input.turnId,
      sequence: input.sequence,
      eventType: input.eventType,
      data: input.data,
      occurredAt: now(),
      attemptId: input.attemptId,
      safetyDecision: input.safetyDecision,
    });
    return toAgentEvent(created);
  }

  async listEvents(turnId: string, afterSequence = 0): Promise<AgentStreamEvent[]> {
    const rows = await this.repo.getStreamEvents(this.tenant, turnId, afterSequence);
    return rows.map(toAgentEvent);
  }

  async finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: "Running" | "Completed" | "Failed" | "Interrupted";
  }): Promise<void> {
    await this.repo.finalizeTurnAttempt(this.tenant, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: input.status,
    });
  }
}

/** 迁移期接线：创建 Turn 后立即以 Replay Provider 执行一次（实时 Provider 阶段 2 接入） */
export async function runReplayTurnOnce(
  repo: SqliteConversationRepository,
  tenant: TenantContext,
  input: { turnId: string; sessionId: string; attemptId: string; userMessage: string },
): Promise<void> {
  const store = new SqliteExecutionStore(repo, tenant);
  const result = await executeTurn(
    {
      execution: store,
      provider: createReplayProvider(),
      contextBuilder: defaultContextBuilder,
    },
    input,
  );
  // 以 Loop 结果对齐 turns 状态；skipped（幂等保护）不覆盖。
  if (result.status === "completed") {
    await repo.updateTurnStatus(tenant, input.turnId, "Completed");
  }
}