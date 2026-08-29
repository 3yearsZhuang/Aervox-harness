/**
 * Aervox｜思隅 @aervox/api — 系统级 Persona 领域服务
 */
import { createHash } from "node:crypto";
import type {
  ActivePersonaSelectionModel,
  PersonaModel,
  PersonaRevisionModel,
  PersonaTurnContextModel,
  PersonaSwitchLogModel,
  PersonaMemoryScopeModel,
  SkillRegistrationModel,
  SqlitePersonaRepository,
  TenantContext,
} from "@aervox/database";
import type { SkillManager } from "../skills/skill-manager.js";
import type { ToolRuntime } from "../tools/runtime.js";
import type { VoiceService } from "../voice/service.js";
import {
  exportPersonaBundle,
  importPersonaBundle,
  previewPersonaBundle,
} from "./bundle.js";
import {
  assertNonEmpty,
  computeRevisionChecksum,
  createPersonaContextSnapshot,
  validatePersonaConfig,
  type ActivePersonaSelection,
  type CreatePersonaInput,
  type Persona,
  type PersonaBundleExportResult,
  type PersonaBundleImportPreview,
  type PersonaContextSnapshot,
  type PersonaRevision,
  type PersonaSource,
  type PersonaSwitchLog,
  type PersonaMemoryScope,
  type UpdatePersonaInput,
  type PersonaReviewStatus,
  type MemoryPolicy,
} from "./types.js";

