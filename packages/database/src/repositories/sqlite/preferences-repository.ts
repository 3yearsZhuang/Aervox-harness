/**
 * Aervox｜思隅 @aervox/database — 用户偏好 SQLite 仓储实现（CAP-010 人格问卷与基础偏好）
 *
 * - 每租户一行，upsert 语义；
 * - update 仅更新传参列，version 自动递增；
 * - reset 恢复中性默认值。
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { personaPreferences } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IPersonaPreferencesRepository,
  PersonaPreferencesModel,
} from "../types.js";

export class SqlitePersonaPreferencesRepository implements IPersonaPreferencesRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async get(tenant: TenantContext): Promise<PersonaPreferencesModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(personaPreferences)
      .where(
        and(
          eq(personaPreferences.workspaceId, tenant.workspaceId),
          eq(personaPreferences.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!found) return null;
    return this.toModel(found);
  }

  async save(
    tenant: TenantContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
      skipped?: boolean;
    },
  ): Promise<PersonaPreferencesModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    const [created] = await this.db
      .insert(personaPreferences)
      .values({
        id: `pref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
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
        target: [personaPreferences.workspaceId, personaPreferences.subjectUserId],
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
    tenant: TenantContext,
    input: {
      tone?: string;
      proactiveness?: string;
      addressForm?: string;
      reminderCadence?: string;
    },
  ): Promise<PersonaPreferencesModel> {
    assertTenantContext(tenant);
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
      .where(
        and(
          eq(personaPreferences.workspaceId, tenant.workspaceId),
          eq(personaPreferences.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();

    if (!updated) {
      // 不存在则 upsert（首次修改即创建）
      return this.save(tenant, input);
    }

    return this.toModel(updated);
  }

  async reset(tenant: TenantContext): Promise<PersonaPreferencesModel> {
    assertTenantContext(tenant);
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
      .where(
        and(
          eq(personaPreferences.workspaceId, tenant.workspaceId),
          eq(personaPreferences.subjectUserId, tenant.subjectUserId),
        ),
      )
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
      workspaceId: r.workspaceId as string,
      subjectUserId: r.subjectUserId as string,
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