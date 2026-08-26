/**
 * Aervox｜思隅 @aervox/database — MCP 工具注册表 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 + docs/reference/DATABASE.md §14
 * 人格仅选择工具 ID；授权/健康/kill switch 状态由服务端策略与适配器维护。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { mcpTools } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { IMcpToolRepository, McpToolModel } from "../types.js";

export class SqliteMcpToolRepository implements IMcpToolRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async listMcpTools(tenant: TenantContext): Promise<McpToolModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(mcpTools)
      .where(
        and(
          eq(mcpTools.workspaceId, tenant.workspaceId),
          eq(mcpTools.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(mcpTools.serverId, mcpTools.name);
    return rows as McpToolModel[];
  }

  async upsertMcpTool(tenant: TenantContext, tool: McpToolModel): Promise<McpToolModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(mcpTools)
      .values({
        id: tool.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        serverId: tool.serverId,
        name: tool.name,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema ?? null,
        scopes: tool.scopes ?? [],
        healthy: tool.healthy ? 1 : 0,
        authorized: tool.authorized ? 1 : 0,
        revoked: tool.revoked ? 1 : 0,
        killSwitch: tool.killSwitch ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpTools.workspaceId, mcpTools.subjectUserId, mcpTools.serverId, mcpTools.name],
        set: {
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? null,
          scopes: tool.scopes ?? [],
          healthy: tool.healthy ? 1 : 0,
          authorized: tool.authorized ? 1 : 0,
          revoked: tool.revoked ? 1 : 0,
          killSwitch: tool.killSwitch ? 1 : 0,
          updatedAt: now,
        },
      })
      .returning();
    return row as McpToolModel;
  }

  async setMcpToolRevoked(tenant: TenantContext, id: string, revoked: boolean): Promise<McpToolModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .update(mcpTools)
      .set({ revoked: revoked ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(
        and(eq(mcpTools.id, id), eq(mcpTools.workspaceId, tenant.workspaceId), eq(mcpTools.subjectUserId, tenant.subjectUserId)),
      )
      .returning();
    return (row as McpToolModel) ?? null;
  }

  async setMcpToolKillSwitch(tenant: TenantContext, id: string, killSwitch: boolean): Promise<McpToolModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .update(mcpTools)
      .set({ killSwitch: killSwitch ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(
        and(eq(mcpTools.id, id), eq(mcpTools.workspaceId, tenant.workspaceId), eq(mcpTools.subjectUserId, tenant.subjectUserId)),
      )
      .returning();
    return (row as McpToolModel) ?? null;
  }
}
