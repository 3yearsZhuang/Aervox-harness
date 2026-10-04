/**
 * Aervox｜思隅 @aervox/core — 独立内核包公共导出（ADR-021 及其内核提纯修订）
 *
 * 吸收 agent-loop 内核内容 + CLI 审批策略 + HostToolRuntime 内存版。
 * 伴学产品构件（教学模式提示词、作答落库工具及其 Port 契约）已按内核提纯修订
 * 回归插件宿主（apps/api 装配点与 plugins/ 第一方插件），内核只保留通用执行/审批/提示词基座能力。
 * 运行时依赖为空（dependencies: {}）；禁止引入 SQLite/LibSQL/Drizzle 等持久层依赖。
 */
export * from "./types.js";
export * from "./ports.js";
export * from "./errors.js";
export * from "./context-builder.js";
export * from "./replay-provider.js";
export * from "./openai-compat-provider.js";
export * from "./tool-provider.js";
export * from "./executor.js";
export * from "./in-memory-store.js";
export * from "./in-memory-inbox.js";
export * from "./adapter-contract.js";
export * from "./adapter-sim.js";
export * from "./base-prompt.js";
export * from "./subagent-contribution.js";
export * from "./user-question-tool.js";
export * from "./resume.js";
export * from "./lease-heartbeat.js";
export * from "./tool-result-safe.js";
export * from "./tool-input-safe.js";
export * from "./control-context.js";
export * from "./approval-policy.js";
export * from "./cli-approval.js";
export * from "./host-tool-runtime.js";
export * from "./turn-terminator.js";
export * from "./tool-ledger.js";
export * from "./tool-pipeline.js";
export * from "./step-collector.js";
export * from "./safe-serialize.js";
export * from "./stable-serialize.js";
export * from "./approval-decision.js";
export * from "./core.js";
