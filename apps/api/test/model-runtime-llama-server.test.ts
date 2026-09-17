/**
 * Aervox｜思隅 @aervox/api — llama-server 子进程生命周期测试（CR-054）
 *
 * 注入 fake spawn / fake fetch，验证启动健康探测、running 状态、SIGTERM/SIGKILL 停止、
 * 崩溃（意外退出）置 error、二进制缺失报错。
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { LlamaServerManager } from "../src/modules/ecosystem/model-runtime/llama-server.js";

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killedSignal: string | null;
  kill: (signal?: string) => boolean;
}

function createFakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedSignal = null;
  child.kill = (signal?: string) => {
    child.killedSignal = signal ?? "SIGTERM";
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  return child;
}

const MODEL = {
  id: "qwen2.5-7b-instruct",
  fileName: "qwen2.5-7b-instruct.gguf",
  sizeBytes: 1024,
  status: "downloaded" as const,
  path: "/models/qwen2.5-7b-instruct.gguf",
};

describe("LlamaServerManager (CR-054)", () => {
  it("resolveBinary：resolveBin 注入优先", () => {
    const manager = new LlamaServerManager({ resolveBin: () => "/opt/llama.cpp/llama-server" });
    expect(manager.resolveBinary()).toBe("/opt/llama.cpp/llama-server");
    expect(manager.configured).toBe(true);
  });

  it("启动成功：健康探测通过后进入 running，并记录 port/modelId/pid", async () => {
    const spawned: FakeChild[] = [];
    const manager = new LlamaServerManager({
      resolveBin: () => "/fake/llama-server",
      spawn: ((...args: unknown[]) => {
        const child = createFakeChild();
        spawned.push(child);
        return child as unknown as ChildProcess;
      }) as typeof import("node:child_process").spawn,
      fetchImpl: (async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 })) as typeof fetch,
      probeIntervalMs: 10,
      probeTimeoutMs: 2000,
    });

    const handle = await manager.start(MODEL, { port: 8080, ctxSize: 8192, gpuLayers: 99, threads: 4 });
    expect(handle.status).toBe("running");
    expect(handle.port).toBe(8080);
    expect(handle.modelId).toBe("qwen2.5-7b-instruct");
    expect(handle.pid).toBe(4242);
    expect(spawned.length).toBe(1);
    expect(manager.getHandle().error).toBeNull();
  });

  it("健康探测持续失败即超时终止并报错", async () => {
    const manager = new LlamaServerManager({
      resolveBin: () => "/fake/llama-server",
      spawn: (() => createFakeChild()) as unknown as typeof import("node:child_process").spawn,
      fetchImpl: (async () => new Response("not ready", { status: 503 })) as typeof fetch,
      probeIntervalMs: 10,
      probeTimeoutMs: 120,
    });

    await expect(manager.start(MODEL, { port: 8081, ctxSize: 4096, gpuLayers: 0, threads: 4 }))
      .rejects.toThrow(/健康检查超时/);
    const handle = manager.getHandle();
    expect(handle.status).toBe("error");
    expect(handle.error).toContain("健康检查超时");
  });

  it("二进制缺失时抛出明确错误", async () => {
    const manager = new LlamaServerManager({ resolveBin: () => null });
    await expect(manager.start(MODEL, { port: 8080, ctxSize: 8192, gpuLayers: 99, threads: 4 }))
      .rejects.toThrow("llama_server_binary_missing");
  });

  it("stop() 幂等：发送 SIGTERM，进程退出后回到 idle", async () => {
    const child = createFakeChild();
    const manager = new LlamaServerManager({
      resolveBin: () => "/fake/llama-server",
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
      probeIntervalMs: 10,
      probeTimeoutMs: 2000,
      killGraceMs: 50,
    });

    await manager.start(MODEL, { port: 8082, ctxSize: 8192, gpuLayers: 99, threads: 4 });
    expect(manager.getHandle().status).toBe("running");

    const stopped = await manager.stop();
    expect(stopped.status).toBe("idle");
    expect(child.killedSignal).toBe("SIGTERM");
    // 重复 stop 应幂等（不再 kill 已死进程）
    const again = await manager.stop();
    expect(again.status).toBe("idle");
  });

  it("进程意外退出（非 stop 触发）置为 error 并带 stderr 尾迹", async () => {
    const child = createFakeChild();
    const manager = new LlamaServerManager({
      resolveBin: () => "/fake/llama-server",
      spawn: (() => child) as unknown as typeof import("node:child_process").spawn,
      fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
      probeIntervalMs: 10,
      probeTimeoutMs: 2000,
    });

    const startPromise = manager.start(MODEL, { port: 8083, ctxSize: 8192, gpuLayers: 99, threads: 4 });
    // 健康来回执前直接让进程崩掉：模拟启动期 segfault
    child.stderr.write("CUDA error: out of memory\n");
    child.emit("exit", 1, "SIGSEGV");
    await startPromise.catch(() => undefined);

    const handle = manager.getHandle();
    expect(handle.status).toBe("error");
    expect(handle.error).toContain("意外退出");
  });
});