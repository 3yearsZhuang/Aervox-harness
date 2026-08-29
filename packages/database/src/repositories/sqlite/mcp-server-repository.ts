/**
 * Aervox｜思隅 @aervox/database — MCP 服务器连接配置 SQLite 仓储实现
 *
 * 与 SqliteToolRegistryRepository 对齐：系统级表（无租户列），drizzle 直查。
 * token 仅落本地库，任何方法都不做脱敏——脱敏是 API 层职责（不回传原文）。
 */
import { eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { mcpServers } from "../../schema/index.js";
import type { IMcpServerRepository, McpServerModel } from "../types.js";

export class SqliteMcpServerRepository implements IMcpServerRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async upsertServer(server: {
    id: string;
    name: string;
    transport: string;
    endpointUrl: string;
    authType: string;
    token?: string | null;
    enabled?: boolean;
    isPreset?: boolean;
  }): Promise<McpServerModel> {
    const now = new Date().toISOString();

    const [existing] = await this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, server.id))
      .limit(1);

    if (existing) {
      // token 语义：undefined = 不改动；null = 显式清除；字符串 = 覆盖
      const nextToken = server.token === undefined ? existing.token : server.token;
      const [updated] = await this.db
        .update(mcpServers)
        .set({
          name: server.name,
          transport: server.transport,
          endpointUrl: server.endpointUrl,
          authType: server.authType,
          token: nextToken,
          enabled: server.enabled === undefined ? existing.enabled : server.enabled ? 1 : 0,
          isPreset: server.isPreset === undefined ? existing.isPreset : server.isPreset ? 1 : 0,
          updatedAt: now,
        })
        .where(eq(mcpServers.id, server.id))
        .returning();
      return updated as McpServerModel;
    }

    const [created] = await this.db
      .insert(mcpServers)
      .values({
        id: server.id,
        name: server.name,
        transport: server.transport,
        endpointUrl: server.endpointUrl,
        authType: server.authType,
        token: server.token ?? null,
        enabled: server.enabled ? 1 : 0,
        isPreset: server.isPreset ? 1 : 0,
        status: "disconnected",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as McpServerModel;
  }

  async getServer(id: string): Promise<McpServerModel | null> {
    const [found] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
    return (found as McpServerModel) ?? null;
  }

  async listServers(): Promise<McpServerModel[]> {
    const rows = await this.db.select().from(mcpServers);
    return rows as McpServerModel[];
  }

  async listEnabledServers(): Promise<McpServerModel[]> {
    const rows = await this.db.select().from(mcpServers).where(eq(mcpServers.enabled, 1));
    return rows as McpServerModel[];
  }

  async setToken(id: string, token: string | null): Promise<McpServerModel | null> {
    const [updated] = await this.db
      .update(mcpServers)
      .set({ token, updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .returning();
    return (updated as McpServerModel) ?? null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerModel | null> {
    const [updated] = await this.db
      .update(mcpServers)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(mcpServers.id, id))
      .returning();
    return (updated as McpServerModel) ?? null;
  }

  async setStatus(id: string, status: string, lastError?: string | null): Promise<McpServerModel | null> {
    const [updated] = await this.db
      .update(mcpServers)
      .set({
        status,
        lastError: lastError ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpServers.id, id))
      .returning();
    return (updated as McpServerModel) ?? null;
  }

  async markSynced(id: string, toolCount: number): Promise<McpServerModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(mcpServers)
      .set({
        status: "connected",
        lastError: null,
        lastSyncAt: now,
        toolCount,
        updatedAt: now,
      })
      .where(eq(mcpServers.id, id))
      .returning();
    return (updated as McpServerModel) ?? null;
  }

  async deleteServer(id: string): Promise<boolean> {
    const deleted = await this.db.delete(mcpServers).where(eq(mcpServers.id, id)).returning();
    return deleted.length > 0;
  }
}
