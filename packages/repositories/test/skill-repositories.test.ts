import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteSkillRegistryRepository,
  SqliteSkillLifecycleRepository,
  type AervoxDatabase,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CAP-020: Skill 注册表仓储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteSkillRegistryRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteSkillRegistryRepository(db);
  });

  it("注册技能：幂等覆盖元数据，active/readonly 保持既有状态", async () => {
    const created = await repo.registerSkill({
      id: "review-notes",
      name: "review-notes",
      description: "整理复习笔记",
      source: "local",
      active: true,
    });
    expect(created.active).toBe(1);
    expect(created.readonly).toBe(0);

    // 幂等：覆盖描述，active=false 不覆盖既有 true
    const updated = await repo.registerSkill({
      id: "review-notes",
      name: "review-notes",
      description: "整理复习笔记（v2）",
      source: "local",
      active: false,
    });
    expect(updated.description).toBe("整理复习笔记（v2）");
    expect(updated.active).toBe(1);
  });

  it("listSkills(activeOnly) 只返回启用技能；setActive 切换启停", async () => {
    await repo.registerSkill({ id: "a", name: "a", description: "A" });
    await repo.registerSkill({ id: "b", name: "b", description: "B" });
    await repo.setActive("b", false);

    const all = await repo.listSkills();
    expect(all.length).toBe(2);
    const active = await repo.listSkills(true);
    expect(active.map((s) => s.id)).toEqual(["a"]);
  });

  it("unregisterSkill：readonly 技能拒绝注销，普通技能可注销", async () => {
    await repo.registerSkill({
      id: "plugin-skill",
      name: "plugin-skill",
      description: "插件内置",
      source: "plugin",
      readonly: true,
    });
    expect(await repo.unregisterSkill("plugin-skill")).toBe(false);

    await repo.registerSkill({ id: "local-skill", name: "local-skill", description: "本地" });
    expect(await repo.unregisterSkill("local-skill")).toBe(true);
    expect(await repo.getSkill("local-skill")).toBeNull();
  });

  it("touchSkill 更新 lastUsedAt；exportSkills 按 active + 门控过滤", async () => {
    await repo.registerSkill({ id: "gated", name: "gated", description: "门控技能", gatingConditions: [{ field: "purpose", operator: "equals", value: "study" }] });
    await repo.registerSkill({ id: "plain", name: "plain", description: "无门控" });

    const before = await repo.getSkill("plain");
    await repo.touchSkill("plain");
    const after = await repo.getSkill("plain");
    expect(after?.lastUsedAt).toBeTruthy();
    expect(before?.lastUsedAt).not.toBe(after?.lastUsedAt);

    // 门控 evaluator 拒绝 → 声明了门控条件的技能被排除，无门控技能保留
    const exportAll = await repo.exportSkills();
    expect(exportAll.length).toBe(2);

    const denied = await repo.exportSkills({
      gatingEvaluator: () => false,
    });
    expect(denied.map((s) => s.id)).toEqual(["plain"]);
  });
});

describe("CAP-020: Skill Neo 生命周期仓储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteSkillLifecycleRepository;

  const evidence = { turnIds: ["turn_1"], memoryIds: ["mem_1"], learningItemIds: [] };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteSkillLifecycleRepository(db);
  });

  it("createPayload：幂等覆盖内容，checksum 同步", async () => {
    const p1 = await repo.createPayload({
      payloadRef: "p_1",
      content: { skill_markdown: "# v1" },
      checksum: "sha256:1",
    });
    expect(p1.kind).toBe("aervox_skill_v1");
    expect(p1.content).toEqual({ skill_markdown: "# v1" });

    const p2 = await repo.createPayload({
      payloadRef: "p_1",
      content: { skill_markdown: "# v2" },
      checksum: "sha256:2",
    });
    expect(p2.content).toEqual({ skill_markdown: "# v2" });
    expect(p2.checksum).toBe("sha256:2");
  });

  it("createCandidate：幂等返回既有；状态机可推进 pending → evaluated → promoted", async () => {
    const c1 = await repo.createCandidate({
      candidateId: "c_1",
      skillKey: "review-notes",
      sourceEvidence: evidence,
    });
    expect(c1.status).toBe("pending");

    const c2 = await repo.createCandidate({
      candidateId: "c_1",
      skillKey: "review-notes",
      sourceEvidence: evidence,
    });
    expect(c2.candidateId).toBe(c1.candidateId);
    expect(c2.status).toBe("pending"); // 未重复创建/覆盖

    await repo.updateCandidateStatus("c_1", "evaluated");
    const listed = await repo.listCandidates({ skillKey: "review-notes", status: "evaluated" });
    expect(listed.length).toBe(1);

    await repo.updateCandidateStatus("c_1", "promoted");
    expect((await repo.getCandidate("c_1"))?.status).toBe("promoted");
  });

  it("createRelease：幂等 + 同 key+stage 自动取消旧 active + 版本唯一", async () => {
    await repo.createCandidate({ candidateId: "c_1", skillKey: "k", sourceEvidence: evidence });
    await repo.createCandidate({ candidateId: "c_2", skillKey: "k", sourceEvidence: evidence });

    const r1 = await repo.createRelease({
      releaseId: "r_1",
      skillKey: "k",
      stage: "canary",
      candidateId: "c_1",
      version: 1,
    });
    expect(r1.active).toBe(1);

    const r2 = await repo.createRelease({
      releaseId: "r_2",
      skillKey: "k",
      stage: "canary",
      candidateId: "c_2",
      version: 2,
    });
    expect(r2.active).toBe(1);
    // 旧 active 被自动取消
    expect((await repo.getRelease("r_1"))?.active).toBe(0);

    // 幂等：同 skillKey+stage+version 返回既有
    const dup = await repo.createRelease({
      releaseId: "r_dup",
      skillKey: "k",
      stage: "canary",
      candidateId: "c_2",
      version: 2,
    });
    expect(dup.releaseId).toBe("r_2");
  });

  it("markSyncedToLocal 与 deactivateRelease 状态流转", async () => {
    await repo.createCandidate({ candidateId: "c_1", skillKey: "k", sourceEvidence: evidence });
    const rel = await repo.createRelease({
      releaseId: "r_1",
      skillKey: "k",
      stage: "stable",
      candidateId: "c_1",
      version: 1,
    });
    expect(rel.syncedToLocal).toBe(0);

    const synced = await repo.markSyncedToLocal("r_1");
    expect(synced?.syncedToLocal).toBe(1);

    const deactivated = await repo.deactivateRelease("r_1");
    expect(deactivated?.active).toBe(0);
    expect((await repo.listReleases({ activeOnly: true })).length).toBe(0);
  });
});
