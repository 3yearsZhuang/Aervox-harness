/**
 * Aervox｜思隅 @aervox/repositories — P2P SQLite 增量 Changeset 提取、对齐与冲突自愈引擎（ITER-028）
 *
 * 设计依据：
 * - SQLite Session Extension / 逻辑时钟增量追踪；
 * - 纯本地去中心化同步：无中心权威服务器，双端基于 LWW（Last-Write-Wins）结合确定性 Tiebreaker 裁决；
 * - 领域适配：
 *   - 学习事实（question_attempts、turns）为不可变事件流，采用 Append-Only / INSERT OR IGNORE 策略；
 *   - 学习进度与错题本（learning_goals、mistake_dispositions、knowledge_items）采用 LWW 状态覆盖；
 *   - 保证双端离线变更在重新连网同步后达成强最终一致性（Strong Eventual Consistency）。
 */
import type { Client, InValue } from "@libsql/client";
import {
  type EstablishedP2PSession,
  encryptSyncPayload,
  decryptSyncPayload,
  type EncryptedSyncPayload,
} from "./p2p-pairing.js";

function toInValue(v: unknown): InValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return new Uint8Array(v);
  return JSON.stringify(v);
}

/** 支持同步的表定义与冲突合并策略 */
export type SyncMergeStrategy = "lww" | "append_only";

export interface SyncTableDefinition {
  tableName: string;
  primaryKey: string;
  timestampColumn?: string; // 用于 LWW 比对的时间列，默认 "updated_at"
  strategy: SyncMergeStrategy;
}

/** 默认预置的个人学习与错题本同步表白名单 */
export const DEFAULT_SYNC_TABLES: SyncTableDefinition[] = [
  {
    tableName: "learning_goals",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "questions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "question_attempts",
    primaryKey: "id",
    timestampColumn: "created_at",
    strategy: "append_only",
  },
  {
    tableName: "mistake_dispositions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "knowledge_items",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "sessions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "turns",
    primaryKey: "id",
    timestampColumn: "created_at",
    strategy: "append_only",
  },
];

/** 单表增量变更集（仿 SQLite Session Changeset 结构） */
export interface TableChangeset {
  tableName: string;
  primaryKey: string;
  strategy: SyncMergeStrategy;
  records: Array<Record<string, unknown>>;
}

/** 完整的端到端同步包 */
export interface P2PSyncBundle {
  bundleId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sinceWatermark?: string;
  generatedAt: string;
  tables: TableChangeset[];
}

/** 同步合并结果报告 */
export interface SyncMergeResult {
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  conflictsResolvedCount: number;
}

/** 检查 SQLite 表是否存在 */
async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const res = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [tableName],
  });
  return res.rows.length > 0;
}

/** 从 SQLite 提取单表增量数据 */
export async function extractTableChangeset(
  client: Client,
  def: SyncTableDefinition,
  options: { sinceWatermark?: string } = {},
): Promise<TableChangeset> {
  const exists = await tableExists(client, def.tableName);
  if (!exists) {
    return {
      tableName: def.tableName,
      primaryKey: def.primaryKey,
      strategy: def.strategy,
      records: [],
    };
  }

  const timeCol = def.timestampColumn ?? "updated_at";
  let sql = `SELECT * FROM "${def.tableName}"`;
  const args: InValue[] = [];

  if (options.sinceWatermark) {
    sql += ` WHERE "${timeCol}" > ? ORDER BY "${timeCol}" ASC`;
    args.push(options.sinceWatermark);
  } else {
    sql += ` ORDER BY "${def.primaryKey}" ASC`;
  }

  const res = await client.execute({ sql, args });
  const records = res.rows.map((r) => ({ ...r }));

  return {
    tableName: def.tableName,
    primaryKey: def.primaryKey,
    strategy: def.strategy,
    records,
  };
}

