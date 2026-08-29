/**
 * Aervox｜思隅 @aervox/database — T-04 工具注册表 SQLite 仓储实现
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4 T-04 工具注册表与主动记忆工具
 * 与 §4.7 AST-04 插件元数据与工具配置门控。
 *
 * 设计要点：
 * - 工具注册为系统级（无租户列），所有租户共享同一注册表；
 * - enabled = 0 对应 disabledToolIds，exportRegistry 按 enabled + 全局禁用 + 门控过滤；
 * - 内置工具（builtin = 1）不可注销，只能禁用；
 * - PET-05 safetyLevel 标记只读白名单，read_only 可被 AI 自主调用。
 */
import { eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { toolRegistrations } from "../../schema/index.js";
import type { IToolRegistryRepository, ToolRegistrationModel } from "../types.js";

export class SqliteToolRegistryRepository implements IToolRegistryRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async registerTool(
    tool: {
      id: string;
      name: string;
      description: string;
      category: string;
      safetyLevel?: string;
      replay?: string;
      requiredPermissions?: unknown;
      inputSchema?: unknown;
      builtin?: boolean;
      pluginId?: string | null;
      gatingConditions?: unknown;
      priority?: number;
    },
  ): Promise<ToolRegistrationModel> {
    const now = new Date().toISOString();

    // 幂等：已有同 id 工具时覆盖元数据，enabled 保持不变
    const [existing] = await this.db
      .select()
      .from(toolRegistrations)
      .where(eq(toolRegistrations.id, tool.id))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(toolRegistrations)
        .set({
          name: tool.name,
          description: tool.description,
          category: tool.category,
          safetyLevel: tool.safetyLevel ?? "write_with_approval",
          replay: tool.replay ?? null,
          requiredPermissionsJson: tool.requiredPermissions ?? null,
          inputSchemaJson: tool.inputSchema ?? null,
          builtin: tool.builtin ? 1 : 0,
          pluginId: tool.pluginId ?? null,
          gatingConditionsJson: tool.gatingConditions ?? null,
          priority: tool.priority ?? 0,
          updatedAt: now,
        })
        .where(eq(toolRegistrations.id, tool.id))
        .returning();
      // enabled 保持原值
      return updated as ToolRegistrationModel;
    }

    const [created] = await this.db
      .insert(toolRegistrations)
      .values({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        safetyLevel: tool.safetyLevel ?? "write_with_approval",
        replay: tool.replay ?? null,
        requiredPermissionsJson: tool.requiredPermissions ?? null,
        inputSchemaJson: tool.inputSchema ?? null,
        builtin: tool.builtin ? 1 : 0,
        pluginId: tool.pluginId ?? null,
        enabled: 1,
        gatingConditionsJson: tool.gatingConditions ?? null,
        priority: tool.priority ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ToolRegistrationModel;
  }

  async getTool(id: string): Promise<ToolRegistrationModel | null> {
    const [found] = await this.db
      .select()
      .from(toolRegistrations)
      .where(eq(toolRegistrations.id, id))
      .limit(1);
    return (found as ToolRegistrationModel) ?? null;
  }

  async listTools(): Promise<ToolRegistrationModel[]> {
    const rows = await this.db.select().from(toolRegistrations);
    return rows as ToolRegistrationModel[];
  }

  async setEnabled(id: string, enabled: boolean): Promise<ToolRegistrationModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(toolRegistrations)
      .set({ enabled: enabled ? 1 : 0, updatedAt: now })
      .where(eq(toolRegistrations.id, id))
      .returning();
    return (updated as ToolRegistrationModel) ?? null;
  }

  async unregisterTool(id: string): Promise<boolean> {
    // 内置工具不可注销
    const [tool] = await this.db
      .select()
      .from(toolRegistrations)
      .where(eq(toolRegistrations.id, id))
      .limit(1);
    if (!tool) return false;
    if (tool.builtin === 1) return false;

    await this.db.delete(toolRegistrations).where(eq(toolRegistrations.id, id));
    return true;
  }

  async exportRegistry(
    options?: {
      disabledToolIds?: string[];
      gatingEvaluator?: (
        condition: {
          field: string;
          operator: string;
          value?: unknown;
          evaluatorId?: string;
        },
        context?: unknown,
      ) => boolean;
      gatingContext?: unknown;
      category?: string;
    },
  ): Promise<ToolRegistrationModel[]> {
    const allTools = await this.db.select().from(toolRegistrations);
    const disabledSet = new Set(options?.disabledToolIds ?? []);

    const filtered = allTools.filter((tool) => {
      // 1. enabled = 1
      if (tool.enabled !== 1) return false;
      // 2. 不在全局禁用列表
      if (disabledSet.has(tool.id)) return false;
      // 3. 按分类过滤
      if (options?.category && tool.category !== options.category) return false;
      // 4. AST-04 门控条件求值
      if (options?.gatingEvaluator && tool.gatingConditionsJson) {
        const conditions = Array.isArray(tool.gatingConditionsJson)
          ? tool.gatingConditionsJson
          : [];
        for (const cond of conditions as Array<{
          field: string;
          operator: string;
          value?: unknown;
          evaluatorId?: string;
        }>) {
          if (!options.gatingEvaluator(cond, options.gatingContext)) {
            return false;
          }
        }
      }
      return true;
    });

    // 按 priority 降序排列
    filtered.sort((a, b) => b.priority - a.priority);
    return filtered as ToolRegistrationModel[];
  }
}
