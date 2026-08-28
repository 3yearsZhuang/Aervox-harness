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
  SqliteVoiceInputConfigRepository,
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

describe("语音输入 (ASR) 配置仓储 (CR-016)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let inputRepo: SqliteVoiceInputConfigRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    inputRepo = new SqliteVoiceInputConfigRepository(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("初始状态读取返回 null", async () => {
    expect(await inputRepo.getConfig(tenantA)).toBeNull();
  });

  it("保存 ASR 配置并正确回显", async () => {
    const saved = await inputRepo.saveConfig(tenantA, {
      enabled: true,
      engineType: "sensevoice-local",
      modelPath: "/opt/sensevoice",
      modelId: "sensevoice-small",
      autoStopOnKeyboard: true,
      vadSilenceThresholdMs: 650,
      settings: { language: "auto" },
    });

    expect(saved.enabled).toBe(1);
    expect(saved.engineType).toBe("sensevoice-local");
    expect(saved.modelPath).toBe("/opt/sensevoice");
    expect(saved.modelId).toBe("sensevoice-small");
    expect(saved.autoStopOnKeyboard).toBe(1);
    expect(saved.vadSilenceThresholdMs).toBe(650);
    expect(saved.settingsJson).toEqual({ language: "auto" });

    const read = await inputRepo.getConfig(tenantA);
    expect(read).toEqual(saved);
  });

  it("支持 whisper-compatible 模式且租户隔离", async () => {
    await inputRepo.saveConfig(tenantA, {
      enabled: true,
      engineType: "whisper-compatible",
      endpoint: "http://127.0.0.1:8000/v1",
      apiKey: "sk-whisper",
      modelId: "whisper-1",
    });

    await inputRepo.saveConfig(tenantB, {
      enabled: false,
      engineType: "sensevoice-local",
      modelId: "sensevoice-small",
    });

    const configA = await inputRepo.getConfig(tenantA);
    const configB = await inputRepo.getConfig(tenantB);

    expect(configA?.engineType).toBe("whisper-compatible");
    expect(configA?.apiKey).toBe("sk-whisper");
    expect(configB?.engineType).toBe("sensevoice-local");
    expect(configB?.enabled).toBe(0);
  });
});