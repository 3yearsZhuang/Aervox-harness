/**
 * Aervox｜思隅 @aervox/agent-loop — 内存 Execution Store（阶段 0 测试骨架）
 *
 * 实现 ExecutionStorePort 供契约测试与固定回放夹具使用；生产由宿主以
 * @aervox/database 仓储适配（见 apps/api），两者行为约定以本文件为基准。
 */
import type { AgentStreamEvent, AgentStreamEventInput, ExecutionStorePort } from "./ports.js";
import type {
  AttemptStatus,
  ContextManifestRecord,
  ModelRunRecord,
  ToolExecutionRecord,
  ToolExecutionStatus,
} from "./types.js";
import { LeaseLostError } from "./errors.js";

interface AttemptRecord {
  id: string;
  turnId: string;
  status: AttemptStatus;
  fencingToken: number;
  leaseId?: string;
  leaseExpiresAt?: string;
}

export class InMemoryExecutionStore implements ExecutionStorePort {
  private readonly eventsByTurn = new Map<string, AgentStreamEvent[]>();
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly toolExecutionLog: ToolExecutionRecord[] = [];
  private readonly toolExecutionByKey = new Map<string, ToolExecutionRecord>();
  private readonly modelRunLog: ModelRunRecord[] = [];
  private readonly contextManifestLog: ContextManifestRecord[] = [];
  private leaseRenewalCount = 0;

  seedAttempt(input: {
    id: string;
    turnId: string;
    status?: AttemptStatus;
    fencingToken?: number;
  }): void {
    this.attempts.set(input.id, {
      id: input.id,
      turnId: input.turnId,
      status: input.status ?? "Running",
      fencingToken: input.fencingToken ?? 0,
    });
  }

