/**
 * Aervox｜思隅 @aervox/database — 挂起提问会话仓储测试（缺陷 C）
 *
 * 覆盖：upsert 幂等覆盖 / getPending 租户隔离 / deletePending 只删本租户行。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteUserQuestionRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: TenantContext = { workspaceId: "ws_a", subjectUserId: "usr_a" };
const tenantB: TenantContext = { workspaceId: "ws_b", subjectUserId: "usr_b" };

const baseInput = (turnId: string, timeoutMs = 60_000) => ({
  turnId,
  attemptId: `atp_${turnId}`,
  step: 1,
  questions: [{ id: "q1", question: "Q?", options: [{ label: "A" }] }],
  timeoutMs,
  createdAt: "2026-08-28T00:00:00.000Z",
  expiresAt: new Date(Date.parse("2026-08-28T00:00:00.000Z") + timeoutMs).toISOString(),
});

describe("SqliteUserQuestionRepository（缺陷 C）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteUserQuestionRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteUserQuestionRepository(db);
  });

  it("upsert 幂等：同 turnId 覆盖为最新提问", async () => {
    await repo.upsertPending(tenantA, baseInput("turn_1"));
    await repo.upsertPending(tenantA, {
      ...baseInput("turn_1"),
      step: 2,
      questions: [{ id: "q2", question: "新问题" }],
      timeoutMs: 30_000,
    });
    const stored = await repo.getPending(tenantA, "turn_1");
    expect(stored).not.toBeNull();
    expect(stored!.step).toBe(2);
    expect((stored!.questions as { id: string }[])[0].id).toBe("q2");
    expect(stored!.timeoutMs).toBe(30_000);
  });

  it("getPending 租户隔离：A 写入对 B 不可见", async () => {
    await repo.upsertPending(tenantA, baseInput("turn_iso"));
    expect(await repo.getPending(tenantA, "turn_iso")).not.toBeNull();
    expect(await repo.getPending(tenantB, "turn_iso")).toBeNull();
  });

  it("deletePending 租户隔离：B 拿 A 的 turnId 无法删除/看到 A 的行", async () => {
    // turnId 全局唯一主键（与 turns.id 惯例一致）：A 创建自己的挂起
    await repo.upsertPending(tenantA, baseInput("turn_del"));

    // B 尝试用 A 的 turnId 删除 → where 含租户条件，不命中 A 的行
    await repo.deletePending(tenantB, "turn_del");
    expect(await repo.getPending(tenantA, "turn_del")).not.toBeNull();
    // B 查不到也不可删
    expect(await repo.getPending(tenantB, "turn_del")).toBeNull();

    // A 自己可正常删除
    await repo.deletePending(tenantA, "turn_del");
    expect(await repo.getPending(tenantA, "turn_del")).toBeNull();
  });
});