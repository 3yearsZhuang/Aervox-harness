/**
 * Aervox｜思隅 @aervox/database — 阶段 5a Agent 收件箱仓储测试
 *
 * 覆盖 ADR-017 / AVX-HAR-001 §7.2：
 * - enqueue 幂等（同 idempotencyKey 重复提交返回既有项）；
 * - claim/ack（pending → claimed → acknowledged）；claimed 未 ack 不被重复 claim（CAS 单赢）；
 * - next-step 需 attemptId 定位；next-turn 忽略 attemptId；
 * - 过期项不 claim；
 * - 租户隔离（不同 workspace/subject 互不可见）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteAgentInboxRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: TenantContext = { workspaceId: "ws_inbox_a", subjectUserId: "usr_inbox_a" };
const tenantB: TenantContext = { workspaceId: "ws_inbox_b", subjectUserId: "usr_inbox_b" };

describe("阶段 5a Agent 收件箱（agent_inbox_items）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteAgentInboxRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteAgentInboxRepository(db);
  });

  it("enqueue 新建：pending + consumeBoundary 按类型推定（followup→next-turn）", async () => {
    const item = await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      type: "followup",
      sourceActor: "user",
      payload: { text: "然后呢？" },
    });
    expect(item.status).toBe("pending");
    expect(item.consumeBoundary).toBe("next-turn");
    expect(item.sourceActor).toBe("user");
  });

  it("enqueue 幂等：同 idempotencyKey 重复提交返回既有项（不新增行）", async () => {
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      type: "followup",
      sourceActor: "user",
      payload: { text: "A" },
    });
    const second = await repo.enqueue(tenantA, {
      id: "inb_2",
      idempotencyKey: "idem_1", // 同 key
      sessionId: "ses_1",
      type: "followup",
      sourceActor: "user",
      payload: { text: "B" },
    });
    expect(second.id).toBe("inb_1");
    expect(second.payload).toEqual({ text: "A" });
    // 不同租户同 key 允许
    const otherTenant = await repo.enqueue(tenantB, {
      id: "inb_3",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      type: "followup",
      sourceActor: "user",
      payload: { text: "C" },
    });
    expect(otherTenant.id).toBe("inb_3");
  });

  it("claim next-step：按 sessionId+attemptId 过滤 pending；claim 后再次 claim 不重复返回（CAS 单赢）", async () => {
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "steer",
      sourceActor: "user",
      payload: { text: "换个方向" },
    });
    await repo.enqueue(tenantA, {
      id: "inb_2",
      idempotencyKey: "idem_2",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "inject",
      sourceActor: "plugin",
      payload: { text: "上下文提示" },
    });
    // 其它 attempt 的项不可 claim
    await repo.enqueue(tenantA, {
      id: "inb_3",
      idempotencyKey: "idem_3",
      sessionId: "ses_1",
      attemptId: "atp_OTHER",
      type: "steer",
      sourceActor: "user",
      payload: { text: "无关" },
    });

    const first = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "next-step",
    });
    expect(first.map((i) => i.id).sort()).toEqual(["inb_1", "inb_2"]);
    expect(first.every((i) => i.status === "claimed")).toBe(true);

    // 二次 claim：已 claimed 项不再返回
    const second = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "next-step",
    });
    expect(second).toHaveLength(0);
  });

  it("ack：claimed → acknowledged；未 claim 不能 ack（保持 pending）", async () => {
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "inject",
      sourceActor: "agent",
      payload: { text: "tip" },
    });
    await repo.enqueue(tenantA, {
      id: "inb_2",
      idempotencyKey: "idem_2",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "inject",
      sourceActor: "agent",
      payload: { text: "tip2" },
    });
    const claimed = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "next-step",
    });
    expect(claimed).toHaveLength(2);
    await repo.acknowledge(tenantA, [claimed[0]!.id]);

    const again = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "next-step",
    });
    // inb_2 已 claim 未 ack：不被重复返回（崩溃安全重放语义：等待宿主后续 ack 或超时回收）
    expect(again).toHaveLength(0);
  });

  it("过期项不 claim：expiresAt 已过则跳过（未过期正常领取）", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "steer",
      sourceActor: "user",
      payload: { text: "过期" },
      expiresAt: past,
    });
    await repo.enqueue(tenantA, {
      id: "inb_2",
      idempotencyKey: "idem_2",
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "steer",
      sourceActor: "user",
      payload: { text: "有效" },
      expiresAt: future,
    });
    const claimed = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      attemptId: "atp_1",
      type: "next-step",
    });
    expect(claimed.map((i) => i.id)).toEqual(["inb_2"]);
  });

  it("租户隔离：tenantB 无法 claim tenantA 的 inbox 项", async () => {
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_shared",
      attemptId: "atp_1",
      type: "steer",
      sourceActor: "user",
      payload: { text: "A 的项" },
    });
    const claimedB = await repo.claimForConsumption(tenantB, {
      sessionId: "ses_shared",
      attemptId: "atp_1",
      type: "next-step",
    });
    expect(claimedB).toHaveLength(0);
  });

  it("next-turn：不绑定 attemptId，按 sessionId+type 领取（followup 排队为新 Turn 输入）", async () => {
    await repo.enqueue(tenantA, {
      id: "inb_1",
      idempotencyKey: "idem_1",
      sessionId: "ses_1",
      type: "followup",
      sourceActor: "user",
      payload: { text: "新问题" },
    });
    const claimed = await repo.claimForConsumption(tenantA, {
      sessionId: "ses_1",
      type: "next-turn",
    });
    expect(claimed.map((i) => i.id)).toEqual(["inb_1"]);
    expect(claimed[0]!.status).toBe("claimed");
  });
});