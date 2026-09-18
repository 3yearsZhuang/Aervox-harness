/**
 * Aervox｜思隅 @aervox/repositories — provenance 仓储类型（自 types.ts 机械拆分）
 */
import type { MemoryEventModel, MemoryEvidenceModel, MemoryRevisionModel, SourceArtifactModel, SourceRevisionModel } from "./feedback.js";
import type { LocalContext } from "../../local-context.js";

export interface IProvenanceRepository {
  createSourceArtifact(
    ctx: LocalContext,
    artifact: {
      id: string;
      kind: string;
      ownerModule: string;
      occurredAt: string;
      ingestedAt: string;
    },
  ): Promise<SourceArtifactModel>;
  getSourceArtifact(ctx: LocalContext, id: string): Promise<SourceArtifactModel | null>;
  appendSourceRevision(
    ctx: LocalContext,
    artifactId: string,
    revision: { id: string; checksum: string; content?: string | null },
  ): Promise<SourceRevisionModel>;
  setCurrentRevision(ctx: LocalContext, artifactId: string, revisionId: string): Promise<SourceArtifactModel | null>;
  appendMemoryRevision(
    ctx: LocalContext,
    revision: {
      id: string;
      memoryId: string;
      content: string;
      confidence?: number;
      importance?: number;
      algorithmVersion?: string | null;
    },
  ): Promise<MemoryRevisionModel>;
  setMemoryCurrentRevision(ctx: LocalContext, memoryId: string, revisionId: string): Promise<boolean>;
  listMemoryRevisions(ctx: LocalContext, memoryId: string): Promise<MemoryRevisionModel[]>;
  createMemoryEvidence(
    ctx: LocalContext,
    evidence: {
      id: string;
      memoryRevisionId: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      sourceRange?: string | null;
    },
  ): Promise<MemoryEvidenceModel>;
  recordMemoryEvent(
    ctx: LocalContext,
    event: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<MemoryEventModel>;
  listMemoryEvents(ctx: LocalContext, memoryId: string): Promise<MemoryEventModel[]>;
}

export interface ScheduledJobModel {
  id: string;
  jobType: string;
  subjectId: string;
  idempotencyKey: string;
  runAt: string;
  status: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationModel {
  id: string;
  type: string;
  scheduledAt: string;
  sentAt?: string | null;
  channel: string;
  status: string;
  /** 通知负载（CR-032：主动关怀话术与表现声明；可选） */
  payloadJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PromptVersionModel {
  id: string;
  purpose: string;
  version: number;
  checksum: string;
  status: string;
  approvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRunModel {
  id: string;
  /** 阶段 7（ADR-017）：Attempt/Step 关联（存量慢启动回填，可为空） */
  attemptId?: string | null;
  stepId?: number | null;
  purpose: string;
  provider: string;
  modelId: string;
  promptVersionId?: string | null;
  contextManifestId?: string | null;
  latencyMs?: number | null;
  tokenUsage?: unknown;
  cost?: number | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextManifestModel {
  id: string;
  modelRunId: string;
  purpose: string;
  sourceArtifactId: string;
  sourceRevisionId: string;
  selectionReason?: string | null;
  permissionSnapshot?: unknown;
  /** 阶段 7（ADR-017）：上下文快照（每 Turn 首个 Step 的 messages；可空） */
  snapshot?: unknown;
  tokenBudget?: number | null;
  createdAt: string;
}

export interface AuditRecordModel {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId: string;
  metadata?: unknown;
  createdAt: string;
}
