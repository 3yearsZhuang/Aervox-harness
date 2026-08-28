/**
 * Aervox｜思隅 @aervox/api — 偏好 API 集成测试（CAP-010 人格问卷与基础偏好）
 *
 * 覆盖：FR-PER-001（问卷/跳过/中性默认值）、FR-PER-002（修改/重置）、BR-PER-001（未配置默认值）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_pref_it",
  "x-user-id": "usr_pref_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

describe("偏好 API 集成测试（CAP-010）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("BR-PER-001：未配置时返回中性默认值", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/preferences",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tone).toBe("neutral");
    expect(res.json().proactiveness).toBe("medium");
    expect(res.json().addressForm).toBe("none");
    expect(res.json().reminderCadence).toBe("moderate");
    expect(res.json().version).toBe(0);
    expect(res.json().skipped).toBe(false);
  });

  it("FR-PER-001：填写问卷", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: {
        tone: "friendly",
        proactiveness: "high",
        addressForm: "casual",
        reminderCadence: "frequent",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tone).toBe("friendly");
    expect(body.proactiveness).toBe("high");
    expect(body.addressForm).toBe("casual");
    expect(body.reminderCadence).toBe("frequent");
    expect(body.version).toBe(1);
    expect(body.skipped).toBe(false);
  });

  it("FR-PER-001：跳过问卷", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: { skipped: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().skipped).toBe(true);
    expect(res.json().version).toBe(1);
  });

  it("FR-PER-002：单项修改", async () => {
    // 先填写
    await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: { tone: "formal", proactiveness: "low", addressForm: "formal", reminderCadence: "gentle" },
    });

    // 修改语气
    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/preferences",
      headers,
      payload: { tone: "friendly" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().tone).toBe("friendly");
    expect(patch.json().proactiveness).toBe("low"); // 未变
    expect(patch.json().version).toBe(2); // 版本递增
  });

  it("FR-PER-002：重置为中性默认值", async () => {
    // 先填写
    await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: { tone: "formal", proactiveness: "high", addressForm: "formal", reminderCadence: "frequent" },
    });

    const reset = await app.inject({
      method: "POST",
      url: "/v1/preferences/reset",
      headers,
    });
    expect(reset.statusCode).toBe(200);
    const body = reset.json();
    expect(body.tone).toBe("neutral");
    expect(body.proactiveness).toBe("medium");
    expect(body.addressForm).toBe("none");
    expect(body.reminderCadence).toBe("moderate");
    expect(body.version).toBe(2); // 重置也是修改
    expect(body.skipped).toBe(false);
  });

  it("租户隔离：不同租户互不干扰", async () => {
    // 租户 A 填写问卷
    await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: { tone: "friendly", proactiveness: "high", addressForm: "casual", reminderCadence: "frequent" },
    });

    // 租户 B 仍是默认值
    const res = await app.inject({
      method: "GET",
      url: "/v1/preferences",
      headers: otherHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(0);
  });

  it("拒绝无效枚举值", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/preferences",
      headers,
      payload: { tone: "aggressive" },
    });
    expect(res.statusCode).toBe(400);
  });
});