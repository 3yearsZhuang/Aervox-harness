/**
 * Aervox｜思隅 @aervox/core — Agent Harness Loop 领域类型
 *
 * 规则依据：docs/reference/agent-harness-loop.md（AVX-HAR-001）§5 状态机、§12.1 内部领域事件。
 * 阶段 1：无工具单 Step；阶段 2：只读工具多 Step（本文件含阶段 2 扩展）。
 * 公开 SSE 负载与 @aervox/contracts 的 TurnStreamEvent 结构对齐（由宿主适配）；本文件是内核内部 schema，不依赖 contracts。
 */

/** Attempt 状态（对齐 turn_attempts.status 列；CancelRequested 为取消请求位，Cancelled 为终态，AVX-HAR-001 §5.1） */
export type AttemptStatus = "Running" | "CancelRequested" | "Completed" | "Failed" | "Interrupted" | "Cancelled";

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

/** Loop 内部持久事件类型（阶段 2 工具、阶段 3a 审批；公开 SSE 只消费 message/delta/done） */
export type LoopEventType =
  | "message"
  | "delta"
  | "done"
  | "error"
  | "redacted"
  | "emote"
  | "reasoning_delta"
  | "tool_request"
  | "tool_result"
  | "tool_approval_required"
  | "tool_approval_granted"
  | "tool_approval_denied"
  | "user_question_required"
  | "user_question_answered";

/** 分段安全门决策（阶段 1/2 本地确定性内容，统一 approved） */
export type SafetyDecision = "approved" | "blocked" | "redacted" | "pending";

/** Prompt 上下文中的单条消息（阶段 2 起包含 tool 结果消息） */
export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** tool 消息必填：对应 ToolInvocation 标识 */
  toolCallId?: string;
  name?: string;
  /** Complete assistant calls paired with subsequent tool messages. */
  toolCalls?: ToolCallRequest[];
  /** Reasoning belongs to this assistant step, never shared across requests. */
  reasoning?: string;
}

/** ContextBuilder 产出：Provider 组装输入所需的上下文 */
export interface PromptContext {
  turnId: string;
  sessionId: string;
  messages: PromptMessage[];
}

/** Skill 渐进披露描述（阶段 5b；只携 name+description，模型按需读取 SKILL.md 全文） */
export interface SkillDescriptor {
  name: string;
  description: string;
}

/** Context 压缩输入（阶段 5b；纯上下文数据，不含数据库句柄） */
export interface ContextCompactionInput {
  turnId: string;
  sessionId: string;
  messages: PromptMessage[];
}

/** Context 压缩结果：压缩后的消息列表 + 可选摘要文本（审计/可观测） */
export interface ContextCompactionResult {
  messages: PromptMessage[];
  summary?: string;
}

/** 工具描述（只读白名单工具的主仓快照；阶段 2d 与工具注册表共用） */
export interface ToolSpec {
  name: string;
  description: string;
  /** read_only：AI 可自主调用；write_with_approval：需授权（阶段 3a） */
  readOnly: boolean;
  /**
   * 参数 JSON Schema（OpenAI 兼容 function calling 的 parameters）。
   * 缺省时 LLM 请求降级为 `{type:"object"}`——模型只能从 description 推断参数形状，
   * 容易把数组参数序列化为字符串（真实 LLM 下 ask_user_questions 曾触发）。声明 schema 的工具应尽量提供。
   */
  parameters?: Record<string, unknown>;
}

/** 审批信息（宿主在需要授权时返回：approvalId + 授权匹配键） */
export interface ToolApprovalInfo {
  approvalId: string;
  toolName: string;
  /** 参数规范化哈希（授权匹配用；宿主计算） */
  argumentsHash: string;
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
  failureKind?: "timeout" | "execution_error" | "rejected";
  id: string;
  name: string;
  ok: boolean;
  /** 成功输出（只读工具输出） */
  output?: unknown;
  /** 失败/超时/被拒绝原因 */
  error?: string;
  /** 阶段 3a：宿主需要授权（未执行）；携带审批匹配键 */
  needsApproval?: ToolApprovalInfo;
}

