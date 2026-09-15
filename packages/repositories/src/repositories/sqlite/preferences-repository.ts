/**
 * Aervox｜思隅 @aervox/database — 用户偏好 SQLite 仓储实现（CAP-010 人格问卷与基础偏好）
 *
 * - 本地实例一行（CR-030：固定主键构成单行真源），save 为幂等 upsert；
 * - update 仅更新传参列，version 自动递增；
 * - reset 恢复中性默认值。
 */
import { eq, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { personaPreferences } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IPersonaPreferencesRepository,
  PersonaPreferencesModel,
} from "../types/index.js";

/** 本地单用户偏好固定主键：保证全表恒为一行，历史多行数据不参与读写。 */
const LOCAL_PREFERENCE_ID = "pref_local";

export class SqlitePersonaPreferencesRepository implements IPersonaPreferencesRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async get(tenant: LocalContext): Promise<PersonaPreferencesModel | null> {
    const [found] = await this.db
      .select()
      .from(personaPreferences)
      .where(eq(personaPreferences.id, LOCAL_PREFERENCE_ID))
      .limit(1);
    if (!found) return null;
    return this.toModel(found);
  }

  async save(
    tenant: LocalContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
      skipped?: boolean;
    },
  ): Promise<PersonaPreferencesModel> {
    const now = new Date().toISOString();

    const [created] = await this.db
      .insert(personaPreferences)
      .values({
        id: LOCAL_PREFERENCE_ID,
        tone: (input.tone ?? "neutral") as "friendly" | "neutral" | "formal",
        proactiveness: (input.proactiveness ?? "medium") as "low" | "medium" | "high",
        addressForm: (input.addressForm ?? "none") as "casual" | "formal" | "none",
        reminderCadence: (input.reminderCadence ?? "moderate") as "gentle" | "moderate" | "frequent",
        version: 1,
        skipped: input.skipped ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: personaPreferences.id,
        set: {
          tone: (input.tone ?? "neutral") as "friendly" | "neutral" | "formal",
          proactiveness: (input.proactiveness ?? "medium") as "low" | "medium" | "high",
          addressForm: (input.addressForm ?? "none") as "casual" | "formal" | "none",
          reminderCadence: (input.reminderCadence ?? "moderate") as "gentle" | "moderate" | "frequent",
          version: sql`${personaPreferences.version} + 1`,
          skipped: input.skipped ?? false,
          updatedAt: now,
        },
      })
      .returning();

    if (!created) throw new Error("failed to save preferences");
    return this.toModel(created);
  }

  async update(
    tenant: LocalContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
    },
  ): Promise<PersonaPreferencesModel> {
    const now = new Date().toISOString();

    const setValues: Record<string, unknown> = {
      updatedAt: now,
      version: sql`${personaPreferences.version} + 1`,
      skipped: false,
    };
    if (input.tone !== undefined) setValues.tone = input.tone;
    if (input.proactiveness !== undefined) setValues.proactiveness = input.proactiveness;
    if (input.addressForm !== undefined) setValues.addressForm = input.addressForm;
    if (input.reminderCadence !== undefined) setValues.reminderCadence = input.reminderCadence;

    const [updated] = await this.db
      .update(personaPreferences)
      .set(setValues)
      .where(eq(personaPreferences.id, LOCAL_PREFERENCE_ID))
      .returning();

    if (!updated) {
      // 不存在则 upsert（首次修改即创建）
      return this.save(tenant, input);
    }

    return this.toModel(updated);
  }

  async reset(tenant: LocalContext): Promise<PersonaPreferencesModel> {
    const now = new Date().toISOString();

    const [updated] = await this.db
      .update(personaPreferences)
      .set({
        tone: "neutral",
        proactiveness: "medium",
        addressForm: "none",
        reminderCadence: "moderate",
        version: sql`${personaPreferences.version} + 1`,
        skipped: false,
        updatedAt: now,
      })
      .where(eq(personaPreferences.id, LOCAL_PREFERENCE_ID))
      .returning();

    if (!updated) {
      return this.save(tenant, {});
    }

    return this.toModel(updated);
  }

  private toModel(row: unknown): PersonaPreferencesModel {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      tone: r.tone as string,
      proactiveness: r.proactiveness as string,
      addressForm: r.addressForm as string,
      reminderCadence: r.reminderCadence as string,
      version: Number(r.version),
      skipped: Boolean(r.skipped),
      createdAt: r.createdAt as string,
      updatedAt: r.updatedAt as string,
    };
  }
}
