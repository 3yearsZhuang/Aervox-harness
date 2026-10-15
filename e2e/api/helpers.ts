/**
 * Aervox｜思隅 E2E — 测试辅助：启动/停止独立 API 服务器
 *
 * 每个测试文件使用唯一的数据库文件，确保隔离。
 */
import { spawn, type ChildProcess } from "child_process";
import net from "net";
import path from "path";
import fs from "fs";

const BASE_PORT = 3100;
let portCounter = 0;
// Playwright transpiles this helper as CommonJS in some environments, so avoid
// import.meta and use the repository root from the test command's cwd instead.
const repoRoot = path.resolve(process.cwd());

export function getServerPort(): number {
  return BASE_PORT + portCounter++;
}

export function getDbPath(name: string): string {
  const dir = path.resolve("/tmp", "aervox-e2e");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.db`);
}

export function startServer(
  port: number,
  dbPath: string,
  extraEnv: Record<string, string> = {},
): Promise<{ server: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const server = spawn("node", ["dist/index.js"], {
      cwd: path.join(repoRoot, "apps", "api"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: `file:${dbPath}`,
        NODE_ENV: "test",
        ...extraEnv,
      },
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        server.kill();
        reject(new Error(`Server startup timeout on port ${port}`));
      }
    }, 30_000);

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

    // 兜底：轮询 TCP 端口直到真正可连接（重建 dist 后首启可能因杀毒扫描显著变慢）
    const probePort = (attempt: number) => {
      if (started) return;
      if (attempt > 150) return; // 30s 总预算由外层 timeout 兜底
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.on("connect", () => {
        socket.destroy();
        if (!started) {
          started = true;
          clearTimeout(timeout);
          resolve({ server, url: `http://localhost:${port}` });
        }
      });
      socket.on("error", () => {
        socket.destroy();
      });
      setTimeout(() => probePort(attempt + 1), 200);
    };
    probePort(0);
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
