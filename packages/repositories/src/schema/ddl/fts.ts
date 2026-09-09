/**
 * Aervox｜思隅 @aervox/repositories — fts 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { initFtsTables } from "../../search/fts.js";

export async function createFtsTables(client: Client): Promise<void> {
  // 5. 初始化 FTS5 全文检索引擎
    await initFtsTables(client);
}
