/**
 * Aervox｜思隅 @aervox/repositories — feedback 仓储类型（自 types.ts 机械拆分）
 */
import type { FeedbackModel } from "./learning.js";
import type { LocalContext } from "../../local-context.js";

export interface IFeedbackRepository {
  createFeedback(
    tenant: LocalContext,
    feedbackData: {
      id: string;
      actorId: string;
      subjectType: string;
      subjectId: string;
      type: string;
      note?: string | null;
    },
  ): Promise<FeedbackModel>;
  listFeedback(tenant: LocalContext, subjectType?: string, subjectId?: string): Promise<FeedbackModel[]>;
}

export interface SourceArtifactModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  kind: string;
  ownerModule: string;
  currentRevisionId?: string | null;
  occurredAt: string;
  ingestedAt: string;
  deletedAt?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceRevisionModel {
  id: string;
  artifactId: string;
  checksum: string;
  content?: string | null;
  version: number;
  supersededAt?: string | null;
  createdAt: string;
}

export interface MemoryRevisionModel {
  id: string;
  memoryId: string;
  content: string;
  confidence: number;
  importance: number;
  algorithmVersion?: string | null;
  createdAt: string;
}

export interface MemoryEvidenceModel {
  id: string;
  memoryRevisionId: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  sourceRange?: string | null;
  status: string;
  createdAt: string;
}

export interface MemoryEventModel {
  id: string;
  memoryId: string;
  action: string;
  fromTier?: string | null;
  toTier?: string | null;
  reason?: string | null;
  actorType: string;
  createdAt: string;
}
