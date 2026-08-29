/**
 * Aervox｜思隅 @aervox/contracts — 流式协议 Zod 模式
 *
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 * 模式是运行时校验与 OpenAPI 生成的事实源；类型经 z.infer 派生。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// 必须在任何 schema 创建前调用：zod 4 的 .openapi 只对 extend 之后创建的 schema 生效
extendZodWithOpenApi(z);

/** Turn 状态机（§3） */
export const turnStatusSchema = z.enum([
  "Created",
  "InputChecking",
  "Running",
  "Finalizing",
  "Completed",
  "Rejected",
  "CancelRequested",
  "Cancelled",
  "Interrupted",
  "Failed",
]);

/** 公开业务 SSE 事件类型（§4；tool_approval_required 为 PET-05 阶段 3a 事件，CR-024 补充登记） */
export const streamEventTypeSchema = z.enum([
  "message",
  "delta",
  "done",
  "error",
  "redacted",
  "emote",
  "reasoning_delta",
  "user_question_required",
  "user_question_answered",
  "tool_approval_required",
  "terms_extracted",
]);

/** 标准错误码（§4.5） */
export const streamErrorCodeSchema = z.enum([
  "IDEMPOTENCY_KEY_REUSED",
  "TURN_NOT_FOUND",
  "STREAM_CURSOR_EXPIRED",
  "TURN_CANCELLED",
  "MODEL_TIMEOUT",
  "MODEL_UNAVAILABLE",
  "OUTPUT_SAFETY_BLOCKED",
  "PERMISSION_REVOKED",
]);

/** 业务事件统一 envelope（§4） */
export const turnStreamEventSchema = z.object({
  /** 全局稳定且不可复用 */
  eventId: z.string().min(1),
  turnId: z.string().min(1),
  /** Turn 内从 1 单调递增且唯一 */
  sequence: z.number().int().positive(),
  eventType: streamEventTypeSchema,
  payloadVersion: z.number().int(),
  /** ISO-8601 UTC */
  occurredAt: z.iso.datetime(),
  modelRunId: z.string().optional(),
  /** 各事件 payload（见 *_data_schema） */
  data: z.unknown(),
});

/** message：Assistant Message 身份/可见元数据已提交（§4.1） */
export const messageEventDataSchema = z.object({
  messageId: z.string().min(1),
  role: z.literal("assistant"),
  contentType: z.enum(["text", "markdown"]),
  isComplete: z.boolean(),
});

/** delta：已通过安全门且已持久化的可见正文（§4.2） */
export const deltaEventDataSchema = z.object({
  messageId: z.string().min(1),
  text: z.string(),
  isFinal: z.boolean(),
});

/**
 * reasoning_delta：思考型模型的思考进度增量（CR-027）。
 * 非正文：不进消息历史，仅作为长思考期间的活性/进度信号；客户端可展示「思考中」反馈。
 */
export const reasoningDeltaEventDataSchema = z.object({
  messageId: z.string().min(1),
  text: z.string(),
});

/** done：Turn 终态已提交（§4.3） */
export const doneEventDataSchema = z.object({
  status: turnStatusSchema,
  messageId: z.string().optional(),
  isComplete: z.boolean(),
  lastSequence: z.number().int().positive(),
  contextVersion: z.string().optional(),
});

/** error：已持久化的错误诊断（§4.4） */
export const errorEventDataSchema = z.object({
  code: streamErrorCodeSchema,
  retryable: z.boolean(),
  message: z.string().min(1),
  lastSequence: z.number().int().positive(),
});

/** redacted：正文因来源删除/同意撤销/权限变化不再可见（§4.5） */
export const redactedEventDataSchema = z.object({
  targetEventId: z.string().min(1),
  visibilityRevision: z.number().int(),
  reasonCode: z.enum(["revoked", "deleted", "policy_changed"]),
  replacement: z.string().optional(),
});

// ============ UQ-01 向用户提问交互契约 (DSH-UQ-01 借鉴) ============

/** 单个选项 */
export const askUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** 提问意图 */
export const askUserQuestionIntentSchema = z.object({
  kind: z.enum(["plan-review", "choice", "confirmation"]),
  approve: z.string().optional(),
});

/** 单个问题 */
export const askUserQuestionItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(askUserQuestionOptionSchema).optional(),
  multiSelect: z.boolean().optional().default(false),
  intent: askUserQuestionIntentSchema.optional(),
});

/** user_question_required: SSE 下发问题交互请求 */
export const userQuestionRequiredEventDataSchema = z.object({
  turnId: z.string().min(1),
  step: z.number().int().positive().optional(),
  questions: z.array(askUserQuestionItemSchema).min(1),
  timeoutMs: z.number().int().positive().optional(),
});

/** 单个问题的回答 */
export const askUserQuestionAnswerItemSchema = z.object({
  id: z.string().min(1),
  selected: z.array(z.string()).default([]),
  custom: z.string().optional(),
});

