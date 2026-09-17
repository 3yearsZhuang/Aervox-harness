import { defineConfig } from 'vitest/config'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
//
// 超时阈值说明：本仓库大量用例是真实 SQLite（WAL）建库 + 迁移 + 并发写入的
// 集成测试。默认 5s 单测超时在 turbo 并行跑全部包时会因磁盘与 CPU 争抢而抖动
// （本机实测单文件耗时从 0.5s 膨胀到 6s 以上），导致门禁偶发红而无真实缺陷。
// 这里统一放宽到 30s：既覆盖并行峰值，也仍能在真实死锁时及时失败。
// 并行度治理：
// 在 Monorepo 中，Turbo 会并行调度多个包。如果包内部的每个 Vitest 实例再启动
// 多个 Worker，多进程 SQLite（WAL 模式）建库与文件操作会发生严重的锁争抢与 CPU 饥饿
// （实测单测耗时膨胀数百倍并可能导致超时卡死）。
// 因此默认每个 Vitest 实例 worker 数收敛为 1（单包内测试文件顺序串行执行），彻底杜绝
// SQLite 文件竞争与端口冲突；多核吞吐由 Turbo 在“包级别”并发调度保障。
// 亦可通过环境变量 VITEST_MAX_WORKERS 显式覆盖。
const configuredWorkers = process.env.VITEST_MAX_WORKERS
  ? Number.parseInt(process.env.VITEST_MAX_WORKERS, 10)
  : 1;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: configuredWorkers,
  },
})