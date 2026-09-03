import { defineConfig } from 'vitest/config'

// 共享 vitest 配置：所有包的 test 入口统一走 test 目录下的 .test.ts 文件
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})