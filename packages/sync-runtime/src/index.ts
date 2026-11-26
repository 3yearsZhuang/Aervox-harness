/**
 * Aervox｜思隅 @aervox/sync-runtime — 本机多端加密同步**原型**。
 *
 * 状态：零生产消费者。本包连同 `packages/repositories/src/sync/p2p-changeset.ts`
 * 目前只被 `packages/repositories/test/` 下的测试导入；不在 turbo build、CI 或
 * mise 任务任一处被引用。配对、设备身份、SAS 与分向密钥在这里是**已实现的原型**，
 * 不是可用的多设备同步能力——真实 mDNS、生产接线与多设备验收均未完成。
 * 决策入口见 plan.md 的 ITER-028。
 */
export * from "./protocol.js";
export * from "./pairing.js";
export * from "./discovery.js";
export * from "./transport.js";

export * from "./exchange.js";
