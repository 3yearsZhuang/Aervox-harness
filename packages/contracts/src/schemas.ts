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

/** 公开业务 SSE 事件类型（§4） */
export const streamEventTypeSchema = z.enum([
  "message",
  "delta",
  "done",
  "error",
  "redacted",
  "emote",
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
export const createTurnRequestSchema = z.object({
  message: z.object({
    content: z.string().min(1),
    contentType: z.enum(["text", "markdown"]),
  }),
  clientVersion: z.string().min(1),
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
