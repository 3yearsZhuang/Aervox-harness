/**
 * Aervox｜思隅 @aervox/database — Persona/修订/激活/上下文快照 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 + docs/reference/DATABASE.md §14
 * 修订采用乐观锁 CAS（expectedRevision）；激活按租户 upsert；删除为归档。
 */
import { eq, and, desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AervoxDatabase } from "../../client.js";
import {
  personas,
  personaRevisions,
  personaSelections,
  personaTurnContexts,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ActivePersonaSelectionModel,
  IPersonaRepository,
  PersonaModel,
  PersonaRevisionModel,
  PersonaTurnContextModel,
} from "../types.js";

export class SqlitePersonaRepository implements IPersonaRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async listPersonas(tenant: TenantContext): Promise<PersonaModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.workspaceId, tenant.workspaceId),
          eq(personas.subjectUserId, tenant.subjectUserId),
          eq(personas.status, "active"),
        ),
      )
      .orderBy(ascPersonaName());
    return rows as PersonaModel[];
  }

  async getPersona(tenant: TenantContext, personaId: string): Promise<PersonaModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(personas)
      .where(
        and(
          eq(personas.id, personaId),
          eq(personas.workspaceId, tenant.workspaceId),
          eq(personas.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (row as PersonaModel) ?? null;
  }

  async listPersonaRevisions(tenant: TenantContext, personaId: string): Promise<PersonaRevisionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(personaRevisions)
      .where(
        and(
          eq(personaRevisions.personaId, personaId),
          sql`${personaRevisions.personaId} IN (SELECT id FROM personas WHERE workspace_id = ${tenant.workspaceId} AND subject_user_id = ${tenant.subjectUserId})`,
        ),
      )
      .orderBy(desc(personaRevisions.revision));
    return rows as PersonaRevisionModel[];
  }

  async getPersonaRevision(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<PersonaRevisionModel | null> {
    assertTenantContext(tenant);
    const revisions = await this.listPersonaRevisions(tenant, personaId);
    if (revisionId) return revisions.find((r) => r.id === revisionId) ?? null;
    return revisions[0] ?? null;
  }

  async getPersonaRevisionById(personaId: string, revisionId?: string): Promise<PersonaRevisionModel | null> {
    if (revisionId) {
      const [row] = await this.db
        .select()
        .from(personaRevisions)
        .where(and(eq(personaRevisions.personaId, personaId), eq(personaRevisions.id, revisionId)));
      return (row as PersonaRevisionModel) ?? null;
    }
    const rows = await this.db
      .select()
      .from(personaRevisions)
      .where(eq(personaRevisions.personaId, personaId))
      .orderBy(desc(personaRevisions.revision));
    return (rows[0] as PersonaRevisionModel) ?? null;
  }

  async createPersona(
    tenant: TenantContext,
    data: {
      id: string;
      name: string;
      description?: string;
      source?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const revisionId = `personarev_${randomUUID()}`;
      // 先插入 persona（revision 外键依赖 persona），再插入首个修订
      const [persona] = await tx
        .insert(personas)
        .values({
          id: data.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          name: data.name,
          description: data.description ?? "",
          source: data.source ?? "user_created",
          status: "active",
          currentRevisionId: revisionId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const [revision] = await tx
        .insert(personaRevisions)
        .values({
          id: revisionId,
          personaId: data.id,
          revision: 1,
          config: data.config,
          checksum: data.checksum,
          createdAt: now,
        })
        .returning();
      return { persona: persona as PersonaModel, revision: revision as PersonaRevisionModel };
    });
  }

  async updatePersona(
    tenant: TenantContext,
    data: {
      personaId: string;
      expectedRevision: number;
      name?: string;
      description?: string;
      config: unknown;
      checksum: string;
    },
  ): Promise<{ persona: PersonaModel; revision: PersonaRevisionModel } | null> {
    assertTenantContext(tenant);
    const existing = await this.getPersona(tenant, data.personaId);
    if (!existing) return null;
    const currentRevision = await this.getPersonaRevision(tenant, data.personaId);
    if (!currentRevision || currentRevision.revision !== data.expectedRevision) {
      throw new Error("PERSONA_REVISION_CONFLICT");
    }
    const now = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      const revisionId = `personarev_${randomUUID()}`;
      const [revision] = await tx
        .insert(personaRevisions)
        .values({
          id: revisionId,
          personaId: data.personaId,
          revision: data.expectedRevision + 1,
          config: data.config,
          checksum: data.checksum,
          createdAt: now,
        })
        .returning();
      const [persona] = await tx
        .update(personas)
        .set({
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          currentRevisionId: revisionId,
          updatedAt: now,
        })
        .where(
          and(
            eq(personas.id, data.personaId),
            eq(personas.workspaceId, tenant.workspaceId),
            eq(personas.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return { persona: persona as PersonaModel, revision: revision as PersonaRevisionModel };
    });
  }

  async deletePersona(tenant: TenantContext, personaId: string): Promise<boolean> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(personas)
      .set({ status: "archived", updatedAt: now })
      .where(
        and(
          eq(personas.id, personaId),
          eq(personas.workspaceId, tenant.workspaceId),
          eq(personas.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    if (!updated) return false;
    // 归档当前激活选择
    await this.db
      .delete(personaSelections)
      .where(
        and(
          eq(personaSelections.workspaceId, tenant.workspaceId),
          eq(personaSelections.subjectUserId, tenant.subjectUserId),
          eq(personaSelections.personaId, personaId),
        ),
      );
    return true;
  }

  async activatePersona(
    tenant: TenantContext,
    personaId: string,
    revisionId?: string,
  ): Promise<ActivePersonaSelectionModel | null> {
    assertTenantContext(tenant);
    const persona = await this.getPersona(tenant, personaId);
    if (!persona || persona.status !== "active") return null;
    const revision = await this.getPersonaRevision(tenant, personaId, revisionId ?? persona.currentRevisionId);
    if (!revision) return null;
    const now = new Date().toISOString();
    const id = `personaselect_${randomUUID()}`;
    const existing = await this.getActivePersona(tenant);
    if (existing) {
      const [updated] = await this.db
        .update(personaSelections)
        .set({ personaId, revisionId: revision.id, selectedAt: now, updatedAt: now })
        .where(eq(personaSelections.id, existing.id))
        .returning();
      return (updated as ActivePersonaSelectionModel) ?? null;
    }
    const [created] = await this.db
      .insert(personaSelections)
      .values({
        id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        personaId,
        revisionId: revision.id,
        selectedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return (created as ActivePersonaSelectionModel) ?? null;
  }

  async getActivePersona(tenant: TenantContext): Promise<ActivePersonaSelectionModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(personaSelections)
      .where(
        and(
          eq(personaSelections.workspaceId, tenant.workspaceId),
          eq(personaSelections.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (row as ActivePersonaSelectionModel) ?? null;
  }

  async saveTurnContext(
    tenant: TenantContext,
    context: PersonaTurnContextModel,
  ): Promise<PersonaTurnContextModel> {
    assertTenantContext(tenant);
    const now = context.createdAt ?? new Date().toISOString();
    const [row] = await this.db
      .insert(personaTurnContexts)
      .values({
        id: context.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        turnId: context.turnId,
        personaId: context.personaId,
        revisionId: context.revisionId,
        revisionChecksum: context.revisionChecksum,
        promptChecksum: context.promptChecksum,
        skillChecksums: context.skillChecksums,
        mcpToolIds: context.mcpToolIds,
        voice: context.voice ?? null,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [personaTurnContexts.workspaceId, personaTurnContexts.subjectUserId, personaTurnContexts.turnId],
        set: {
          personaId: context.personaId,
          revisionId: context.revisionId,
          revisionChecksum: context.revisionChecksum,
          promptChecksum: context.promptChecksum,
          skillChecksums: context.skillChecksums,
          mcpToolIds: context.mcpToolIds,
          voice: context.voice ?? null,
        },
      })
      .returning();
    return row as PersonaTurnContextModel;
  }

  async getTurnContext(tenant: TenantContext, turnId: string): Promise<PersonaTurnContextModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(personaTurnContexts)
      .where(
        and(
          eq(personaTurnContexts.turnId, turnId),
          eq(personaTurnContexts.workspaceId, tenant.workspaceId),
          eq(personaTurnContexts.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (row as PersonaTurnContextModel) ?? null;
  }
}

/** SQLite 无内置自然排序；按名称排序 */
function ascPersonaName() {
  return sql`name ASC`;
}
