/**
 * Aervox｜思隅 @aervox/api — 大语言模型端点后台健康探测器 (CR-034/CR-042 N1)
 *
 * 规则依据：CR-034（已归档至归档库）
 * - 超时防挂起（默认 5s，不可阻塞 Turn）；
 * - 错误分类（timeout / network_error / auth_error / http_error / unsupported_protocol）；
 * - 探活脱敏：不记录任何 Authorization Header 密钥或 Prompt 正文。
 */
import type {
  HealthStatus,
  LLMProviderType,
  ProbeErrorCategory,
} from "@aervox/contracts";

export interface ProbeParams {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  providerType: LLMProviderType;
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  status: HealthStatus;
  latencyMs: number;
  errorCategory: ProbeErrorCategory | null;
  errorMessage: string | null;
}

export class LlmHealthProber {
  /**
   * 发送轻量探测请求评估指定端点健康状态。
   * 优先探测 /models；不支持则降级为单 Token /chat/completions ping。
   */
  async probe(params: ProbeParams): Promise<ProbeResult> {
    const start = Date.now();
    const timeoutMs = params.timeoutMs ?? 5000;
    const cleanBaseUrl = params.baseUrl.replace(/\/+$/, "");

    try {
      new URL(cleanBaseUrl);
    } catch {
      return {
        ok: false,
        status: "unavailable",
        latencyMs: 0,
        errorCategory: "unknown",
        errorMessage: `Invalid URL format: ${params.baseUrl}`,
      };
    }

    if (params.providerType === "anthropic") {
      return {
        ok: false,
        status: "unavailable",
        latencyMs: 0,
        errorCategory: "unsupported_protocol",
        errorMessage: "anthropic protocol is unsupported in native OpenAI-compatible loop",
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (params.apiKey?.trim()) {
      headers["Authorization"] = `Bearer ${params.apiKey.trim()}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // 1. 优先尝试 GET /models
      let res: Response;
      try {
        res = await fetch(`${cleanBaseUrl}/models`, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
      } catch (err: unknown) {
        if (controller.signal.aborted) throw err;
        // 若 GET /models 失败且未超时，尝试 POST /chat/completions ping
        res = await fetch(`${cleanBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: params.modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: controller.signal,
        });
      }

      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      if (res.ok) {
        return {
          ok: true,
          status: "healthy",
          latencyMs,
          errorCategory: null,
          errorMessage: null,
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: "unavailable",
          latencyMs,
          errorCategory: "auth_error",
          errorMessage: `Authentication failed (HTTP ${res.status})`,
        };
      }

      return {
        ok: false,
        status: "unavailable",
        latencyMs,
        errorCategory: "http_error",
        errorMessage: `Upstream error HTTP ${res.status}`,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted")));

      return {
        ok: false,
        status: "unavailable",
        latencyMs,
        errorCategory: isAbort ? "timeout" : "network_error",
        errorMessage: isAbort ? `Probe timeout after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
      };
    }
  }
}