/** user_question_answered: SSE 回复或状态同步 */
export const userQuestionAnsweredEventDataSchema = z.object({
  turnId: z.string().min(1),
  answers: z.array(askUserQuestionAnswerItemSchema),
});

/** 用户提交回答的请求体 (POST /v1/turns/:turnId/questions/answers) */
export const submitQuestionAnswersRequestSchema = z.object({
  answers: z.array(askUserQuestionAnswerItemSchema).min(1),
});

/** 用户提交回答的响应体 */
export const submitQuestionAnswersResponseSchema = z.object({
  turnId: z.string().min(1),
  accepted: z.boolean(),
  answers: z.array(askUserQuestionAnswerItemSchema),
});

// ============ PET-01 桌宠表现指令（契约预留） ============
// 表现层与 AI 大脑解耦：表情/动作/位移由事件驱动，Web 陪伴头像与桌面桌宠共用同一指令集。
// 设计依据：reference/Petra src/bridges/astrobot.ts（MIT，借鉴命令形态，自研字段）。

/** 桌宠表情枚举 */
export const petEmoteSchema = z.enum([
  "idle",
  "cheer",
  "think",
  "worry",
  "happy",
  "sad",
  "surprise",
]);

/** 桌宠肢体动作枚举 */
export const petGestureSchema = z.enum([
  "wave",
  "nod",
  "shake",
  "stretch",
  "yawn",
]);

/** 桌宠表现命令类型（与 Petra astrobot.ts 的命令族对齐） */
export const petCommandTypeSchema = z.enum(["speak", "emote", "gesture", "move", "react"]);

/** 单条表现命令 */
export const petCommandSchema = z.object({
  type: petCommandTypeSchema,
  /** emote 类型时的表情 */
  emote: petEmoteSchema.optional(),
  /** gesture 类型时的动作 */
  gesture: petGestureSchema.optional(),
  /** speak 类型时的文本 */
  text: z.string().optional(),
  /** move 类型时的位移（逻辑坐标，桌面端可用） */
  x: z.number().optional(),
  y: z.number().optional(),
});

/** emote：SSE 侧的表现指令事件负载（挂载于 turnStreamEventSchema.data） */
export const emoteEventDataSchema = petCommandSchema;

/** 创建 Turn 请求体最小字段（§2.1） */
export const toolApprovalModeSchema = z.enum(["ask", "full_access"]);

/** Turn 消息附件引用（多模态输入：附件先经 POST /v1/attachments 上传，再随消息引用） */
export const turnAttachmentRefSchema = z.object({
  attachmentId: z.string().min(1),
  name: z.string().min(1).optional(),
  mediaType: z.string().min(1).optional(),
});

export const createTurnRequestSchema = z.object({
  message: z.object({
    content: z.string().min(1),
    contentType: z.enum(["text", "markdown"]),
    /** 多模态输入：随消息发送的附件引用清单（CAP-012） */
    attachments: z.array(turnAttachmentRefSchema).optional(),
  }),
  clientVersion: z.string().min(1),
  /** Turn 级工具授权策略；full_access 仅预授权普通写工具，不放行 privileged。 */
  toolApprovalMode: toolApprovalModeSchema.default("ask"),
  references: z
    .array(
      z.object({
        sourceId: z.string().min(1),
        sourceVersion: z.string().min(1),
      }),
    )
    .optional(),
});

/** 创建 Turn 成功响应（§2.1） */
export const createTurnResponseSchema = z.object({
  turnId: z.string().min(1),
  status: z.literal("Created"),
  eventsUrl: z.string().min(1),
  cancelUrl: z.string().min(1),
});

/** 取消 Turn 响应（§2.3） */
export const cancelTurnResponseSchema = z.object({
  turnId: z.string().min(1),
  status: z.enum(["CancelRequested", "Cancelled"]),
});

/** 当前事件 payload 版本 */
export const STREAM_PAYLOAD_VERSION = 1;

/** 学习目标等级（与 packages/database src/schema/learning.ts 对齐） */
export const learningGoalLevelSchema = z.enum(["beginner", "intermediate", "advanced"]);
export const learningGoalStatusSchema = z.enum(["active", "paused", "completed", "archived"]);

/** 创建学习目标请求体（FR-LRN-001 / CAP-002） */
export const createLearningGoalSchema = z.object({
  topic: z.string().trim().min(1, "topic is required"),
  level: learningGoalLevelSchema.optional(),
  availableMinutes: z
    .number({ error: "availableMinutes must be a positive integer" })
    .int("availableMinutes must be a positive integer")
    .positive("availableMinutes must be a positive integer")
    .optional(),
});

