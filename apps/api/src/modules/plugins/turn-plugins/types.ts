/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件契约 (Server Turn Plugin Protocol)
 *
 * 允许独立插件介入单次回合（Turn）执行的生命周期：
 * 1. beforeTurn: 探测前缀/条件，读取配置，产出动态系统提示词 (extraSections) 与决策标志；
 * 2. afterTurn: Turn 执行完毕后（成功/中断/失败）执行增强后处理（如术语抽取、日志归档等）。
 */
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";
import type { LLMCallable } from "@aervox/practice-review";

export interface TurnPluginContext {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  tenant: TenantContext;
  repo: SqliteConversationRepository;
  llm?: LLMCallable | null;
  /** Turn 级结构化元数据（如 mode: 'study' | 'quiz'） */
  metadata?: Record<string, unknown>;
}

export interface BeforeTurnResult {
  /** 注入到 Base System Prompt 的片段 */
  extraSections?: string[];
  /** 是否允许触发刷题模式联动 */
  allowQuizTrigger?: boolean;
  /** 是否激活刷题模式 (CAP-016) */
  quizMode?: boolean;
  /** 传递给 afterTurn 的任意自定义上下文状态 */
  state?: Record<string, unknown>;
}

export interface AfterTurnContext extends TurnPluginContext {
  status: "Completed" | "Failed" | "Interrupted";
}

export interface ServerTurnPlugin {
  /** 唯一对应的插件 ID（如 study-mode） */
  id: string;

  /**
   * 前置切面：在构建 Agent Loop System Prompt 前执行。
   * 插件检查自身是否需要介入（例如检测特定前缀、配置或会话上下文），返回要注入的 prompt 片段。
   */
  beforeTurn?(
    ctx: TurnPluginContext,
    config?: Record<string, unknown>,
  ): Promise<BeforeTurnResult | void> | BeforeTurnResult | void;

  /**
   * 后置切面：在回合执行完成后执行增强后处理。
   */
  afterTurn?(
    ctx: AfterTurnContext,
    config?: Record<string, unknown>,
    beforeResult?: BeforeTurnResult,
  ): Promise<void> | void;
}
