import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { strToU8, zipSync } from "fflate";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInMemoryDatabase, SqliteSkillRegistryRepository, type AervoxDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_persona",
  "x-user-id": "usr_persona",
} as const;

describe("Persona API：SQLite 持久化 + Skills/MCP/Voice", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let skillsRoot: string;

  beforeEach(async () => {
    skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-persona-test-"));
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client, skillsRoot });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
    await fs.rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it("创建/激活人格，导入 Skills 并导出 Persona Bundle", async () => {
    // 安装系统级技能
    const markdown = "---\nname: alpha\ndescription: alpha description\n---\n\nUse alpha.";
    const skillZip = zipSync({ "alpha/SKILL.md": strToU8(markdown) });
    const installRes = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { zipBase64: Buffer.from(skillZip).toString("base64") },
    });
    expect(installRes.statusCode).toBe(201);

    // 创建人格并激活
    const create = await app.inject({
      method: "POST",
      url: "/v1/personas",
      headers,
      payload: {
        name: "Tutor",
        description: "学习导师",
        config: { systemPromptAppend: "Be concise", allowedSkillNames: ["alpha"], allowedMcpToolIds: [] },
      },
    });
    expect(create.statusCode).toBe(201);
    const personaId = create.json().persona.id;

    const activate = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/activate`,
      headers,
      payload: {},
    });
    expect(activate.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/v1/personas", headers });
    expect(list.json().active.personaId).toBe(personaId);

    // 导出（应包含 alpha Skill）
    const exported = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/export`,
      headers,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().skillNames).toEqual(["alpha"]);
    expect(exported.json().bundleBase64).toBeTruthy();

    // 通过另一兼容上下文导入到同一本地实例
    const otherHeaders = { "x-workspace-id": "ws_persona2", "x-user-id": "usr_persona2" };
    const imported = await app.inject({
      method: "POST",
      url: "/v1/personas/import",
      headers: otherHeaders,
      payload: { bundleBase64: exported.json().bundleBase64, conflictResolution: "error" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().skills).toHaveLength(1);
  });

  it("修订 CAS：并发冲突返回 409", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/personas",
      headers,
      payload: { name: "Guide", config: { systemPromptAppend: "v1" } },
    });
    const personaId = create.json().persona.id;

    const conflict = await app.inject({
      method: "PATCH",
      url: `/v1/personas/${personaId}`,
      headers,
      payload: { expectedRevision: 99, config: { systemPromptAppend: "v2" } },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it.each(["voice", "dependencies", "description"])("导入包的无效 %s 在安装 Skills 或创建人格之前返回 400", async (invalidField) => {
    const beforePersonas = await app.inject({ method: "GET", url: "/v1/personas" });
    const beforeSkills = await app.inject({ method: "GET", url: "/v1/skills" });
    const skillName = "invalid-persona-voice";
    const skillZip = zipSync({
      [`${skillName}/SKILL.md`]: strToU8(
        `---\nname: ${skillName}\ndescription: Must not be installed\n---\n\nBe useful.`,
      ),
    });
    const config = {
      systemPromptAppend: "A valid prompt with invalid nested voice settings",
      ...(invalidField === "voice" ? { voice: { enabled: true, providerId: "gpt-sovits-local", modelId: "" } } : {}),
    };
    // The checksum deliberately matches: rejection must come from the nested
    // configuration contract, rather than archive integrity checks.
    const personaChecksum = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const bundle = zipSync({
      "manifest.json": strToU8(JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        personaId: "invalid-voice-source",
        personaRevisionId: "invalid-voice-revision",
        personaChecksum,
        skills: [{ name: skillName, version: 1, checksum: "a".repeat(64), exported: true }],
        missingDependencies: invalidField === "dependencies" ? "tool:missing" : [],
      })),
      "persona.json": strToU8(JSON.stringify({ schemaVersion: 1, name: "Invalid voice", config,
        ...(invalidField === "description" ? { description: { invalid: true } } : {}) })),
      "skills/skills.zip": skillZip,
    });

    const imported = await app.inject({
      method: "POST",
      url: "/v1/personas/import",
      payload: { bundleBase64: Buffer.from(bundle).toString("base64") },
    });
    const afterPersonas = await app.inject({ method: "GET", url: "/v1/personas" });
    const afterSkills = await app.inject({ method: "GET", url: "/v1/skills" });

    expect.soft(imported.statusCode).toBe(400);
    expect.soft(imported.json().code).toBe("INVALID_BUNDLE");
    expect.soft(afterPersonas.statusCode).toBe(200);
    expect.soft(afterPersonas.json()).toEqual(beforePersonas.json());
    expect.soft(afterSkills.statusCode).toBe(200);
    expect.soft(afterSkills.json()).toEqual(beforeSkills.json());
    await expect(fs.access(path.join(skillsRoot, skillName))).rejects.toThrow();
  });

  it("导入旧版 Bundle 复用 checksum 为 null 的既有技能并返回 201", async () => {
    const skillName = "legacy-persona-skill";
    const registry = new SqliteSkillRegistryRepository(db);
    const existingSkill = await registry.registerSkill({
      id: skillName,
      name: skillName,
      description: "Existing legacy registration",
      source: "local",
      checksum: null,
    });
    const config = { systemPromptAppend: "Reuse a legacy skill", allowedSkillNames: [skillName] };
    const personaChecksum = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const bundle = zipSync({
      "manifest.json": strToU8(JSON.stringify({
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        personaId: "legacy-source",
        personaRevisionId: "legacy-revision",
        personaChecksum,
        // Older manifests may omit skill checksums; the importer reuses the
        // existing registration instead of replacing its files or metadata.
        skills: [{ name: skillName, version: 1, exported: true }],
        missingDependencies: [],
      })),
      "persona.json": strToU8(JSON.stringify({ schemaVersion: 1, name: "Legacy import", config })),
      "skills/skills.zip": zipSync({
        [`${skillName}/SKILL.md`]: strToU8(
          `---\nname: ${skillName}\ndescription: Archive content must not replace the existing skill\n---\n\nBe useful.`,
        ),
      }),
    });

    const imported = await app.inject({
      method: "POST",
      url: "/v1/personas/import",
      payload: { bundleBase64: Buffer.from(bundle).toString("base64") },
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json().skills).toEqual([{
      name: skillName,
      description: existingSkill.description,
      checksum: null,
    }]);
    expect(await registry.getSkill(skillName)).toEqual(existingSkill);
    await expect(fs.access(path.join(skillsRoot, skillName))).rejects.toThrow();
    const detail = await app.inject({ method: "GET", url: `/v1/personas/${imported.json().persona.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().revision.config).toEqual(config);
  });

  it("语音 provider 未配置时返回 503 且不阻断文本", async () => {
    const failed = await app.inject({
      method: "POST",
      url: "/v1/voice/synthesize",
      payload: { providerId: "gpt-sovits-local", text: "hello", modelId: "m" },
    });
    expect(failed.statusCode).toBe(503);
  });

  it("创建与更新携带 voice 语音配置的人格，并在详情中回显", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/personas",
      headers,
      payload: {
        name: "VoicePersona",
        description: "带语音设定的人格",
        config: {
          systemPromptAppend: "You have a calm voice.",
          voice: {
            enabled: true,
            providerId: "gpt-sovits-local",
            modelId: "gpt-sovits-v2",
            speakerId: "calm_girl",
          },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const personaId = create.json().persona.id;
    expect(create.json().revision.config.voice).toEqual({
      enabled: true,
      providerId: "gpt-sovits-local",
      modelId: "gpt-sovits-v2",
      speakerId: "calm_girl",
    });

    // 查询详情验证回显
    const detail = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().revision.config.voice.speakerId).toBe("calm_girl");

    // 更新人格：修改音色
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/personas/${personaId}`,
      headers,
      payload: {
        expectedRevision: 1,
        config: {
          systemPromptAppend: "Updated prompt",
          voice: {
            enabled: true,
            providerId: "gpt-sovits-local",
            modelId: "gpt-sovits-v2",
            speakerId: "energetic_girl",
          },
        },
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().revision.config.voice.speakerId).toBe("energetic_girl");
  });
});
