/**
 * Aervox｜思隅 @aervox/database — Schema 汇总导出（兼容层）
 *
 * W-19 阶段 2：表结构已平移至 `@aervox/schema`，本文件 re-export 以保持
 * 消费方 `import {...} from "@aervox/database"` 的既有路径不变。
 * `init.ts`（DDL 初始化，依赖 `../search/fts.js`）仍在本包，随此导出。
 */
export * from "@aervox/schema";
export * from "./init.js";
