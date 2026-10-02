/**
 * Aervox｜思隅 @aervox/host-plugin-api — 服务端回合插件契约 (Server Turn Plugin Protocol)
 *
 * 机器事实源：CR-060 与 AVX-PLUG-001 §0.3。
 *
 * 本包是**第一方插件与宿主之间的唯一装配契约**，只含类型与窄端口，零运行时依赖。
 * 设计约束：
 * 1. 插件不得接触宿主仓储实现（`@aervox/repositories`）或模块内部总线；宿主把
 *    需要的能力收敛为窄端口注入，插件据此工作，从而实现"删掉插件宿主仍可编译"；
 * 2. 契约内不得出现任何具体插件的领域字段；插件私有语义一律经
 *    `BeforeTurnResult.state` 与 Turn `metadata` 自行承载；
 * 3. 宿主注册表实现由 `apps/api` 提供，本包只声明其形状。
 */

/** 回合流事件帧：与宿主 `TurnStreamHub` / 仓储事件模型结构一致，宿主适配为零成本 */
export interface TurnStreamEventFrame {
  id: string;
  turnId: string;
  /** 回合内单调递增序号 */
  sequence: number;
  eventType: string;
  payloadVersion: number;
  occurredAt: string;
  data: unknown;
}

/**
 * 追加事件的入参。
 * `id`、`sequence`、`occurredAt` 等持久化细节由宿主分配，插件只描述语义，
 * 避免插件自行拼接 id 或推算序号而与宿主写入路径产生分歧。
 */
export interface TurnStreamAppendInput {
  eventType: string;
  payloadVersion?: number;
  data: unknown;
}

/**
 * 回合流窄端口。
 * 宿主负责把 `LocalContext` 与仓储/总线封装在实现内部，插件不感知其存在；
 * `appendEvent` 应同时落库并广播，保证 SSE 实时性与重放一致性。
 */
export interface TurnStreamPort {
  readEvents(turnId: string, fromSequence: number): Promise<TurnStreamEventFrame[]>;
  /** 追加事件：由宿主分配 id/序号/时间，落库并实时广播 */
  appendEvent(input: TurnStreamAppendInput): Promise<TurnStreamEventFrame>;
}

/** 插件可用的模型调用窄端口（宿主按当前配置注入，可能缺省） */
export interface TurnLlmPort {
  generate(prompt: string, options?: { systemPrompt?: string; temperature?: number }): Promise<string>;
}

/** 回合插件上下文 */
export interface TurnPluginContext {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  /** Turn 级结构化元数据；模式等插件私有语义经此传递，宿主不解释其取值 */
  metadata?: Record<string, unknown>;
  /** 回合流端口（读既有事件、追加新事件） */
  stream: TurnStreamPort;
  /** 可选模型调用端口 */
  llm?: TurnLlmPort | null;
}

/** 前置切面返回值 */
export interface BeforeTurnResult {
  /** 注入到 Base System Prompt 的片段（按插件注册顺序拼接） */
  extraSections?: string[];
  /** 传递给本插件 afterTurn 的自定义状态；宿主不解释其结构 */
  state?: Record<string, unknown>;
}

/** 后置切面上下文 */
export interface AfterTurnContext extends TurnPluginContext {
  status: "Completed" | "Failed" | "Interrupted";
}

/** 服务端回合插件：由宿主组合根显式注册 */
export interface ServerTurnPlugin {
  /** 插件唯一 id（与 Manifest `metadata.id` 一致） */
  id: string;
  /** 展示名（可选） */
  name?: string;
  /**
   * 历史兼容别名。仅为既有安装的平滑迁移保留：注册表按别名解析到主 id，
   * 但新插件**不得**借用他人 id 或别名。
   */
  aliases?: string[];

  /** 前置切面：在构建 Agent Loop System Prompt 前执行；返回 void 表示本回合不介入 */
  beforeTurn?(
    ctx: TurnPluginContext,
    config?: Record<string, unknown>,
  ): Promise<BeforeTurnResult | void> | BeforeTurnResult | void;

  /** 后置切面：回合终态后执行增强后处理（异常由宿主按插件隔离） */
  afterTurn?(
    ctx: AfterTurnContext,
    config?: Record<string, unknown>,
    beforeResult?: BeforeTurnResult,
  ): Promise<void> | void;
}

/** 宿主回合插件注册表契约（实现见 apps/api） */
export interface TurnPluginRegistryPort {
  register(plugin: ServerTurnPlugin): () => void;
  get(idOrAlias: string): ServerTurnPlugin | undefined;
  getAll(): ServerTurnPlugin[];
}
