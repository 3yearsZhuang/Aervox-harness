import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, SqliteLLMConfigRepository,
  SqliteVoiceConfigRepository, SqliteVoiceInputConfigRepository, SqliteVoiceRemoteConfigRepository } from "../src/index.js";
import { llmConfigs, voiceConfigs, voiceInputConfigs, voiceRemoteConfigs } from "@aervox/schema";

const context = { workspaceId: "local", subjectUserId: "local" };
const cases = [
  { label: "llm", Repo: SqliteLLMConfigRepository, table: llmConfigs },
  { label: "voice", Repo: SqliteVoiceConfigRepository, table: voiceConfigs },
  { label: "voice-input", Repo: SqliteVoiceInputConfigRepository, table: voiceInputConfigs },
  { label: "voice-remote", Repo: SqliteVoiceRemoteConfigRepository, table: voiceRemoteConfigs },
];
describe.each(cases)("$label preset lifecycle", ({ Repo, table }) => {
  it("selects the active 51st preset and deterministically promotes a fallback", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    try {
      await initDatabaseSchema(client);
      const repo = new Repo(db);
      // Seed through the writer to exercise selection independently of createPreset.
      await db.insert(table).values(Array.from({ length: 51 }, (_, i) => ({
        id: `preset_${String(i).padStart(3, "0")}`, name: `Preset ${i}`,
        baseUrl: "http://localhost", model: "model", modelId: "model", providerId: "gpt-sovits-local", endpoint: "http://localhost", apiKey: "",
        isActive: i === 50 ? 1 : 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
      })));
      expect((await repo.getConfig(context))?.id).toBe("preset_050");
      const before = (await db.select().from(table)).find(row => row.id === "preset_000");
      const saved = await repo.saveConfig(context, {
        enabled: true, modelId: "changed-active-model", providerId: "gpt-sovits-local",
        providerType: "openai-compatible", engineType: "whisper-compatible",
        baseUrl: "http://localhost/changed", endpoint: "http://localhost/changed", temperature: 0.4,
      });
      expect(saved.id).toBe("preset_050");
      expect(saved.modelId).toBe("changed-active-model");
      const after = await db.select().from(table);
      expect(after.find(row => row.id === "preset_000")).toEqual(before);
      expect(after.find(row => row.id === "preset_050")?.modelId).toBe("changed-active-model");

      expect(await repo.activatePreset(context, "missing")).toBeNull();
      expect((await repo.getConfig(context))?.id).toBe("preset_050");
      expect((await repo.activatePreset(context, "preset_010"))?.id).toBe("preset_010");
      expect((await db.select().from(table)).filter(row => row.isActive === 1)).toHaveLength(1);
      expect(await repo.deletePreset(context, "preset_010")).toBe(true);
      expect((await repo.getConfig(context))?.id).toBe("preset_000");
      await db.update(table).set({ isActive: 0 });
      expect((await repo.getConfig(context))?.id).toBe("preset_000");
    } finally { await cleanup(); }
  });
});
