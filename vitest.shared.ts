import os from 'node:os'
import { defineConfig } from 'vitest/config'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
//
// 超时阈值说明：本仓库大量用例是真实 SQLite（WAL）建库 + 迁移 + 并发写入的
// 集成测试。默认 5s 单测超时在 turbo 并行跑全部包时会因磁盘与 CPU 争抢而抖动
// （本机实测单文件耗时从 0.5s 膨胀到 6s 以上），导致门禁偶发红而无真实缺陷。
// 这里统一放宽到 30s：既覆盖并行峰值，也仍能在真实死锁时及时失败。
//
// 并行度治理：
// 既往为了防止 Turbo 在包级别并发调度时与单包内 Vitest worker 产生 CPU/磁盘饥饿，曾保守将
// Vitest worker 限制为 1。然而在 @aervox/api（73 个测试文件）等重型包中，单 worker 纯串行执行导致
// 耗时膨胀至 9+ 分钟，多核算力被严重闲置。
//
// 经过基准实测与隔离保障：
// 1. 各测试用例均使用唯一命名的临时 SQLite 文件或内存隔离，无跨进程文件锁冲突；
// 2. 默认在 CI 开启 2 worker，本地开发根据 CPU 核心数自适应分配（最多 3 worker），
//    在保障不产生端口/资源争抢的前提下将单包测试耗时压缩 50%~75%；
// 3. 仍保留通过 VITEST_MAX_WORKERS 环境变量显式覆盖的能力。
const defaultWorkers = process.env.CI
  ? 2
  : Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));

const configuredWorkers = process.env.VITEST_MAX_WORKERS
  ? Number.parseInt(process.env.VITEST_MAX_WORKERS, 10)
  : defaultWorkers;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: configuredWorkers,
  },
})