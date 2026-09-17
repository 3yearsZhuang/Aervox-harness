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
  });
});
