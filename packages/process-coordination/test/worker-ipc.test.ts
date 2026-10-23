import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  MAX_WORKER_PRESSURE_DURATION_MS,
  WorkerIpcServer,
  notifyWorkerPressure,
  notifyWorkerWakeup,
  sendWorkerIpcMessage,
  resolveWorkerIpcPath,
} from "../src/index.js";

/**
 * ITER-027 IPC 通道回归：生命周期竞态、投递确认、权限收紧与 fail-closed 清理。
 * 这些用例覆盖评审发现的缺陷，旧实现下会失败：
 * - stop() 在 listen 回调前调用会留下无法关闭的 server（isRunning() 恒为 true）；
 * - 客户端收到任意字节即视为投递成功，未注册任务名也回 ok:true；
 * - socket 以默认 umask 权限创建；
 * - 清理残留文件前不校验类型，可能删除普通文件。
 */
const sockets: string[] = [];
const files: string[] = [];

function tempSocketPath(): string {
  const socketPath = path.join(
    os.tmpdir(),
    `aervox-ipc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
  );
  sockets.push(socketPath);
  return socketPath;
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, 10);
    timer.unref?.();
  });
}

afterEach(async () => {
  for (const socketPath of sockets.splice(0)) {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      // 忽略
    }
  }
  for (const file of files.splice(0)) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // 忽略
    }
  }
});

describe("ITER-027 WorkerIpcServer 生命周期与安全", () => {
  it("start() 与 stop() 竞争时不留悬挂 server，且可重新启动", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({ socketPath });

    const startPromise = server.start();
    await server.stop();
    await startPromise;

    expect(server.isRunning()).toBe(false);

    // 旧实现下这里会抛 "already in use"：残留的 live server 仍占用 socket。
    await server.start();
    expect(server.isRunning()).toBe(true);
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("stop() 可重复调用且不抛错", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({ socketPath });
    await server.start();
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.isRunning()).toBe(false);
  });

  it.runIf(process.platform !== "win32")("socket 创建后权限收紧为 0600", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({ socketPath });
    await server.start();
    const mode = fs.statSync(socketPath).mode & 0o777;
    // 旧实现使用默认 umask（通常 0755），共享临时目录下任意本地用户均可连接。
    expect(mode).toBe(0o600);
    await server.stop();
  });

  it.runIf(process.platform !== "win32")(
    "残留路径不是 socket 时拒绝删除（fail-closed）",
    async () => {
      const filePath = path.join(
        os.tmpdir(),
        `aervox-ipc-notsocket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`,
      );
      files.push(filePath);
      fs.writeFileSync(filePath, "i am a plain file, not a socket");

      const server = new WorkerIpcServer({ socketPath: filePath });
      await expect(server.start()).rejects.toThrow(/not a unix socket/i);
      // 普通文件必须原样保留
      expect(fs.readFileSync(filePath, "utf8")).toBe("i am a plain file, not a socket");
    },
  );
});

describe("ITER-027 IPC 投递确认", () => {
  it("未注册的任务名回执 ok:false，客户端返回 false", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({
      socketPath,
      // 模拟 wakeJob 返回 false（任务不存在）
      handlers: { onWake: () => false },
    });
    await server.start();

    // 旧实现下客户端收到任意字节即 resolve(true)，无法区分是否真的投递。
    await expect(notifyWorkerWakeup("outbox", socketPath)).resolves.toBe(false);

    await server.stop();
  });

  it("已注册任务回执 ok:true，客户端返回 true", async () => {
    const socketPath = tempSocketPath();
    const woken: string[] = [];
    const server = new WorkerIpcServer({
      socketPath,
      handlers: {
        onWake: (task) => {
          woken.push(task);
          return true;
        },
      },
    });
    await server.start();

    await expect(notifyWorkerWakeup("outbox", socketPath)).resolves.toBe(true);
    expect(woken).toEqual(["outbox"]);

    await server.stop();
  });

  it("无唤醒处理器时返回 false", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({ socketPath });
    await server.start();
    await expect(notifyWorkerWakeup("outbox", socketPath)).resolves.toBe(false);
    await server.stop();
  });

  it("压力信号时长被钳制到上限", async () => {
    const socketPath = tempSocketPath();
    const received: Array<number | undefined> = [];
    const server = new WorkerIpcServer({
      socketPath,
      handlers: {
        onPressure: (_active, durationMs) => {
          received.push(durationMs);
        },
      },
    });
    await server.start();

    await expect(
      notifyWorkerPressure(true, MAX_WORKER_PRESSURE_DURATION_MS * 10, socketPath),
    ).resolves.toBe(true);
    expect(received).toEqual([MAX_WORKER_PRESSURE_DURATION_MS]);

    await server.stop();
  });

  it("socket 不存在时客户端立即返回 false 而不抛错", async () => {
    const socketPath = tempSocketPath();
    await expect(notifyWorkerWakeup("outbox", socketPath)).resolves.toBe(false);
  });

  it("服务端回执不可解析时返回 false", async () => {
    const socketPath = tempSocketPath();
    sockets.push(socketPath);
    const garbageServer = net.createServer((socket) => {
      socket.on("data", () => {
        socket.write("not-json-at-all\n");
      });
    });
    await new Promise<void>((resolve) => garbageServer.listen(socketPath, () => resolve()));

    await expect(sendWorkerIpcMessage({ action: "ping" }, { socketPath })).resolves.toBe(false);

    await new Promise<void>((resolve) => {
      garbageServer.close(() => resolve());
    });
  });

  it("服务端不回执直接断开时返回 false", async () => {
    const socketPath = tempSocketPath();
    sockets.push(socketPath);
    const silentServer = net.createServer((socket) => {
      socket.on("data", () => socket.destroy());
    });
    await new Promise<void>((resolve) => silentServer.listen(socketPath, () => resolve()));

    await expect(sendWorkerIpcMessage({ action: "ping" }, { socketPath })).resolves.toBe(false);

    await new Promise<void>((resolve) => {
      silentServer.close(() => resolve());
    });
  });

  it("ping 回执 ok:true 视为已送达", async () => {
    const socketPath = tempSocketPath();
    const server = new WorkerIpcServer({ socketPath });
    await server.start();
    await expect(sendWorkerIpcMessage({ action: "ping" }, { socketPath })).resolves.toBe(true);
    await server.stop();
  });

  it("resolveWorkerIpcPath 尊重显式路径与环境变量", () => {
    const previous = process.env.AERVOX_WORKER_IPC_SOCKET;
    try {
      process.env.AERVOX_WORKER_IPC_SOCKET = "/tmp/aervox-env-override.sock";
      expect(resolveWorkerIpcPath()).toBe("/tmp/aervox-env-override.sock");
      expect(resolveWorkerIpcPath("/tmp/aervox-explicit.sock")).toBe("/tmp/aervox-explicit.sock");
    } finally {
      if (previous === undefined) delete process.env.AERVOX_WORKER_IPC_SOCKET;
      else process.env.AERVOX_WORKER_IPC_SOCKET = previous;
    }
  });

  it("服务端可处理同一连接上的多条消息", async () => {
    const socketPath = tempSocketPath();
    const woken: string[] = [];
    const server = new WorkerIpcServer({
      socketPath,
      handlers: {
        onWake: (task) => {
          woken.push(task);
          return true;
        },
      },
    });
    await server.start();

    await notifyWorkerWakeup("outbox", socketPath);
    await notifyWorkerWakeup("review", socketPath);
    expect(woken).toEqual(["outbox", "review"]);

    await server.stop();
    await waitFor(() => !fs.existsSync(socketPath)).catch(() => undefined);
  });
});
