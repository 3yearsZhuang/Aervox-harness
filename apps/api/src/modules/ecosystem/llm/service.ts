import type {
  LLMConfig,
  LLMConfigResponse,
  LLMPreset,
  LLMPresetListResponse,
  LLMProviderType,
} from "@aervox/contracts";
import type { SqliteLLMConfigRepository, LocalContext } from "@aervox/repositories";
import type {
  LLMServiceOptions,
  ModelCapabilities,
  TestConnectionParams,
  TestConnectionResult,
} from "./types.js";

const DEFAULT_CONFIGS: Record<LLMProviderType, { baseUrl: string; modelId: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", modelId: "llama3.2" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", modelId: "claude-3-5-sonnet-20241022" },
  custom_openai: { baseUrl: "http://127.0.0.1:8000/v1", modelId: "default" },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1", modelId: "qwen2.5-7b-instruct" },
};

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
  const preset = DEFAULT_CONFIGS[defaultProvider];
  return {
    enabled: true,
    providerType: defaultProvider,
    baseUrl: options.defaultBaseUrl ?? preset.baseUrl,
    modelId: options.defaultModelId ?? preset.modelId,
    temperature: 0.7,
    maxTokens: 4096,
    settings: {},
  };
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
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(`Invalid baseUrl format: ${config.baseUrl}`);
    }
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
    // 校验 Base URL 格式
    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(`Invalid baseUrl format: ${config.baseUrl}`);
    }

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
  }): Promise<ModelCapabilities | undefined> {
    const isLocal =
      params.providerType === "llamacpp" ||
      params.providerType === "ollama" ||
      this.isLoopbackUrl(params.baseUrl);

    const capabilities: ModelCapabilities = {};
    let contextWindow: number | undefined;

    const withTimeout = async (url: string): Promise<Response | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        return await fetch(url, { method: "GET", headers: params.headers, signal: controller.signal });
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // 1) llama.cpp 专属 /props（default_generation_settings.n_ctx）
    const propsRes = await withTimeout(`${params.baseUrl}/props`);
    if (propsRes?.ok) {
      try {
        const props = (await propsRes.json()) as { default_generation_settings?: Record<string, unknown> };
        const nCtx = props.default_generation_settings?.n_ctx;
        if (typeof nCtx === "number" && nCtx > 0) contextWindow = nCtx;
      } catch {
        // ignore
      }
    }

    // 2) /models/{modelId} 的 meta（llama.cpp 新版 OpenAI 兼容返回 context_length 等元数据）
    if (contextWindow === undefined) {
      const metaRes = await withTimeout(
        `${params.baseUrl}/models/${encodeURIComponent(params.modelId)}`,
      );
      if (metaRes?.ok) {
        try {
          const meta = (await metaRes.json()) as {
            meta?: Record<string, unknown>;
            context_length?: unknown;
          };
          const raw = meta.meta?.context_length ?? meta.meta?.context_window ?? meta.context_length;
          const parsed = typeof raw === "number" || /^\d+$/.test(String(raw)) ? Number(raw) : undefined;
          if (parsed !== undefined && parsed > 0) contextWindow = parsed;
        } catch {
          // ignore
        }
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
    const start = Date.now();
    const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");

    try {
      new URL(cleanBaseUrl);
    } catch {
      return {
        ok: false,
        latencyMs: 0,
        message: `URL 格式非法: ${params.baseUrl}`,
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
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      // 优先尝试探测 models 列表；若不支持则发起单 Token 极简生成探测
      let testEndpoint = `${cleanBaseUrl}/models`;
      if (params.providerType === "anthropic") {
        testEndpoint = `${cleanBaseUrl}/models`;
      }

      let res = await fetch(testEndpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      }).catch(async () => {
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

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - start;

      if (res.ok) {
        let availableModels: string[] | undefined;
        try {
          const data = (await res.json()) as { data?: Array<{ id: string }>; models?: Array<{ name: string }> };
          if (Array.isArray(data.data)) {
            availableModels = data.data.map((m) => m.id).slice(0, 20);
          } else if (Array.isArray(data.models)) {
            availableModels = data.models.map((m) => m.name).slice(0, 20);
          }
        } catch {
          // ignore json parse error on probe
        }
        // 顺带探测模型能力（上下文窗口 / 工具调用支持），best-effort 失败不阻断
        const capabilities = await this.probeModelCapabilities({
          baseUrl: cleanBaseUrl,
          providerType: params.providerType,
          modelId: params.modelId,
          headers,
        });
        return {
          ok: true,
          latencyMs,
          message: `连接成功 (HTTP ${res.status})`,
          availableModels,
          capabilities,
        };
      }

      const errorText = await res.text().catch(() => "");
      return {
        ok: false,
        latencyMs,
        message: `服务返回错误 HTTP ${res.status}${errorText ? `: ${errorText.slice(0, 100)}` : ""}`,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        latencyMs,
        message: `连接失败: ${errorMsg}`,
      };
    }
  }
}
