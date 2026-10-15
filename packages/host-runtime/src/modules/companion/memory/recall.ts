/**
 * Aervox｜思隅 @aervox/api — 记忆检索与召回门面
 *
 * 统一重定向至 @aervox/host-agent 的通用实现，保持 API 模块既有导出接口不变。
 */
export {
  createSqliteMemoryRecall,
  buildMemoryContext,
  AUTO_RECALL_CONSENT_PURPOSE,
  AUTO_RECALL_CONSENT_SCOPE,
  type RecalledMemory,
  type MemoryRecallPort,
  type SqliteMemoryRecallOptions,
} from "@aervox/host-agent";
