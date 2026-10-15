/**
 * Aervox｜思隅 UI E2E — 测试辅助：按 worker 起停独立 API 进程 + Vite dev server
 *
 * - 每个 worker 使用独立端口（API / Web）与独立 SQLite 数据库文件，互不干扰；
 * - API 进程复用 e2e/api/helpers.ts 的 startServer/stopServer（spawn apps/api dist）；
 * - Web 端 spawn "pnpm -F @aervox/web dev"，注入 VITE_API_URL 指向该 worker 的
 *   API 端口，并以 VITE_AERVOX_PLATFORM=mobile 运行（移动端平台启用跨会话草稿）。
 */
import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import {
  startServer,
  stopServer,
  cleanupDb,
  getDbPath,
} from "../api/helpers.js";

const repoRoot = path.resolve(process.cwd());

/** worker 端口基址：API 4100+idx*10，Web 5100+idx*10，避开 API 级 e2e 的 3100+ 段 */
const API_BASE_PORT = 4100;
const WEB_BASE_PORT = 5100;

export interface UiServers {
  apiUrl: string;
  webUrl: string;
}

/** 轮询 HTTP 端点直至可响应（带截止时间的就绪探测，非裸 sleep） */
async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "等待服务就绪超时: " + url + (lastError ? "（最后错误：" + String(lastError) + "）" : ""),
  );
}

function startWebServer(apiUrl: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    // detached：pnpm 只是壳进程，真正的 vite 是孙进程，停止时按进程组终止
    const web = spawn(
      "pnpm",
      [
        "-F",
        "@aervox/web",
        "dev",
        "--port",
        String(port),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      {
        cwd: repoRoot,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          VITE_API_URL: apiUrl,
          // 移动端平台（跨会话草稿契约的目标环境）；可用 E2E_PLATFORM=web 覆盖
          VITE_AERVOX_PLATFORM: process.env.E2E_PLATFORM ?? "mobile",
        },
      },
    );

    let settled = false;
    let stderrTail = "";
    web.stderr?.on("data", (data: Buffer) => {
      stderrTail = (stderrTail + data.toString()).slice(-4000);
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stopWebServer(web);
        reject(
          new Error(
            "Vite dev server 启动超时（端口 " + port + "）。stderr 尾部：\n" + stderrTail,
          ),
        );
      }
    }, 90_000);

    waitForHttp("http://127.0.0.1:" + port + "/", 90_000)
      .then(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(web);
        }
      })
      .catch((err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          stopWebServer(web);
          reject(
            err instanceof Error
              ? new Error(err.message + "\nstderr 尾部：\n" + stderrTail)
              : err,
          );
        }
      });

    web.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

function stopWebServer(web: ChildProcess | undefined): void {
  if (!web || web.pid === undefined) return;
  try {
    process.kill(-web.pid, "SIGTERM");
  } catch {
    try {
      web.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => {
    try {
      if (web.pid !== undefined) process.kill(-web.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }, 2000);
}

export const test = base.extend<{}, { servers: UiServers }>({
  servers: [
    async ({}, use, workerInfo) => {
      const workerIndex = workerInfo.workerIndex;
      const apiPort = API_BASE_PORT + workerIndex * 10;
      const webPort = WEB_BASE_PORT + workerIndex * 10;
      const dbPath = getDbPath("ui-w" + workerIndex);

      cleanupDb(dbPath);
      const { server: apiServer, url: apiUrl } = await startServer(
        apiPort,
        dbPath,
      );
      let webServer: ChildProcess | undefined;
      try {
        webServer = await startWebServer(apiUrl, webPort);
        await use({
          apiUrl,
          webUrl: "http://127.0.0.1:" + webPort,
        });
      } finally {
        stopWebServer(webServer);
        stopServer(apiServer);
        cleanupDb(dbPath);
      }
    },
    { scope: "worker" },
  ],
});

export { expect };

/** 打开工作台并等待根组件渲染完成（首次访问需等待 Vite 按需编译，放宽超时） */
export async function openWorkbench(page: Page, webUrl: string): Promise<void> {
  await page.goto(webUrl, { timeout: 90_000 });
  await expect(page.locator(".aervox-workbench")).toBeVisible({
    timeout: 90_000,
  });
}
