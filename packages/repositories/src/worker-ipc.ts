/**
 * Aervox｜思隅 @aervox/repositories — 跨进程 IPC 事件唤醒与写入协调（ITER-027）
 *
 * 核心目标：
 * 1. 替代高频空轮询：API/仓储层写入 Outbox 或紧急任务时，通过本地 Domain Socket 触发秒级 IPC 唤醒；
 * 2. 多进程 SQLite 写入协调：流式会话/批量写入期间下发写入压力信号，Worker 降频退避以**降低**
 *    写锁竞争概率（不承诺"零 SQLITE_BUSY"：真实多进程压测未执行，见追踪基线 §4.2 的范围说明）；
 * 3. 故障自愈与零侵入：当 Worker 未启动时，IPC 客户端静默忽略，不阻塞核心 API；清理意外退出的残留 socket 文件。
 *
 * 明确边界（避免过度承诺）：
 * - 唤醒是**尽力而为的优化**，不是投递保证；投递结果以返回的 boolean 为准，失败时调用方依赖轮询兜底。
 *   服务端会回执 `{ ok, delivered }`，未注册的任务名返回 `ok:false`，客户端不再把"收到任意字节"当作成功。
 * - Socket 位于共享临时目录，因此服务端启动后 chmod 0600 收紧权限；清理残留文件前会 lstat 校验必须是
 *   socket（fail-closed），避免 `AERVOX_WORKER_IPC_SOCKET` 被指向普通文件时误删。
 * - 压力信号带最大时长上限（MAX_WORKER_PRESSURE_DURATION_MS），防止任意本地进程无限期拖住后台任务。
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
  /** 已处理的动作类别（wake/pressure/pong） */
  handled?: string;
  /** wake 专用：目标任务是否真的存在并被唤醒 */
  delivered?: boolean;
  error?: string;
}

export interface WorkerIpcServerHandlers {
  /** 返回 false 表示目标任务不存在（未投递）；返回 undefined 视为已投递 */
  onWake?: (task: string) => boolean | void | Promise<boolean | void>;
  onPressure?: (active: boolean, durationMs?: number) => void | Promise<void>;
}

/** 单次写入压力信号允许的最长时长（5 分钟），防止本地任意进程无限期抑制后台任务 */
export const MAX_WORKER_PRESSURE_DURATION_MS = 5 * 60_000;

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const repoHash = crypto.createHash("md5").update(repoRoot).digest("hex").slice(0, 8);

/**
 * 解析本地单用户 Domain Socket / 命名管道路径。
 * 按仓库根目录哈希隔离，杜绝并行测试或不同实例间的 Socket 冲突。
 * 可用 AERVOX_WORKER_IPC_SOCKET 显式覆盖（打包/多副本部署时的推荐做法）。
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
 * 删除残留 socket 文件；若路径存在但不是 socket，则拒绝删除（fail-closed）。
 */
function removeStaleSocketFile(socketPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(socketPath);
  } catch {
    return; // 不存在则无需清理
  }
  if (!stat.isSocket()) {
    throw new Error(
      `Refusing to remove ${socketPath}: it is not a unix socket. ` +
        `请检查 AERVOX_WORKER_IPC_SOCKET 是否被指向了普通文件或目录。`,
    );
  }
  fs.unlinkSync(socketPath);
}

/**
 * 带兜底的等待：避免个别平台/状态下回调不触发导致关闭流程永久挂起。
 */
function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * Worker 宿主 IPC 服务端
 */
export class WorkerIpcServer {
  private readonly socketPath: string;
  private readonly handlers: WorkerIpcServerHandlers;
  private server: net.Server | null = null;
  private isListening = false;
  private stopping = false;
  /** listen 回调（成功或失败）落地的信号；用于让 stop() 不在 listen 中途关闭 */
  private listenSettled: Promise<void> | null = null;
  private settleListen: (() => void) | null = null;
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
    this.stopping = false;

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

