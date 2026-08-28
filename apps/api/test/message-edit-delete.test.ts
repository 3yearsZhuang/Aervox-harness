/**
 * Aervox｜思隅 @aervox/api — 消息编辑、删除与引用集成测试（CAP-013）
 *
 * 覆盖：
 * - FR-CONV-004：编辑生成新版本，原版本可追溯
 * - AC-FR-CONV-004-02：已删除消息拒绝编辑
 * - AC-FR-CONV-004-03：并发编辑 CAS 冲突
 * - FR-CONV-005：软删除 + 影响预览
 * - 恢复已删除消息
 * - 版本历史查询
 * - 租户隔离
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_msg_it",
  "x-user-id": "usr_msg_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

const tenant = { workspaceId: "ws_msg_it", subjectUserId: "usr_msg_it" };

describe("消息编辑、删除与引用集成测试（CAP-013）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    repo = new SqliteConversationRepository(db);
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  /** 辅助：创建带版本的完整消息 */
  async function createMessageWithVersion(content: string, sessionId: string) {
    // 确保会话存在（messages.session_id 外键引用 sessions.id）
    await repo.getOrCreateSession(tenant, sessionId, "测试会话");

    // 创建消息身份
    const message = await repo.createMessage(tenant, {
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      role: "user",
    });

    // 创建 turn
    const { turn } = await repo.createTurnWithOutbox(
      tenant,
      {
        id: `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        idempotencyKey: `idem_${Date.now().toString(36)}`,
        status: "Created",
      },
      {
        id: `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        content,
      },
    );

    // 将 message_version 关联到 message
    await client.execute({
      sql: `UPDATE message_versions SET message_id = ? WHERE turn_id = ? AND version = 1`,
      args: [message.id, turn.id],
    });
    await client.execute({
      sql: `UPDATE messages SET current_version_id = (SELECT id FROM message_versions WHERE message_id = messages.id ORDER BY version DESC LIMIT 1) WHERE id = ?`,
      args: [message.id],
    });

    return { message, turn };
  }

  it("FR-CONV-004-01：编辑消息生成新版本，原版本仍可追溯", async () => {
    const { message } = await createMessageWithVersion("原始消息", "ses_edit_1");

    // 编辑消息
    const editRes = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${message.id}`,
      headers,
      payload: { content: "编辑后的内容", expectedVersion: 1 },
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().newVersion.version).toBe(2);
    expect(editRes.json().newVersion.content).toBe("编辑后的内容");

    // 版本历史 — 原版本仍可追溯
    const versionsRes = await app.inject({
      method: "GET",
      url: `/v1/messages/${message.id}/versions`,
      headers,
    });
    expect(versionsRes.statusCode).toBe(200);
    expect(versionsRes.json().versions).toHaveLength(2);
    expect(versionsRes.json().versions[0].version).toBe(2);
    expect(versionsRes.json().versions[1].version).toBe(1);
    expect(versionsRes.json().versions[1].content).toBe("原始消息");
  });

  it("AC-FR-CONV-004-02：已删除消息拒绝编辑", async () => {
    const { message } = await createMessageWithVersion("待删除", "ses_del_edit_1");

    // 软删除
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${message.id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(200);

    // 尝试编辑
    const editRes = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${message.id}`,
      headers,
      payload: { content: "尝试编辑已删除消息", expectedVersion: 1 },
    });
    expect(editRes.statusCode).toBe(409);
  });

  it("AC-FR-CONV-004-03：并发编辑版本冲突", async () => {
    const { message } = await createMessageWithVersion("原始", "ses_cas_1");

    // 第一次编辑（expectedVersion=1，成功）
    const edit1 = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${message.id}`,
      headers,
      payload: { content: "第一次编辑", expectedVersion: 1 },
    });
    expect(edit1.statusCode).toBe(200);
    expect(edit1.json().newVersion.version).toBe(2);

    // 第二次编辑（expectedVersion=1，版本冲突）
    const edit2 = await app.inject({
      method: "PATCH",
      url: `/v1/messages/${message.id}`,
      headers,
      payload: { content: "第二次编辑", expectedVersion: 1 },
    });
    expect(edit2.statusCode).toBe(409);
  });

  it("FR-CONV-005：软删除消息 + 影响预览", async () => {
    const { message } = await createMessageWithVersion("待预览", "ses_del_preview_1");

    // 删除影响预览
    const previewRes = await app.inject({
      method: "GET",
      url: `/v1/messages/${message.id}/delete-impact`,
      headers,
    });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().messageId).toBe(message.id);
    expect(previewRes.json().totalAffected).toBeGreaterThanOrEqual(0);

    // 软删除
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${message.id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().deletedAt).toBeTruthy();

    // 重复删除返回 404
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${message.id}`,
      headers,
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it("恢复已删除的消息", async () => {
    const { message } = await createMessageWithVersion("待恢复", "ses_restore_1");

    // 软删除
    await app.inject({
      method: "DELETE",
      url: `/v1/messages/${message.id}`,
      headers,
    });

    // 恢复
    const restoreRes = await app.inject({
      method: "POST",
      url: `/v1/messages/${message.id}/restore`,
      headers,
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(restoreRes.json().deletedAt).toBeNull();
  });

  it("版本历史查询", async () => {
    const { message } = await createMessageWithVersion("版本1", "ses_ver_1");

    // 编辑生成版本2
    await app.inject({
      method: "PATCH",
      url: `/v1/messages/${message.id}`,
      headers,
      payload: { content: "版本2", expectedVersion: 1 },
    });

    // 查询版本历史
    const versionsRes = await app.inject({
      method: "GET",
      url: `/v1/messages/${message.id}/versions`,
      headers,
    });
    expect(versionsRes.statusCode).toBe(200);
    expect(versionsRes.json().versions).toHaveLength(2);
    expect(versionsRes.json().versions[0].version).toBe(2);
    expect(versionsRes.json().versions[1].version).toBe(1);
  });

  it("租户隔离：不同租户无法操作对方的消息", async () => {
    const { message } = await createMessageWithVersion("隔离测试", "ses_iso_1");

    // 租户 B 尝试删除
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/messages/${message.id}`,
      headers: otherHeaders,
    });
    expect(delRes.statusCode).toBe(404);
  });
});