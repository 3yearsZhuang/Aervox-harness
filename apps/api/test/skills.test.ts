/**
 * Aervox｜思隅 @aervox/api — Skill 模块集成测试（CAP-020）
 *
 * 覆盖：zip 安装（单/多技能）、安全校验（路径穿越拒绝）、frontmatter 描述解析、
 * 内容读取、渐进式披露 prompt、启停、删除（readonly 拒绝）、overwrite 冲突语义。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, initDatabaseSchema, SqliteSkillRegistryRepository, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_skill",
  "x-user-id": "usr_skill",
} as const;

// ---- 测试用 STORE（无压缩）zip 构造器 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoreZip(files: Array<{ name: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, content } of files) {
    const data = Buffer.from(content, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = STORE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const SKILL_MD = (name: string, desc: string): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\n按本手册执行。`;

describe("CAP-020 Skill 模块", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let skillsRoot: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox_skills_"));
    const built = await buildApp({ db, client, skillsRoot });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await cleanup();
  });

  it("安装单技能 zip（根含 SKILL.md）：注册 + 内容落盘 + frontmatter 描述解析", async () => {
    const zip = buildStoreZip([{ name: "SKILL.md", content: SKILL_MD("review-notes", "整理复习笔记") }]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "review-notes", zipBase64: zip.toString("base64") },
    });
    expect(res.statusCode).toBe(201);
    const installed = res.json().installed as Array<{ name: string; description: string; source: string }>;
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe("review-notes");
    expect(installed[0].description).toBe("整理复习笔记");
    expect(installed[0].source).toBe("local");

    const content = await app.inject({ method: "GET", url: "/v1/skills/review-notes/content" });
    expect(content.statusCode).toBe(200);
    expect(content.json().content).toContain("按本手册执行");
  });

  it("安装多技能 zip：按顶层目录逐个安装", async () => {
    const zip = buildStoreZip([
      { name: "skill-a/SKILL.md", content: SKILL_MD("skill-a", "技能A") },
      { name: "skill-a/scripts/run.sh", content: "echo a" },
      { name: "skill-b/SKILL.md", content: SKILL_MD("skill-b", "技能B") },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { zipBase64: zip.toString("base64") },
    });
    expect(res.statusCode).toBe(201);
    const installed = res.json().installed as Array<{ name: string }>;
    expect(installed.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);

    const list = await app.inject({ method: "GET", url: "/v1/skills?source=local" });
    expect(list.json().items.length).toBe(2);
  });

  it("安全校验：路径穿越 zip 被拒绝", async () => {
    const zip = buildStoreZip([{ name: "../evil/SKILL.md", content: "x" }]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "evil", zipBase64: zip.toString("base64") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("安全校验：./ 前缀与反斜杠条目被规范化（Windows / zip -r . 打包兼容）", async () => {
    const zip = buildStoreZip([
      { name: "./", content: "" },
      { name: "./skill-a/SKILL.md", content: SKILL_MD("skill-a", "技能A") },
      { name: "./skill-a/assets/note.md", content: "note" },
      { name: "skill-b\\SKILL.md", content: SKILL_MD("skill-b", "技能B") },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { zipBase64: zip.toString("base64") },
    });
    expect(res.statusCode).toBe(201);
    const installed = res.json().installed as Array<{ name: string }>;
    expect(installed.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
  });

  it("安全校验：反斜杠路径穿越被拒绝", async () => {
    const zip = buildStoreZip([{ name: "skill\\..\\..\\evil.txt", content: "x" }]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "evil", zipBase64: zip.toString("base64") },
    });
    expect(res.statusCode).toBe(400);
  });

  it("overwrite 语义：冲突 409，覆盖 201", async () => {
    const zip = buildStoreZip([{ name: "SKILL.md", content: SKILL_MD("dup", "v1") }]);
    const first = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "dup", zipBase64: zip.toString("base64") },
    });
    expect(first.statusCode).toBe(201);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "dup", zipBase64: zip.toString("base64") },
    });
    expect(conflict.statusCode).toBe(409);

    const overwrite = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "dup", overwrite: true, zipBase64: zip.toString("base64") },
    });
    expect(overwrite.statusCode).toBe(201);
  });

  it("渐进式披露 prompt 仅含启用技能清单", async () => {
    const zip = buildStoreZip([{ name: "SKILL.md", content: SKILL_MD("piano-tutor", "钢琴陪练") }]);
    await app.inject({ method: "POST", url: "/v1/skills", payload: { name: "piano-tutor", zipBase64: zip.toString("base64") } });

    const res = await app.inject({ method: "GET", url: "/v1/skills/prompt" });
    expect(res.statusCode).toBe(200);
    const prompt = res.json().prompt as string;
    expect(prompt).toContain("piano-tutor");
    expect(prompt).toContain("钢琴陪练");
    expect(prompt).toContain("/v1/skills/:name/content");
  });

  it("启停：activeOnly 过滤；删除后 404；readonly 拒绝删除", async () => {
    const zip = buildStoreZip([{ name: "SKILL.md", content: SKILL_MD("toggle-me", "开关测试") }]);
    await app.inject({ method: "POST", url: "/v1/skills", payload: { name: "toggle-me", zipBase64: zip.toString("base64") } });

    const disable = await app.inject({
      method: "PATCH",
      url: "/v1/skills/toggle-me",
      payload: { active: false },
    });
    expect(disable.statusCode).toBe(200);
    expect(disable.json().active).toBe(0);

    const activeOnly = await app.inject({ method: "GET", url: "/v1/skills?activeOnly=true&source=local" });
    expect(activeOnly.json().items.length).toBe(0);

    // readonly 技能直接注册后删除应 409
    const registry = new SqliteSkillRegistryRepository(db);
    await registry.registerSkill({
      id: "plugin-skill",
      name: "plugin-skill",
      description: "插件内置",
      source: "plugin",
      readonly: true,
    });
    const deny = await app.inject({ method: "DELETE", url: "/v1/skills/plugin-skill" });
    expect(deny.statusCode).toBe(409);

    const del = await app.inject({ method: "DELETE", url: "/v1/skills/toggle-me" });
    expect(del.statusCode).toBe(204);

    const missing = await app.inject({ method: "GET", url: "/v1/skills/toggle-me" });
    expect(missing.statusCode).toBe(404);
  });

  it("非法 zip（非 zip 数据）返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/skills",
      payload: { name: "x", zipBase64: Buffer.from("not a zip at all").toString("base64") },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("CAP-020 Skill Neo 生命周期（阶段4）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let skillsRoot: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox_skills_life_"));
    const built = await buildApp({ db, client, skillsRoot });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await cleanup();
  });

  it("全流程：payload → candidate → evaluate(passed) → promote canary → release active", async () => {
    const pl = await app.inject({
      method: "POST",
      url: "/v1/skills/payloads",
      payload: { kind: "aervox_skill_v1", payload: { skill_markdown: "# demo" } },
    });
    expect(pl.statusCode).toBe(201);
    const payloadRef = pl.json().payloadRef as string;

    const cand = await app.inject({
      method: "POST",
      url: "/v1/skills/candidates",
      payload: {
        skillKey: "demo-skill",
        sourceEvidence: { turnIds: ["turn_1"], memoryIds: ["mem_1"] },
        payloadRef,
      },
    });
    expect(cand.statusCode).toBe(201);
    const candidateId = cand.json().candidateId as string;
    expect(cand.json().status).toBe("pending");

    const evalRes = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/evaluate`,
      payload: { passed: true, score: 90, report: "ok" },
    });
    expect(evalRes.statusCode).toBe(200);
    expect(evalRes.json().status).toBe("evaluated");

    const promote = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/promote`,
      payload: { stage: "canary" },
    });
    expect(promote.statusCode).toBe(200);
    const release = promote.json();
    expect(release.stage).toBe("canary");
    expect(release.version).toBe(1);
    expect(release.active).toBe(1);

    const list = await app.inject({ method: "GET", url: "/v1/skills/releases?skillKey=demo-skill&stage=canary" });
    expect(list.json().items.length).toBe(1);
  });

  it("rejected 候选晋升被拒（409）；评估后再次评估幂等返回已定态", async () => {
    const cand = await app.inject({
      method: "POST",
      url: "/v1/skills/candidates",
      payload: { skillKey: "bad-skill", sourceEvidence: {} },
    });
    const candidateId = cand.json().candidateId as string;

    const reject = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/evaluate`,
      payload: { passed: false, report: "不通过" },
    });
    expect(reject.json().status).toBe("rejected");

    const promote = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/promote`,
      payload: { stage: "canary" },
    });
    expect(promote.statusCode).toBe(409);
  });

  it("promote stable + syncToLocal：落盘 SKILL.md + 注册 ai_authored + synced_to_local=1", async () => {
    const md = "---\nname: ai-notes\ndescription: AI 自主生成的技能\n---\n# ai-notes\n\n自动生成内容。";
    const pl = await app.inject({
      method: "POST",
      url: "/v1/skills/payloads",
      payload: { payload: { skill_markdown: md } },
    });
    const payloadRef = pl.json().payloadRef as string;

    const cand = await app.inject({
      method: "POST",
      url: "/v1/skills/candidates",
      payload: { skillKey: "ai-notes", sourceEvidence: {}, payloadRef },
    });
    const candidateId = cand.json().candidateId as string;
    await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/evaluate`,
      payload: { passed: true },
    });

    const promote = await app.inject({
      method: "POST",
      url: `/v1/skills/candidates/${candidateId}/promote`,
      payload: { stage: "stable", syncToLocal: true },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().syncedToLocal).toBe(1);

    // 本地文件落盘
    const skillMd = path.join(skillsRoot, "ai-notes", "SKILL.md");
    const onDisk = await fs.readFile(skillMd, "utf8");
    expect(onDisk).toContain("自动生成内容");

    // 注册表已登记 ai_authored
    const content = await app.inject({ method: "GET", url: "/v1/skills/ai-notes/content" });
    expect(content.statusCode).toBe(200);
    expect(content.json().description).toBe("AI 自主生成的技能");
  });

  it("回滚：promote v2 后 rollback v2，v1 恢复 active", async () => {
    const mk = async (key: string, ver: string) => {
      const pl = await app.inject({ method: "POST", url: "/v1/skills/payloads", payload: { payload: { skill_markdown: `# ${key} ${ver}` } } });
      const payloadRef = pl.json().payloadRef as string;
      const cand = await app.inject({ method: "POST", url: "/v1/skills/candidates", payload: { skillKey: "rollback-skill", sourceEvidence: {}, payloadRef } });
      const candidateId = cand.json().candidateId as string;
      await app.inject({ method: "POST", url: `/v1/skills/candidates/${candidateId}/evaluate`, payload: { passed: true } });
      const promote = await app.inject({ method: "POST", url: `/v1/skills/candidates/${candidateId}/promote`, payload: { stage: "canary" } });
      return promote.json();
    };

    const v1 = await mk("rollback-skill", "v1");
    const v2 = await mk("rollback-skill", "v2");

    // 重新拉取发布列表：v2 晋升后 v1 应被自动取消 active
    const list = await app.inject({ method: "GET", url: "/v1/skills/releases?skillKey=rollback-skill&stage=canary" });
    const releases = list.json().items as Array<{ releaseId: string; version: number; active: number }>;
    const byVersion = new Map(releases.map((r) => [r.version, r]));
    expect(byVersion.get(1)?.active).toBe(0); // 旧发布被取消
    expect(byVersion.get(2)?.active).toBe(1);

    const rollback = await app.inject({ method: "POST", url: `/v1/skills/releases/${v2.releaseId}/rollback` });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().rolledBack.active).toBe(0);
    expect(rollback.json().restored.releaseId).toBe(v1.releaseId);
    expect(rollback.json().restored.active).toBe(1);
  });

  it("aervox_skill_* 工具登记：read_only/write_with_approval 安全级别正确", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/tools" });
    const tools = list.json().items as Array<{ id: string; safetyLevel: string }>;
    const skillTools = tools.filter((t) => t.id.startsWith("aervox_skill_"));
    expect(skillTools.length).toBe(9);

    const readOnlyIds = skillTools.filter((t) => t.safetyLevel === "read_only").map((t) => t.id);
    expect(readOnlyIds.sort()).toEqual(
      ["aervox_skill_get_payload", "aervox_skill_list_candidates", "aervox_skill_list_releases"].sort(),
    );
    const writeIds = skillTools.filter((t) => t.safetyLevel === "write_with_approval").map((t) => t.id);
    expect(writeIds.length).toBe(6);
  });

  it("aervox_skill_* 工具可经 /v1/tools/:id/call 调用：写工具需授权，读工具可直接调用", async () => {
    // 写工具未授权 → 400
    const denied = await app.inject({
      method: "POST",
      url: "/v1/tools/aervox_skill_create_payload/call",
      payload: { arguments: { payload: { skill_markdown: "# x" } } },
    });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().isError).toBe(true);

    // 写工具授权 → 200，创建 payload
    const approved = await app.inject({
      method: "POST",
      url: "/v1/tools/aervox_skill_create_payload/call",
      payload: { arguments: { payload: { skill_markdown: "# via-tool" } }, approval: true },
    });
    expect(approved.statusCode).toBe(200);
    const created = JSON.parse(approved.json().content[0].text as string);
    expect(created.payloadRef).toBeTruthy();

    // 读工具无需授权
    const listed = await app.inject({
      method: "POST",
      url: "/v1/tools/aervox_skill_list_releases/call",
      payload: { arguments: {} },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.json().content[0].text as string)).toEqual({ items: [] });
  });
});

describe("CAP-020 插件 Skill 联动（阶段5）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let skillsRoot: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox_skills_plugin_"));
    const built = await buildApp({ db, client, skillsRoot });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(skillsRoot, { recursive: true, force: true }).catch(() => undefined);
    await cleanup();
  });

  const installPluginWithSkill = () =>
    app.inject({
      method: "POST",
      url: "/v1/plugins",
      payload: {
        id: "flashcards",
        publisher: "aervox",
        version: "1.0.0",
        tools: [{ name: "review_card", description: "复习卡片", category: "learning" }],
        skills: [
          {
            name: "flashcard-review",
            description: "插件内置复习技能",
            content: "---\nname: flashcard-review\ndescription: 插件内置\n---\n# 复习\n\n按卡复习。",
          },
        ],
      },
    });

  it("安装插件：技能只读注册 + pluginId 关联 + 内容落盘与可读", async () => {
    const res = await installPluginWithSkill();
    expect(res.statusCode).toBe(201);

    const skill = await app.inject({ method: "GET", url: "/v1/skills/flashcard-review" });
    expect(skill.statusCode).toBe(200);
    expect(skill.json().source).toBe("plugin");
    expect(skill.json().readonly).toBe(1);
    expect(skill.json().pluginId).toBe("flashcards");

    const content = await app.inject({ method: "GET", url: "/v1/skills/flashcard-review/content" });
    expect(content.json().content).toContain("按卡复习");

    // 内容落盘在 <skillsRoot>/<pluginId>/<skillName>/
    const onDisk = await fs.readFile(path.join(skillsRoot, "flashcards", "flashcard-review", "SKILL.md"), "utf8");
    expect(onDisk).toContain("按卡复习");
  });

  it("插件技能只读：skill 管理接口删除被拒（409）", async () => {
    await installPluginWithSkill();
    const del = await app.inject({ method: "DELETE", url: "/v1/skills/flashcard-review" });
    expect(del.statusCode).toBe(409);
  });

  it("插件启停联动技能 active；卸载后技能移除且文件清理", async () => {
    await installPluginWithSkill();

    // 停用插件 → 技能 inactive
    const disable = await app.inject({
      method: "PATCH",
      url: "/v1/plugins/flashcards",
      payload: { enabled: false },
    });
    expect(disable.statusCode).toBe(200);
    const activeOnly = await app.inject({ method: "GET", url: "/v1/skills?activeOnly=true" });
    expect(activeOnly.json().items.filter((s: { pluginId?: string }) => s.pluginId === "flashcards").length).toBe(0);

    // 重新启用 → 技能 active
    await app.inject({ method: "PATCH", url: "/v1/plugins/flashcards", payload: { enabled: true } });
    const activeAgain = await app.inject({ method: "GET", url: "/v1/skills?activeOnly=true" });
    expect(activeAgain.json().items.some((s: { id: string }) => s.id === "flashcard-review")).toBe(true);

    // 卸载插件 → 技能移除 + 文件清理
    const uninstall = await app.inject({ method: "DELETE", url: "/v1/plugins/flashcards" });
    expect(uninstall.statusCode).toBe(204);
    const missing = await app.inject({ method: "GET", url: "/v1/skills/flashcard-review" });
    expect(missing.statusCode).toBe(404);
    await expect(
      fs.access(path.join(skillsRoot, "flashcards")),
    ).rejects.toBeTruthy();
  });
});
