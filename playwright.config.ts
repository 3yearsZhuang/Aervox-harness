import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:3000",
    extraHTTPHeaders: {
      "x-workspace-id": "ws_e2e",
      "x-user-id": "usr_e2e",
    },
  },
  // 不使用 webServer 自动管理，各测试文件手动启动/停止
});