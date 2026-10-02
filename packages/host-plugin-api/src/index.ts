/**
 * Aervox｜思隅 @aervox/host-plugin-api — 公共导出（CR-060 / AVX-PLUG-001 §0.3）
 *
 * 第一方插件与宿主之间的唯一装配契约：只含类型与窄端口，零运行时依赖。
 * 宿主实现见 `apps/api/src/plugin-assembly.ts`（组合根在启用插件时装配贡献）。
 */
export * from "./turn-plugin.js";
export * from "./contribution.js";
