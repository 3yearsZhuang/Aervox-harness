import { describe, it, expect, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  busyBackoffMs,
  isSqliteBusyError,
  runWithBusyRetry,
  withBusyRetry,
} from "../src/index.js";

function tempDbUrl(): string {
  const file = path.join(
    os.tmpdir(),
    `aervox_busy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
  );
  return `file:${file}`;
}

function cleanup(url: string): void {
  const file = url.startsWith("file:") ? url.slice("file:".length) : url;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (fs.existsSync(file + suffix)) fs.unlinkSync(file + suffix);
    } catch {
      // 忽略清理异常
    }
  }
}

describe("T-01 SQLite 写竞争重试拦截器", () => {
  it("识别 database is locked / sqlite_busy 形态", () => {
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
    expect(isSqliteBusyError(new Error("SQLITE_BUSY: database is locked (5) (errno 5)"))).toBe(
      true,
    );
    expect(isSqliteBusyError("sqlite_busy")).toBe(true);
    expect(isSqliteBusyError(new Error("no such table: x"))).toBe(false);
    expect(isSqliteBusyError(new Error("foreign key constraint failed"))).toBe(false);
  });

  it("busyBackoffMs 按指数退避并封顶", () => {
    const cfg = { baseDelayMs: 50, maxDelayMs: 1000 };
    expect(busyBackoffMs(cfg, 1)).toBe(50);
    expect(busyBackoffMs(cfg, 2)).toBe(100);
    expect(busyBackoffMs(cfg, 3)).toBe(200);
    expect(busyBackoffMs(cfg, 6)).toBe(1000);
  });

  it("runWithBusyRetry 在 busy 后重试至成功", async () => {
    let calls = 0;
    const result = await runWithBusyRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("database is locked");
        return "ok";
      },
      { attempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("runWithBusyRetry 在 attempts 耗尽后抛出 busy 错误", async () => {
    let calls = 0;
    await expect(
      runWithBusyRetry(
        async () => {
          calls += 1;
          throw new Error("database is locked");
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow("database is locked");
    expect(calls).toBe(3);
  });

  it("非 busy 错误不重试，立即抛出", async () => {
    const fake = {
      execute: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as Client;
    const proxied = withBusyRetry(fake, { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
    await expect(proxied.execute("SELECT 1")).rejects.toThrow("boom");
    expect(fake.execute).toHaveBeenCalledTimes(1);
  });

  it("withBusyRetry 的 execute 对 busy 重试至成功", async () => {
    let calls = 0;
    const fake = {
      execute: vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls < 3) throw new Error("sqlite_busy");
        return { rows: [], rowsAffected: 1 };
      }),
    } as unknown as Client;
    const proxied = withBusyRetry(fake, { attempts: 5, baseDelayMs: 1, maxDelayMs: 3 });
    const res = await proxied.execute("INSERT ...");
    expect(res.rowsAffected).toBe(1);
    expect(calls).toBe(3);
  });

  it("enabled=false 时透传原始 client", () => {
    const fake = { execute: vi.fn() } as unknown as Client;
    expect(withBusyRetry(fake, { enabled: false })).toBe(fake);
  });
});

describe("T-01 端到端：真实文件级 SQLITE_BUSY 竞争", () => {
  // 注：本机 libsql file 后端的跨连接读快照在"曾持有写事务的连接"之后会滞后
  // （裸连接复现：写者自读正常，他人连接读空）。故断言一律用写入者自身连接视角，
  // 聚焦验证"busy 打回 + 自动退避重试 + 写入成功"，不依赖跨连接读可见性。
  it("写锁被占用时 execute 自动退避重试并最终成功", async () => {
    const url = tempDbUrl();
    const lockOwner = createClient({ url });
    const retryingRaw = createClient({ url });
    const rawNoRetry = createClient({ url });
    try {
      await lockOwner.execute("CREATE TABLE IF NOT EXISTS rt (id INTEGER PRIMARY KEY, v TEXT)");
      // 竞争方让 busy 立即暴露；锁持有方无需等待
      await lockOwner.execute("PRAGMA busy_timeout = 0");
      await retryingRaw.execute("PRAGMA busy_timeout = 0");
      await rawNoRetry.execute("PRAGMA busy_timeout = 0");

      const retrying = withBusyRetry(retryingRaw, {
        attempts: 8,
        baseDelayMs: 10,
        maxDelayMs: 60,
      });

      // 1) 无重试对照：持锁时插入必然被 SQLITE_BUSY 打回，证明锁真实在挡路
      await lockOwner.execute("BEGIN IMMEDIATE");
      await expect(
        rawNoRetry.execute({ sql: "INSERT INTO rt(v) VALUES (?)", args: ["blocked"] }),
      ).rejects.toMatchObject({ code: "SQLITE_BUSY" });

      // 2) 重试版在同一把锁下启动：进入退避等待
      const insertPromise = retrying.execute({ sql: "INSERT INTO rt(v) VALUES (?)", args: ["ok"] });

      // 3) 退避期间释放写锁 → 重试自动命中并成功（写入者自身视角验证）
      await new Promise((r) => setTimeout(r, 15));
      await lockOwner.execute("COMMIT");
      const res = await insertPromise;
      expect(res.rowsAffected).toBe(1);

      const check = await retryingRaw.execute("SELECT v FROM rt WHERE id = 1");
      expect(check.rows[0]?.v).toBe("ok");
    } finally {
      lockOwner.close();
      retryingRaw.close();
      rawNoRetry.close();
      cleanup(url);
    }
  });

  it("事务 BEGIN 被写锁占用时直接打回 SQLITE_BUSY", async () => {
    // 注：libsql@0.4.7 的 client 一旦发生过 BEGIN busy，该连接会残留语句状态，
    // 其后续事务 commit 报 "SQL statements in progress"（上游限制）。因此 BEGIN
    // 阶段不做自动重试（见 write-retry.ts 边界说明），本用例只用全新连接验证打回。
    const url = tempDbUrl();
    const owner = createClient({ url });
    const retryingRaw = createClient({ url });
    try {
      await owner.execute("CREATE TABLE IF NOT EXISTS rt (id INTEGER PRIMARY KEY, v TEXT)");
      await owner.execute("PRAGMA busy_timeout = 0");
      await retryingRaw.execute("PRAGMA busy_timeout = 0");

      const retrying = withBusyRetry(retryingRaw, { attempts: 8, baseDelayMs: 10, maxDelayMs: 60 });

      await owner.execute("BEGIN IMMEDIATE");
      await expect(retrying.transaction()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      await owner.execute("COMMIT");
    } finally {
      owner.close();
      retryingRaw.close();
      cleanup(url);
    }
  });

  it("干净路径事务（全新连接）：写入、事务内查询、提交全部成功", async () => {
    const url = tempDbUrl();
    const a = createClient({ url });
    try {
      await a.execute("CREATE TABLE IF NOT EXISTS rt (id INTEGER PRIMARY KEY, v TEXT)");
      const retrying = withBusyRetry(a, { attempts: 4, baseDelayMs: 5, maxDelayMs: 20 });

      const tx = await retrying.transaction();
      await tx.execute({ sql: "INSERT INTO rt(v) VALUES (?)", args: ["tx"] });

      // 事务对象绑定独立连接（transaction() 惰性建新连接），用 tx 自身视角查询
      const inTx = await tx.execute("SELECT v FROM rt ORDER BY id DESC LIMIT 1");
      expect(inTx.rows[0]?.v).toBe("tx");

      await tx.commit();
    } finally {
      a.close();
      cleanup(url);
    }
  });
});