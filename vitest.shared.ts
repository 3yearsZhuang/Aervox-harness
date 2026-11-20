import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
//
// 超时阈值（2026-11-20 实测修订）：
// 原值 30s 的理由是"并行时 SQLite 抖动到 6s 以上"。对 @aervox/repositories 的
// 1266 项通过用例逐项计时后，真实分布是：仅 1 项 ≥10s（完整的 v1 迁移演练，
// 真实磁盘 staging + rollback），1 项 ≥3s，其余全部 <1s。全局 30s 的实际作用
// 是让卡死用例多等 20s 才报错，并不能区分慢与坏。
// 因此恢复 10s 默认：覆盖实测峰值，同时让真正的死锁快速失败。确需更久的用例
// 用 it(..., { timeout }) 就地标注，不要再次抬高全局值。
//
// 并行度（2026-11-20 实测修订）：
// 此前把每包 worker 固定为 1，理由是"多进程 SQLite 文件锁争抢"（该约束来自
// 更早的 maxWorkers:'50%' 时代，当时缺陷是"包级并发 × 文件级并发"叠加超订）。
// 逐项核实后，锁争抢的前提并不成立：测试的临时库一律经 mkdtemp 分配到各自独立
// 目录，HTTP 端口一律用 0 由系统分配，不存在共享库文件或固定端口。
// 对照实验（原生产物齐全、同一批用例全通过）：
//   @aervox/repositories  串行 2m47s → 4 workers 1m29s（1.87x，1266 项）
//   @aervox/api           串行 3m34s → 4 workers 1m38s（2.18x，1096 项）
// 两种模式下通过/失败集合完全一致，未引入新失败，也未观察到超时。
//
// 折中保留原洞察（避免超订）但恢复吞吐：取核数的一半并封顶 4。
//   10 核开发机 → 4；GitHub ubuntu-latest 4 核 → 2。两者都不超过核数。
// 仍可用 VITEST_MAX_WORKERS 显式覆盖。
const DEFAULT_MAX_WORKERS = Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));

const configuredWorkers = process.env.VITEST_MAX_WORKERS
  ? Number.parseInt(process.env.VITEST_MAX_WORKERS, 10)
  : DEFAULT_MAX_WORKERS;

export default defineConfig({
  // Tests may exercise private implementations without publishing them to consumers.
  resolve: { alias: [{
    find: /^@aervox\/host-runtime-test\//,
    replacement: fileURLToPath(new URL('./packages/host-runtime/dist/', import.meta.url)),
  }] },
  test: {
    setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    maxWorkers: configuredWorkers,
  },
})