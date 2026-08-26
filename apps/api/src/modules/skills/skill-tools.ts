/**
 * Aervox｜思隅 @aervox/api — Skill 生命周期工具注册（CAP-020 / PET-05）
 *
 * 将 Neo 生命周期操作暴露为 aervox_skill_* 工具（进 tool_registrations），
 * 供 AI 运行时经 MCP 形态统一调用：
 * - read_only：list / get（AI 可自主调用）；
 * - write_with_approval：create / evaluate / promote / rollback / sync（需显式授权）。
 *
 * 规则依据：reference/AstrBot shipyard_neo/neo_skills.py 的 astrbot_skill_* 工具形态；
 * handler 在 ToolRuntime 存在时绑定，缺省仅登记元数据（运行时接线阶段生效）。
 */
import type { SqliteSkillRegistryRepository, SqliteToolRegistryRepository } from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import type { SkillLifecycleService } from "./lifecycle.js";

const CATEGORY = "system";

interface ToolSpec {
  id: string;
  name: string;
  description: string;
  safetyLevel: "read_only" | "write_with_approval";
  inputSchema: unknown;
}

const TOOLS: ToolSpec[] = [
  {
    id: "aervox_skill_create_payload",
    name: "aervox_skill_create_payload",
    description:
      "Step 1/3 技能创作：创建不可变技能内容载荷（skill_markdown + 结构化 metadata），返回 payloadRef；只存内容，不直接写本地技能目录。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: {
        payloadRef: { type: "string", description: "可选载荷引用（幂等键）" },
        kind: { type: "string", default: "aervox_skill_v1" },
        payload: { type: "object", description: "典型：{ skill_markdown, inputs, outputs, meta }" },
      },
      required: ["payload"],
    },
  },
  {
    id: "aervox_skill_get_payload",
    name: "aervox_skill_get_payload",
    description: "读取技能载荷内容（按 payloadRef）。",
    safetyLevel: "read_only",
    inputSchema: {
      type: "object",
      properties: { payloadRef: { type: "string" } },
      required: ["payloadRef"],
    },
  },
  {
    id: "aervox_skill_create_candidate",
    name: "aervox_skill_create_candidate",
    description:
      "Step 2/3 技能创作：创建候选——绑定创作来源证据（turns/memory/learning）与可选载荷，返回 candidateId。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: {
        skillKey: { type: "string", description: "稳定逻辑标识，如 review-notes" },
        sourceEvidence: {
          type: "object",
          properties: {
            turnIds: { type: "array", items: { type: "string" } },
            memoryIds: { type: "array", items: { type: "string" } },
            learningItemIds: { type: "array", items: { type: "string" } },
          },
        },
        payloadRef: { type: "string" },
        scenarioKey: { type: "string" },
      },
      required: ["skillKey"],
    },
  },
  {
    id: "aervox_skill_list_candidates",
    name: "aervox_skill_list_candidates",
    description: "列出技能候选（可按 skillKey / status 过滤）。",
    safetyLevel: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        skillKey: { type: "string" },
        status: { type: "string", enum: ["pending", "evaluated", "promoted", "rejected"] },
      },
    },
  },
  {
    id: "aervox_skill_evaluate_candidate",
    name: "aervox_skill_evaluate_candidate",
    description: "评估技能候选（passed=true → evaluated；false → rejected）。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        passed: { type: "boolean" },
        score: { type: "number", minimum: 0, maximum: 100 },
        report: { type: "string" },
      },
      required: ["candidateId", "passed"],
    },
  },
  {
    id: "aervox_skill_promote_candidate",
    name: "aervox_skill_promote_candidate",
    description:
      "Step 3/3 技能创作：晋升候选为 canary/stable 发布；stable + syncToLocal=true 时自动同步 payload.skill_markdown 到本地 SKILL.md。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string" },
        stage: { type: "string", enum: ["canary", "stable"], default: "canary" },
        syncToLocal: { type: "boolean", default: true },
      },
      required: ["candidateId"],
    },
  },
  {
    id: "aervox_skill_list_releases",
    name: "aervox_skill_list_releases",
    description: "列出技能发布（可按 skillKey / stage / activeOnly 过滤）。",
    safetyLevel: "read_only",
    inputSchema: {
      type: "object",
      properties: {
        skillKey: { type: "string" },
        stage: { type: "string", enum: ["canary", "stable"] },
        activeOnly: { type: "boolean", default: false },
      },
    },
  },
  {
    id: "aervox_skill_rollback_release",
    name: "aervox_skill_rollback_release",
    description: "回滚发布：取消目标发布，重新激活同技能同阶段最近历史发布（如有）。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: { releaseId: { type: "string" } },
      required: ["releaseId"],
    },
  },
  {
    id: "aervox_skill_sync_release",
    name: "aervox_skill_sync_release",
    description: "同步 stable 发布内容到本地 SKILL.md 并更新注册表（幂等）。",
    safetyLevel: "write_with_approval",
    inputSchema: {
      type: "object",
      properties: { releaseId: { type: "string" } },
      required: ["releaseId"],
    },
  },
];

