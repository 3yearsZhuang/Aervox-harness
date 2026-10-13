import { defineConfig, devices } from "@playwright/test";

/**
 * Aervox｜思隅 浏览器级 UI E2E 配置（独立于 API 级 playwright.config.ts）。
 *
 * - 测试目录 e2e-ui/，由 fixtures.ts 手动起停 API 进程与 Vite dev server
 *   （不使用 webServer 字段自动管理，风格对齐现有 e2e/）。
 * - 真实模型不可用：用例只验证纯前端交互，不发送会触发 LLM 的消息。
 */
export default defineConfig({
  testDir: "./e2e-ui",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        trace: "retain-on-failure",
      },
    },
  ],
});
