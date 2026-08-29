/**
 * Aervox｜思隅 @aervox/agent-loop — OpenAI 兼容 Chat Completions Provider（阶段 2e）
 *
 * 真实模型接入（DeepSeek / OpenAI / Ollama / 自定义 OpenAI 兼容端点）：
 * - 只实现 OpenAI `/chat/completions` SSE 流协议（Anthropic 等非兼容协议在宿主接线层拒绝）；
 * - 流式解析 delta.content 与 delta.tool_calls（工具调用分片累积），`[DONE]` / finish_reason 收尾；
 * - 工具 schema 来自 request.tools（executor 传入只读白名单），不改变 Loop 控制流。
 * - 思考型模型：思考增量以 `delta.reasoning_content`（DeepSeek / Qwen / vLLM 事实标准）
 *   或 `delta.reasoning`（OpenRouter 统一字段 / Ollama 兼容端点）透传，两种格式同时解析；
 *   OpenAI 官方 Chat Completions 不透出原生推理（走 Responses API），此时自然无思考增量。
 *   捕获的思考内容在下一 Step 序列化时随 assistant 消息回灌（provider 实例单回合内跨 Step 存活）。
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
  maxTokens?: number;
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
  opts: { lastStepReasoning?: string } = {},
): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId });
      continue;
    }
    const msg: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.name) msg.name = encodeName(m.name);
    // 思考型模型：把上一步骤的 reasoning_content 随 assistant 消息回传
    if (m.role === "assistant" && opts.lastStepReasoning) msg.reasoning_content = opts.lastStepReasoning;
    out.push(msg);
  }
  return out;
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
  const timeoutMs = config.timeoutMs ?? 45_000;
  return {
    id: "openai-compat",
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      const toolNameByWireName = new Map(
        (request.tools ?? []).map((tool) => [encodeToolName(tool.name), tool.name]),
      );
      const encodeName = (name: string): string => toolNameByWireName.has(name) ? name : encodeToolName(name);
      // 思考型模型跨 Step 回灌：上一次 stream 捕获的 reasoning_content（provider 实例单回合内存活）
      let lastStepReasoning = "";
      const controller = new AbortController();
      let timedOut = false;
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

      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.modelId,
            messages: toOpenAIMessages(request.context.messages, encodeName, { lastStepReasoning }),
            stream: true,
            temperature: config.temperature ?? 0.7,
            ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: { name: encodeToolName(t.name), description: t.description, parameters: t.parameters ?? { type: "object" } },
                  })),
                }
              : {}),
          }),
          signal: controller.signal,
          redirect: config.redirect,
        });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`llm_http_${res.status}: ${detail.slice(0, 200)}`);
      }
      armIdleTimer();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // 工具调用分片累积：index → { id, name, arguments }
      const toolAccumulator = new Map<number, { id?: string; name: string; args: string }>();
      // 本 Step 的思考内容（思考型模型要求下一步骤随 assistant 消息回传；不作为正文输出）
      let stepReasoning = "";
      let buffer = "";

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
            // 思考增量：reasoning_content（DeepSeek/Qwen/vLLM）与 reasoning（OpenRouter/Ollama）双格式
            const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? "";
            if (reasoningDelta) {
              stepReasoning += reasoningDelta;
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
      // 供同回合下一 Step 序列化时回灌（思考型模型协议要求）
      lastStepReasoning = stepReasoning;
      } catch (error) {
        if (timedOut) throw new Error(`llm_timeout: upstream idle for over ${timeoutMs}ms`);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
