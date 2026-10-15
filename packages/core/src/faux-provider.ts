/**
 * Aervox｜思隅 @aervox/core — 标准化测试模型 Provider（PI-01 对照与 Provider Parity 夹具）
 *
 * 核心目标：
 * - 统一测试夹具：收敛各处测试中的 ad-hoc mock、scripted 桩和 replay，提供标准能力声明与流式模拟；
 * - 完整能力声明：显式声明 toolCalls, reasoning, contextWindowTokens, maxOutputTokens；
 * - 契约自洽：严格产出归一的 ModelChunk、ModelStopReason 和 ModelUsage 分账数据；
 * - 故障注入：支持在指定 Step 触发错误、取消信号响应以及模拟流延迟。
 */
import type { ModelProviderPort } from "./ports.js";
import type {
  ModelCapabilities,
  ModelChunk,
  ModelRequest,
  ModelStopReason,
  ModelUsage,
  ToolCallRequest,
} from "./types.js";

export interface FauxStep {
  /** 思考内容增量 */
  reasoning?: string;
  /** 文本内容增量 */
  text?: string;
  /** 是否终态 chunk（若未指定，步骤末尾自动补 isFinal=true） */
  isFinal?: boolean;
  /** 终止原因归一（如 stop, tool_calls, length, content_filter, incomplete） */
  stopReason?: ModelStopReason;
  /** 工具调用请求集合 */
  toolCalls?: ToolCallRequest[];
  /** 用量分账数据 */
  usage?: ModelUsage;
  /** 模拟流延迟 ms */
  delayMs?: number;
}

export interface FauxProviderOptions {
  id?: string;
  capabilities?: Partial<ModelCapabilities>;
  /** 预定义各 Step 输出序列 */
  steps?: readonly (FauxStep | readonly FauxStep[])[];
  /** 动态生成函数（优先于 steps） */
  generator?: (request: ModelRequest) => AsyncIterable<ModelChunk> | Iterable<ModelChunk> | FauxStep[];
  /** 注入错误发生的 Step（1-indexed） */
  errorOnStep?: number;
  /** Failure target, 1-indexed. With failAtChunk, selects the failing request Step. */
  failAtStep?: number;
  /** Fail before emitting this chunk (1-indexed); defaults to every Step if failAtStep is absent. */
  failAtChunk?: number;
  errorMessage?: string;
}

export function createFauxProvider(options: FauxProviderOptions = {}): ModelProviderPort {
  const capabilities: ModelCapabilities = {
    toolCalls: options.capabilities?.toolCalls ?? true,
    reasoning: options.capabilities?.reasoning ?? true,
    contextWindowTokens: options.capabilities?.contextWindowTokens ?? 32768,
    maxOutputTokens: options.capabilities?.maxOutputTokens ?? 4096,
  };

  return {
    id: options.id ?? "faux-provider",
    capabilities,
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const checkAbort = () => {
        if (request.signal?.aborted) throw new Error("model_aborted");
      };
      checkAbort();
      if (options.errorOnStep === request.step || (options.failAtStep === request.step && options.failAtChunk === undefined)) {
        throw new Error(options.errorMessage ?? "faux_injected_error");
      }
      let chunkIndex = 0;
      const checkChunk = () => {
        checkAbort();
        if (++chunkIndex === options.failAtChunk && (options.failAtStep === undefined || options.failAtStep === request.step)) {
          throw new Error(options.errorMessage ?? "faux_injected_error");
        }
      };

      if (options.generator) {
        const generated = options.generator(request);
        for await (const chunk of generated) {
          checkChunk();
          yield chunk as ModelChunk;
        }
        return;
      }

      const stepIndex = request.step - 1;
      const stepConfig = options.steps?.[stepIndex];

      if (!stepConfig) {
        // 缺省自然结束
        checkChunk();
        yield {
          text: "",
          isFinal: true,
          stopReason: "stop",
          usage: { totalTokens: 10, promptTokens: 8, completionTokens: 2 },
        };
        return;
      }

      const items: FauxStep[] = Array.isArray(stepConfig) ? [...stepConfig] : [stepConfig as FauxStep];

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (request.signal?.aborted) {
          throw new Error("model_aborted");
        }
        if (item.delayMs && item.delayMs > 0) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (request.signal) request.signal.removeEventListener("abort", onAbort);
              resolve();
            }, item.delayMs);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("model_aborted"));
            };
            if (request.signal) {
              if (request.signal.aborted) {
                clearTimeout(timer);
                reject(new Error("model_aborted"));
                return;
              }
              request.signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        }

        const isLastItem = i === items.length - 1;
        const isFinal = item.isFinal ?? isLastItem;

        const chunk: ModelChunk = {
          text: item.text ?? "",
          isFinal,
          ...(item.reasoning !== undefined ? { reasoning: item.reasoning } : {}),
          ...(item.toolCalls && item.toolCalls.length ? { toolCalls: item.toolCalls } : {}),
          ...(item.usage ? { usage: item.usage } : {}),
          ...(item.stopReason !== undefined
            ? { stopReason: item.stopReason }
            : isFinal
              ? { stopReason: item.toolCalls?.length ? "tool_calls" : "stop" }
              : {}),
        };

        checkChunk();
        yield chunk;
      }
    },
  };
}