      // 存在但不是 socket 时直接抛错，绝不删除任意文件。
      removeStaleSocketFile(this.socketPath);
    }

    // 注意：listenSettled 必须在校验/清理都通过之后再建立，否则上面的抛错路径会
    // 留下一个永不 settle 的 promise，使后续 stop() 白等一个超时。
    this.listenSettled = new Promise<void>((resolve) => {
      this.settleListen = resolve;
    });

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

      // 关键：在 listen 之前就登记 server 引用。net.Server.listen() 会先创建
      // socket 文件再异步回调，若此间调用 stop()，旧实现会因为 this.server 仍为 null
      // 而无法关闭该 server，留下一个永远存活、阻止进程退出且 isRunning() 恒为 true 的实例。
      this.server = server;

      let settled = false;
      const markListenSettled = () => {
        const resolveListen = this.settleListen;
        this.settleListen = null;
        resolveListen?.();
      };

      server.once("error", (err) => {
        if (settled) return;
        settled = true;
        this.isListening = false;
        if (this.server === server) this.server = null;
        markListenSettled();
        reject(err);
      });

      server.listen(this.socketPath, () => {
        if (settled) return;
        settled = true;
        if (this.stopping) {
          // start() 与 stop() 竞争：不再声明已就绪，直接关闭避免悬挂句柄。
          try {
            server.close(() => undefined);
          } catch {
            // 已关闭
          }
          if (this.server === server) this.server = null;
          this.isListening = false;
          // Node 在 close() 时不会自动删除 unix socket 文件；stop() 若因等待超时
          // 已经返回，这里补一次清理，避免残留文件影响下次启动。
          if (process.platform !== "win32") {
            try {
              removeStaleSocketFile(this.socketPath);
            } catch {
              // 路径异常时保持不动更安全
            }
          }
          markListenSettled();
          resolve();
          return;
        }
        if (process.platform !== "win32") {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch {
            // 收紧权限失败不阻断启动（例如个别文件系统不支持 chmod）
          }
        }
        this.isListening = true;
        markListenSettled();
        resolve();
      });
    });
  }

  private async handleMessage(msg: WorkerIpcMessage): Promise<WorkerIpcResponse> {
    if (msg.action === "wake") {
      if (!this.handlers.onWake) {
        return { ok: false, handled: "wake", delivered: false, error: "no_wake_handler" };
      }
      const delivered = (await this.handlers.onWake(msg.task)) !== false;
      if (!delivered) {
        return { ok: false, handled: "wake", delivered: false, error: "unknown_task" };
      }
      return { ok: true, handled: "wake", delivered: true };
    }
    if (msg.action === "pressure") {
      if (!this.handlers.onPressure) {
        return { ok: false, handled: "pressure", error: "no_pressure_handler" };
      }
      const durationMs =
        typeof msg.durationMs === "number" && Number.isFinite(msg.durationMs) && msg.durationMs > 0
          ? Math.min(msg.durationMs, MAX_WORKER_PRESSURE_DURATION_MS)
          : undefined;
      await this.handlers.onPressure(msg.active, durationMs);
      return { ok: true, handled: "pressure" };
    }
    if (msg.action === "ping") {
      return { ok: true, handled: "pong" };
    }
    return { ok: false, error: "unknown_action" };
  }

  /**
   * 关闭 IPC 服务并清理本地 socket 文件。可重复调用。
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.isListening = false;

    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    const server = this.server;
    this.server = null;

    // 若 start() 的 listen 回调尚未落地，先等它落地（回调会因 stopping 直接关闭），
    // 否则在 listen 中途调用 close() 可能永远等不到回调，并留下 socket 文件。
    const listenSettled = this.listenSettled;
    this.listenSettled = null;
    if (listenSettled) {
      await withTimeout(listenSettled, 250);
    }

    if (server) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          // 未处于 listening 状态时 close() 会把错误传给回调，这里一律视为已关闭。
          server.close(() => finish());
        } catch {
          finish();
        }
        // close() 回调在个别状态下可能不触发，兜底保证 stop() 永不悬挂。
        const timer = setTimeout(finish, 250);
        timer.unref?.();
      });
    }

    if (process.platform !== "win32") {
      try {
        removeStaleSocketFile(this.socketPath);
      } catch {
        // 清理阶段的失败不影响调用方（例如路径已被替换为普通文件，此时保持不动更安全）
      }
    }
  }
}

/**
 * 发送 IPC 消息给后台 Worker。
 * 静默吞没服务未启动或连接异常，确保对调用方零性能损耗与零异常抛出。
 * 返回值为**服务端确认送达**（`ok:true`），而非"写出去就算成功"。
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
    let settled = false;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = net.connect(socketPath);

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      client.destroy();
      resolve(result);
    };

    timer = setTimeout(() => finish(false), timeoutMs);

    client.setEncoding("utf8");
    client.once("connect", () => {
      client.write(`${JSON.stringify(msg)}\n`);
    });

    client.on("data", (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newlineIndex)) as WorkerIpcResponse;
        finish(parsed.ok === true);
      } catch {
        finish(false);
      }
    });

    client.once("error", () => finish(false));
    // 服务端未回执即关闭连接：视为未送达，交由轮询兜底。
    client.once("close", () => finish(false));
  });
}

/**
 * 唤醒特定后台任务（如 "outbox"）。
 * 返回 true 仅代表 Worker 确认存在该任务并已被唤醒。
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
 * durationMs 由服务端钳制到 MAX_WORKER_PRESSURE_DURATION_MS。
 */
export async function notifyWorkerPressure(
  active: boolean,
  durationMs?: number,
  socketPath?: string,
): Promise<boolean> {
  return sendWorkerIpcMessage({ action: "pressure", active, durationMs }, { socketPath });
}
