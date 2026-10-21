import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";

/** The local registry's wire representation, including its integer flags and nullable columns. */
export const skillRegistrationResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: z.string(),
  active: z.union([z.literal(0), z.literal(1)]),
  readonly: z.union([z.literal(0), z.literal(1)]),
  version: z.string(),
  checksum: z.string().nullable().optional(),
  pluginId: z.string().nullable().optional(),
  gatingConditionsJson: z.unknown().optional(),
  contentPath: z.string().nullable().optional(),
  lastUsedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const skillListResponseSchema = z.object({ items: z.array(skillRegistrationResponseSchema) });
export const skillContentResponseSchema = z.object({ name: z.string(), description: z.string(), content: z.string() });
export const skillPromptResponseSchema = z.object({ prompt: z.string() });
export const installSkillZipRequestSchema = z.object({
  zipBase64: z.string().min(1),
  // The manager normalizes whitespace and validates the target directory before touching files.
  name: z.string().optional(),
  overwrite: z.boolean().optional(),
});
export const skillInstallResponseSchema = z.object({ installed: z.array(skillRegistrationResponseSchema) });
const skillParamsSchema = z.object({ skillName: z.string().min(1) });

export const skillsApi = {
  list: {
    method: "get", path: "/v1/skills", operationId: "get_v1_skills",
    summary: "列出本地技能注册", tags: ["Skills"],
    query: z.object({ activeOnly: z.string().optional(), source: z.string().optional() }),
    response: skillListResponseSchema, errors: { 400: "Invalid query" },
  },
  install: {
    method: "post", path: "/v1/skills", operationId: "post_v1_skills",
    summary: "安装单个或多个技能 ZIP", tags: ["Skills"],
    body: installSkillZipRequestSchema, bodyRequired: true,
    response: skillInstallResponseSchema, status: 201,
    validationErrorMessage: "Invalid skill installation request",
    errors: { 400: "Invalid skill installation request or archive", 409: "Skill or directory ownership conflict" },
  },
  prompt: {
    method: "get", path: "/v1/skills/prompt", operationId: "get_v1_skills_prompt",
    summary: "读取启用技能的渐进式披露提示词", tags: ["Skills"], response: skillPromptResponseSchema,
  },
  get: {
    method: "get", path: "/v1/skills/{skillName}", operationId: "get_v1_skills_skillName",
    summary: "读取技能注册元数据", tags: ["Skills"], params: skillParamsSchema,
    response: skillRegistrationResponseSchema, errors: { 400: "Invalid params", 404: "Skill not found" },
  },
  content: {
    method: "get", path: "/v1/skills/{skillName}/content", operationId: "get_v1_skills_skillName_content",
    summary: "读取技能 SKILL.md 内容", tags: ["Skills"], params: skillParamsSchema,
    response: skillContentResponseSchema, errors: { 400: "Invalid params", 404: "Skill not found" },
  },
  setActive: {
    method: "patch", path: "/v1/skills/{skillName}", operationId: "patch_v1_skills_skillName",
    summary: "启用或停用技能", tags: ["Skills"], params: skillParamsSchema,
    body: z.object({ active: z.boolean() }), bodyRequired: true, response: skillRegistrationResponseSchema,
    validationErrorMessage: "active is required", errors: { 400: "active is required", 404: "Skill not found" },
  },
  delete: {
    method: "delete", path: "/v1/skills/{skillName}", operationId: "delete_v1_skills_skillName",
    summary: "删除本地可写技能", tags: ["Skills"], params: skillParamsSchema,
    response: z.void(), status: 204, errors: { 400: "Invalid params", 409: "Skill not found, readonly or ownership conflict" },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type SkillRegistrationResponse = z.output<typeof skillRegistrationResponseSchema>;
export type SkillInstallResponse = z.output<typeof skillInstallResponseSchema>;
export type InstallSkillZipRequest = z.input<typeof installSkillZipRequestSchema>;
