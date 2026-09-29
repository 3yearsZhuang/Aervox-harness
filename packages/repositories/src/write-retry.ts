/**
 * Aervox｜思隅 @aervox/repositories — SQLite 写竞争重试拦截器（T-01）
 *
 * 场景：API、Worker、Desktop 共用同一 `data/aervox.db`（WAL 模式），多进程写
 * 竞争是既有风险。client.ts 的 `busy_timeout` 只把 SQLITE_BUSY 的暴露时间推迟到
 * 固定时长，超时后仍会抛错。
 *
 * 方案：在 client 边界统一装饰 `execute / executeMultiple / batch / transaction`，
 * 识别 busy 错误并按指数退避重试。一处接入、所有现有与未来仓储的写操作自动生效，
 * 调用方零侵入；仅对写相关入口生效，只读方法直接放行。
 *
 * 边界：`execute/batch` 重试安全；`transaction` 的 BEGIN 阶段 Busy 直接抛原错误
 * （libsql@0.4.7 BEGIN 失败后残留语句状态，重试会破坏后续 commit），tx 内的
 * execute/commit/rollback 仍带重试。
 *
 * 实测复现与影响范围（Node 24 + libsql 0.4.7 + @libsql/client 0.14.0，`busy_timeout=0`）：
 * 另一连接持有 `BEGIN IMMEDIATE` 时，本连接 `transaction()` 抛 SQLITE_BUSY；此后
 * 1) 同一连接的新事务虽能 BEGIN，但 `commit` 以
 *    `SQLITE_BUSY: cannot commit transaction - SQL statements in progress` 失败；
 * 2) 在**该进程存活期间**，其他连接乃至另一个进程的写入都会以 `database is locked` 失败
 *    （被遗弃的事务持续持有写锁）；
 * 3) 实测 `rollback()` 与 `close()` 后重建连接**都不能**在进程内恢复可写性，只有进程退出才释放。
 *
 * 因此本层的策略是**快速失败并把错误上抛**，绝不在同一连接上重试或等待；调用方应把该错误
 * 视为需要重启进程的严重故障（fail loud），而不是可重试的锁竞争。级联重试只会反复失败、
 * 放大延迟，并把该终态错误掩盖成"写锁竞争"。
 *
 * 已知缺口（需后续 CR 处理）：进程内的自动恢复（重连）未实现，也未验证可行；
 * 降低发生概率主要依赖上层会话级写锁（AST-01）与合理的 `busy_timeout`。
 *
 * 调用方注意：**不要在 `client.transaction()` 之外再包一层 `runWithBusyRetry`**。
 * 本文件的代理已经覆盖 tx 内部的 execute/commit/rollback，外层再包会重新引入被禁止的
 * BEGIN 重试（每次尝试都可能耗尽 busy_timeout，把最坏阻塞放大数倍），并把
 * "SQL statements in progress" 这类连接终态错误误判为可重试。
 * 同理，`attempts` 的默认值会线性放大每个写路径的最坏阻塞时长，不应全局调高。
 *
 * 设计依据：reference/baishou-next（AGPLv3，仅借鉴公开思想，自研实现）。
 * 与 AST-01 会话级写锁互补：锁降低冲突概率，重试兜底残留冲突。
 */
import type { Client, Transaction, TransactionMode } from "@libsql/client";

/** busy 错误特征文本（libsql/sqlite 常见形态） */
const BUSY_PATTERNS: ReadonlyArray<RegExp> = [
  /database is locked/i,
  /sqlite_busy/i,
];

/**
 * 非竞争类错误：虽然携带 SQLITE_BUSY 字样，但重试不可能成功，必须立即抛出。
 * - `SQL statements in progress`：libsql@0.4.7 在 BEGIN 竞争失败后连接残留语句状态，
 *   后续 commit 会报此错。这是**连接已损坏**的终态信号，不是可等待的锁竞争；重试只会
 *   反复失败并掩盖真实故障（曾使上层误判为写锁冲突并触发 Worker 压力退避）。
 * - `cannot start a transaction within a transaction`：嵌套事务属于编程错误。
 */
const NON_RETRYABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /statements in progress/i,
  /cannot start a transaction within a transaction/i,
];

