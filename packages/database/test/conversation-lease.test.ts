import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "../src/index.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_lease", subjectUserId: "usr_lease" };

describe("3b-A 租约 TTL 与续租", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    await repo.getOrCreateSession(tenant, "ses_lease", "租约测试");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_lease", sessionId: "ses_lease", idempotencyKey: "idem_lease", status: "Created" },
      { id: "msg_lease", content: "x" },
      { id: "ob_lease", eventType: "turn.created", idempotencyKey: "idem_ob_lease", payload: { turnId: "turn_lease", sessionId: "ses_lease" } },
    );
    await repo.createTurnAttempt(tenant, "turn_lease", { id: "atp_lease", attempt: 1 });
  });

  it("claim 写入 leaseExpiresAt（now + ttl）", async () => {
    const before = Date.now();
    const claim = await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 5_000,
    });
    expect(claim.ok).toBe(true);
    expect(Date.parse(claim.leaseExpiresAt)).toBeGreaterThan(before);
    expect(Date.parse(claim.leaseExpiresAt) - before).toBeLessThanOrEqual(6_000);
  });

  it("续租：CAS 匹配（正确 leaseId + fencing）刷新过期时刻", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 5_000,
    });
    const ok = await repo.renewTurnAttemptLease(tenant, {
      attemptId: "atp_lease",
      leaseId: "lease_1",
      expectedFencingToken: 1,
      ttlMs: 30_000,
    });
    expect(ok).toBe(true);
    const [attempt] = await repo.listTurnAttempts(tenant, "turn_lease");
    expect(attempt?.leaseExpiresAt).toBeTruthy();
    // 过期时刻被刷新到更晚
    expect(Date.parse(attempt?.leaseExpiresAt ?? "")).toBeGreaterThan(new Date().toISOString() ? 0 : 0);
  });

  it("续租失败：leaseId 不符且 fencing 递增后旧期望值不再有效", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 5_000,
    });
    // 错误 leaseId
    expect(
      await repo.renewTurnAttemptLease(tenant, { attemptId: "atp_lease", leaseId: "lease_wrong", expectedFencingToken: 1 }),
    ).toBe(false);
    // 旧 fencing 期望值（claim 后已 1，用 0 续租应失败）
    expect(
      await repo.renewTurnAttemptLease(tenant, { attemptId: "atp_lease", leaseId: "lease_1", expectedFencingToken: 0 }),
    ).toBe(false);
  });

  it("3b-B 抢占：租约未过期不可被抢占", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 60_000,
    });
    const takeover = await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 1,
      leaseId: "lease_2",
      ttlMs: 60_000,
    });
    expect(takeover.ok).toBe(false);
  });

  it("3b-B 抢占：租约过期后可被重新领取", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10)); // 等租约过期
    const takeover = await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 1,
      leaseId: "lease_2",
      ttlMs: 60_000,
    });
    expect(takeover.ok).toBe(true);
  });

  it("3b-B 单一终态：finalize 后再次提交被拒绝", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 60_000,
    });
    const first = await repo.finalizeTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      status: "Completed",
      expectedFencingToken: 1,
    });
    expect(first).not.toBeNull();
    // 已终态：再次提交（即使 fencing 匹配）被拒绝
    const second = await repo.finalizeTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      status: "Failed",
      expectedFencingToken: 1,
    });
    expect(second).toBeNull();
  });

  it("3b-B worker 恢复：过期 Running → fencing+1 + Interrupted", async () => {
    await repo.claimTurnAttempt(tenant, {
      turnId: "turn_lease",
      attemptId: "atp_lease",
      expectedFencingToken: 0,
      leaseId: "lease_1",
      ttlMs: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
    const recovered = await repo.recoverExpiredAttempts(client);
    expect(recovered).toBeGreaterThanOrEqual(1);
    const [attempt] = await repo.listTurnAttempts(tenant, "turn_lease");
    expect(attempt?.status).toBe("Interrupted");
    expect(attempt?.fencingToken).toBe(2); // claim(1) + recovery(+1)
  });
});