/**
 * Aervox｜思隅 @aervox/repositories — 主动画像激活租约生命周期 Store
 */
import { and, desc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { proactiveActivationLeases } from "@aervox/schema";
import { RepositoryNotFoundError } from "../../../errors.js";
import type { LocalContext } from "../../../local-context.js";
import type {
  IProactiveProfileRepository,
  ProactiveActivationLeaseModel,
} from "../../types/index.js";
import { AuditExportStore } from "./audit-export-store.js";
import { ProfileLifecycleStore } from "./profile-lifecycle-store.js";
import { MAX_LIST_LIMIT, bool, datePlusMs, stringify, toLease } from "./shared.js";

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export class ActivationLeaseStore {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly lifecycle: ProfileLifecycleStore,
    private readonly audit: AuditExportStore,
  ) {}

  async createActivationLease(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createActivationLease"]>[1],
  ): Promise<ProactiveActivationLeaseModel> {
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    const now = new Date().toISOString();
    const expiresAt = datePlusMs(now, input.ttlMs ?? DEFAULT_LEASE_TTL_MS);
    await this.db
      .update(proactiveActivationLeases)
      .set({ status: "ended", endedAt: now, endReason: "superseded", updatedAt: now })
      .where(
        and(
          eq(proactiveActivationLeases.deviceId, input.deviceId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      );
    // 同一 (device_id, epoch) 幂等复用：宿主重复 authorize（重试/向导二次提交）时
    // 该行已被上方 supersede 置为 ended，直接重激活而非撞唯一约束抛 500。
    const [sameEpoch] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.deviceId, input.deviceId),
          eq(proactiveActivationLeases.epoch, input.epoch),
        ),
      )
      .limit(1);
    if (sameEpoch) return this.reactivateActivationLease(ctx, input, sameEpoch.id, now, expiresAt);
    let created: typeof proactiveActivationLeases.$inferSelect | undefined;
    try {
      [created] = await this.db
        .insert(proactiveActivationLeases)
        .values({
          id: input.id,
          revisionId: revision.id,
          deviceId: input.deviceId,
          epoch: input.epoch,
          status: "active",
          localReady: input.localReady,
          fullAccessSnapshot: input.fullAccessSnapshot,
          issuedAt: now,
          expiresAt,
          heartbeatAt: now,
          endedAt: null,
          endReason: null,
          metadataJson: stringify(input.metadata),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } catch (error) {
      // 并发竞态：两个 authorize 同帧到达时彼此都查不到对方的未提交行，后插入者
      // 撞 UNIQUE(device_id, epoch)。捕获后重查复用，保证接口幂等。
      const constraintCode = (error as {code?: string} | null)?.code ?? "";
      const message = error instanceof Error ? error.message : String(error);
      if (!constraintCode.startsWith("SQLITE_CONSTRAINT") || !message.includes("UNIQUE")) throw error;
      const [raced] = await this.db
        .select()
        .from(proactiveActivationLeases)
        .where(
          and(
            eq(proactiveActivationLeases.deviceId, input.deviceId),
            eq(proactiveActivationLeases.epoch, input.epoch),
          ),
        )
        .limit(1);
      if (!raced) throw error;
      return this.reactivateActivationLease(ctx, input, raced.id, now, expiresAt);
    }
    if (!created) throw new Error("failed to create proactive activation lease");
    await this.audit.recordAudit(ctx, {
      id: `${input.id}_audit_activated`,
      revisionId: revision.id,
      eventType: "activation.issued",
      actorId: input.actorId,
      resourceType: "activation_lease",
      resourceId: input.id,
      payload: { deviceId: input.deviceId, epoch: input.epoch, localReady: input.localReady },
    });
    return toLease(created);
  }

  /** 复用既有 (device_id, epoch) 租约：重激活并续期，审计标注 reused */
  private async reactivateActivationLease(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createActivationLease"]>[1],
    leaseId: string,
    now: string,
    expiresAt: string,
  ): Promise<ProactiveActivationLeaseModel> {
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    const [reactivated] = await this.db
      .update(proactiveActivationLeases)
      .set({
        revisionId: revision.id,
        status: "active",
        localReady: input.localReady,
        fullAccessSnapshot: input.fullAccessSnapshot,
        issuedAt: now,
        expiresAt,
        heartbeatAt: now,
        endedAt: null,
        endReason: null,
        metadataJson: stringify(input.metadata),
        updatedAt: now,
      })
      .where(eq(proactiveActivationLeases.id, leaseId))
      .returning();
    if (!reactivated) throw new Error("failed to reactivate proactive activation lease");
    await this.audit.recordAudit(ctx, {
      id: `${input.id}_audit_activated`,
      revisionId: revision.id,
      eventType: "activation.issued",
      actorId: input.actorId,
      resourceType: "activation_lease",
      resourceId: reactivated.id,
      payload: { deviceId: input.deviceId, epoch: input.epoch, localReady: input.localReady, reused: true },
    });
    return toLease(reactivated);
  }

  async heartbeatActivationLease(
    ctx: LocalContext,
    leaseId: string,
    input: Parameters<IProactiveProfileRepository["heartbeatActivationLease"]>[2],
  ): Promise<ProactiveActivationLeaseModel | null> {
    const [existing] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    const now = new Date().toISOString();
    if (existing.status !== "active" || Date.parse(existing.expiresAt) <= Date.parse(now)) {
      if (existing.status === "active") {
        await this.db
          .update(proactiveActivationLeases)
          .set({ status: "expired", endedAt: now, endReason: "lease_expired", updatedAt: now })
          .where(eq(proactiveActivationLeases.id, leaseId));
      }
      return this.getLease(ctx, leaseId);
    }
    const [updated] = await this.db
      .update(proactiveActivationLeases)
      .set({
        heartbeatAt: now,
        expiresAt: datePlusMs(now, input.ttlMs ?? DEFAULT_LEASE_TTL_MS),
        localReady: input.localReady ?? bool(existing.localReady),
        fullAccessSnapshot: input.fullAccessSnapshot ?? bool(existing.fullAccessSnapshot),
        metadataJson: input.metadata === undefined ? existing.metadataJson : stringify(input.metadata),
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      )
      .returning();
    return updated ? toLease(updated) : null;
  }

  async endActivationLease(ctx: LocalContext, leaseId: string, reason: string, actorId: string): Promise<ProactiveActivationLeaseModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveActivationLeases)
      .set({ status: "ended", endedAt: now, endReason: reason, updatedAt: now })
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.audit.recordAudit(ctx, {
      id: `${leaseId}_audit_ended_${Date.now().toString(36)}`,
      revisionId: updated.revisionId,
      eventType: "activation.ended",
      actorId,
      resourceType: "activation_lease",
      resourceId: leaseId,
      payload: { reason },
    });
    return toLease(updated);
  }

  async getLease(ctx: LocalContext, leaseId: string): Promise<ProactiveActivationLeaseModel | null> {
    const [row] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
        ),
      )
      .limit(1);
    return row ? toLease(row) : null;
  }

  async listLeases(ctx: LocalContext): Promise<ProactiveActivationLeaseModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
        ),
      )
      .orderBy(desc(proactiveActivationLeases.issuedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map(toLease);
  }
}
