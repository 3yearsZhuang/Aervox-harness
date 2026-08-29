/**
 * Aervox｜思隅 @aervox/agent-loop — OpenAI 兼容 Chat Completions Provider（阶段 2e）
 *
 * 真实模型接入（DeepSeek / OpenAI / Ollama / 自定义 OpenAI 兼容端点）：
 * - 只实现 OpenAI `/chat/completions` SSE 流协议（Anthropic 等非兼容协议在宿主接线层拒绝）；
 * - 流式解析 delta.content 与 delta.tool_calls（工具调用分片累积），`[DONE]` / finish_reason 收尾；
 * - 工具 schema 来自 request.tools（executor 传入只读白名单），不改变 Loop 控制流。
 * 使用全局 fetch（Node 18+ / 浏览器均可用）。
 */
import type { ModelProviderPort } from "./ports.js";
import type { ModelChunk, ModelRequest, PromptMessage, ToolCallRequest } from "./types.js";

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }>;
}

function toOpenAIMessages(messages: PromptMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content, name: m.name };
  });
}

function parseToolArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** 构造 OpenAI 兼容流式 Provider */
export function createOpenAICompatProvider(config: OpenAICompatConfig): ModelProviderPort {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  return {
    id: "openai-compat",
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: toOpenAIMessages(request.context.messages),
          stream: true,
          temperature: config.temperature ?? 0.7,
          ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: "object" } },
                })),
              }
            : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`llm_http_${res.status}: ${detail.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // 工具调用分片累积：index → { id, name, arguments }
      const toolAccumulator = new Map<number, { id?: string; name: string; args: string }>();
      let buffer = "";

      const flushToolCalls = (): ToolCallRequest[] => {
        if (toolAccumulator.size === 0) return [];
        const calls: ToolCallRequest[] = [];
        for (const [, acc] of [...toolAccumulator.entries()].sort(([a], [b]) => a - b)) {
          calls.push({
            id: acc.id ?? `tool_${calls.length + 1}`,
            name: acc.name,
            arguments: parseToolArguments(acc.args),
          });
        }
        toolAccumulator.clear();
        return calls;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;

          let parsed: ChatCompletionChunk;
          try {
            parsed = JSON.parse(payload) as ChatCompletionChunk;
          } catch {
            continue; // 忽略半行/非 JSON 中间态
          }

          for (const choice of parsed.choices ?? []) {
            const delta = choice.delta ?? {};
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

            if (choice.finish_reason === "tool_calls") {
              yield { text: "", isFinal: true, toolCalls: flushToolCalls() };
            } else if (choice.finish_reason === "stop") {
              yield { text: "", isFinal: true };
            }
          }
        }
      }

      // 流结束兜底：残留工具请求未随 finish_reason 吐出
      const leftover = flushToolCalls();
      if (leftover.length > 0) {
        yield { text: "", isFinal: true, toolCalls: leftover };
      }
    },
  };
}