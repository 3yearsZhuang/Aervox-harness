/**
 * Aervox｜思隅 @aervox/database — E：授权快照幂等 + 安全片段原子化（§12.2）
 *
 * - recordToolApproval 幂等：同 (toolName, argumentsHash) 已存在 pending 则复用既有行，
 *   不重复插入（授权匹配键跨 turn 复用）；granted/denied 后新请求才新建。
 * - recordSafeSegmentAtomically：安全片段 + delta 事件同事务，fencing 失配抛
 *   FencingMismatchError 且无部分写入；listCommittedSegments 返回可见前缀。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository, type AervoxDatabase, type TenantContext } from "../src/index.js";
import { FencingMismatchError } from "../src/errors.js";
import type { Client } from "@libsql/client";

const tenant: TenantContext = { workspaceId: "ws_e", subjectUserId: "usr_e" };

describe("E1 授权快照幂等（recordToolApproval）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    await repo.getOrCreateSession(tenant, "ses_e1", "E1 授权幂等");
    await repo.createTurnWithOutbox(
      tenant,
      { id: "turn_e1", sessionId: "ses_e1", idempotencyKey: "idem_e1", status: "Created" },
      { id: "msg_e1", content: "x" },
    );
    await repo.createTurnAttempt(tenant, "turn_e1", { id: "atp_e1", attempt: 1 });
  });

  it("同 (toolName, argumentsHash) 重复 pending → 复用既有行，不重复插入", async () => {
    const first = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_x",
      requester: "usr_e", state: "pending",
    });
    const second = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_x",
      requester: "usr_e", state: "pending",
    });
    expect(second.id).toBe(first.id); // 复用
    const all = await repo.listToolApprovalsByTurn(tenant, "turn_e1");
    expect(all.filter((a) => a.state === "pending")).toHaveLength(1);
  });

  it("不同 argumentsHash → 各自新建", async () => {
    const a = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_1",
      requester: "usr_e", state: "pending",
    });
    const b = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_2",
      requester: "usr_e", state: "pending",
    });
    expect(b.id).not.toBe(a.id);
  });

  it("pending 被决定后（granted）再请求同参数 → 新建新 pending（不复用已决）", async () => {
    const pending = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_g",
      requester: "usr_e", state: "pending",
    });
    await repo.decideToolApproval(tenant, pending.id, "granted", "admin");
    const again = await repo.recordToolApproval(tenant, {
      turnId: "turn_e1", attemptId: "atp_e1", toolName: "aervox_save_note", argumentsHash: "hash_g",
      requester: "usr_e", state: "pending",
    });
    expect(again.id).not.toBe(pending.id);
    expect(again.state).toBe("pending");
  });
});

describe("E2 安全片段原子化（safe_segments）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let seq = 0;

  const nextTurn = async (): Promise<{ turnId: string; attemptId: string }> => {
    const n = (++seq).toString(36);
    const turnId = `turn_e2_${n}`;
    const sessionId = `ses_e2_${n}`;
    await repo.getOrCreateSession(tenant, sessionId, "E2 安全片段");
    await repo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey: `idem_${turnId}`, status: "Created" },
      { id: `msg_${turnId}`, content: "x" },
      { id: `ob_${turnId}`, eventType: "turn.created", idempotencyKey: `idem_ob_${turnId}`, payload: { turnId } },
    );
    const attemptId = `atp_e2_${n}`;
    await repo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    return { turnId, attemptId };
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
  });

  it("recordSafeSegmentAtomically：安全片段 + delta 事件同事务写入", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_e2a", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    const ok = await repo.recordSafeSegmentAtomically(tenant, {
      turnId, attemptId, sequence: 2, text: "第一段", eventData: { text: "第一段", isFinal: false },
      safetyDecision: "approved", expectedFencingToken: claim.fencingToken,
    });
    expect(ok).toBe(true);

    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events.some((e) => e.eventType === "delta" && (e.data as { text?: string })?.text === "第一段")).toBe(true);
    const segments = await repo.listCommittedSegments(tenant, turnId);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ sequence: 2, text: "第一段" });
    expect(segments[0]!.streamEventId).toBeTruthy(); // 已关联事件
  });

  it("recordSafeSegmentAtomically：fencing 失配 → 抛错且无部分写入", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_e2b", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;

    await expect(
      repo.recordSafeSegmentAtomically(tenant, {
        turnId, attemptId, sequence: 2, text: "迟到", eventData: { text: "迟到" },
        safetyDecision: "approved", expectedFencingToken: claim.fencingToken + 100,
      }),
    ).rejects.toThrow(FencingMismatchError);

    // 无部分写入：无 delta 事件、无安全片段
    const events = await repo.getStreamEvents(tenant, turnId, 0);
    expect(events.some((e) => e.eventType === "delta")).toBe(false);
    expect(await repo.listCommittedSegments(tenant, turnId)).toHaveLength(0);
  });

  it("listCommittedSegments：按 sequence 升序返回可见前缀", async () => {
    const { turnId, attemptId } = await nextTurn();
    const claim = await repo.claimTurnAttempt(tenant, { turnId, attemptId, expectedFencingToken: 0, leaseId: "lease_e2c", ttlMs: 60_000 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    for (const [seqNo, text] of [[2, "第一"], [3, "第二"], [1, "零"]]) {
      await repo.recordSafeSegmentAtomically(tenant, {
        turnId, attemptId, sequence: seqNo, text, eventData: { text }, safetyDecision: "approved",
        expectedFencingToken: claim.fencingToken,
      });
    }
    const segments = await repo.listCommittedSegments(tenant, turnId);
    expect(segments.map((s) => s.text)).toEqual(["零", "第一", "第二"]);
  });
});