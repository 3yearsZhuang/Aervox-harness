/**
 * Aervox｜思隅 @aervox/api — Loop 模型 Provider 构建与 LLMCallable 适配
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * AERVOX_LOOP_PROVIDER 的 Provider 选择（replay / scripted* / llm + CR-034
 * 模型路由降级阶梯）、practice-review 的 LLMCallable 适配与参数规范化哈希
 * 逐字节迁移至本文件。
 */
import {
  createOpenAICompatProvider,
  createReplayProvider,
  createScriptedProvider,
} from "@aervox/agent-loop";
import type { ModelProviderPort } from "@aervox/agent-loop";
import type { LLMCallable } from "@aervox/practice-review";
import type { LocalContext } from "@aervox/repositories";
import { loadApiConfig } from "@aervox/config";
import type { ModelRoutingSnapshot } from "@aervox/contracts";
import type { LLMConfigService } from "../../ecosystem/llm/service.js";
import type { LlmDegradationService } from "../../ecosystem/llm/degradation-service.js";
import { createRuleResponseProvider } from "./rule-response-provider.js";
import { isLiteralLoopbackUrl } from "../../proactive/proactive/profile-context.js";
import {
  API_TOOL_SCRIPT,
  API_WRITE_SCRIPT,
  API_PRIVILEGED_SCRIPT,
  API_QUIZ_SCRIPT,
} from "./replay-scripts.js";

/** 将 ModelProviderPort 适配为 practice-review 所需的 LLMCallable 接口 */
export function createLLMCallable(provider: ModelProviderPort): LLMCallable {
  return {
    async generate(prompt: string, options?: { systemPrompt?: string; temperature?: number }): Promise<string> {
      const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [];
      if (options?.systemPrompt) {
        messages.push({ role: "system", content: options.systemPrompt });
      }
      messages.push({ role: "user", content: prompt });
      let text = "";
      const callId = `llm_${Date.now().toString(36)}`;
      for await (const chunk of provider.stream({
        turnId: callId,
        attemptId: `atp_${callId}`,
        step: 1,
        temperature: options?.temperature,
        context: {
          turnId: callId,
          sessionId: `ses_${callId}`,
          messages,
        },
      })) {
        if (chunk.text) {
          text += chunk.text;
        }
      }
      return text;
    },
  };
}

/** 参数规范化哈希：key 排序，保证等价 JSON 命中同一授权 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Loop 模型 Provider 构建（Leader 与 5c 子任务共用）。
 * 选择（AERVOX_LOOP_PROVIDER）：replay（默认确定性回放）/ scripted（两步工具链验证）/
 * scripted-write / scripted-privileged / llm（CR-015 真实配置；anthropic 明示不支持）。
 */
