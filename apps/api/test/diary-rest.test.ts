/**
 * 日记 REST 路径集成测试（每日按需生成/取回 + 历史列表 + 默认每日计划懒建）
 *
 * 规则依据：PRD §6.7（反虚构、当日唯一自动日记、改写不覆盖历史）；scripted 模式走确定性模板（无网络依赖）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteDiaryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_diary_rest",
  "x-user-id": "usr_diary_rest",
} as const;
const tenant = { workspaceId: "ws_diary_rest", subjectUserId: "usr_diary_rest" } as const;

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe("日记 REST：按需生成 / 幂等取回 / 改写 / 列表 / 默认计划", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const generateToday = (body: unknown = {}) =>
    app.inject({ method: "POST", url: "/v1/diaries/generate-today", headers, payload: body });

  it("首次调用：生成并新建当日日记（模板降级），并懒建默认每日计划", async () => {
    const res = await generateToday();
    expect(res.statusCode).toBe(200);
    const result = res.json() as {
      mode: string;
      generatedBy: string;
      localDate: string;
      title: string;
      content: string;
      materialCount: number;
    };
    expect(result.mode).toBe("created");
    expect(result.generatedBy).toBe("template");
    expect(result.localDate).toBe(todayLocal());
    expect(result.content.length).toBeGreaterThan(0);

    // 懒建默认每日计划（Worker 定时兜底链路激活）
    const diaryRepo = new SqliteDiaryRepository(db);
    const schedule = await diaryRepo.getActiveDailySchedule(tenant);
    expect(schedule).not.toBeNull();
    expect(schedule?.cutoffRule).toBe("daily");
  });

  it("同日再次调用：幂等返回 existing，不重复建日记（当日唯一自动日记）", async () => {
    const first = await generateToday();
    const firstResult = first.json() as { diaryId: string; mode: string };
    expect(firstResult.mode).toBe("created");

    const second = await generateToday();
    expect(second.statusCode).toBe(200);
    const secondResult = second.json() as { diaryId: string; mode: string };
    expect(secondResult.mode).toBe("existing");
    expect(secondResult.diaryId).toBe(firstResult.diaryId);

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/diaries?limit=10",
      headers,
    });
    const list = listRes.json() as { items: Array<{ localDate: string }> };
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.localDate).toBe(todayLocal());
  });

  it("rewrite=true：当日已有 → 改写版本落库、主行推进（mode=rewritten）", async () => {
    const created = (await generateToday()).json() as { diaryId: string };
    const rewritten = await generateToday({ rewrite: true });
    const result = rewritten.json() as { diaryId: string; mode: string };
    expect(result.mode).toBe("rewritten");
    expect(result.diaryId).toBe(created.diaryId);

    const res = await app.inject({
      method: "GET",
      url: `/v1/diaries?localDate=${todayLocal()}`,
      headers,
    });
    const diary = res.json() as { version: number; status: string };
    expect(diary.version).toBe(2);
    expect(diary.status).toBe("edited");
  });

  it("列表接口：按日期倒序返回最近日记（历史回看）", async () => {
    await generateToday();
    const res = await app.inject({ method: "GET", url: "/v1/diaries?limit=5", headers });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { items: Array<{ localDate: string; title: string }> };
    expect(Array.isArray(list.items)).toBe(true);
    expect(list.items.length).toBe(1);
    expect(list.items[0]?.title.length).toBeGreaterThan(0);
    expect(list.items[0]?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});