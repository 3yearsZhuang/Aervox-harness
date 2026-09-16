import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteExtensionRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("PRD §8 P2/P3：内容/生态扩展域", () => {
  let db: AervoxDatabase;
  let client: Client;
  let ext: SqliteExtensionRepository;

  const ctx: LocalContext = { workspaceId: "ws_p23", subjectUserId: "usr_p23" };
  const otherTenant: LocalContext = { workspaceId: "ws_other", subjectUserId: "usr_other" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    ext = new SqliteExtensionRepository(db);
  });

  it("外部来源：创建 + 查询 + 本地上下文共享", async () => {
    const src = await ext.createExternalSource(ctx, {
      id: "es_1",
      provider: "题库A",
      externalId: "ext_1",
      permissionScope: "read",
    });
    expect(src.syncState).toBe("idle");
    expect((await ext.getExternalSource(ctx, "es_1"))?.provider).toBe("题库A");
    expect(await ext.getExternalSource(otherTenant, "es_1")).not.toBeNull();
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

    const grant = await ext.grantPlugin(ctx, { id: "pg_1", pluginId: plugin.id, permission: "review:read", scope: "daily" });
    expect(grant.permission).toBe("review:read");
    expect(await ext.hasPluginPermission(ctx, "flashcards", "review:read")).toBe(true);

    await ext.revokePluginGrant(ctx, "pg_1");
    expect(await ext.hasPluginPermission(ctx, "flashcards", "review:read")).toBe(false);
  });

  it("社区内容 + 机构：创建 + 查询 + 本地上下文共享", async () => {
    const content = await ext.createCommunityContent(ctx, {
      id: "cc_1",
      authorId: "usr_p23",
      type: "knowledge_card",
    });
    expect(content.reviewState).toBe("pending");
    expect((await ext.getCommunityContent(ctx, "cc_1"))?.visibility).toBe("public");
    expect(await ext.getCommunityContent(otherTenant, "cc_1")).not.toBeNull();

    const org = await ext.createOrganization(ctx, { id: "org_1", ownerId: "usr_p23", policyVersion: "v1" });
    expect(org.memberScope).toBe("institution");
    expect(await ext.getOrganization(otherTenant, "org_1")).not.toBeNull();
  });
});
