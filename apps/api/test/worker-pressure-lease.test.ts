import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ITER-027 写入压力租约：验证并发回合不会互相提前解除压力，且长回合靠续期维持窗口。
 * 旧实现由每次 runLoop 直接下发 pressure(true, 15s) / finally pressure(false)，
 * 并发会话下先结束者会解除仍在写入者的保护。
 */
const notifyWorkerPressure = vi.fn().mockResolvedValue(true);

vi.mock("@aervox/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aervox/repositories")>();
  return { ...actual, notifyWorkerPressure };
});

const {
  acquireWorkerPressureLease,
  releaseWorkerPressureLease,
  activeWorkerPressureLeaseCount,
  expiredWorkerPressureLeaseCount,
  resetWorkerPressureLeasesForTest,
  PRESSURE_LEASE_MAX_MS,
  PRESSURE_LEASE_REFRESH_MS,
  PRESSURE_LEASE_TTL_MS,
} = await import("../src/shared/worker-pressure-lease.js");

describe("ITER-027 Worker 写入压力租约", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    notifyWorkerPressure.mockClear();
    resetWorkerPressureLeasesForTest();
  });

  afterEach(() => {
    resetWorkerPressureLeasesForTest();
    vi.useRealTimers();
  });

  it("并发租约：只有最后一个租约释放才下发 pressure(false)", () => {
    const first = acquireWorkerPressureLease();
    const second = acquireWorkerPressureLease();
    expect(activeWorkerPressureLeaseCount()).toBe(2);

    // 两个租约各自申请时都下发了 true
    expect(notifyWorkerPressure).toHaveBeenCalledWith(true, PRESSURE_LEASE_TTL_MS);
    expect(notifyWorkerPressure).not.toHaveBeenCalledWith(false);

    releaseWorkerPressureLease(first);
    // 旧实现此时已解除压力，仍在写入的 second 失去保护
    expect(notifyWorkerPressure).not.toHaveBeenCalledWith(false);
    expect(activeWorkerPressureLeaseCount()).toBe(1);

    releaseWorkerPressureLease(second);
    expect(notifyWorkerPressure).toHaveBeenCalledWith(false);
    expect(activeWorkerPressureLeaseCount()).toBe(0);
  });

  it("长回合靠续期维持压力窗口（TTL 到期前重复下发 true）", () => {
    const lease = acquireWorkerPressureLease();
    notifyWorkerPressure.mockClear();

    vi.advanceTimersByTime(10_000);
    expect(notifyWorkerPressure).toHaveBeenCalledWith(true, PRESSURE_LEASE_TTL_MS);

    vi.advanceTimersByTime(10_000);
    expect(notifyWorkerPressure).toHaveBeenCalledTimes(2);

    releaseWorkerPressureLease(lease);
  });

  it("硬上限：租约超时后自动停止续期并释放（泄漏租约不会永久抑制后台任务）", () => {
    acquireWorkerPressureLease();
    notifyWorkerPressure.mockClear();

    // 续期到接近上限
    vi.advanceTimersByTime(PRESSURE_LEASE_MAX_MS - PRESSURE_LEASE_REFRESH_MS);
    expect(activeWorkerPressureLeaseCount()).toBe(1);
    expect(notifyWorkerPressure).toHaveBeenCalledWith(true, PRESSURE_LEASE_TTL_MS);

    // 越过上限的下一跳：停止续期并释放压力
    notifyWorkerPressure.mockClear();
    vi.advanceTimersByTime(PRESSURE_LEASE_REFRESH_MS);
    expect(activeWorkerPressureLeaseCount()).toBe(0);
    expect(notifyWorkerPressure).toHaveBeenCalledWith(false);
    expect(expiredWorkerPressureLeaseCount()).toBe(1);

    // 释放后不再有任何续期
    notifyWorkerPressure.mockClear();
    vi.advanceTimersByTime(PRESSURE_LEASE_REFRESH_MS * 5);
    expect(notifyWorkerPressure).not.toHaveBeenCalled();
  });

  it("重复释放同一租约不产生多余的 pressure(false)", () => {
    const lease = acquireWorkerPressureLease();
    releaseWorkerPressureLease(lease);
    releaseWorkerPressureLease(lease);
    releaseWorkerPressureLease("pressure_does_not_exist");
    expect(notifyWorkerPressure.mock.calls.filter((call) => call[0] === false)).toHaveLength(1);
  });
});
