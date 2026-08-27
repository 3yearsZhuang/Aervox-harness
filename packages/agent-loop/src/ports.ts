/**
 * Aervox｜思隅 @aervox/agent-loop — Port 契约（阶段 0）
 *
 * Loop 应用层只依赖本端口，不得导入 Drizzle/@libsql 或具体 SQLite 类（AVX-HAR-001 §15 阶段 0）。
 * 宿主持有实现：生产走 @aervox/database 仓储适配，测试走内存实现。
 */
import type { AttemptStatus, LoopEventType, PromptContext, PromptMessage, SafetyDecision } from "./types.js";

/** 执行存储：Executor 的持久化边界 */
export interface ExecutionStorePort {
  /**
   * 领取 Attempt（CAS + fencing）：仅在 Attempt 可执行且期望 fencing 匹配时成功，
   * 成功后 fencing 递增，防重复执行。
   */
  claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<{ ok: true; fencingToken: number } | { ok: false; reason: "not_runnable" | "already_claimed" }>;

  /** 下一个可用事件序号（现有事件数 + 1；阶段 1 单执行器，不做跨执行器分配） */
  nextSequence(turnId: string): Promise<number>;

  /** 追加一条已过安全门的持久化流事件 */
  appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent>;

  /** 读取 Turn 的持久事件（afterSequence 起点；0 = 全量） */
  listEvents(turnId: string, afterSequence?: number): Promise<AgentStreamEvent[]>;

  /** 提交 Attempt 终态 */
  finalizeAttempt(input: { turnId: string; attemptId: string; status: AttemptStatus }): Promise<void>;
}

/** 追加事件的输入（executor 构造；id / occurredAt / payloadVersion 由 store 补齐） */
export interface AgentStreamEventInput {
  turnId: string;
  attemptId: string;
  sequence: number;
  eventType: LoopEventType;
  data: unknown;
  safetyDecision: SafetyDecision;
  modelRunId?: string;
}

/** 持久化后的流事件（与 @aervox/contracts TurnStreamEvent 同构的最小面） */
export interface AgentStreamEvent extends AgentStreamEventInput {
  eventId: string;
  payloadVersion: number;
  occurredAt: string;
}

/** Model Provider（ADR-005 ModelProviderPort 阶段 1 最小面） */
export interface ModelProviderPort {
  readonly id: string;
  stream(request: {
    turnId: string;
    attemptId: string;
    context: PromptContext;
  }): AsyncIterable<{ text: string; isFinal: boolean }>;
}

/** ContextBuilder：把 Turn 输入组装为 Provider 上下文 */
export interface ContextBuilderPort {
  build(input: { turnId: string; sessionId: string; messages: PromptMessage[] }): PromptContext;
}