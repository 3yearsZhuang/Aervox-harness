/**
 * Aervox｜思隅 @aervox/host-agent/core — 纯轻量内核公共导出（ADR-020 / ITER-025）
 *
 * 仅导出纯内存、进程内执行管道、工具沙箱与三端审批能力，
 * 绝不拉取 SQLite、LibSQL、Drizzle 表元数据等持久层重型依赖。
 * 用于 CLI、无头 Agent、测试桩及独立轻量运行时。
 */
export * from "./pipeline.js";
export * from "./cli-approval.js";
export * from "./host-tool-runtime.js";
export * from "./profile.js";
export * from "./adapter-turn.js";
export * from "./stdio-adapter.js";
