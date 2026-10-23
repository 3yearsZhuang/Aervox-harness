import { afterEach, describe, expect, it, vi } from "vitest";
import { DiaryGenerationService } from "@aervox/diary";
import { createSqliteDiaryMaterialPort, SqliteDiaryRepository, SqliteLLMConfigRepository } from "@aervox/repositories";
import { createHostFixture, local } from "./host-fixture.js";
import { runDiaryGenerationCycle } from "../src/diary-generator.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("diary provider protocol through both product composition roots", () => {
  it("an Anthropic configuration stays a labeled template in scheduled and HTTP rewrite paths without OpenAI requests", async () => {
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "llm");
    const fixture = await createHostFixture();
    try {
      await new SqliteLLMConfigRepository(fixture.db).saveConfig(local, {
        enabled: 1, providerType: "anthropic", baseUrl: "https://api.anthropic.com/v1", modelId: "claude-test",
        apiKey: "fake-test-key", temperature: .7, maxTokens: 1024, settingsJson: {},
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
});