/** 更新学习目标请求体；归档由 DELETE 路由统一处理。 */
export const updateLearningGoalSchema = z
  .object({
    topic: z.string().trim().min(1, "topic is required").optional(),
    level: learningGoalLevelSchema.optional(),
    availableMinutes: z
      .number({ error: "availableMinutes must be a positive integer" })
      .int("availableMinutes must be a positive integer")
      .positive("availableMinutes must be a positive integer")
      .optional(),
    status: z.enum(["active", "paused", "completed"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one field is required");

// ============ T-04 工具注册表 + AST-04 插件元数据 + PET-05 只读白名单 ============
// 设计依据：reference/baishou-next/packages/ai/src/tools/ ToolRegistry（MIT，借鉴开关注册模型，自研字段）
// 与 reference/AstrBot astrbot/core/tools/registry.py 条件门控形成 TS/Python 双参照。

/** 工具分类（对应记忆晋升候选链路各阶段） */
export const toolCategorySchema = z.enum([
  "memory", // 主动记忆工具（MemoryStoreTool）
  "search", // 检索工具
  "learning", // 学习/练习工具
  "diary", // 日记工具
  "system", // 系统工具
  "external", // 外部集成工具
]);

/** AST-04 工具配置条件门控操作符 */
export const toolGatingOperatorSchema = z.enum([
  "equals",
  "in",
  "truthy",
  "custom",
]);

/** AST-04 工具配置条件门控（参考 AstrBot registry.py 条件过滤） */
export const toolGatingConditionSchema = z.object({
  /** 门控字段名（如 "purpose"、"capability.level"） */
  field: z.string().min(1),
  operator: toolGatingOperatorSchema,
  /** 比较值（equals 为单值、in 为数组、truthy 忽略、custom 为函数标识） */
  value: z.unknown().optional(),
  /** custom 操作符时的求值函数标识（运行时注入） */
  evaluatorId: z.string().optional(),
});

/** PET-05 工具安全级别：readOnly 标记 AI 可自主调用，非只读需用户确认 */
export const toolSafetyLevelSchema = z.enum([
  "read_only", // AI 可自主调用（如检索、读取记忆）
  "write_with_approval", // 需用户确认（如存储记忆、修改学习目标）
  "privileged", // 仅管理员/系统可调用
]);

/** T-04 工具元数据（注册表条目核心） */
export const toolMetadataSchema = z.object({
  /** 工具唯一标识（如 "aervox_memory_store"） */
  toolId: z.string().min(1),
  /** 面向 AI 的工具名称（MCP 暴露名，如 "aervox_memory_store"） */
  name: z.string().min(1),
  description: z.string().min(1),
  category: toolCategorySchema,
  /** PET-05 安全级别，默认 write_with_approval（模型请求不等于授权） */
  safetyLevel: toolSafetyLevelSchema.default("write_with_approval"),
  /** 工具所需权限声明（对应 plugin_grants.permission） */
  requiredPermissions: z.array(z.string()).default([]),
  /** 输入参数 JSON Schema（MCP tool inputSchema） */
  inputSchema: z.unknown(),
  /** 是否为内置工具（内置不可卸载，插件工具可禁用） */
  builtin: z.boolean().default(false),
  /** 关联插件 ID（非内置时必填） */
  pluginId: z.string().optional(),
});

/** T-04 工具注册表条目（元数据 + 启用态 + 门控条件） */
export const toolRegistryEntrySchema = toolMetadataSchema.extend({
  /** 是否启用（disabledToolIds 对应项） */
  enabled: z.boolean().default(true),
  /** AST-04 按配置条件门控（为空时无条件启用） */
  gatingConditions: z.array(toolGatingConditionSchema).default([]),
  /** 注册顺序（用于工具列表排序） */
  priority: z.number().int().default(0),
});

/** T-04 工具注册表导出快照（面向 AI 运行时 / MCP server 导出） */
export const toolRegistryExportSchema = z.object({
  tools: z.array(toolRegistryEntrySchema),
  /** 全局禁用列表（补充 per-entry enabled=false） */
  disabledToolIds: z.array(z.string()).default([]),
  /** 导出版本（用于缓存失效） */
  exportVersion: z.number().int(),
});

/** T-04 MemoryStoreTool 输入参数（Agent 主动存储长期记忆） */
export const memoryStoreToolInputSchema = z.object({
  /** 记忆内容（自然语言） */
  content: z.string().min(1),
  /** PET-02 source 区分：ai_inferred 时默认 unverified 候选 */
  source: z.enum(["user_said", "ai_inferred"]).default("ai_inferred"),
  /** PET-02 category 分类 */
  category: z
    .enum(["identity", "preference", "habit", "schedule", "relationship", "event", "other"])
    .default("other"),
  /** 关键词（便于检索归类与记忆树投影） */
  keywords: z.array(z.string()).default([]),
  /** 关联会话/turn（溯源用） */
  sourceTurnId: z.string().optional(),
  /** 候选标记（ai_inferred 默认 true，user_said 默认 false） */
  asCandidate: z.boolean().optional(),
});

/** T-04 MemoryStoreTool 输出 */
export const memoryStoreToolOutputSchema = z.object({
  memoryId: z.string().min(1),
  /** 是否作为候选写入（unverified 状态） */
  isCandidate: z.boolean(),
  /** 去重命中已有记忆的 ID（向量/FTS 命中时） */
  deduplicatedMemoryId: z.string().optional(),
  /** 嵌入写入状态（如 embedding 服务不可用则降级为仅 FTS） */
  embeddingStatus: z.enum(["indexed", "skipped", "failed"]).optional(),
});

/** CAP-009 日记主行 DTO（GET /v1/diaries 响应；对齐 @aervox/database DiaryModel） */
export const diarySchema = z.object({
  id: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  autoGenerated: z.number().int(),
  title: z.string(),
  content: z.string(),
  version: z.number().int(),
  status: z.enum(["draft", "published", "edited", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** CAP-009 对话触发写日记工具（aervox_diary_write）输入 */
export const diaryWriteToolInputSchema = z.object({
  /** 用户希望日记额外强调的内容（如"重点写今天的数学练习"） */
  focus: z.string().max(500).optional(),
});

/** CAP-009 对话触发写日记工具输出 */
export const diaryWriteToolOutputSchema = z.object({
  diaryId: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string(),
  content: z.string(),
  /** created=新建当日日记；rewritten=当日已有日记，以改写版本落库 */
  mode: z.enum(["created", "rewritten"]),
  /** 参与生成的当日素材条数（消息 + 学习事件） */
  materialCount: z.number().int(),
  /** 生成方式：llm=模型生成；template=非 LLM 模式的确定性摘要（诚实降级） */
  generatedBy: z.enum(["llm", "template"]),
});

/** 日记历史回看列表响应（GET /v1/diaries?limit=） */
export const diaryListResponseSchema = z.object({
  items: z.array(diarySchema),
});

/** 每日按需生成/取回响应（POST /v1/diaries/generate-today） */
export const diaryGenerateTodayOutputSchema = z.object({
  diaryId: z.string().min(1),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string(),
  content: z.string(),
  /** existing=当日已有直接返回（幂等）；created=本次生成新建；rewritten=当日已有且本次改写 */
  mode: z.enum(["created", "rewritten", "existing"]),
  generatedBy: z.enum(["llm", "template"]),
  materialCount: z.number().int(),
});

/** PET-05 写工具审批待决事件负载（tool_approval_required；CR-024 补充公开契约） */
export const toolApprovalRequiredEventDataSchema = z.object({
  approvalId: z.string().min(1),
  toolName: z.string().min(1),
  argumentsHash: z.string().min(1),
});

/** AST-04 插件元数据模型（参考 AstrBot StarMetadata，自研字段） */
export const pluginMetadataSchema = z.object({
  /** 插件显示名称 */
  displayName: z.string().min(1),
  author: z.string().min(1),
  version: z.string().min(1),
  /** 仓库/来源 URL */
  repository: z.string().optional(),
  /** 平台声明（如 ["web", "desktop"]） */
  platforms: z.array(z.string()).default([]),
  /** 依赖版本范围（如 { "aervox-core": ">=1.0.0" }） */
  dependencies: z.record(z.string(), z.string()).default({}),
  /** i18n 文案 key→翻译映射 */
  i18n: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** 注册页面元数据（图标、描述、分类） */
  registryMeta: z
    .object({
      icon: z.string().optional(),
      tagline: z.string().optional(),
      category: z.string().optional(),
    })
    .optional(),
});

// ============ Codex Pets 兼容：9 状态 spritesheet 协议 ============
// 兼容对象：OpenAI Codex Pets（2026-05）标准精灵图集协议—— pet.json manifest +
// 8 列 × 9 行 atlas（每格 192×208），9 个固定动画状态，每态固定帧数。
// 本段仅表达协议结构（自研 schema），不含任何 OpenAI 素材/代码。

/** Codex Pets 9 个标准动画状态（行索引 0~8，固定顺序） */
export const petSheetStateSchema = z.enum([
  "idle", // 行 0：平静呼吸/眨眼，6 帧；第一帧为减少动态的静态姿势
  "running-right", // 行 1：向右移动，8 帧
  "running-left", // 行 2：向左移动（通常为 right 镜像），8 帧
  "waving", // 行 3：打招呼/引起注意，4 帧
  "jumping", // 行 4：跳跃（预备→起跳→顶点→落地→落定），5 帧
  "failed", // 行 5：失败/沮丧/泄气，8 帧
  "waiting", // 行 6：等待（待机变体），6 帧
  "running", // 行 7：工作进行中/推理循环（非跑步），6 帧
  "review", // 行 8：专注检查/思考，6 帧
]);

/** 每态帧数（行 → 实际使用的列数；尾部列为全透明） */
export const petSheetRowFramesSchema = z.partialRecord(
  petSheetStateSchema,
  z.number().int().min(1).max(8),
);

/** Codex Pets atlas 几何布局常量（协议固定值） */
export const petSheetLayoutSchema = z.object({
  columns: z.literal(8),
  rows: z.literal(9),
  cellWidth: z.literal(192),
  cellHeight: z.literal(208),
  atlasWidth: z.literal(1536),
  atlasHeight: z.literal(1872),
  /** 清单协议版本（1 = 8×9 基础版；2 = 另含 9-10 行注视方向，V1 客户端仍可用） */
  spriteVersionNumber: z.literal(1),
});

/** pet.json manifest（Codex Pets 自定义桌宠包必需字段） */
export const petManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  spritesheetPath: z.string().min(1),
  /** 缺省按布局配置 */
  layout: petSheetLayoutSchema,
  /** 每态帧数（缺省用协议默认表） */
  rowFrames: petSheetRowFramesSchema.optional(),
});

/** Aervox 侧 P0 协议默认帧数表（与 Codex Pets 固定值一致） */
export const DEFAULT_PET_SHEET_ROW_FRAMES: Record<
  z.infer<typeof petSheetStateSchema>,
  number
> = {
  idle: 6,
  "running-right": 8,
  "running-left": 8,
  waving: 4,
  jumping: 5,
  failed: 8,
  waiting: 6,
  running: 6,
  review: 6,
};

/** Codex Pets 状态 → PET-01 emote/gesture 建议映射（表现层消费时参考） */
export const petStateToCommandSchema = z.record(
  petSheetStateSchema,
  petCommandSchema,
);

// ============ CAP-020 Skill 能力（基础 + Neo 生命周期） ============
// 设计依据：reference/AstrBot astrbot/core/skills/skill_manager.py（SkillInfo/渐进式披露、
// payload→candidate→promote 生命周期）与 astrbot/core/tools/computer_tools/shipyard_neo/neo_skills.py。
// 借鉴协议形态、自研字段；AstrBot 沙盒「执行证据」适配为 Aervox 业务对象
// （turns / memory_records / learning_goals），语义见 docs/explanation/reference-design-transfer.md。

/** Skill 来源类型（来源决定可管理性与生命周期归属） */
export const skillSourceSchema = z.enum([
  "local", // 本地上传/安装（zip），可启停/删除
  "plugin", // 插件内置 skills/ 目录，只读、由插件生命周期管理
  "ai_authored", // Neo 生命周期晋升后落盘的 AI 自主技能，可启停/删除
]);

/** Skill 名称合法字符集（对应 Anthropic Skills 目录名规范：英文/数字/点/下划线/短横线） */
export const skillNameSchema = z
  .string()
  .min(1)
  .regex(/^[\w.-]+$/, "skill name must match [\\w.-]+");

/** Neo 生命周期发布阶段 */
export const skillStageSchema = z.enum(["canary", "stable"]);

/** Neo 技能候选状态机 */
export const skillCandidateStatusSchema = z.enum([
  "pending", // 已创建候选，待评估
  "evaluated", // 已评估（passed/failed）
  "promoted", // 已晋升为 release
  "rejected", // 评估未通过
]);

/** CAP-020 Skill 注册表元数据（DB 真源映射；内容本体在文件系统 data/skills/<name>/） */
export const skillMetadataSchema = z.object({
  /** 技能唯一标识（= skill_registrations.id，即目录名） */
  name: skillNameSchema,
  /** 面向 Agent 的简短描述（渐进式披露清单仅注入 name+description） */
  description: z.string().min(1),
  source: skillSourceSchema,
  /** 是否启用（disabled 对应 active=false） */
  active: z.boolean().default(true),
  /** 只读（插件内置 / 沙盒技能不可编辑删除） */
  readonly: z.boolean().default(false),
  version: z.string().default("1.0.0"),
  /** 内容校验和（zip 安装 / AI 落盘时记录） */
  checksum: z.string().optional(),
  /** 关联插件 ID（source=plugin 时必填） */
  pluginId: z.string().optional(),
  /** AST-04 条件门控（复用工具门控求值器） */
  gatingConditions: z.array(toolGatingConditionSchema).default([]),
  /** SKILL.md 落盘路径（运行时读取用） */
  contentPath: z.string().optional(),
});

/** 渐进式披露清单项：仅 name + description（对齐 AstrBot build_skills_prompt） */
export const skillDescriptorSchema = z.object({
  name: skillNameSchema,
  description: z.string(),
});

/** Skill 安装请求（zip 上传由 HTTP multipart 承载，此处表达元信息） */
export const skillInstallRequestSchema = z.object({
  /** 单技能 zip（根含 SKILL.md）时的名称提示；缺省用 zip 文件名 */
  name: skillNameSchema.optional(),
  /** 已存在同名技能时是否覆盖（缺省 false 冲突即报错） */
  overwrite: z.boolean().default(false),
});

// ---- Neo 生命周期：payload → candidate → evaluate → promote → release ----

/** 不可变技能内容载荷（skill_markdown + 结构化 metadata；只存内容，不直接写本地技能目录） */
export const skillPayloadSchema = z.object({
  /** 载荷引用标识（幂等键） */
  payloadRef: z.string().min(1),
  /** 载荷类型（如 "aervox_skill_v1"） */
  kind: z.string().default("aervox_skill_v1"),
  /** 载荷内容（典型：{ skill_markdown, inputs, outputs, meta }） */
  content: z.unknown(),
  /** 内容校验和（防篡改溯源） */
  checksum: z.string().optional(),
  createdAt: z.string().optional(),
});

/** 创建 payload 请求 */
export const skillPayloadCreateSchema = z.object({
  payload: z.unknown(),
  kind: z.string().default("aervox_skill_v1"),
});

/** 技能创作来源证据（AstrBot source_execution_ids 适配为 Aervox 业务对象） */
export const skillSourceEvidenceSchema = z.object({
  /** 关联对话轮次（创作依据） */
  turnIds: z.array(z.string()).default([]),
  /** 关联记忆记录 */
  memoryIds: z.array(z.string()).default([]),
  /** 关联学习目标 */
  learningItemIds: z.array(z.string()).default([]),
});

/** 技能候选（绑定来源证据 + 可选载荷） */
export const skillCandidateSchema = z.object({
  candidateId: z.string().min(1),
  /** 稳定逻辑标识（如 "image-collage-9grid"） */
  skillKey: z.string().min(1),
  /** 来源证据（Aervox 无沙盒，以 turns/memory/learning 为创作依据） */
  sourceEvidence: skillSourceEvidenceSchema,
  payloadRef: z.string().optional(),
  /** 候选分组命名空间 */
  scenarioKey: z.string().optional(),
  status: skillCandidateStatusSchema,
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

/** 创建候选请求 */
export const skillCandidateCreateSchema = z.object({
  skillKey: z.string().min(1),
  sourceEvidence: skillSourceEvidenceSchema.default({ turnIds: [], memoryIds: [], learningItemIds: [] }),
  payloadRef: z.string().optional(),
  scenarioKey: z.string().optional(),
});

/** 候选评估请求 */
export const skillEvaluationSchema = z.object({
  passed: z.boolean(),
  /** 0~100 评分（可选） */
  score: z.number().min(0).max(100).optional(),
  /** 评估报告（文本） */
  report: z.string().optional(),
});

/** 发布记录（release） */
export const skillReleaseSchema = z.object({
  releaseId: z.string().min(1),
  skillKey: z.string().min(1),
  stage: skillStageSchema,
  candidateId: z.string().min(1),
  payloadRef: z.string().optional(),
  /** 版本号（单调递增） */
  version: z.number().int().min(1),
  /** 是否为当前生效发布（同 skillKey 同 stage 仅一份 active） */
  active: z.boolean().default(true),
  /** stable 发布是否已同步到本地 SKILL.md */
  syncedToLocal: z.boolean().default(false),
  createdAt: z.string().optional(),
});

/** 晋升候选请求 */
export const skillPromoteRequestSchema = z.object({
  stage: skillStageSchema.default("canary"),
  /** stable 时是否同步 payload.skill_markdown 到本地 SKILL.md（缺省 true） */
  syncToLocal: z.boolean().default(true),
});

// ============ CAP-010 人格问卷与基础偏好（FR-PER-001/002/003）============

/** 语气选项 */
export const toneSchema = z.enum(["friendly", "neutral", "formal"]);
/** 主动程度选项 */
export const proactivenessSchema = z.enum(["low", "medium", "high"]);
/** 称呼选项 */
export const addressFormSchema = z.enum(["casual", "formal", "none"]);
/** 提醒节奏选项 */
export const reminderCadenceSchema = z.enum(["gentle", "moderate", "frequent"]);

/** 偏好问卷完整模型 */
export const personaPreferencesSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  tone: toneSchema,
  proactiveness: proactivenessSchema,
  addressForm: addressFormSchema,
  reminderCadence: reminderCadenceSchema,
  version: z.number().int().min(1),
  skipped: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 首次填写问卷请求体 */
export const savePersonaPreferencesSchema = z.object({
  tone: toneSchema.optional(),
  proactiveness: proactivenessSchema.optional(),
  addressForm: addressFormSchema.optional(),
  reminderCadence: reminderCadenceSchema.optional(),
  /** 跳过问卷（使用中性默认值） */
  skipped: z.boolean().optional(),
});

/** 更新偏好请求体（单项或多项） */
export const updatePersonaPreferencesSchema = z.object({
  tone: toneSchema.optional(),
  proactiveness: proactivenessSchema.optional(),
  addressForm: addressFormSchema.optional(),
  reminderCadence: reminderCadenceSchema.optional(),
});

// ============ CAP-013 消息编辑、删除与引用（FR-CONV-004/005、BR-CONV-003/004）============

/** 编辑消息请求体 */
export const editMessageSchema = z.object({
  content: z.string().min(1),
  /** 期望的当前版本号（CAS） */
  expectedVersion: z.number().int().min(1),
});

/** 消息版本模型 */
export const messageVersionSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().nullable().optional(),
  role: z.string(),
  version: z.number().int().min(1),
  content: z.string(),
  isRedacted: z.number(),
  supersededAt: z.string().nullable().optional(),
  createdAt: z.string(),
});

/** 消息模型（含版本和删除状态） */
export const messageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.string(),
  currentVersionId: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  createdAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});

/** 删除影响预览项 */
export const deleteImpactItemSchema = z.object({
  type: z.enum(["summary", "mistake", "review", "diary", "memory"]),
  id: z.string(),
  description: z.string(),
});

/** 删除影响预览响应 */
export const deleteImpactPreviewSchema = z.object({
  messageId: z.string(),
  impacts: z.array(deleteImpactItemSchema),
  totalAffected: z.number().int().min(0),
});

// ============ CAP-011 学习资料整理（FR-LRN-002/003、BR-LRN-001）============

/** 资料类型 */
export const materialTypeSchema = z.enum(["explanation", "mindmap", "exercises", "reading", "code"]);

/** 资料状态 */
export const materialStatusSchema = z.enum(["generating", "ready", "failed", "deleted"]);

/** 来源类型 */
export const sourceTypeSchema = z.enum(["model", "external"]);

/** 许可证状态 */
export const licenseStatusSchema = z.enum(["confirmed", "unconfirmed", "restricted"]);

/** 事实核验状态 */
export const verificationStatusSchema = z.enum(["verified", "needs_review", "unverifiable"]);

/** 生成资料请求体 */
export const createStudyMaterialSchema = z.object({
  goalId: z.string().optional(),
  type: materialTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  format: z.enum(["markdown", "json"]).default("markdown"),
  sources: z.array(z.object({
    sourceType: sourceTypeSchema,
    sourceUri: z.string().optional(),
    sourceTitle: z.string().optional(),
    licenseStatus: licenseStatusSchema.default("unconfirmed"),
    verificationStatus: verificationStatusSchema.default("needs_review"),
  })).default([]),
});

/** 编辑资料请求体 */
export const editStudyMaterialSchema = z.object({
  content: z.string().min(1),
  expectedVersion: z.number().int().min(1),
});

/** 导出格式 */
export const exportFormatSchema = z.enum(["json", "markdown"]);

// ============ CAP-012 多模态答疑（FR-EXT-001/002、BR-EXT-001/002） ============

/** 附件用途声明（FR-EXT-001；audio/file 为多模态输入扩展） */
export const attachmentPurposeSchema = z.enum([
  "question",
  "chart",
  "code_screenshot",
  "reading",
  "audio",
  "file",
]);

/** 允许的附件 MIME 类型（FR-EXT-001 AC-01；多模态输入扩展：音频与文档） */
export const allowedMediaTypesSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
]);

/** 最大附件大小（字节）— 10MB */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** 创建附件请求体（FR-EXT-001） */
export const createAttachmentSchema = z.object({
  objectKey: z.string().min(1),
  mediaType: allowedMediaTypesSchema,
  size: z.number().int().min(0).max(MAX_ATTACHMENT_SIZE),
  sourceLicense: z.string().optional(),
  purpose: attachmentPurposeSchema,
  idempotencyKey: z.string().optional(),
});

/** 触发解析请求体（FR-EXT-002） */
export const parseAttachmentSchema = z.object({
  idempotencyKey: z.string().optional(),
});

/** 裁剪解析结果请求体（FR-EXT-002 AC-01） */
export const cropParseResultSchema = z.object({
  cropData: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(1),
    height: z.number().min(1),
  }),
});

