import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  defaultModelProviderRegistry,
  ModelProviderRegistry,
  type ModelProviderDescriptor,
} from "../src/index.js";

describe("ModelProviderRegistry (ITER-033 统一模型 Provider 目录与代际注册)", () => {
  it("默认注册表包含全部出厂内建 Provider 描述符", () => {
    const list = defaultModelProviderRegistry.listDescriptors();
    const ids = list.map((d) => d.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("ollama");
    expect(ids).toContain("llamacpp");
    expect(ids).toContain("custom_openai");
    expect(ids).toContain("replay");
    expect(ids).toContain("faux");

    // 验证本地/出网标记与协议
    const llamacpp = defaultModelProviderRegistry.getDescriptor("llamacpp");
    expect(llamacpp?.isLocal).toBe(true);
    expect(llamacpp?.protocol).toBe("openai-compat");
    expect(llamacpp?.defaultBaseUrl).toBe("http://127.0.0.1:8080/v1");

    const deepseek = defaultModelProviderRegistry.getDescriptor("deepseek");
    expect(deepseek?.isLocal).toBe(false);
    expect(deepseek?.protocol).toBe("openai-compat");
  });

  it("代际注册：注册与注销触发代际递增", () => {
    const registry = new ModelProviderRegistry(false);
    expect(registry.generation).toBe(0);

    const desc: ModelProviderDescriptor = {
      id: "vllm-local",
      name: "vLLM Inference Server",
      protocol: "openai-compat",
      defaultBaseUrl: "http://127.0.0.1:8000/v1",
      capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 4096 },
      isLocal: true,
    };

    registry.register(desc);
    expect(registry.generation).toBe(1);
    expect(registry.getDescriptor("vllm-local")).toEqual(desc);

    // 重复注册同 ID 同样视为一次新代际（热更提供者元数据或配置）
    registry.register({ ...desc, name: "vLLM Updated" });
    expect(registry.generation).toBe(2);
    expect(registry.getDescriptor("vllm-local")?.name).toBe("vLLM Updated");

    // 注销递增
    expect(registry.unregister("vllm-local")).toBe(true);
    expect(registry.generation).toBe(3);
    expect(registry.getDescriptor("vllm-local")).toBeUndefined();

    // 注销不存在的 ID 不递增
    expect(registry.unregister("vllm-local")).toBe(false);
    expect(registry.generation).toBe(3);
  });

  it("无需改动执行器或路由：声明并注册自定义 Provider 后即可直接实例化", async () => {
    const registry = new ModelProviderRegistry(true);

    const customDesc: ModelProviderDescriptor = {
      id: "qwen-local-engine",
      name: "Qwen Dedicated Local Engine",
      protocol: "openai-compat",
      defaultBaseUrl: "http://127.0.0.1:9000/v1",
      capabilities: { toolCalls: true, reasoning: false, maxOutputTokens: 2048 },
      isLocal: true,
      recommendedModels: ["qwen2.5-14b-instruct"],
    };

    registry.register(customDesc);

    const provider = registry.createProvider("qwen-local-engine", {
      modelId: "qwen2.5-14b-instruct",
    });

    expect(provider).toBeDefined();
    expect(provider.id).toBe("openai-compat");
    expect(provider.capabilities?.maxOutputTokens).toBe(2048);
  });

  it("支持自定义 factory 注入", () => {
    const registry = new ModelProviderRegistry(false);
    const mockProvider = {
      id: "mock-p",
      async *stream() {
        yield { text: "mock", isFinal: true };
      },
    };

    registry.register(
      {
        id: "mock-p",
        name: "Mock Provider",
        protocol: "custom",
        capabilities: { toolCalls: false, reasoning: false },
        isLocal: true,
      },
      () => mockProvider,
    );

    const created = registry.createProvider("mock-p");
    expect(created).toBe(mockProvider);
  });

  it("非法 Provider 标识在注册时抛出错误", () => {
    const registry = new ModelProviderRegistry(false);
    expect(() =>
      registry.register({
        id: "",
        name: "Bad",
        protocol: "openai-compat",
        capabilities: { toolCalls: false, reasoning: false },
        isLocal: true,
      }),
    ).toThrow("invalid_provider_id");
  });
});
