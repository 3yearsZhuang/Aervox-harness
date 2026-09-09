import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryRepository,
  SqliteProvenanceRepository,
  SqliteConversationRepository,
  SqliteLearningRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("PRD §8 P1（R2）：记忆树投影独立化 + 会话地图 + 知识关系", () => {
  let db: AervoxDatabase;
  let client: Client;
  let memory: SqliteMemoryRepository;
  let provenance: SqliteProvenanceRepository;
  let conversation: SqliteConversationRepository;
  let learning: SqliteLearningRepository;

  const tenant: TenantContext = { workspaceId: "ws_p1", subjectUserId: "usr_p1" };
  const otherTenant: TenantContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    memory = new SqliteMemoryRepository(db, client);
    provenance = new SqliteProvenanceRepository(db);
    conversation = new SqliteConversationRepository(db);
    learning = new SqliteLearningRepository(db);
  });

  it("记忆投影节点：可创建层级节点树，且租户隔离", async () => {
    const root = await memory.createNode(tenant, { id: "node_root", label: "自然科学" });
    expect(root.nodeType).toBe("concept");

    const child = await memory.createNode(tenant, {
      id: "node_physics",
      label: "物理学",
      canonicalParentId: root.id,
    });
    expect(child.canonicalParentId).toBe("node_root");
    expect((await memory.getNode(tenant, "node_physics"))?.label).toBe("物理学");

    // 跨租户不可见
    expect(await memory.getNode(otherTenant, "node_root")).toBeNull();
  });

  it("节点级记忆边 + 边证据：可创建并关联长期记忆修订", async () => {
    const a = await memory.createNode(tenant, { id: "node_a", label: "A" });
    const b = await memory.createNode(tenant, { id: "node_b", label: "B" });
    const edge = await memory.createEdge(tenant, {
      id: "edge_1",
      fromNodeId: a.id,
      toNodeId: b.id,
      relationType: "causal",
      confidence: 80,
    });
    expect(edge.fromNodeId).toBe("node_a");
    expect(edge.confidence).toBe(80);
    expect(edge.visibilityScope).toBe("private");

    // 建记忆 + 修订，再挂边证据
    const record = await memory.createRecord(tenant, { id: "mem_1", layer: "long_term", type: "learning_event", content: "证据内容" });
    const rev = await provenance.appendMemoryRevision(tenant, { id: "mrev_1", memoryId: record.id, content: "证据内容 v1", confidence: 90 });
    const evidence = await memory.createEdgeEvidence({ id: "eev_1", edgeId: edge.id, memoryRevisionId: rev.id });
    expect(evidence.status).toBe("active");
  });

  it("记忆算法版本：仅 active 可被查询", async () => {
    await memory.createMemoryAlgorithm({ id: "alg_1", stage: "short_to_long", schemaVersion: 1, thresholds: { minConfidence: 60 }, status: "draft" });
    expect(await memory.getActiveAlgorithm("short_to_long")).toBeNull();

    await memory.createMemoryAlgorithm({ id: "alg_2", stage: "short_to_long", schemaVersion: 2, thresholds: { minConfidence: 70 }, status: "active" });
    const active = await memory.getActiveAlgorithm("short_to_long");
    expect(active?.id).toBe("alg_2");
    expect(active?.thresholds).toEqual({ minConfidence: 70 });
  });

  it("会话地图分支：创建并按父会话列出，且租户隔离", async () => {
    const parent = await conversation.createSession(tenant, "Parent Session");
    const child = await conversation.createSession(tenant, "Child Session");
    const branch = await conversation.createConversationBranch(tenant, {
      id: "br_1",
      parentSessionId: parent.id,
      childSessionId: child.id,
      forkAtMessageId: "msg_fork",
    });
    expect(branch.parentSessionId).toBe(parent.id);
    expect(branch.forkAtMessageId).toBe("msg_fork");

    const branches = await conversation.listBranchesByParent(tenant, parent.id);
    expect(branches).toHaveLength(1);
    expect(await conversation.listBranchesByParent(otherTenant, parent.id)).toHaveLength(0);
  });

  it("思维宇宙知识关系：创建并按知识点列出，且租户隔离", async () => {
    const k1 = await learning.createKnowledgeItem(tenant, { id: "ki_a", concept: "导数" });
    const k2 = await learning.createKnowledgeItem(tenant, { id: "ki_b", concept: "极限" });
    const rel = await learning.createKnowledgeRelation(tenant, {
      id: "kr_1",
      fromKnowledgeId: k1.id,
      toKnowledgeId: k2.id,
      relationType: "prerequisite",
      source: "inference",
      confidence: 70,
    });
    expect(rel.relationType).toBe("prerequisite");

    const relations = await learning.listKnowledgeRelations(tenant, k1.id);
    expect(relations).toHaveLength(1);
    expect(await learning.listKnowledgeRelations(otherTenant, k1.id)).toHaveLength(0);
  });
});
