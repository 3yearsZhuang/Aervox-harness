/**
 * Aervox｜思隅 @aervox/database — 模式公共列与辅助定义
 */
import { text } from "drizzle-orm/sqlite-core";

export const timestampColumns = {
  /** 创建时间（ISO8601 UTC 字符串） */
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  /** 更新时间（ISO8601 UTC 字符串） */
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
};
