/**
 * Aervox｜思隅 @aervox/api — Worker 写入压力租约（ITER-027）
 *
 * 背景：会话流式/多轮密集执行期间，API 需要通知后台 Worker 降频退避，避免争抢
 * SQLite 写锁。旧实现由每次 runLoop 直接下发 `pressure(true, 15s)` 并在 finally 里
 * `pressure(false)`，存在两个缺陷：
 * 1. 并发会话下，先结束的会话会提前解除压力，仍在写入的会话失去保护；
 * 2. 15 秒窗口对超过 15 秒的长回合会在会话中途失效。
 *
 * 本模块用进程内租约解决：每个并发回合持有一个租约，只有**最后一个**租约释放时才下发
 * `pressure(false)`；租约持有期间按 REFRESH_INTERVAL_MS 续期，长回合不会中途掉出窗口。
 * 进程崩溃时 Worker 侧看门狗会在窗口到期后自动恢复，无需显式清理；超过
 * PRESSURE_LEASE_MAX_MS 的租约会停止续期并自动释放，避免泄漏租约永久抑制后台任务。
 *
 * 已知次序限制：`true`/`false` 走各自独立的 socket 连接，无法保证跨连接的投递顺序，
 * 因此"释放"可能被在途的"续期"覆盖，形成至多一个续期周期（≤10s）的额外压力窗口。
 * Worker 侧窗口单调延长，且该窗口本身有界，因此影响可控；如需严格次序需改为带序号的控制协议。
 */
import { notifyWorkerPressure } from "@aervox/repositories";

/** 单次压力窗口时长；租约续期保证活跃期间持续有效 */
export const PRESSURE_LEASE_TTL_MS = 15_000;
/** 续期间隔，必须显著小于 TTL，避免网络/事件循环抖动导致窗口空档 */
export const PRESSURE_LEASE_REFRESH_MS = 10_000;
/**
 * 租约的硬上限。超过后停止续期并释放，避免"泄漏的租约"（异常路径未释放、
 * 长跑进程堆积）永久压低后台任务节奏；Worker 侧的看门狗上限同样有界。
 */
export const PRESSURE_LEASE_MAX_MS = 10 * 60_000;

interface LeaseEntry {
  timer: ReturnType<typeof setInterval>;
  acquiredAt: number;
}

const leases = new Map<string, LeaseEntry>();
let leaseSequence = 0;
let expiredLeaseCount = 0;

/** 因超过硬上限而被自动释放的租约数量（观测用） */
export function expiredWorkerPressureLeaseCount(): number {
  return expiredLeaseCount;
}

/**
 * 获取一个写入压力租约。返回租约 id，必须在 finally 中调用
 * `releaseWorkerPressureLease` 释放。
 */
export function acquireWorkerPressureLease(): string {
  leaseSequence += 1;
  const leaseId = `pressure_${leaseSequence}_${Date.now().toString(36)}`;
  const entry: LeaseEntry = {
    acquiredAt: Date.now(),
    timer: setInterval(() => {
      const current = leases.get(leaseId);
      if (!current) return;
      if (Date.now() - current.acquiredAt >= PRESSURE_LEASE_MAX_MS) {
        // 硬上限：停止续期并释放，避免永久抑制后台任务
        clearInterval(current.timer);
        leases.delete(leaseId);
        expiredLeaseCount += 1;
        if (leases.size === 0) {
          void notifyWorkerPressure(false);
        }
        return;
      }
      void notifyWorkerPressure(true, PRESSURE_LEASE_TTL_MS);
    }, PRESSURE_LEASE_REFRESH_MS),
  };
  // 续期定时器不应阻止进程退出
  entry.timer.unref?.();
  leases.set(leaseId, entry);
  void notifyWorkerPressure(true, PRESSURE_LEASE_TTL_MS);
  return leaseId;
}

/** 释放租约；仅在最后一个租约释放后才真正解除 Worker 压力模式。 */
export function releaseWorkerPressureLease(leaseId: string): void {
  const entry = leases.get(leaseId);
  if (!entry) return;
  clearInterval(entry.timer);
  leases.delete(leaseId);
  if (leases.size === 0) {
    void notifyWorkerPressure(false);
  }
}

/** 当前活跃租约数（观测与测试用） */
export function activeWorkerPressureLeaseCount(): number {
  return leases.size;
}

/** 测试夹具：清空全部租约并解除压力，避免用例间相互污染。 */
export function resetWorkerPressureLeasesForTest(): void {
  for (const entry of leases.values()) {
    clearInterval(entry.timer);
  }
  leases.clear();
  leaseSequence = 0;
  expiredLeaseCount = 0;
}
