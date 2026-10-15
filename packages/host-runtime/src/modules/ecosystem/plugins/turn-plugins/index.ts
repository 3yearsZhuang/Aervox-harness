/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件体系导出
 *
 * CR-060：具体插件实现不再位于宿主（已迁至 `plugins/<id>/src/server`），
 * 本出口只暴露通用契约与编排器。
 */
export * from "./types.js";
export * from "./registry.js";
export * from "./runner.js";
