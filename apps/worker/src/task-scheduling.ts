/** Worker 任务调度默认值与环境变量覆盖解析。 */

export const DEFAULT_WORKER_TICK_MS = 5_000;

/**
 * Expensive/background tasks intentionally run less often than the outbox.
 * These values mirror the documented `.env.example` defaults.
 */
export const DEFAULT_WORKER_INTERVALS: Readonly<Record<string, number>> = Object.freeze({
  outbox: 3_000,
  review: 10_000,
  diary: 60_000,
  deletion: 30_000,
  compaction: 60_000,
  embedding: 30_000,
  "attempt-recovery": 5_000,
  "inbox-expiry": 10_000,
  "proactive-profile": 30_000,
  "proactive-intelligence": 60_000,
});

/**
 * Resolve one task interval. An explicit per-task override wins. A custom
 * WORKER_TICK_MS remains a global override for backwards compatibility;
 * documented task defaults apply when the tick is left at its default.
 */
export function resolveWorkerTaskInterval(
  name: string,
  tickMs: number,
  overrides: Readonly<Record<string, number>>,
): number {
  const normalized = name.replaceAll("-", "_");
  const override = overrides[name] ?? overrides[normalized];
  if (override !== undefined) return override;
  if (tickMs !== DEFAULT_WORKER_TICK_MS) return tickMs;
  return DEFAULT_WORKER_INTERVALS[name] ?? tickMs;
}