/** Declared protocol capabilities and verified model capacity; absence means unknown. */
export interface ModelCapabilities {
  toolCalls: boolean;
  reasoning: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

/** Model Provider 请求（ADR-005 ModelProviderPort 的阶段 2 面：支持工具请求） */
export interface ModelRequest {
  turnId: string;
  attemptId: string;
  step: number;
  context: PromptContext;
  /** 阶段 2e：当前可执行的只读工具 schema（供真实模型生成 tool_calls） */
  tools?: ToolSpec[];
  /** Remaining execution output allowance; providers must not widen it. */
  maxOutputTokens?: number;
  /** 采样温度覆盖值（缺省回退 Provider 配置或默认 0.7） */
  temperature?: number;
  /** 取消信号（上层 ControlContext 或超时控制） */
  signal?: AbortSignal;
}

/** 终止原因归一（ITER-038 跨栈一致面）：映射 OpenAI 兼容 finish_reason；保留字符串兜底以容纳非标端点 */
export type ModelStopReason = "stop" | "tool_calls" | "length" | "content_filter" | (string & {});

/** 用量分账：总账保留（既有消费方），输入/输出分账由支持 stream_options.include_usage 的端点提供 */
export interface ModelUsage {
  /** Cumulative input + output tokens for this model request. */
  totalTokens: number;
  /** 提示词（输入）token 数 */
  promptTokens?: number;
  /** 补全（输出）token 数 */
  completionTokens?: number;
  /** Cached input tokens; included in promptTokens, never added to totalTokens. */
  cacheReadTokens?: number;
  /** Input tokens written to a provider cache, when explicitly reported. */
  cacheWriteTokens?: number;
}

/** Provider 流输出分块：文本增量 +（阶段 2）一次 Step 末的工具请求集合 */
export interface ModelChunk {
  usage?: ModelUsage;
  /** Step 结束原因（isFinal=true 时携带；结构化归一，替代裸 isFinal 布尔的语义缺失） */
  stopReason?: ModelStopReason;
  /** 本块文本（可持续追加；Step 无文本时可空字符串） */
  text: string;
  /** 本 Step 输出是否结束（后续不再有块；可能伴随 toolCalls） */
  isFinal: boolean;
  /** Step 结束时模型请求的工具（isFinal=true 时携带） */
  toolCalls?: ToolCallRequest[];
  /**
   * 思考型模型（DeepSeek reasoning_content / OpenRouter·Ollama reasoning）的思考增量。
   * 非正文：不进用户可见消息与安全片段；作为 reasoning_delta 进度事件透出，
   * 并由当前 Step 的 assistant PromptMessage 保存以满足后续工具调用协议，
   * 让客户端在长思考期间保持活性与「思考中」反馈。
   */
  reasoning?: string;
}

/** executeTurn 执行结果 */
export type ExecuteResult =
  | { status: "completed"; attemptId: string; lastSequence: number; stepsTaken: number }
  | { status: "cancelled"; attemptId: string; lastSequence: number; stepsTaken: number }
  /**
   * 库内终态 Interrupted 的镜像（预算 / 截止 / 删除水位 / turn 超时 / max_steps / 待授权）。
   * 与 failed 的分界以 DB 收敛状态为准，不按「是否出错」：库内 Failed（tools_disabled、
   * execution error）或本 runner 未能终态化（lease_lost、finalize contested）才用 failed。
   */
  | { status: "interrupted"; attemptId: string; reason: string }
  | { status: "failed"; attemptId: string; reason: string }
  | { status: "skipped"; attemptId: string; reason: "not_runnable" | "already_claimed" };

/** 工具副作用证据状态（阶段 2d 持久化为 tool_executions；3a 增审批待决；2c 增预留/未知结果） */
export type ToolExecutionStatus =
  /** 意图已提交（幂等预留/进行中，AVX-HAR-001 §9 idempotency reservation） */
  | "pending"
  /** 已执行（含成功输出） */
  | "executed"
  /** 被拒绝：未注册 / 非只读 / 未配置工具 */
  | "rejected"
  /** 重复调用被拦截 */
  | "duplicate"
  /** 执行抛错或超时 */
  | "timeout_error"
  /** 崩溃释放后结果未知（§11.3 unknown outcome：不自动重放） */
  | "outcome_unknown"
  /** 阶段 3a：写工具等待授权，未执行 */
  | "pending_approval";

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

/** AgentInboxItem 类型（AVX-HAR-001 §7.2 + ADR-017） */
export type AgentInboxItemType = "followup" | "steer" | "inject";

/** AgentInboxItem 消费边界（next-turn=排队为新 Turn 输入；next-step=注入下一 Step 输入） */
export type AgentInboxConsumeBoundary = "next-turn" | "next-step";

/** AgentInboxItem 状态（ADR-017：pending → claimed → acknowledged；expired 兜底回收） */
export type AgentInboxItemStatus = "pending" | "claimed" | "acknowledged" | "expired";

/** 来源 actor（用户 / Agent / 插件；外部插件只能提交受限 inbox command） */
export type AgentInboxSourceActor = "user" | "agent" | "plugin";

/** AgentInboxItem（Loop 应用层面；ADR-017 数据模型） */
export interface AgentInboxItem {
  id: string;
  /** 幂等键（租户内唯一；重复提交安全） */
  idempotencyKey: string;
  sessionId: string;
  /** 消费目标 Attempt（next-turn = null；next-step 定位） */
  attemptId?: string;
  stepId?: string;
  type: AgentInboxItemType;
  /** 顺序（同目标边界内单调） */
  orderingSeq: number;
  sourceActor: AgentInboxSourceActor;
  /** 内容载荷（compact 编码，含来源与用途标注） */
  payload: unknown;
  status: AgentInboxItemStatus;
  consumeBoundary: AgentInboxConsumeBoundary;
  claimedAt?: string;
  ackedAt?: string;
  expiresAt?: string;
  createdAt: string;
}

/** 受控 inbox command（外部插件/用户提交 followup/steer/inject 的统一入口） */
export interface AgentInboxCommand {
  /** 幂等键（来源 + 事件去重；重复提交安全） */
  idempotencyKey: string;
  sessionId: string;
  attemptId?: string;
  stepId?: string;
  type: AgentInboxItemType;
  sourceActor: AgentInboxSourceActor;
  payload: unknown;
  /** 消费边界；缺省按类型推定（followup→next-turn；steer/inject→next-step） */
  consumeBoundary?: AgentInboxConsumeBoundary;
  /** 过期时间；缺省不自动过期 */
  expiresAt?: string;
}

/**
 * Subagent 委托输入（阶段 5c：Subagent/Workflow Contribution，AVX-HAR-001 §13 阶段 5）。
 * Leader Loop 在 Step 中调用 `subagent_delegate`，宿主创建独立子 turn/attempt（落库可审计/恢复）。
 */
export interface SubagentDelegateInput {
  controlContext?: import("./control-context.js").ControlContext;
  /** 父（Leader）Turn/Attempt/执行键（子任务溯源；parentAttemptId+parentExecutionId 幂等） */
  parentTurnId: string;
  parentAttemptId: string;
  parentExecutionId: string;
  /** 子任务归属会话（与父一致；审计与恢复沿用会话边界） */
  sessionId: string;
  /** 子任务目标（仅注入子上下文，不注入父历史：隔离原则） */
  task: string;
  /**
   * 子任务工具集约束（缺省：Host 默认工具集）。
   * 递归防护：Leader 侧生成的子工具集必须剔除 `subagent_delegate`/`workflow_run`。
   */
  toolScope?: ToolSpec[];
}

/** Subagent 运行结果（父级经 tool_result 回填；子任务完整事件在子 turn 下审计） */
export interface SubagentRunResult {
  subTurnId: string;
  subAttemptId: string;
  /** 子 Attempt 终态（Completed = 结果可信；其余 = error/被取消/预算截断） */
  status: AttemptStatus;
  /** 子任务正文输出（Completed 时的 delta 聚合） */
  resultText?: string;
  error?: string;
}

/** Workflow 步骤上下文（宿主扩展；不透传数据库句柄，宿主按需注入） */
export interface WorkflowContext {
  turnId: string;
  attemptId: string;
  sessionId: string;
  /** 父级取消信号（步骤在长任务中协作感知；取消不在此层被吞没） */
  signal?: AbortSignal;
  /** 控制上下文（预算/截止与工具调用同源收紧；步骤不得放松其约束） */
  controlContext?: import("./control-context.js").ControlContext;
}

/** Workflow 步骤结果（上一步输出作为下一步输入） */
export interface WorkflowStepResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

/** Workflow 步骤（5c：TypeScript 步骤定义形态；顺序执行） */
export interface WorkflowStep {
  /** 供审计/模型理解的步骤说明 */
  description: string;
  execute(ctx: WorkflowContext, input: unknown): Promise<WorkflowStepResult>;
}

/** Workflow 定义（宿主以类型安全步骤数组声明，天然过 typecheck；`workflow_run` 为写类走既有审批） */
export interface WorkflowDefinition {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

/** 阶段 7（ADR-017）：Step 级 ModelRun 记录（Loop 可追溯写入；宿主落库为 model_runs） */
export interface ModelRunRecord {
  runId: string;
  turnId: string;
  sessionId: string;
  attemptId: string;
  stepId: number;
  provider: string;
  modelId: string;
  purpose: string;
  status: "completed" | "failed";
  latencyMs?: number;
}

/** ContextManifest 快照（每次实际模型调用；宿主落库为 context_manifests） */
export interface ContextManifestRecord {
  manifestId: string;
  turnId: string;
  sessionId: string;
  attemptId: string;
  stepId: number;
  modelRunId: string;
  purpose: string;
  /** 上下文 messages 快照（序列化面由宿主决定；不在此持有数据库结构） */
  snapshot: PromptMessage[];
  /** Optional for older hosts; the model request's tool and generation settings. */
  requestSnapshot?: { tools: ToolSpec[]; maxOutputTokens?: number; temperature?: number };
}

// ============ UQ-01 用户提问交互负载（ADR-021 内核提纯：内核本地声明，不再 type-import @aervox/contracts） ============
// 与 packages/contracts 的 askUserQuestion*Schema（z.infer 输出面）结构兼容，
// 由 core/test/type-compat.test.ts 锁定单向可赋值，防止双源漂移。

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionIntent {
  kind: "plan-review" | "choice" | "confirmation";
  approve?: string;
}

export interface AskUserQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: AskUserQuestionOption[];
  /** 与 @aervox/contracts z.infer 输出面同构（schema default(false) 收窄后必选）；内核构造点恒显式赋值 */
  multiSelect: boolean;
  intent?: AskUserQuestionIntent;
}

export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}
