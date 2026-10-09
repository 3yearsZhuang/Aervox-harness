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

  it("分级/期限不合格的长期记忆不进入主动回合上下文（与主对话召回共用资格谓词）", async () => {
    const database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    try {
      const personaRepo = new SqlitePersonaRepository(database.db);
      const memoryRepo = new SqliteMemoryRepository(database.db, database.client);
      const created = await personaRepo.createPersona(tenant, {
        id: "persona-eligibility",
        name: "思隅",
        config: {systemPromptAppend: "克制、可解释。", allowedSkillNames: []},
        checksum: "b".repeat(64),
      });
      await personaRepo.activatePersona(tenant, created.persona.id, created.revision.id);
      await memoryRepo.createRecord(tenant, {
        id: "memory-ok", layer: "long_term", type: "preference", content: "偏好短暂散步", verificationStatus: "verified",
      });
      await memoryRepo.createRecord(tenant, {
        id: "memory-sensitive", layer: "long_term", type: "preference", content: "敏感记录", verificationStatus: "verified",
      });
      await memoryRepo.createRecord(tenant, {
        id: "memory-expired", layer: "long_term", type: "preference", content: "过期记录", verificationStatus: "verified",
      });
      await database.client.execute("UPDATE memory_records SET sensitivity_class = 'sensitive' WHERE id = 'memory-sensitive'");
      await database.client.execute("UPDATE memory_records SET ai_recall_until = '2000-01-01T00:00:00Z' WHERE id = 'memory-expired'");

      const resolved = await resolveProactiveTurnContext({
        tenant,
        personaRepo,
        memoryRepo,
        evidenceText: "普通提醒",
        pluginId: null,
      });
      expect(resolved.turnContext.memoryReferences.map((ref) => ref.memoryId)).toEqual(["memory-ok"]);
      expect(resolved.memoryContext).toContain("偏好短暂散步");
      expect(resolved.memoryContext).not.toContain("敏感记录");
      expect(resolved.memoryContext).not.toContain("过期记录");
    } finally {
      await database.cleanup();
    }
  });
});
