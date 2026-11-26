import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
//
// 超时阈值（2026-11-20 实测修订，含独立复审后的更正）：
// 原值 30s 的理由是"并行时 SQLite 抖动到 6s 以上"。逐项计时后确实存在长用例，
// 但先前把分布记成"仅 1 项 ≥10s"是错的：在 4 workers 的真实争抢下，
// @aervox/repositories 的 schema-staging 单项可达 8.3–11.6s（同一机器 ±40%），
// schema-table-contract 的参数化用例 4.4–9.9s，且偶发把 10s 顶穿。
// 也就是说这些用例的耗时是**磁盘争抢敏感型**，不能靠"找出唯一慢的那一个"来解决。
// 取 15s：覆盖实测最坏值（11.6s）并留出机器间差异余量，同时仍比 30s 提前一半
// 暴露真正的死锁。确需更久的用例仍应就地标注 it(..., { timeout })。
//
// 并行度（2026-11-20 实测修订）：
// 此前把每包 worker 固定为 1，理由是"多进程 SQLite 文件锁争抢"（该约束来自
// 更早的 maxWorkers:'50%' 时代，当时缺陷是"包级并发 × 文件级并发"叠加超订）。
// 逐项核实后，**共享库文件与固定端口**这两个前提不成立：临时库一律经 mkdtemp
// 分配到各自独立目录，HTTP 端口一律用 0 由系统分配。
// 但复审指出并已复现：争抢确实存在，只是来源是**共享磁盘带宽**而非文件锁。
// fsync 密集型用例（schema staging、迁移演练）在 4 workers 下比串行慢 20–40%。
// 因此这里的取舍是明确的：用可接受的单包墙钟换取总吞吐，代价是慢用例更需要
// 宽裕的超时——这正是上面把默认值定在 15s 而非 5–10s 的原因。
// 对照实验（原生产物齐全、同一批用例全通过）：
//   @aervox/repositories  串行 2m47s → 4 workers 1m29s（1.87x，1266 项）
//   @aervox/api           串行 3m34s → 4 workers 1m38s（2.18x，1096 项）
//
// 保留原洞察（避免超订）但恢复吞吐：取核数的一半并封顶 4。
//   10 核开发机 min(4, 5) = 4；GitHub ubuntu-latest 4 核 floor(4/2) = 2。
// 两者都不超过核数；仍可用 VITEST_MAX_WORKERS 显式覆盖。
//
// **2026-11-26 更正：上面的余量推理漏了一层。** 这里算的是「单包 workers」，
// 但本地门禁是 `turbo run test --concurrency=2`——两个包同时跑，各自再开 4 个
// worker，10 核机上实际是 **8 个 vitest worker 同时抢磁盘**，不是注释假设的 4 个。
// 实测佐证：schema-staging 的「rebuilds the selected logical snapshot」单项
// 单独跑就要 11.25s（15s 预算的 75%），在 8 worker 争抢下必然顶穿。
//
// 因此把上限收到 2：单包 2 × 并发 2 = 4，与当初测量 15s 时的前提一致。
// 代价是单包串行度下降，换来的是门禁在并发下可稳定通过——门禁的价值是可复现，
// 不是峰值吞吐。
const DEFAULT_MAX_WORKERS = Math.min(2, Math.max(1, Math.floor(availableParallelism() / 4)));

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
    // 15s 覆盖的是「4 worker 争抢」下的最坏值 11.6s；worker 数已收到与之一致。
    testTimeout: 15_000,
    hookTimeout: 15_000,
    maxWorkers: configuredWorkers,
  },
})
