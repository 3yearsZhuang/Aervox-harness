/**
 * Aervox｜思隅 @aervox/repositories — 数据访问层（仓储 + 基础设施）
 *
 * W-19 拆分产物：仓储接口 + SQLite 实现 + client/tenant/errors 等基础设施散件，
 * 依赖 `@aervox/schema`（表结构）+ drizzle-orm + @libsql/client。
 */
export * from "@aervox/schema";
export * from "./client.js";
export * from "./proactive-vault-crypto.js";
export * from "./proactive-vault-auth.js";
export * from "./errors.js";
export * from "./tenant.js";
export * from "./search/index.js";
export * from "./write-retry.js";
export * from "./session-lock.js";
export * from "./token-usage.js";
export * from "./migration/index.js";
export * from "./sync/index.js";
export * from "./repositories/index.js";
export * from "./schema/init.js";
