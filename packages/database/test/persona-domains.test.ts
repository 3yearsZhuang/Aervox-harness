import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePersonaRepository,
  SqliteSkillRepository,
  SqliteMcpToolRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CAP-019/CAP-020：Persona/Skills/MCP SQLite 持久化", () => {
  let db: AervoxDatabase;
  let client: Client;
  let personas: SqlitePersonaRepository;
  let skills: SqliteSkillRepository;
  let mcp: SqliteMcpToolRepository;

  const tenant: TenantContext = { workspaceId: "ws_persona", subjectUserId: "usr_persona" };
  const otherTenant: TenantContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    personas = new SqlitePersonaRepository(db);
    skills = new SqliteSkillRepository(db);
    mcp = new SqliteMcpToolRepository(db);
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

  it("Skills upsert/启用/删除 + 租户隔离", async () => {
    const skill = {
      id: "skill_1",
      workspaceId: tenant.workspaceId,
      subjectUserId: tenant.subjectUserId,
      name: "alpha",
      description: "Alpha skill",
      source: "imported",
      version: 1,
      checksum: "d".repeat(64),
      enabled: 1,
      valid: 1,
      validationErrors: [] as string[],
      filesJson: { "SKILL.md": "aGVsbG8=" },
      skillMarkdown: "---\nname: alpha\ndescription: Alpha\n---\nbody",
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await skills.upsertSkill(tenant, skill);
    expect((await skills.getSkill(tenant, "alpha"))?.filesJson["SKILL.md"]).toBe("aGVsbG8=");
    expect(await skills.getSkill(otherTenant, "alpha")).toBeNull();

    await skills.setSkillEnabled(tenant, "alpha", false);
    expect((await skills.getSkill(tenant, "alpha"))?.enabled).toBe(0);
    expect(await skills.deleteSkill(tenant, "alpha")).toBe(true);
    expect(await skills.getSkill(tenant, "alpha")).toBeNull();
  });

  it("MCP 工具 upsert/撤权/kill switch", async () => {
    const tool = {
      id: "server:tool",
      workspaceId: tenant.workspaceId,
      subjectUserId: tenant.subjectUserId,
      serverId: "server",
      name: "tool",
      scopes: [] as string[],
      healthy: 1,
      authorized: 1,
      revoked: 0,
      killSwitch: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mcp.upsertMcpTool(tenant, tool);
    await mcp.setMcpToolRevoked(tenant, "server:tool", true);
    expect((await mcp.listMcpTools(tenant))[0]?.revoked).toBe(1);
    await mcp.setMcpToolKillSwitch(tenant, "server:tool", true);
    expect((await mcp.listMcpTools(tenant))[0]?.killSwitch).toBe(1);
    expect(await mcp.listMcpTools(otherTenant)).toHaveLength(0);
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
