/**
 * Aervox｜思隅 @aervox/repositories — memory 仓储类型（自 types.ts 机械拆分）
 */
import type { MemoryAlgorithmModel, MemoryEdgeEvidenceModel, MemoryEdgeModel, MemoryNodeModel, MemoryRecordModel, MemoryTreeNode } from "./conversation.js";
import type { LocalContext } from "../../local-context.js";

export interface IMemoryRepository {
  createRecord(
    ctx: LocalContext,
    record: {
      id: string;
      layer: string;
      type: string;
      content: string;
      canonicalParentId?: string | null;
      sourceTurnId?: string | null;
      // PET-02 可选记忆条目字段
      source?: string;
      category?: string;
      keywords?: string[];
      lastUsedAt?: string | null;
      /** 校验状态；缺省沿用 schema 默认 unverified（候选语义） */
      verificationStatus?: string;
    },
  ): Promise<MemoryRecordModel>;
  getRecord(ctx: LocalContext, id: string): Promise<MemoryRecordModel | null>;
  getRecordsByIds(ctx: LocalContext, ids: string[]): Promise<MemoryRecordModel[]>;
  listRecordsByLayer(ctx: LocalContext, layer: string): Promise<MemoryRecordModel[]>;
  createEdge(
    ctx: LocalContext,
    edge: { id: string; fromNodeId: string; toNodeId: string; relationType: string; confidence?: number; visibilityScope?: string },
  ): Promise<MemoryEdgeModel>;
  getTreeProjection(
    ctx: LocalContext,
    rootRecordId?: string | null,
  ): Promise<MemoryTreeNode[]>;
  softDeleteRecord(ctx: LocalContext, id: string): Promise<boolean>;
  // P1（R2）：记忆树投影节点 / 边证据 / 算法版本
  createNode(
    ctx: LocalContext,
    node: { id: string; label: string; nodeType?: string; canonicalParentId?: string | null; confidence?: number; projectionVersion?: number },
  ): Promise<MemoryNodeModel>;
  getNode(ctx: LocalContext, id: string): Promise<MemoryNodeModel | null>;
  listNodesByTenant(ctx: LocalContext): Promise<MemoryNodeModel[]>;
  createEdgeEvidence(
    evidence: { id: string; edgeId: string; memoryRevisionId: string },
  ): Promise<MemoryEdgeEvidenceModel>;
  createMemoryAlgorithm(
    algorithm: {
      id: string;
      stage: string;
      schemaVersion?: number;
      promptVersionId?: string | null;
      thresholds?: unknown;
      status?: string;
    },
  ): Promise<MemoryAlgorithmModel>;
  getActiveAlgorithm(stage: string): Promise<MemoryAlgorithmModel | null>;
}

export interface MemoryCompactionMarkerModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  memoryId: string;
  snapshotId: string;
  coveredUpToMessageId?: string | null;
  summaryText?: string | null;
  phase: string; // "auto" | "manual"
  status: string; // "completed" | "failed"
  thoughtDurationMs?: number | null;
  summaryDurationMs?: number | null;
  createdAt: string;
  updatedAt: string;
}
