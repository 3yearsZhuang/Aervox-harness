import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, createReconnectableClient, type AervoxDatabase } from "../src/client.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("client 异步操作队列（真实 libSQL）", () => {
  let directory: string;
  let url: string;
  let client: Client;
  let db: AervoxDatabase;
  let reconnect: () => Promise<void>;
  let reconnectCount: () => number;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-client-queue-"));
    url = `file:${path.join(directory, "queue.db")}`;
    ({ db, client, reconnect, reconnectCount } = await createDatabase({
      url,
      busyTimeoutMs: 20,
      busyRetry: { enabled: false },
    }));
    await client.execute("CREATE TABLE writes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  });

  afterEach(() => {
    client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const insert = (value: string) => ({ sql: "INSERT INTO writes (value) VALUES (?)", args: [value] });

  it("事务持有槽位到提交，外部 execute 和第二个事务按调用顺序继续", async () => {
    const first = await client.transaction();
    await first.execute(insert("first"));
    const entered: string[] = [];
    const queued = Promise.all([
      client.execute(insert("outside")).then(() => { entered.push("outside"); }),
      client.transaction().then(async (second) => {
        entered.push("second");
        await second.execute(insert("second"));
        await second.commit();
      }),
    ]);
    await setImmediate();
    expect(entered).toEqual([]);
    await first.commit();
    await queued;
    expect(entered).toEqual(["outside", "second"]);
    expect((await client.execute("SELECT value FROM writes ORDER BY id")).rows.map((r) => r.value))
      .toEqual(["first", "outside", "second"]);
    expect(reconnectCount()).toBe(0);
  });

  it("同时开始的 Drizzle 事务可在 await 后提交，第二个事务不会阻塞事件循环", async () => {
    const entered = deferred();
    const release = deferred();
    let secondEntered = false;
    const first = db.transaction(async (tx) => {
      await tx.run("INSERT INTO writes (value) VALUES ('first')" as never);
      entered.resolve();
      await release.promise;
      await tx.run("INSERT INTO writes (value) VALUES ('first-last')" as never);
    });
    const second = db.transaction(async (tx) => {
      secondEntered = true;
      await tx.run("INSERT INTO writes (value) VALUES ('second')" as never);
    });
    const completed = Promise.all([first, second]);
    await entered.promise;
    await setImmediate();
    expect(secondEntered).toBe(false);
    release.resolve();
    await completed;
    expect((await client.execute("SELECT value FROM writes ORDER BY id")).rows.map((r) => r.value))
      .toEqual(["first", "first-last", "second"]);
    expect(reconnectCount()).toBe(0);
  });

  it("Drizzle 回调异常回滚并释放后续操作，未提交数据不可见", async () => {
    const entered = deferred();
    const release = deferred();
    const failed = db.transaction(async (tx) => {
      await tx.run("INSERT INTO writes (value) VALUES ('rolled-back')" as never);
      entered.resolve();
      await release.promise;
      throw new Error("transaction callback failed");
    });
    const rejection = expect(failed).rejects.toThrow("transaction callback failed");
    await entered.promise;
    const outside = client.execute(insert("outside"));
    release.resolve();
    await Promise.all([rejection, outside]);
    expect((await client.execute("SELECT value FROM writes")).rows.map((r) => r.value))
      .toEqual(["outside"]);
    expect(reconnectCount()).toBe(0);
  });

  it("事务 close 回滚并释放槽位，多次 close 不会释放后一个事务", async () => {
    const first = await client.transaction();
    await first.execute(insert("rolled-back"));
    const secondPending = client.transaction();
    first.close();
    const second = await secondPending;
    await second.execute(insert("second"));
    let outsideEntered = false;
    const outside = client.execute(insert("outside")).then(() => { outsideEntered = true; });
    first.close();
    await expect(first.commit()).rejects.toMatchObject({ code: "TRANSACTION_CLOSED" });
    await setImmediate();
    expect(outsideEntered).toBe(false);
    await second.commit();
    await outside;
    expect((await client.execute("SELECT value FROM writes ORDER BY id")).rows.map((r) => r.value))
      .toEqual(["second", "outside"]);
  });

  it("公开 reconnect 等待活动事务结束，并发请求仍共享一次换连接", async () => {
    const tx = await client.transaction();
    await tx.execute(insert("committed"));
    const reconnecting = Promise.all([reconnect(), reconnect(), reconnect()]);
    const outside = client.execute(insert("after-reconnect"));
    await setImmediate();
    expect(reconnectCount()).toBe(0);
    await tx.commit();
    await Promise.all([reconnecting, outside]);
    expect(reconnectCount()).toBe(1);
    expect((await client.execute("SELECT value FROM writes ORDER BY id")).rows.map((r) => r.value))
      .toEqual(["committed", "after-reconnect"]);
  });

  it("client.close 回滚活动事务，并拒绝队列和重连，连接不能被复活", async () => {
    const tx = await client.transaction();
    await tx.execute(insert("rolled-back"));
    const queued = expect(client.execute(insert("must-not-run")))
      .rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    client.close();
    await queued;
    expect(tx.closed).toBe(true);
    await expect(reconnect()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(client.transaction()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    const observer = createClient({ url });
    try {
      expect((await observer.execute("SELECT * FROM writes")).rows).toEqual([]);
    } finally {
      observer.close();
    }
  });

  it("事务内部 BUSY 清理与内部重连不重新排队，后续事务可继续", async () => {
    const owner = createClient({ url });
    try {
      const tx = await client.transaction("deferred");
      await owner.execute("BEGIN IMMEDIATE");
      await expect(tx.execute(insert("blocked"))).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      await owner.execute("ROLLBACK");
      expect(tx.closed).toBe(true);
      const next = await client.transaction();
      await next.execute(insert("after-recovery"));
      await next.commit();
      expect(reconnectCount()).toBeGreaterThan(0);
      expect((await client.execute("SELECT value FROM writes")).rows[0]?.value).toBe("after-recovery");
    } finally {
      owner.close();
    }
  });

  it("换连接在途关闭时也会关闭新连接，并释放后续等待者", async () => {
    const initial = createClient({ url });
    const next = createClient({ url });
    const entered = deferred();
    const release = deferred();
    const wrapped = createReconnectableClient({
      initial,
      createAndPrepare: async () => {
        entered.resolve();
        await release.promise;
        return next;
      },
    });
    try {
      const reconnecting = expect(wrapped.reconnect()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      await entered.promise;
      const queued = expect(wrapped.execute("SELECT 1")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      wrapped.close();
      release.resolve();
      await Promise.all([reconnecting, queued]);
      expect(initial.closed).toBe(true);
      expect(next.closed).toBe(true);
      expect(wrapped.reconnectCount()).toBe(0);
    } finally {
      release.resolve();
      wrapped.close();
      next.close();
    }
  });
});
