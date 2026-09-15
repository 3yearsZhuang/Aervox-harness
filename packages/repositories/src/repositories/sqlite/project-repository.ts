/**
 * Aervox｜思隅 @aervox/repositories — 项目 SQLite 仓储实现 (CR-048 / W3)
 */
import { desc, eq, and, isNull } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import { projects, sessions } from "@aervox/schema";
import type {
  ProjectItem,
  CreateProjectRequest,
  UpdateProjectRequest,
} from "@aervox/contracts";

function rowToProjectItem(row: typeof projects.$inferSelect): ProjectItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    color: row.color ?? undefined,
    icon: row.icon ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export class SqliteProjectRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async listProjects(
    optionsOrTenant?: LocalContext | { includeArchived?: boolean },
    maybeOptions?: { includeArchived?: boolean },
  ): Promise<ProjectItem[]> {
    const options = (maybeOptions ?? (optionsOrTenant && "includeArchived" in optionsOrTenant ? optionsOrTenant : undefined)) as { includeArchived?: boolean } | undefined;
    const query = this.db.select().from(projects);
    const rows = options?.includeArchived
      ? await query.orderBy(desc(projects.updatedAt))
      : await query.where(isNull(projects.archivedAt)).orderBy(desc(projects.updatedAt));

    return rows.map(rowToProjectItem);
  }

  async getProjectById(
    idOrTenant: LocalContext | string,
    maybeId?: string,
  ): Promise<ProjectItem | null> {
    const id = typeof idOrTenant === "string" ? idOrTenant : maybeId!;
    const rows = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!rows[0]) return null;
    return rowToProjectItem(rows[0]);
  }

  async createProject(
    inputOrTenant: LocalContext | CreateProjectRequest,
    maybeInput?: CreateProjectRequest,
  ): Promise<ProjectItem> {
    const input = (maybeInput ?? inputOrTenant) as CreateProjectRequest;
    const now = new Date().toISOString();
    const id = input.id?.trim() || `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const row = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      color: input.color?.trim() || null,
      icon: input.icon?.trim() || null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(projects).values(row);
    return rowToProjectItem(row);
  }

  async updateProject(
    idOrTenant: LocalContext | string,
    idOrInput: string | UpdateProjectRequest,
    maybeInput?: UpdateProjectRequest,
  ): Promise<ProjectItem | null> {
    const id = typeof idOrTenant === "string" ? idOrTenant : (idOrInput as string);
    const input = (maybeInput ?? (typeof idOrInput === "object" ? idOrInput : undefined)) as UpdateProjectRequest;

    const existing = await this.getProjectById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: Partial<typeof projects.$inferInsert> = {
      updatedAt: now,
    };

    if (input.name !== undefined) {
      updates.name = input.name.trim();
    }
    if (input.description !== undefined) {
      updates.description = input.description.trim() || null;
    }
    if (input.color !== undefined) {
      updates.color = input.color.trim() || null;
    }
    if (input.icon !== undefined) {
      updates.icon = input.icon.trim() || null;
    }
    if (input.archived !== undefined) {
      updates.archivedAt = input.archived ? now : null;
    }

    await this.db.update(projects).set(updates).where(eq(projects.id, id));
    return this.getProjectById(id);
  }

  async deleteProject(
    idOrTenant: LocalContext | string,
    maybeId?: string,
  ): Promise<boolean> {
    const id = typeof idOrTenant === "string" ? idOrTenant : maybeId!;
    const existing = await this.getProjectById(id);
    if (!existing) return false;

    // 1. 解除会话关联
    await this.db
      .update(sessions)
      .set({ projectId: null, updatedAt: new Date().toISOString() })
      .where(eq(sessions.projectId, id));

    // 2. 删除项目
    await this.db.delete(projects).where(eq(projects.id, id));
    return true;
  }
}
