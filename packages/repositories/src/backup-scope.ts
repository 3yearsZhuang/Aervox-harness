/**
 * Aervox｜思隅 @aervox/repositories — 备份范围（浏览器安全，无 node: 内置依赖）
 *
 * 逻辑备份只搬运**权威业务事实**。三类别外：
 *
 * 1. 派生检索投影（`messages_fts` / `memories_fts` 及其 shadow 表）：由权威来源重建，
 *    从不作为普通表写回。SQLite 的 FTS5 shadow 表不接受 raw INSERT，任何越过虚表
 *    API 的写回都会以 `SQLITE_CORRUPT_VTAB` 失败或让后续索引写入损坏。
 * 2. 凭据与设备作用域（模型密钥、MCP token、插件 Secret、Bot 会话、外部连接）：
 *    与 [plugin-config-and-pages](../../../docs/reference/plugin-config-and-pages.md)
 *    的「排除 Secret」及 CR-004「不导出 MCP 凭据」一致；跨机恢复须由用户重新配置。
 * 3. 结构版本元数据（`_aervox_schema_versions`）：见
 *    [DATABASE](../../../docs/reference/DATABASE.md#3-本地存储拓扑)。
 *
 * 恢复时同样跳过这些表；删除/撤权事实另由恢复准入门禁保护（见 native-runtime）。
 */

/** 与 schema/manifest 共享同一派生投影判据，避免两处正则漂移。 */
export const DERIVED_SEARCH_TABLE_PATTERN = /^(messages|memories)_fts(?:_(?:data|idx|content|docsize|config))?$/;

export function isDerivedSearchTable(name: string): boolean {
  return DERIVED_SEARCH_TABLE_PATTERN.test(name);
}

/** Credential/device-scope tables: never exported, never overwritten by a restore. */
export const BACKUP_EXCLUDED_TABLES: readonly string[] = Object.freeze([
  "llm_configs",
  "mcp_servers",
  "plugin_configs",
  "plugin_config_secrets",
  "voice_configs",
  "voice_input_configs",
  "voice_remote_configs",
  "bot_connections",
  "bot_inbox",
  "bot_deliveries",
  "bot_session_bindings",
  "proactive_external_connections",
  "deletion_requests",
  "deletion_targets",
  "_aervox_schema_versions",
]);

export const BACKUP_EXCLUDED_TABLE_SET: ReadonlySet<string> = new Set(BACKUP_EXCLUDED_TABLES);

/** True when a logical backup may carry this table's rows. */
export function isBackupScopedTable(name: string): boolean {
  return !isDerivedSearchTable(name) && !BACKUP_EXCLUDED_TABLE_SET.has(name);
}

/** Tables the restore must leave untouched (same rule, evaluated on the live schema). */
export function backupExclusionReason(name: string): "derived_search" | "credential_scope" | "schema_metadata" | null {
  if (isDerivedSearchTable(name)) return "derived_search";
  if (name === "_aervox_schema_versions") return "schema_metadata";
  if (BACKUP_EXCLUDED_TABLE_SET.has(name)) return "credential_scope";
  return null;
}