export interface BusyRetryConfig {
  /**
   * 最大尝试次数（含首次），默认 5。
   * 注意：单次尝试可能已耗尽 client 的 `busy_timeout`（client.ts 默认 5000ms），
   * 因此本值会线性放大写路径的最坏阻塞时长（5 次 ≈ 25s+）。请勿在全局默认上随意调高；
   * 确需更长的调用点请显式传入配置，并评估该路径是否可承受相应延迟。
   */
  readonly attempts?: number;
  /** 初始退避（毫秒），默认 50；每次尝试翻倍 */
  readonly baseDelayMs?: number;
  /** 最大退避（毫秒），默认 1000 */
  readonly maxDelayMs?: number;
  /** 是否启用重试，默认 true（便于测试与特例关闭） */
  readonly enabled?: boolean;
}

/** 判断错误是否为 SQLite 写锁竞争（非损坏、可安全重试） */
export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // 终态/编程类错误优先排除，绝不重试（见 NON_RETRYABLE_PATTERNS 说明）。
  if (NON_RETRYABLE_PATTERNS.some((p) => p.test(message))) {
    return false;
  }
  return BUSY_PATTERNS.some((p) => p.test(message));
}

/**
 * 判断错误是否意味着**连接/进程已进入不可写状态**（BEGIN 竞争失败后的残留事务状态）。
 *
 * 命中该判定时不要重试：实测同一进程内 `rollback()` 与重建连接都无法恢复可写性，
 * 只有进程退出才释放被遗弃事务持有的写锁。调用方应记致命日志并提示重启。
 */
export function isSqliteConnectionPoisonedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NON_RETRYABLE_PATTERNS.some((p) => p.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 第 attempt 次（从 1 起）失败后的退避时长 */
export function busyBackoffMs(
  config: Pick<BusyRetryConfig, "baseDelayMs" | "maxDelayMs">,
  attempt: number,
): number {
  const base = config.baseDelayMs ?? 50;
  const max = config.maxDelayMs ?? 1000;
  return Math.min(max, base * 2 ** (attempt - 1));
}

const DEFAULT_RETRY: Required<BusyRetryConfig> = {
  attempts: 5,
  baseDelayMs: 50,
  maxDelayMs: 1000,
  enabled: true,
};

/** 对单个异步写操作执行 busy 指数退避重试 */
export async function runWithBusyRetry<T>(
  operation: () => Promise<T>,
  config: BusyRetryConfig = {},
): Promise<T> {
  const cfg: Required<BusyRetryConfig> = { ...DEFAULT_RETRY, ...config };
  let lastError: unknown;
  for (let attempt = 1; attempt <= cfg.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === cfg.attempts) {
        throw error;
      }
      await sleep(busyBackoffMs(cfg, attempt));
    }
  }
  throw lastError;
}

/** 用重试语义包装一个 AsyncFunction 属性值 */
function wrapAsync<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  config: BusyRetryConfig,
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => runWithBusyRetry(() => fn(...args), config);
}

/**
 * 返回一个写方法带 busy 重试的 client 代理。
 * - execute / executeMultiple / batch：整体包一层重试；
 * - transaction：返回的事务对象（tx）为重试版，事务内 execute 同样生效；
 * - 其余属性（close/sync 等）原样透传。
 */
export function withBusyRetry<T extends Client>(client: T, config: BusyRetryConfig = {}): T {
  const cfg: Required<BusyRetryConfig> = { ...DEFAULT_RETRY, ...config };
  if (!cfg.enabled) return client;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        // 事务对象形态：const tx = await client.transaction(mode?)。
        // BEGIN（获取写锁）阶段 Busy 不改自动重试：libsql@0.4.7 在 BEGIN 竞争失败
        // 后残留语句状态（后续 commit 报 "SQL statements in progress"），重试反而
        // 破坏事务；此阶段直接抛原错误，交由上层 AST-01 会话锁与调用方兜底。
        // tx 内部 execute/commit/rollback 仍带重试（防御性）。
        const fn = Reflect.get(target, prop, receiver) as Client["transaction"];
        const transactionFn = (fn as (mode?: TransactionMode) => Promise<Transaction>).bind(
          target,
        );
        return (async (mode?: TransactionMode) => {
          const tx = (await transactionFn(mode)) as unknown as Client;
          return withBusyRetry(tx, cfg);
        }) as unknown as Client["transaction"];
      }
      // 写相关方法与事务终止方法统一重试（commit 在提交阶段遇写锁同样安全重试）
      if (
        prop === "execute" ||
        prop === "executeMultiple" ||
        prop === "batch" ||
        prop === "commit" ||
        prop === "rollback"
      ) {
        const fn = Reflect.get(target, prop, receiver);
        if (typeof fn !== "function") return fn;
        return wrapAsync(fn.bind(target), cfg);
      }
      // 其余属性一律绑定 target，避免 Proxy 上调用类方法丢失 this（私有字段 #database 等）
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}