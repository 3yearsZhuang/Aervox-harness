/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona 领域类型与校验
 */
import { createHash } from "node:crypto";
import type { TenantContext } from "@aervox/database";

export const PERSONA_SCHEMA_VERSION = 1;

export type PersonaSource = "builtin" | "user_created" | "imported";
export type PersonaStatus = "active" | "archived";

export interface VoiceSelection {
  enabled: boolean;
  providerId: string;
  modelId: string;
  speakerId?: string;
  settings?: Record<string, string | number | boolean>;
}

export interface PersonaRevisionConfig {
  systemPromptAppend: string;
  allowedSkillNames?: string[];
  allowedMcpToolIds?: string[];
  voice?: VoiceSelection;
}

export interface Persona {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  name: string;
  description: string;
  source: PersonaSource;
  status: PersonaStatus;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaRevision {
  id: string;
  personaId: string;
  revision: number;
  config: PersonaRevisionConfig;
  checksum: string;
  createdAt: string;
}

export interface ActivePersonaSelection {
  id?: string;
  workspaceId: string;
  subjectUserId: string;
  personaId: string;
  revisionId: string;
  selectedAt: string;
}

export interface PersonaContextSnapshot {
  personaId: string;
  revisionId: string;
  revisionChecksum: string;
  promptChecksum: string;
  skillChecksums: string[];
  mcpToolIds: string[];
  voice?: VoiceSelection;
  createdAt: string;
}

export interface PersonaBundleManifestSkill {
  name: string;
  version: number;
  checksum: string;
  source?: string;
  license?: string;
  exported: boolean;
}

export interface PersonaBundleManifest {
  schemaVersion: number;
  exportedAt: string;
  personaId: string;
  personaRevisionId: string;
  personaChecksum: string;
  skills: PersonaBundleManifestSkill[];
  missingDependencies: string[];
}

export interface PersonaBundleExportResult {
  bytes: Uint8Array;
  manifest: PersonaBundleManifest;
  skillNames: string[];
  missingDependencies: string[];
}

export interface PersonaBundleImportPreview {
  persona: Omit<Persona, "id" | "currentRevisionId" | "createdAt" | "updatedAt">;
  revision: Omit<PersonaRevision, "id" | "personaId" | "createdAt">;
  skills: Array<{ name: string; description: string; checksum: string; version: number }>;
  manifest: PersonaBundleManifest;
  missingDependencies: string[];
}

export interface CreatePersonaInput {
  name: string;
  description?: string;
  source?: PersonaSource;
  config: PersonaRevisionConfig;
}

export interface UpdatePersonaInput {
  personaId: string;
  expectedRevision: number;
  name?: string;
  description?: string;
  config: PersonaRevisionConfig;
}

export function assertNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

export function validatePersonaConfig(config: PersonaRevisionConfig): PersonaRevisionConfig {
  const systemPromptAppend = assertNonEmpty(config.systemPromptAppend, "systemPromptAppend");
  if (systemPromptAppend.length > 32_000) throw new Error("systemPromptAppend is too long");
  const normalizeList = (values: string[] | undefined, field: string): string[] | undefined => {
    if (values === undefined) return undefined;
    return [...new Set(values.map((value) => assertNonEmpty(value, field)))];
  };
  return {
    systemPromptAppend,
    ...(config.allowedSkillNames !== undefined
      ? { allowedSkillNames: normalizeList(config.allowedSkillNames, "allowedSkillNames") }
      : {}),
    ...(config.allowedMcpToolIds !== undefined
      ? { allowedMcpToolIds: normalizeList(config.allowedMcpToolIds, "allowedMcpToolIds") }
      : {}),
    ...(config.voice ? { voice: { ...config.voice } } : {}),
  };
}

export function computeRevisionChecksum(config: PersonaRevisionConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function createPersonaContextSnapshot(input: {
  persona: Persona;
  revision: PersonaRevision;
  skillChecksums: readonly string[];
  toolIds: readonly string[];
}): PersonaContextSnapshot {
  return {
    personaId: input.persona.id,
    revisionId: input.revision.id,
    revisionChecksum: input.revision.checksum,
    promptChecksum: createHash("sha256")
      .update(input.revision.config.systemPromptAppend)
      .digest("hex"),
    skillChecksums: [...input.skillChecksums],
    mcpToolIds: [...input.toolIds],
    ...(input.revision.config.voice ? { voice: { ...input.revision.config.voice } } : {}),
    createdAt: new Date().toISOString(),
  };
}
