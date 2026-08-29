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
  const chunks: Array<{ text: string; isFinal: boolean; toolCalls?: unknown[] }> = [];
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
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
      tools?: Array<{ type: string; function: { name: string } }>;
    };
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "user", content: "帮我查复习计划" },
      { role: "assistant", content: "我先查一下", name: "search_notes" },
      { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_1" },
    ]);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "search_notes", description: "查笔记", parameters: { type: "object" } } },
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

  it("非 2xx：抛出 llm_http_<status> 错误", async () => {
    mockFetch("unauthorized", 401);
    const provider = createOpenAICompatProvider({ baseUrl: "http://x/v1", modelId: "m" });
    const chunks = collect(provider);
    await expect(chunks).rejects.toThrow(/llm_http_401/);
  });
});