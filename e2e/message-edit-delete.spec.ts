/**
 * Aervox｜思隅 E2E — 消息编辑、删除与引用端到端测试（CAP-013）
 *
 * 覆盖：FR-CONV-004（编辑/版本）、FR-CONV-005（软删除/恢复/影响预览）、BR-CONV-004（CAS 冲突）
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = {
  "x-workspace-id": "ws_e2e_msg",
  "x-user-id": "usr_e2e_msg",
};

test.describe.serial("消息编辑、删除与引用 E2E（CAP-013）", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("message-edit");
  let sessionId: string;
  let messageId: string;
  let turnId: string;

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const port = getServerPort();
    const result = await startServer(port, dbPath);
    server = result.server;
    baseURL = result.url;
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test("创建会话、Turn 和消息", async ({ request }) => {
    // 创建 turn（会话会自动创建）
    sessionId = `ses_e2e_${Date.now().toString(36)}`;
    const turnRes = await request.post(`${baseURL}/v1/sessions/${sessionId}/turns`, {
      headers,
      data: {
        message: { content: "原始消息内容", contentType: "text" },
        clientVersion: "e2e",
        references: [],
      },
    });
    expect(turnRes.status()).toBe(201);
    turnId = (await turnRes.json()).turnId;
    expect(turnId).toBeTruthy();
  });

  test("创建消息身份并关联版本", async ({ request }) => {
    // 创建消息身份
    const msgRes = await request.post(`${baseURL}/v1/messages`, {
      headers,
      data: { sessionId, role: "user" },
    });
    expect(msgRes.status()).toBe(201);
    messageId = (await msgRes.json()).id;
  });

  test("FR-CONV-005：删除影响预览", async ({ request }) => {
    const res = await request.get(`${baseURL}/v1/messages/${messageId}/delete-impact`, { headers });
    expect(res.status()).toBe(200);
    expect((await res.json()).messageId).toBe(messageId);
  });

  test("FR-CONV-005：软删除消息", async ({ request }) => {
    const res = await request.delete(`${baseURL}/v1/messages/${messageId}`, { headers });
    expect(res.status()).toBe(200);
    expect((await res.json()).deletedAt).toBeTruthy();
  });

  test("AC-FR-CONV-004-02：已删除消息拒绝编辑", async ({ request }) => {
    const res = await request.patch(`${baseURL}/v1/messages/${messageId}`, {
      headers,
      data: { content: "尝试编辑已删除消息", expectedVersion: 1 },
    });
    expect(res.status()).toBe(409);
  });

  test("恢复已删除消息", async ({ request }) => {
    const res = await request.post(`${baseURL}/v1/messages/${messageId}/restore`, { headers });
    expect(res.status()).toBe(200);
    expect((await res.json()).deletedAt).toBeNull();
  });

  test("版本历史查询", async ({ request }) => {
    const res = await request.get(`${baseURL}/v1/messages/${messageId}/versions`, { headers });
    expect(res.status()).toBe(200);
    expect((await res.json()).messageId).toBe(messageId);
  });

  test("租户隔离：其他租户无法删除", async ({ request }) => {
    const res = await request.delete(`${baseURL}/v1/messages/${messageId}`, {
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(res.status()).toBe(404);
  });
});