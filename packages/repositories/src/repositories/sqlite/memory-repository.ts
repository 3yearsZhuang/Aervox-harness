/**
 * Aervox｜思隅 @aervox/database — 记忆与记忆树 SQLite 仓储实现
 *
 * 使用 SQLite 3.8.3+ 原生 WITH RECURSIVE CTE 实现记忆树递归遍历与投影。
 */
import { eq, and, inArray } from "drizzle-orm";
import type { Client, InValue } from "@libsql/client";
import type { AervoxDatabase } from "../../client.js";
import {
  memoryRecords,
  memoryEdges,
  memoryNodes,
  memoryEdgeEvidence,
  memoryAlgorithms,
  memoryProjectionOverrides,
} from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IMemoryRepository,
  MemoryRecordModel,
  MemoryEdgeModel,
  MemoryNodeModel,
  MemoryEdgeEvidenceModel,
  MemoryAlgorithmModel,
  MemoryTreeNode,
} from "../types/index.js";

export class SqliteMemoryRepository implements IMemoryRepository {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly client: Client,
  ) {}

  async createRecord(
    tenant: LocalContext,
    recordData: {
      id: string;
      layer: string;
      type: string;
      content: string;
      canonicalParentId?: string | null;
      sourceTurnId?: string | null;
      // PET-02 记忆条目字段
      source?: string;
      category?: string;
      keywords?: string[];
      lastUsedAt?: string | null;
      verificationStatus?: string;
    },
  ): Promise<MemoryRecordModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(memoryRecords)
      .values({
        id: recordData.id,
        layer: recordData.layer,
        type: recordData.type,
        content: recordData.content,
        canonicalParentId: recordData.canonicalParentId ?? null,
        sourceTurnId: recordData.sourceTurnId ?? null,
        version: 1,
        isDeleted: 0,
        source: recordData.source ?? "user_said",
        category: recordData.category ?? "other",
        keywordsJson:
          recordData.keywords && recordData.keywords.length > 0
            ? JSON.stringify(recordData.keywords)
            : null,
        lastUsedAt: recordData.lastUsedAt ?? null,
        verificationStatus: recordData.verificationStatus,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MemoryRecordModel;
  }

  async getRecord(tenant: LocalContext, id: string): Promise<MemoryRecordModel | null> {
    const [found] = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.id, id),
          eq(memoryRecords.isDeleted, 0),
        ),
      );
    return (found as MemoryRecordModel) ?? null;
  }

  async getRecordsByIds(tenant: LocalContext, ids: string[]): Promise<MemoryRecordModel[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          inArray(memoryRecords.id, ids),
          eq(memoryRecords.isDeleted, 0),
        ),
      );
    return rows as MemoryRecordModel[];
  }

  async listRecordsByLayer(tenant: LocalContext, layer: string): Promise<MemoryRecordModel[]> {
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.layer, layer),
          eq(memoryRecords.isDeleted, 0),
        ),
      );
    return rows as MemoryRecordModel[];
  }

  async createEdge(
    tenant: LocalContext,
    edgeData: {
      id: string;
      fromNodeId: string;
      toNodeId: string;
      relationType: string;
      confidence?: number;
      visibilityScope?: string;
    },
  ): Promise<MemoryEdgeModel> {
    const [created] = await this.db
      .insert(memoryEdges)
      .values({
        id: edgeData.id,
        fromNodeId: edgeData.fromNodeId,
        toNodeId: edgeData.toNodeId,
        relationType: edgeData.relationType,
        confidence: edgeData.confidence ?? 0,
        visibilityScope: edgeData.visibilityScope ?? "private",
        status: "active",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MemoryEdgeModel;
  }

  async getTreeProjection(
    tenant: LocalContext,
    rootRecordId?: string | null,
  ): Promise<MemoryTreeNode[]> {

    // 使用 SQLite WITH RECURSIVE CTE 递归查询整棵树
    const rootCondition = rootRecordId
      ? "id = ?"
      : "(canonical_parent_id IS NULL OR canonical_parent_id = '')";

    const baseArgs: InValue[] = [];
    if (rootRecordId) {
      baseArgs.push(rootRecordId);
    }
    const recursiveArgs: InValue[] = [];

    const querySql = `
      WITH RECURSIVE memory_tree AS (
        SELECT
          id, layer, type, content,
          canonical_parent_id, source_turn_id, version, is_deleted,
          created_at, updated_at,
          0 AS depth,
          id AS path
        FROM memory_records
        WHERE is_deleted = 0
          AND ${rootCondition}
        UNION ALL
        SELECT
          c.id, c.layer, c.type, c.content,
          c.canonical_parent_id, c.source_turn_id, c.version, c.is_deleted,
          c.created_at, c.updated_at,
          p.depth + 1 AS depth,
          p.path || '/' || c.id AS path
        FROM memory_records c
        JOIN memory_tree p ON c.canonical_parent_id = p.id
        WHERE c.is_deleted = 0
      )
      SELECT * FROM memory_tree ORDER BY depth ASC, created_at ASC;
    `;

    const res = await this.client.execute({
      sql: querySql,
      args: [...baseArgs, ...recursiveArgs],
    });

    const flatNodes: Array<{
      record: MemoryRecordModel;
      depth: number;
      path: string;
    }> = res.rows.map((row) => ({
      record: {
        id: String(row.id),
        layer: String(row.layer),
        type: String(row.type),
        content: String(row.content),
        canonicalParentId: row.canonical_parent_id ? String(row.canonical_parent_id) : null,
        sourceTurnId: row.source_turn_id ? String(row.source_turn_id) : null,
        version: Number(row.version),
        isDeleted: Number(row.is_deleted),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      },
      depth: Number(row.depth),
      path: String(row.path),
    }));

    // 组装成树形结构
    const nodeMap = new Map<string, MemoryTreeNode>();
    const roots: MemoryTreeNode[] = [];

    for (const item of flatNodes) {
      const node: MemoryTreeNode = {
        record: item.record,
        depth: item.depth,
        path: item.path,
        children: [],
      };
      nodeMap.set(item.record.id, node);
    }

    for (const item of flatNodes) {
      const node = nodeMap.get(item.record.id)!;
      const parentId = item.record.canonicalParentId;
      if (parentId && nodeMap.has(parentId)) {
        nodeMap.get(parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async softDeleteRecord(tenant: LocalContext, id: string): Promise<boolean> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(memoryRecords)
      .set({ isDeleted: 1, updatedAt: now })
      .where(
        and(
          eq(memoryRecords.id, id),
        ),
      )
      .returning();
    return !!updated;
  }

  // ============ P1（R2）：记忆树投影节点 / 边证据 / 算法版本 ============

  async createNode(
    tenant: LocalContext,
    nodeData: {
      id: string;
      label: string;
      nodeType?: string;
      canonicalParentId?: string | null;
      confidence?: number;
      projectionVersion?: number;
    },
  ): Promise<MemoryNodeModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(memoryNodes)
      .values({
        id: nodeData.id,
        canonicalParentId: nodeData.canonicalParentId ?? null,
        label: nodeData.label,
        nodeType: nodeData.nodeType ?? "concept",
        confidence: nodeData.confidence ?? 0,
        status: "active",
        projectionVersion: nodeData.projectionVersion ?? 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MemoryNodeModel;
  }

  async getNode(tenant: LocalContext, id: string): Promise<MemoryNodeModel | null> {
    const [found] = await this.db
      .select()
      .from(memoryNodes)
      .where(
        and(
          eq(memoryNodes.id, id),
        ),
      );
    return (found as MemoryNodeModel) ?? null;
  }

  async listNodesByTenant(tenant: LocalContext): Promise<MemoryNodeModel[]> {
    const rows = await this.db
      .select()
      .from(memoryNodes)
      .where(
        and(
        ),
      )
      .orderBy(memoryNodes.updatedAt);
    return rows as MemoryNodeModel[];
  }

  async createEdgeEvidence(
    evidenceData: { id: string; edgeId: string; memoryRevisionId: string },
  ): Promise<MemoryEdgeEvidenceModel> {
    const [created] = await this.db
      .insert(memoryEdgeEvidence)
      .values({
        id: evidenceData.id,
        edgeId: evidenceData.edgeId,
        memoryRevisionId: evidenceData.memoryRevisionId,
        status: "active",
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as MemoryEdgeEvidenceModel;
  }

  async createMemoryAlgorithm(
    algorithmData: {
      id: string;
      stage: string;
      schemaVersion?: number;
      promptVersionId?: string | null;
      thresholds?: unknown;
      status?: string;
    },
  ): Promise<MemoryAlgorithmModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(memoryAlgorithms)
      .values({
        id: algorithmData.id,
        stage: algorithmData.stage,
        schemaVersion: algorithmData.schemaVersion ?? 1,
        promptVersionId: algorithmData.promptVersionId ?? null,
        thresholds: algorithmData.thresholds ?? null,
        status: algorithmData.status ?? "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MemoryAlgorithmModel;
  }

  async getActiveAlgorithm(stage: string): Promise<MemoryAlgorithmModel | null> {
    const [found] = await this.db
      .select()
      .from(memoryAlgorithms)
      .where(
        and(
          eq(memoryAlgorithms.stage, stage),
          eq(memoryAlgorithms.status, "active"),
        ),
      )
      .limit(1);
    return (found as MemoryAlgorithmModel) ?? null;
  }
}
