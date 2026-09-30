/**
 * Aervox｜思隅 @aervox/repositories — 客户端与连接管理
 *
 * 基于 @libsql/client (SQLite/LibSQL) + Drizzle ORM，支持文件与内存/临时隔离数据库。
 * 默认启用 WAL 模式、外键约束、busy_timeout 与 synchronous=NORMAL 优化。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "@aervox/schema";
import {
  withBusyRetry,
  isSqliteBusyError,
  isSqliteConnectionPoisonedError,
  type BusyRetryConfig,
} from "./write-retry.js";

export type AervoxDatabase = LibSQLDatabase<typeof schema>;

/**
 * 具备连接自愈能力的 client。
 *
 * 背景（实测，Node 24 + libsql 0.4.7 + @libsql/client 0.14.0）：
 * 1) `transaction()` 在 BEGIN 阶段遇到写锁竞争而失败时，该连接会残留语句状态，
 *    之后同一连接 `commit` 报 `SQL statements in progress`；
 * 2) 只有**关闭该连接并新建连接**能恢复可写性（`ROLLBACK`/`COMMIT`/`tx.close()` 均无效）；
 * 3) 更严重的是：若在**已被污染**的连接上又成功 BEGIN，随后 commit 失败，则被遗弃的事务会
 *    永久持有写锁——实测进程内任何清理手段（tx.rollback/tx.close/client.close/新建连接）都无法
 *    释放，只有进程退出才行。
 *
 * 因此本层的核心不变量是：**绝不在可能已被污染的连接上开启事务**。
 * - 任何可恢复错误（连接污染，或 BEGIN 阶段竞争失败）都会**同步标记**该连接不可用，
 *   并在换连接成功后才清除标记；
 * - 所有写入口在执行前先 `ensureHealthy()`，等待在途重连或主动重连，从而让第 (3) 类
 *   不可恢复状态在构造上不可达；
 * - 换连接后仅重试一次（不是在同一连接上重试 BEGIN）。
 *
 * 外层 `withBusyRetry` 负责同一连接内的退避重试；两层职责分明。
 */
export interface ReconnectableClient extends Client {
  /** 关闭当前连接并建立新连接；并发调用共享同一次重连，可重复调用 */
  reconnect(): Promise<void>;
  /** 已发生的重连次数（观测与测试用） */
  reconnectCount(): number;
}

/**
 * 用可替换连接的对象包装 client：所有方法在调用时解析到**当前**连接，
 * 因此 Drizzle 与各仓储持有的引用在重连后依然有效。
 */
