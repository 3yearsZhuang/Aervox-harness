/**
 * Aervox｜思隅 @aervox/database — CAP-020 Skill Neo 生命周期 SQLite 仓储实现
 *
 * 规则依据：docs/explanation/reference-design-transfer.md（Skill 能力）与
 * reference/AstrBot astrbot/core/tools/computer_tools/shipyard_neo/neo_skills.py
 * （payload → candidate → evaluate → promote → release 流程）。
 *
 * 设计要点：
 * - payload 不可变语义：同一 payloadRef 重复写入覆盖内容（幂等 + checksum 同步）；
 * - candidate 幂等：同一 candidateId 返回既有记录，不重复创建；
 * - release 幂等：同 skillKey+stage+version 返回既有；新建时自动取消
 *   同 skillKey+stage 的旧 active（仅一份 active，由部分唯一索引兜底）；
 * - 状态机约束（pending → evaluated/promoted/rejected）在仓储层仅做写入，
 *   编排由上层生命周期服务负责。
 */
import { and, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  skillCandidates,
  skillPayloads,
  skillReleases,
} from "../../schema/index.js";
import type {
  ISkillLifecycleRepository,
  SkillCandidateModel,
  SkillPayloadModel,
  SkillReleaseModel,
} from "../types.js";

export class SqliteSkillLifecycleRepository implements ISkillLifecycleRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createPayload(
    payload: {
      payloadRef: string;
      kind?: string;
      content: unknown;
      checksum?: string | null;
    },
  ): Promise<SkillPayloadModel> {
    const now = new Date().toISOString();

    // 幂等：同一 payloadRef 覆盖内容（不可变语义，checksum 同步）
    const [existing] = await this.db
      .select()
      .from(skillPayloads)
      .where(eq(skillPayloads.payloadRef, payload.payloadRef))
      .limit(1);

    if (existing) {
      const [updated] = await this.db
        .update(skillPayloads)
        .set({
          kind: payload.kind ?? existing.kind,
          contentJson: payload.content,
          checksum: payload.checksum ?? existing.checksum,
          updatedAt: now,
        })
        .where(eq(skillPayloads.payloadRef, payload.payloadRef))
        .returning();
      return this.toPayloadModel(updated!);
    }

    const [created] = await this.db
      .insert(skillPayloads)
      .values({
        payloadRef: payload.payloadRef,
        kind: payload.kind ?? "aervox_skill_v1",
        contentJson: payload.content,
        checksum: payload.checksum ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.toPayloadModel(created!);
  }

  async getPayload(payloadRef: string): Promise<SkillPayloadModel | null> {
    const [found] = await this.db
      .select()
      .from(skillPayloads)
      .where(eq(skillPayloads.payloadRef, payloadRef))
      .limit(1);
    return found ? this.toPayloadModel(found) : null;
  }

  async createCandidate(
    candidate: {
      candidateId: string;
      skillKey: string;
      sourceEvidence: { turnIds: string[]; memoryIds: string[]; learningItemIds: string[] };
      payloadRef?: string | null;
      scenarioKey?: string | null;
    },
  ): Promise<SkillCandidateModel> {
    const now = new Date().toISOString();

    // 幂等：同一 candidateId 返回既有记录
    const [existing] = await this.db
      .select()
      .from(skillCandidates)
      .where(eq(skillCandidates.candidateId, candidate.candidateId))
      .limit(1);
    if (existing) return this.toCandidateModel(existing);

    const [created] = await this.db
      .insert(skillCandidates)
      .values({
        candidateId: candidate.candidateId,
        skillKey: candidate.skillKey,
        sourceEvidenceJson: candidate.sourceEvidence,
        payloadRef: candidate.payloadRef ?? null,
        scenarioKey: candidate.scenarioKey ?? null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.toCandidateModel(created!);
  }

  async getCandidate(candidateId: string): Promise<SkillCandidateModel | null> {
    const [found] = await this.db
      .select()
      .from(skillCandidates)
      .where(eq(skillCandidates.candidateId, candidateId))
      .limit(1);
    return found ? this.toCandidateModel(found) : null;
  }

  async listCandidates(options?: {
    skillKey?: string;
    status?: string;
  }): Promise<SkillCandidateModel[]> {
    const conditions = [];
    if (options?.skillKey) conditions.push(eq(skillCandidates.skillKey, options.skillKey));
    if (options?.status) conditions.push(eq(skillCandidates.status, options.status));

    const rows = conditions.length
      ? await this.db.select().from(skillCandidates).where(and(...conditions))
      : await this.db.select().from(skillCandidates);
    return rows.map((row) => this.toCandidateModel(row));
  }

  async updateCandidateStatus(
    candidateId: string,
    status: string,
  ): Promise<SkillCandidateModel | null> {
    const [updated] = await this.db
      .update(skillCandidates)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(skillCandidates.candidateId, candidateId))
      .returning();
    return updated ? this.toCandidateModel(updated) : null;
  }

  async createRelease(
    release: {
      releaseId: string;
      skillKey: string;
      stage: string;
      candidateId: string;
      payloadRef?: string | null;
      version: number;
    },
  ): Promise<SkillReleaseModel> {
    const now = new Date().toISOString();

    // 幂等：同 skillKey+stage+version 返回既有
    const [existing] = await this.db
      .select()
      .from(skillReleases)
      .where(
        and(
          eq(skillReleases.skillKey, release.skillKey),
          eq(skillReleases.stage, release.stage),
          eq(skillReleases.version, release.version),
        ),
      )
      .limit(1);
    if (existing) return this.toReleaseModel(existing);

    // 新建发布：自动取消同 skillKey+stage 的旧 active（仅一份 active）
    await this.db
      .update(skillReleases)
      .set({ active: 0, updatedAt: now })
      .where(
        and(
          eq(skillReleases.skillKey, release.skillKey),
          eq(skillReleases.stage, release.stage),
          eq(skillReleases.active, 1),
        ),
      );

    const [created] = await this.db
      .insert(skillReleases)
      .values({
        releaseId: release.releaseId,
        skillKey: release.skillKey,
        stage: release.stage,
        candidateId: release.candidateId,
        payloadRef: release.payloadRef ?? null,
        version: release.version,
        active: 1,
        syncedToLocal: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return this.toReleaseModel(created!);
  }

  async getRelease(releaseId: string): Promise<SkillReleaseModel | null> {
    const [found] = await this.db
      .select()
      .from(skillReleases)
      .where(eq(skillReleases.releaseId, releaseId))
      .limit(1);
    return found ? this.toReleaseModel(found) : null;
  }

  async listReleases(options?: {
    skillKey?: string;
    stage?: string;
    activeOnly?: boolean;
  }): Promise<SkillReleaseModel[]> {
    const conditions = [];
    if (options?.skillKey) conditions.push(eq(skillReleases.skillKey, options.skillKey));
    if (options?.stage) conditions.push(eq(skillReleases.stage, options.stage));
    if (options?.activeOnly) conditions.push(eq(skillReleases.active, 1));

    const rows = conditions.length
      ? await this.db.select().from(skillReleases).where(and(...conditions))
      : await this.db.select().from(skillReleases);
    return rows.map((row) => this.toReleaseModel(row));
  }

  async markSyncedToLocal(releaseId: string): Promise<SkillReleaseModel | null> {
    const [updated] = await this.db
      .update(skillReleases)
      .set({ syncedToLocal: 1, updatedAt: new Date().toISOString() })
      .where(eq(skillReleases.releaseId, releaseId))
      .returning();
    return updated ? this.toReleaseModel(updated) : null;
  }

  async deactivateRelease(releaseId: string): Promise<SkillReleaseModel | null> {
    return this.setReleaseActive(releaseId, false);
  }

  async setReleaseActive(releaseId: string, active: boolean): Promise<SkillReleaseModel | null> {
    const [updated] = await this.db
      .update(skillReleases)
      .set({ active: active ? 1 : 0, updatedAt: new Date().toISOString() })
      .where(eq(skillReleases.releaseId, releaseId))
      .returning();
    return updated ? this.toReleaseModel(updated) : null;
  }

  // ---- 行 → 模型映射 ----

  private toPayloadModel(row: typeof skillPayloads.$inferSelect): SkillPayloadModel {
    return {
      payloadRef: row.payloadRef,
      kind: row.kind,
      content: row.contentJson,
      checksum: row.checksum,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toCandidateModel(row: typeof skillCandidates.$inferSelect): SkillCandidateModel {
    return {
      candidateId: row.candidateId,
      skillKey: row.skillKey,
      sourceEvidence: (row.sourceEvidenceJson ?? {
        turnIds: [],
        memoryIds: [],
        learningItemIds: [],
      }) as SkillCandidateModel["sourceEvidence"],
      payloadRef: row.payloadRef,
      scenarioKey: row.scenarioKey,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toReleaseModel(row: typeof skillReleases.$inferSelect): SkillReleaseModel {
    return {
      releaseId: row.releaseId,
      skillKey: row.skillKey,
      stage: row.stage,
      candidateId: row.candidateId,
      payloadRef: row.payloadRef,
      version: row.version,
      active: row.active,
      syncedToLocal: row.syncedToLocal,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
