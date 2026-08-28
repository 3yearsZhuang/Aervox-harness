import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_cap019",
  "x-user-id": "usr_cap019",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_cap019_other",
  "x-user-id": "usr_cap019_other",
} as const;

async function createPersona(
  app: FastifyInstance,
  hdrs: Record<string, string>,
  name: string,
  promptAppend = "Be helpful",
): Promise<{ personaId: string; revisionId: string; revision: number }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/personas",
    headers: hdrs,
    payload: {
      name,
      description: `Persona: ${name}`,
      config: { systemPromptAppend: promptAppend },
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return {
    personaId: body.persona.id,
    revisionId: body.revision.id,
    revision: body.revision.revision,
  };
}

describe("CAP-019: 多人格模板 — 审核、切换、回滚、记忆隔离/共享", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let skillsRoot: string;

  beforeEach(async () => {
    skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cap019-test-"));
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

  // ---- 模板审核 ----

  it("创建人格默认为 draft 审核状态", async () => {
    const { personaId } = await createPersona(app, headers, "Tutor");
    const res = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().persona.reviewStatus).toBe("draft");
    expect(res.json().persona.reviewNotes).toBe("");
    expect(res.json().persona.reviewedAt).toBeNull();
  });

  it("提交审核：draft → pending_review → approved", async () => {
    const { personaId } = await createPersona(app, headers, "Guide");

    // 提交审核
    const submit = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/review`,
      headers,
      payload: { reviewStatus: "pending_review" },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().reviewStatus).toBe("pending_review");
    expect(submit.json().reviewedAt).toBeTruthy();

    // 审核通过
    const approve = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/review`,
      headers,
      payload: { reviewStatus: "approved", reviewNotes: "内容安全、边界清晰" },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().reviewStatus).toBe("approved");
    expect(approve.json().reviewNotes).toBe("内容安全、边界清晰");
  });

  it("审核拒绝：rejected + 拒绝理由", async () => {
    const { personaId } = await createPersona(app, headers, "Bad");

    const reject = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/review`,
      headers,
      payload: { reviewStatus: "rejected", reviewNotes: "提示词越界" },
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().reviewStatus).toBe("rejected");
    expect(reject.json().reviewNotes).toBe("提示词越界");
  });

  it("审核不存在的人格返回 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/personas/nonexistent/review",
      headers,
      payload: { reviewStatus: "approved" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- 修订列表与回滚 ----

  it("列出人格所有修订并回滚到旧修订", async () => {
    const { personaId } = await createPersona(app, headers, "Scholar", "v1 prompt");

    // 更新人格生成第二个修订
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/personas/${personaId}`,
      headers,
      payload: { expectedRevision: 1, config: { systemPromptAppend: "v2 prompt" } },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().revision.revision).toBe(2);

    // 列出所有修订
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}/revisions`,
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().revisions).toHaveLength(2);
    expect(listRes.json().revisions[0].revision).toBe(2); // 最新在前
    expect(listRes.json().revisions[1].revision).toBe(1);

    // 回滚到修订 1
    const oldRevisionId = listRes.json().revisions[1].id;
    const rollback = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/rollback`,
      headers,
      payload: { revisionId: oldRevisionId, regressionNotes: "v2 效果不佳" },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json().persona.currentRevisionId).toBe(oldRevisionId);
    expect(rollback.json().revision.revision).toBe(1);
    expect(rollback.json().revision.config.systemPromptAppend).toBe("v1 prompt");
  });

  it("回滚到不存在的修订返回 404", async () => {
    const { personaId } = await createPersona(app, headers, "Test");
    const res = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/rollback`,
      headers,
      payload: { revisionId: "nonexistent_rev" },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- 切换历史 ----

  it("切换人格记录切换历史", async () => {
    const p1 = await createPersona(app, headers, "Tutor", "Be a tutor");
    const p2 = await createPersona(app, headers, "Companion", "Be a companion");

    // 激活第一个
    await app.inject({
      method: "POST",
      url: `/v1/personas/${p1.personaId}/activate`,
      headers,
      payload: {},
    });

    // 切换到第二个
    await app.inject({
      method: "POST",
      url: `/v1/personas/${p2.personaId}/activate`,
      headers,
      payload: {},
    });

    // 获取全部切换历史
    const historyRes = await app.inject({
      method: "GET",
      url: "/v1/personas/switch-history",
      headers,
    });
    expect(historyRes.statusCode).toBe(200);
    const history = historyRes.json().history;
    expect(history.length).toBeGreaterThanOrEqual(2);

    // 最新一条应为切换到 p2
    const latest = history[0];
    expect(latest.personaId).toBe(p2.personaId);
    expect(latest.previousPersonaId).toBe(p1.personaId);
    expect(latest.switchReason).toBe("user_initiated");

    // 按特定人格查询
    const p1History = await app.inject({
      method: "GET",
      url: `/v1/personas/${p1.personaId}/switch-history`,
      headers,
    });
    expect(p1History.statusCode).toBe(200);
    expect(p1History.json().history.every((h: { personaId: string }) => h.personaId === p1.personaId)).toBe(true);
  });

  it("回滚也记录在切换历史中", async () => {
    const { personaId } = await createPersona(app, headers, "Rollback", "v1");

    // 更新
    const update = await app.inject({
      method: "PATCH",
      url: `/v1/personas/${personaId}`,
      headers,
      payload: { expectedRevision: 1, config: { systemPromptAppend: "v2" } },
    });

    // 激活
    await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/activate`,
      headers,
      payload: {},
    });

    // 回滚
    await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/rollback`,
      headers,
      payload: { revisionId: update.json().revision.id === undefined ? "" : "", regressionNotes: "测试回滚" },
    }).catch(() => undefined);

    // 获取修订列表
    const revList = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}/revisions`,
      headers,
    });
    const oldRevId = revList.json().revisions[1].id;

    // 正式回滚
    const rollback = await app.inject({
      method: "POST",
      url: `/v1/personas/${personaId}/rollback`,
      headers,
      payload: { revisionId: oldRevId, regressionNotes: "测试回滚" },
    });
    expect(rollback.statusCode).toBe(200);

    // 验证切换历史包含 rollback
    const history = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}/switch-history`,
      headers,
    });
    const rollbackEntry = history.json().history.find(
      (h: { switchReason: string }) => h.switchReason === "rollback",
    );
    expect(rollbackEntry).toBeTruthy();
    expect(rollbackEntry.regressionNotes).toBe("测试回滚");
  });

  // ---- 记忆隔离/共享 ----

  it("记忆范围默认为隔离", async () => {
    const { personaId } = await createPersona(app, headers, "Isolated");

    const scopeRes = await app.inject({
      method: "GET",
      url: `/v1/personas/${personaId}/memory-scope`,
      headers,
    });
    expect(scopeRes.statusCode).toBe(200);
    expect(scopeRes.json().memoryPolicy).toBe("isolated");
    expect(scopeRes.json().sharedPersonaIds).toEqual([]);
    expect(scopeRes.json().sharedCategories).toEqual([]);
    expect(scopeRes.json().confirmedAt).toBeNull();
  });

  it("更新记忆范围为共享并确认", async () => {
    const p1 = await createPersona(app, headers, "Shared1");
    const p2 = await createPersona(app, headers, "Shared2");

    const updateRes = await app.inject({
      method: "PUT",
      url: `/v1/personas/${p1.personaId}/memory-scope`,
      headers,
      payload: {
        memoryPolicy: "shared",
        sharedPersonaIds: [p2.personaId],
        sharedCategories: ["learning", "preference"],
        confirmed: true,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().memoryPolicy).toBe("shared");
    expect(updateRes.json().sharedPersonaIds).toEqual([p2.personaId]);
    expect(updateRes.json().sharedCategories).toEqual(["learning", "preference"]);
    expect(updateRes.json().confirmedAt).toBeTruthy();
  });

  it("再次更新记忆范围保留已有数据", async () => {
    const p1 = await createPersona(app, headers, "UpdateScope");
    const p2 = await createPersona(app, headers, "OtherScope");

    // 初始设置
    await app.inject({
      method: "PUT",
      url: `/v1/personas/${p1.personaId}/memory-scope`,
      headers,
      payload: {
        memoryPolicy: "shared",
        sharedPersonaIds: [p2.personaId],
        sharedCategories: ["learning"],
        confirmed: true,
      },
    });

    // 更新
    const updateRes = await app.inject({
      method: "PUT",
      url: `/v1/personas/${p1.personaId}/memory-scope`,
      headers,
      payload: {
        memoryPolicy: "isolated",
        confirmed: false,
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().memoryPolicy).toBe("isolated");
    expect(updateRes.json().confirmedAt).toBeNull();
  });

  it("获取不存在人格的记忆范围返回 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/personas/nonexistent/memory-scope",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- 租户隔离 ----

  it("切换历史按租户隔离", async () => {
    const p1 = await createPersona(app, headers, "TenantA");
    const p2 = await createPersona(app, otherHeaders, "TenantB");

    await app.inject({
      method: "POST",
      url: `/v1/personas/${p1.personaId}/activate`,
      headers,
      payload: {},
    });

    await app.inject({
      method: "POST",
      url: `/v1/personas/${p2.personaId}/activate`,
      headers: otherHeaders,
      payload: {},
    });

    const historyA = await app.inject({
      method: "GET",
      url: "/v1/personas/switch-history",
      headers,
    });
    const historyB = await app.inject({
      method: "GET",
      url: "/v1/personas/switch-history",
      headers: otherHeaders,
    });

    // 各租户只能看到自己的切换记录
    expect(historyA.json().history.every((h: { personaId: string }) => h.personaId === p1.personaId)).toBe(true);
    expect(historyB.json().history.every((h: { personaId: string }) => h.personaId === p2.personaId)).toBe(true);
  });

  it("审核状态按租户隔离", async () => {
    const p1 = await createPersona(app, headers, "ReviewA");

    // 租户 A 审核
    await app.inject({
      method: "POST",
      url: `/v1/personas/${p1.personaId}/review`,
      headers,
      payload: { reviewStatus: "approved", reviewNotes: "approved by A" },
    });

    // 租户 B 无法看到 p1
    const crossTenant = await app.inject({
      method: "GET",
      url: `/v1/personas/${p1.personaId}`,
      headers: otherHeaders,
    });
    expect(crossTenant.statusCode).toBe(404);
  });

  it("记忆范围按租户隔离", async () => {
    const p1 = await createPersona(app, headers, "MemScopeA");

    await app.inject({
      method: "PUT",
      url: `/v1/personas/${p1.personaId}/memory-scope`,
      headers,
      payload: {
        memoryPolicy: "shared",
        sharedCategories: ["diary"],
        confirmed: true,
      },
    });

    // 租户 B 无法访问
    const crossRes = await app.inject({
      method: "GET",
      url: `/v1/personas/${p1.personaId}/memory-scope`,
      headers: otherHeaders,
    });
    expect(crossRes.statusCode).toBe(404);
  });

  // ---- 共享安全边界验证 ----

  it("人格切换仅影响表达，安全边界不变", async () => {
    const p1 = await createPersona(app, headers, "TutorPersona", "You are a tutor");
    const p2 = await createPersona(app, headers, "CompanionPersona", "You are a companion");

    // 激活 p1
    await app.inject({
      method: "POST",
      url: `/v1/personas/${p1.personaId}/activate`,
      headers,
      payload: {},
    });

    // 切换到 p2
    const switchRes = await app.inject({
      method: "POST",
      url: `/v1/personas/${p2.personaId}/activate`,
      headers,
      payload: {},
    });
    expect(switchRes.statusCode).toBe(200);

    // 验证当前激活为 p2
    const list = await app.inject({ method: "GET", url: "/v1/personas", headers });
    expect(list.json().active.personaId).toBe(p2.personaId);

    // 两个人格的修订配置都不包含安全策略覆盖
    const p1Detail = await app.inject({
      method: "GET",
      url: `/v1/personas/${p1.personaId}`,
      headers,
    });
    const p2Detail = await app.inject({
      method: "GET",
      url: `/v1/personas/${p2.personaId}`,
      headers,
    });

    // 人格配置仅包含 systemPromptAppend, allowedSkillNames, allowedMcpToolIds, voice
    // 不包含安全策略覆盖字段
    const p1Config = p1Detail.json().revision.config;
    const p2Config = p2Detail.json().revision.config;
    expect(p1Config.systemPromptAppend).toBe("You are a tutor");
    expect(p2Config.systemPromptAppend).toBe("You are a companion");
    // 确保没有安全覆盖字段
    expect(p1Config).not.toHaveProperty("safetyPolicyOverride");
    expect(p2Config).not.toHaveProperty("safetyPolicyOverride");
  });
});
