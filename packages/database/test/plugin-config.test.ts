/**
 * Aervox｜思隅 @aervox/database — 插件 Config / Page 仓储测试（CR-006）
 *
 * 覆盖：租户隔离、revision CAS、reset、secret 状态、Page 元数据幂等、卸载清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
  SqlitePluginSecretRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: TenantContext = { workspaceId: "ws_a", subjectUserId: "usr_a" };
const tenantB: TenantContext = { workspaceId: "ws_b", subjectUserId: "usr_b" };

describe("插件 Config / Page 仓储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let configRepo: SqlitePluginConfigRepository;
  let secretRepo: SqlitePluginSecretRepository;
  let pageRepo: SqlitePluginPageRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    configRepo = new SqlitePluginConfigRepository(db);
    secretRepo = new SqlitePluginSecretRepository(db);
    pageRepo = new SqlitePluginPageRepository(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it("保存/读取配置并按租户隔离", async () => {
    const saved = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedRevision: -1,
      values: { enabled: true, endpoint: "https://example.test" },
      secretKeys: [],
    });
    expect(saved.conflict).toBe(false);
    expect(saved.saved.revision).toBe(1);

    const readA = await configRepo.getConfig(tenantA, "demo");
    expect(readA?.valuesJson).toMatchObject({ enabled: true });
    expect(await configRepo.getConfig(tenantB, "demo")).toBeNull();
  });

  it("revision CAS：旧 revision 保存返回冲突", async () => {
    await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedRevision: -1,
      values: { a: 1 },
      secretKeys: [],
    });
    const second = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedRevision: 1,
      values: { a: 2 },
      secretKeys: [],
    });
    expect(second.conflict).toBe(false);
    expect(second.saved.revision).toBe(2);

    const stale = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedRevision: 1,
      values: { a: 3 },
      secretKeys: [],
    });
    expect(stale.conflict).toBe(true);
    expect(stale.saved.valuesJson).toMatchObject({ a: 2 });
  });

  it("reset 配置并保留租户边界", async () => {
    await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedRevision: -1,
      values: { a: 1 },
      secretKeys: [],
    });
    const reset = await configRepo.resetConfig(tenantA, "demo", 1, { a: 0 });
    expect(reset.valuesJson).toMatchObject({ a: 0 });
    expect(reset.revision).toBe(2);
    expect(await configRepo.getConfig(tenantB, "demo")).toBeNull();
  });

  it("secret 只暴露状态，值不可读", async () => {
    await secretRepo.put(tenantA, { pluginId: "demo", fieldKey: "apiKey", value: "s3cret" });
    expect(await secretRepo.getState(tenantA, "demo", "apiKey")).toEqual({ configured: true });
    expect(await secretRepo.getState(tenantB, "demo", "apiKey")).toEqual({ configured: false });
    await secretRepo.delete(tenantA, "demo", "apiKey");
    expect(await secretRepo.getState(tenantA, "demo", "apiKey")).toEqual({ configured: false });
  });

  it("Page 元数据幂等 upsert + 卸载清理", async () => {
    const created = await pageRepo.upsertPage({
      pluginId: "demo",
      pageId: "dashboard",
      title: "面板",
      entry: "pages/dashboard/index.html",
      capabilities: ["config.read"],
    });
    expect(created.pageId).toBe("dashboard");

    const updated = await pageRepo.upsertPage({
      pluginId: "demo",
      pageId: "dashboard",
      title: "面板 v2",
      entry: "pages/dashboard/index.html",
      capabilities: ["config.read", "host.notify"],
    });
    expect(updated.title).toBe("面板 v2");

    expect(await pageRepo.listPages("demo")).toHaveLength(1);
    await pageRepo.deletePagesForPlugin("demo");
    expect(await pageRepo.listPages("demo")).toHaveLength(0);
  });
});
