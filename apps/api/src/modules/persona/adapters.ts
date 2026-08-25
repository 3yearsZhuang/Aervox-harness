/**
 * Aervox｜思隅 @aervox/api — SQLite 仓储 → @aervox/mod-persona Port 适配器
 *
 * 主仓 @aervox/database 拥有表与仓储；模块定义领域 Port（PersonaRepository /
 * SkillRepository / McpToolRepository）。适配器做模型映射，让人格领域编排保留在模块内。
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  ActivePersonaSelectionModel,
  IMcpToolRepository,
  IPersonaRepository,
  ISkillRepository,
  McpToolModel,
  PersonaModel,
  PersonaRevisionModel,
  SkillModel,
  TenantContext,
} from "@aervox/database";
import type {
  ActivePersonaSelection,
  McpTool,
  McpToolRepository,
  Persona,
  PersonaRepository,
  PersonaRevision,
  SkillRecord,
  SkillRepository,
} from "@aervox/mod-persona";

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function tenantOf(workspaceId: string, subjectUserId: string): TenantContext {
  return { workspaceId, subjectUserId };
}

function personaToDomain(model: PersonaModel): Persona {
  return {
    id: model.id,
    workspaceId: model.workspaceId,
    subjectUserId: model.subjectUserId,
    name: model.name,
    description: model.description,
    source: model.source as Persona["source"],
    status: model.status as Persona["status"],
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
    workspaceId: model.workspaceId,
    subjectUserId: model.subjectUserId,
    personaId: model.personaId,
    revisionId: model.revisionId,
    selectedAt: model.selectedAt,
  };
}

function skillToDomain(model: SkillModel): SkillRecord {
  const files: Record<string, Uint8Array> = {};
  for (const [path, base64] of Object.entries(model.filesJson)) files[path] = fromBase64(base64);
  return {
    id: model.id,
    workspaceId: model.workspaceId,
    name: model.name,
    description: model.description,
    ...(model.license ? { license: model.license } : {}),
    ...(model.compatibility ? { compatibility: model.compatibility } : {}),
    ...(model.metadata ? { metadata: model.metadata as Record<string, unknown> } : {}),
    ...(model.allowedTools ? { allowedTools: model.allowedTools as string[] } : {}),
    source: model.source as SkillRecord["source"],
    version: model.version,
    checksum: model.checksum,
    enabled: model.enabled === 1,
    valid: model.valid === 1,
    validationErrors: model.validationErrors,
    files,
    skillMarkdown: model.skillMarkdown,
    importedAt: model.importedAt,
  };
}

function skillToModel(skill: SkillRecord, tenant: TenantContext): SkillModel {
  const filesJson: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(skill.files)) filesJson[path] = asBase64(bytes);
  return {
    id: skill.id,
    workspaceId: tenant.workspaceId,
    subjectUserId: tenant.subjectUserId,
    name: skill.name,
    description: skill.description,
    ...(skill.license ? { license: skill.license } : {}),
    ...(skill.compatibility ? { compatibility: skill.compatibility } : {}),
    ...(skill.metadata ? { metadata: skill.metadata } : {}),
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
    source: skill.source,
    version: skill.version,
    checksum: skill.checksum,
    enabled: skill.enabled ? 1 : 0,
    valid: skill.valid ? 1 : 0,
    validationErrors: skill.validationErrors,
    filesJson,
    skillMarkdown: skill.skillMarkdown,
    importedAt: skill.importedAt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mcpToDomain(model: McpToolModel): McpTool {
  return {
    id: model.id,
    serverId: model.serverId,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    inputSchema: model.inputSchema ?? {},
    scopes: model.scopes,
    healthy: model.healthy === 1,
    authorized: model.authorized === 1,
    revoked: model.revoked === 1,
    killSwitch: model.killSwitch === 1,
  };
}

function mcpToModel(tool: McpTool, tenant: TenantContext): McpToolModel {
  return {
    id: tool.id,
    workspaceId: tenant.workspaceId,
    subjectUserId: tenant.subjectUserId,
    serverId: tool.serverId,
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema,
    scopes: tool.scopes,
    healthy: tool.healthy ? 1 : 0,
    authorized: tool.authorized ? 1 : 0,
    revoked: tool.revoked ? 1 : 0,
    killSwitch: tool.killSwitch ? 1 : 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function configChecksum(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

/** PersonaRepository Port ← SqlitePersonaRepository */
export class SqlitePersonaRepositoryAdapter implements PersonaRepository {
  constructor(private readonly inner: IPersonaRepository) {}

  async list(workspaceId: string, subjectUserId: string): Promise<Persona[]> {
    return (await this.inner.listPersonas(tenantOf(workspaceId, subjectUserId))).map(personaToDomain);
  }

  async get(workspaceId: string, subjectUserId: string, personaId: string): Promise<Persona | undefined> {
    const model = await this.inner.getPersona(tenantOf(workspaceId, subjectUserId), personaId);
    return model ? personaToDomain(model) : undefined;
  }

