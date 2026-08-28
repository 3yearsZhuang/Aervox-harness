/**
 * Aervox｜思隅 @aervox/database — 语音输出配置仓储测试（CR-011 阶段 1 · 本地语音模型配置）
 *
 * 覆盖：空→save→get 回显、更新覆盖（upsert 每租户一行）、租户隔离。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteVoiceConfigRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: TenantContext = { workspaceId: "ws_a", subjectUserId: "usr_a" };
const tenantB: TenantContext = { workspaceId: "ws_b", subjectUserId: "usr_b" };

describe("语音输出配置仓储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let repo: SqliteVoiceConfigRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    repo = new SqliteVoiceConfigRepository(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("空配置返回 null", async () => {
    expect(await repo.getConfig(tenantA)).toBeNull();
  });

  it("save → get 回显，并按租户隔离", async () => {
    const saved = await repo.saveConfig(tenantA, {
      enabled: true,
      providerId: "gpt-sovits-local",
      modelPath: "/data/models/gpt-sovits",
      modelId: "gpt-sovits-v2",
      speakerId: "speaker-01",
      settings: { sampleRate: 24000 },
    });
    expect(saved.enabled).toBe(1);
    expect(saved.providerId).toBe("gpt-sovits-local");
    expect(saved.modelId).toBe("gpt-sovits-v2");

    const read = await repo.getConfig(tenantA);
    expect(read?.modelPath).toBe("/data/models/gpt-sovits");
    expect(read?.speakerId).toBe("speaker-01");
    expect(read?.settingsJson).toMatchObject({ sampleRate: 24000 });
    expect(await repo.getConfig(tenantB)).toBeNull();
  });

  it("更新覆盖并保持每租户一行", async () => {
    await repo.saveConfig(tenantA, {
      enabled: true,
      providerId: "gpt-sovits-local",
      modelPath: "/data/models/gpt-sovits",
      modelId: "v1",
    });
    await repo.saveConfig(tenantA, {
      enabled: false,
      providerId: "gpt-sovits-local",
      modelPath: "/data/models/gpt-sovits-v2",
      modelId: "v2",
      speakerId: "speaker-09",
    });
    const read = await repo.getConfig(tenantA);
    expect(read?.modelPath).toBe("/data/models/gpt-sovits-v2");
    expect(read?.modelId).toBe("v2");
    expect(read?.speakerId).toBe("speaker-09");
    expect(read?.enabled).toBe(0);
  });

  it("缺省字段可空：modelPath/speakerId/settings 未提供", async () => {
    await repo.saveConfig(tenantA, {
      enabled: true,
      providerId: "gpt-sovits-local",
      modelId: "gpt-sovits-v2",
    });
    const read = await repo.getConfig(tenantA);
    expect(read?.modelPath).toBeNull();
    expect(read?.speakerId).toBeNull();
    expect(read?.settingsJson).toEqual({});
  });

  it("跨租户保存互不覆盖", async () => {
    await repo.saveConfig(tenantA, { enabled: true, providerId: "gpt-sovits-local", modelId: "A" });
    await repo.saveConfig(tenantB, { enabled: true, providerId: "gpt-sovits-local", modelId: "B" });
    expect((await repo.getConfig(tenantA))?.modelId).toBe("A");
    expect((await repo.getConfig(tenantB))?.modelId).toBe("B");
  });
});