/** 注册 aervox_skill_* 工具（幂等；ToolRuntime 存在时绑定 handler） */
export function registerSkillLifecycleTools(
  registry: SqliteToolRegistryRepository,
  lifecycle: SkillLifecycleService,
  runtime?: ToolRuntime,
): void {
  for (const tool of TOOLS) {
    void registry.registerTool({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: CATEGORY,
      safetyLevel: tool.safetyLevel,
      requiredPermissions: [],
      inputSchema: tool.inputSchema,
      builtin: true,
      gatingConditions: [],
      priority: 90,
    });

    if (!runtime) continue;
    runtime.registerHandler(tool.id, {
      call: async (_tenant, args) => {
        const a = (args ?? {}) as Record<string, unknown>;
        switch (tool.id) {
          case "aervox_skill_create_payload":
            return lifecycle.createPayload({
              payloadRef: a.payloadRef as string | undefined,
              kind: a.kind as string | undefined,
              payload: a.payload,
            });
          case "aervox_skill_get_payload":
            return lifecycle.getPayload(a.payloadRef as string);
          case "aervox_skill_create_candidate":
            return lifecycle.createCandidate({
              skillKey: a.skillKey as string,
              sourceEvidence: a.sourceEvidence as never,
              payloadRef: (a.payloadRef as string | null) ?? null,
              scenarioKey: (a.scenarioKey as string | null) ?? null,
            });
          case "aervox_skill_list_candidates":
            return { items: await lifecycle.listCandidates({
              skillKey: a.skillKey as string | undefined,
              status: a.status as string | undefined,
            }) };
          case "aervox_skill_evaluate_candidate":
            return lifecycle.evaluateCandidate(a.candidateId as string, {
              passed: a.passed as boolean,
              score: a.score as number | undefined,
              report: a.report as string | undefined,
            });
          case "aervox_skill_promote_candidate":
            return lifecycle.promoteCandidate(a.candidateId as string, {
              stage: a.stage as "canary" | "stable" | undefined,
              syncToLocal: a.syncToLocal as boolean | undefined,
            });
          case "aervox_skill_list_releases":
            return { items: await lifecycle.listReleases({
              skillKey: a.skillKey as string | undefined,
              stage: a.stage as string | undefined,
              activeOnly: a.activeOnly as boolean | undefined,
            }) };
          case "aervox_skill_rollback_release":
            return lifecycle.rollbackRelease(a.releaseId as string);
          case "aervox_skill_sync_release":
            return lifecycle.syncRelease(a.releaseId as string);
          default:
            throw new Error(`unknown skill tool: ${tool.id}`);
        }
      },
    });
  }
}