/** 转文字请求体（BR-EXT-001 AC-01：用户手动输入文本） */
export const convertToTextSchema = z.object({
  text: z.string().min(1),
});

/** OCR 置信度阈值（BR-EXT-001：低于此值标记 low_confidence） */
export const OCR_CONFIDENCE_THRESHOLD = 0.7;

// ============ CAP-007 / CAP-002 术语抽取与追问探索契约 ============

/** 抽取出来的单个术语 */
export const extractedTermSchema = z.object({
  text: z.string().min(1),
  relation: z.enum(["background", "related"]),
  description: z.string().optional(),
});

/** SSE terms_extracted 事件负载数据 */
export const termsExtractedEventDataSchema = z.object({
  turnId: z.string().min(1),
  messageId: z.string().optional(),
  terms: z.array(extractedTermSchema),
});

/** 追问探索方向类型 */
export const termExploreKindSchema = z.enum([
  "child",   // 深挖下钻（原理/前置细节）
  "related", // 对比发散（异同/应用场景）
  "branch",  // 分支对话（创建独立分支会话）
]);

/** 追问探索请求体 (POST /v1/terms/explore 或 POST /v1/hierarchy/explore) */
export const termExploreRequestSchema = z.object({
  term: z.string().min(1),
  kind: termExploreKindSchema.default("child"),
  context: z.string().optional(),
  sessionId: z.string().optional(),
});