export async function buildLoopProvider(
  ctx: LocalContext,
  llmConfigService?: LLMConfigService,
  options: {
    requireLocalOnly?: boolean;
    sessionId?: string;
    turnId?: string;
    modelRoutingService?: LlmDegradationService;
    persona?: { name?: string };
  } = {},
): Promise<ModelProviderPort> {
  // 缺陷 E：Provider 选择经 @aervox/config 集中解析（AERVOX_LOOP_PROVIDER 启动期枚举校验）；
  // 每次调用读取，避免模块级缓存导致测试/配置热变失效。
  const apiConfig = loadApiConfig();
  const { loopProvider: mode } = apiConfig;
  if (mode === "replay") return createReplayProvider();
  if (mode === "scripted") return createScriptedProvider(API_TOOL_SCRIPT);
  if (mode === "scripted-write") return createScriptedProvider(API_WRITE_SCRIPT);
  if (mode === "scripted-privileged") return createScriptedProvider(API_PRIVILEGED_SCRIPT);
  if (mode === "scripted-quiz") return createScriptedProvider(API_QUIZ_SCRIPT);
  if (mode === "llm") {
    // CR-034: 若开启模型路由且注入了降级决策服务，走降级阶梯
    if (apiConfig.modelRoutingFeatureFlags.has("model_routing") && options.modelRoutingService) {
      const snapshot = await options.modelRoutingService.getRoutingSnapshot({
        sessionId: options.sessionId,
        turnId: options.turnId,
        requireLocalOnly: options.requireLocalOnly,
        tenant: ctx,
      });

      if (snapshot.tier === "L2" || !snapshot.baseUrl || !snapshot.modelId) {
        if (apiConfig.modelRoutingFeatureFlags.has("rule_response")) {
          const ruleProvider = createRuleResponseProvider({
            personaName: options.persona?.name,
            reason: snapshot.reason,
          });
          (ruleProvider as unknown as { routingSnapshot?: ModelRoutingSnapshot }).routingSnapshot = snapshot;
          return ruleProvider;
        }
        throw new Error(`model_degraded_l2: ${snapshot.reason}`);
      }

      if (options.requireLocalOnly && !snapshot.localAttestation) {
        throw new Error("proactive_local_provider_required: 主动画像上下文禁止发送到非本机模型端点");
      }

      const presets = llmConfigService ? await llmConfigService.listPresets(ctx) : null;
      const matchedPreset = snapshot.presetId
        ? presets?.presets.find((p) => p.id === snapshot.presetId)
        : null;

      const isL1Tier = snapshot.tier === "L1";
      const isCapabilityTiering = apiConfig.modelRoutingFeatureFlags.has("capability_tiering");
      const defaultMaxTokens = isL1Tier && isCapabilityTiering ? 2048 : 4096;
      const configuredMax = matchedPreset?.maxTokens ?? defaultMaxTokens;
      const maxTokens = isL1Tier && isCapabilityTiering ? Math.min(configuredMax, 2048) : configuredMax;
      // CR-053 预算适配：探测得的上下文窗口（preset.settings.contextWindow，连通性测试回写）为有效上界时，
      // 预留 CONTEXT_RESERVE_TOKENS 给系统提示与工具 schema，避免 maxTokens 放不下 prompt 组合而直接被拒。
      const discoveredContextWindow = Number(matchedPreset?.settings?.contextWindow);
      const CONTEXT_RESERVE_TOKENS = 1024;
      const effectiveMaxTokens =
        Number.isFinite(discoveredContextWindow) && discoveredContextWindow > 0
          ? Math.max(256, Math.min(maxTokens, discoveredContextWindow - CONTEXT_RESERVE_TOKENS))
          : maxTokens;

      const requestTimeoutMs = Number(matchedPreset?.settings?.requestTimeoutMs);
      const provider = createOpenAICompatProvider({
        baseUrl: snapshot.baseUrl,
        apiKey: matchedPreset?.apiKey,
        modelId: snapshot.modelId,
        temperature: matchedPreset?.temperature ?? 0.7,
        maxTokens: effectiveMaxTokens,
        ...(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? { timeoutMs: requestTimeoutMs } : {}),
        redirect: options.requireLocalOnly ? "error" : undefined,
      });
      (provider as unknown as { routingSnapshot?: ModelRoutingSnapshot }).routingSnapshot = snapshot;
      return provider;
    }

    if (!llmConfigService) {
      throw new Error("llm_provider_unavailable: LLMConfigService 未接线");
    }
    const cfg = await llmConfigService.getConfig(ctx);
    if (!cfg.enabled) throw new Error("llm_disabled: 当前租户未启用 LLM 配置");
    if (cfg.providerType === "anthropic") {
      throw new Error("anthropic_unsupported: 阶段 2e 仅支持 OpenAI 兼容协议（openai/deepseek/ollama/llamacpp/custom_openai）");
    }
    if (options.requireLocalOnly && !isLiteralLoopbackUrl(cfg.baseUrl)) {
      throw new Error("proactive_local_provider_required: 主动画像上下文禁止发送到非本机模型端点");
    }
    // CR-027：思考型模型经 settings.requestTimeoutMs（空闲超时，ms）放宽上游静默上限；
    // provider 语义为「每收到一段数据即重置」，默认 45s 空闲。
    const requestTimeoutMs = Number(cfg.settings?.requestTimeoutMs);
    // CR-053 预算适配：探测回的上下文窗口回写在 settings.contextWindow，作为 maxTokens 上界。
    const discoveredContextWindow = Number(cfg.settings?.contextWindow);
    const reserve = 1024;
    const effectiveMaxTokens =
      Number.isFinite(discoveredContextWindow) && discoveredContextWindow > 0
        ? Math.max(256, Math.min(cfg.maxTokens ?? 4096, discoveredContextWindow - reserve))
        : (cfg.maxTokens ?? 4096);
    return createOpenAICompatProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      modelId: cfg.modelId,
      temperature: cfg.temperature,
      maxTokens: effectiveMaxTokens,
      ...(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? { timeoutMs: requestTimeoutMs } : {}),
      redirect: options.requireLocalOnly ? "error" : undefined,
    });
  }
  return createReplayProvider();
}
