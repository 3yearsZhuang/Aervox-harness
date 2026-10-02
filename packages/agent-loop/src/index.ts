/**
 * Aervox｜思隅 @aervox/agent-loop — re-export 壳（ADR-021 Decision 2）
 *
 * 全部实现已吸收至 `@aervox/core`；本包仅为过渡期兼容层，
 * 一个迭代后移除。四下游（diary / host-agent / api / worker）import 保持不变。
 */
export * from "@aervox/core";
