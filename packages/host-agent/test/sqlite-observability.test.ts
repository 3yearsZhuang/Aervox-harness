/**
 * Aervox｜思隅 @aervox/host-agent — SQLite 可观测性门面测试（缺陷5）
 *
 * 覆盖 createSqliteObservability：
 * - audit.emit 落库 audit_logs，字段对齐 AuditEntry、payload JSON 编码；
 * - 无 payload 时 payload 列为 NULL；emit 调用不抛异常（接口约定）。
 */
import { describe, expect, it } from "vitest";
import { auditLogs, createInMemoryDatabase, initDatabaseSchema } from "@aervox/database";
import { createSqliteObservability } from "../src/index.js";

describe("SqliteObservability（audit 落库）", () => {
  it("audit.emit 写入 audit_logs：字段对齐 AuditEntry、payload JSON 编码", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    try {
      await initDatabaseSchema(client);
      const ob = createSqliteObservability(db);

      await ob.audit.emit({
        eventType: "agent.turn.completed",
        actorId: "agent-host",
        action: "complete_turn",
        scope: "turn_1",
        evidenceRef: "atp_1",
        payload: { attemptId: "atp_1", durationMs: 12 },
      });

      const rows = await db.select().from(auditLogs);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.eventType).toBe("agent.turn.completed");
      expect(row.actorId).toBe("agent-host");
      expect(row.action).toBe("complete_turn");
      expect(row.scope).toBe("turn_1");
      expect(row.evidenceRef).toBe("atp_1");
      expect(JSON.parse(row.payload!)).toEqual({ attemptId: "atp_1", durationMs: 12 });
    } finally {
      await cleanup();
    }
  });

  it("audit.emit 无 payload 时 payload 为 NULL，且调用不抛错", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    try {
      await initDatabaseSchema(client);
      const ob = createSqliteObservability(db);

      await expect(
        ob.audit.emit({
          eventType: "agent.fencing.denials",
          actorId: "host",
          action: "deny_repeat_delivery",
          scope: "atp_1",
        }),
      ).resolves.toBeUndefined();

      const rows = await db.select().from(auditLogs);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toBeNull();
    } finally {
      await cleanup();
    }
  });
});