export function createReconnectableClient(options: {
  readonly createAndPrepare: () => Promise<Client>;
  readonly initial: Client;
}): ReconnectableClient {
  let current = options.initial;
  let reconnects = 0;
  let reconnectInFlight: Promise<void> | null = null;
  /** 当前连接是否已被污染（同步标记，用于阻止在污染连接上开启事务） */
  let poisoned = false;

  const runReconnect = (): Promise<void> => {
    const attempt = (async () => {
      const stale = current;
      // 先建新连接并完成 PRAGMA，成功后再切换；失败时保持旧引用与 poisoned 标记。
      const next = await options.createAndPrepare();
      current = next;
      poisoned = false;
      try {
        stale.close();
      } catch {
        // 旧连接关闭失败不应影响已切换的新连接
      }
      reconnects += 1;
    })();
    reconnectInFlight = attempt;
    void attempt.then(
      () => {
        if (reconnectInFlight === attempt) reconnectInFlight = null;
      },
      () => {
        if (reconnectInFlight === attempt) reconnectInFlight = null;
      },
    );
    return attempt;
  };

  const reconnect = async (): Promise<void> => {
    if (!reconnectInFlight) return runReconnect();
    await reconnectInFlight.catch(() => undefined);
    if (!poisoned) return;
    return runReconnect();
  };

  /** 执行任何操作前确保连接健康；被污染的连接绝不允许再开事务 */
  const ensureHealthy = async (): Promise<void> => {
    if (!poisoned) return;
    await reconnect();
  };

  /**
   * 是否需要换连接。
   *
   * 实测结论（libsql 0.4.7）：**任何** SQLITE_BUSY 都会在出错的连接上留下未完成的语句，
   * 使该连接后续 `COMMIT` 报 `SQL statements in progress` —— 不只是 BEGIN 阶段。
   * 因此 execute/batch/transaction 任一入口遇到 busy 都必须换连接，
   * 「在同一连接上重试 execute 是安全的」这一既有假设已被推翻。
   */
  const isRecoverable = (error: unknown, _method: string): boolean =>
    isSqliteConnectionPoisonedError(error) || isSqliteBusyError(error);

  /**
   * 包装事务对象：事务一旦因连接污染而失败，立即标记并换连接。
   * 事务本身无法重放（回调已经执行过），因此这里只做连接清理，然后如实上抛。
   */
  const wrapTransaction = (tx: unknown): unknown => {
    if (!tx || typeof tx !== "object") return tx;
    return new Proxy(tx as Record<string, unknown>, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (
          prop === "commit" ||
          prop === "rollback" ||
          prop === "execute" ||
          prop === "executeMultiple" ||
          prop === "batch"
        ) {
          return async (...args: unknown[]): Promise<unknown> => {
            try {
              return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            } catch (error) {
              if (isSqliteConnectionPoisonedError(error)) {
                poisoned = true;
                await reconnect().catch(() => undefined);
              }
              throw error;
            }
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
  };

  const recoverable = (method: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      await ensureHealthy();

      const invoke = (): Promise<unknown> => {
        const fn = (current as unknown as Record<string, unknown>)[method];
        if (typeof fn !== "function") {
          throw new Error(`libsql client has no method ${method}`);
        }
        return (fn as (...a: unknown[]) => Promise<unknown>).apply(current, args);
      };
      const finish = (result: unknown): unknown =>
        method === "transaction" ? wrapTransaction(result) : result;

      try {
        return finish(await invoke());
      } catch (error) {
        if (!isRecoverable(error, method)) throw error;
        // 同步标记：并发调用会在 ensureHealthy() 处等待重连完成，
        // 不会在这个已被污染的连接上开启事务（那会导致不可恢复的丢锁）。
        poisoned = true;
        await reconnect();
        try {
          return finish(await invoke());
        } catch (retryError) {
          // 重试本身若再次失败（例如锁仍被占用），新连接同样会被污染：
          // 再换一次，确保 current 永远是一条干净连接，而不是把污染留给下一个调用。
          if (isRecoverable(retryError, method)) {
            poisoned = true;
            await reconnect().catch(() => undefined);
          }
          throw retryError;
        }
      }
    };

  return new Proxy(options.initial as unknown as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "reconnect") return reconnect;
      if (prop === "reconnectCount") return () => reconnects;
      if (
        prop === "execute" ||
        prop === "executeMultiple" ||
        prop === "batch" ||
        prop === "transaction"
      ) {
        return recoverable(String(prop));
      }
      const value = Reflect.get(current as unknown as Record<string, unknown>, prop, current);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(current)
        : value;
    },
  }) as unknown as ReconnectableClient;
}


/**
 * 仓库根目录（src/client.ts 或 dist/client.js 均向上三级到达仓库根）。
 * 用于统一 API / Worker / 多进程默认数据库真源路径。
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
/** 默认共享数据库文件：<repo>/data/aervox.db */
const defaultDbUrl = `file:${path.join(repoRoot, "data", "aervox.db")}`;

/**
 * CAP-033 本地私密 Vault 默认目录：<repo>/data（与主库同目录）。
 * 开发/单机使用仓库内目录（已被 .gitignore 的 data/ 忽略），避免 macOS 默认
 * Application Support 目录被开发容器/沙箱拦截；打包宿主可用
 * AERVOX_PROACTIVE_VAULT_URL / AERVOX_PROACTIVE_VAULT_KEY_PATH 注入 OS 隔离位置。
 */
function proactiveApplicationDataDir(): string {
  return path.join(repoRoot, "data");
}