  async getRevision(personaId: string, revisionId?: string): Promise<PersonaRevision | undefined> {
    const model = await this.inner.getPersonaRevisionById(personaId, revisionId);
    return model ? revisionToDomain(model) : undefined;
  }

  async create(input: {
    workspaceId: string;
    subjectUserId: string;
    name: string;
    description?: string;
    source?: string;
    config: PersonaRevision["config"];
  }): Promise<{ persona: Persona; revision: PersonaRevision }> {
    const { persona, revision } = await this.inner.createPersona(tenantOf(input.workspaceId, input.subjectUserId), {
      id: `persona_${randomUUID()}`,
      name: input.name,
      description: input.description,
      source: input.source,
      config: input.config,
      checksum: configChecksum(input.config),
    });
    return { persona: personaToDomain(persona), revision: revisionToDomain(revision) };
  }

  async update(input: {
    workspaceId: string;
    subjectUserId: string;
    personaId: string;
    expectedRevision: number;
    name?: string;
    description?: string;
    config: PersonaRevision["config"];
  }): Promise<{ persona: Persona; revision: PersonaRevision } | undefined> {
    const updated = await this.inner.updatePersona(tenantOf(input.workspaceId, input.subjectUserId), {
      personaId: input.personaId,
      expectedRevision: input.expectedRevision,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      config: input.config,
      checksum: configChecksum(input.config),
    });
    if (!updated) return undefined;
    return { persona: personaToDomain(updated.persona), revision: revisionToDomain(updated.revision) };
  }

  async delete(workspaceId: string, subjectUserId: string, personaId: string): Promise<boolean> {
    return this.inner.deletePersona(tenantOf(workspaceId, subjectUserId), personaId);
  }

  async activate(
    workspaceId: string,
    subjectUserId: string,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelection | undefined> {
    const model = await this.inner.activatePersona(tenantOf(workspaceId, subjectUserId), personaId, revisionId);
    return model ? selectionToDomain(model) : undefined;
  }

  async active(workspaceId: string, subjectUserId: string): Promise<ActivePersonaSelection | undefined> {
    const model = await this.inner.getActivePersona(tenantOf(workspaceId, subjectUserId));
    return model ? selectionToDomain(model) : undefined;
  }
}

/** SkillRepository Port ← SqliteSkillRepository */
export class SqliteSkillRepositoryAdapter implements SkillRepository {
  constructor(private readonly inner: ISkillRepository) {}

  async list(workspaceId: string, subjectUserId: string): Promise<SkillRecord[]> {
    return (await this.inner.listSkills(tenantOf(workspaceId, subjectUserId))).map(skillToDomain);
  }

  async get(workspaceId: string, subjectUserId: string, name: string): Promise<SkillRecord | undefined> {
    const model = await this.inner.getSkill(tenantOf(workspaceId, subjectUserId), name);
    return model ? skillToDomain(model) : undefined;
  }

  async upsert(workspaceId: string, subjectUserId: string, skill: SkillRecord): Promise<SkillRecord> {
    const model = await this.inner.upsertSkill(tenantOf(workspaceId, subjectUserId), skillToModel(skill, tenantOf(workspaceId, subjectUserId)));
    return skillToDomain(model);
  }

  async setEnabled(workspaceId: string, subjectUserId: string, name: string, enabled: boolean): Promise<SkillRecord | undefined> {
    const model = await this.inner.setSkillEnabled(tenantOf(workspaceId, subjectUserId), name, enabled);
    return model ? skillToDomain(model) : undefined;
  }

  async delete(workspaceId: string, subjectUserId: string, name: string): Promise<boolean> {
    return this.inner.deleteSkill(tenantOf(workspaceId, subjectUserId), name);
  }
}

/** McpToolRepository Port ← SqliteMcpToolRepository */
export class SqliteMcpToolRepositoryAdapter implements McpToolRepository {
  constructor(private readonly inner: IMcpToolRepository) {}

  async list(workspaceId: string, subjectUserId: string): Promise<McpTool[]> {
    return (await this.inner.listMcpTools(tenantOf(workspaceId, subjectUserId))).map(mcpToDomain);
  }

  async upsert(workspaceId: string, subjectUserId: string, tool: McpTool): Promise<McpTool> {
    const model = await this.inner.upsertMcpTool(tenantOf(workspaceId, subjectUserId), mcpToModel(tool, tenantOf(workspaceId, subjectUserId)));
    return mcpToDomain(model);
  }

  async setRevoked(workspaceId: string, subjectUserId: string, id: string, revoked: boolean): Promise<McpTool | undefined> {
    const model = await this.inner.setMcpToolRevoked(tenantOf(workspaceId, subjectUserId), id, revoked);
    return model ? mcpToDomain(model) : undefined;
  }

  async setKillSwitch(workspaceId: string, subjectUserId: string, id: string, killSwitch: boolean): Promise<McpTool | undefined> {
    const model = await this.inner.setMcpToolKillSwitch(tenantOf(workspaceId, subjectUserId), id, killSwitch);
    return model ? mcpToDomain(model) : undefined;
  }
}
