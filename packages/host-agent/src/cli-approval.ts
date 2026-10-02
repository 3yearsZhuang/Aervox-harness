/**
 * Aervox｜思隅 @aervox/host-agent — cli-approval 兼容 re-export（ADR-021）
 *
 * 实现已迁入 `@aervox/core`（消除本包对轻量消费者的 libsql 依赖拖拽）。
 * 本文件仅 re-export 原 `CliInteractiveApprovalPolicy` 公共符号以保持导出面兼容；
 * 随 agent-loop 壳移除一并清理。
 */
export { CliInteractiveApprovalPolicy } from "@aervox/core";
export type { CliInteractiveApprovalPolicyOptions } from "@aervox/core";
