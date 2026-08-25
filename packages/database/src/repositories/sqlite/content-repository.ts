/**
 * Aervox｜思隅 @aervox/database — 内容/资源域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（Attachment / EmbeddingIndex）
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { attachments, embeddingIndexes } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { IContentRepository, AttachmentModel, EmbeddingIndexModel } from "../types.js";

export class SqliteContentRepository implements IContentRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createAttachment(
    tenant: TenantContext,
    attachmentData: {
      id: string;
      objectKey: string;
      mediaType: string;
      size?: number;
      scanStatus?: string;
      sourceLicense?: string | null;
    },
  ): Promise<AttachmentModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(attachments)
      .values({
        id: attachmentData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        objectKey: attachmentData.objectKey,
        mediaType: attachmentData.mediaType,
        size: attachmentData.size ?? 0,
        scanStatus: attachmentData.scanStatus ?? "pending",
        sourceLicense: attachmentData.sourceLicense ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as AttachmentModel;
  }

  async getAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.workspaceId, tenant.workspaceId),
          eq(attachments.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as AttachmentModel) ?? null;
  }

  async createEmbeddingIndex(
    tenant: TenantContext,
    indexData: {
      id: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      modelId: string;
      dimension?: number;
      indexVersion?: number;
      status?: string;
    },
  ): Promise<EmbeddingIndexModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(embeddingIndexes)
      .values({
        id: indexData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sourceArtifactId: indexData.sourceArtifactId,
        sourceRevisionId: indexData.sourceRevisionId,
        modelId: indexData.modelId,
        dimension: indexData.dimension ?? 0,
        indexVersion: indexData.indexVersion ?? 1,
        status: indexData.status ?? "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as EmbeddingIndexModel;
  }

  async listEmbeddingIndexes(tenant: TenantContext, sourceArtifactId: string): Promise<EmbeddingIndexModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(embeddingIndexes)
      .where(
        and(
          eq(embeddingIndexes.workspaceId, tenant.workspaceId),
          eq(embeddingIndexes.subjectUserId, tenant.subjectUserId),
          eq(embeddingIndexes.sourceArtifactId, sourceArtifactId),
        ),
      )
      .orderBy(desc(embeddingIndexes.updatedAt));
    return rows as EmbeddingIndexModel[];
  }
}
