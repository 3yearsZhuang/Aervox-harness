/**
 * Aervox｜思隅 @aervox/database — 工作区 Anthropic Skills SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 + docs/reference/DATABASE.md §14
 * Skill 内容（SKILL.md/资源）以 base64 JSON 持久化；导入/校验由 @aervox/mod-persona 完成。
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { workspaceSkills } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { ISkillRepository, SkillModel } from "../types.js";

export class SqliteSkillRepository implements ISkillRepository {
  constructor(private readonly db: AervoxDatabase) {}

  private toModel(row: {
    id: string; workspaceId: string; subjectUserId: string; name: string; description: string;
    license: string | null; compatibility: string | null; metadata: unknown; allowedTools: unknown;
    source: string; version: number; checksum: string; enabled: number; valid: number;
    validationErrors: unknown; filesJson: string; skillMarkdown: string; importedAt: string;
    createdAt: string; updatedAt: string;
  }): SkillModel {
    return {
      ...row,
      license: row.license,
      compatibility: row.compatibility,
      validationErrors: Array.isArray(row.validationErrors) ? row.validationErrors : JSON.parse(String(row.validationErrors ?? "[]")) as string[],
      filesJson: JSON.parse(row.filesJson) as Record<string, string>,
    };
  }

  async listSkills(tenant: TenantContext): Promise<SkillModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.workspaceId, tenant.workspaceId),
          eq(workspaceSkills.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(sql`name ASC`);
    return rows.map((row) => this.toModel(row));
  }

  async getSkill(tenant: TenantContext, name: string): Promise<SkillModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .select()
      .from(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.name, name),
          eq(workspaceSkills.workspaceId, tenant.workspaceId),
          eq(workspaceSkills.subjectUserId, tenant.subjectUserId),
        ),
      );
    return row ? this.toModel(row) : null;
  }

  async upsertSkill(tenant: TenantContext, skill: SkillModel): Promise<SkillModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const existing = await this.getSkill(tenant, skill.name);
    const version = existing ? existing.version + 1 : 1;
    const [row] = await this.db
      .insert(workspaceSkills)
      .values({
        id: skill.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        name: skill.name,
        description: skill.description,
        license: skill.license ?? null,
        compatibility: skill.compatibility ?? null,
        metadata: skill.metadata ?? null,
        allowedTools: skill.allowedTools ?? null,
        source: skill.source,
        version,
        checksum: skill.checksum,
        enabled: skill.enabled ? 1 : 0,
        valid: skill.valid ? 1 : 0,
        validationErrors: skill.validationErrors ?? [],
        filesJson: JSON.stringify(skill.filesJson),
        skillMarkdown: skill.skillMarkdown,
        importedAt: skill.importedAt ?? now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workspaceSkills.workspaceId, workspaceSkills.subjectUserId, workspaceSkills.name],
        set: {
          description: skill.description,
          license: skill.license ?? null,
          compatibility: skill.compatibility ?? null,
          metadata: skill.metadata ?? null,
          allowedTools: skill.allowedTools ?? null,
          source: skill.source,
          version,
          checksum: skill.checksum,
          enabled: skill.enabled ? 1 : 0,
          valid: skill.valid ? 1 : 0,
          validationErrors: skill.validationErrors ?? [],
          filesJson: JSON.stringify(skill.filesJson),
          skillMarkdown: skill.skillMarkdown,
          importedAt: skill.importedAt ?? now,
          updatedAt: now,
        },
      })
      .returning();
    const saved = await this.getSkill(tenant, skill.name);
    if (!saved) throw new Error("skill upsert failed");
    return saved;
  }

  async setSkillEnabled(tenant: TenantContext, name: string, enabled: boolean): Promise<SkillModel | null> {
    assertTenantContext(tenant);
    const [row] = await this.db
      .update(workspaceSkills)
      .set({ enabled: enabled ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(workspaceSkills.name, name),
          eq(workspaceSkills.workspaceId, tenant.workspaceId),
          eq(workspaceSkills.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return row ? this.toModel(row) : null;
  }

  async deleteSkill(tenant: TenantContext, name: string): Promise<boolean> {
    assertTenantContext(tenant);
    const rows = await this.db
      .delete(workspaceSkills)
      .where(
        and(
          eq(workspaceSkills.name, name),
          eq(workspaceSkills.workspaceId, tenant.workspaceId),
          eq(workspaceSkills.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning({ id: workspaceSkills.id });
    return rows.length > 0;
  }
}
