import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import type { Client } from "@libsql/client";

describe("LLM Config API (CR-012)", () => {
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
    if (app) await app.close();
    await cleanup();
  });

  it("GET /v1/llm/config 返回默认配置", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/llm/config",
      headers: {
        "x-workspace-id": "ws_api_test",
        "x-user-id": "usr_api_test",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.enabled).toBe(true);
    expect(body.providerType).toBe("ollama");
    expect(body.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(body.modelId).toBe("llama3.2");
  });

  it("PUT /v1/llm/config 保存并更新配置", async () => {
    const updatePayload = {
      enabled: true,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-deepseek-test",
      modelId: "deepseek-chat",
      temperature: 0.6,
      maxTokens: 4096,
      settings: { stream: true },
    };

    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/llm/config",
      headers: {
        "x-workspace-id": "ws_api_test",
        "x-user-id": "usr_api_test",
      },
      payload: updatePayload,
    });

    expect(putRes.statusCode).toBe(200);
    const putBody = JSON.parse(putRes.payload);
    expect(putBody.providerType).toBe("deepseek");
    expect(putBody.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(putBody.apiKey).toBe("sk-deepseek-test");
    expect(putBody.modelId).toBe("deepseek-chat");
    expect(putBody.temperature).toBe(0.6);

    const getRes = await app.inject({
      method: "GET",
      url: "/v1/llm/config",
      headers: {
        "x-workspace-id": "ws_api_test",
        "x-user-id": "usr_api_test",
      },
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.payload);
    expect(getBody.modelId).toBe("deepseek-chat");
    expect(getBody.providerType).toBe("deepseek");
  });

  it("PUT /v1/llm/config 非法 payload 返回 400", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/llm/config",
      headers: {
        "x-workspace-id": "ws_api_test",
        "x-user-id": "usr_api_test",
      },
      payload: {
        providerType: "unknown_provider",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/llm/test-connection 测试连通性", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/test-connection",
      headers: {
        "x-workspace-id": "ws_api_test",
        "x-user-id": "usr_api_test",
      },
      payload: {
        providerType: "ollama",
        baseUrl: "http://127.0.0.1:9999/v1", // 不可达端口
        modelId: "llama3.2",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.latencyMs).toBe("number");
    expect(typeof body.message).toBe("string");
  });

  it("OPTIONS preflight 请求支持 PUT 等 CORS 方法", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/llm/config",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,x-workspace-id,x-user-id",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
  });
});
