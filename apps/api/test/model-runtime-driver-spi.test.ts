import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  ModelRuntimeService,
  type ModelRuntimeDriver,
  type ModelRuntimeDriverHandle,
} from "../src/modules/ecosystem/model-runtime/index.js";
import type { LocalModel, LlamaRuntimeParams } from "@aervox/contracts";

describe("ModelRuntimeDriver SPI (本地模型运行时驱动扩展点)", () => {
  it("支持注入第三方自定义驱动（如 Ollama / MLX / 测试桩）并完成状态与启停编排", async () => {
    let startCalled = false;
    let stopCalled = false;

    const mockDriverHandle: ModelRuntimeDriverHandle = {
      pid: 99999,
      status: "running",
      port: 11434,
      modelId: "custom-ollama-model",
      startedAt: new Date().toISOString(),
      error: null,
      logs: ["Custom Ollama runtime initialized"],
    };

    const mockDriver: ModelRuntimeDriver = {
      id: "mock-ollama",
      name: "Mock Ollama Driver",
      configured: true,
      running: false,
      resolveBinary: () => "/usr/local/bin/ollama",
      getHandle: () => (startCalled ? mockDriverHandle : {
        pid: null,
        status: "idle",
        port: null,
        modelId: null,
        startedAt: null,
        error: null,
        logs: [],
      }),
      start: async (_model: LocalModel, _params: LlamaRuntimeParams) => {
        startCalled = true;
        return mockDriverHandle;
      },
      stop: async () => {
        stopCalled = true;
        startCalled = false;
      },
      sampleMetrics: async () => ({
        tokensPerSec: 42.5,
        promptTokensPerSec: 120.0,
      }),
    };

    const service = new ModelRuntimeService({
      driver: mockDriver,
    });

    expect(service.driver.id).toBe("mock-ollama");
    expect(service.driver.name).toBe("Mock Ollama Driver");

    const initialState = await service.getState();
    expect(initialState.llamaServer.binPath).toBe("/usr/local/bin/ollama");
    expect(initialState.llamaServer.configured).toBe(true);
    expect(initialState.runtime.status).toBe("idle");

    // 验证驱动 SPI 提供的指标探测
    const metric = await service.driver.sampleMetrics?.();
    expect(metric?.tokensPerSec).toBe(42.5);

    // 验证停止指令通过驱动派发
    await service.stop();
    expect(stopCalled).toBe(true);
    await service.dispose();
  });

  it("缺省 Driver 场景（unavailable）：返回未配置状态，启动抛错且不发起网络调用", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-driver-unavail-"));
    try {
      await fs.writeFile(path.join(tmpDir, "sample.gguf"), "mock-gguf-binary");
      await fs.writeFile(path.join(tmpDir, "sample.json"), JSON.stringify({
        url: "https://example.com/sample.gguf",
        sha256: "fake-sha",
        downloadedAt: new Date().toISOString(),
      }));

      const service = new ModelRuntimeService({
        modelsDir: tmpDir,
        // options.driver 未传，缺省采用 unavailableModelRuntimeDriver
      });

      expect(service.driver.id).toBe("unavailable");
      expect(service.driver.configured).toBe(false);

      const state = await service.getState();
      expect(state.llamaServer.configured).toBe(false);
      expect(state.runtime.status).toBe("idle");
      expect(state.models).toHaveLength(1);

      // 尝试启动受限模型：明确报错 driver unavailable，而不是崩溃或悄悄走远程
      await expect(service.start({ modelId: "sample" })).rejects.toThrow("model_runtime_driver_unavailable");

      // 验证模型文件与 sidecar 完整保留未被删除或破坏
      const fileExists = await fs.stat(path.join(tmpDir, "sample.gguf")).then(() => true).catch(() => false);
      const sidecarExists = await fs.stat(path.join(tmpDir, "sample.json")).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);
      expect(sidecarExists).toBe(true);

      await service.dispose();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("生命周期完整编排：start、stop 幂等、并发防冲撞与 dispose 闭环", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-driver-lifecycle-"));
    try {
      await fs.writeFile(path.join(tmpDir, "test-model.gguf"), "mock-gguf-binary");
      await fs.writeFile(path.join(tmpDir, "test-model.json"), JSON.stringify({
        url: "https://example.com/test-model.gguf",
        sha256: "fake-sha",
        downloadedAt: new Date().toISOString(),
      }));

      let isRunning = false;
      let stopCount = 0;
      let sampleCalled = 0;

      const fakeDriver: ModelRuntimeDriver = {
        id: "fake-lifecycle",
        name: "Fake Lifecycle Driver",
        configured: true,
        get running() { return isRunning; },
        resolveBinary: () => "/bin/fake",
        getHandle: () => ({
          pid: isRunning ? 12345 : null,
          status: isRunning ? "running" : "idle",
          port: isRunning ? 8080 : null,
          modelId: isRunning ? "test-model" : null,
          startedAt: isRunning ? new Date().toISOString() : null,
          error: null,
          logs: [],
        }),
        start: async () => {
          isRunning = true;
          return fakeDriver.getHandle();
        },
        stop: async () => {
          stopCount++;
          isRunning = false;
          return fakeDriver.getHandle();
        },
        sampleMetrics: async () => {
          sampleCalled++;
          return { tokensPerSec: 50.0, promptTokensPerSec: 100.0 };
        },
      };

      const service = new ModelRuntimeService({
        modelsDir: tmpDir,
        driver: fakeDriver,
        metricsIntervalMs: 50,
      });

      // 启动模型
      const startedState = await service.start({ modelId: "test-model" });
      expect(startedState.runtime.status).toBe("running");

      // 运行中重复调用 start 阻断
      await expect(service.start({ modelId: "test-model" })).rejects.toThrow("llama_server_busy");

      // 停止（首次）
      await service.stop();
      expect(stopCount).toBe(1);

      // 重复停止（幂等）
      await service.stop();
      expect(stopCount).toBe(2);

      // dispose 释放资源并阻断后续调用
      await service.dispose();
      await service.dispose(); // 重复 dispose 幂等

      // dispose 后调用方法均抛出 model_runtime_disposed
      await expect(service.start({ modelId: "test-model" })).rejects.toThrow("model_runtime_disposed");
      await expect(service.resumeDownload("task_1")).rejects.toThrow("model_runtime_disposed");
      await expect(service.deleteModel("test-model")).rejects.toThrow("model_runtime_disposed");
      expect(() => service.subscribe(() => {})).toThrow("model_runtime_disposed");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("代际保护：dispose 后或代际更新后迟到探针/采样结果不改变实例状态或污染样本", async () => {
    let sampleResolve: ((sample: any) => void) | null = null;
    let isRunning = true;

    const fakeDriver: ModelRuntimeDriver = {
      id: "fake-stale",
      name: "Fake Stale Driver",
      configured: true,
      get running() { return isRunning; },
      resolveBinary: () => "/bin/fake",
      getHandle: () => ({
        pid: isRunning ? 1234 : null,
        status: isRunning ? "running" : "idle",
        port: 8080,
        modelId: "model-stale",
        startedAt: new Date().toISOString(),
        error: null,
        logs: [],
      }),
      start: async () => fakeDriver.getHandle(),
      stop: async () => {
        isRunning = false;
        return fakeDriver.getHandle();
      },
      sampleMetrics: () => new Promise((resolve) => {
        sampleResolve = resolve;
      }),
    };

    const service = new ModelRuntimeService({
      driver: fakeDriver,
      metricsIntervalMs: 20,
    });

    // 等待定时器触发 sampleMetrics
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sampleResolve).not.toBeNull();

    // 在采样挂起期间执行 stop（递增 generation）
    await service.stop();

    // 迟到 probe 返回
    sampleResolve!({ tokensPerSec: 99.9, promptTokensPerSec: 88.8 });

    // 验证状态中没有被迟到的 sample 污染
    const state = await service.getState();
    expect(state.metrics).toBeUndefined();

    await service.dispose();
  });
});
