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

  it("token 模式：正确 token + 已绑定租户配置放行（请求头被忽略）", async () => {
    const { app, cleanup } = await buildWith({
      mode: "token",
      token: "s3cret-token",
      workspaceId: "ws_bound",
      subjectUserId: "usr_bound",
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/llm/config",
        headers: {
          authorization: "Bearer s3cret-token",
          // 即使伪造请求头，也不应改变 token 绑定的租户身份
          "x-workspace-id": "ws_forged",
          "x-user-id": "usr_forged",
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

  it("token 模式：正确 token 但未绑定租户配置 → 500 fail-closed", async () => {
    const { app, cleanup } = await buildWith({ mode: "token", token: "s3cret-token" });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/llm/config",
        headers: { authorization: "Bearer s3cret-token" },
      });
      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload) as { code?: string };
      expect(body.code).toBe("AUTH_NOT_CONFIGURED");
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

  it("loadAuthConfig：读取 token 模式绑定的租户身份配置", () => {
    const cfg = loadAuthConfig({
      AERVOX_AUTH_MODE: "TOKEN",
      AERVOX_AUTH_TOKEN: "x",
      AERVOX_AUTH_WORKSPACE: "ws_cfg",
      AERVOX_AUTH_USER: "usr_cfg",
      AERVOX_AUTH_ACTOR: "act_cfg",
    });
    expect(cfg.workspaceId).toBe("ws_cfg");
    expect(cfg.subjectUserId).toBe("usr_cfg");
    expect(cfg.actorId).toBe("act_cfg");
  });
});