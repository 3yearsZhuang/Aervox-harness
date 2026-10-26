/**
 * Aervox｜思隅 @aervox/core — 统一模型 Provider 目录与代际注册（ITER-033）
 *
 * 核心目标：
 * - 统一两套模型接入栈（@aervox/core 与 apps/api model-runtime）；
 * - 统一 Provider 目录与元数据（协议、是否本地、默认能力声明、推荐模型）；
 * - 代际追踪（generation）：动态增删提供者触发代际递增，避免旧连接/过期配置混乱；
 * - 开放注册接口：新增 OpenAI 兼容端点仅需注册描述符，无需修改执行器或路由。
 */
import type { ModelCapabilities } from "./types.js";
import type { ModelProviderPort } from "./ports.js";
import { createOpenAICompatProvider, type OpenAICompatConfig } from "./openai-compat-provider.js";
import { createReplayProvider } from "./replay-provider.js";
import { createFauxProvider, type FauxProviderOptions } from "./faux-provider.js";

export type ProviderProtocol = "openai-compat" | "replay" | "faux" | "custom";

export interface ModelProviderDescriptor {
  /** 唯一供应商/协议标识，如 'openai', 'deepseek', 'ollama', 'llamacpp', 'custom_openai', 'replay', 'faux' */
  readonly id: string;
  /** 人类可读名称 */
  readonly name: string;
  /** 协议类型 */
  readonly protocol: ProviderProtocol;
  /** 默认 BaseUrl（若有） */
  readonly defaultBaseUrl?: string;
  /** 默认声明能力 */
  readonly capabilities: ModelCapabilities;
  /** 是否为本地模型提供者（不出网） */
  readonly isLocal: boolean;
  /** 推荐模型列表 */
  readonly recommendedModels?: readonly string[];
}

export interface CreateProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  timeoutMs?: number;
  seed?: number;
  redirect?: "error" | "follow" | "manual";
  estimateInputTokens?: (bodyJson: string) => number;
  customConfig?: Record<string, unknown>;
  /** 仅用于 faux 测试提供者 */
  fauxOptions?: FauxProviderOptions;
  /** 仅用于 replay 测试提供者 */
  replayFixture?: readonly string[];
}

export type ModelProviderFactory = (
  descriptor: ModelProviderDescriptor,
  options: CreateProviderOptions,
) => ModelProviderPort;

export interface ModelProviderRegistryPort {
  readonly generation: number;
  register(descriptor: ModelProviderDescriptor, factory?: ModelProviderFactory): void;
  unregister(id: string): boolean;
  getDescriptor(id: string): ModelProviderDescriptor | undefined;
  listDescriptors(): ModelProviderDescriptor[];
  createProvider(id: string, options?: CreateProviderOptions): ModelProviderPort;
}

function copyDescriptor(descriptor: ModelProviderDescriptor): ModelProviderDescriptor {
  return { ...descriptor, capabilities: { ...descriptor.capabilities },
    ...(descriptor.recommendedModels ? { recommendedModels: [...descriptor.recommendedModels] } : {}) };
}

const builtinProviderDescriptors: ModelProviderDescriptor[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-compat",
    defaultBaseUrl: "https://api.openai.com/v1",
    capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 4096 },
    isLocal: false,
    recommendedModels: ["gpt-4o", "gpt-4o-mini"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compat",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 8192 },
    isLocal: false,
    recommendedModels: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    protocol: "openai-compat",
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 4096 },
    isLocal: true,
    recommendedModels: ["llama3.2", "qwen2.5"],
  },
  {
    id: "llamacpp",
    name: "llama.cpp (Local)",
    protocol: "openai-compat",
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 4096 },
    isLocal: true,
    recommendedModels: ["qwen2.5-7b-instruct"],
  },
  {
    id: "custom_openai",
    name: "Custom OpenAI Compatible",
    protocol: "openai-compat",
    defaultBaseUrl: "http://127.0.0.1:8000/v1",
    capabilities: { toolCalls: true, reasoning: true, maxOutputTokens: 4096 },
    isLocal: true,
  },
  {
    id: "replay",
    name: "Deterministic Replay",
    protocol: "replay",
    capabilities: { toolCalls: false, reasoning: false },
    isLocal: true,
  },
  {
    id: "faux",
    name: "Standard Faux Test Provider",
    protocol: "faux",
    capabilities: { toolCalls: true, reasoning: true },
    isLocal: true,
  },
];

