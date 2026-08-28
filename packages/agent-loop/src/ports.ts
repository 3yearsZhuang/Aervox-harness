/**
 * Aervox｜思隅 @aervox/agent-loop — Port 契约（阶段 0）
 *
 * Loop 应用层只依赖本端口，不得导入 Drizzle/@libsql 或具体 SQLite 类（AVX-HAR-001 §15 阶段 0）。
 * 宿主持有实现：生产走 @aervox/database 仓储适配，测试走内存实现。
 */
import type {
  AttemptStatus,
  LoopEventType,
  ModelRequest,
  PromptContext,
  PromptMessage,
  SafetyDecision,
  ToolApprovalInfo,
  ToolCallRequest,
  ToolExecutionRecord,
  ToolSpec,
} from "./types.js";

/** 执行存储：Executor 的持久化边界 */
export interface ExecutionStorePort {
  /**
   * 领取 Attempt（CAS + fencing）：仅在 Attempt 可执行且期望 fencing 匹配时成功，
   * 成功后 fencing 递增并绑定租约（含过期时刻），防重复执行；3b-B 据过期抢占/恢复。
   */
  claimTurnAttempt(input: {
    turnId: string;
    attemptId: string;
    expectedFencingToken: number;
  }): Promise<
    | { ok: true; fencingToken: number; leaseId?: string; leaseExpiresAt?: string }
    | { ok: false; reason: "not_runnable" | "already_claimed" }
  >;

  /** 3b-A：续租（CAS：leaseId + fencing 匹配且 Running 时才刷新过期时刻） */
  renewAttemptLease(input: {
    attemptId: string;
    leaseId: string;
    expectedFencingToken: number;
    ttlMs?: number;
  }): Promise<{ ok: boolean }>;

  /** 下一个可用事件序号（现有事件数 + 1；阶段 1 单执行器，不做跨执行器分配） */
  nextSequence(turnId: string): Promise<number>;

  /** 追加一条已过安全门的持久化流事件 */
  appendEvent(input: AgentStreamEventInput): Promise<AgentStreamEvent>;

  /** 读取 Turn 的持久事件（afterSequence 起点；0 = 全量） */
  listEvents(turnId: string, afterSequence?: number): Promise<AgentStreamEvent[]>;

  /** 提交 Attempt 终态；带 expectedFencingToken 时做 CAS 校验（单一终态，3b-B） */
  finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: AttemptStatus;
    expectedFencingToken?: number;
  }): Promise<{ ok: boolean }>;

  /** 记录一次工具执行（副作用证据账本；阶段 2d 落库 tool_executions） */
  recordToolExecution(input: ToolExecutionRecord): Promise<void>;
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

/** Model Provider（ADR-005 ModelProviderPort 阶段 2 面：支持工具请求） */
export interface ModelProviderPort {
  readonly id: string;
  stream(request: ModelRequest): AsyncIterable<{ text: string; isFinal: boolean; toolCalls?: ToolCallRequest[] }>;
}

/** 工具描述（定义见 types.ts；此处 re-export 保持既有导入路径兼容） */
export type { ToolSpec } from "./types.js";

/** 工具执行输入 */
export interface ToolExecutionInput {
  turnId: string;
  attemptId: string;
  invocationId: string;
  name: string;
  arguments: unknown;
}

/** 工具执行结果（调用方可注入下一 Step；副作用证据持久化留阶段 2d/3） */
export interface ToolExecutionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** 阶段 3a：需要授权（宿主未执行，生成 pending 授权并返回匹配键） */
  needsApproval?: ToolApprovalInfo;
}

/** 工具执行器（只读工具子集；阶段 3 扩展审批/幂等/副作用证据） */
export interface ToolProviderPort {
  /** 当前可执行工具的只读清单 */
  readonly tools: ToolSpec[];
  /** 执行命名工具；未注册或非只读一律拒绝（fail-closed） */
  execute(input: ToolExecutionInput): Promise<ToolExecutionResult>;
}

/** ContextBuilder：把 Turn 输入组装为 Provider 上下文 */
export interface ContextBuilderPort {
  build(input: { turnId: string; sessionId: string; messages: PromptMessage[] }): PromptContext;
}