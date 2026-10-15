/**
 * Aervox｜思隅 E2E — 偏好端到端测试（CAP-010 人格问卷与基础偏好）
 *
 * 覆盖：FR-PER-001（问卷/跳过）、FR-PER-002（修改/重置）、BR-PER-001（中性默认值）
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = {
  "x-workspace-id": "ws_e2e_pref",
  "x-user-id": "usr_e2e_pref",
};

test.describe("偏好 E2E（CAP-010）", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("preferences");

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

  test("BR-PER-001：未配置时返回中性默认值", async ({ request }) => {
    const res = await request.get(`${baseURL}/v1/preferences`, { headers });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.tone).toBe("neutral");
    expect(body.proactiveness).toBe("medium");
    expect(body.addressForm).toBe("none");
    expect(body.reminderCadence).toBe("moderate");
    expect(body.version).toBe(0);
  });

  test("FR-PER-001：填写问卷", async ({ request }) => {
    const res = await request.post(`${baseURL}/v1/preferences`, {
      headers,
      data: { tone: "friendly", proactiveness: "high", addressForm: "casual", reminderCadence: "frequent" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.tone).toBe("friendly");
    expect(body.proactiveness).toBe("high");
    expect(body.addressForm).toBe("casual");
    expect(body.reminderCadence).toBe("frequent");
    expect(body.skipped).toBe(false);
  });

  test("FR-PER-001：跳过问卷", async ({ request }) => {
    const res = await request.post(`${baseURL}/v1/preferences`, {
      headers,
      data: { skipped: true },
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).skipped).toBe(true);
  });

  test("FR-PER-002：单项修改后版本递增", async ({ request }) => {
    // 先填写
    await request.post(`${baseURL}/v1/preferences`, {
      headers,
      data: { tone: "formal", proactiveness: "low", addressForm: "formal", reminderCadence: "gentle" },
    });

    // 单项修改
    const patch = await request.patch(`${baseURL}/v1/preferences`, {
      headers,
      data: { tone: "friendly" },
    });
    expect(patch.status()).toBe(200);
    const body = await patch.json();
    expect(body.tone).toBe("friendly");
    expect(body.proactiveness).toBe("low");
    expect(body.version).toBeGreaterThanOrEqual(2);
  });

  test("FR-PER-002：重置为中性默认值", async ({ request }) => {
    await request.post(`${baseURL}/v1/preferences`, {
      headers,
      data: { tone: "formal", proactiveness: "high", addressForm: "formal", reminderCadence: "frequent" },
    });

    const reset = await request.post(`${baseURL}/v1/preferences/reset`, { headers });
    expect(reset.status()).toBe(200);
    const body = await reset.json();
    expect(body.tone).toBe("neutral");
    expect(body.proactiveness).toBe("medium");
    expect(body.addressForm).toBe("none");
    expect(body.reminderCadence).toBe("moderate");
    expect(body.skipped).toBe(false);
  });

  test("拒绝无效枚举值", async ({ request }) => {
    const res = await request.post(`${baseURL}/v1/preferences`, {
      headers,
      data: { tone: "aggressive" },
    });
    expect(res.status()).toBe(400);
  });
});