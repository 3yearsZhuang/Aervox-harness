/**
 * CR-033 E3 感知事件流 Port 测试。
 *
 * 覆盖：原子 sequence、幂等去重、digest 校验 fail-closed、
 * consumer offset/ACK 单调、重放、死信、过期 cursor、保留压缩。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import type { PerceptionEventEnvelope } from "@aervox/contracts";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  perceptionPayloadDigest,
  SqlitePerceptionEventRepository,
  type AervoxDatabase,
} from "../src/index.js";

const ctx = { workspaceId: "ws_evt", subjectUserId: "usr_evt" } as const;

let seq = 0;
const envelope = (overrides: Partial<PerceptionEventEnvelope> = {}): PerceptionEventEnvelope => {
  seq += 1;
  const payload = overrides.payload ?? { text: `clip-${seq}` };
  return {
    version: "perception_event_v1",
    eventId: `evt_${seq}`,
    idempotencyKey: `idem_${seq}`,
    source: "device.clipboard",
    deviceId: "dev_1",
    activationEpoch: "epoch_1",
    sourceGrantId: "grant_1",
    occurredAt: "2026-09-14T05:00:00.000Z",
    ingestedAt: "2026-09-14T05:00:01.000Z",
    sequence: 0,
    payloadDigest: perceptionPayloadDigest(payload),
    schemaVersion: "perception_event_v1",
    payload,
    ...overrides,
  };
};

describe("CR-033 E3 感知事件流", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqlitePerceptionEventRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    repo = new SqlitePerceptionEventRepository(db);
  });

  it("摄入分配原子单调 sequence", async () => {
    const first = await repo.ingest(ctx, envelope());
    const second = await repo.ingest(ctx, envelope());
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(true);
    expect(second.sequence!).toBe(first.sequence! + 1);
  });

  it("并发摄入不同事件不丢失且 sequence 唯一", async () => {
    const events = Array.from({ length: 16 }, () => envelope());
    const outcomes = await Promise.all(events.map((event) => repo.ingest(ctx, event)));
    expect(outcomes.every((outcome) => outcome.ingested)).toBe(true);
    expect(new Set(outcomes.map((outcome) => outcome.sequence)).size).toBe(events.length);
  });

  it("幂等键重复投递只保留一条", async () => {
    const evt = envelope();
    const first = await repo.ingest(ctx, evt);
    const dup = await repo.ingest(ctx, { ...evt, eventId: "evt_other" });
    expect(first.ingested).toBe(true);
    expect(dup.ingested).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(dup.sequence).toBe(first.sequence);
  });

  it("payload digest 不匹配 fail-closed 拒绝", async () => {
    const evt = envelope({ payloadDigest: "sha256:wrong" });
    const outcome = await repo.ingest(ctx, evt);
    expect(outcome.ingested).toBe(false);
    expect(outcome.reason).toContain("digest mismatch");
  });

  it("未知 schema version 拒绝（未知版本 fail-closed）", async () => {
    const evt = envelope({ schemaVersion: "perception_event_v9" });
    const outcome = await repo.ingest(ctx, evt);
    expect(outcome.ingested).toBe(false);
  });

  it("consume/ack：offset 单调推进且不重复消费", async () => {
    await repo.ingest(ctx, envelope());
    await repo.ingest(ctx, envelope());
    const batch1 = await repo.consume(ctx, "distiller");
    expect(batch1).toHaveLength(2);
    await repo.ack(ctx, "distiller", batch1[1]!.sequence);
    const batch2 = await repo.consume(ctx, "distiller");
    expect(batch2).toHaveLength(0);
  });

  it("ack 不允许回退（单调游标）", async () => {
    await repo.ingest(ctx, envelope());
    await repo.ingest(ctx, envelope());
    await repo.ack(ctx, "c1", 2);
    await repo.ack(ctx, "c1", 1);
    const batch = await repo.consume(ctx, "c1");
    expect(batch).toHaveLength(0);
  });

  it("ack 不允许跳过尚不存在的未来事件", async () => {
    const current = await repo.ingest(ctx, envelope());
    await expect(repo.ack(ctx, "c1", current.sequence! + 1)).rejects.toThrow("invalid perception ACK");
  });

  it("重放不改 offset", async () => {
    await repo.ingest(ctx, envelope());
    await repo.ingest(ctx, envelope());
    await repo.ack(ctx, "c1", 2);
    const replayed = await repo.replay(ctx, 1);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    const cursor = await repo.ensureConsumer(ctx, "c1");
    expect(cursor.lastAckedSequence).toBe(2);
  });

  it("处理失败进死信后不再被消费（未知结果不自动重放）", async () => {
    const evt = envelope();
    await repo.ingest(ctx, evt);
    await repo.markDead(ctx, evt.eventId);
    const batch = await repo.consume(ctx, "c1");
    expect(batch).toHaveLength(0);
  });

  it("过期 cursor fail-closed：需重置后才能继续", async () => {
    await repo.ingest(ctx, envelope());
    await repo.ensureConsumer(ctx, "c1");
    const stale = new Date(Date.now() + 60_000);
    await repo.expireStaleConsumers(ctx, stale);
    expect(await repo.consume(ctx, "c1")).toHaveLength(0);
    expect(await repo.resetExpiredConsumer(ctx, "c1")).toBe(true);
    // 重置后从最新 sequence 继续：旧事件不再重放
    const batch = await repo.consume(ctx, "c1");
    expect(batch).toHaveLength(0);
  });

  it("保留压缩：删除早于指定 sequence 的事件", async () => {
    const first = await repo.ingest(ctx, envelope());
    const second = await repo.ingest(ctx, envelope());
    await repo.ensureConsumer(ctx, "distiller");
    await repo.ack(ctx, "distiller", first.sequence!);
    await repo.ensureConsumer(ctx, "projector");
    await repo.ack(ctx, "projector", second.sequence!);
    const purged = await repo.purgeBeforeSequence(ctx, first.sequence!);
    expect(purged).toBe(1);
    const remaining = await repo.replay(ctx, 0);
    expect(remaining).toHaveLength(1);
  });

  it("任一活跃消费者未 ACK 时禁止越过其游标压缩", async () => {
    const first = await repo.ingest(ctx, envelope());
    const second = await repo.ingest(ctx, envelope());
    await repo.ack(ctx, "fast", second.sequence!);
    await repo.ack(ctx, "slow", first.sequence!);
    expect(await repo.purgeBeforeSequence(ctx, second.sequence!)).toBe(1);
    expect((await repo.replay(ctx, 0)).map((event) => event.sequence)).toEqual([second.sequence]);
  });
});
