/**
 * Aervox｜思隅 @aervox/repositories — memory-compaction 仓储类型（自 types.ts 机械拆分）
 */
import type { MemoryCompactionMarkerModel } from "./memory.js";
import type { LocalContext } from "../../local-context.js";

export interface IMemoryCompactionRepository {
  /**
   * 幂等写入压缩标记：同一 memoryId + snapshotId 已存在时不覆盖（快照溯源不可改写）。
   * 由调用方保证在「完整响应持久化后」（先写后投递时序）调用。
   */
  upsertMarker(
    tenant: LocalContext,
    marker: {
      id: string;
      memoryId: string;
      snapshotId: string;
      coveredUpToMessageId?: string | null;
      summaryText?: string | null;
      phase?: string;
      status?: string;
      thoughtDurationMs?: number | null;
      summaryDurationMs?: number | null;
    },
  ): Promise<MemoryCompactionMarkerModel>;
  getMarkerBySnapshotId(tenant: LocalContext, snapshotId: string): Promise<MemoryCompactionMarkerModel | null>;
  listMarkersByMemoryId(tenant: LocalContext, memoryId: string): Promise<MemoryCompactionMarkerModel[]>;
  /** 写 memory_events 审计（action = "compressed" 等） */
  recordEvent(
    tenant: LocalContext,
    event: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<void>;
}

export interface MemoryEmbeddingModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  memoryId: string;
  dimension: number;
  modelId: string;
  vector: number[];
  sourceCreatedAt?: string | null;
  indexVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbeddingBatchProgress {
  current: number;
  total: number;
}
