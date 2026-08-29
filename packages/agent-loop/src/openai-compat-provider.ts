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
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }>;
}

/**
 * 序列化为 OpenAI 兼容消息序列：
 * - 携带 toolCallId 的 assistant 消息（Loop 记录的工具调用步骤）→ assistant.tool_calls 载体；
 * - role=tool 消息必须紧跟带 tool_calls 的 assistant 消息（OpenAI/DeepSeek 协议要求），
 *   若历史缺失载体则就地合成（id/name 取自 tool 消息）；
 * - 思考型模型（DeepSeek v4 等）要求把上一步骤的 reasoning_content 随 assistant 消息回传：
 *   provider 实例在单回合内跨 Step 存活，lastStepReasoning 由上一次 stream 捕获。
 */
function toOpenAIMessages(
  messages: PromptMessage[],
  opts: { lastStepReasoning?: string } = {},
): unknown[] {
  const out: unknown[] = [];
  const isToolCallsCarrier = (m: unknown): boolean =>
    Array.isArray((m as { tool_calls?: unknown[] }).tool_calls);

  const emitAssistantWithToolCalls = (m: PromptMessage) => {
    const msg: Record<string, unknown> = {
      role: "assistant",
      content: m.content ?? "",
      tool_calls: [
        {
          id: m.toolCallId ?? `call_${out.length}`,
          type: "function",
          function: { name: m.name ?? "tool", arguments: "{}" },
        },
      ],
    };
    if (opts.lastStepReasoning) msg.reasoning_content = opts.lastStepReasoning;
    out.push(msg);
  };

  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (!m) break;
    if (m.role === "assistant" && m.toolCallId) {
      emitAssistantWithToolCalls(m);
      i += 1;
      continue;
    }
    if (m.role !== "tool") {
      out.push({ role: m.role, content: m.content, name: m.name });
      i += 1;
      continue;
    }
    // tool 消息：前置载体缺失时为连续 tool 批次合成一条 assistant.tool_calls
    if (!isToolCallsCarrier(out[out.length - 1])) {
      const batch: PromptMessage[] = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        const t = messages[i];
        if (!t) break;
        batch.push(t);
        i += 1;
      }
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: "",
        tool_calls: batch.map((t, idx) => ({
          id: t.toolCallId ?? `call_${out.length}_${idx}`,
          type: "function",
          function: { name: t.name ?? "tool", arguments: "{}" },
        })),
      };
      if (opts.lastStepReasoning) msg.reasoning_content = opts.lastStepReasoning;
      out.push(msg);
      for (const t of batch) {
        out.push({ role: "tool", content: t.content, tool_call_id: t.toolCallId ?? "" });
      }
      continue;
    }
    out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" });
    i += 1;
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

/**
 * OpenAI 兼容端点的 function.name 仅允许 ^[a-zA-Z0-9_-]+$（DeepSeek 等严格校验），
 * 而 Loop 内置工具名含点号（subagent.delegate / workflow.run）。
 * 出站按请求做安全名映射（非法字符→下划线），入站在 tool_calls 上还原为内部名。
 */
const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolName(name: string): string {
  return SAFE_TOOL_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 构造 OpenAI 兼容流式 Provider */
export function createOpenAICompatProvider(config: OpenAICompatConfig): ModelProviderPort {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  // 思考型模型跨 Step 回灌：上一次 stream 捕获的 reasoning_content（provider 实例回合内存活）
  let lastStepReasoning = "";
  return {
    id: "openai-compat",
    async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
      // 工具名安全映射：内部名 ↔ API 安全名（本请求内双向一致）
      const safeNameToInternal = new Map<string, string>();
      for (const t of request.tools ?? []) {
        const safe = sanitizeToolName(t.name);
        if (safe !== t.name) safeNameToInternal.set(safe, t.name);
      }
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.modelId,
          messages: toOpenAIMessages(request.context.messages, { lastStepReasoning }),
          stream: true,
          temperature: config.temperature ?? 0.7,
          ...(config.maxTokens ? { max_tokens: config.maxTokens } : {}),
          ...(request.tools?.length
            ? {
                tools: request.tools.map((t) => ({
                  type: "function",
                  function: { name: sanitizeToolName(t.name), description: t.description, parameters: { type: "object" } },
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
      // 本 Step 的思考内容（思考型模型要求下一步骤随 assistant 消息回传；不作为正文输出）
      let stepReasoning = "";
      let buffer = "";

      const flushToolCalls = (): ToolCallRequest[] => {
        if (toolAccumulator.size === 0) return [];
        const calls: ToolCallRequest[] = [];
        for (const [, acc] of [...toolAccumulator.entries()].sort(([a], [b]) => a - b)) {
          calls.push({
            id: acc.id ?? `tool_${calls.length + 1}`,
            // API 返回安全名时还原为内部工具名（如 subagent_delegate → subagent.delegate）
            name: safeNameToInternal.get(acc.name) ?? acc.name,
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
            if (delta.reasoning_content) {
              stepReasoning += delta.reasoning_content;
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
    },
  };
}