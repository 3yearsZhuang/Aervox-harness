/**
 * Aervox｜思隅 @aervox/api — 删除请求创建路由健壮性（ITER-003 切片）
 *
 * 覆盖：重复 target 去重（复合主键冲突不再 500）、同幂等键返回既有请求、
 * 非法载荷 fail-closed 400（缺字段、空 targets、同键不同 ownerModule）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "@aervox/repositories";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = { "x-workspace-id": "ws_delroute", "x-user-id": "usr_delroute" };

describe("POST /v1/deletions（删除请求创建与去重）", () => {
  let app: FastifyInstance;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db: res.db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("创建删除请求：重复 target 去重后落库，不产生主键冲突", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/deletions",
      headers,
      payload: {
        scope: "memory",
        ownerModule: "memory",
        idempotencyKey: "del-dup",
        targets: [
          { targetType: "memory", targetId: "m1", ownerModule: "memory" },
          { targetType: "memory", targetId: "m2", ownerModule: "memory" },
          { targetType: "memory", targetId: "m1", ownerModule: "memory" },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const requestId = JSON.parse(res.payload).id as string;
    const rows = await client.execute({
      sql: "SELECT target_id FROM deletion_targets WHERE request_id = ? ORDER BY target_id",
      args: [requestId],
    });
    expect(rows.rows.map((row) => row.target_id)).toEqual(["m1", "m2"]);
  });

  it("同幂等键重复提交返回既有请求（不重复建目标）", async () => {
    const payload = {
      scope: "memory",
      ownerModule: "memory",
      idempotencyKey: "del-idem",
      targets: [{ targetType: "memory", targetId: "m1", ownerModule: "memory" }],
    };
    const first = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const requestId = JSON.parse(first.payload).id as string;
    expect(JSON.parse(second.payload).id).toBe(requestId);
    const count = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM deletion_targets WHERE request_id = ?",
      args: [requestId],
    });
    expect(Number(count.rows[0]!.n)).toBe(1);
  });

  it("非法载荷 400：缺 scope、空 targets、同键不同 ownerModule", async () => {
    const missingScope = await app.inject({
      method: "POST",
      url: "/v1/deletions",
      headers,
      payload: { ownerModule: "memory" },
    });
    expect(missingScope.statusCode).toBe(400);

    const emptyTargets = await app.inject({
      method: "POST",
      url: "/v1/deletions",
      headers,
      payload: { scope: "memory", ownerModule: "memory", targets: [] },
    });
    expect(emptyTargets.statusCode).toBe(400);

    const conflictingOwner = await app.inject({
      method: "POST",
      url: "/v1/deletions",
      headers,
      payload: {
        scope: "memory",
        ownerModule: "memory",
        targets: [
          { targetType: "memory", targetId: "m1", ownerModule: "memory" },
          { targetType: "memory", targetId: "m1", ownerModule: "other" },
        ],
      },
    });
    expect(conflictingOwner.statusCode).toBe(400);
    expect(JSON.parse(conflictingOwner.payload).error).toContain("ownerModule");
  });
});