/** 追问探索响应体 */
export const termExploreResponseSchema = z.object({
  term: z.string(),
  kind: termExploreKindSchema,
  content: z.string(),
  relatedQuestions: z.array(z.string()).default([]),
  childSessionId: z.string().optional(),
});

// ============ CAP-014 层级对话与会话地图 ============

/** 分支原因类型 */
export const branchReasonSchema = z.enum([
  "term_drill",
  "text_followup",
  "alternative_solution",
  "other",
]);

/** 创建分支请求体 */
export const createBranchSchema = z.object({
  childSessionId: z.string().min(1),
  forkAtMessageId: z.string().optional(),
  title: z.string().optional(),
  branchReason: branchReasonSchema.optional(),
});

/** 更新布局请求体 */
export const updateBranchLayoutSchema = z.object({
  layoutData: z.unknown(),
});

// ============ CAP-015 思维宇宙 ============

/** 知识关系类型 */
export const relationTypeSchema = z.enum([
  "prerequisite",
  "related",
  "contrast",
  "causal",
]);

/** 知识来源类型 */
export const knowledgeSourceSchema = z.enum([
  "user",
  "inference",
  "external",
  "system",
]);

/** 创建知识关系请求体 */
export const createKnowledgeRelationSchema = z.object({
  fromKnowledgeId: z.string().min(1),
  toKnowledgeId: z.string().min(1),
  relationType: relationTypeSchema,
  source: knowledgeSourceSchema.optional(),
  confidence: z.number().int().min(0).max(100).optional(),
});

