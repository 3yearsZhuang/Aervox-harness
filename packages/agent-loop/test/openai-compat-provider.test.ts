/**
 * Aervox｜思隅 @aervox/agent-loop — OpenAI 兼容 Provider 测试（阶段 2e）
 *
 * mock 全局 fetch，覆盖 SSE 流的纯文本、工具调用分片累积、请求体组装与非 2xx 错误。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatProvider } from "../src/index.js";
import type { ModelRequest } from "../src/index.js";

const baseRequest: ModelRequest = {
  turnId: "turn_llm",
  attemptId: "atp_llm",
  step: 1,
  context: {
    turnId: "turn_llm",
    sessionId: "sess_llm",
    messages: [
      { role: "user", content: "帮我查复习计划" },
      { role: "assistant", content: "我先查一下", toolCallId: "call_1", name: "search_notes" },
      { role: "tool", content: "{\"ok\":true}", toolCallId: "call_1", name: "search_notes" },
    ],
  },
};

const sseBody = (events: string[]): string => events.map((e) => `data: ${e}\n\n`).join("") + "data: [DONE]\n\n";

function mockFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function collect(provider: ReturnType<typeof createOpenAICompatProvider>, request: ModelRequest = baseRequest) {
  const chunks: Array<{ text: string; isFinal: boolean; reasoning?: string; toolCalls?: unknown[] }> = [];
  for await (const chunk of provider.stream(request)) chunks.push(chunk);
  return chunks;
}

describe("createOpenAICompatProvider（阶段 2e）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("纯文本流：content 逐块 yield，finish_reason=stop 收尾", async () => {
    mockFetch(
      sseBody([
        JSON.stringify({ choices: [{ delta: { content: "你好" }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: "！" }, finish_reason: "stop" }] }),
      ]),
    );
    const chunks = await collect(createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" }));
    expect(chunks.map((c) => c.text)).toEqual(["你好", "！", ""]);
    expect(chunks.map((c) => c.isFinal)).toEqual([false, false, true]);
    expect(chunks.every((c) => !c.toolCalls)).toBe(true);
  });

  it("工具调用流：delta.tool_calls 分片累积为完整 ToolCallRequest", async () => {
    mockFetch(
      sseBody([
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search_notes", arguments: "" } }] },
              finish_reason: null,
            },
          ],
        }),
        JSON.stringify({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: "{\"q\":\"复习\"}" } }] }, finish_reason: "tool_calls" },
          ],
        }),
      ]),
    );

    const chunks = await collect(createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" }));
    const toolChunk = chunks.find((c) => c.toolCalls);
    expect(toolChunk?.isFinal).toBe(true);
    expect(toolChunk?.toolCalls).toEqual([
      { id: "call_1", name: "search_notes", arguments: { q: "复习" } },
    ]);
  });

  it("将含点号的内部工具名编码为 OpenAI 兼容名称，并在回调时还原", async () => {
    const fetchFn = mockFetch(
      sseBody([
        JSON.stringify({
          choices: [{
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "avx_subagent_delegate", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          }],
        }),
      ]),
    );
    const provider = createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" });
    const chunks = await collect(provider, {
      ...baseRequest,
      tools: [{ name: "subagent_delegate", description: "委派子任务", readOnly: true }],
    });

    expect(chunks.find((chunk) => chunk.toolCalls)?.toolCalls).toEqual([
      { id: "call_1", name: "subagent_delegate", arguments: {} },
    ]);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { tools: Array<{ function: { name: string } }> };
    expect(body.tools[0]?.function.name).toBe("avx_subagent_delegate");
  });

  it("请求体组装：messages 含 tool 消息映射，tools 注入只读白名单 schema，stream:true", async () => {
    const fetchFn = mockFetch(sseBody([]));
    const provider = createOpenAICompatProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      apiKey: "k",
      modelId: "llama3.2",
      temperature: 0.3,
      maxTokens: 512,
    });
    await collect(provider, {
      ...baseRequest,
      tools: [{ name: "search_notes", description: "查笔记", readOnly: true }],
    });

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");

    const body = JSON.parse(String(init?.body)) as {
      stream: boolean;
      messages: Array<{ role: string; tool_call_id?: string; content: string; tool_calls?: unknown[] }>;
      tools?: Array<{ type: string; function: { name: string } }>;
    };
    expect(body.stream).toBe(true);
    // 携带 toolCallId 的 assistant 消息 → assistant.tool_calls 载体；tool 消息紧跟其后（OpenAI 协议）
    expect(body.messages).toEqual([
      { role: "user", content: "帮我查复习计划" },
      { role: "assistant", content: "我先查一下", name: "avx_search_notes" },
      { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_1" },
    ]);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "avx_search_notes", description: "查笔记", parameters: { type: "object" } } },
    ]);
  });

  it("tools 声明 parameters JSON Schema 时透传给兼容端点（防数组参数被模型序列化为字符串）", async () => {
    const fetchFn = mockFetch(sseBody([]));
    const provider = createOpenAICompatProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      apiKey: "k",
      modelId: "llama3.2",
    });
    const schema = {
      type: "object",
      properties: { questions: { type: "array", items: { type: "object" } } },
      required: ["questions"],
    };
    await collect(provider, {
      ...baseRequest,
      tools: [{ name: "ask_user_question", description: "提问", readOnly: true, parameters: schema }],
    });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init?.body)) as {
      tools?: Array<{ function: { parameters?: unknown } }>;
    };
    expect(body.tools?.[0]?.function.parameters).toEqual(schema);
  });

  it("思考模型（DeepSeek/Qwen/vLLM）：delta.reasoning_content 逐块透出 reasoning，不混入正文", async () => {
    mockFetch(
      sseBody([
        JSON.stringify({ choices: [{ delta: { reasoning_content: "先想一下" }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { reasoning_content: "：1+1=2" }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: "答案是 2" }, finish_reason: "stop" }] }),
      ]),
    );
    const chunks = await collect(createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" }));
    const reasoningChunks = chunks.filter((c) => c.reasoning);
    expect(reasoningChunks.map((c) => c.reasoning)).toEqual(["先想一下", "：1+1=2"]);
    // 思考增量不产生正文
    expect(reasoningChunks.every((c) => c.text === "" && !c.isFinal)).toBe(true);
    // 正文只有 content 部分（isFinal 收尾块 text 为空串，被 filter 排除）
    expect(chunks.filter((c) => c.text).map((c) => c.text)).toEqual(["答案是 2"]);
  });

  it("思考模型（OpenRouter/Ollama）：delta.reasoning 同样透出 reasoning", async () => {
    mockFetch(
      sseBody([
        JSON.stringify({ choices: [{ delta: { reasoning: "推理片段" }, finish_reason: null }] }),
        JSON.stringify({ choices: [{ delta: { content: "结论" }, finish_reason: "stop" }] }),
      ]),
    );
    const chunks = await collect(createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" }));
    expect(chunks.find((c) => c.reasoning)?.reasoning).toBe("推理片段");
    expect(chunks.filter((c) => c.text).map((c) => c.text)).toEqual(["结论"]);
  });

  it("非 2xx：抛出 llm_http_<status> 错误", async () => {
    mockFetch("unauthorized", 401);
    const provider = createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" });
    const chunks = collect(provider);
    await expect(chunks).rejects.toThrow(/llm_http_401/);
  });

  it("上游模型长期不响应时中止请求并报告 llm_timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const provider = createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m", timeoutMs: 10 });
    const chunks = collect(provider);
    const timeoutAssertion = expect(chunks).rejects.toThrow(/llm_timeout/);

    await vi.advanceTimersByTimeAsync(10);

    await timeoutAssertion;
    vi.useRealTimers();
  });
});
