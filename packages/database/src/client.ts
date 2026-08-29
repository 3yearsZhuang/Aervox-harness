/**
 * Aervox｜思隅 @aervox/database — 客户端与连接管理
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
import * as schema from "./schema/index.js";
import { withBusyRetry, type BusyRetryConfig } from "./write-retry.js";

export type AervoxDatabase = LibSQLDatabase<typeof schema>;

/**
 * 仓库根目录（src/client.ts 或 dist/client.js 均向上三级到达仓库根）。
 * 用于统一 API / Worker / 多进程默认数据库真源路径。
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
/** 默认共享数据库文件：<repo>/data/aervox.db */
const defaultDbUrl = `file:${path.join(repoRoot, "data", "aervox.db")}`;

function proactiveApplicationDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Aervox");
  }
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Aervox");
  }
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "aervox");
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
 * 初始化 SQLite / LibSQL 连接并配置运行时 PRAGMA
 */
export async function createDatabase(
  config: DatabaseConfig = {},
): Promise<{ db: AervoxDatabase; client: Client }> {
  const url = config.url ?? process.env.DATABASE_URL ?? defaultDbUrl;

  // 先确保文件父目录存在（libsql createClient 构造时即打开文件，必须在其之前创建 <repo>/data）
  if (url.startsWith("file:") || !url.includes("://")) {
    const filePath = url.startsWith("file:") ? url.slice("file:".length) : url;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch {
      // 目录已存在或路径不可创建时忽略
    }
  }

  const client = createClient({
    url,
    authToken: config.authToken ?? process.env.DATABASE_AUTH_TOKEN,
  });

  // 非 http 远端模式下执行 SQLite 运行时 PRAGMA 优化
  if (url.startsWith("file:") || !url.includes("://")) {
    const timeout = config.busyTimeoutMs ?? 5000;
    await client.execute(`PRAGMA busy_timeout = ${timeout};`);
    await client.execute("PRAGMA foreign_keys = ON;");
    try {
      await client.execute("PRAGMA journal_mode = WAL;");
      await client.execute("PRAGMA synchronous = NORMAL;");
    } catch {
      // 特殊环境忽略 WAL
    }
  }

  // T-01：写路径统一 busy 退避重试（仅影响写入口，调用方零侵入）
  const retryingClient = withBusyRetry(client, config.busyRetry);

  const db = drizzle(retryingClient, { schema });
  return { db, client: retryingClient };
}

/**
 * 创建独立的临时测试数据库（用于单元测试与快速集成测试）
 */
export async function createInMemoryDatabase(): Promise<{
  db: AervoxDatabase;
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const tempFile = path.join(
    os.tmpdir(),
    `aervox_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
  );
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