/** 纠正知识关系请求体 */
export const correctRelationSchema = z.object({
  reason: z.string().min(1),
});

/** 合并知识关系请求体 */
export const mergeRelationsSchema = z.object({
  targetRelationId: z.string().min(1),
});

// ============ CAP-016 自适应刷题与报告 ============

/** 创建练习报告请求体 */
export const createPracticeReportSchema = z.object({
  sessionId: z.string().min(1),
  totalQuestions: z.number().int().min(0),
  correctCount: z.number().int().min(0),
  incorrectCount: z.number().int().min(0),
  avgTimeSpentSec: z.number().int().min(0).optional(),
  totalHintsUsed: z.number().int().min(0).optional(),
  masteryPrediction: z.number().min(0).max(1).optional(),
  biasAssessment: z.string().optional(),
  reportType: z.enum(["summary", "detailed"]).optional(),
});

export const practiceReportResponseSchema = z.object({
  id: z.string(), workspaceId: z.string(), subjectUserId: z.string(), sessionId: z.string(),
  totalQuestions: z.number().int(), correctCount: z.number().int(), incorrectCount: z.number().int(),
  avgTimeSpentSec: z.number().int().nullable().optional(), totalHintsUsed: z.number().int(),
  masteryPrediction: z.number().nullable().optional(), biasAssessment: z.string().nullable().optional(),
  reportType: z.string(), isReset: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export const practiceReportListResponseSchema = z.object({ items: z.array(practiceReportResponseSchema) });

// ============ 学习规划（OpenMAIC planner 单次结构化生成） ============

/** 生成学习规划请求体 */
export const generateLearningPlanSchema = z.object({
  topic: z.string().trim().min(1),
  level: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  dailyMinutes: z.number().int().min(5).max(600).optional(),
});

/** 更新规划任务状态请求体 */
export const updatePlanTaskStatusSchema = z.object({
  status: z.enum(["todo", "done"]),
});

export const planTaskResponseSchema = z.object({
  id: z.string(), workspaceId: z.string(), subjectUserId: z.string(), milestoneId: z.string(),
  order: z.number().int(), title: z.string(), description: z.string().nullable().optional(),
  hints: z.array(z.string()), status: z.string(), createdAt: z.string(), updatedAt: z.string(),
});

export const planMilestoneResponseSchema = z.object({
  id: z.string(), workspaceId: z.string(), subjectUserId: z.string(), planId: z.string(),
  order: z.number().int(), title: z.string(), description: z.string().nullable().optional(),
  briefing: z.string().nullable().optional(), completionCriteria: z.string().nullable().optional(),
  debrief: z.string().nullable().optional(), status: z.string(),
  tasks: z.array(planTaskResponseSchema), createdAt: z.string(), updatedAt: z.string(),
});

export const learningPlanResponseSchema = z.object({
  id: z.string(), workspaceId: z.string(), subjectUserId: z.string(), topic: z.string(), level: z.string(),
  title: z.string(), description: z.string(), learningObjective: z.string(), gains: z.array(z.string()),
  dailyAvailableMinutes: z.number().int(), status: z.string(),
  milestones: z.array(planMilestoneResponseSchema), createdAt: z.string(), updatedAt: z.string(),
});
export const learningPlanListResponseSchema = z.object({ items: z.array(learningPlanResponseSchema) });
