/**
 * Aervox｜思隅 @aervox/schema — 表结构汇总导出
 *
 * W-19 拆分产物：Drizzle 表定义层，仅依赖 drizzle-orm。
 * DDL 初始化（依赖 search/fts）位于 `@aervox/repositories` 侧，不在此导出。
 */
export * from "./common.js";
export * from "./conversations.js";
export * from "./memories.js";
export * from "./memory-compaction.js";
export * from "./embeddings.js";
export * from "./diaries.js";
export * from "./outbox.js";
export * from "./learning.js";
export * from "./feedback.js";
export * from "./provenance.js";
export * from "./platform.js";
export * from "./safety.js";
export * from "./privacy.js";
export * from "./ledger.js";
export * from "./analytics.js";
export * from "./content.js";
export * from "./ecosystem.js";
export * from "./persona.js";
export * from "./tool-registry.js";
export * from "./mcp.js";
export * from "./skills.js";
export * from "./plugin-config.js";
export * from "./voice.js";
export * from "./llm.js";
export * from "./preferences.js";
export * from "./study-materials.js";
export * from "./tool-executions.js";
export * from "./tool-approvals.js";
export * from "./safe-segments.js";
export * from "./agent-inbox.js";
export * from "./subagent-runs.js";
export * from "./audit.js";
export * from "./user-question.js";
export * from "./proactive.js";
export * from "./proactive-intelligence.js";
