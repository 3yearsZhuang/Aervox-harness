/**
 * Aervox｜思隅 @aervox/core — OpenAI 兼容 Chat Completions Provider（阶段 2e）
 *
 * 真实模型接入（DeepSeek / OpenAI / Ollama / 自定义 OpenAI 兼容端点）：
 * - 只实现 OpenAI `/chat/completions` SSE 流协议（Anthropic 等非兼容协议在宿主接线层拒绝）；
 * - 流式解析 delta.content 与 delta.tool_calls（工具调用分片累积），`[DONE]` / finish_reason 收尾；
 * - 工具 schema 来自 request.tools（executor 传入只读白名单），不改变 Loop 控制流。
 * - 思考型模型：思考增量以 `delta.reasoning_content`（DeepSeek / Qwen / vLLM 事实标准）
 *   或 `delta.reasoning`（OpenRouter 统一字段 / Ollama 兼容端点）透传，两种格式同时解析；
 *   OpenAI 官方 Chat Completions 不透出原生推理（走 Responses API），此时自然无思考增量。
 *   捕获的思考内容由每条 assistant 历史持有，在下一 Step 序列化时回传。
 * - timeoutMs 为【空闲超时】：每收到一段上游数据即重置；思考模型持续吐 reasoning 也算活性。
 * 使用全局 fetch（Node 18+ / 浏览器均可用）。
 */
import type { ModelProviderPort } from "./ports.js";
import type { ModelChunk, ModelRequest, PromptMessage, ToolCallRequest } from "./types.js";

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  temperature?: number;
  /** Reproducibility hint; server support requires separate verification. */
  seed?: number;
  /** Optional cap on raw SSE response bytes, including tool argument fragments. */
  maxResponseBytes?: number;
  maxTokens?: number;
  contextWindowTokens?: number;
  estimateInputTokens?: (serializedRequest: string) => number;
  /** 上游空闲超时：连接/首包/任意流片段之间的最大静默间隔（收到数据即重置）。 */
  timeoutMs?: number;
  /** CAP-033 local-only calls reject redirects instead of following them. */
  redirect?: RequestRedirect;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; cache_creation_input_tokens?: number };
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
      /** DeepSeek / Qwen / vLLM 系思考增量 */
      reasoning_content?: string | null;
      /** OpenRouter 统一字段 / Ollama 兼容端点思考增量 */
      reasoning?: string | null;
    };
    finish_reason?: string | null;
  }>;
}

/** OpenAI-compatible providers only accept [A-Za-z0-9_-] in function names. */
function encodeToolName(name: string): string {
  return `avx_${name.replace(/[^a-zA-Z0-9_-]/g, (character) => `_x${character.codePointAt(0)!.toString(16)}_`)}`;
}

function toOpenAIMessages(
  messages: PromptMessage[],
  encodeName: (name: string) => string,
): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
      continue;
    }
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) msg.name = encodeName(m.name);
    if (m.role === "assistant") {
      if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((call) => ({
        id: call.id, type: "function",
        function: { name: encodeName(call.name), arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) },
      }));
      if (m.reasoning) msg.reasoning_content = m.reasoning;
    }
    out.push(msg);
  }
  return out;
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid_tool_arguments");
  }
}

