import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase } from "@aervox/database";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../src/shared/errors.js";

describe("统一错误序列化（缺陷6）", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    const built = await buildApp({ db: res.db, client: res.client });
    app = built.app;
    cleanup = res.cleanup;
    // 测试专用路由：抛各类 ApiError，验证 setErrorHandler 统一映射
    app.get("/__test/:kind", async (_req, reply) => {
      const kind = (_req.params as { kind: string }).kind;
      if (kind === "not-found") throw new NotFoundError("user not found");
      if (kind === "validation") throw new ValidationError("bad input");
      if (kind === "conflict") throw new ConflictError("already exists");
      reply.code(200).send({ ok: true });
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    await cleanup();
  });

  it("NotFoundError → 404 { error, code: NOT_FOUND, message }", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/not-found" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload)).toEqual({
      error: "NotFoundError",
      code: "NOT_FOUND",
      message: "user not found",
    });
  });

  it("ValidationError → 400 { error, code: VALIDATION_FAILED, message }", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/validation" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({
      error: "ValidationError",
      code: "VALIDATION_FAILED",
      message: "bad input",
    });
  });

  it("ConflictError → 409 { error, code: CONFLICT, message }", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/conflict" });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload)).toEqual({
      error: "ConflictError",
      code: "CONFLICT",
      message: "already exists",
    });
  });

  it("未命中路由仍为 Fastify 默认 404（非业务异常不改写）", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/no-such-endpoint-xyz" });
    expect(res.statusCode).toBe(404);
  });
});