import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePersonaRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CAP-019/CAP-020：Persona SQLite 持久化", () => {
  let db: AervoxDatabase;
  let client: Client;
  let personas: SqlitePersonaRepository;

  const tenant: TenantContext = { workspaceId: "ws_persona", subjectUserId: "usr_persona" };
  const otherTenant: TenantContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    personas = new SqlitePersonaRepository(db);
  });

  it("创建人格 + 不可变修订 + 激活（每租户唯一）", async () => {
    const created = await personas.createPersona(tenant, {
      id: "persona_1",
      name: "Tutor",
      config: { systemPromptAppend: "Be concise", allowedSkillNames: ["alpha"] },
      checksum: "a".repeat(64),
    });
    expect(created.persona.currentRevisionId).toBe(created.revision.id);
    expect(created.revision.revision).toBe(1);

    const active = await personas.activatePersona(tenant, "persona_1");
    expect(active?.personaId).toBe("persona_1");
    expect((await personas.getActivePersona(tenant))?.personaId).toBe("persona_1");

    // 其他租户不可见
    expect(await personas.getPersona(otherTenant, "persona_1")).toBeNull();
  });

  it("修订 CAS：expectedRevision 不匹配时拒绝", async () => {
    await personas.createPersona(tenant, {
      id: "persona_2",
      name: "Guide",
      config: { systemPromptAppend: "v1" },
      checksum: "b".repeat(64),
    });
    await expect(
      personas.updatePersona(tenant, {
        personaId: "persona_2",
        expectedRevision: 99,
        config: { systemPromptAppend: "v2" },
        checksum: "c".repeat(64),
      }),
    ).rejects.toThrow("PERSONA_REVISION_CONFLICT");
  });

  it("Turn 级上下文快照落库并可读取", async () => {
    await personas.saveTurnContext(tenant, {
      id: "ctx_1",
      workspaceId: tenant.workspaceId,
      subjectUserId: tenant.subjectUserId,
      turnId: "turn_1",
      personaId: "persona_1",
      revisionId: "rev_1",
      revisionChecksum: "e".repeat(64),
      promptChecksum: "f".repeat(64),
      skillChecksums: ["d".repeat(64)],
      mcpToolIds: ["server:tool"],
      createdAt: new Date().toISOString(),
    });
    const ctx = await personas.getTurnContext(tenant, "turn_1");
    expect(ctx?.skillChecksums).toEqual(["d".repeat(64)]);
    expect(await personas.getTurnContext(otherTenant, "turn_1")).toBeNull();
  });
});
