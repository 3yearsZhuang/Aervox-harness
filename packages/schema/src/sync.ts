/**
 * Aervox｜思隅 @aervox/schema — P2P 同步行状态表（ITER-028 墓碑与来源戳）
 */
import { sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/**
 * 同步行状态表：每个被同步行的权威来源与删除墓碑。
 * 主键为 `(table_name, primary_key)` 复合键，属纯本地单用户真源，不含租户字段。
 */
export const syncRowState = sqliteTable(
  "sync_row_state",
  {
    tableName: text("table_name").notNull(),
    primaryKeyValue: text("primary_key").notNull(),
    originDeviceId: text("origin_device_id").notNull(),
    originTimestamp: text("origin_timestamp").notNull(),
    deletedAt: text("deleted_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tableName, table.primaryKeyValue] }),
    originTsIdx: index("sync_row_state_origin_ts_idx").on(table.tableName, table.originTimestamp),
    tombstoneIdx: index("sync_row_state_tombstone_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  }),
);

export type SyncRowStateRow = typeof syncRowState.$inferSelect;
export type NewSyncRowStateRow = typeof syncRowState.$inferInsert;
