/**
 * Aervox｜思隅 @aervox/agent-loop — Agent Harness Loop 领域类型（阶段 0 契约冻结）
 *
 * 规则依据：docs/reference/agent-harness-loop.md（AVX-HAR-001）§5 状态机与 §12.1 内部领域事件。
 * 这些是 Loop 内部领域 schema（非公开 SSE 契约），因此不放入 @aervox/contracts；
 * 公开事件复用 @aervox/contracts 的 TurnStreamEvent / message / delta / done 负载。
 *
 * 阶段 1 覆盖无工具的单个 Step；StepStatus 的 Tool 相关状态、TerminalReason 的
 * max_steps 等仅预留给阶段 2+，不在本阶段产生。
 */

/** Attempt 状态（对齐 turn_attempts.status 列） */
export type AttemptStatus = "Running" | "Completed" | "Failed" | "Interrupted";

/** Step 状态（AVX-HAR-001 §5.2 最小子集；阶段 2 增加 ToolRequested 等） */
export type StepStatus = "Pending" | "Running" | "ModelSucceeded" | "Finalized" | "Failed";

/** Turn 终止原因（AVX-HAR-001 §5.3；阶段 1 只产出 completed/failed） */
export type TerminalReason = "completed" | "failed" | "cancelled" | "interrupted" | "max_steps";

/** 公开 SSE 事件类型（与 @aervox/contracts streamEventType 对齐的本地窄化视图） */
export type LoopEventType =
  | "message"
  | "delta"
  | "done"
  | "error"
  | "redacted";

/** 分段安全门决策（阶段 1 本地确定性内容，统一 approved） */
export type SafetyDecision = "approved" | "blocked" | "redacted" | "pending";

/** Prompt 上下文中的单条消息（阶段 1：用户输入 + 可选系统提示） */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** ContextBuilder 产出：Provider 组装输入所需的上下文 */
export interface PromptContext {
  turnId: string;
  sessionId: string;
  messages: PromptMessage[];
}

/** Model Provider 请求（ADR-005 ModelProviderPort 的阶段 1 最小面） */
export interface ModelRequest {
  turnId: string;
  attemptId: string;
  context: PromptContext;
}

/** Provider 文本流分块；isFinal=true 表示该 Step 的流式输出结束 */
export interface ModelChunk {
  text: string;
  isFinal: boolean;
}

/** executeTurn 执行结果 */
export type ExecuteResult =
  | { status: "completed"; attemptId: string; lastSequence: number }
  | { status: "failed"; attemptId: string; reason: string }
  | { status: "skipped"; attemptId: string; reason: "not_runnable" | "already_claimed" };