/**
 * Aervox｜思隅 @aervox/database — 统一来源链 + 记忆版本/证据/事件 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（SourceArtifact/SourceRevision/MemoryRevision/MemoryEvidence/MemoryEvent）
 * 不变量：来源删除后保留 tombstone，MemoryEvidence 不随来源级联删除。
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  sourceArtifacts,
  sourceRevisions,
  memoryRevisions,
  memoryEvidence,
  memoryEvents,
  memoryRecords,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IProvenanceRepository,
  SourceArtifactModel,
  SourceRevisionModel,
  MemoryRevisionModel,
  MemoryEvidenceModel,
  MemoryEventModel,
} from "../types.js";

export class SqliteProvenanceRepository implements IProvenanceRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createSourceArtifact(
    tenant: TenantContext,
    artifactData: { id: string; kind: string; ownerModule: string; occurredAt: string; ingestedAt: string },
  ): Promise<SourceArtifactModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(sourceArtifacts)
      .values({
        id: artifactData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        kind: artifactData.kind,
        ownerModule: artifactData.ownerModule,
        occurredAt: artifactData.occurredAt,
        ingestedAt: artifactData.ingestedAt,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SourceArtifactModel;
  }

  async getSourceArtifact(tenant: TenantContext, id: string): Promise<SourceArtifactModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(sourceArtifacts)
      .where(
        and(
          eq(sourceArtifacts.id, id),
          eq(sourceArtifacts.workspaceId, tenant.workspaceId),
          eq(sourceArtifacts.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as SourceArtifactModel) ?? null;
  }

  async appendSourceRevision(
    tenant: TenantContext,
    artifactId: string,
    revisionData: { id: string; checksum: string; content?: string | null },
  ): Promise<SourceRevisionModel> {
    assertTenantContext(tenant);
    const artifact = await this.getSourceArtifact(tenant, artifactId);
    if (!artifact) throw new Error(`Source artifact ${artifactId} not found in tenant`);
    const [created] = await this.db
      .insert(sourceRevisions)
      .values({
        id: revisionData.id,
        artifactId,
        checksum: revisionData.checksum,
        content: revisionData.content ?? null,
        version: 1,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as SourceRevisionModel;
  }

  async setCurrentRevision(
    tenant: TenantContext,
    artifactId: string,
    revisionId: string,
  ): Promise<SourceArtifactModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(sourceArtifacts)
      .set({ currentRevisionId: revisionId, updatedAt: now })
      .where(
        and(
          eq(sourceArtifacts.id, artifactId),
          eq(sourceArtifacts.workspaceId, tenant.workspaceId),
          eq(sourceArtifacts.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as SourceArtifactModel) ?? null;
  }

  async appendMemoryRevision(
    tenant: TenantContext,
    revisionData: {
      id: string;
      memoryId: string;
      content: string;
      confidence?: number;
      importance?: number;
      algorithmVersion?: string | null;
    },
  ): Promise<MemoryRevisionModel> {
    assertTenantContext(tenant);
    // 记忆必须属于当前租户
    const [memory] = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.id, revisionData.memoryId),
          eq(memoryRecords.workspaceId, tenant.workspaceId),
          eq(memoryRecords.subjectUserId, tenant.subjectUserId),
        ),
      );
    if (!memory) throw new Error(`Memory ${revisionData.memoryId} not found in tenant`);
    const [created] = await this.db
      .insert(memoryRevisions)
      .values({
        id: revisionData.id,
        memoryId: revisionData.memoryId,
        content: revisionData.content,
        confidence: revisionData.confidence ?? 0,
        importance: revisionData.importance ?? 0,
        algorithmVersion: revisionData.algorithmVersion ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MemoryRevisionModel;
  }

  async setMemoryCurrentRevision(
    tenant: TenantContext,
    memoryId: string,
    revisionId: string,
  ): Promise<boolean> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(memoryRecords)
      .set({ currentRevisionId: revisionId, updatedAt: now })
      .where(
        and(
          eq(memoryRecords.id, memoryId),
          eq(memoryRecords.workspaceId, tenant.workspaceId),
          eq(memoryRecords.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return !!updated;
  }

  async listMemoryRevisions(tenant: TenantContext, memoryId: string): Promise<MemoryRevisionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({ rev: memoryRevisions })
      .from(memoryRevisions)
      .innerJoin(memoryRecords, eq(memoryRevisions.memoryId, memoryRecords.id))
      .where(
        and(
          eq(memoryRevisions.memoryId, memoryId),
          eq(memoryRecords.workspaceId, tenant.workspaceId),
          eq(memoryRecords.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(memoryRevisions.createdAt);
    return rows.map((r) => r.rev) as MemoryRevisionModel[];
  }

  async createMemoryEvidence(
    tenant: TenantContext,
    evidenceData: {
      id: string;
      memoryRevisionId: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      sourceRange?: string | null;
    },
  ): Promise<MemoryEvidenceModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(memoryEvidence)
      .values({
        id: evidenceData.id,
        memoryRevisionId: evidenceData.memoryRevisionId,
        sourceArtifactId: evidenceData.sourceArtifactId,
        sourceRevisionId: evidenceData.sourceRevisionId,
        sourceRange: evidenceData.sourceRange ?? null,
        status: "active",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MemoryEvidenceModel;
  }

  async recordMemoryEvent(
    tenant: TenantContext,
    eventData: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<MemoryEventModel> {
    assertTenantContext(tenant);
    const [memory] = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.id, eventData.memoryId),
          eq(memoryRecords.workspaceId, tenant.workspaceId),
          eq(memoryRecords.subjectUserId, tenant.subjectUserId),
        ),
      );
    if (!memory) throw new Error(`Memory ${eventData.memoryId} not found in tenant`);
    const [created] = await this.db
      .insert(memoryEvents)
      .values({
        id: eventData.id,
        memoryId: eventData.memoryId,
        action: eventData.action,
        fromTier: eventData.fromTier ?? null,
        toTier: eventData.toTier ?? null,
        reason: eventData.reason ?? null,
        actorType: eventData.actorType ?? "system",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MemoryEventModel;
  }

  async listMemoryEvents(tenant: TenantContext, memoryId: string): Promise<MemoryEventModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({ ev: memoryEvents })
      .from(memoryEvents)
      .innerJoin(memoryRecords, eq(memoryEvents.memoryId, memoryRecords.id))
      .where(
        and(
          eq(memoryEvents.memoryId, memoryId),
          eq(memoryRecords.workspaceId, tenant.workspaceId),
          eq(memoryRecords.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(memoryEvents.createdAt));
    return rows.map((r) => r.ev) as MemoryEventModel[];
  }
}
