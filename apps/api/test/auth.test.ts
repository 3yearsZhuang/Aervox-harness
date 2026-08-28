import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { createInMemoryDatabase } from "@aervox/database";
import { loadAuthConfig } from "../src/shared/auth.js";

async function buildWith(auth: BuildAppOptions["auth"]) {
  const { db, client, cleanup } = await createInMemoryDatabase();
  const { app } = await buildApp({ db, client, auth });
  await app.ready();
  return { app, cleanup };
}

describe("认证中间件（租户信任模型加固）", () => {
  it("open 模式（默认）免认证放行", async () => {
    const { app, cleanup } = await buildWith(undefined);
    try {
      const res = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
      await cleanup();
    }
  });

  it("token 模式：缺失 / 错误 token 一律 401 短路", async () => {
    const { app, cleanup } = await buildWith({ mode: "token", token: "s3cret-token" });
    try {
      const missing = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(missing.statusCode).toBe(401);
      const wrong = await app.inject({
        method: "GET",
        url: "/openapi.json",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(wrong.statusCode).toBe(401);
      const malformed = await app.inject({
        method: "GET",
        url: "/openapi.json",
        headers: { authorization: "Weird s3cret-token" },
      });
      expect(malformed.statusCode).toBe(401);
    } finally {
      await app.close();
      await cleanup();
    }
  });

  it("token 模式：正确 token 放行并正常进入业务路由", async () => {
    const { app, cleanup } = await buildWith({ mode: "token", token: "s3cret-token" });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/llm/config",
        headers: {
          authorization: "Bearer s3cret-token",
          "x-workspace-id": "ws_auth_test",
          "x-user-id": "usr_auth_test",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as { providerType?: string };
      expect(body.providerType).toBe("ollama");
    } finally {
      await app.close();
      await cleanup();
    }
  });

  it("loadAuthConfig：缺省 open，token 模式需显式声明密钥", () => {
    expect(loadAuthConfig({}).mode).toBe("open");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "TOKEN", AERVOX_AUTH_TOKEN: "x" }).mode).toBe("token");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "TOKEN", AERVOX_AUTH_TOKEN: "x" }).token).toBe("x");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "token" }).token).toBeUndefined();
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "token" }).mode).toBe("token");
  });
});