/** 构造 OpenAI 兼容流式 Provider */
export function createOpenAICompatProvider(config: OpenAICompatConfig): ModelProviderPort {
  for (const value of [config.contextWindowTokens, config.maxTokens, config.maxResponseBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("invalid_model_limit");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 45_000;
  return {
    id: "openai-compat",
    capabilities: { toolCalls: true, reasoning: true, contextWindowTokens: config.contextWindowTokens, maxOutputTokens: config.maxTokens },
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const toolNameByWireName = new Map(
        (request.tools ?? []).map((tool) => [encodeToolName(tool.name), tool.name]),
      );
      if (toolNameByWireName.size !== (request.tools ?? []).length) throw new Error("tool_name_collision");
      const encodeName = (name: string): string => toolNameByWireName.has(name) ? name : encodeToolName(name);
      const controller = new AbortController();
      let timedOut = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      // 空闲超时：连接建立、首包、每段流数据都重置计时；持续输出的思考模型不会被误杀
      const armIdleTimer = (): void => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      };
      armIdleTimer();

      const abort = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) {
        controller.abort();
      } else if (request.signal) {
        request.signal.addEventListener("abort", abort, { once: true });
      }

      try {
        const body = JSON.stringify({
            model: config.modelId,
            messages: toOpenAIMessages(request.context.messages, encodeName),
            ...(config.seed !== undefined ? { seed: config.seed } : {}),
            stream: true,
            temperature: request.temperature ?? config.temperature ?? 0.7,
            ...((request.maxOutputTokens ?? config.maxTokens ?? config.contextWindowTokens) !== undefined ? { max_tokens: Math.min(request.maxOutputTokens ?? Infinity, config.maxTokens ?? 4096) } : {}),
            stream_options: { include_usage: true },
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: { name: encodeToolName(t.name), description: t.description, parameters: t.parameters ?? { type: "object" } },
                  })),
                }
              : {}),
          });
        if (config.contextWindowTokens !== undefined) {
          const estimated = config.estimateInputTokens?.(body) ?? new TextEncoder().encode(body).length + 256;
          const reserve = Math.min(request.maxOutputTokens ?? Infinity, config.maxTokens ?? 4096);
          if (!Number.isFinite(estimated) || estimated < 0 || estimated + reserve > config.contextWindowTokens) throw new Error("context_window_exceeded");
        }
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body,
          signal: controller.signal,
          redirect: config.redirect,
        });
      if (!res.ok || !res.body) {
        // An error response may also be an unbounded stream. Read only a snippet.
        let detail = "";
        const errorReader = res.body?.getReader();
        if (errorReader) {
          try {
            let bytes = 0;
            const decoder = new TextDecoder();
            while (bytes < 200) {
              const { done, value } = await errorReader.read();
              if (done) break;
              const slice = value.subarray(0, 200 - bytes);
              bytes += slice.byteLength;
              detail += decoder.decode(slice, { stream: true });
            }
          } finally {
            void errorReader.cancel().catch(() => {});
          }
        }
        throw new Error(`llm_http_${res.status}: ${detail}`);
      }
      armIdleTimer();

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      // 工具调用分片累积：index → { id, name, arguments }
      const toolAccumulator = new Map<number, { id?: string; name: string; args: string }>();
      let buffer = "";
      let responseBytes = 0;
      let finished = false;

      const flushToolCalls = (): ToolCallRequest[] => {
        if (toolAccumulator.size === 0) return [];
        const calls: ToolCallRequest[] = [];
        for (const [, acc] of [...toolAccumulator.entries()].sort(([a], [b]) => a - b)) {
          calls.push({
            id: acc.id ?? `tool_${calls.length + 1}`,
            name: toolNameByWireName.get(acc.name) ?? acc.name,
            arguments: parseToolArguments(acc.args),
          });
        }
        toolAccumulator.clear();
        return calls;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleTimer();
        responseBytes += value.byteLength;
        if (responseBytes > (config.maxResponseBytes ?? 8 * 1024 * 1024)) throw new Error("llm_response_limit");
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") {
            if (!finished) yield { text: "", isFinal: true, stopReason: "incomplete" };
            return;
          }

          let parsed: ChatCompletionChunk;
          try {
            parsed = JSON.parse(payload) as ChatCompletionChunk;
          } catch {
            throw new Error("invalid_stream_chunk");
          }

          if (Number.isFinite(parsed.usage?.total_tokens) && parsed.usage!.total_tokens! >= 0) {
            const u = parsed.usage!;
            yield {
              text: "",
              isFinal: false,
              usage: {
                totalTokens: u.total_tokens!,
                ...((Number.isFinite(u.prompt_tokens_details?.cached_tokens) && u.prompt_tokens_details!.cached_tokens! >= 0) ? { cacheReadTokens: u.prompt_tokens_details!.cached_tokens } : {}),
                ...((Number.isFinite(u.cache_creation_input_tokens) && u.cache_creation_input_tokens! >= 0) ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
                ...(Number.isFinite(u.prompt_tokens) ? { promptTokens: u.prompt_tokens } : {}),
                ...(Number.isFinite(u.completion_tokens) ? { completionTokens: u.completion_tokens } : {}),
              },
            };
          }
          if (finished) continue; // only usage may follow the terminal choice
          for (const choice of (parsed.choices ?? []).slice(0, 1)) {
            const delta = choice.delta ?? {};
            // 思考增量：reasoning_content（DeepSeek/Qwen/vLLM）与 reasoning（OpenRouter/Ollama）双格式
            const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? "";
            if (reasoningDelta) {
              yield { text: "", isFinal: false, reasoning: reasoningDelta };
            }
            if (delta.content) {
              yield { text: delta.content, isFinal: false };
            }
            for (const tc of delta.tool_calls ?? []) {
              const acc = toolAccumulator.get(tc.index) ?? { id: tc.id ?? "", name: "", args: "" };
              if (tc.id !== undefined) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
              toolAccumulator.set(tc.index, acc);
            }

            if (choice.finish_reason) {
              finished = true;
              if (choice.finish_reason === "tool_calls") {
                try {
                  const calls = flushToolCalls();
                  if (!calls.length || new Set(calls.map(c => c.id)).size !== calls.length || calls.some(c => !c.id || !c.name || !c.arguments || typeof c.arguments !== "object" || Array.isArray(c.arguments))) {
                    throw new Error("invalid_tool_arguments");
                  }
                  yield { text: "", isFinal: true, stopReason: "tool_calls", toolCalls: calls };
                } catch {
                  toolAccumulator.clear();
                  yield { text: "", isFinal: true, stopReason: "invalid_tool_arguments" };
                }
              } else {
                const reason = choice.finish_reason === "stop" && toolAccumulator.size ? "incomplete" : choice.finish_reason;
                toolAccumulator.clear();
                yield { text: "", isFinal: true, stopReason: reason };
              }
            }
          }
        }
      }

      // EOF cannot turn partial intent into executable tool calls.
      if (!finished || toolAccumulator.size) yield { text: "", isFinal: true, stopReason: "incomplete" };
      } catch (error) {
        if (timedOut) throw new Error(`llm_timeout: upstream idle for over ${timeoutMs}ms`);
        throw error;
      } finally {
        void reader?.cancel().catch(() => {});
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  };
}
