/**
 * Aervox｜思隅 @aervox/database — CAP-020 Skill 注册表 SQLite 仓储实现
 *
 * 规则依据：docs/explanation/reference-design-transfer.md（Skill 能力）与
 * reference/AstrBot astrbot/core/skills/skill_manager.py。
 *
 * 设计要点：
 * - 技能注册为系统级（无租户列），所有租户共享同一注册表（与 tool_registrations 同构）；
 * - 幂等注册：同一 id 覆盖元数据，active/readonly 保持既有状态；
 * - readonly=1（插件内置）拒绝注销，只允许启停；
 * - exportSkills 按 active + 门控条件过滤，供渐进式披露/运行时消费。
 */
import { eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { skillRegistrations } from "../../schema/index.js";
import type { ISkillRegistryRepository, SkillRegistrationModel } from "../types.js";

export class SqliteSkillRegistryRepository implements ISkillRegistryRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async registerSkill(
    skill: {
      id: string;
      name: string;
      description: string;
      source?: string;
      active?: boolean;
      readonly?: boolean;
      version?: string;
      checksum?: string | null;
      pluginId?: string | null;
      gatingConditions?: unknown;
      contentPath?: string | null;
    },
  ): Promise<SkillRegistrationModel> {
    const now = new Date().toISOString();

    // 幂等：已有同 id 技能时覆盖元数据，active/readonly 保持不变
    const [existing] = await this.db
      .select()
      .from(skillRegistrations)
      .where(eq(skillRegistrations.id, skill.id))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(skillRegistrations)
        .set({
          name: skill.name,
          description: skill.description,
          source: skill.source ?? existing.source,
          version: skill.version ?? existing.version,
          checksum: skill.checksum ?? existing.checksum,
          pluginId: skill.pluginId ?? existing.pluginId,
          gatingConditionsJson: skill.gatingConditions ?? existing.gatingConditionsJson,
          contentPath: skill.contentPath ?? existing.contentPath,
          updatedAt: now,
        })
        .where(eq(skillRegistrations.id, skill.id))
        .returning();
      return updated as SkillRegistrationModel;
    }

    const [created] = await this.db
      .insert(skillRegistrations)
      .values({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: skill.source ?? "local",
        active: skill.active === false ? 0 : 1,
        readonly: skill.readonly ? 1 : 0,
        version: skill.version ?? "1.0.0",
        checksum: skill.checksum ?? null,
        pluginId: skill.pluginId ?? null,
        gatingConditionsJson: skill.gatingConditions ?? null,
        contentPath: skill.contentPath ?? null,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as SkillRegistrationModel;
  }

  async getSkill(id: string): Promise<SkillRegistrationModel | null> {
    const [found] = await this.db
      .select()
      .from(skillRegistrations)
      .where(eq(skillRegistrations.id, id))
      .limit(1);
    return (found as SkillRegistrationModel) ?? null;
  }

  async listSkills(activeOnly = false): Promise<SkillRegistrationModel[]> {
    if (activeOnly) {
      const rows = await this.db
        .select()
        .from(skillRegistrations)
        .where(eq(skillRegistrations.active, 1));
      return rows as SkillRegistrationModel[];
    }
    const rows = await this.db.select().from(skillRegistrations);
    return rows as SkillRegistrationModel[];
  }

  async setActive(id: string, active: boolean): Promise<SkillRegistrationModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(skillRegistrations)
      .set({ active: active ? 1 : 0, updatedAt: now })
      .where(eq(skillRegistrations.id, id))
      .returning();
    return (updated as SkillRegistrationModel) ?? null;
  }

  async unregisterSkill(id: string): Promise<boolean> {
    // readonly 技能（插件内置）不可注销
    const [skill] = await this.db
      .select()
      .from(skillRegistrations)
      .where(eq(skillRegistrations.id, id))
      .limit(1);
    if (!skill) return false;
    if (skill.readonly === 1) return false;

    await this.db.delete(skillRegistrations).where(eq(skillRegistrations.id, id));
    return true;
  }

  async removeSkill(id: string): Promise<boolean> {
    // 无条件移除（忽略 readonly）：供插件卸载等内部生命周期使用
    const [skill] = await this.db
      .select()
      .from(skillRegistrations)
      .where(eq(skillRegistrations.id, id))
      .limit(1);
    if (!skill) return false;

    await this.db.delete(skillRegistrations).where(eq(skillRegistrations.id, id));
    return true;
  }

  async touchSkill(id: string): Promise<SkillRegistrationModel | null> {
    const [updated] = await this.db
      .update(skillRegistrations)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(skillRegistrations.id, id))
      .returning();
    return (updated as SkillRegistrationModel) ?? null;
  }

  async exportSkills(
    options?: {
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
    },
  ): Promise<SkillRegistrationModel[]> {
    const all = await this.db.select().from(skillRegistrations);
    const filtered = all.filter((skill) => {
      // 1. active = 1
      if (skill.active !== 1) return false;
      // 2. AST-04 门控条件求值
      if (options?.gatingEvaluator && skill.gatingConditionsJson) {
        const conditions = Array.isArray(skill.gatingConditionsJson)
          ? skill.gatingConditionsJson
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

    // 按名称排序（稳定清单顺序）
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered as SkillRegistrationModel[];
  }
}
