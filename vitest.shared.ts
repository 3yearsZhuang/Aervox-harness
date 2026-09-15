import { defineConfig } from 'vitest/config'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
//
// 超时阈值说明：本仓库大量用例是真实 SQLite（WAL）建库 + 迁移 + 并发写入的
// 集成测试。默认 5s 单测超时在 turbo 并行跑全部包时会因磁盘与 CPU 争抢而抖动
// （本机实测单文件耗时从 0.5s 膨胀到 6s 以上），导致门禁偶发红而无真实缺陷。
// 这里统一放宽到 30s：既覆盖并行峰值，也仍能在真实死锁时及时失败。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})