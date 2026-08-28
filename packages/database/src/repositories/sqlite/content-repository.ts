/**
 * Aervox｜思隅 @aervox/database — 内容/资源域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（Attachment / EmbeddingIndex）
 * CAP-012 扩展：用途声明、解析管线、OCR 置信度、裁剪/转文字、删除传播
 */
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { attachments, attachmentParseResults, embeddingIndexes } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IContentRepository,
  AttachmentModel,
  AttachmentParseResultModel,
  EmbeddingIndexModel,
} from "../types.js";

export class SqliteContentRepository implements IContentRepository {
  constructor(private readonly db: AervoxDatabase) {}

  // ============ 附件身份 ============

  async createAttachment(
    tenant: TenantContext,
    attachmentData: {
      id: string;
      objectKey: string;
      mediaType: string;
      size?: number;
      scanStatus?: string;
      sourceLicense?: string | null;
      purpose?: string | null;
      idempotencyKey?: string | null;
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
        purpose: attachmentData.purpose ?? null,
        parseStatus: "pending",
        idempotencyKey: attachmentData.idempotencyKey ?? null,
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
          isNull(attachments.deletedAt),
        ),
      )
      .limit(1);
    return (found as AttachmentModel) ?? null;
  }

  async softDeleteAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(attachments)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.workspaceId, tenant.workspaceId),
          eq(attachments.subjectUserId, tenant.subjectUserId),
          isNull(attachments.deletedAt),
        ),
      )
      .returning();
    return (updated as AttachmentModel) ?? null;
  }

  async getAttachmentByIdempotencyKey(
    tenant: TenantContext,
    key: string,
  ): Promise<AttachmentModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.idempotencyKey, key),
          eq(attachments.workspaceId, tenant.workspaceId),
          eq(attachments.subjectUserId, tenant.subjectUserId),
          isNull(attachments.deletedAt),
        ),
      )
      .limit(1);
    return (found as AttachmentModel) ?? null;
  }

  // ============ CAP-012 解析结果 ============

  async createParseResult(
    tenant: TenantContext,
    input: {
      id: string;
      attachmentId: string;
      parseStatus?: string;
      parsedText?: string;
      confidence?: number;
      parseError?: string;
      cropData?: unknown;
      operation?: string;
      idempotencyKey?: string;
    },
  ): Promise<AttachmentParseResultModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(attachmentParseResults)
      .values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        attachmentId: input.attachmentId,
        parseStatus: input.parseStatus ?? "pending",
        parsedText: input.parsedText ?? null,
        confidence: input.confidence ?? null,
        parseError: input.parseError ?? null,
        cropData: input.cropData ?? null,
        operation: input.operation ?? "ocr",
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 同步更新 attachments.parseStatus
    const status = input.parseStatus ?? "pending";
    await this.db
      .update(attachments)
      .set({ parseStatus: status, updatedAt: now })
      .where(eq(attachments.id, input.attachmentId));

    return created as AttachmentParseResultModel;
  }

  async getActiveParseResult(
    tenant: TenantContext,
    attachmentId: string,
  ): Promise<AttachmentParseResultModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(attachmentParseResults)
      .where(
        and(
          eq(attachmentParseResults.attachmentId, attachmentId),
          eq(attachmentParseResults.workspaceId, tenant.workspaceId),
          eq(attachmentParseResults.subjectUserId, tenant.subjectUserId),
          isNull(attachmentParseResults.supersededAt),
        ),
      )
      .orderBy(desc(attachmentParseResults.createdAt))
      .limit(1);
    return (found as AttachmentParseResultModel) ?? null;
  }

  async getParseResultByIdempotencyKey(
    tenant: TenantContext,
    key: string,
  ): Promise<AttachmentParseResultModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(attachmentParseResults)
      .where(
        and(
          eq(attachmentParseResults.idempotencyKey, key),
          eq(attachmentParseResults.workspaceId, tenant.workspaceId),
          eq(attachmentParseResults.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as AttachmentParseResultModel) ?? null;
  }

  async listParseResults(
    tenant: TenantContext,
    attachmentId: string,
  ): Promise<AttachmentParseResultModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(attachmentParseResults)
      .where(
        and(
          eq(attachmentParseResults.attachmentId, attachmentId),
          eq(attachmentParseResults.workspaceId, tenant.workspaceId),
          eq(attachmentParseResults.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(attachmentParseResults.createdAt));
    return rows as AttachmentParseResultModel[];
  }

  async supersedeParseResult(tenant: TenantContext, parseResultId: string): Promise<void> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    await this.db
      .update(attachmentParseResults)
      .set({ supersededAt: now })
      .where(
        and(
          eq(attachmentParseResults.id, parseResultId),
          eq(attachmentParseResults.workspaceId, tenant.workspaceId),
          eq(attachmentParseResults.subjectUserId, tenant.subjectUserId),
          isNull(attachmentParseResults.supersededAt),
        ),
      );
  }

  async invalidateParseResults(tenant: TenantContext, attachmentId: string): Promise<number> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const result = await this.db
      .update(attachmentParseResults)
      .set({ supersededAt: now, updatedAt: now })
      .where(
        and(
          eq(attachmentParseResults.attachmentId, attachmentId),
          eq(attachmentParseResults.workspaceId, tenant.workspaceId),
          eq(attachmentParseResults.subjectUserId, tenant.subjectUserId),
          isNull(attachmentParseResults.supersededAt),
        ),
      );
    return (result as { rowsAffected?: number }).rowsAffected ?? 0;
  }

  // ============ 向量索引 ============

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
