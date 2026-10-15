import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createInMemoryDatabase, SqliteLLMConfigRepository, type AervoxDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_2e",
  "x-user-id": "usr_2e",
} as const;

const turnPayload = {
  message: { content: "你好", contentType: "text" },
  clientVersion: "it-2e",
  references: [],
};

const parseSse = (body: string): Array<{ eventType: string; data: { text?: string; status?: string; message?: string } }> =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data
        ? (JSON.parse(data.slice(6)) as { eventType: string; data: { text?: string; status?: string; message?: string } })
        : null;
    })
    .filter((x): x is { eventType: string; data: { text?: string; status?: string; message?: string } } => x !== null);

const llmSse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

describe("Agent Loop 阶段 2e：AERVOX_LOOP_PROVIDER=llm 真实模型接线", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "llm";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    vi.unstubAllGlobals();
    await app.close();
    await cleanup();
  });

  it("llm 模式：OpenAI 兼容流 → SSE 收到 delta 正文 + done(Completed)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(llmSse("你好，我是思隅。"), { status: 200 })),
    );
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_2e/turns",
      headers,
      payload: turnPayload,
    });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const parsed = parseSse(eventsRes.body);
    const deltas = parsed.filter((e) => e.eventType === "delta").map((e) => e.data.text);
    expect(deltas).toContain("你好，我是思隅。");
    const done = parsed[parsed.length - 1];
    expect(done.eventType).toBe("done");
    expect(done.data.status).toBe("Completed");
  });

  it("llm 模式 + anthropic 配置：明确不支持 → error 事件 + Failed（不静默回退）", async () => {
    const repo = new SqliteLLMConfigRepository(db);
    await repo.saveConfig(
      { workspaceId: "ws_2e", subjectUserId: "usr_2e" },
      {
        enabled: true,
        providerType: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "k",
        modelId: "claude-3-5",
        temperature: 0.7,
        maxTokens: 4096,
        settings: {},
      },
    );

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_2e/turns",
      headers,
      payload: turnPayload,
    });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const parsed = parseSse(eventsRes.body);
    const errorEvent = parsed.find((e) => e.eventType === "error");
    expect(errorEvent?.data.message).toContain("anthropic_unsupported");
    expect(eventsRes.body).not.toContain('"eventType":"done"');
  });

  it.each([
    { personaName: undefined, metadata: {}, expectedName: "小隅", expectedAddress: "你" },
    { personaName: undefined, metadata: { companionName: "团子", userAddress: "掌柜" }, expectedName: "团子", expectedAddress: "掌柜" },
    { personaName: "雾老师", metadata: { companionName: "团子", userAddress: "掌柜" }, expectedName: "雾老师", expectedAddress: "掌柜" },
  ])("模型实际请求遵循身份优先级：$expectedName / $expectedAddress", async ({ personaName, metadata, expectedName, expectedAddress }) => {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(llmSse("收到。"), { status: 200 });
    }));
    if (personaName) {
      const createdPersona = await app.inject({
        method: "POST", url: "/v1/personas", headers,
        payload: { name: personaName, config: { systemPromptAppend: "请保持简洁。" } },
      });
      expect(createdPersona.statusCode).toBe(201);
      const activated = await app.inject({
        method: "POST", url: `/v1/personas/${createdPersona.json().persona.id}/activate`, headers, payload: {},
      });
      expect(activated.statusCode).toBe(200);
    }
    const created = await app.inject({
      method: "POST", url: "/v1/sessions/ses_identity/turns", headers,
      payload: { ...turnPayload, metadata },
    });
    expect(created.statusCode).toBe(201);
    const events = await app.inject({ method: "GET", url: `/v1/turns/${created.json().turnId}/events`, headers });
    expect(parseSse(events.body).at(-1)?.data.status).toBe("Completed");
    expect(requests.length).toBeGreaterThan(0);
    const system = requests[0]!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    expect(system).toContain(`你是 ${expectedName}`);
    expect(system).toContain(`称呼用户为「${expectedAddress}」`);
    expect(system).toContain("思隅是你所在的空间与介质，不是你的名字");
    if (personaName) expect(system).toContain("请保持简洁。");
  });
});
