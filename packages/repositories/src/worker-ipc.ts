/**
 * Aervox｜思隅 @aervox/repositories — 跨进程 IPC 事件唤醒与写入协调（ITER-027）
 *
 * 核心目标：
 * 1. 替代高频空轮询：API/仓储层写入 Outbox 或紧急任务时，通过本地 Domain Socket 触发秒级 IPC 唤醒；
 * 2. 多进程 SQLite 写入协调：流式会话/批量写入期间下发写入压力信号，Worker 自动退避至低频轮询，杜绝 SQLITE_BUSY；
 * 3. 故障自愈与零侵入：当 Worker 未启动时，IPC 客户端静默忽略，不阻塞核心 API；清理意外退出的残留 socket 文件。
 */
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export type WorkerIpcAction = "wake" | "pressure" | "ping";

export type WorkerIpcMessage =
  | { action: "wake"; task: string }
  | { action: "pressure"; active: boolean; durationMs?: number }
  | { action: "ping" };

export interface WorkerIpcResponse {
  ok: boolean;
  handled?: string;
  error?: string;
}

export interface WorkerIpcServerHandlers {
  onWake?: (task: string) => void | Promise<void>;
  onPressure?: (active: boolean, durationMs?: number) => void | Promise<void>;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const repoHash = crypto.createHash("md5").update(repoRoot).digest("hex").slice(0, 8);

/**
 * 解析本地单用户 Domain Socket / 命名管道路径。
 * 按仓库根目录哈希隔离，杜绝并行测试或不同实例间的 Socket 冲突。
 */
export function resolveWorkerIpcPath(customPath?: string): string {
  if (customPath && customPath.trim().length > 0) {
    return customPath.trim();
  }
  if (process.env.AERVOX_WORKER_IPC_SOCKET && process.env.AERVOX_WORKER_IPC_SOCKET.trim().length > 0) {
    return process.env.AERVOX_WORKER_IPC_SOCKET.trim();
  }
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\aervox-worker-${repoHash}`;
  }
  return path.join(os.tmpdir(), `aervox-worker-${repoHash}.sock`);
}

/**
 * Worker 宿主 IPC 服务端
 */
export class WorkerIpcServer {
  private readonly socketPath: string;
  private readonly handlers: WorkerIpcServerHandlers;
  private server: net.Server | null = null;
  private isListening = false;
  private readonly activeSockets = new Set<net.Socket>();

  constructor(options: { socketPath?: string; handlers?: WorkerIpcServerHandlers } = {}) {
    this.socketPath = resolveWorkerIpcPath(options.socketPath);
    this.handlers = options.handlers ?? {};
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  isRunning(): boolean {
    return this.isListening;
  }

  /**
   * 启动 IPC 监听服务。
   * 自动探测并清理异常终止残留的僵死 socket 文件。
   */
  async start(): Promise<void> {
    if (this.isListening) return;

    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      const isAlive = await new Promise<boolean>((resolve) => {
        const client = net.connect(this.socketPath);
        const timer = setTimeout(() => {
          client.destroy();
          resolve(false);
        }, 150);

        client.once("connect", () => {
          clearTimeout(timer);
          client.destroy();
          resolve(true);
        });

        client.once("error", () => {
          clearTimeout(timer);
          client.destroy();
          resolve(false);
        });
      });

      if (isAlive) {
        throw new Error(`Worker IPC socket ${this.socketPath} is already in use by an active process`);
      }

      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // 忽略删除失败
      }
    }

    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.activeSockets.add(socket);
        let buffer = "";

        socket.on("data", async (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const msg = JSON.parse(trimmed) as WorkerIpcMessage;
              const res = await this.handleMessage(msg);
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify(res)}\n`);
              }
            } catch (err) {
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify({ ok: false, error: String(err) })}\n`);
              }
            }
          }
        });

        socket.on("error", () => {
          this.activeSockets.delete(socket);
        });

        socket.on("close", () => {
          this.activeSockets.delete(socket);
        });
      });

      server.once("error", (err) => {
        this.isListening = false;
        reject(err);
      });

      server.listen(this.socketPath, () => {
        this.server = server;
        this.isListening = true;
        resolve();
      });
    });
  }

  private async handleMessage(msg: WorkerIpcMessage): Promise<WorkerIpcResponse> {
    if (msg.action === "wake") {
      await this.handlers.onWake?.(msg.task);
      return { ok: true, handled: "wake" };
    }
    if (msg.action === "pressure") {
      await this.handlers.onPressure?.(msg.active, msg.durationMs);
      return { ok: true, handled: "pressure" };
    }
    if (msg.action === "ping") {
      return { ok: true, handled: "pong" };
    }
    return { ok: false, error: "unknown_action" };
  }

  /**
   * 关闭 IPC 服务并清理本地 socket 文件
   */
  async stop(): Promise<void> {
    this.isListening = false;
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    if (process.platform !== "win32" && fs.existsSync(this.socketPath)) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // 忽略清理异常
      }
    }
  }
}

/**
 * 发送 IPC 消息给后台 Worker。
 * 静默吞没服务未启动或连接异常，确保对调用方零性能损耗与零异常抛出。
 */
export async function sendWorkerIpcMessage(
  msg: WorkerIpcMessage,
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const socketPath = resolveWorkerIpcPath(options.socketPath);
  const timeoutMs = options.timeoutMs ?? 200;

  if (process.platform !== "win32" && !fs.existsSync(socketPath)) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const finish = (result: boolean) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.destroy();
        resolve(result);
      }
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    const client = net.connect(socketPath);

    client.once("connect", () => {
      client.write(`${JSON.stringify(msg)}\n`);
    });

    client.on("data", () => {
      finish(true);
    });

    client.once("error", () => {
      finish(false);
    });
  });
}

/**
 * 唤醒特定后台任务（如 "outbox"）
 */
export async function notifyWorkerWakeup(
  task: string,
  socketPath?: string,
): Promise<boolean> {
  return sendWorkerIpcMessage({ action: "wake", task }, { socketPath });
}

/**
 * 下发 SQLite 写入压力信号。
 * 当 active 为 true 时，Worker 进入退避降频模式，减少锁争夺；会话结束恢复 normal。
 */
export async function notifyWorkerPressure(
  active: boolean,
  durationMs?: number,
  socketPath?: string,
): Promise<boolean> {
  return sendWorkerIpcMessage({ action: "pressure", active, durationMs }, { socketPath });
}
