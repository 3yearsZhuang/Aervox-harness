import type {
  LLMConfig,
  LLMConfigResponse,
  LLMPreset,
  LLMPresetListResponse,
  LLMProviderType,
} from "@aervox/contracts";
import type { SqliteLLMConfigRepository, TenantContext } from "@aervox/database";
import type { LLMServiceOptions, TestConnectionParams, TestConnectionResult } from "./types.js";

const DEFAULT_CONFIGS: Record<LLMProviderType, { baseUrl: string; modelId: string }> = {
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", modelId: "llama3.2" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", modelId: "gpt-4o" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", modelId: "claude-3-5-sonnet-20241022" },
  custom_openai: { baseUrl: "http://127.0.0.1:8000/v1", modelId: "default" },
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

  async getConfig(tenant: TenantContext): Promise<LLMConfigResponse> {
    const found = await this.repo.getConfig(tenant);
    if (found) return toResponse(found);
    return getConfiguredDefault(this.options);
  }

  /** 列出全部 LLM 配置预设（含激活标记） */
  async listPresets(tenant: TenantContext): Promise<LLMPresetListResponse> {
    const rows = await this.repo.listPresets(tenant);
    const presets = rows.map(toPreset);
    const active = presets.find((p) => p.isActive) ?? null;
    return { presets, activeId: active?.id ?? null };
  }

  /** 新建 LLM 配置预设（首个预设自动激活） */
  async createPreset(tenant: TenantContext, name: string, config: LLMConfig): Promise<LLMPreset> {
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
  async activatePreset(tenant: TenantContext, presetId: string): Promise<LLMPreset | null> {
    const activated = await this.repo.activatePreset(tenant, presetId);
    return activated ? toPreset(activated) : null;
  }

  /** 删除指定 LLM 配置预设（删除激活项时自动提升剩余第一条） */
  async deletePreset(tenant: TenantContext, presetId: string): Promise<boolean> {
    return this.repo.deletePreset(tenant, presetId);
  }

  async saveConfig(tenant: TenantContext, config: LLMConfig): Promise<LLMConfigResponse> {
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
        return {
          ok: true,
          latencyMs,
          message: `连接成功 (HTTP ${res.status})`,
          availableModels,
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
