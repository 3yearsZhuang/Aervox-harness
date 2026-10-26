/**
 * Aervox｜思隅 @aervox/core — 独立内核包公共导出（ADR-021 及其内核提纯修订）
 *
 * 吸收 agent-loop 内核内容 + CLI 审批策略 + HostToolRuntime 内存版。
 * 伴学产品构件（教学模式提示词、作答落库工具及其 Port 契约）已按内核提纯修订
 * 回归插件宿主（apps/api 装配点与 plugins/ 第一方插件），内核只保留通用执行/审批/提示词基座能力。
 * 运行时依赖为空（dependencies: {}）；禁止引入 SQLite/LibSQL/Drizzle 等持久层依赖。
 */
export * from "./browser.js";
export * from "./cli-approval.js";
