import { afterEach, describe, expect, it, vi } from "vitest";
import { DiaryGenerationService, localDateToday } from "@aervox/diary";
import { createSqliteDiaryMaterialPort, SqliteDiaryRepository, SqliteLLMConfigRepository } from "@aervox/repositories";
import { createHostFixture, local } from "./host-fixture.js";
import { runDiaryGenerationCycle } from "../src/diary-generator.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function scheduledDiary(fixture: Awaited<ReturnType<typeof createHostFixture>>) {
  const diaryRepo = new SqliteDiaryRepository(fixture.db);
  const now = new Date().toISOString();
  await diaryRepo.createDiarySchedule(local, { id: "scheduled", scheduleEpochId: "daily", activeFrom: now, initialWindowStart: now, cutoffRule: "daily" });
  const generate = () => runDiaryGenerationCycle({
    diaryRepo, generation: new DiaryGenerationService({ materials: createSqliteDiaryMaterialPort(fixture.db), useModel: true, model: fixture.worker.modelGeneration }),
    platformRepo: { createAuditRecord: async () => undefined } as never, workerId: "contract",
  });
  return { diaryRepo, generate };
}

describe("diary provider protocol through both product composition roots", () => {
  it("an Anthropic configuration stays a labeled template in scheduled and HTTP rewrite paths without OpenAI requests", async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    const fixture = await createHostFixture();
    try {
      await new SqliteLLMConfigRepository(fixture.db).saveConfig(local, {
        enabled: 1, providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1", modelId: "claude-test",
        apiKey: "fake-test-key", temperature: .7, maxTokens: 1024, settings: {},
      });
      const fetch = vi.fn(() => { throw new Error("unsupported provider must not reach the network"); });
      vi.stubGlobal("fetch", fetch);
      const diaryRepo = new SqliteDiaryRepository(fixture.db);
      const now = new Date().toISOString();
      await diaryRepo.createDiarySchedule(local, { id: "scheduled", scheduleEpochId: "daily", activeFrom: now, initialWindowStart: now, cutoffRule: "daily" });
      expect(await runDiaryGenerationCycle({
        diaryRepo, generation: new DiaryGenerationService({ materials: createSqliteDiaryMaterialPort(fixture.db), useModel: true, model: fixture.worker.modelGeneration }),
        platformRepo: { createAuditRecord: async () => undefined } as never, workerId: "contract",
      })).toBe(1);
      const response = await fixture.api.app.inject({ method: "POST", url: "/v1/diaries/generate-today", payload: { rewrite: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ mode: "rewritten", generatedBy: "template" });
      expect(response.json().content).toContain("（本篇为非 LLM 模式的模板日记");
      expect(fetch).not.toHaveBeenCalled();
      const publications = await fixture.client.execute("SELECT count(*) n FROM outbox_events WHERE event_type = 'diary.published'");
      expect(Number(publications.rows[0]!.n)).toBe(2);
    } finally { await fixture.close(); }
  });

  it.each(["ollama", "custom_openai"])("uses the configured %s protocol and output limits for scheduled generation and HTTP rewrite", async providerType => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    const fixture = await createHostFixture();
    try {
      await new SqliteLLMConfigRepository(fixture.db).saveConfig(local, {
        enabled: 1, providerType, baseUrl: "http://127.0.0.1:11434/v1", modelId: "shared-diary-model",
        apiKey: "fake-test-key", temperature: .2, maxTokens: 1024, settings: { contextWindow: 8192, requestTimeoutMs: 90_000 },
      });
      const requests: Array<{ url: string; headers: HeadersInit | undefined; body: Record<string, unknown> }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "标题：共同生成\n完整的日记正文。" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      }));
      const scheduled = await scheduledDiary(fixture);
      expect(await scheduled.generate()).toBe(1);
      expect(await scheduled.diaryRepo.getDiaryByDate(local, localDateToday())).toMatchObject({ title: "共同生成", content: "完整的日记正文。" });
      const response = await fixture.api.app.inject({ method: "POST", url: "/v1/diaries/generate-today", payload: { rewrite: true } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ mode: "rewritten", generatedBy: "llm", title: "共同生成", content: "完整的日记正文。" });
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
        expect(new Headers(request.headers).get("Authorization")).toBe("Bearer fake-test-key");
        expect(request.body).toMatchObject({ model: "shared-diary-model", temperature: .2, max_tokens: 1024, stream: true });
        expect(request.body).not.toHaveProperty("tools");
      }
      const publications = await fixture.client.execute("SELECT count(*) n FROM outbox_events WHERE event_type = 'diary.published'");
      expect(Number(publications.rows[0]!.n)).toBe(2);
    } finally { await fixture.close(); }
  });

  it.each(["early EOF", "empty final", "output token overflow"])("does not publish %s as a diary through either product root", async failure => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    const fixture = await createHostFixture();
    try {
      await new SqliteLLMConfigRepository(fixture.db).saveConfig(local, {
        enabled: 1, providerType: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelId: "shared-diary-model",
        temperature: .7, maxTokens: 1024, settings: { contextWindow: 8192 },
      });
      const partial = `data: ${JSON.stringify({ choices: [{ delta: { content: "不应发布的残稿" }, ...(failure === "output token overflow" ? { finish_reason: "stop" } : {}) }] })}\n\n`;
      const empty = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      const overflow = 'data: {"choices":[],"usage":{"total_tokens":2049,"completion_tokens":1025}}\n\ndata: [DONE]\n\n';
      const fetch = vi.fn(async () => new Response(failure === "empty final" ? empty : partial + (failure === "output token overflow" ? overflow : "")));
      vi.stubGlobal("fetch", fetch);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const scheduled = await scheduledDiary(fixture);
      expect(await scheduled.generate()).toBe(0);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[diary-generator]"), expect.any(Error));
      const response = await fixture.api.app.inject({ method: "POST", url: "/v1/diaries/generate-today", payload: {} });
      expect(response.statusCode).toBe(500);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await scheduled.diaryRepo.listDiaries(local, 10)).toEqual([]);
      const publications = await fixture.client.execute("SELECT count(*) n FROM outbox_events WHERE event_type = 'diary.published'");
      expect(Number(publications.rows[0]!.n)).toBe(0);
    } finally { await fixture.close(); }
  });

  it("enforces the discovered context window before network I/O in both diary triggers", async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    const fixture = await createHostFixture();
    try {
      await new SqliteLLMConfigRepository(fixture.db).saveConfig(local, {
        enabled: 1, providerType: "ollama", baseUrl: "http://127.0.0.1:11434/v1", modelId: "small-context",
        temperature: .7, maxTokens: 1024, settings: { contextWindow: 512 },
      });
      const fetch = vi.fn(() => { throw new Error("over-budget prompt must not reach the network"); });
      vi.stubGlobal("fetch", fetch);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const scheduled = await scheduledDiary(fixture);
      expect(await scheduled.generate()).toBe(0);
      const response = await fixture.api.app.inject({ method: "POST", url: "/v1/diaries/generate-today", payload: {} });
      expect(response.statusCode).toBe(500);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[diary-generator]"), expect.objectContaining({ message: "context_window_exceeded" }));
      expect(fetch).not.toHaveBeenCalled();
      expect(await scheduled.diaryRepo.listDiaries(local, 10)).toEqual([]);
    } finally { await fixture.close(); }
  });
});