/** 构建完整的点对点增量同步包 */
export async function buildP2PSyncBundle(
  client: Client,
  options: {
    sourceDeviceId: string;
    targetDeviceId: string;
    sinceWatermark?: string;
    tables?: SyncTableDefinition[];
  },
): Promise<P2PSyncBundle> {
  const tableDefs = options.tables ?? DEFAULT_SYNC_TABLES;
  const tables: TableChangeset[] = [];

  for (const def of tableDefs) {
    const cs = await extractTableChangeset(client, def, { sinceWatermark: options.sinceWatermark });
    if (cs.records.length > 0) {
      tables.push(cs);
    }
  }

  return {
    bundleId: `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sourceDeviceId: options.sourceDeviceId,
    targetDeviceId: options.targetDeviceId,
    sinceWatermark: options.sinceWatermark,
    generatedAt: new Date().toISOString(),
    tables,
  };
}

/**
 * 将远端同步包应用合并到本地 SQLite 数据库中。
 * 遵循 LWW 配合设备 ID 字典序 Tiebreaker，杜绝时钟倾斜与并发修改震荡。
 */
export async function applyP2PSyncBundle(
  client: Client,
  bundle: P2PSyncBundle,
  localDeviceId: string,
): Promise<SyncMergeResult> {
  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let conflictsResolvedCount = 0;

  // 在单个写事务中原子应用增量变更
  const tx = await client.transaction("write");

  try {
    for (const table of bundle.tables) {
      const exists = await tableExists(client, table.tableName);
      if (!exists) continue;

      const timeCol = table.strategy === "lww" ? "updated_at" : "created_at";

      for (const incomingRow of table.records) {
        const pkValue = incomingRow[table.primaryKey];
        if (pkValue === undefined || pkValue === null) continue;

        // 查询本地已有记录
        const existingRes = await tx.execute({
          sql: `SELECT * FROM "${table.tableName}" WHERE "${table.primaryKey}" = ? LIMIT 1`,
          args: [toInValue(pkValue)],
        });

        const existingRow = existingRes.rows[0];

        if (!existingRow) {
          // 1. 本地无对应记录：直接插入
          const cols = Object.keys(incomingRow);
          const placeholders = cols.map(() => "?").join(", ");
          const values = cols.map((col) => toInValue(incomingRow[col]));

          await tx.execute({
            sql: `INSERT INTO "${table.tableName}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
            args: values,
          });
          insertedCount++;
        } else if (table.strategy === "append_only") {
          // 2. 不可变事实（如答题历史）：本地已存在则幂等忽略
          skippedCount++;
        } else {
          // 3. 状态覆盖（LWW 策略）：对比 updated_at
          const incomingTime = String(incomingRow[timeCol] ?? "");
          const existingTime = String(existingRow[timeCol] ?? "");

          let shouldUpdate = false;
          if (incomingTime > existingTime) {
            shouldUpdate = true;
          } else if (incomingTime === existingTime) {
            // 时间戳完全相同：以 sourceDeviceId 字典序较大者作为确定性 Tiebreaker
            if (bundle.sourceDeviceId > localDeviceId) {
              shouldUpdate = true;
              conflictsResolvedCount++;
            } else {
              skippedCount++;
            }
          } else {
            // 本地记录更新：保留本地，丢弃远端旧版本
            skippedCount++;
          }

          if (shouldUpdate) {
            const colsToUpdate = Object.keys(incomingRow).filter((col) => col !== table.primaryKey);
            const setClause = colsToUpdate.map((c) => `"${c}" = ?`).join(", ");
            const values = colsToUpdate.map((col) => toInValue(incomingRow[col]));
            values.push(toInValue(pkValue));

            await tx.execute({
              sql: `UPDATE "${table.tableName}" SET ${setClause} WHERE "${table.primaryKey}" = ?`,
              args: values,
            });
            updatedCount++;
          }
        }
      }
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }

  return {
    insertedCount,
    updatedCount,
    skippedCount,
    conflictsResolvedCount,
  };
}

/**
 * 完整模拟两台设备（如 Node A: Electron 桌面端, Node B: Capacitor 移动端）
 * 通过加密通道进行双向 P2P 增量同步与数据对齐。
 */
export async function executeP2PBidirectionalSync(options: {
  nodeA: { client: Client; deviceId: string };
  nodeB: { client: Client; deviceId: string };
  session: EstablishedP2PSession;
  tables?: SyncTableDefinition[];
  watermarks?: { aSince?: string; bSince?: string };
}): Promise<{
  aToBResult: SyncMergeResult;
  bToAResult: SyncMergeResult;
  syncTimestamp: string;
}> {
  const syncTimestamp = new Date().toISOString();

  // 1. Node A 提取增量 Changeset 并加密发送给 Node B
  const bundleA = await buildP2PSyncBundle(options.nodeA.client, {
    sourceDeviceId: options.nodeA.deviceId,
    targetDeviceId: options.nodeB.deviceId,
    sinceWatermark: options.watermarks?.bSince,
    tables: options.tables,
  });

  const encryptedAtoB: EncryptedSyncPayload = encryptSyncPayload(options.session, bundleA);

  // 2. Node B 解密并应用 Node A 的 Changeset
  const decryptedAtoB = decryptSyncPayload<P2PSyncBundle>(options.session, encryptedAtoB);
  const aToBResult = await applyP2PSyncBundle(options.nodeB.client, decryptedAtoB, options.nodeB.deviceId);

  // 3. Node B 提取自身增量 Changeset 并加密发送给 Node A
  const bundleB = await buildP2PSyncBundle(options.nodeB.client, {
    sourceDeviceId: options.nodeB.deviceId,
    targetDeviceId: options.nodeA.deviceId,
    sinceWatermark: options.watermarks?.aSince,
    tables: options.tables,
  });

  const encryptedBtoA: EncryptedSyncPayload = encryptSyncPayload(options.session, bundleB);

  // 4. Node A 解密并应用 Node B 的 Changeset
  const decryptedBtoA = decryptSyncPayload<P2PSyncBundle>(options.session, encryptedBtoA);
  const bToAResult = await applyP2PSyncBundle(options.nodeA.client, decryptedBtoA, options.nodeA.deviceId);

  return {
    aToBResult,
    bToAResult,
    syncTimestamp,
  };
}
