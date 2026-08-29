/**
 * Worker 日记定时生成测试（scripted 模板模式，无网络依赖）
 *
 * 覆盖：模板生成真实内容（非占位）/ 当日记忆进入素材 / 同日已存在 → 跳过并推进游标。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  createInMemoryDatabase,
  diarySchedules,
  initDatabaseSchema,
  SqliteDiaryRepository,
  SqliteLLMConfigRepository,
  SqliteMemoryRepository,
  SqliteOutboxRepository,
  SqlitePlatformRepository,
  type AervoxDatabase,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import { runDiaryGenerationCycle } from "../src/diary-generator.js";

const tenant = { workspaceId: "ws_worker_diary", subjectUserId: "usr_worker_diary" } as const;

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe("Worker 日记定时生成", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let diaryRepo: SqliteDiaryRepository;
  let memoryRepo: SqliteMemoryRepository;
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}_${Date.now().toString(36)}`;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted";
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    diaryRepo = new SqliteDiaryRepository(db);
    memoryRepo = new SqliteMemoryRepository(db, client);
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await cleanup();
  });

  /** 到期计划（nextRunAt=null → 立即到期）+ 当日记忆素材 */
  async function seedDueScheduleWithMemory(): Promise<void> {
    await diaryRepo.createDiarySchedule(tenant, {
      id: nextId("ds_seed"),
      scheduleEpochId: "test:daily",
      activeFrom: new Date().toISOString(),
      initialWindowStart: `${todayLocal()}T00:00:00`,
      cutoffRule: "daily",
    });
    await memoryRepo.createRecord(tenant, {
      id: nextId("mem_seed"),
      layer: "short_term",
      type: "learning_event",
      category: "learning_event",
      content: "用户今天复习了二叉树的前序遍历",
    });
  }

  it("到期计划：生成真实模板内容（非占位），当日记忆计入素材", async () => {
    await seedDueScheduleWithMemory();

    const generated = await runDiaryGenerationCycle({
      db,
      diaryRepo,
      llmConfigRepo: new SqliteLLMConfigRepository(db),
      platformRepo: new SqlitePlatformRepository(db),
      outboxRepo: new SqliteOutboxRepository(db),
      workerId: "worker-test",
    });

    expect(generated).toBe(1);

    const diary = await diaryRepo.getDiaryByDate(tenant, todayLocal());
    expect(diary).not.toBeNull();
    // 真实模板内容（而非旧占位串「今日从 N 份素材中生成」）
    expect(diary?.content).toContain("今天我还悄悄记下了 1 件与你有关的事");
    expect(diary?.content).toContain("（本篇为非 LLM 模式的模板日记");
    expect(diary?.content).not.toContain("今日从");
  });

  it("同日已存在（按需路径已生成）：跳过并推进游标，不产生第二篇", async () => {
    await seedDueScheduleWithMemory();

    const ctx = {
      db,
      diaryRepo,
      llmConfigRepo: new SqliteLLMConfigRepository(db),
      platformRepo: new SqlitePlatformRepository(db),
      outboxRepo: new SqliteOutboxRepository(db),
      workerId: "worker-test",
    };

    // 第一轮：真实生成（游标推进至 +24h）
    expect(await runDiaryGenerationCycle(ctx)).toBe(1);

    // 把计划游标重置为到期，模拟「按需路径先写好日记、定时兜底随后触发」的重复窗口
    const [sched] = await db
      .select()
      .from(diarySchedules)
      .where(eq(diarySchedules.workspaceId, tenant.workspaceId));
    expect(sched).toBeDefined();
    await db
      .update(diarySchedules)
      .set({ nextRunAt: null, lastCutoffAt: null, updatedAt: new Date().toISOString() })
      .where(eq(diarySchedules.id, sched!.id));

    // 第二轮：同日已存在 → 跳过（不生成、游标照常推进）
    expect(await runDiaryGenerationCycle(ctx)).toBe(0);

    // 仍只有一篇当天日记
    const items = await diaryRepo.listDiaries(tenant, 10);
    expect(items.length).toBe(1);
    expect(items[0]?.localDate).toBe(todayLocal());
  });
});