/** CAP-033 本地私密 Vault：不继承可能指向远端的 DATABASE_URL。 */
const defaultProactiveVaultUrl = `file:${path.join(proactiveApplicationDataDir(), "proactive-vault.db")}`;

export interface DatabaseConfig {
  /** SQLite 数据库文件路径或 URL（如 "file:aervox.db"） */
  readonly url?: string;
  /** 认证 Token（如果连接远程 LibSQL/Turso） */
  readonly authToken?: string;
  /** 事务忙等待超时（毫秒），默认 5000 */
  readonly busyTimeoutMs?: number;
  /** SQLITE_BUSY 指数退避重试配置（T-01），缺省开启（5 次/50ms 起步） */
  readonly busyRetry?: BusyRetryConfig;
}

export interface ProactiveVaultDatabaseConfig {
  /** 仅接受本地 SQLite 文件路径；缺省读取 AERVOX_PROACTIVE_VAULT_URL。 */
  readonly url?: string;
  readonly busyTimeoutMs?: number;
  readonly busyRetry?: BusyRetryConfig;
}

/**
 * CAP-033 主动画像正文与控制面必须留在当前设备。
 * 这里在连接建立前拒绝 http(s)/libsql/ws 等远端 transport，避免主库切换时
 * 主动数据静默跟随 DATABASE_URL 出机。
 */
export function assertLocalSqliteUrl(url: string): void {
  const trimmed = url.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0) {
    throw new Error("proactive vault URL must not be empty");
  }
  if (normalized.startsWith("file://")) {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    if (hostname && hostname !== "localhost") {
      throw new Error("proactive vault requires a local SQLite file URL");
    }
    return;
  }
  if (normalized.startsWith("file:") || normalized === ":memory:") return;
  if (trimmed.startsWith("\\\\") || trimmed.startsWith("//")) {
    throw new Error("proactive vault requires a local SQLite file URL");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || normalized.includes("://")) {
    throw new Error("proactive vault requires a local SQLite file URL");
  }
  // Relative and absolute filesystem paths without a URL scheme are local SQLite paths.
  if (trimmed.length > 0) return;
  throw new Error("proactive vault requires a local SQLite file URL");
}

/** 解析 CAP-033 Vault URL；显式不读取 DATABASE_URL。 */
export function resolveProactiveVaultUrl(
  configuredUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = configuredUrl ?? env.AERVOX_PROACTIVE_VAULT_URL ?? defaultProactiveVaultUrl;
  assertLocalSqliteUrl(url);
  return url;
}

/** 创建独立的 CAP-033 本地 Vault 连接。调用方仍需执行 initDatabaseSchema。 */
export async function createProactiveVaultDatabase(
  config: ProactiveVaultDatabaseConfig = {},
): Promise<{ db: AervoxDatabase; client: Client }> {
  const url = resolveProactiveVaultUrl(config.url);
  return createDatabase({
    url,
    busyTimeoutMs: config.busyTimeoutMs,
    busyRetry: config.busyRetry,
  });
}

/**
 * 初始化 SQLite / LibSQL 连接并配置运行时 PRAGMA。
 *
 * 返回的 `client` 具备连接自愈能力（见 `ReconnectableClient`）：写锁竞争导致连接被污染时
 * 会自动换连接并重试一次；`reconnect`/`reconnectCount` 供调用方观测或强制自愈。
 */
