/**
 * Aervox｜思隅 @aervox/repositories — 大语言模型与供应商配置 SQLite 仓储实现（CR-012）
 *
 * - 配置属于本地单用户实例，可保存多个预设，至多一行激活；
 * - 支持 Ollama / DeepSeek / OpenAI / Anthropic / 自定义 OpenAI 兼容端点参数持久化；
 * - 激活语义：本地实例至多一个激活预设（部分唯一索引兜底）。
 */
import { and, asc, eq } from "drizzle-orm";
import { activePresetOrder, activatePreset, deletePreset } from "./preset-lifecycle.js";
import type { AervoxDatabase } from "../../client.js";
import { llmConfigs } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  ILLMConfigRepository,
  LLMConfigSaveInput,
  LLMConfigModel,
} from "../types/index.js";

function rowToModel(row: typeof llmConfigs.$inferSelect): LLMConfigModel {
  return {
    id: row.id,
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

  async getConfig(ctx: LocalContext): Promise<LLMConfigModel | null> {
    const rows = await this.db
      .select()
      .from(llmConfigs)
      .orderBy(...activePresetOrder(llmConfigs))
      .limit(1);
    if (rows.length === 0) return null;
    return rowToModel(rows[0]!);
  }

  async saveConfig(
    ctx: LocalContext,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel> {
    const now = new Date().toISOString();
    const active = await this.getConfig(ctx);

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
        name: "默认配置",
        isActive: 1,
        ...valuesFor(input),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToModel(created!);
  }

  async listPresets(ctx: LocalContext): Promise<LLMConfigModel[]> {
    const rows = await this.db
      .select()
      .from(llmConfigs)
      .orderBy(asc(llmConfigs.createdAt));
    return rows.map(rowToModel);
  }

  async createPreset(
    ctx: LocalContext,
    name: string,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel> {
    const now = new Date().toISOString();
    const existing = await this.listPresets(ctx);
    const firstPreset = existing.length === 0;

    const [created] = await this.db
      .insert(llmConfigs)
      .values({
        id: `llm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
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
    ctx: LocalContext,
    presetId: string,
    input: LLMConfigSaveInput,
  ): Promise<LLMConfigModel | null> {
    const [updated] = await this.db
      .update(llmConfigs)
      .set({ ...valuesFor(input), updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(llmConfigs.id, presetId),
        ),
      )
      .returning();
    return updated ? rowToModel(updated!) : null;
  }

  async activatePreset(
    ctx: LocalContext,
    presetId: string,
  ): Promise<LLMConfigModel | null> {
    return activatePreset(this.db, llmConfigs, presetId, async tx => {
      const [row] = await tx.select().from(llmConfigs).where(eq(llmConfigs.id, presetId)).limit(1);
      return row ? rowToModel(row) : null;
    });
  }

  async deletePreset(ctx: LocalContext, presetId: string): Promise<boolean> {
    return deletePreset(this.db, llmConfigs, presetId);
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
