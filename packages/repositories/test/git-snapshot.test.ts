/**
 * Aervox｜思隅 @aervox/database — T-09 Git 快照导出/恢复测试
 */
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema } from "../src/index.js";
import { exportSnapshot, restoreSnapshot, snapshotFileName } from "../src/sync/git-snapshot.js";

describe("T-09 数据版本快照", () => {
  it("导出全库快照 → 修改 → 恢复 → 数据复原", async () => {
    const db1 = await createInMemoryDatabase();
    await initDatabaseSchema(db1.client);
    try {
      // 写入一行数据
      await db1.client.execute({
        sql: `INSERT INTO sessions(id, workspace_id, subject_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["s1", "ws_snap", "usr_snap", "snapshot session", "2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.000Z"],
      });

      // 导出快照
      const snapshot = await exportSnapshot(db1.client, 1);
      expect(snapshot.tables["sessions"]).toHaveLength(1);
      expect(snapshot.tables["sessions"]![0]!.title).toBe("snapshot session");

      // 序列化 → 反序列化（模拟 git 落盘再读回）
      const json = JSON.stringify(snapshot);
      const parsed = JSON.parse(json) as Parameters<typeof restoreSnapshot>[1];

      // 清库
      await db1.client.execute(`DELETE FROM sessions`);

      // 恢复
      await restoreSnapshot(db1.client, parsed);
      const after = await db1.client.execute(`SELECT * FROM sessions`);
      expect(after.rows).toHaveLength(1);
      expect(String(after.rows[0]!.title)).toBe("snapshot session");
    } finally {
      await db1.cleanup();
    }
  });

  it("快照文件名约定稳定", () => {
    expect(snapshotFileName(3)).toBe("snapshot-v3.json");
  });

  it("迁移 journal 表不参与导出", async () => {
    const db1 = await createInMemoryDatabase();
    try {
      const snapshot = await exportSnapshot(db1.client, 1);
      expect(snapshot.tables["_migration_journal"]).toBeUndefined();
    } finally {
      await db1.cleanup();
    }
  });
});