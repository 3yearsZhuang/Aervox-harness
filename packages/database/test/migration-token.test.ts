/**
 * Aervox｜思隅 @aervox/database — T-06 迁移服务 + T-10 Token 分账测试
 */
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../src/client.js";
import {
  addColumnIfMissing,
  ensureJournalTable,
  isMigrationCompleted,
  listAppliedMigrations,
  runMigrations,
} from "../src/migration/migration-service.js";
import { splitTokenUsage } from "../src/token-usage.js";

describe("T-06 迁移服务（journal + 幂等重入 + 旧库列补齐）", () => {
  it("runMigrations 幂等：同步骤二次执行不重复", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      const steps = [
        {
          name: "test.v1.add_banner",
          description: "add test banner column",
          up: async (c: typeof client) => {
            await c.execute(`CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY)`);
            await addColumnIfMissing(c, "t", "banner", "banner TEXT");
          },
        },
      ];
      const first = await runMigrations(client, steps);
      const second = await runMigrations(client, steps);
      expect(first).toEqual(["test.v1.add_banner"]);
      expect(second).toEqual([]);
      expect(await isMigrationCompleted(client, "test.v1.add_banner")).toBe(true);

      const columns = await client.execute(`PRAGMA table_info(t)`);
      expect(columns.rows.map((r) => String(r.name))).toContain("banner");
    } finally {
      await cleanup();
    }
  });

  it("ensureJournalTable + listAppliedMigrations 幂等登记", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      await ensureJournalTable(client);
      await ensureJournalTable(client);
      const applied = await listAppliedMigrations(client);
      expect(applied).toBeInstanceOf(Set);
    } finally {
      await cleanup();
    }
  });

  it("addColumnIfMissing 已存在列不重复 ADD", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      await client.execute(`CREATE TABLE IF NOT EXISTS t2 (id TEXT PRIMARY KEY, keep TEXT)`);
      await addColumnIfMissing(client, "t2", "keep", "keep TEXT NOT NULL DEFAULT ''");
      const columns = await client.execute(`PRAGMA table_info(t2)`);
      expect(columns.rows.filter((r) => String(r.name) === "keep")).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe("T-10 Token 用量分账", () => {
  it("旧形态 { prompt, completion, total } 归并为非缓存", () => {
    const r = splitTokenUsage({ prompt: 100, completion: 20, total: 120 });
    expect(r.noncacheReadTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.completionTokens).toBe(20);
    expect(r.totalTokens).toBe(120);
  });

  it("OpenAI 形态带缓存命中扣减非缓存", () => {
    const raw = {
      prompt_tokens: 500,
      completion_tokens: 30,
      total_tokens: 530,
      prompt_tokens_details: { cached_tokens: 200 },
    };
    const r = splitTokenUsage(raw);
    expect(r.cacheReadTokens).toBe(200);
    expect(r.noncacheReadTokens).toBe(300);
    expect(r.completionTokens).toBe(30);
    expect(r.totalTokens).toBe(530);
  });

  it("缓存读 + 缓存写均可识别", () => {
    const raw = {
      promptTokens: 400,
      completionTokens: 10,
      totalTokens: 410,
      cacheReadTokens: 150,
      cacheWriteTokens: 50,
    };
    const r = splitTokenUsage(raw);
    expect(r.cacheReadTokens).toBe(150);
    expect(r.cacheWriteTokens).toBe(50);
    expect(r.noncacheReadTokens).toBe(200);
    expect(r.totalTokens).toBe(410);
  });

  it("非法输入归零", () => {
    const r = splitTokenUsage(null);
    expect(r.totalTokens).toBe(0);
    expect(r.noncacheReadTokens).toBe(0);
  });
});