function personaToDomain(model: PersonaModel): Persona {
  return {
    id: model.id,
    workspaceId: model.workspaceId,
    subjectUserId: model.subjectUserId,
    name: model.name,
    description: model.description,
    source: model.source as PersonaSource,
    status: model.status as Persona["status"],
    reviewStatus: model.reviewStatus as Persona["reviewStatus"],
    reviewNotes: model.reviewNotes,
    reviewedAt: model.reviewedAt ?? null,
    currentRevisionId: model.currentRevisionId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function revisionToDomain(model: PersonaRevisionModel): PersonaRevision {
  return {
    id: model.id,
    personaId: model.personaId,
    revision: model.revision,
    config: model.config as PersonaRevision["config"],
    checksum: model.checksum,
    createdAt: model.createdAt,
  };
}

function selectionToDomain(model: ActivePersonaSelectionModel): ActivePersonaSelection {
  return {
    id: model.id,
    workspaceId: model.workspaceId,
    subjectUserId: model.subjectUserId,
    personaId: model.personaId,
    revisionId: model.revisionId,
    selectedAt: model.selectedAt,
  };
}

export interface PersonaServiceDeps {
  personaRepo: SqlitePersonaRepository;
  skillManager?: SkillManager;
  toolRuntime?: ToolRuntime;
  voiceService?: VoiceService;
}

export class PersonaService {
  constructor(private readonly deps: PersonaServiceDeps) {}

  async listPersonas(tenant: TenantContext): Promise<Persona[]> {
    const list = await this.deps.personaRepo.listPersonas(tenant);
    return list.map(personaToDomain);
  }

  async getPersona(
    tenant: TenantContext,
    personaId: string,
  ): Promise<{ persona: Persona; revision: PersonaRevision | null; active: boolean } | null> {
    const persona = await this.deps.personaRepo.getPersona(tenant, personaId);
    if (!persona) return null;
    const domainPersona = personaToDomain(persona);
    const revision = await this.deps.personaRepo.getPersonaRevision(
      tenant,
      persona.id,
      persona.currentRevisionId,
    );
    const activeSelection = await this.deps.personaRepo.getActivePersona(tenant);
    const active = activeSelection?.personaId === persona.id;
    return {
      persona: domainPersona,
      revision: revision ? revisionToDomain(revision) : null,
      active,
    };
  }

  async getPersonaRevision(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<PersonaRevision | null> {
    const model = await this.deps.personaRepo.getPersonaRevision(tenant, personaId, revisionId);
    return model ? revisionToDomain(model) : null;
  }

  async createPersona(
    tenant: TenantContext,
    input: CreatePersonaInput,
  ): Promise<{ persona: Persona; revision: PersonaRevision }> {
    const name = assertNonEmpty(input.name, "name");
    const normalizedConfig = validatePersonaConfig(input.config);
    const checksum = computeRevisionChecksum(normalizedConfig);
    const personaId = `persona_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const created = await this.deps.personaRepo.createPersona(tenant, {
      id: personaId,
      name,
      description: input.description?.trim() ?? "",
      source: input.source ?? "user_created",
      config: normalizedConfig,
      checksum,
    });

    return {
      persona: personaToDomain(created.persona),
      revision: revisionToDomain(created.revision),
    };
  }

  async updatePersona(
    tenant: TenantContext,
    input: UpdatePersonaInput,
  ): Promise<{ persona: Persona; revision: PersonaRevision } | null> {
    const normalizedConfig = validatePersonaConfig(input.config);
    const checksum = computeRevisionChecksum(normalizedConfig);

    const updated = await this.deps.personaRepo.updatePersona(tenant, {
      personaId: input.personaId,
      expectedRevision: input.expectedRevision,
      name: input.name,
      description: input.description,
      config: normalizedConfig,
      checksum,
    });

    if (!updated) return null;

    return {
      persona: personaToDomain(updated.persona),
      revision: revisionToDomain(updated.revision),
    };
  }

  async deletePersona(tenant: TenantContext, personaId: string): Promise<boolean> {
    return this.deps.personaRepo.deletePersona(tenant, personaId);
  }

  async activatePersona(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelection | null> {
    const selected = await this.deps.personaRepo.activatePersona(tenant, personaId, revisionId);
    return selected ? selectionToDomain(selected) : null;
  }

  async getActivePersona(tenant: TenantContext): Promise<ActivePersonaSelection | null> {
    const active = await this.deps.personaRepo.getActivePersona(tenant);
    return active ? selectionToDomain(active) : null;
  }

  /**
   * 当前激活人格的提示词摘要（名称 + systemPromptAppend + 技能白名单）。
   * 供对话系统提示词做「人格覆盖默认身份/设定」使用；无激活人格或记录缺失时返回 undefined。
   */
  async describeActivePersonaSummary(
    tenant: TenantContext,
  ): Promise<{ name?: string; prompt?: string; allowedSkillNames?: string[] } | undefined> {
    const active = await this.getActivePersona(tenant);
    if (!active) return undefined;
    const personaRecord = await this.deps.personaRepo.getPersona(tenant, active.personaId);
    const revisionRecord = await this.deps.personaRepo.getPersonaRevision(
      tenant,
      active.personaId,
      active.revisionId,
    );
    if (!personaRecord || !revisionRecord) return undefined;
    const persona = personaToDomain(personaRecord);
    const revision = revisionToDomain(revisionRecord);
    const allowed = revision.config.allowedSkillNames;
    return {
      name: persona.name,
      prompt: revision.config.systemPromptAppend.trim() || undefined,
      ...(Array.isArray(allowed) && allowed.length > 0
        ? { allowedSkillNames: allowed }
        : {}),
    };
  }

  async saveTurnContext(
    tenant: TenantContext,
    context: PersonaContextSnapshot & { id?: string; turnId: string },
  ): Promise<PersonaTurnContextModel> {
    return this.deps.personaRepo.saveTurnContext(tenant, {
      id: context.id ?? `ptc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: tenant.workspaceId,
      subjectUserId: tenant.subjectUserId,
      turnId: context.turnId,
      personaId: context.personaId,
      revisionId: context.revisionId,
      revisionChecksum: context.revisionChecksum,
      promptChecksum: context.promptChecksum,
      skillChecksums: context.skillChecksums,
      mcpToolIds: context.mcpToolIds,
      voice: context.voice,
      createdAt: context.createdAt,
    });
  }

  async getTurnContext(
    tenant: TenantContext,
    turnId: string,
  ): Promise<PersonaTurnContextModel | null> {
    return this.deps.personaRepo.getTurnContext(tenant, turnId);
  }

  async composeSystemPrompt(
    tenant: TenantContext,
    coreSystemPrompt: string,
    safetyPolicyPrompt: string,
  ): Promise<{
    systemPrompt: string;
    persona?: Persona;
    revision?: PersonaRevision;
    contextVersion: string;
  }> {
    const active = await this.getActivePersona(tenant);
    if (!active) {
      const basePrompt = [
        "<core-system-instructions>",
        coreSystemPrompt.trim(),
        "</core-system-instructions>",
        "<non-overridable-safety-and-data-policy>",
        safetyPolicyPrompt.trim(),
        "</non-overridable-safety-and-data-policy>",
      ].join("\n\n");
      return {
        systemPrompt: basePrompt,
        contextVersion: createHash("sha256").update(basePrompt).digest("hex"),
      };
    }

    const personaRecord = await this.deps.personaRepo.getPersona(tenant, active.personaId);
    const revisionRecord = await this.deps.personaRepo.getPersonaRevision(
      tenant,
      active.personaId,
      active.revisionId,
    );

    if (!personaRecord || !revisionRecord) {
      const basePrompt = [
        "<core-system-instructions>",
        coreSystemPrompt.trim(),
        "</core-system-instructions>",
        "<non-overridable-safety-and-data-policy>",
        safetyPolicyPrompt.trim(),
        "</non-overridable-safety-and-data-policy>",
      ].join("\n\n");
      return {
        systemPrompt: basePrompt,
        contextVersion: createHash("sha256").update(basePrompt).digest("hex"),
      };
    }

    const persona = personaToDomain(personaRecord);
    const revision = revisionToDomain(revisionRecord);

    const skillsPrompt = this.deps.skillManager
      ? await this.deps.skillManager.buildPrompt(revision.config.allowedSkillNames)
      : "";

    const sections = [
      "<core-system-instructions>",
      coreSystemPrompt.trim(),
      "</core-system-instructions>",
      "<persona-instructions>",
      revision.config.systemPromptAppend.trim(),
      "</persona-instructions>",
    ];

    if (skillsPrompt) {
      sections.push("<available-skills>", skillsPrompt, "</available-skills>");
    }

    sections.push(
      "<non-overridable-safety-and-data-policy>",
      safetyPolicyPrompt.trim(),
      "</non-overridable-safety-and-data-policy>",
    );

    const systemPrompt = sections.join("\n\n");
    const contextVersion = createHash("sha256").update(systemPrompt).digest("hex");

    return {
      systemPrompt,
      persona,
      revision,
      contextVersion,
    };
  }

  async exportBundle(tenant: TenantContext, personaId: string): Promise<PersonaBundleExportResult> {
    const personaRecord = await this.deps.personaRepo.getPersona(tenant, personaId);
    if (!personaRecord) throw new Error("Persona not found");
    const revisionRecord = await this.deps.personaRepo.getPersonaRevision(
      tenant,
      personaId,
      personaRecord.currentRevisionId,
    );
    if (!revisionRecord) throw new Error("Persona revision is missing");

    if (!this.deps.skillManager) {
      throw new Error("SkillManager is not available for bundle export");
    }

    const availableTools = this.deps.toolRuntime
      ? (await this.deps.toolRuntime.listTools()).map((t) => t.id)
      : [];
    const availableVoiceProviders = this.deps.voiceService
      ? this.deps.voiceService.listProviderIds()
      : [];

    return exportPersonaBundle({
      persona: personaToDomain(personaRecord),
      revision: revisionToDomain(revisionRecord),
      skillManager: this.deps.skillManager,
      availableToolIds: availableTools,
      availableVoiceProviderIds: availableVoiceProviders,
    });
  }

  previewBundle(bytes: Uint8Array, workspaceId: string): PersonaBundleImportPreview {
    return previewPersonaBundle(bytes, workspaceId);
  }

  async importBundle(
    tenant: TenantContext,
    bytes: Uint8Array,
    conflictResolution: "error" | "replace" = "error",
  ): Promise<{
    persona: Persona;
    revision: PersonaRevision;
    skills: SkillRegistrationModel[];
    missingDependencies: string[];
  }> {
    if (!this.deps.skillManager) {
      throw new Error("SkillManager is not available for bundle import");
    }
    return importPersonaBundle({
      bytes,
      tenant,
      personaRepo: this.deps.personaRepo,
      skillManager: this.deps.skillManager,
      conflictResolution,
    });
  }

  // ---- CAP-019: 模板审核、回滚、切换历史、记忆范围 ----

  async reviewPersona(
    tenant: TenantContext,
    personaId: string,
    reviewStatus: "pending_review" | "approved" | "rejected",
    reviewNotes?: string,
  ): Promise<Persona | null> {
    const updated = await this.deps.personaRepo.reviewPersona(
      tenant,
      personaId,
      reviewStatus,
      reviewNotes,
    );
    return updated ? personaToDomain(updated) : null;
  }

  async rollbackPersona(
    tenant: TenantContext,
    personaId: string,
    revisionId: string,
    regressionNotes?: string,
  ): Promise<{ persona: Persona; revision: PersonaRevision } | null> {
    const result = await this.deps.personaRepo.rollbackPersona(tenant, personaId, revisionId);
    if (!result) return null;

    // 记录回滚切换日志
    const active = await this.getActivePersona(tenant);
    await this.deps.personaRepo.recordSwitchLog(tenant, {
      personaId,
      revisionId,
      previousPersonaId: active?.personaId ?? personaId,
      previousRevisionId: active?.revisionId ?? null,
      switchReason: "rollback",
      regressionNotes: regressionNotes ?? null,
    });

    // 如果当前激活的就是这个人格，更新激活选择到回滚后的修订
    if (active?.personaId === personaId) {
      await this.deps.personaRepo.activatePersona(tenant, personaId, revisionId);
    }

    return {
      persona: personaToDomain(result.persona),
      revision: revisionToDomain(result.revision),
    };
  }

  async getSwitchHistory(
    tenant: TenantContext,
    personaId?: string,
  ): Promise<PersonaSwitchLog[]> {
    const logs = await this.deps.personaRepo.getSwitchHistory(tenant, personaId);
    return logs.map((log) => ({
      id: log.id,
      personaId: log.personaId,
      revisionId: log.revisionId,
      previousPersonaId: log.previousPersonaId,
      previousRevisionId: log.previousRevisionId,
      switchReason: log.switchReason as PersonaSwitchLog["switchReason"],
      regressionNotes: log.regressionNotes,
      switchedAt: log.switchedAt,
    }));
  }

  async getMemoryScope(
    tenant: TenantContext,
    personaId: string,
  ): Promise<PersonaMemoryScope | null> {
    const scope = await this.deps.personaRepo.getMemoryScope(tenant, personaId);
    if (!scope) {
      // 默认隔离
      return {
        personaId,
        memoryPolicy: "isolated",
        sharedPersonaIds: [],
        sharedCategories: [],
        confirmedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      personaId: scope.personaId,
      memoryPolicy: scope.memoryPolicy as MemoryPolicy,
      sharedPersonaIds: scope.sharedPersonaIds,
      sharedCategories: scope.sharedCategories,
      confirmedAt: scope.confirmedAt,
      createdAt: scope.createdAt,
      updatedAt: scope.updatedAt,
    };
  }

  async updateMemoryScope(
    tenant: TenantContext,
    personaId: string,
    data: {
      memoryPolicy: MemoryPolicy;
      sharedPersonaIds?: string[];
      sharedCategories?: string[];
      confirmed?: boolean;
    },
  ): Promise<PersonaMemoryScope> {
    const confirmedAt = data.confirmed ? new Date().toISOString() : null;
    const scope = await this.deps.personaRepo.upsertMemoryScope(tenant, personaId, {
      memoryPolicy: data.memoryPolicy,
      sharedPersonaIds: data.sharedPersonaIds,
      sharedCategories: data.sharedCategories,
      confirmedAt,
    });
    return {
      personaId: scope.personaId,
      memoryPolicy: scope.memoryPolicy as MemoryPolicy,
      sharedPersonaIds: scope.sharedPersonaIds,
      sharedCategories: scope.sharedCategories,
      confirmedAt: scope.confirmedAt,
      createdAt: scope.createdAt,
      updatedAt: scope.updatedAt,
    };
  }

  async listPersonaRevisions(
    tenant: TenantContext,
    personaId: string,
  ): Promise<PersonaRevision[]> {
    const revisions = await this.deps.personaRepo.listPersonaRevisions(tenant, personaId);
    return revisions.map(revisionToDomain);
  }
}
