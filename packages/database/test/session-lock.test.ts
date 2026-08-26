import { describe, it, expect } from "vitest";
import { SessionLockManager, sessionLockManager, withSessionLock } from "../src/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AST-01 会话级写锁", () => {
  it("同一 key 的任务严格串行执行且保持顺序", async () => {
    const manager = new SessionLockManager();
    const timeline: Array<{ id: number; at: number }> = [];
    const results: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((id) =>
        manager.runExclusive("session:1", async () => {
          timeline.push({ id, at: Date.now() });
          await sleep(5);
          results.push(id);
        }),
      ),
    );

    expect(results).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < timeline.length; i += 1) {
      // 相邻任务结束于下一个任务的开始之前（无重叠）：用结果序即可，再检查开始时间递增
      expect(timeline[i]!.at).toBeGreaterThanOrEqual(timeline[i - 1]!.at);
    }
  });

  it("不同 key 的任务互不阻塞（并行）", async () => {
    const manager = new SessionLockManager();
    const startedAt = Date.now();

    await Promise.all(
      ["a", "b", "c"].map((k) =>
        manager.runExclusive(`session:${k}`, async () => {
          await sleep(30);
        }),
      ),
    );

    // 并行总耗时应显著小于串行 3×30ms
    expect(Date.now() - startedAt).toBeLessThan(80);
  });

  it("任务异常不中断队列，异常正确传播", async () => {
    const manager = new SessionLockManager();
    const order: string[] = [];

    const p1 = manager.runExclusive("k", async () => {
      order.push("first");
      throw new Error("boom");
    });
    const p2 = manager.runExclusive("k", async () => {
      order.push("second");
    });

    await expect(p1).rejects.toThrow("boom");
    await p2;
    expect(order).toEqual(["first", "second"]);
  });

  it("无竞争后锁自动回收（不泄漏）", async () => {
    const manager = new SessionLockManager();
    expect(manager.activeLockCount).toBe(0);
    await manager.runExclusive("k", async () => sleep(1));
    expect(manager.activeLockCount).toBe(0);
  });

  it("withSessionLock 便捷函数共享全局 manager", async () => {
    const order: string[] = [];
    await Promise.all([
      withSessionLock("s", async () => {
        order.push("a");
        await sleep(5);
      }),
      withSessionLock("s", async () => {
        order.push("b");
      }),
    ]);
    expect(order).toEqual(["a", "b"]);
    expect(sessionLockManager.activeLockCount).toBe(0);
  });
});