  async claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<
    | { ok: true; fencingToken: number; leaseId?: string; leaseExpiresAt?: string }
    | { ok: false; reason: "not_runnable" | "already_claimed" }
  > {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.status !== "Running") {
      return { ok: false, reason: "not_runnable" };
    }
    if (attempt.fencingToken !== input.expectedFencingToken) {
      return { ok: false, reason: "already_claimed" };
    }
    // 3b-B：未过期租约不可抢占
    if (attempt.leaseExpiresAt && Date.parse(attempt.leaseExpiresAt) > Date.now()) {
      return { ok: false, reason: "already_claimed" };
    }
    attempt.fencingToken += 1;
    attempt.leaseId = `lease_mem_${input.attemptId}`;
    attempt.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    return {
      ok: true,
      fencingToken: attempt.fencingToken,
      leaseId: attempt.leaseId,
      leaseExpiresAt: attempt.leaseExpiresAt,
    };
  }

  /** 3b-A：续租（CAS：leaseId + fencing 匹配且 Running 才刷新） */
  async renewAttemptLease(input: {
    attemptId: string;
    leaseId: string;
    expectedFencingToken: number;
    ttlMs?: number;
  }): Promise<{ ok: boolean }> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.status !== "Running") return { ok: false };
    if (attempt.leaseId !== input.leaseId || attempt.fencingToken !== input.expectedFencingToken) return { ok: false };
    attempt.leaseExpiresAt = new Date(Date.now() + (input.ttlMs ?? 60_000)).toISOString();
    this.leaseRenewalCount += 1;
    return { ok: true };
  }

  /** 续租次数（测试断言：Step 间持有租约） */
  leaseRenewals(): number {
    return this.leaseRenewalCount;
  }

  async nextSequence(turnId: string): Promise<number> {
    return (this.eventsByTurn.get(turnId)?.length ?? 0) + 1;
  }

  async appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent> {
    // B1：事件写入 fencing CAS 校验（与生产 SqliteExecutionStore 同语义；
    // 仅当携带期望 fencing 时启用，测试夹具直写保持兼容）
    if (input.expectedFencingToken !== undefined) {
      const attempt = this.attempts.get(input.attemptId);
      const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
      const terminalDoneOk =
        attempt &&
        (input.eventType === "done" || input.eventType === "error") &&
        ["Completed", "Failed", "Interrupted", "Cancelled"].includes(attempt.status);
      if (
        !attempt ||
        attempt.fencingToken !== input.expectedFencingToken ||
        !(running || terminalDoneOk)
      ) {
        throw new LeaseLostError(
          `attempt ${input.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot append ${input.eventType}`,
        );
      }
    }
    const event: AgentStreamEvent = {
      ...input,
      eventId: `tev_${input.turnId}_${input.sequence}`,
      payloadVersion: 1,
      occurredAt: new Date(0).toISOString(), // 测试确定性时间
    };
    const list = this.eventsByTurn.get(input.turnId) ?? [];
    list.push(event);
    this.eventsByTurn.set(input.turnId, list);
    return event;
  }

  async listEvents(turnId: string, afterSequence = 0): Promise<AgentStreamEvent[]> {
    return (this.eventsByTurn.get(turnId) ?? [])
      .filter((e) => e.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: AttemptStatus;
    expectedFencingToken?: number;
  }): Promise<{ ok: boolean }> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) return { ok: false };
    // 3b-B：单一终态（仅运行中状态 Running/CancelRequested 可提交；fencing 匹配才允许）
    if (attempt.status !== "Running" && attempt.status !== "CancelRequested") return { ok: false };
    if (input.expectedFencingToken !== undefined && attempt.fencingToken !== input.expectedFencingToken) {
      return { ok: false };
    }
    attempt.status = input.status;
    return { ok: true };
  }

  /** 2b：取消请求位（仅 Running → CancelRequested；已终态拒绝） */
  async requestCancelAttempt(input: {
    turnId: string;
    attemptId: string;
  }): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) return { ok: false, reason: "not_found" };
    if (attempt.status !== "Running") return { ok: false, reason: "already_finalized" };
    attempt.status = "CancelRequested";
    return { ok: true };
  }

  /** 2b：executor 检查点轮询 */
  async isCancelRequested(input: { turnId: string; attemptId: string }): Promise<boolean> {
    return this.attempts.get(input.attemptId)?.status === "CancelRequested";
  }

  /** 测试钩子：模拟租约被抢占/丢失（改 leaseId，使续租探活失败） */
  simulateLeaseLoss(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      attempt.leaseId = `lease_lost_${attemptId}`;
      attempt.leaseExpiresAt = new Date(0).toISOString();
    }
  }

  /** 测试钩子：模拟恢复器抢占（fencing +1，等价 worker recoverExpiredAttempts）——事件写入 CAS 将拒绝 */
  simulatePreemption(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      attempt.fencingToken += 1;
      attempt.leaseId = `lease_preempted_${attemptId}`;
      attempt.leaseExpiresAt = new Date(0).toISOString();
    }
  }

  async recordToolExecution(input: ToolExecutionRecord): Promise<void> {
    this.toolExecutionLog.push(input);
  }

  /** 2c：幂等预留（attempt+invocation 唯一；已存在不覆盖） */
  async reserveToolExecution(input: {
    turnId: string;
    attemptId: string;
    invocationId: string;
    name: string;
    arguments: unknown;
  }): Promise<{ ok: boolean; alreadyReserved: boolean }> {
    const key = `${input.attemptId}:${input.invocationId}`;
    if (this.toolExecutionByKey.has(key)) {
      return { ok: true, alreadyReserved: true };
    }
    const record: ToolExecutionRecord = {
      turnId: input.turnId,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
      name: input.name,
      arguments: input.arguments,
      status: "pending",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
    };
    this.toolExecutionLog.push(record);
    this.toolExecutionByKey.set(key, record);
    return { ok: true, alreadyReserved: false };
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
    const record = this.toolExecutionByKey.get(`${input.attemptId}:${input.invocationId}`);
    if (!record) return { ok: false };
    record.status = input.status;
    if (input.output !== undefined) record.output = input.output;
    record.error = input.error ?? (input.status === "rejected" || input.status === "timeout_error" ? record.error : undefined);
    record.finishedAt = input.finishedAt ?? new Date(0).toISOString();
    return { ok: true };
  }

  /** 工具倒插预留行（崩溃恢复下由恢复器标记未知结果；测试钩子） */
  markAllPendingUnknown(attemptId: string): void {
    for (const record of this.toolExecutionLog) {
      if (record.attemptId === attemptId && record.status === "pending") {
        record.status = "outcome_unknown";
      }
    }
  }

  /** 工具副作用证据日志（测试断言用） */
  toolExecutionRecords(): ToolExecutionRecord[] {
    return this.toolExecutionLog;
  }

  /** 阶段 7（ADR-017）：Step 级 ModelRun 可追溯写入（测试断言用） */
  async recordModelRun(input: ModelRunRecord): Promise<void> {
    this.modelRunLog.push(input);
  }

  /** 阶段 7（ADR-017）：ContextManifest 快照写入（测试断言用） */
  async recordContextManifest(input: ContextManifestRecord): Promise<void> {
    this.contextManifestLog.push(input);
  }

  /** 已写入的 ModelRun 记录（测试断言） */
  modelRunRecords(): ModelRunRecord[] {
    return this.modelRunLog;
  }

  /** 已写入的 ContextManifest 记录（测试断言） */
  contextManifestRecords(): ContextManifestRecord[] {
    return this.contextManifestLog;
  }

  attemptStatus(attemptId: string): AttemptStatus | undefined {
    return this.attempts.get(attemptId)?.status;
  }
}