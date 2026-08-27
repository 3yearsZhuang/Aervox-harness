import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema, type AervoxDatabase } from "../src/index.js";
import { SqliteLLMConfigRepository } from "../src/repositories/sqlite/llm-config-repository.js";
import type { Client } from "@libsql/client";

describe("SqliteLLMConfigRepository (CR-012)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let repo: SqliteLLMConfigRepository;

  const tenantA = { workspaceId: "ws_test_a", subjectUserId: "usr_test_a" };
  const tenantB = { workspaceId: "ws_test_b", subjectUserId: "usr_test_b" };

  beforeEach(async () => {
    const initialized = await createInMemoryDatabase();
    db = initialized.db;
    client = initialized.client;
    cleanup = initialized.cleanup;
    await initDatabaseSchema(client);
    repo = new SqliteLLMConfigRepository(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("初始状态读取返回 null", async () => {
    const config = await repo.getConfig(tenantA);
    expect(config).toBeNull();
  });

  it("保存新配置并正确回显", async () => {
    const saved = await repo.saveConfig(tenantA, {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
      maxTokens: 4096,
      settings: { topP: 0.9 },
    });

    expect(saved).toBeDefined();
    expect(saved.workspaceId).toBe(tenantA.workspaceId);
    expect(saved.subjectUserId).toBe(tenantA.subjectUserId);
    expect(saved.enabled).toBe(1);
    expect(saved.providerType).toBe("ollama");
    expect(saved.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(saved.modelId).toBe("llama3.2");
    expect(saved.temperature).toBe(0.7);
    expect(saved.maxTokens).toBe(4096);
    expect(saved.settingsJson).toEqual({ topP: 0.9 });

    const retrieved = await repo.getConfig(tenantA);
    expect(retrieved).toEqual(saved);
  });

  it("多次保存对同一租户执行 upsert 覆盖", async () => {
    await repo.saveConfig(tenantA, {
      enabled: true,
      providerType: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "llama3.2",
      temperature: 0.7,
    });

    const updated = await repo.saveConfig(tenantA, {
      enabled: false,
      providerType: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-test-secret",
      modelId: "deepseek-chat",
      temperature: 0.5,
      maxTokens: 8192,
      settings: { stream: true },
    });

    expect(updated.enabled).toBe(0);
    expect(updated.providerType).toBe("deepseek");
    expect(updated.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(updated.apiKey).toBe("sk-test-secret");
    expect(updated.modelId).toBe("deepseek-chat");
    expect(updated.temperature).toBe(0.5);
    expect(updated.maxTokens).toBe(8192);

    const retrieved = await repo.getConfig(tenantA);
    expect(retrieved?.modelId).toBe("deepseek-chat");
  });

  it("不同租户配置严格隔离", async () => {
    await repo.saveConfig(tenantA, {
      enabled: true,
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-tenant-a",
      modelId: "gpt-4o",
      temperature: 0.8,
    });

    await repo.saveConfig(tenantB, {
      enabled: true,
      providerType: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-tenant-b",
      modelId: "claude-3-5-sonnet",
      temperature: 0.3,
    });

    const configA = await repo.getConfig(tenantA);
    const configB = await repo.getConfig(tenantB);

    expect(configA?.providerType).toBe("openai");
    expect(configA?.apiKey).toBe("sk-tenant-a");
    expect(configB?.providerType).toBe("anthropic");
    expect(configB?.apiKey).toBe("sk-tenant-b");
  });
});
