/**
 * Aervox｜思隅 @aervox/core — Loop 领域错误（B1：事件写入 fencing）
 *
 * 执行存储实现（生产 @aervox/host-agent → @aervox/repositories）在事件写入被 fencing
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

/**
 * 上下文压缩错误（ITER-032：PI-01 阻塞式压缩失败可见）
 * 摘要 Provider 失败、超时或违背配对规则时抛出，让阻塞失败可见，避免盲目发出超大请求。
 */
export class CompactionError extends Error {
  readonly code = "COMPACTION_FAILED";

  constructor(message = "context compaction failed", public readonly cause?: unknown) {
    super(message);
    this.name = "CompactionError";
  }
}