/**
 * Aervox｜思隅 @aervox/agent-loop — Loop 领域错误（B1：事件写入 fencing）
 *
 * 执行存储实现（生产 @aervox/host-agent → @aervox/database）在事件写入被 fencing
 * CAS 拒绝时抛出本错误。executor 捕获后立即停止产生新副作用并收敛为 lease_lost
 * （AVX-HAR-001 §11.2「续租失败立即停止产生新副作用」）。
 */
export class LeaseLostError extends Error {
  readonly code = "LEASE_LOST";

  constructor(message = "attempt lease lost: event write rejected") {
    super(message);
    this.name = "LeaseLostError";
  }
}