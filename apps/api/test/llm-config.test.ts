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

  // ---- 多预设（与人格设定同款：列表/新建/激活/删除） ----

  it("GET /v1/llm/presets 列出预设（初始为空）", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/llm/presets",
      headers: { "x-workspace-id": "ws_api_test", "x-user-id": "usr_api_test" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.presets).toEqual([]);
    expect(body.activeId).toBeNull();
  });

  it("POST /v1/llm/presets 新建预设并激活，切换与删除闭环", async () => {
    const headers = { "x-workspace-id": "ws_api_test", "x-user-id": "usr_api_test" };

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/llm/presets",
      headers,
      payload: {
        name: "本地 Ollama",
        config: {
          enabled: true,
          providerType: "ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          modelId: "llama3.2",
          temperature: 0.7,
          maxTokens: 4096,
        },
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    expect(created.name).toBe("本地 Ollama");
    expect(created.isActive).toBe(true);

    const create2Res = await app.inject({
      method: "POST",
      url: "/v1/llm/presets",
      headers,
      payload: {
        name: "DeepSeek Chat",
        config: {
          enabled: true,
          providerType: "deepseek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-test",
          modelId: "deepseek-chat",
          temperature: 0.5,
          maxTokens: 8192,
        },
      },
    });
    expect(create2Res.statusCode).toBe(201);
    const second = JSON.parse(create2Res.payload);
    expect(second.isActive).toBe(false);

    // 列表：两个预设，活跃为第一个
    const listRes = await app.inject({ method: "GET", url: "/v1/llm/presets", headers });
    const listBody = JSON.parse(listRes.payload);
    expect(listBody.presets).toHaveLength(2);
    expect(listBody.activeId).toBe(created.id);

    // 激活第二个
    const activateRes = await app.inject({
      method: "POST",
      url: `/v1/llm/presets/${second.id}/activate`,
      headers,
    });
    expect(activateRes.statusCode).toBe(200);
    expect(JSON.parse(activateRes.payload).isActive).toBe(true);

    // getConfig 应读取激活的第二个预设
    const configRes = await app.inject({ method: "GET", url: "/v1/llm/config", headers });
    expect(JSON.parse(configRes.payload).modelId).toBe("deepseek-chat");

    // 删除非激活的第一个
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/llm/presets/${created.id}`,
      headers,
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.payload).deleted).toBe(true);

    const finalList = await app.inject({ method: "GET", url: "/v1/llm/presets", headers });
    expect(JSON.parse(finalList.payload).presets).toHaveLength(1);
  });

  it("激活不存在的预设返回 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/presets/not-exist/activate",
      headers: { "x-workspace-id": "ws_api_test", "x-user-id": "usr_api_test" },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).code).toBe("PRESET_NOT_FOUND");
  });

  it("新建预设非法 payload 返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/llm/presets",
      headers: { "x-workspace-id": "ws_api_test", "x-user-id": "usr_api_test" },
      payload: { name: "", config: {} },
    });
    expect(res.statusCode).toBe(400);
  });
});
