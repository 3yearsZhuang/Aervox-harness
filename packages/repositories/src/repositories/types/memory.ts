/**
 * Aervox｜思隅 @aervox/repositories — memory 仓储类型（自 types.ts 机械拆分）
 */
import type { MemoryAlgorithmModel, MemoryEdgeEvidenceModel, MemoryEdgeModel, MemoryNodeModel, MemoryRecordModel, MemoryTreeNode } from "./conversation.js";
import type { LocalContext } from "../../local-context.js";

export interface IMemoryRepository {
  createRecord(
    tenant: LocalContext,
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
  getRecord(tenant: LocalContext, id: string): Promise<MemoryRecordModel | null>;
  listRecordsByLayer(tenant: LocalContext, layer: string): Promise<MemoryRecordModel[]>;
  createEdge(
    tenant: LocalContext,
    edge: { id: string; fromNodeId: string; toNodeId: string; relationType: string; confidence?: number; visibilityScope?: string },
  ): Promise<MemoryEdgeModel>;
  getTreeProjection(
    tenant: LocalContext,
    rootRecordId?: string | null,
  ): Promise<MemoryTreeNode[]>;
  softDeleteRecord(tenant: LocalContext, id: string): Promise<boolean>;
  // P1（R2）：记忆树投影节点 / 边证据 / 算法版本
  createNode(
    tenant: LocalContext,
    node: { id: string; label: string; nodeType?: string; canonicalParentId?: string | null; confidence?: number; projectionVersion?: number },
  ): Promise<MemoryNodeModel>;
  getNode(tenant: LocalContext, id: string): Promise<MemoryNodeModel | null>;
  listNodesByTenant(tenant: LocalContext): Promise<MemoryNodeModel[]>;
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
