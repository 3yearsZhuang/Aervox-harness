/**
 * Aervox｜思隅 @aervox/database — CAP-020 Skill 能力表（基础注册表 + Neo 生命周期）
 *
 * 规则依据：docs/explanation/reference-design-transfer.md（Skill 能力）与
 * reference/AstrBot astrbot/core/skills/skill_manager.py、neo_skills.py。
 *
 * 设计要点：
 * - skill_registrations 为系统级表（无租户列）：技能注册表真源，与 tool_registrations
 *   同构（source / active / readonly / gating）；内容本体在文件系统 data/skills/<name>/，
 *   content_path 记录落盘位置；
 * - skill_payloads / skill_candidates / skill_releases 承载 Neo 生命周期
 *   （payload → candidate → evaluate → promote → release），同为系统级；
 * - 同一 skillKey + stage 仅允许一份 active release（部分唯一索引，对齐 diary
 *   auto_generated 的既有模式）。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { timestampColumns } from "./common.js";

/** CAP-020 Skill 注册表（系统级，无租户列；内容本体在文件系统） */
export const skillRegistrations = sqliteTable(
  "skill_registrations",
  {
    /** 技能唯一标识（即目录名，约束见 contracts skillNameSchema） */
    id: text("id").primaryKey(),
    /** 面向 Agent 的显示名称 */
    name: text("name").notNull(),
    /** 简短描述（渐进式披露清单仅注入 name+description） */
    description: text("description").notNull(),
    /** 来源：local / plugin / ai_authored */
    source: text("source").notNull().default("local"),
    /** 是否启用（active=false 对应 disabled） */
    active: integer("active").notNull().default(1),
    /** 只读（插件内置不可编辑删除） */
    readonly: integer("readonly").notNull().default(0),
    version: text("version").notNull().default("1.0.0"),
    /** 内容校验和（zip 安装 / AI 落盘时记录） */
    checksum: text("checksum"),
    /** 关联插件 ID（source=plugin 时必填） */
    pluginId: text("plugin_id"),
    /** AST-04 条件门控（JSON 数组，运行时求值） */
    gatingConditionsJson: text("gating_conditions_json", { mode: "json" }),
    /** SKILL.md 落盘路径（运行时读取用） */
    contentPath: text("content_path"),
    /** 最近一次被引用时间（召回窗口淘汰用） */
    lastUsedAt: text("last_used_at"),
    ...timestampColumns,
  },
  (table) => ({
    sourceActiveIdx: index("skill_registrations_source_active_idx").on(
      table.source,
      table.active,
    ),
    pluginIdx: index("skill_registrations_plugin_idx").on(table.pluginId),
  }),
);

/** Neo 生命周期：不可变技能内容载荷 */
export const skillPayloads = sqliteTable(
  "skill_payloads",
  {
    /** 载荷引用标识（幂等键） */
    payloadRef: text("payload_ref").primaryKey(),
    /** 载荷类型（如 "aervox_skill_v1"） */
    kind: text("kind").notNull().default("aervox_skill_v1"),
    /** 载荷内容（典型：{ skill_markdown, inputs, outputs, meta }） */
    contentJson: text("content_json", { mode: "json" }).notNull(),
    /** 内容校验和（防篡改溯源） */
    checksum: text("checksum"),
    ...timestampColumns,
  },
);

/** Neo 生命周期：技能候选（绑定来源证据 + 可选载荷） */
export const skillCandidates = sqliteTable(
  "skill_candidates",
  {
    candidateId: text("candidate_id").primaryKey(),
    /** 稳定逻辑标识（如 "image-collage-9grid"） */
    skillKey: text("skill_key").notNull(),
    /** 来源证据（JSON：{ turnIds, memoryIds, learningItemIds }） */
    sourceEvidenceJson: text("source_evidence_json", { mode: "json" }).notNull(),
    payloadRef: text("payload_ref"),
    /** 候选分组命名空间 */
    scenarioKey: text("scenario_key"),
    /** 状态机：pending / evaluated / promoted / rejected */
    status: text("status").notNull().default("pending"),
    ...timestampColumns,
  },
  (table) => ({
    skillKeyStatusIdx: index("skill_candidates_skill_key_status_idx").on(
      table.skillKey,
      table.status,
    ),
  }),
);

/** Neo 生命周期：发布记录 */
export const skillReleases = sqliteTable(
  "skill_releases",
  {
    releaseId: text("release_id").primaryKey(),
    skillKey: text("skill_key").notNull(),
    /** 发布阶段：canary / stable */
    stage: text("stage").notNull(),
    candidateId: text("candidate_id").notNull(),
    payloadRef: text("payload_ref"),
    /** 版本号（同 skillKey + stage 单调递增） */
    version: integer("version").notNull(),
    /** 是否为当前生效发布（同 skillKey + stage 仅一份 active） */
    active: integer("active").notNull().default(1),
    /** stable 发布是否已同步到本地 SKILL.md */
    syncedToLocal: integer("synced_to_local").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    skillKeyStageVersionIdx: uniqueIndex("skill_releases_skill_stage_version_idx").on(
      table.skillKey,
      table.stage,
      table.version,
    ),
    // 同一 skillKey + stage 仅允许一份 active 发布（对齐 diary auto_generated 模式）
    skillKeyStageActiveIdx: uniqueIndex("skill_releases_skill_stage_active_idx")
      .on(table.skillKey, table.stage)
      .where(sql`${table.active} = 1`),
  }),
);
