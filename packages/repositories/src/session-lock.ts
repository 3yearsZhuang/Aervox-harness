/**
 * Aervox｜思隅 @aervox/database — 会话级写锁（AST-01）
 *
 * 场景：API 与 Worker 会写同一会话的 Outbox/MemoryEvent/Turn。T-01 的 busy 重试
 * 解决进程间竞争；进程内同一会话的并发写此前无串行化约束。会话锁与 busy 重试互补：
 * 锁降低冲突发生概率，重试兜底残留冲突（跨进程）。
 *
 * 设计依据：reference/AstrBot core/utils/session_lock.py（AGPLv3，仅借鉴公开思想，
 * 自研实现）。AstrBot 用弱引用 + 计数支撑多事件循环；Node 单事件循环无需 per-loop
 * 隔离，这里以 promise 尾链实现按 key 互斥，并沿用"引用计数归零即回收"防止泄漏。
 */
export interface ISessionLockManager {
  /** 以 key 为粒度串行执行 fn；返回 fn 的结果或异常 */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 当前持有/排队中的锁数量（观测与测试用） */
  readonly activeLockCount: number;
}

/** 基于 promise 尾链的按 key 互斥锁 */
export class SessionLockManager implements ISessionLockManager {
  /** key -> 尾链 promise（排队任务挂在此链后） */
  private tails = new Map<string, Promise<unknown>>();
  /** key -> 当前活跃（持有或等待）任务数 */
  private refs = new Map<string, number>();
  // 该 Map 为空时说明无等待者，tail 已按需回收；计数用于回收判断
  private _keys = new Map<string, true>();

  get activeLockCount(): number {
    return this._keys.size;
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
    this._keys.set(key, true);

    // 续链：串行执行 fn，错误不打断队列（下一个任务继续）
    const run = prev.then(() => fn());
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );

    try {
      return await run;
    } finally {
      const remaining = (this.refs.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.refs.delete(key);
        // 仅当没有新任务排队时回收 tail，避免丢掉排队任务
        if (this.tails.get(key) === run) {
          this.tails.delete(key);
        }
        this._keys.delete(key);
      } else {
        this.refs.set(key, remaining);
      }
    }
  }
}

/** 全局共享实例 */
export const sessionLockManager = new SessionLockManager();

/** 便捷函数：按会话 key 串行化写入 */
export function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return sessionLockManager.runExclusive(key, fn);
}