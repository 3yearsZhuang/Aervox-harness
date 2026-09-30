/**
 * 连接自愈回归：BEGIN 竞争失败后必须能自动恢复可写性。
 *
 * 背景（实测，Node 24 + libsql 0.4.7 + @libsql/client 0.14.0）：
 * 另一连接持有 `BEGIN IMMEDIATE` 时，本连接 `transaction()` 抛 SQLITE_BUSY；此后同一连接的
 * 新事务 `commit` 会以 `SQL statements in progress` 失败，且被遗弃的事务会持续持有写锁，
 * 使同进程其他连接与其它进程的写入同样失败。实测 `ROLLBACK`/`COMMIT` 都无法清理，
 * **只有关闭该连接并新建连接**才能恢复。
 *
 * 修复前：一次 BEGIN 竞争即可把该 client 变成"永久不可提交"，本文件的用例会失败；
 * 修复后：`createDatabase` 返回的 client 在遇到 BEGIN 竞争或连接污染时自动换连接并重试一次。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDatabase, type AervoxDatabase } from "../src/index.js";

describe("client 连接自愈：BEGIN 竞争后自动换连接", () => {
  let dbFile: string;
  let db: AervoxDatabase;
  let client: Client;
  let reconnect: () => Promise<void>;
  let reconnectCount: () => number;
  let owner: Client;

  beforeEach(async () => {
    dbFile = path.join(
      os.tmpdir(),
      `aervox_selfheal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );
    const created = await createDatabase({ url: `file:${dbFile}`, busyTimeoutMs: 0 });
    db = created.db;
    client = created.client;
    reconnect = created.reconnect;
    reconnectCount = created.reconnectCount;
    await client.execute("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");

    owner = createClient({ url: `file:${dbFile}` });
    await owner.execute("PRAGMA busy_timeout = 0");
  });

  afterEach(() => {
    try {
      client.close();
    } catch {
      // 忽略
    }
    try {
      owner.close();
    } catch {
      // 忽略
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (fs.existsSync(dbFile + suffix)) fs.unlinkSync(dbFile + suffix);
      } catch {
        // 忽略
      }
    }
  });

  it("写锁竞争期间 BEGIN 失败后，锁释放即可立刻写入（不再永久卡死）", async () => {
    await owner.execute("BEGIN IMMEDIATE");

    // 第一次事务必然拿不到写锁（libsql 的 transaction() 接收模式参数，不接收回调）
    let firstFailure: unknown;
    try {
      const tx = await client.transaction();
      await tx.execute("INSERT INTO t (v) VALUES ('blocked')");
      await tx.commit();
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toMatchObject({ code: "SQLITE_BUSY" });

    // 自愈发生了：换过连接
    expect(reconnectCount()).toBeGreaterThan(0);

    // 释放写锁后，同一个 client 引用必须立刻可写
    // （修复前：这里会以 SQL statements in progress 永久失败）
    await owner.execute("ROLLBACK");

    const tx = await client.transaction();
    await tx.execute("INSERT INTO t (v) VALUES ('after')");
    await tx.commit();

    const rows = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v = 'after'");
    expect(Number(rows.rows[0]!.c)).toBe(1);
  }, 30_000);

  it("自愈后仍保持 PRAGMA 配置（busy_timeout / foreign_keys）", async () => {
    await owner.execute("BEGIN IMMEDIATE");
    let failure: unknown;
    try {
      const tx = await client.transaction();
      await tx.execute("INSERT INTO t (v) VALUES ('blocked')");
      await tx.commit();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
    await owner.execute("ROLLBACK");

    const foreignKeys = await client.execute("PRAGMA foreign_keys;");
    expect(Number(Object.values(foreignKeys.rows[0]!)[0])).toBe(1);

    // 外键约束在自愈后的连接上依然生效
    await client.execute(
      "CREATE TABLE IF NOT EXISTS child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES t(id))",
    );
    await expect(
      client.execute("INSERT INTO child (id, parent_id) VALUES (1, 99999)"),
    ).rejects.toThrow(/FOREIGN KEY/i);
  }, 30_000);

  it("反复竞争不会把 client 拖入不可恢复状态（每轮之后都能正常提交）", async () => {
    // 关键不变量：只要某条连接被 BEGIN 竞争污染就必须立刻换掉，
    // 绝不允许在污染连接上再次 BEGIN——那会让 commit 失败并永久丢锁
    // （实测：进程内 tx.rollback/tx.close/client.close/新建连接都无法释放该写锁）。
    for (let round = 0; round < 5; round += 1) {
      await owner.execute("BEGIN IMMEDIATE");
      let failure: unknown;
      try {
        const tx = await client.transaction();
        await tx.execute(`INSERT INTO t (v) VALUES ('blocked-${round}')`);
        await tx.commit();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
      await owner.execute("ROLLBACK");

      // 每轮竞争之后都必须能提交；如果曾进入"污染连接上 BEGIN"的状态，
      // 这里会以 SQL statements in progress 失败。
      const tx = await client.transaction();
      await tx.execute(`INSERT INTO t (v) VALUES ('round-${round}')`);
      await tx.commit();
    }

    const rows = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v LIKE 'round-%'");
    expect(Number(rows.rows[0]!.c)).toBe(5);
    // 至少发生了一次自愈
    expect(reconnectCount()).toBeGreaterThan(0);
  }, 60_000);

  it("普通 execute 遇到 busy 后，同一 client 仍能完成后续事务（execute busy 同样污染连接）", async () => {
    // 关键实测结论：不只是 BEGIN 阶段，**任何** SQLITE_BUSY 都会在出错连接上留下未完成语句，
    // 使该连接后续 COMMIT 报 statements in progress。因此 busy 之后的连接必须被替换。
    await owner.execute("BEGIN IMMEDIATE");
    let plainBusy: unknown;
    try {
      await client.execute("INSERT INTO t (v) VALUES ('plain-busy')");
    } catch (error) {
      plainBusy = error;
    }
    expect(plainBusy).toMatchObject({ code: "SQLITE_BUSY" });
    await owner.execute("ROLLBACK");

    // 修复前：这里会在 commit 抛 SQL statements in progress（且永久丢锁）
    const tx = await client.transaction();
    await tx.execute("INSERT INTO t (v) VALUES ('after-exec-busy')");
    await tx.commit();

    const rows = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v = 'after-exec-busy'");
    expect(Number(rows.rows[0]!.c)).toBe(1);
  }, 30_000);

  it("reconnect() 幂等且并发调用共享同一次重连", async () => {
    const before = reconnectCount();
    await Promise.all([reconnect(), reconnect(), reconnect()]);
    expect(reconnectCount()).toBe(before + 1);
    await reconnect();
    expect(reconnectCount()).toBe(before + 2);
    await client.execute("SELECT 1");
  }, 30_000);

  it("drizzle 事务在自愈后仍可正常使用", async () => {
    await owner.execute("BEGIN IMMEDIATE");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO t (v) VALUES ('blocked-drizzle')" as never);
      }),
    ).rejects.toBeDefined();
    await owner.execute("ROLLBACK");

    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO t (v) VALUES ('drizzle-after')" as never);
    });
    const rows = await client.execute("SELECT COUNT(*) AS c FROM t WHERE v = 'drizzle-after'");
    expect(Number(rows.rows[0]!.c)).toBe(1);
  }, 30_000);
});
