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
    const keys = ["a", "b", "c"];

    // 确定性并行验证（barrier 交叉）：每个任务进入临界区后，等待其他
    // 所有 key 的任务也都进入临界区才结束。若锁退化为跨 key 串行，先
    // 进入的任务将永远等不到后序信号（后序任务被锁挡在临界区外），
    // 由兜底超时转为失败。不依赖墙钟，不受 CPU 负载影响（原 80ms
    // 墙钟断言在全量测试 CPU 争抢下会因 setTimeout 延迟膨胀而 flaky）。
    const entered = new Map<string, Promise<void>>();
    const markEntered = new Map<string, () => void>();
    for (const k of keys) {
      let resolve!: () => void;
      entered.set(k, new Promise<void>((r) => (resolve = r)));
      markEntered.set(k, resolve);
    }

    const deadlockGuard = sleep(2000).then(() => {
      throw new Error("不同 key 的任务互相阻塞：锁疑似退化为全局串行");
    });

    await Promise.race([
      Promise.all(
        keys.map((k) =>
          manager.runExclusive(`session:${k}`, async () => {
            markEntered.get(k)!();
            await Promise.all(
              keys.filter((other) => other !== k).map((other) => entered.get(other)!),
            );
          }),
        ),
      ),
      deadlockGuard,
    ]);
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