/**
 * Aervox｜思隅 @aervox/database — Token 用量分账工具（T-10 接线）
 *
 * 参照 BaiShou-Next 的 token usage 分类做法（AGPLv3，仅借鉴「缓存/非缓存分离」
 * 的公开设计，字段命名自研）：把一次模型运行的 token 用量拆为
 * - noncacheReadTokens  非缓存输入（首次提示词）token 数
 * - cacheReadTokens     缓存命中输入（提示词前缀缓存）token 数
 * - cacheWriteTokens    本次写入缓存的输入 token 数
 * - completionTokens   输出 token 数
 * - totalTokens         合计
 *
 * 用于成本核算（缓存命中显著降价）与 AI 质量回看；写入 model_runs.token_usage。
 * 兼容旧 { prompt, completion, total } 形态：未分类时按总量归并到非缓存。
 */
export interface TokenUsageBreakdown {
  noncacheReadTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 兼容识别原始 usage 中的数字字段（宽松捕获） */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 将模型 provider 返回的原始 usage 归一为分账结构。
 * 输入可为：
 * - { prompt, completion, total }（旧形态）
 * - { promptTokens, completionTokens, totalTokens }（常见形态）
 * - { prompt_tokens, completion_tokens, total_tokens }（OpenAI 形态）
 * - 带缓存：{ cacheReadTokens | cache_creation_tokens | cached_tokens, cacheWriteTokens | cache_write_tokens, ... }
 */
export function splitTokenUsage(raw: unknown): TokenUsageBreakdown {
  if (!raw || typeof raw !== "object") {
    return {
      noncacheReadTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }
  const usage = raw as Record<string, unknown>;

  const completion = num(
    usage.completion ?? usage.completionTokens ?? usage.completion_tokens,
  );
  const totalInput = num(
    usage.promptTokens ?? usage.prompt_tokens ?? usage.prompt ?? usage.inputTokens,
  );
  const cacheRead = num(
    usage.cacheReadTokens ??
      usage.cached_tokens ??
      (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.[
        "cached_tokens"
      ] ??
      usage.cacheReadInputTokens,
  );
  const cacheWrite = num(
    usage.cacheWriteTokens ??
      usage.cache_write_tokens ??
      (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.[
        "cache_creation_input_tokens"
      ] ??
      usage.cacheCreationInputTokens,
  );
  // 兼容嵌套 prompt_tokens_details（OpenAI）与顶层 cache 字段
  const details =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : usage.promptTokensDetails && typeof usage.promptTokensDetails === "object"
        ? (usage.promptTokensDetails as Record<string, unknown>)
        : null;

  const cacheReadFinal =
    cacheRead > 0 ? cacheRead : details ? num(details["cached_tokens"]) : 0;
  const cacheWriteFinal =
    cacheWrite > 0
      ? cacheWrite
      : details
        ? num(
            details["cache_creation_input_tokens"] ??
              details["cache_write_tokens"],
          )
        : 0;

  const noncacheRead = Math.max(totalInput - cacheReadFinal - cacheWriteFinal, 0);
  const totalTokens = num(usage.totalTokens ?? usage.total_tokens ?? usage.total);

  return {
    noncacheReadTokens: noncacheRead,
    cacheReadTokens: cacheReadFinal,
    cacheWriteTokens: cacheWriteFinal,
    completionTokens: completion,
    totalTokens:
      totalTokens > 0
        ? totalTokens
        : noncacheRead + cacheReadFinal + cacheWriteFinal + completion,
  };
}