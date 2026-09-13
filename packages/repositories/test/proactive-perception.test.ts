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

const tenant = { workspaceId: "ws_evt", subjectUserId: "usr_evt" } as const;

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
    const first = await repo.ingest(tenant, envelope());
    const second = await repo.ingest(tenant, envelope());
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(true);
    expect(second.sequence!).toBe(first.sequence! + 1);
  });

  it("幂等键重复投递只保留一条", async () => {
    const evt = envelope();
    const first = await repo.ingest(tenant, evt);
    const dup = await repo.ingest(tenant, { ...evt, eventId: "evt_other" });
    expect(first.ingested).toBe(true);
    expect(dup.ingested).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(dup.sequence).toBe(first.sequence);
  });

  it("payload digest 不匹配 fail-closed 拒绝", async () => {
    const evt = envelope({ payloadDigest: "sha256:wrong" });
    const outcome = await repo.ingest(tenant, evt);
    expect(outcome.ingested).toBe(false);
    expect(outcome.reason).toContain("digest mismatch");
  });

  it("未知 schema version 拒绝（未知版本 fail-closed）", async () => {
    const evt = envelope({ schemaVersion: "perception_event_v9" });
    const outcome = await repo.ingest(tenant, evt);
    expect(outcome.ingested).toBe(false);
  });

  it("consume/ack：offset 单调推进且不重复消费", async () => {
    await repo.ingest(tenant, envelope());
    await repo.ingest(tenant, envelope());
    const batch1 = await repo.consume(tenant, "distiller");
    expect(batch1).toHaveLength(2);
    await repo.ack(tenant, "distiller", batch1[1]!.sequence);
    const batch2 = await repo.consume(tenant, "distiller");
    expect(batch2).toHaveLength(0);
  });

  it("ack 不允许回退（单调游标）", async () => {
    await repo.ingest(tenant, envelope());
    await repo.ingest(tenant, envelope());
    await repo.ack(tenant, "c1", 2);
    await repo.ack(tenant, "c1", 1);
    const batch = await repo.consume(tenant, "c1");
    expect(batch).toHaveLength(0);
  });

  it("重放不改 offset", async () => {
    await repo.ingest(tenant, envelope());
    await repo.ingest(tenant, envelope());
    await repo.ack(tenant, "c1", 2);
    const replayed = await repo.replay(tenant, 1);
    expect(replayed.length).toBeGreaterThanOrEqual(2);
    const cursor = await repo.ensureConsumer(tenant, "c1");
    expect(cursor.lastAckedSequence).toBe(2);
  });

  it("处理失败进死信后不再被消费（未知结果不自动重放）", async () => {
    const evt = envelope();
    await repo.ingest(tenant, evt);
    await repo.markDead(tenant, evt.eventId);
    const batch = await repo.consume(tenant, "c1");
    expect(batch).toHaveLength(0);
  });

  it("过期 cursor fail-closed：需重置后才能继续", async () => {
    await repo.ingest(tenant, envelope());
    await repo.ensureConsumer(tenant, "c1");
    const stale = new Date(Date.now() + 60_000);
    await repo.expireStaleConsumers(tenant, stale);
    expect(await repo.consume(tenant, "c1")).toHaveLength(0);
    expect(await repo.resetExpiredConsumer(tenant, "c1")).toBe(true);
    // 重置后从最新 sequence 继续：旧事件不再重放
    const batch = await repo.consume(tenant, "c1");
    expect(batch).toHaveLength(0);
  });

  it("保留压缩：删除早于指定 sequence 的事件", async () => {
    const first = await repo.ingest(tenant, envelope());
    await repo.ingest(tenant, envelope());
    const purged = await repo.purgeBeforeSequence(tenant, first.sequence!);
    expect(purged).toBe(1);
    const remaining = await repo.replay(tenant, 0);
    expect(remaining).toHaveLength(1);
  });
});