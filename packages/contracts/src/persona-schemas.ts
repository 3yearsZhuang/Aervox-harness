import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const personaSourceSchema = z.enum(["builtin", "user_created", "imported"]);
export const personaStatusSchema = z.enum(["active", "archived"]);
export const voiceSelectionSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const personaRevisionConfigSchema = z.object({
  systemPromptAppend: z.string().min(1).max(32_000),
  allowedSkillNames: z.array(z.string().min(1)).optional(),
  allowedMcpToolIds: z.array(z.string().min(1)).optional(),
  voice: voiceSelectionSchema.optional(),
});
export const personaSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: personaSourceSchema,
  status: personaStatusSchema,
  currentRevisionId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const personaRevisionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revision: z.number().int().positive(),
  config: personaRevisionConfigSchema,
  checksum: z.string().length(64),
  createdAt: z.iso.datetime(),
});
export const activePersonaSelectionSchema = z.object({
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  personaId: z.string().min(1),
  revisionId: z.string().min(1),
  selectedAt: z.iso.datetime(),
});
export const skillSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
  source: z.enum(["active", "workspace", "imported"]),
  version: z.number().int().positive(),
  checksum: z.string().length(64),
  enabled: z.boolean(),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  importedAt: z.iso.datetime(),
});
export const mcpToolSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown(),
  scopes: z.array(z.string()),
  healthy: z.boolean(),
  authorized: z.boolean(),
  revoked: z.boolean(),
  killSwitch: z.boolean(),
});
export const voiceSynthesisRequestSchema = z.object({
  providerId: z.string().min(1),
  text: z.string().min(1).max(20_000),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const voiceSynthesisResponseSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  contentType: z.string().min(1),
  audioBase64: z.string().min(1),
});

export const voiceModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  speakerIds: z.array(z.string()),
  available: z.boolean(),
  source: z.enum(["local", "remote"]),
});

export const createPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const updatePersonaRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const activatePersonaRequestSchema = z.object({ revisionId: z.string().min(1).optional() });
export const importPersonaRequestSchema = z.object({
  bundleBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const importSkillsRequestSchema = z.object({
  zipBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const exportSkillsRequestSchema = z.object({ names: z.array(z.string().min(1)).optional() });

export const personaBundleResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
  missingDependencies: z.array(z.string()),
});
export const skillZipResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
});
