/**
 * Aervox｜思隅 @aervox/repositories — content 仓储类型（自 types.ts 机械拆分）
 */
import type { AttachmentModel, AttachmentParseResultModel, EmbeddingIndexModel } from "./analytics.js";
import type { TenantContext } from "../../tenant.js";

export interface IContentRepository {
  createAttachment(
    tenant: TenantContext,
    attachment: {
      id: string;
      objectKey: string;
      mediaType: string;
      size?: number;
      scanStatus?: string;
      sourceLicense?: string | null;
      purpose?: string | null;
      idempotencyKey?: string | null;
    },
  ): Promise<AttachmentModel>;
  getAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-002：软删除附件 */
  softDeleteAttachment(tenant: TenantContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-001：幂等键查询 */
  getAttachmentByIdempotencyKey(tenant: TenantContext, key: string): Promise<AttachmentModel | null>;
  /** CAP-012 FR-EXT-002：创建解析结果 */
  createParseResult(
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
  ): Promise<AttachmentParseResultModel>;
  /** CAP-012 FR-EXT-002：获取当前（未取代）解析结果 */
  getActiveParseResult(tenant: TenantContext, attachmentId: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 BR-EXT-001 AC-02：幂等键查询解析结果 */
  getParseResultByIdempotencyKey(tenant: TenantContext, key: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 FR-EXT-002：列出租户内附件的所有解析结果 */
  listParseResults(tenant: TenantContext, attachmentId: string): Promise<AttachmentParseResultModel[]>;
  /** CAP-012 FR-EXT-002：取代旧解析结果（裁剪/转文字时） */
  supersedeParseResult(tenant: TenantContext, parseResultId: string): Promise<void>;
  /** CAP-012 BR-EXT-002：失效所有解析结果（删除附件时） */
  invalidateParseResults(tenant: TenantContext, attachmentId: string): Promise<number>;
  createEmbeddingIndex(
    tenant: TenantContext,
    index: {
      id: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      modelId: string;
      dimension?: number;
      indexVersion?: number;
      status?: string;
    },
  ): Promise<EmbeddingIndexModel>;
  listEmbeddingIndexes(tenant: TenantContext, sourceArtifactId: string): Promise<EmbeddingIndexModel[]>;
}

export interface StudyMaterialModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  goalId?: string | null;
  type: string;
  title: string;
  currentVersionId?: string | null;
  status: string;
  idempotencyKey?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterialVersionModel {
  id: string;
  materialId: string;
  workspaceId: string;
  subjectUserId: string;
  version: number;
  content: string;
  format: string;
  author: string;
  supersededAt?: string | null;
  createdAt: string;
}

export interface MaterialSourceModel {
  id: string;
  materialVersionId: string;
  workspaceId: string;
  subjectUserId: string;
  sourceType: string;
  sourceUri?: string | null;
  sourceTitle?: string | null;
  licenseStatus: string;
  verificationStatus: string;
  invalidatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