export async function createDatabase(
  config: DatabaseConfig = {},
): Promise<{
  db: AervoxDatabase;
  client: Client;
  reconnect: () => Promise<void>;
  reconnectCount: () => number;
}> {
  const url = config.url ?? process.env.DATABASE_URL ?? defaultDbUrl;
  const isLocalSqlite = url.startsWith("file:") || !url.includes("://");

  // 先确保文件父目录存在（libsql createClient 构造时即打开文件，必须在其之前创建 <repo>/data）
  if (isLocalSqlite) {
    const filePath = url.startsWith("file:") ? url.slice("file:".length) : url;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // 目录已存在或路径不可创建时忽略
    }
  }

  /** 建立一条已完成 PRAGMA 配置的新连接（首次与重连共用，保证自愈后配置一致） */
  const createAndPrepare = async (): Promise<Client> => {
    const created = createClient({
      url,
      authToken: config.authToken ?? process.env.DATABASE_AUTH_TOKEN,
    });

    // 非 http 远端模式下执行 SQLite 运行时 PRAGMA 优化
    if (isLocalSqlite) {
      const timeout = config.busyTimeoutMs ?? 5000;
      await created.execute(`PRAGMA busy_timeout = ${timeout};`);
      await created.execute("PRAGMA foreign_keys = ON;");
      try {
        await created.execute("PRAGMA journal_mode = WAL;");
        await created.execute("PRAGMA synchronous = NORMAL;");
      } catch {
        // 特殊环境忽略 WAL
      }
    }
    return created;
  };

  const initial = await createAndPrepare();
  const reconnectable = createReconnectableClient({ createAndPrepare, initial });

  // T-01：写路径统一 busy 退避重试（仅影响写入口，调用方零侵入）。
  // 顺序：内层负责“换连接自愈”，外层负责“同一连接内的退避重试”。
  const retryingClient = withBusyRetry(reconnectable, config.busyRetry);

  const db = drizzle(retryingClient, { schema });
  return {
    db,
    client: retryingClient,
    reconnect: () => reconnectable.reconnect(),
    reconnectCount: () => reconnectable.reconnectCount(),
  };
}

let cachedTemplatePath: string | null = null;
let templateInitPromise: Promise<string> | null = null;

export interface InMemoryDatabaseOptions {
  /**
   * 是否创建完全空白的临时数据库（不从已构建的 Schema 模板文件克隆）。
   * 缺省为 false（默认克隆预构建模板，将建表开销降至亚毫秒级）。
   */
  empty?: boolean;
}

async function getOrInitTemplateDatabase(): Promise<string> {
  if (cachedTemplatePath && fs.existsSync(cachedTemplatePath)) {
    return cachedTemplatePath;
  }
  if (!templateInitPromise) {
    templateInitPromise = (async () => {
      const templateFile = path.join(
        os.tmpdir(),
        `aervox_template_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.db`,
      );
      const { client } = await createDatabase({ url: `file:${templateFile}` });
      const { initDatabaseSchema } = await import("./schema/ddl/index.js");
      await initDatabaseSchema(client);
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE);");
      client.close();
      cachedTemplatePath = templateFile;
      return templateFile;
    })().catch((err) => {
      templateInitPromise = null;
      throw err;
    });
  }
  return templateInitPromise;
}

process.once("exit", () => {
  if (cachedTemplatePath) {
    try {
      if (fs.existsSync(cachedTemplatePath)) fs.unlinkSync(cachedTemplatePath);
      if (fs.existsSync(`${cachedTemplatePath}-wal`)) fs.unlinkSync(`${cachedTemplatePath}-wal`);
      if (fs.existsSync(`${cachedTemplatePath}-shm`)) fs.unlinkSync(`${cachedTemplatePath}-shm`);
    } catch {
      // 忽略退出清理异常
    }
  }
});

/**
 * 创建独立的临时测试数据库（用于单元测试与快速集成测试）。
 * 默认从预初始化 Schema 的模板文件瞬间克隆，亚毫秒级就绪；
 * 如需测试原始 DDL 流程，可传入 `{ empty: true }`。
 */
export async function createInMemoryDatabase(
  options: InMemoryDatabaseOptions = {},
): Promise<{
  db: AervoxDatabase;
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const tempFile = path.join(
    os.tmpdir(),
    `aervox_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
  );

  if (!options.empty) {
    const templateFile = await getOrInitTemplateDatabase();
    fs.copyFileSync(templateFile, tempFile);
  }

  const { db, client } = await createDatabase({ url: `file:${tempFile}` });

  const cleanup = async () => {
    try {
      client.close();
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      if (fs.existsSync(`${tempFile}-wal`)) fs.unlinkSync(`${tempFile}-wal`);
      if (fs.existsSync(`${tempFile}-shm`)) fs.unlinkSync(`${tempFile}-shm`);
    } catch {
      // 忽略清理异常
    }
  };

  return { db, client, cleanup };
}
