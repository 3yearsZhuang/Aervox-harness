/**
 * Aervox｜思隅 @aervox/database — 大语言模型与供应商配置 SQLite 仓储实现（CR-012）
 *
 * - 配置按 (workspaceId, subjectUserId) 租户隔离，每租户一行（upsert）；
 * - 支持 Ollama / DeepSeek / OpenAI / Anthropic / 自定义 OpenAI 兼容端点参数持久化。
 */
import { and, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { llmConfigs } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ILLMConfigRepository,
  LLMConfigSaveInput,
  LLMConfigModel,
} from "../types.js";

export class SqliteLLMConfigRepository implements ILLMConfigRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async getConfig(tenant: TenantContext): Promise<LLMConfigModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(llmConfigs)
      .where(
        and(
          eq(llmConfigs.workspaceId, tenant.workspaceId),
          eq(llmConfigs.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as LLMConfigModel) ?? null;
  }

  async saveConfig(
    tenant: TenantContext,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getConfig(tenant);

    if (existing) {
      const [updated] = await this.db
        .update(llmConfigs)
        .set({
          enabled: input.enabled ? 1 : 0,
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey ?? null,
          modelId: input.modelId,
          temperature: input.temperature,
          maxTokens: input.maxTokens ?? 4096,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        })
        .where(
          and(
            eq(llmConfigs.workspaceId, tenant.workspaceId),
            eq(llmConfigs.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      return updated as LLMConfigModel;
    }

    const [created] = await this.db
      .insert(llmConfigs)
      .values({
        id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        enabled: input.enabled ? 1 : 0,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey ?? null,
        modelId: input.modelId,
        temperature: input.temperature,
        maxTokens: input.maxTokens ?? 4096,
        settingsJson: input.settings ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [llmConfigs.workspaceId, llmConfigs.subjectUserId],
        set: {
          enabled: input.enabled ? 1 : 0,
          providerType: input.providerType,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey ?? null,
          modelId: input.modelId,
          temperature: input.temperature,
          maxTokens: input.maxTokens ?? 4096,
          settingsJson: input.settings ?? {},
          updatedAt: now,
        },
      })
      .returning();
    return created as LLMConfigModel;
  }
}
