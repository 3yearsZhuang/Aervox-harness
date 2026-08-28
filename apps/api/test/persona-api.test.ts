import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { strToU8, zipSync } from "fflate";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
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

    // 导入到另一租户
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
