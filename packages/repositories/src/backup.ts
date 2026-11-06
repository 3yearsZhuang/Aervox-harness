/**
 * Aervox｜思隅 @aervox/repositories/backup — 逻辑备份范围与派生投影重建（WebView/原生可装载）
 *
 * 与 `./conversation`、`./learning`、`./persona` 一致：只导出浏览器安全的依赖闭包，
 * 不引 node: 内置模块。移动端恢复用它排除派生/凭据表，并在覆盖业务表后按权威来源
 * 重建 FTS 投影；API 侧的 staging 迁移复用同一重建入口。
 */
export {
  BACKUP_EXCLUDED_TABLES,
  BACKUP_EXCLUDED_TABLE_SET,
  DERIVED_SEARCH_TABLE_PATTERN,
  backupExclusionReason,
  isBackupScopedTable,
  isDerivedSearchTable,
} from "./backup-scope.js";
export { rebuildSearchProjections } from "./search/fts-neutral.js";
