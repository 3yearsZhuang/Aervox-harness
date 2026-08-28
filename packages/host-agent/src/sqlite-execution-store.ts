/**
 * Aervox｜思隅 @aervox/host-agent — Agent Loop SQLite 执行存储适配（阶段 4a）
 *
 * 从 apps/api 迁移的组合根适配：实现 @aervox/agent-loop 的 ExecutionStorePort，
 * 宿主为对话仓储；API 同步路径与内嵌异步 Loop Host 共用本实现。
 * 迁移边界：apps/api 经 `@aervox/host-agent` 复用，不再自维护 SQLite 适配。
 */
import type {
  AgentStreamEvent,
  AgentStreamEventInput,
  ContextManifestRecord,
  ExecutionStorePort,
  ModelRunRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from "@aervox/agent-loop";
import { LeaseLostError } from "@aervox/agent-loop";
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";
import { FencingMismatchError } from "@aervox/database";

/**
 * 阶段 7（ADR-017）ModelRun/ContextManifest 落库口（可选委托）。
 * 不注入时 record* 为 no-op（缺省兼容既有宿主/测试）。
 */
export interface ModelRunSink {
  recordModelRun(input: ModelRunRecord): Promise<void>;
  recordContextManifest(input: ContextManifestRecord): Promise<void>;
}

const now = (): string => new Date().toISOString();
let seqCounter = 0;
const nextEventId = (turnId: string): string => `tev_${turnId}_${(++seqCounter).toString(36)}`;

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
    /** 阶段 7：ModelRun/Manifest 落库口（可选；缺省 no-op，兼容既有宿主/测试） */
    private readonly modelRunSink?: ModelRunSink,
  ) {}

  /** 阶段 7（ADR-017）：Step 级 ModelRun 写入（委托可选落库口；缺省 no-op） */
  async recordModelRun(input: ModelRunRecord): Promise<void> {
    await this.modelRunSink?.recordModelRun(input);
  }

  /** 阶段 7（ADR-017）：ContextManifest 快照写入（同上） */
  async recordContextManifest(input: ContextManifestRecord): Promise<void> {
    await this.modelRunSink?.recordContextManifest(input);
  }

  async claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<
    | { ok: true; fencingToken: number; leaseId?: string; leaseExpiresAt?: string }
    | { ok: false; reason: "not_runnable" | "already_claimed" }
  > {
    const res = await this.repo.claimTurnAttempt(this.tenant, {
      ...input,
      leaseId: `lease_${Date.now().toString(36)}`,
    });
    if (!res.ok) return { ok: false, reason: "already_claimed" };
    return {
      ok: true,
      fencingToken: res.fencingToken,
      leaseId: res.leaseId,
      leaseExpiresAt: res.leaseExpiresAt,
    };
  }

  /** 3b-A：续租（CAS 委托仓储） */
  async renewAttemptLease(input: {
    attemptId: string;
    leaseId: string;
    expectedFencingToken: number;
    ttlMs?: number;
  }): Promise<{ ok: boolean }> {
    const ok = await this.repo.renewTurnAttemptLease(this.tenant, input);
    return { ok };
  }

  async nextSequence(turnId: string): Promise<number> {
    const events = await this.repo.getStreamEvents(this.tenant, turnId, 0);
    return events.length + 1;
  }

  async appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent> {
    try {
      const created = await this.repo.appendStreamEvent(this.tenant, {
        id: nextEventId(input.turnId),
        turnId: input.turnId,
        sequence: input.sequence,
        eventType: input.eventType,
        data: input.data,
        occurredAt: now(),
        attemptId: input.attemptId,
        safetyDecision: input.safetyDecision,
        // B1：事件写入 fencing CAS（携带 expectedFencingToken 时仓储强制校验）
        expectedFencingToken: input.expectedFencingToken,
      });
      return toAgentEvent(created);
    } catch (err) {
      // B1：被抢占/恢复后写入被 CAS 拒绝 → 转译为 Loop 语义错误（executor 收敛为 lease_lost）
      if (err instanceof FencingMismatchError) {
        throw new LeaseLostError(`event write rejected: ${err.message}`);
      }
      throw err;
    }
  }

  async listEvents(turnId: string, afterSequence = 0): Promise<AgentStreamEvent[]> {
    const rows = await this.repo.getStreamEvents(this.tenant, turnId, afterSequence);
    return rows.map(toAgentEvent);
  }

  async finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: "Running" | "Completed" | "Failed" | "Interrupted" | "Cancelled";
    expectedFencingToken?: number;
  }): Promise<{ ok: boolean }> {
    const updated = await this.repo.finalizeTurnAttempt(this.tenant, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: input.status,
      expectedFencingToken: input.expectedFencingToken,
    });
    return { ok: Boolean(updated) };
  }

  /** 2b：用户取消请求位（CAS 委托仓储） */
  async requestCancelAttempt(input: {
    turnId: string;
    attemptId: string;
  }): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }> {
    return this.repo.requestCancelTurnAttempt(this.tenant, input);
  }

  /** 2b：executor 取消检查点（轮询仓储状态） */
  async isCancelRequested(input: { turnId: string; attemptId: string }): Promise<boolean> {
    return (await this.repo.getTurnAttemptStatus(this.tenant, input)) === "CancelRequested";
  }

  /** 工具副作用证据落库（tool_executions，AVX-HAR-001 §12） */
  async recordToolExecution(input: ToolExecutionRecord): Promise<void> {
    await this.repo.recordToolExecution(this.tenant, {
      turnId: input.turnId,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
      name: input.name,
      arguments: input.arguments,
      status: input.status,
      output: input.output,
      error: input.error ?? null,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    });
  }

  /** 2c：幂等预留（attempt+invocation 唯一） */
  async reserveToolExecution(input: {
    turnId: string;
    attemptId: string;
    invocationId: string;
    name: string;
    arguments: unknown;
  }): Promise<{ ok: boolean; alreadyReserved: boolean }> {
    return this.repo.reserveToolExecution(this.tenant, input);
  }

  /** 2c：以权威结果收口预留行 */
  async updateToolExecutionResult(input: {
    turnId: string;
    attemptId: string;
    invocationId: string;
    status: ToolExecutionStatus;
    output?: unknown;
    error?: string;
    finishedAt?: string;
  }): Promise<{ ok: boolean }> {
    return this.repo.updateToolExecutionResult(this.tenant, input);
  }
}