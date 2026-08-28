/**
 * Aervox｜思隅 @aervox/agent-loop — Agent Harness Loop 领域类型
 *
 * 规则依据：docs/reference/agent-harness-loop.md（AVX-HAR-001）§5 状态机、§12.1 内部领域事件。
 * 阶段 1：无工具单 Step；阶段 2：只读工具多 Step（本文件含阶段 2 扩展）。
 * 公开 SSE 契约仍复用 @aervox/contracts 的 TurnStreamEvent 负载；本文件是 Loop 内部 schema。
 */

/** Attempt 状态（对齐 turn_attempts.status 列） */
export type AttemptStatus = "Running" | "Completed" | "Failed" | "Interrupted";

/** Step 状态（阶段 2 增加 ToolRequested / ToolExecuted；阶段 3 扩写工具） */
export type StepStatus =
  | "Pending"
  | "Running"
  | "ModelSucceeded"
  | "ToolRequested"
  | "ToolExecuted"
  | "Finalized"
  | "Failed";

/** Turn 终止原因（阶段 2 起可产出 max_steps） */
export type TerminalReason = "completed" | "failed" | "cancelled" | "interrupted" | "max_steps";

/** Loop 内部持久事件类型（阶段 2 新增 tool 事件；公开 SSE 只消费 message/delta/done） */
export type LoopEventType =
  | "message"
  | "delta"
  | "done"
  | "error"
  | "redacted"
  | "tool_request"
  | "tool_result";

/** 分段安全门决策（阶段 1/2 本地确定性内容，统一 approved） */
export type SafetyDecision = "approved" | "blocked" | "redacted" | "pending";

/** Prompt 上下文中的单条消息（阶段 2 起包含 tool 结果消息） */
export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool 消息必填：对应 ToolInvocation 标识 */
  toolCallId?: string;
  name?: string;
}

/** ContextBuilder 产出：Provider 组装输入所需的上下文 */
export interface PromptContext {
  turnId: string;
  sessionId: string;
  messages: PromptMessage[];
}

/** 工具描述（只读白名单工具的主仓快照；阶段 2d 与工具注册表共用） */
export interface ToolSpec {
  name: string;
  description: string;
  /** 阶段 2 只接只读工具（PET-05 白名单）；写/需审批工具留阶段 3 */
  readOnly: true;
}

/** 模型请求一个工具调用（对齐 OpenAI 风格 tool_calls 的最小面） */
export interface ToolCallRequest {
  /** 本次调用唯一 ID（Attempt 内）；用于结果回填与去重 */
  id: string;
  name: string;
  /** 任意 JSON 参数 */
  arguments: unknown;
}

/** 工具执行结果（安全校验后注入下一 Step） */
export interface ToolCallResult {
  id: string;
  name: string;
  ok: boolean;
  /** 成功输出（只读工具输出） */
  output?: unknown;
  /** 失败/超时/被拒绝原因 */
  error?: string;
}

/** Model Provider 请求（ADR-005 ModelProviderPort 的阶段 2 面：支持工具请求） */
export interface ModelRequest {
  turnId: string;
  attemptId: string;
  step: number;
  context: PromptContext;
  /** 阶段 2e：当前可执行的只读工具 schema（供真实模型生成 tool_calls） */
  tools?: ToolSpec[];
}

/** Provider 流输出分块：文本增量 +（阶段 2）一次 Step 末的工具请求集合 */
export interface ModelChunk {
  /** 本块文本（可持续追加；Step 无文本时可空字符串） */
  text: string;
  /** 本 Step 输出是否结束（后续不再有块；可能伴随 toolCalls） */
  isFinal: boolean;
  /** Step 结束时模型请求的工具（isFinal=true 时携带） */
  toolCalls?: ToolCallRequest[];
}

/** executeTurn 执行结果 */
export type ExecuteResult =
  | { status: "completed"; attemptId: string; lastSequence: number; stepsTaken: number }
  | { status: "failed"; attemptId: string; reason: string }
  | { status: "skipped"; attemptId: string; reason: "not_runnable" | "already_claimed" };

/** 工具副作用证据状态（阶段 2d 持久化为 tool_executions） */
export type ToolExecutionStatus =
  /** 已执行（含成功输出） */
  | "executed"
  /** 被拒绝：未注册 / 非只读 / 未配置工具 */
  | "rejected"
  /** 重复调用被拦截 */
  | "duplicate"
  /** 执行抛错或超时 */
  | "timeout_error";

/** 工具执行账本记录（副作用证据；由 ExecutionStore 持久化） */
export interface ToolExecutionRecord {
  turnId: string;
  attemptId: string;
  invocationId: string;
  name: string;
  arguments: unknown;
  status: ToolExecutionStatus;
  output?: unknown;
  error?: string;
  startedAt: string;
  finishedAt: string;
}