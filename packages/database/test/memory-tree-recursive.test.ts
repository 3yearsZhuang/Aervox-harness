import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("ADR-007: 记忆树 SQLite WITH RECURSIVE CTE 递归投影测试", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteMemoryRepository;

  const tenant: TenantContext = {
    workspaceId: "ws_knowledge",
    subjectUserId: "usr_student",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteMemoryRepository(db, client);
  });

  it("能够使用递归 CTE 正确查询并组装多层级记忆树", async () => {
    // 1. 根节点：自然科学
    const root = await repo.createRecord(tenant, {
      id: "mem_root_science",
      layer: "system",
      type: "learning_event",
      content: "自然科学体系",
    });

    // 2. 二级节点：物理学、生物学
    const physics = await repo.createRecord(tenant, {
      id: "mem_physics",
      layer: "system",
      type: "learning_event",
      content: "经典力学与电磁学",
      canonicalParentId: root.id,
    });

    const biology = await repo.createRecord(tenant, {
      id: "mem_biology",
      layer: "system",
      type: "learning_event",
      content: "细胞生物学",
      canonicalParentId: root.id,
    });

    // 3. 三级节点：牛顿力学（属于物理学）
    const newton = await repo.createRecord(tenant, {
      id: "mem_newton",
      layer: "long_term",
      type: "user_fact",
      content: "掌握牛顿三大运动定律",
      canonicalParentId: physics.id,
    });

    // 4. 执行递归投影查询
    const tree = await repo.getTreeProjection(tenant);
    expect(tree).toHaveLength(1);

    const rootNode = tree[0]!;
    expect(rootNode.record.id).toBe("mem_root_science");
    expect(rootNode.depth).toBe(0);
    expect(rootNode.children).toHaveLength(2);

    const physicsNode = rootNode.children.find((c) => c.record.id === "mem_physics");
    expect(physicsNode).toBeDefined();
    expect(physicsNode!.depth).toBe(1);
    expect(physicsNode!.children).toHaveLength(1);

    const newtonNode = physicsNode!.children[0]!;
    expect(newtonNode.record.id).toBe("mem_newton");
    expect(newtonNode.depth).toBe(2);
    expect(newtonNode.path).toBe("mem_root_science/mem_physics/mem_newton");
  });
});
