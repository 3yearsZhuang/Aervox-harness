/**
 * Aervox｜思隅 @aervox/database — 兼容组合包（W-19 过渡态）
 *
 * W-19 阶段 3 后，本包为纯兼容 re-export：表结构在 `@aervox/schema`，
 * 数据访问层在 `@aervox/repositories`。保留本包以维持消费方
 * `import {...} from "@aervox/database"` 的既有路径不变，最终在阶段 6 清理。
 */
export * from "@aervox/schema";
export * from "@aervox/repositories";
