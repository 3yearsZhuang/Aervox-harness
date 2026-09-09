/**
 * Aervox｜思隅 @aervox/database — 纯本地数据访问层（Schema + 仓储 + 基础设施）
 */
export * from "./schema/index.js";
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
export {
  addColumnIfMissing,
  initDatabaseSchema,
  initLedgerSchema,
} from "./schema/init.js";
