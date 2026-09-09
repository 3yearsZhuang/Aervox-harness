/**
 * Aervox｜思隅 @aervox/repositories — analytics 仓储类型（自 types.ts 机械拆分）
 */
import type { AnalyticsEventModel } from "./platform.js";
import type { TenantContext } from "../../tenant.js";

export interface IAnalyticsRepository {
  recordEvent(
    tenant: TenantContext,
    event: {
      id: string;
      eventName: string;
      eventSchemaVersion?: number;
      occurredAt?: string;
      analyticsSubjectId: string;
      context?: unknown;
      privacyClass?: string;
    },
  ): Promise<AnalyticsEventModel>;
  listEventsBySubject(tenant: TenantContext, analyticsSubjectId: string, limit?: number): Promise<AnalyticsEventModel[]>;
}

export interface AttachmentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  objectKey: string;
  mediaType: string;
  size: number;
  scanStatus: string;
  sourceLicense?: string | null;
  /** CAP-012：用途声明 */
  purpose?: string | null;
  /** CAP-012：解析状态 */
  parseStatus?: string | null;
  /** CAP-012：幂等键 */
  idempotencyKey?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentParseResultModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  attachmentId: string;
  parseStatus: string;
  parsedText?: string | null;
  confidence?: number | null;
  parseError?: string | null;
  cropData?: unknown;
  operation: string;
  idempotencyKey?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingIndexModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  modelId: string;
  dimension: number;
  indexVersion: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}
