import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteExtensionRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("PRD §8 P2/P3：内容/生态扩展域", () => {
  let db: AervoxDatabase;
  let client: Client;
  let ext: SqliteExtensionRepository;

  const tenant: TenantContext = { workspaceId: "ws_p23", subjectUserId: "usr_p23" };
  const otherTenant: TenantContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    ext = new SqliteExtensionRepository(db);
  });

  it("外部来源：创建 + 查询 + 租户隔离", async () => {
    const src = await ext.createExternalSource(tenant, {
      id: "es_1",
      provider: "题库A",
      externalId: "ext_1",
      permissionScope: "read",
    });
    expect(src.syncState).toBe("idle");
    expect((await ext.getExternalSource(tenant, "es_1"))?.provider).toBe("题库A");
    expect(await ext.getExternalSource(otherTenant, "es_1")).toBeNull();
  });

  it("插件：创建（系统级）+ 授权/撤销/权限校验", async () => {
    const plugin = await ext.createPlugin({
      id: "flashcards",
      publisher: "aervox",
      version: "1.0.0",
      checksum: "abc",
      permissions: ["review:read"],
    });
    expect(plugin.enabled).toBe(1);
    expect(await ext.listPlugins()).toHaveLength(1);

    const grant = await ext.grantPlugin(tenant, { id: "pg_1", pluginId: plugin.id, permission: "review:read", scope: "daily" });
    expect(grant.permission).toBe("review:read");
    expect(await ext.hasPluginPermission(tenant, "flashcards", "review:read")).toBe(true);

    await ext.revokePluginGrant(tenant, "pg_1");
    expect(await ext.hasPluginPermission(tenant, "flashcards", "review:read")).toBe(false);
  });

  it("社区内容 + 机构：创建 + 查询 + 租户隔离", async () => {
    const content = await ext.createCommunityContent(tenant, {
      id: "cc_1",
      authorId: "usr_p23",
      type: "knowledge_card",
    });
    expect(content.reviewState).toBe("pending");
    expect((await ext.getCommunityContent(tenant, "cc_1"))?.visibility).toBe("public");
    expect(await ext.getCommunityContent(otherTenant, "cc_1")).toBeNull();

    const org = await ext.createOrganization(tenant, { id: "org_1", ownerId: "usr_p23", policyVersion: "v1" });
    expect(org.memberScope).toBe("institution");
    expect(await ext.getOrganization(otherTenant, "org_1")).toBeNull();
  });
});
