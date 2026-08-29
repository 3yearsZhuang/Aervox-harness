/**
 * Aervox｜思隅 @aervox/agent-loop — Port 契约（阶段 0）
 *
 * Loop 应用层只依赖本端口，不得导入 Drizzle/@libsql 或具体 SQLite 类（AVX-HAR-001 §15 阶段 0）。
 * 宿主持有实现：生产走 @aervox/database 仓储适配，测试走内存实现。
 */
import type {
  AgentInboxCommand,
  AgentInboxConsumeBoundary,
  AgentInboxItem,
  AttemptStatus,
  ContextCompactionInput,
  ContextCompactionResult,
  ContextManifestRecord,
  LoopEventType,
  ModelChunk,
  ModelRequest,
  ModelRunRecord,
  PromptContext,
  PromptMessage,
  SafetyDecision,
  SubagentDelegateInput,
  SubagentRunResult,
  ToolApprovalInfo,
  ToolExecutionRecord,
  ToolExecutionStatus,
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

  /** 提交 Attempt 终态；带 expectedFencingToken 时做 CAS 校验（单一终态，3b-B；Running/CancelRequested 均可提交） */
  finalizeAttempt(input: {
    turnId: string;
    attemptId: string;
    status: AttemptStatus;
    expectedFencingToken?: number;
  }): Promise<{ ok: boolean }>;

  /**
   * 用户取消请求位（AVX-HAR-001 §11.1）：仅 Attempt 仍在运行（Running）时置 CancelRequested，
   * 已终态则拒绝（拒绝优先于执行器自己的终态，避免覆盖已提交结果）。
   */
  requestCancelAttempt(input: {
    turnId: string;
    attemptId: string;
  }): Promise<{ ok: boolean; reason?: "not_found" | "already_finalized" }>;

  /** 检查 Attempt 是否已被请求取消（executor 检查点轮询；turnId 用于宿主租户定位） */
  isCancelRequested(input: { turnId: string; attemptId: string }): Promise<boolean>;

  /** 记录一次工具执行（副作用证据账本；阶段 2d 落库 tool_executions） */
  recordToolExecution(input: ToolExecutionRecord): Promise<void>;

  /** 2c：幂等预留（§9 idempotency reservation）——意图先于外部副作用持久化；attempt+invocation 幂等 */
  reserveToolExecution(input: {
    turnId: string;
    attemptId: string;
    invocationId: string;
    name: string;
    arguments: unknown;
  }): Promise<{ ok: boolean; alreadyReserved: boolean }>;

  /** 2c：以权威结果收口预留行（§9 非幂等副作用失败不自动重试） */
  updateToolExecutionResult(input: {
    turnId: string;
    attemptId: string;
    invocationId: string;
    status: ToolExecutionStatus;
    output?: unknown;
    error?: string;
    finishedAt?: string;
  }): Promise<{ ok: boolean }>;

  /**
   * 阶段 7（ADR-017）：Step 级 ModelRun 可追溯写入（宿主落库 model_runs，含 attemptId/stepId）。
   * 可观测副作用（同 recordToolExecution），不影响 Loop 控制流；宿主缺省可为 no-op。
   */
  recordModelRun(input: ModelRunRecord): Promise<void>;

  /** 阶段 7（ADR-017）：ContextManifest 快照写入（每 Turn 首个 Step；宿主落库 context_manifests） */
  recordContextManifest(input: ContextManifestRecord): Promise<void>;

  /**
   * B4-D（§12.2）：原子提交「工具结果账本收口 + tool_result 事件」。
   * 同一事务内写入 tool_executions 结果与 turn_stream_events 事件，避免崩溃把两者拆散。
   * fencing 失配（被抢占/恢复）→ 抛 LeaseLostError（与 appendEvent 同语义）。
   */
  recordToolOutcome(input: {
    turnId: string;
    attemptId: string;
    sequence: number;
    invocationId: string;
    name: string;
    arguments: unknown;
    status: ToolExecutionStatus;
    output?: unknown;
    error?: string;
    startedAt: string;
    finishedAt?: string;
    eventData: unknown;
    safetyDecision: SafetyDecision;
    expectedFencingToken: number;
  }): Promise<{ ok: boolean }>;

  /**
   * B4-D（§12.2）：原子提交「Attempt 终态 + 收尾事件（done/error）」。
   * 终态 CAS（Running/CancelRequested + fencing 匹配）成功才一并写事件；
   * 失败返回 ok:false（不抛，调用方按 contested 收敛，杜绝孤儿 done/终态错位）。
   */
  finalizeAttemptWithEvent(input: {
    turnId: string;
    attemptId: string;
    status: AttemptStatus;
    expectedFencingToken: number;
    sequence: number;
    eventType: Extract<LoopEventType, "done" | "error">;
    eventData: unknown;
    safetyDecision?: SafetyDecision;
  }): Promise<{ ok: boolean }>;

  /**
   * E2（§12.2「安全片段 + TurnStreamEvent + Draft prefix」）：原子提交「安全片段 + delta 事件」。
   * 同一事务内写入 safe_segments（committed=1 可见前缀）与 turn_stream_events（delta），
   * 崩溃不把片段与事件拆散。fencing 失配（被抢占/恢复）→ 抛 LeaseLostError。
   */
  recordSafeSegment(input: {
    turnId: string;
    attemptId: string;
    sequence: number;
    text: string;
    eventData: unknown;
    safetyDecision: SafetyDecision;
    expectedFencingToken: number;
  }): Promise<{ ok: boolean }>;

  /** E2：读取 Turn 的已提交安全片段（可见前缀；sequence 升序）。缺省实现返回空（宿主未接时透传）。 */
  listCommittedSegments?(turnId: string): Promise<Array<{ id: string; sequence: number; text: string; streamEventId: string | null }>>;
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
  /**
   * 3c+（B1）：事件写入 fencing CAS 校验。执行器必须携带 claim 得到的当前 fencing；
   * store 校验 Attempt 未被抢占/恢复（fencing 递增）且状态允许，否则抛 LeaseLostError。
   * 未携带则保持既有无校验行为（测试夹具/宿主收尾路径兼容）。
   */
  expectedFencingToken?: number;
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
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
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
  /** 5c：会话标识（Subagent/Workflow Contribution 创建子任务时归属会话；invocationId 为 Host 幂等键） */
  sessionId?: string;
  /** 缺陷 D：工具超时/外层取消信号。aborted 表示宿主不再等待本工具结果，
   *  实现应尽早停止长操作（清理 side effect 挂起）并 reject；支持取消是可选的，
   *  未感知 signal 的实现保持既有行为（结果将被丢弃，timer 由宿主管控） */
  signal?: AbortSignal;
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
  build(input: {
    turnId: string;
    sessionId: string;
    messages: PromptMessage[];
    /** 阶段 5a：本 Step 可消费的 inbox items（§7.1 第 7 项；缺省为空） */
    inboxItems?: AgentInboxItem[];
  }): PromptContext | Promise<PromptContext>;
}

