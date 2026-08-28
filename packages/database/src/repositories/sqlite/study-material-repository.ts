/**
 * Aervox｜思隅 @aervox/database — 学习资料 SQLite 仓储实现（CAP-011）
 *
 * 覆盖：FR-LRN-002（资料生成）、FR-LRN-003（编辑/导出）、BR-LRN-001（事实核验/版权/删除传播）
 */
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  studyMaterials,
  materialVersions,
  materialSources,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IStudyMaterialRepository,
  StudyMaterialModel,
  MaterialVersionModel,
  MaterialSourceModel,
} from "../types.js";

export class SqliteStudyMaterialRepository implements IStudyMaterialRepository {
  constructor(private readonly db: AervoxDatabase) {}

  // ============ 资料身份 ============

  async create(
    tenant: TenantContext,
    input: {
      id: string;
      goalId?: string;
      type: string;
      title: string;
      idempotencyKey?: string;
    },
  ): Promise<StudyMaterialModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(studyMaterials)
      .values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        goalId: input.goalId ?? null,
        type: input.type,
        title: input.title,
        status: "generating",
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as StudyMaterialModel;
  }

  async get(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(studyMaterials)
      .where(
        and(
          eq(studyMaterials.id, id),
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
          isNull(studyMaterials.deletedAt),
        ),
      )
      .limit(1);
    return (found as StudyMaterialModel) ?? null;
  }

  async listByGoal(tenant: TenantContext, goalId: string): Promise<StudyMaterialModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(studyMaterials)
      .where(
        and(
          eq(studyMaterials.goalId, goalId),
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
          isNull(studyMaterials.deletedAt),
        ),
      )
      .orderBy(desc(studyMaterials.createdAt));
    return rows as StudyMaterialModel[];
  }

  async listByTenant(tenant: TenantContext): Promise<StudyMaterialModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(studyMaterials)
      .where(
        and(
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
          isNull(studyMaterials.deletedAt),
        ),
      )
      .orderBy(desc(studyMaterials.createdAt));
    return rows as StudyMaterialModel[];
  }

  async updateStatus(
    tenant: TenantContext,
    id: string,
    status: string,
  ): Promise<StudyMaterialModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(studyMaterials)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(studyMaterials.id, id),
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as StudyMaterialModel) ?? null;
  }

  async softDelete(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(studyMaterials)
      .set({ deletedAt: now, status: "deleted", updatedAt: now })
      .where(
        and(
          eq(studyMaterials.id, id),
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
          isNull(studyMaterials.deletedAt),
        ),
      )
      .returning();
    return (updated as StudyMaterialModel) ?? null;
  }

  async getByIdempotencyKey(
    tenant: TenantContext,
    key: string,
  ): Promise<StudyMaterialModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(studyMaterials)
      .where(
        and(
          eq(studyMaterials.idempotencyKey, key),
          eq(studyMaterials.workspaceId, tenant.workspaceId),
          eq(studyMaterials.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as StudyMaterialModel) ?? null;
  }

  // ============ 资料版本 ============

  async createVersion(
    tenant: TenantContext,
    input: {
      id: string;
      materialId: string;
      content: string;
      format?: string;
      author?: string;
    },
  ): Promise<MaterialVersionModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    // 查找当前最大版本号
    const existing = await this.listVersions(tenant, input.materialId);
    const maxVersion = existing.length > 0 ? Math.max(...existing.map((v) => v.version)) : 0;

    const [created] = await this.db
      .insert(materialVersions)
      .values({
        id: input.id,
        materialId: input.materialId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        version: maxVersion + 1,
        content: input.content,
        format: input.format ?? "markdown",
        author: input.author ?? "model",
        createdAt: now,
      })
      .returning();

    // 更新 study_materials.currentVersionId 和 status
    await this.db
      .update(studyMaterials)
      .set({ currentVersionId: input.id, status: "ready", updatedAt: now })
      .where(eq(studyMaterials.id, input.materialId));

    return created as MaterialVersionModel;
  }

  async getVersion(tenant: TenantContext, versionId: string): Promise<MaterialVersionModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(materialVersions)
      .where(
        and(
          eq(materialVersions.id, versionId),
          eq(materialVersions.workspaceId, tenant.workspaceId),
          eq(materialVersions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as MaterialVersionModel) ?? null;
  }

  async listVersions(tenant: TenantContext, materialId: string): Promise<MaterialVersionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(materialVersions)
      .where(
        and(
          eq(materialVersions.materialId, materialId),
          eq(materialVersions.workspaceId, tenant.workspaceId),
          eq(materialVersions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(materialVersions.version));
    return rows as MaterialVersionModel[];
  }

  async editVersion(
    tenant: TenantContext,
    materialId: string,
    content: string,
    expectedVersion: number,
  ): Promise<MaterialVersionModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    // 获取当前活跃版本
    const versions = await this.listVersions(tenant, materialId);
    const activeVersions = versions.filter((v) => !v.supersededAt);
    if (activeVersions.length === 0) return null;
    const currentVersion = activeVersions[0]!;
    if (currentVersion.version !== expectedVersion) return null;

    // 标记旧版本 supersededAt
    await this.db
      .update(materialVersions)
      .set({ supersededAt: now })
      .where(eq(materialVersions.id, currentVersion.id));

    // 创建新版本
    const newVersionId = `mv_mat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const [newVersion] = await this.db
      .insert(materialVersions)
      .values({
        id: newVersionId,
        materialId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        version: expectedVersion + 1,
        content,
        format: currentVersion.format,
        author: "user",
        createdAt: now,
      })
      .returning();

    // 更新 currentVersionId
    await this.db
      .update(studyMaterials)
      .set({ currentVersionId: newVersionId, updatedAt: now })
      .where(eq(studyMaterials.id, materialId));

    return newVersion as MaterialVersionModel;
  }

  // ============ 引用来源 ============

  async addSource(
    tenant: TenantContext,
    input: {
      id: string;
      materialVersionId: string;
      sourceType: string;
      sourceUri?: string;
      sourceTitle?: string;
      licenseStatus?: string;
      verificationStatus?: string;
    },
  ): Promise<MaterialSourceModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(materialSources)
      .values({
        id: input.id,
        materialVersionId: input.materialVersionId,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sourceType: input.sourceType,
        sourceUri: input.sourceUri ?? null,
        sourceTitle: input.sourceTitle ?? null,
        licenseStatus: input.licenseStatus ?? "unconfirmed",
        verificationStatus: input.verificationStatus ?? "needs_review",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MaterialSourceModel;
  }

  async listSources(tenant: TenantContext, materialVersionId: string): Promise<MaterialSourceModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(materialSources)
      .where(
        and(
          eq(materialSources.materialVersionId, materialVersionId),
          eq(materialSources.workspaceId, tenant.workspaceId),
          eq(materialSources.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(materialSources.createdAt);
    return rows as MaterialSourceModel[];
  }

  async invalidateSources(tenant: TenantContext, materialVersionId: string): Promise<number> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const result = await this.db
      .update(materialSources)
      .set({ invalidatedAt: now, updatedAt: now })
      .where(
        and(
          eq(materialSources.materialVersionId, materialVersionId),
          eq(materialSources.workspaceId, tenant.workspaceId),
          eq(materialSources.subjectUserId, tenant.subjectUserId),
          isNull(materialSources.invalidatedAt),
        ),
      );
    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }
}