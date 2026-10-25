/**
 * Aervox｜思隅 @aervox/repositories — 插件 Config / Page 仓储测试（CR-006）
 *
 * 覆盖：本地上下文共享、revision CAS、reset、secret 状态、Page 元数据幂等、卸载清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqlitePluginConfigRepository,
  SqliteExtensionRepository,
  SqlitePluginPageRepository,
  SqlitePluginSecretRepository,
  DomainConflictError,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: LocalContext = { workspaceId: "ws_a", subjectUserId: "usr_a" };
const tenantB: LocalContext = { workspaceId: "ws_b", subjectUserId: "usr_b" };
const fields = [{ key: "a", type: "integer", label: "A" }, { key: "value", type: "integer", label: "Value" },
  { key: "enabled", type: "boolean", label: "Enabled" }, { key: "endpoint", type: "string", label: "Endpoint" },
  { key: "apiKey", type: "secret", label: "API key" }];

describe("插件 Config / Page 仓储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let configRepo: SqlitePluginConfigRepository;
  let secretRepo: SqlitePluginSecretRepository;
  let pageRepo: SqlitePluginPageRepository;
  const generations = new Map<string, string>();

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    await initDatabaseSchema(client);
    configRepo = new SqlitePluginConfigRepository(db);
    secretRepo = new SqlitePluginSecretRepository(db);
    pageRepo = new SqlitePluginPageRepository(db);
    const extensions = new SqliteExtensionRepository(db);
    generations.clear();
    for (const id of ["demo", "cas"]) {
      const plugin = await extensions.createPlugin({ id, publisher: "test", version: "1", checksum: "fixture", configSchemaJson: fields });
      generations.set(id, plugin.lifecycleGeneration);
    }
  });

  afterEach(async () => {
    await cleanup();
  });

  it("保存/读取配置并由本地上下文共享", async () => {
    const saved = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedSchema: fields, expectedLifecycleGeneration: generations.get("demo")!,
      expectedRevision: 0,
      values: { enabled: true, endpoint: "https://example.test" },
      secretKeys: [],
    });
    expect(saved.conflict).toBe(false);
    expect(saved.saved?.revision).toBe(1);

    const readA = await configRepo.getConfig(tenantA, "demo");
    expect(readA?.valuesJson).toMatchObject({ enabled: true });
    expect(await configRepo.getConfig(tenantB, "demo")).not.toBeNull();
  });

  it("revision CAS：旧 revision 保存返回冲突", async () => {
    await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedSchema: fields, expectedLifecycleGeneration: generations.get("demo")!,
      expectedRevision: 0,
      values: { a: 1 },
      secretKeys: [],
    });
    const second = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedSchema: fields, expectedLifecycleGeneration: generations.get("demo")!,
      expectedRevision: 1,
      values: { a: 2 },
      secretKeys: [],
    });
    expect(second.conflict).toBe(false);
    expect(second.saved?.revision).toBe(2);

    const stale = await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedSchema: fields, expectedLifecycleGeneration: generations.get("demo")!,
      expectedRevision: 1,
      values: { a: 3 },
      secretKeys: [],
    });
    expect(stale.conflict).toBe(true);
    expect(stale.saved?.valuesJson).toMatchObject({ a: 2 });
  });

  it("reset 配置并保留本地共享语义", async () => {
    await configRepo.saveConfig(tenantA, {
      pluginId: "demo",
      schemaVersion: 1,
      expectedSchema: fields, expectedLifecycleGeneration: generations.get("demo")!,
      expectedRevision: 0,
      values: { a: 1 },
      secretKeys: [],
    });
    const reset = await configRepo.resetConfig(tenantA, "demo", 1, { a: 0 }, fields, generations.get("demo")!, 1);
    expect(reset.valuesJson).toMatchObject({ a: 0 });
    expect(reset.revision).toBe(2);
    expect(await configRepo.getConfig(tenantB, "demo")).not.toBeNull();
  });

  it("首次保存也检查 revision；同 revision 的并发写最多一个成功", async () => {
    const input = { pluginId: "cas", schemaVersion: 1, expectedSchema: fields, expectedLifecycleGeneration: generations.get("cas")!, expectedRevision: 9, values: {}, secretKeys: [] };
    expect(await configRepo.saveConfig(tenantA, input)).toEqual({ saved: null, conflict: true });
    expect(await configRepo.getConfig(tenantA, "cas")).toBeNull();
    const create = await Promise.all([1, 2].map((value) =>
      configRepo.saveConfig(tenantA, { ...input, expectedRevision: 0, values: { value } }),
    ));
    expect(create.filter((result) => !result.conflict)).toHaveLength(1);
    const update = await Promise.all([3, 4].map((value) =>
      configRepo.saveConfig(tenantA, { ...input, expectedRevision: 1, values: { value } }),
    ));
    expect(update.filter((result) => !result.conflict)).toHaveLength(1);
    expect((await configRepo.getConfig(tenantA, "cas"))?.revision).toBe(2);
  });

  it("secret 只暴露状态，值不可读", async () => {
    await secretRepo.put(tenantA, { pluginId: "demo", fieldKey: "apiKey", value: "s3cret" });
    expect(await secretRepo.getState(tenantA, "demo", "apiKey")).toEqual({ configured: true });
    expect(await secretRepo.getState(tenantB, "demo", "apiKey")).toEqual({ configured: true });
    await secretRepo.delete(tenantA, "demo", "apiKey");
    expect(await secretRepo.getState(tenantA, "demo", "apiKey")).toEqual({ configured: false });
  });

  it("Page 元数据 upsert 保持唯一并使每次登记成为新实例，卸载清理全部 Page", async () => {
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
    expect(updated.id).not.toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);

    expect(await pageRepo.listPages("demo")).toHaveLength(1);
    await pageRepo.deletePagesForPlugin("demo");
    expect(await pageRepo.listPages("demo")).toHaveLength(0);
  });

  it("同声明重登记与资源校验和更新持久旋转 Page 实例身份", async () => {
    const input = { pluginId: "demo", pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["config.write"] };
    const original = await pageRepo.upsertPage(input);
    const registered = await pageRepo.upsertPage(input);
    const assets = await pageRepo.upsertPage({ ...input, checksum: "new-assets" });
    expect(new Set([original.id, registered.id, assets.id]).size).toBe(3);
    expect(await new SqlitePluginPageRepository(db).getPage("demo", "settings")).toMatchObject({ id: assets.id, checksum: "new-assets" });
    expect(await pageRepo.listPages("demo", generations.get("demo")!)).toHaveLength(1);
  });

  it("独立仓储并发登记同 Page 都原子完成且仅保留一个持久实例", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map(version => new SqlitePluginPageRepository(db).upsertPage({
      pluginId: "demo", pageId: "settings", title: `Settings ${version}`, entry: "pages/settings/index.html", capabilities: ["config.write"],
    })));
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const saved = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    expect(new Set(saved.map(page => page.id)).size).toBe(4);
    const persisted = await pageRepo.listPages("demo", generations.get("demo")!);
    expect(persisted).toHaveLength(1);
    expect(saved.map(page => page.id)).toContain(persisted[0]!.id);
  });

  it("资源校验和更新仅针对捕获的 Page 实例并保留全部声明", async () => {
    const original = await pageRepo.upsertPage({
      pluginId: "demo", pageId: "settings", title: {zh: "设置"}, description: "Keep this declaration",
      entry: "pages/settings/nested/index.html", capabilities: ["config.read", "config.write"], checksum: "old-assets",
    });
    const updated = await pageRepo.updatePageChecksum("demo", "settings", original.id, "new-assets");
    expect(updated).not.toBeNull();
    expect(updated!.id).not.toBe(original.id);
    expect(updated).toMatchObject({
      pluginId: original.pluginId, pageId: original.pageId, title: original.title, description: original.description,
      entry: original.entry, capabilitiesJson: original.capabilitiesJson, checksum: "new-assets", createdAt: original.createdAt,
    });
    expect(await pageRepo.updatePageChecksum("demo", "settings", original.id, "stale-assets")).toBeNull();
    expect(await pageRepo.getPage("demo", "settings")).toEqual(updated);
  });

  it.each(["revoked", "deleted", "recreated"] as const)("资源写者读取后 Page %s 不覆盖新声明或重建已删除 Page", async transition => {
    const input = {pluginId: "demo", pageId: "settings", title: "Old", entry: "pages/settings/index.html", capabilities: ["config.write"], checksum: "old-assets"};
    const original = await pageRepo.upsertPage(input);
    if (transition === "deleted" || transition === "recreated") await pageRepo.deletePagesForPlugin("demo");
    if (transition !== "deleted") await pageRepo.upsertPage({
      ...input, title: "New", entry: "pages/settings/replaced.html", capabilities: [], checksum: "current-assets",
    });
    const current = await new SqlitePluginPageRepository(db).getPage("demo", "settings");
    const updated = await pageRepo.updatePageChecksum("demo", "settings", original.id, "late-assets");
    expect(updated).toBeNull();
    expect(await pageRepo.getPage("demo", "settings")).toEqual(current);
    expect((await new SqliteExtensionRepository(db).getPlugin("demo"))!.lifecycleGeneration).toBe(generations.get("demo"));
  });

  it.each([undefined, null, "", "x".repeat(129)])("资源校验和更新拒绝缺失或非法 Page 代际 %j", async invalid => {
    const original = await pageRepo.upsertPage({pluginId: "demo", pageId: "settings", title: "Keep", entry: "pages/settings/index.html", capabilities: ["config.write"]});
    expect(await pageRepo.updatePageChecksum("demo", "settings", invalid as unknown as string, "late-assets")).toBeNull();
    expect(await pageRepo.getPage("demo", "settings")).toEqual(original);
  });

  it.each(["disabled", "reenabled", "missing", "restored", "uninstalled"] as const)("rejects Page grants from an expired lifecycle after %s", async transition => {
    const extension = new SqliteExtensionRepository(db);
    await pageRepo.upsertPage({ pluginId: "demo", pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["host.notify"] });
    const before = await pageRepo.listPages("demo", generations.get("demo")!);
    expect(before).toHaveLength(1);
    if (transition === "disabled" || transition === "reenabled") {
      await extension.setPluginEnabled("demo", false);
      if (transition === "reenabled") await extension.setPluginEnabled("demo", true);
    } else if (transition === "missing" || transition === "restored") {
      await extension.setPluginAvailability("demo", "missing");
      if (transition === "restored") await extension.setPluginAvailability("demo", "available");
    } else {
      await client.execute({ sql: "DELETE FROM plugins WHERE id = ?", args: ["demo"] });
    }
    await expect(pageRepo.listPages("demo", generations.get("demo")!)).rejects.toBeInstanceOf(DomainConflictError);
    const current = await extension.getPlugin("demo");
    if (current?.enabled === 1 && current.availability === "available") {
      expect(await pageRepo.listPages("demo", current.lifecycleGeneration)).toEqual(before);
    }
  });

  it("reads current Page capabilities and distinguishes an empty Page list from a stale lifecycle", async () => {
    const generation = generations.get("demo")!;
    expect(await pageRepo.listPages("demo", generation)).toEqual([]);
    await expect(pageRepo.listPages("demo", "")).rejects.toBeInstanceOf(DomainConflictError);
    await pageRepo.upsertPage({ pluginId: "demo", pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["host.notify"] });
    await pageRepo.upsertPage({ pluginId: "demo", pageId: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: [] });
    expect((await pageRepo.listPages("demo", generation))[0]?.capabilitiesJson).toEqual([]);
  });
});
