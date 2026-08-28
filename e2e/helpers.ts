/**
 * Aervox｜思隅 E2E — 测试辅助：启动/停止独立 API 服务器
 *
 * 每个测试文件使用唯一的数据库文件，确保隔离。
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

const BASE_PORT = 3100;
let portCounter = 0;

export function getServerPort(): number {
  return BASE_PORT + portCounter++;
}

export function getDbPath(name: string): string {
  const dir = path.resolve("/tmp", "aervox-e2e");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.db`);
}

export function startServer(port: number, dbPath: string): Promise<{ server: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const server = spawn("node", ["dist/index.js"], {
      cwd: path.resolve("/workspace/Aervox-harness/apps/api"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: `file:${dbPath}`,
        NODE_ENV: "test",
      },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error(`Server startup timeout on port ${port}`));
      }
    }, 15_000);

    server.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      // 服务启动后不会输出特殊标志，我们等待端口监听
      if (!started && text.includes("listen")) {
        started = true;
        clearTimeout(timeout);
        resolve({ server, url: `http://localhost:${port}` });
      }
    });

    server.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Fastify 启动日志输出到 stderr
      if (!started && (text.includes("listen") || text.includes("localhost"))) {
        started = true;
        clearTimeout(timeout);
        resolve({ server, url: `http://localhost:${port}` });
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // 兜底：2 秒后检查是否已启动
    setTimeout(() => {
      if (!started) {
        started = true;
        clearTimeout(timeout);
        resolve({ server, url: `http://localhost:${port}` });
      }
    }, 3000);
  });
}

export function stopServer(server: ChildProcess): void {
  server.kill("SIGTERM");
  // 给进程 2 秒时间退出
  setTimeout(() => {
    try { server.kill("SIGKILL"); } catch { /* ignore */ }
  }, 2000);
}

export function cleanupDb(dbPath: string): void {
  try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(`${dbPath}-wal`); } catch { /* ignore */ }
  try { fs.unlinkSync(`${dbPath}-shm`); } catch { /* ignore */ }
}