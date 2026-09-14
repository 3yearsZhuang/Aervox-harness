/**
 * Aervox｜思隅 @aervox/repositories — CR-034/CR-042 模型路由仓储测试
 *
 * 覆盖：
 * - 健康探测快照 save/get/list，幂等 upsert；
 * - 连续成功/失败计数及迟滞状态更新；
 * - 切层审计事件 record/list/listForSession 追溯与时序排序。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteModelRoutingRepository,
  type AervoxDatabase,
} from "../src/index.js";
import type { HealthSnapshot, ModelRoutingEvent } from "@aervox/contracts";

describe("SqliteModelRoutingRepository (CR-034 / CR-042)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteModelRoutingRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    repo = new SqliteModelRoutingRepository(db);
  });

  it("健康快照保存、查询与幂等更新", async () => {
    const snap1: HealthSnapshot = {
      presetId: "preset_cloud_1",
      providerType: "deepseek",
      endpointIdentity: "api.deepseek.com:443",
      status: "healthy",
      consecutiveSuccesses: 1,
      consecutiveFailures: 0,
      latencyMs: 120,
      lastProbeAt: "2026-09-14T10:00:00.000Z",
      lastSuccessAt: "2026-09-14T10:00:00.000Z",
      lastFailureAt: null,
      errorCategory: null,
      errorMessage: null,
      cooldownUntil: null,
    };

    await repo.saveHealthSnapshot(snap1);

    const found = await repo.getHealthSnapshot("preset_cloud_1");
    expect(found).not.toBeNull();
    expect(found?.status).toBe("healthy");
    expect(found?.latencyMs).toBe(120);
    expect(found?.consecutiveSuccesses).toBe(1);

    // 发生失败后的幂等更新
    const snap1Updated: HealthSnapshot = {
      ...snap1,
      status: "degraded",
      consecutiveSuccesses: 0,
      consecutiveFailures: 1,
      latencyMs: 5000,
      lastProbeAt: "2026-09-14T10:01:00.000Z",
      lastFailureAt: "2026-09-14T10:01:00.000Z",
      errorCategory: "timeout",
      errorMessage: "Probe timeout after 5000ms",
    };

    await repo.saveHealthSnapshot(snap1Updated);

    const updatedFound = await repo.getHealthSnapshot("preset_cloud_1");
    expect(updatedFound?.status).toBe("degraded");
    expect(updatedFound?.consecutiveFailures).toBe(1);
    expect(updatedFound?.errorCategory).toBe("timeout");
    expect(updatedFound?.errorMessage).toBe("Probe timeout after 5000ms");

    // listHealthSnapshots 仅 1 条记录
    const all = await repo.listHealthSnapshots();
    expect(all).toHaveLength(1);
    expect(all[0]?.presetId).toBe("preset_cloud_1");
  });

  it("切层审计事件记录与查询（按 occurredAt 倒序与按 session 过滤）", async () => {
    const event1: ModelRoutingEvent = {
      id: "ev_1",
      sessionId: "session_123",
      turnId: "turn_1",
      fromTier: "L0",
      toTier: "L1",
      fromPresetId: "preset_cloud_1",
      toPresetId: "preset_local_1",
      reason: "l0_unavailable_consecutive_failures",
      occurredAt: "2026-09-14T10:00:00.000Z",
    };

    const event2: ModelRoutingEvent = {
      id: "ev_2",
      sessionId: "session_123",
      turnId: "turn_2",
      fromTier: "L1",
      toTier: "L0",
      fromPresetId: "preset_local_1",
      toPresetId: "preset_cloud_1",
      reason: "l0_recovered_consecutive_successes",
      occurredAt: "2026-09-14T10:10:00.000Z",
    };

    const eventOtherSession: ModelRoutingEvent = {
      id: "ev_3",
      sessionId: "session_999",
      turnId: "turn_x",
      fromTier: "L0",
      toTier: "L2",
      fromPresetId: "preset_cloud_1",
      toPresetId: null,
      reason: "no_model_available",
      occurredAt: "2026-09-14T10:05:00.000Z",
    };

    await repo.recordRoutingEvent(event1);
    await repo.recordRoutingEvent(event2);
    await repo.recordRoutingEvent(eventOtherSession);

    const allEvents = await repo.listRoutingEvents(10);
    expect(allEvents).toHaveLength(3);
    // 最新事件排最前
    expect(allEvents[0]?.id).toBe("ev_2");
    expect(allEvents[1]?.id).toBe("ev_3");
    expect(allEvents[2]?.id).toBe("ev_1");

    // 会话过滤
    const sessionEvents = await repo.listRoutingEventsForSession("session_123");
    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0]?.id).toBe("ev_2");
    expect(sessionEvents[1]?.id).toBe("ev_1");
  });
});
