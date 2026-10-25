import { defineConfig, devices } from "@playwright/test";

/**
 * Aervox｜思隅 E2E 统一配置：API 级与浏览器级用例共用一份配置，按 project 拆分。
 *
 * - `api`（e2e/api/）：Playwright request fixture 打真实 API（默认
 *   http://localhost:3000），各 spec 经 helpers 自行起停服务。
 * - `ui`（e2e/ui/）：chromium + Desktop Chrome，由 fixtures.ts 自行起停 API 进程与
 *   Vite dev server。
 *
 * 两套用例都不使用 webServer 字段自动管理服务，风格保持一致；差异只在超时与设备，
 * 因此落在 project 级。`--project=api` / `--project=ui` 可单独执行（对应
 * `test:e2e:api` / `test:e2e:ui`），不带参数则两套都跑。
 *
 * 真实模型不可用：ui 用例只验证纯前端交互，不发送会触发 LLM 的消息。
 */
export default defineConfig({
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  projects: [
    {
      name: "api",
      testDir: "./api",
      timeout: 60_000,
      use: {
        baseURL: "http://localhost:3000",
      },
    },
    {
      name: "ui",
      testDir: "./ui",
      timeout: 120_000,
      expect: { timeout: 15_000 },
      use: {
        ...devices["Desktop Chrome"],
        trace: "retain-on-failure",
      },
    },
  ],
});
