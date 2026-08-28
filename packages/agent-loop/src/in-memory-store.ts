/**
 * Aervox｜思隅 @aervox/agent-loop — 内存 Execution Store（阶段 0 测试骨架）
 *
 * 实现 ExecutionStorePort 供契约测试与固定回放夹具使用；生产由宿主以
 * @aervox/database 仓储适配（见 apps/api），两者行为约定以本文件为基准。
 */
import type { AgentStreamEvent, AgentStreamEventInput, ExecutionStorePort } from "./ports.js";
import type { AttemptStatus, ToolExecutionRecord } from "./types.js";

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
    // 3b-B：单一终态（仅 Running 可提交；fencing 匹配才允许）
    if (attempt.status !== "Running") return { ok: false };
    if (input.expectedFencingToken !== undefined && attempt.fencingToken !== input.expectedFencingToken) {
      return { ok: false };
    }
    attempt.status = input.status;
    return { ok: true };
  }

  /** 测试钩子：模拟租约被抢占/丢失（改 leaseId，使续租探活失败） */
  simulateLeaseLoss(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      attempt.leaseId = `lease_lost_${attemptId}`;
      attempt.leaseExpiresAt = new Date(0).toISOString();
    }
  }

  async recordToolExecution(input: ToolExecutionRecord): Promise<void> {
    this.toolExecutionLog.push(input);
  }

  /** 工具副作用证据日志（测试断言用） */
  toolExecutionRecords(): ToolExecutionRecord[] {
    return this.toolExecutionLog;
  }

  attemptStatus(attemptId: string): AttemptStatus | undefined {
    return this.attempts.get(attemptId)?.status;
  }
}