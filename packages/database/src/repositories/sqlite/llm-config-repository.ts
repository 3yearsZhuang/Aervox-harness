/**
 * Aervox｜思隅 @aervox/database — 大语言模型与供应商配置 SQLite 仓储实现（CR-012）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户多行（多预设），至多一行激活；
 * - 支持 Ollama / DeepSeek / OpenAI / Anthropic / 自定义 OpenAI 兼容端点参数持久化；
 * - 激活语义：同租户至多一个预设 is_active=1（部分唯一索引 tenant_active_idx 兜底）。
 */
import { and, asc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { llmConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ILLMConfigRepository,
  LLMConfigSaveInput,
  LLMConfigModel,
} from "../types.js";

function rowToModel(row: typeof llmConfigs.$inferSelect): LLMConfigModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    name: row.name,
    isActive: row.isActive,
    enabled: row.enabled,
    providerType: row.providerType,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    modelId: row.modelId,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    settingsJson: row.settingsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteLLMConfigRepository implements ILLMConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<LLMConfigModel | null> {
    assertTenantContext(tenant);
    const tenantRows = await this.db
      .select()
      .from(llmConfigs)
      .where(
        and(
          eq(llmConfigs.workspaceId, tenant.workspaceId),
          eq(llmConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(llmConfigs.createdAt))
      .limit(50);
    if (tenantRows.length === 0) return null;
    const active = tenantRows.find((row) => row.isActive === 1) ?? tenantRows[0]!;
    return rowToModel(active);
  }

  async saveConfig(
    tenant: TenantContext,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const active = await this.getConfig(tenant);

    if (active) {
      const [updated] = await this.db
        .update(llmConfigs)
        .set({
          ...valuesFor(input),
          updatedAt: now,
        })
        .where(eq(llmConfigs.id, active.id))
        .returning();
      return rowToModel(updated!);
    }

    const [created] = await this.db
      .insert(llmConfigs)
      .values({
        id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        name: "默认配置",
        isActive: 1,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async listPresets(tenant: TenantContext): Promise<LLMConfigModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(llmConfigs)
      .where(
        and(
          eq(llmConfigs.workspaceId, tenant.workspaceId),
          eq(llmConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(llmConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    tenant: TenantContext,
    name: string,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.listPresets(tenant);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(llmConfigs)
      .values({
        id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        name: name.trim() || "默认配置",
        isActive: firstPreset ? 1 : 0,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async updatePreset(
    tenant: TenantContext,
    presetId: string,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(llmConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(llmConfigs.id, presetId),
          eq(llmConfigs.workspaceId, tenant.workspaceId),
          eq(llmConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    tenant: TenantContext,
    presetId: string,
  ): Promise<LLMConfigModel | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(llmConfigs)
        .where(
          and(
            eq(llmConfigs.id, presetId),
            eq(llmConfigs.workspaceId, tenant.workspaceId),
            eq(llmConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return null;
      await tx
        .update(llmConfigs)
        .set({ isActive: 0, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(llmConfigs.workspaceId, tenant.workspaceId),
            eq(llmConfigs.subjectUserId, tenant.subjectUserId),
          ),
        );
      const [activated] = await tx
        .update(llmConfigs)
        .set({ isActive: 1, updatedAt: new Date().toISOString() })
        .where(eq(llmConfigs.id, presetId))
        .returning();
      return rowToModel(activated!);
    });
  }

  async deletePreset(tenant: TenantContext, presetId: string): Promise<boolean> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(llmConfigs)
        .where(
          and(
            eq(llmConfigs.id, presetId),
            eq(llmConfigs.workspaceId, tenant.workspaceId),
            eq(llmConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .limit(1);
      if (!target) return false;
      const wasActive = target.isActive === 1;
      await tx.delete(llmConfigs).where(eq(llmConfigs.id, presetId));
      if (wasActive) {
        const [first] = await tx
          .select()
          .from(llmConfigs)
          .where(
            and(
              eq(llmConfigs.workspaceId, tenant.workspaceId),
              eq(llmConfigs.subjectUserId, tenant.subjectUserId),
            ),
          )
          .orderBy(asc(llmConfigs.createdAt))
          .limit(1);
        if (first) {
          await tx
            .update(llmConfigs)
            .set({ isActive: 1, updatedAt: new Date().toISOString() })
            .where(eq(llmConfigs.id, first.id));
        }
      }
      return true;
    });
  }
}

function valuesFor(input: LLMConfigSaveInput) {
  return {
    enabled: input.enabled ? 1 : 0,
    providerType: input.providerType,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey ?? null,
    modelId: input.modelId,
    temperature: input.temperature,
    maxTokens: input.maxTokens ?? 4096,
    settingsJson: input.settings ?? {},
  };
}