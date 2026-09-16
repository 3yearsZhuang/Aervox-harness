import { describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryRepository,
  SqlitePersonaRepository,
  SqliteSkillRegistryRepository,
} from "@aervox/repositories";
import { resolveProactiveTurnContext } from "../src/proactive/turn-context.js";

const tenant = {workspaceId: "local", subjectUserId: "local"} as const;

describe("CR-039 P5 主动回合上下文", () => {
  it("复用激活 Persona、有效技能、已验证记忆与统一安全分类", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    try {
      const personaRepo = new SqlitePersonaRepository(database.db);
      const memoryRepo = new SqliteMemoryRepository(database.db, database.client);
      const skillRegistry = new SqliteSkillRegistryRepository(database.db);
      const created = await personaRepo.createPersona(tenant, {
        id: "persona-proactive",
        name: "思隅",
        config: {systemPromptAppend: "保持温柔、克制。", allowedSkillNames: ["care", "disabled"]},
        checksum: "a".repeat(64),
      });
      await personaRepo.activatePersona(tenant, created.persona.id, created.revision.id);
      await skillRegistry.registerSkill({id: "care", name: "care", description: "关怀", active: true});
      await skillRegistry.registerSkill({id: "disabled", name: "disabled", description: "停用", active: false});
      await memoryRepo.createRecord(tenant, {
        id: "memory-verified",
        layer: "long_term",
        type: "preference",
        content: "偏好短暂散步来恢复精力",
        verificationStatus: "verified",
      });
      await memoryRepo.createRecord(tenant, {
        id: "memory-unverified",
        layer: "long_term",
        type: "preference",
        content: "未经确认",
        verificationStatus: "unverified",
      });

      const resolved = await resolveProactiveTurnContext({
        tenant,
        personaRepo,
        memoryRepo,
        skillRegistry,
        evidenceText: "我不想活了",
        pluginId: "health-guard",
      });
      expect(resolved.turnContext).toMatchObject({
        personaId: created.persona.id,
        personaRevisionId: created.revision.id,
        allowedSkills: ["care"],
        safety: {classificationLevel: "crisis", crisisResponse: "fixed_response"},
        memoryReferences: [{memoryId: "memory-verified"}],
        untrustedPluginLayer: {pluginId: "health-guard", personaOverlayEnabled: false},
      });
      expect(resolved.memoryContext).toContain("偏好短暂散步");
      expect(resolved.memoryContext).not.toContain("未经确认");
    } finally {
      await database.cleanup();
    }
  });

  it("无激活 Persona 时 fail-closed", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    try {
      await expect(resolveProactiveTurnContext({
        tenant,
        personaRepo: new SqlitePersonaRepository(database.db),
        memoryRepo: new SqliteMemoryRepository(database.db, database.client),
        evidenceText: "普通提醒",
        pluginId: null,
      })).rejects.toThrow("active Persona");
    } finally {
      await database.cleanup();
    }
  });
});