export const BUILTIN_PROVIDER_DESCRIPTORS: readonly ModelProviderDescriptor[] = Object.freeze(
  builtinProviderDescriptors.map(descriptor => {
    const snapshot = copyDescriptor(descriptor);
    Object.freeze(snapshot.capabilities);
    if (snapshot.recommendedModels) Object.freeze(snapshot.recommendedModels);
    return Object.freeze(snapshot);
  }),
);

export class ModelProviderRegistry implements ModelProviderRegistryPort {
  private readonly descriptors = new Map<string, ModelProviderDescriptor>();
  private readonly factories = new Map<string, ModelProviderFactory>();
  private _generation = 0;

  get generation(): number {
    return this._generation;
  }

  constructor(seedBuiltins = true) {
    if (seedBuiltins) {
      for (const desc of BUILTIN_PROVIDER_DESCRIPTORS) {
        this.descriptors.set(desc.id, copyDescriptor(desc));
      }
    }
  }

  register(descriptor: ModelProviderDescriptor, factory?: ModelProviderFactory): void {
    if (typeof descriptor.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(descriptor.id)) {
      throw new Error("invalid_provider_id");
    }
    this.descriptors.set(descriptor.id, copyDescriptor(descriptor));
    if (factory) {
      this.factories.set(descriptor.id, factory);
    } else {
      this.factories.delete(descriptor.id);
    }
    this._generation++;
  }

  unregister(id: string): boolean {
    const deletedDesc = this.descriptors.delete(id);
    this.factories.delete(id);
    if (deletedDesc) {
      this._generation++;
    }
    return deletedDesc;
  }

  getDescriptor(id: string): ModelProviderDescriptor | undefined {
    const descriptor = this.descriptors.get(id);
    return descriptor && copyDescriptor(descriptor);
  }

  listDescriptors(): ModelProviderDescriptor[] {
    return [...this.descriptors.values()].map(copyDescriptor);
  }

  createProvider(id: string, options: CreateProviderOptions = {}): ModelProviderPort {
    const customFactory = this.factories.get(id);
    const descriptor = this.descriptors.get(id);

    if (customFactory && descriptor) {
      return customFactory(copyDescriptor(descriptor), options);
    }

    if (!descriptor) {
      throw new Error(`unknown_model_provider: ${id}`);
    }

    if (descriptor.protocol === "replay") {
      return createReplayProvider(options.replayFixture);
    }

    if (descriptor.protocol === "faux") {
      return createFauxProvider({ ...options.fauxOptions,
        capabilities: { ...descriptor.capabilities, ...options.fauxOptions?.capabilities },
      });
    }

    if (descriptor.protocol !== "openai-compat") throw new Error(`model_provider_factory_required: ${id}`);
    const compatConfig: OpenAICompatConfig = {
      baseUrl: options.baseUrl ?? descriptor.defaultBaseUrl ?? "http://127.0.0.1:8000/v1",
      apiKey: options.apiKey,
      modelId: options.modelId ?? "default",
      temperature: options.temperature,
      maxTokens: options.maxTokens ?? descriptor.capabilities.maxOutputTokens,
      contextWindowTokens: options.contextWindowTokens ?? descriptor.capabilities.contextWindowTokens,
      timeoutMs: options.timeoutMs,
      seed: options.seed,
      redirect: options.redirect,
      estimateInputTokens: options.estimateInputTokens,
      capabilities: { toolCalls: descriptor.capabilities.toolCalls, reasoning: descriptor.capabilities.reasoning },
    };
    return createOpenAICompatProvider(compatConfig);
  }
}

export const defaultModelProviderRegistry = new ModelProviderRegistry(true);
