import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import { createInMemoryDatabase } from "@aervox/repositories";
import { assertSafeApiListenHost, loadAuthConfig } from "../src/shared/auth.js";
import { resolveLocalContext } from "../src/shared/local-context.js";
import type { FastifyRequest } from "fastify";

async function buildWith(auth: BuildAppOptions["auth"]) {
  const { db, client, cleanup } = await createInMemoryDatabase();
  const { app } = await buildApp({ db, client, auth });
  await app.ready();
  return { app, cleanup };
}

describe("本机 API 认证中间件", () => {
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

  it("token 模式：正确 token 直接使用本地单用户上下文", async () => {
    const { app, cleanup } = await buildWith({
      mode: "token",
      token: "s3cret-token",
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/v1/llm/config",
        headers: {
          authorization: "Bearer s3cret-token",
          // 遗留客户端即使发送旧 Header，也不会改变本地单用户上下文。
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

  it("loadAuthConfig：缺省 open，token 模式需显式声明密钥", () => {
    expect(loadAuthConfig({}).mode).toBe("open");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "TOKEN", AERVOX_AUTH_TOKEN: "x" }).mode).toBe("token");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "TOKEN", AERVOX_AUTH_TOKEN: "x" }).token).toBe("x");
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "token" }).token).toBeUndefined();
    expect(loadAuthConfig({ AERVOX_AUTH_MODE: "token" }).mode).toBe("token");
  });

  it("open 认证禁止非 loopback 监听，token 认证允许显式远程监听", () => {
    expect(() => assertSafeApiListenHost("127.0.0.1", "open")).not.toThrow();
    expect(() => assertSafeApiListenHost("0.0.0.0", "open")).toThrow(/non-loopback/);
    expect(() => assertSafeApiListenHost("0.0.0.0", "token")).not.toThrow();
  });

  it("旧租户 Header 不会进入本地上下文", () => {
    const request = {
      headers: {
        "x-workspace-id": "ws_forged",
        "x-user-id": "usr_forged",
        "x-actor-id": "actor_forged",
      },
    } as unknown as FastifyRequest;
    expect(resolveLocalContext(request)).toEqual({
      workspaceId: "local",
      subjectUserId: "local",
    });
  });

  it("loadAuthConfig：只读取 token 与可选审计主体", () => {
    const cfg = loadAuthConfig({
      AERVOX_AUTH_MODE: "TOKEN",
      AERVOX_AUTH_TOKEN: "x",
      AERVOX_AUTH_ACTOR: "act_cfg",
    });
    expect(cfg).not.toHaveProperty("workspaceId");
    expect(cfg).not.toHaveProperty("subjectUserId");
    expect(cfg.actorId).toBe("act_cfg");
  });
});
