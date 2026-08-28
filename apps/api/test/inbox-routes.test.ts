/**
 * Aervox｜思隅 @aervox/api — 阶段 5a-2 受控收件箱 HTTP 入口测试
 *
 * 覆盖 AVX-HAR-001 §7.2 + ADR-017：
 * - 统一端点 POST /v1/sessions/:sessionId/inbox：followup/steer/inject 三类型；
 * - 服务端强校验（消费边界一致性、幂等、payload 必填）；
 * - 插件受控入口：x-plugin-id 需已安装 + 启用 + inbox.command 权限，否则 403；
 * - next-turn 消费闭环：followup 在创建新 Turn 时注入为输入。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_ibx",
  "x-user-id": "usr_ibx",
} as const;

const turnPayload = {
  message: { content: "好的", contentType: "text" },
  clientVersion: "it-inbox",
  references: [],
};

describe("阶段 5a-2：受控收件箱（Agent Inbox）HTTP 入口", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  const postInbox = (sessionId: string, payload: object, extraHeaders: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/inbox`,
      headers: { ...headers, ...extraHeaders },
      payload,
    });

  it("user followup → 201；consumeBoundary=next-turn；sourceActor=user", async () => {
    const res = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k1",
      type: "followup",
      payload: { text: "继续聊" },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item.type).toBe("followup");
    expect(item.consumeBoundary).toBe("next-turn");
    expect(item.sourceActor).toBe("user");
    expect(item.status).toBe("pending");
    expect(item.sessionId).toBe("ses_ibx");
  });

  it("幂等：同 idempotencyKey 重复提交 → 200 返回既有项，不新增", async () => {
    await postInbox("ses_ibx", { idempotencyKey: "ibx_k1", type: "inject", payload: { text: "A" } });
    const second = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k1",
      type: "inject",
      payload: { text: "B" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().payload).toEqual({ text: "A" });
  });

  it("非法 type / payload 缺失 → 400", async () => {
    const badType = await postInbox("ses_ibx", { idempotencyKey: "ibx_k2", type: "bogus", payload: {} });
    expect(badType.statusCode).toBe(400);
    const noPayload = await postInbox("ses_ibx", { idempotencyKey: "ibx_k3", type: "inject" });
    expect(noPayload.statusCode).toBe(400);
  });

  it("consumeBoundary 与 type 不匹配 → 400（followup 不能 next-step；steer 不能 next-turn）", async () => {
    const followupBad = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k4",
      type: "followup",
      consumeBoundary: "next-step",
      payload: { text: "x" },
    });
    expect(followupBad.statusCode).toBe(400);
    const steerBad = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k5",
      type: "steer",
      consumeBoundary: "next-turn",
      payload: { text: "x" },
    });
    expect(steerBad.statusCode).toBe(400);
  });

  it("steer 带 attemptId → 201 next-step；inject 显式 next-turn 允许", async () => {
    const steer = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k6",
      type: "steer",
      attemptId: "atp_9",
      payload: { text: "换个方向" },
    });
    expect(steer.statusCode).toBe(201);
    expect(steer.json().consumeBoundary).toBe("next-step");
    expect(steer.json().attemptId).toBe("atp_9");

    const inject = await postInbox("ses_ibx", {
      idempotencyKey: "ibx_k7",
      type: "inject",
      consumeBoundary: "next-turn",
      payload: { text: "补充背景" },
    });
    expect(inject.statusCode).toBe(201);
    expect(inject.json().consumeBoundary).toBe("next-turn");
  });

  it("x-plugin-id：未安装插件 → 403", async () => {
    const res = await postInbox(
      "ses_ibx",
      { idempotencyKey: "ibx_k8", type: "inject", payload: { text: "x" } },
      { "x-plugin-id": "plg_missing" },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("plugin_forbidden");
  });

  it("x-plugin-id：已安装但缺 inbox.command 权限 → 403；授权后 → 201 sourceActor=plugin", async () => {
    const install = await app.inject({
      method: "POST",
      url: "/v1/plugins",
      headers,
      payload: { id: "plg_ibx", publisher: "test-pub", version: "1.0.0" },
    });
    expect(install.statusCode).toBe(201);

    const denied = await postInbox(
      "ses_ibx",
      { idempotencyKey: "ibx_k9", type: "inject", payload: { text: "x" } },
      { "x-plugin-id": "plg_ibx" },
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("plugin_permission_denied");

    const grant = await app.inject({
      method: "POST",
      url: "/v1/plugins/plg_ibx/grants",
      headers,
      payload: { permission: "inbox.command", scope: "*" },
    });
    expect(grant.statusCode).toBe(201);

    const ok = await postInbox(
      "ses_ibx",
      { idempotencyKey: "ibx_k9", type: "inject", payload: { text: "x" } },
      { "x-plugin-id": "plg_ibx" },
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.json().sourceActor).toBe("plugin");
  });

  it("followup 消费闭环：创建新 Turn 时注入为该轮输入（ack 后不再重复消费）", async () => {
    await postInbox("ses_fu", {
      idempotencyKey: "ibx_fu_1",
      type: "followup",
      payload: { text: "别忘了复习三角函数" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_fu/turns",
      headers,
      payload: turnPayload,
    });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const rows = (
      await client.execute({
        sql: "SELECT content, role FROM message_versions WHERE turn_id = ? ORDER BY version ASC",
        args: [turnId],
      })
    ).rows as Array<{ content: string; role: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const userVersion = rows.find((r) => r.role === "user");
    expect(userVersion?.content).toContain("别忘了复习三角函数");
    expect(userVersion?.content).toContain("好的");

    // 已消费（claimed→acknowledged），第二次创建 Turn 不再注入
    const second = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_fu/turns",
      headers,
      payload: turnPayload,
    });
    const secondTurnId = second.json().turnId as string;
    const rows2 = (
      await client.execute({
        sql: "SELECT content, role FROM message_versions WHERE turn_id = ? ORDER BY version ASC",
        args: [secondTurnId],
      })
    ).rows as Array<{ content: string; role: string }>;
    expect(rows2.find((r) => r.role === "user")?.content).not.toContain("别忘了复习三角函数");
  });
});