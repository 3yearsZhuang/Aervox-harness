/**
 * Aervox｜思隅 @aervox/repositories — content 仓储类型（自 types.ts 机械拆分）
 */
import type { AttachmentModel, AttachmentParseResultModel, EmbeddingIndexModel } from "./analytics.js";
import type { LocalContext } from "../../local-context.js";

export interface IContentRepository {
  createAttachment(
    ctx: LocalContext,
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
  getAttachment(ctx: LocalContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-002：软删除附件 */
  softDeleteAttachment(ctx: LocalContext, id: string): Promise<AttachmentModel | null>;
  /** CAP-012 BR-EXT-001：幂等键查询 */
  getAttachmentByIdempotencyKey(ctx: LocalContext, key: string): Promise<AttachmentModel | null>;
  /** CAP-012 FR-EXT-002：创建解析结果 */
  createParseResult(
    ctx: LocalContext,
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
  getActiveParseResult(ctx: LocalContext, attachmentId: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 BR-EXT-001 AC-02：幂等键查询解析结果 */
  getParseResultByIdempotencyKey(ctx: LocalContext, key: string): Promise<AttachmentParseResultModel | null>;
  /** CAP-012 FR-EXT-002：列出租户内附件的所有解析结果 */
  listParseResults(ctx: LocalContext, attachmentId: string): Promise<AttachmentParseResultModel[]>;
  /** CAP-012 FR-EXT-002：取代旧解析结果（裁剪/转文字时） */
  supersedeParseResult(ctx: LocalContext, parseResultId: string): Promise<void>;
  /** CAP-012 BR-EXT-002：失效所有解析结果（删除附件时） */
  invalidateParseResults(ctx: LocalContext, attachmentId: string): Promise<number>;
  createEmbeddingIndex(
    ctx: LocalContext,
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
  listEmbeddingIndexes(ctx: LocalContext, sourceArtifactId: string): Promise<EmbeddingIndexModel[]>;
}

export interface StudyMaterialModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
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
  workspaceId?: string;
  subjectUserId?: string;
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
  workspaceId?: string;
  subjectUserId?: string;
  sourceType: string;
  sourceUri?: string | null;
  sourceTitle?: string | null;
  licenseStatus: string;
  verificationStatus: string;
  invalidatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
