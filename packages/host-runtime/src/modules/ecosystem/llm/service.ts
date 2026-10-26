import type {
  LLMConfig,
  LLMConfigResponse,
  LLMPreset,
  LLMPresetListResponse,
  LLMProviderType,
} from "@aervox/contracts";
import { llmModelCapabilitiesSchema, llmTestConnectionResponseSchema } from "@aervox/contracts";
import type { SqliteLLMConfigRepository, LocalContext } from "@aervox/repositories";
import { configuredProviderDescriptor } from "./provider-catalog.js";
import type {
  LLMServiceOptions,
  ModelCapabilities,
  TestConnectionParams,
  TestConnectionResult,
} from "./types.js";

const contextWindowSchema = llmModelCapabilitiesSchema.shape.contextWindow.unwrap();
const modelNameSchema = llmTestConnectionResponseSchema.shape.availableModels.unwrap().element;

/** Optional provider metadata cannot invalidate a successful connection. */
function normalizeContextWindow(value: unknown): number | undefined {
  const parsed = contextWindowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function normalizeAvailableModels(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  const field = Array.isArray(payload.data) ? "id" : "name";
  const rows: unknown = field === "id" ? payload.data : payload.models;
  if (!Array.isArray(rows)) return undefined;
  const models: string[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const parsed = modelNameSchema.safeParse((row as Record<string, unknown>)[field]);
    if (parsed.success) models.push(parsed.data);
    if (models.length === 20) break;
  }
  return models;
}

function toResponse(found: {
  enabled: number;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number | null;
  settingsJson: unknown;
}): LLMConfigResponse {
  return {
    enabled: Boolean(found.enabled),
    providerType: found.providerType as LLMProviderType,
    baseUrl: found.baseUrl,
    apiKey: found.apiKey ?? undefined,
    modelId: found.modelId,
    temperature: found.temperature,
    maxTokens: found.maxTokens ?? 4096,
    settings: (found.settingsJson as Record<string, string | number | boolean>) ?? {},
  };
}

function toPreset(found: {
  id: string;
  name?: string;
  isActive?: number;
  enabled: number;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number | null;
  settingsJson: unknown;
}): LLMPreset {
  return {
    id: found.id,
    name: found.name ?? "默认配置",
    isActive: Boolean(found.isActive),
    ...toResponse(found),
  };
}

function getConfiguredDefault(options: LLMServiceOptions): LLMConfigResponse {
  const defaultProvider = options.defaultProviderType ?? "ollama";
  assertConfiguredProvider(defaultProvider);
  const descriptor = configuredProviderDescriptor(defaultProvider);
  return {
    enabled: true,
    providerType: defaultProvider,
    baseUrl: options.defaultBaseUrl ?? descriptor.defaultBaseUrl,
    modelId: options.defaultModelId ?? descriptor.recommendedModels[0] ?? "default",
    temperature: 0.7,
    maxTokens: 4096,
    settings: {},
  };
}

/** Safe input failures are distinct from storage and internal service errors. */
export class LLMConfigInputError extends Error {}
function assertConfiguredProvider(id: string): void {
  try { configuredProviderDescriptor(id); }
  catch (error) {
    if (error instanceof Error && error.message === `unknown_model_provider: ${id}`) throw new LLMConfigInputError(error.message);
    throw error;
  }
}
function assertConfigInput(config: LLMConfig): void {
  assertConfiguredProvider(config.providerType);
  try { new URL(config.baseUrl); }
  catch { throw new LLMConfigInputError("Invalid baseUrl format"); }
  if (!config.modelId.trim()) throw new LLMConfigInputError("modelId must not be blank");
}

export class LLMConfigService {
  constructor(
    private readonly repo: SqliteLLMConfigRepository,
    private readonly options: LLMServiceOptions = {},
  ) {}

  async getConfig(tenant: LocalContext): Promise<LLMConfigResponse> {
    const found = await this.repo.getConfig(tenant);
    if (found) return toResponse(found);
    return getConfiguredDefault(this.options);
  }

  /** 列出全部 LLM 配置预设（含激活标记） */
  async listPresets(tenant: LocalContext): Promise<LLMPresetListResponse> {
    const rows = await this.repo.listPresets(tenant);
    const presets = rows.map(toPreset);
    const active = presets.find((p) => p.isActive) ?? null;
    return { presets, activeId: active?.id ?? null };
  }

  /** 新建 LLM 配置预设（首个预设自动激活） */
  async createPreset(tenant: LocalContext, name: string, config: LLMConfig): Promise<LLMPreset> {
    assertConfigInput(config);
    const saved = await this.repo.createPreset(tenant, name, {
      enabled: config.enabled,
      providerType: config.providerType,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      apiKey: config.apiKey?.trim() ? config.apiKey.trim() : undefined,
      modelId: config.modelId.trim(),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      settings: config.settings,
    });
    return toPreset(saved);
  }

  /** 激活指定 LLM 配置预设 */
  async activatePreset(tenant: LocalContext, presetId: string): Promise<LLMPreset | null> {
    const activated = await this.repo.activatePreset(tenant, presetId);
    return activated ? toPreset(activated) : null;
  }

  /** 删除指定 LLM 配置预设（删除激活项时自动提升剩余第一条） */
  async deletePreset(tenant: LocalContext, presetId: string): Promise<boolean> {
    return this.repo.deletePreset(tenant, presetId);
  }

  async saveConfig(tenant: LocalContext, config: LLMConfig): Promise<LLMConfigResponse> {
    assertConfigInput(config);

    const saved = await this.repo.saveConfig(tenant, {
      enabled: config.enabled,
      providerType: config.providerType,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      apiKey: config.apiKey?.trim() ? config.apiKey.trim() : undefined,
      modelId: config.modelId.trim(),
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      settings: config.settings,
    });

    return toResponse(saved);
  }

  /**
   * Best-effort 探测模型能力（上下文窗口与工具调用支持）。
   * 来源约定：
   * - llama.cpp（llamacpp / custom_openai 指向本地端点）：GET /props 的
   *   default_generation_settings.n_ctx，以及 GET /models/{modelId} 的
   *   meta.context_length（各版本字段存在差异，做多键解析）；
   * - 本地端点（回环）默认标记 supportsToolCalls=true（现代 llama.cpp server /
   *   Ollama 均支持 OpenAI function calling）；远程端点不做假设。
   * 探测失败（超时 / 404 / 非 JSON）一律返回 undefined，不阻断主探测。
   */
  private async probeModelCapabilities(params: {
    baseUrl: string;
    providerType: LLMProviderType;
    modelId: string;
    headers: Record<string, string>;
    signal: AbortSignal;
  }): Promise<ModelCapabilities | undefined> {
    const isLocal =
      params.providerType === "llamacpp" ||
      params.providerType === "ollama" ||
      this.isLoopbackUrl(params.baseUrl);

    const capabilities: ModelCapabilities = {};
    let contextWindow: number | undefined;

    const withTimeout = async (url: string): Promise<unknown> => {
      if (params.signal.aborted) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const signal = AbortSignal.any([controller.signal, params.signal]);
      let response: Response | undefined;
      try {
        response = await fetch(url, { method: "GET", headers: params.headers, signal });
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
      }
    };

    // 1) llama.cpp 专属 /props（default_generation_settings.n_ctx）
    const props = await withTimeout(`${params.baseUrl}/props`) as { default_generation_settings?: Record<string, unknown> } | null;
    contextWindow = normalizeContextWindow(props?.default_generation_settings?.n_ctx);

    // 2) /models/{modelId} 的 meta（llama.cpp 新版 OpenAI 兼容返回 context_length 等元数据）
    if (contextWindow === undefined) {
      const meta = await withTimeout(
        `${params.baseUrl}/models/${encodeURIComponent(params.modelId)}`,
      ) as { meta?: Record<string, unknown>; context_length?: unknown } | null;
      for (const raw of [meta?.meta?.context_length, meta?.meta?.context_window, meta?.context_length]) {
        const candidate = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
        contextWindow = normalizeContextWindow(candidate);
        if (contextWindow !== undefined) break;
      }
    }

    if (contextWindow !== undefined) capabilities.contextWindow = contextWindow;
    // 本地端点（llama.cpp / Ollama / 回环 custom）默认具备工具调用能力
    if (isLocal) capabilities.supportsToolCalls = true;
    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  }

  /** 判断 baseUrl 是否为回环端点（127.0.0.1 / localhost / ::1） */
  private isLoopbackUrl(baseUrl: string): boolean {
    try {
      const host = new URL(baseUrl).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    } catch {
      return false;
    }
  }

  async testConnection(params: TestConnectionParams): Promise<TestConnectionResult> {
    try { assertConfiguredProvider(params.providerType); }
    catch (error) { return { ok: false, latencyMs: 0, message: (error as Error).message }; }
    const start = Date.now();
    const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");

    try {
      new URL(cleanBaseUrl);
    } catch {
      return {
        ok: false,
        latencyMs: 0,
        message: "URL 格式非法，请检查模型连接配置。",
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (params.apiKey?.trim()) {
      if (params.providerType === "anthropic") {
        headers["x-api-key"] = params.apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${params.apiKey.trim()}`;
      }
    }

    // 针对不同 Provider 发送轻量探测请求
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    let res: Response | undefined;
    try {
      // 优先尝试探测 models 列表；若不支持则发起单 Token 极简生成探测
      let testEndpoint = `${cleanBaseUrl}/models`;
      if (params.providerType === "anthropic") {
        testEndpoint = `${cleanBaseUrl}/models`;
      }

      res = await fetch(testEndpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      }).catch(async () => {
        controller.signal.throwIfAborted();
        // 若 /models 不支持或失败，尝试发送 POST /chat/completions 或 /messages 极简 probe
        const fallbackEndpoint =
          params.providerType === "anthropic"
            ? `${cleanBaseUrl}/messages`
            : `${cleanBaseUrl}/chat/completions`;
        const body =
          params.providerType === "anthropic"
            ? {
                model: params.modelId,
                max_tokens: 1,
                messages: [{ role: "user", content: "ping" }],
              }
            : {
                model: params.modelId,
                max_tokens: 1,
                messages: [{ role: "user", content: "ping" }],
              };
        return fetch(fallbackEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      });

      const latencyMs = Date.now() - start;

      if (res.ok) {
        let availableModels: string[] | undefined;
        try {
          availableModels = normalizeAvailableModels(await res.json());
        } catch {
          controller.signal.throwIfAborted();
          // ignore json parse error on probe
        }
        // 顺带探测模型能力（上下文窗口 / 工具调用支持），best-effort 失败不阻断
        const capabilities = await this.probeModelCapabilities({
          baseUrl: cleanBaseUrl,
          providerType: params.providerType,
          modelId: params.modelId,
          headers,
          signal: controller.signal,
        });
        return {
          ok: true,
          latencyMs,
          message: `连接成功 (HTTP ${res.status})`,
          availableModels,
          capabilities,
        };
      }

      // Provider errors and fetch exceptions can embed credentials or full URLs.
      return { ok: false, latencyMs, message: `服务返回错误 HTTP ${res.status}` };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, message: "连接失败，请检查模型服务和连接配置。" };
    } finally {
      clearTimeout(timeoutId);
      if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => undefined);
    }
  }
}