/**
 * 阶段 5b：Context 压缩扩展点（Context compaction seam，§7.1 §13 阶段 5）。
 * 可插拔：缺省不配置即透传（行为与既有完全一致）；生产可注入 LLM 摘要实现。
 */
export interface ContextCompactionPort {
  compact(input: ContextCompactionInput): Promise<ContextCompactionResult>;
}

/**
 * 阶段 5a：受控收件箱（ADR-017）。外部插件/用户只能提交受限 inbox command，
 * 消费采用 claim/ack，崩溃后可安全重放。实现由宿主持有（生产走 @aervox/database 仓储，
 * 测试走内存实现）；Loop 应用层只依赖本端口。
 */
export interface InboxPort {
  /** 提交一条受控 inbox command（幂等：同 idempotencyKey 重复提交返回既有项） */
  enqueue(command: AgentInboxCommand): Promise<AgentInboxItem>;
  /**
   * claim 一批可消费的 inbox items（pending → claimed）：
   * - next-step：按 sessionId + attemptId + boundary 过滤，返回 claimed 项；
   * - next-turn：按 sessionId + boundary 过滤（attemptId 可空）。
   * 幂等：已被 claim 但未 ack 的项不会重复返回（崩溃安全重放语义）。
   */
  claimForConsumption(input: {
    sessionId: string;
    attemptId?: string;
    type: AgentInboxConsumeBoundary;
    limit?: number;
  }): Promise<AgentInboxItem[]>;
  /** ack 消费完成（claimed → acknowledged）；只接受此前 claim 的项 */
  ack(input: { itemIds: string[] }): Promise<void>;
}
/**
 * 阶段 5c：Subagent 委托端口（ADR-017 扩展点）。宿主实现子任务运行：创建独立子
 * turn/attempt 落库（可审计/恢复），嵌套执行后返回结构化结果；parentAttemptId +
 * parentExecutionId 幂等（崩溃/重试不产生重复子任务）。
 */
export interface SubagentPort {
  delegate(input: SubagentDelegateInput): Promise<SubagentRunResult>;
}

// ============ UQ-01 向用户询问交互端口 (DSH-UQ-01 借鉴) ============

export interface AskUserQuestionPortRequest {
  turnId: string;
  attemptId: string;
  step: number;
  questions: import("@aervox/contracts").AskUserQuestionItem[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AskUserQuestionPortResult {
  answers: import("@aervox/contracts").AskUserQuestionAnswerItem[];
}

/** 宿主实现的向用户询问协调端口 */
export interface UserQuestionPort {
  ask(request: AskUserQuestionPortRequest): Promise<AskUserQuestionPortResult>;
}

// ============ 刷题模式作答落库端口（CAP-016 刷题闭环） ============

/** 刷题模式下一次作答的落库请求（AI 判定后委托宿主持久化） */
export interface PracticeAttemptPortRequest {
  turnId: string;
  /** 题干 */
  prompt: string;
  /** 题型：choice | short_answer | fill_blank（展示用） */
  questionType?: string;
  /** 用户原始回答 */
  userAnswer: string;
  /** 标准答案 */
  correctAnswer: string;
  judgement: "correct" | "incorrect" | "partial";
  /** 解析（答错时的纠正说明） */
  explanation?: string;
  /** 可选知识点概念描述 */
  knowledgeConcept?: string;
}

export interface PracticeAttemptPortResult {
  questionId: string;
  attemptId: string;
  judgement: "correct" | "incorrect" | "partial";
  /** judgement === "incorrect" 时进入错题本 */
  enteredMistakeNotebook: boolean;
}

/** 宿主实现的刷题作答落库端口（写 questions + question_attempts） */
export interface PracticeAttemptPort {
  recordAttempt(request: PracticeAttemptPortRequest): Promise<PracticeAttemptPortResult>;
}

export type {
  AgentInboxCommand,
  AgentInboxConsumeBoundary,
  AgentInboxItem,
  ContextCompactionInput,
  ContextCompactionResult,
  SkillDescriptor,
  SubagentDelegateInput,
  SubagentRunResult,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepResult,
} from "./types.js";