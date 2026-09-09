/**
 * Aervox｜思隅 @aervox/database — Git 数据版本/同步层（T-09 接线）
 *
 * 参照 BaiShou-Next 用 git 提交作为数据版本历史的手法（AGPLv3，仅借鉴公开设计，
 * 具体实现自研）：以数据库行级快照作为版本单元，导出为可读 JSON，再由 git
 * 记录历史（提交即版本点，log 即可分页历史）。
 *
 * 本模块只做「快照导出/恢复」这一数据侧骨架；git 提交/回滚由宿主（CLI / 桌面）
 * 按需调用，避免本包对 git CLI 形成链路依赖。恢复前注意先备份当前库。
 */
import type { Client } from "@libsql/client";

export interface DatabaseSnapshot {
  /** 导出版本（递增，避免名称歧义） */
  version: number;
  /** 导出时间 ISO */
  exportedAt: string;
  /** 表名 → 行数组（行 = 字段名 → 值；SQLite 值仅 number/string/null/BigInt 需归一） */
  tables: Record<string, Array<Record<string, unknown>>>;
}

/** 快照文件命名约定（供 git 层直接引用，避免异构） */
export function snapshotFileName(version: number): string {
  return `snapshot-v${version}.json`;
}

/** 排除系统/派生表（WAL、虚拟表、索引不参与导出，靠建表语句重建） */
const EXCLUDED_TABLES = new Set([
  "_migration_journal",
  "messages_fts",
  "memories_fts",
]);

function normalizeCell(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value as Uint8Array).toString("base64");
  }
  // 防非标量对象混入（sqlite3 不应出现，防御性归一）
  if (value !== null && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return value;
}

/** 列出全部用户表（排除 sqlite_* 系统表与派生虚表） */
async function listUserTables(client: Client): Promise<string[]> {
  const res = await client.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  return res.rows
    .map((row) => String(row.name))
    .filter((name) => !EXCLUDED_TABLES.has(name));
}

/** 导出全库为行级快照（分表导出；大表由调用方分批处理） */
export async function exportSnapshot(client: Client, version: number): Promise<DatabaseSnapshot> {
  const tables: DatabaseSnapshot["tables"] = {};
  for (const table of await listUserTables(client)) {
    const res = await client.execute(`SELECT * FROM "${table}"`);
    tables[table] = res.rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) out[key] = normalizeCell(value);
      return out;
    });
  }
  return { version, exportedAt: new Date().toISOString(), tables };
}

/**
 * 快照序列化（人类可读 JSON）。宿主可用它写文件后交 git commit。
 */
export function serializeSnapshot(snapshot: DatabaseSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 从 JSON 恢复快照：逐表重建（先 DELETE 全部既有行再插入）。
 * ⚠ 破坏性操作，调用前必须确认；用于版本回滚。
 */
export async function restoreSnapshot(
  client: Client,
  snapshot: DatabaseSnapshot,
  options: { clearExisting?: boolean } = {},
): Promise<void> {
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    if (options.clearExisting !== false) {
      await client.execute(`DELETE FROM "${table}"`);
    }
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0]!);
    const placeholders = columns.map(() => "?").join(", ");
    const insertSql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`;
    for (const row of rows) {
      // SQLite 可绑定类型：number/string/bigint/Uint8Array/null
      const args: Array<string | number | bigint | Uint8Array | null> = columns.map((c) => {
        const value = normalizeCell(row[c]);
        if (value === undefined || value === null) return null;
        if (typeof value === "boolean") return value ? 1 : 0;
        if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
          return value;
        }
        return null;
      });
      await client.execute({ sql: insertSql, args });
    }
  }
}