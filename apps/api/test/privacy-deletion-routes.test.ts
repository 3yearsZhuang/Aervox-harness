/**
 * Aervox｜思隅 @aervox/api — 删除请求创建路由健壮性（ITER-003 切片）
 *
 * 覆盖：重复 target 去重（复合主键冲突不再 500）、同幂等键返回既有请求、
 * 非法载荷 fail-closed 400，同键异意图 409 且原请求/目标不变。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
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

  it.each([
    { scope: "account" }, { ownerModule: "other" },
    { targets: [{ targetType: "memory", targetId: "private-replacement", ownerModule: "memory" }] },
    { targets: [{ targetType: "memory", targetId: "m1", ownerModule: "other" }] },
  ])("同幂等键异意图返回 409 且不修改原请求和目标：%j", async change => {
    const payload = { scope: "memory", ownerModule: "memory", idempotencyKey: "immutable-deletion",
      targets: [{ targetType: "memory", targetId: "m1", ownerModule: "memory" }] };
    const first = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload });
    expect(first.statusCode).toBe(202);
    const original = (await client.execute("SELECT * FROM deletion_requests")).rows;
    const originalTargets = (await client.execute("SELECT * FROM deletion_targets")).rows;
    const rejected = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload: { ...payload, ...change } });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ code: "CONFLICT", message: "deletion_intent_conflict", status: 409 });
    expect(rejected.payload).not.toContain("private-replacement");
    expect((await client.execute("SELECT * FROM deletion_requests")).rows).toEqual(original);
    expect((await client.execute("SELECT * FROM deletion_targets")).rows).toEqual(originalTargets);
  });

  it("同意图目标重排与重复项仍返回原受理回执", async () => {
    const targets = [
      { targetType: "memory", targetId: "m1", ownerModule: "memory" },
      { targetType: "memory", targetId: "m2", ownerModule: "memory" },
    ];
    const payload = { scope: "memory", ownerModule: "memory", idempotencyKey: "canonical-deletion", targets };
    const first = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload });
    const replay = await app.inject({ method: "POST", url: "/v1/deletions", headers,
      payload: { ...payload, targets: [targets[1], targets[0], targets[1]] } });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM deletion_targets")).rows[0]!.n)).toBe(2);
  });

  it("目标字段含分隔符时仍按完整元组去重，遗漏任一目标的重试返回 409", async () => {
    const targets = [
      { targetType: "memory\u0000a", targetId: "b", ownerModule: "memory" },
      { targetType: "memory", targetId: "a\u0000b", ownerModule: "memory" },
    ];
    const payload = { scope: "memory", ownerModule: "memory", idempotencyKey: "tuple-safe-deletion", targets };
    const first = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload });
    expect(first.statusCode).toBe(202);
    // libsql's text reader truncates embedded NUL; inspect stored bytes directly.
    const query = "SELECT hex(target_type) AS target_type, hex(target_id) AS target_id, hex(owner_module) AS owner_module FROM deletion_targets";
    const stored = (await client.execute(query)).rows;
    expect(stored).toHaveLength(2);
    const decode = (value: unknown) => Buffer.from(String(value), 'hex').toString('utf8');
    expect(stored.map(row => ({ targetType: decode(row.target_type), targetId: decode(row.target_id), ownerModule: decode(row.owner_module) })))
      .toEqual(expect.arrayContaining(targets));
    const equivalent = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload: { ...payload, targets: [...targets].reverse() } });
    expect(equivalent.statusCode).toBe(202);
    expect(equivalent.json()).toEqual(first.json());
    const replay = await app.inject({ method: "POST", url: "/v1/deletions", headers, payload: { ...payload, targets: [targets[1]] } });
    expect(replay.statusCode).toBe(409);
    expect((await client.execute(query)).rows).toEqual(stored);
  });

  it.each(['scope', 'ownerModule', 'targetOwner'] as const)("含 NUL 的 %s 身份完整返回并可重放，同前缀不同后缀仍冲突", async field => {
    const payload = { scope: field === 'scope' ? 'memory\u0000first' : 'memory',
      ownerModule: field === 'ownerModule' ? 'memory\u0000first' : 'memory', idempotencyKey: `nul-${field}`,
      targets: [{ targetType: 'memory', targetId: 'm1', ownerModule: field === 'targetOwner' ? 'memory\u0000first' : 'memory' }] };
    const first = await app.inject({ method: 'POST', url: '/v1/deletions', headers, payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ scope: payload.scope, ownerModule: payload.ownerModule });
    const replay = await app.inject({ method: 'POST', url: '/v1/deletions', headers, payload });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    const changed = field === 'targetOwner'
      ? { ...payload, targets: [{ ...payload.targets[0], ownerModule: 'memory\u0000second' }] }
      : { ...payload, [field]: 'memory\u0000second' };
    const rejected = await app.inject({ method: 'POST', url: '/v1/deletions', headers, payload: changed });
    expect(rejected.statusCode).toBe(409);
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
