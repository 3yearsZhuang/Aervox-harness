/**
 * Aervox｜思隅 @aervox/repositories — 原始捕获/观察数据摄取、提炼与保留清理 Store
 */
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  proactiveAuditEvents,
  proactiveCaptures,
  proactiveObservations,
  proactiveSourceGrants,
} from "@aervox/schema";
import { DomainConflictError, RepositoryNotFoundError } from "../../../errors.js";
import type { LocalContext } from "../../../local-context.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveBehaviorObservationModel,
  ProactiveCaptureModel,
} from "../../types/index.js";
import { AuditExportStore } from "./audit-export-store.js";
import { decodeWithCipher, encrypt } from "./crypto.js";
import { ProfileLifecycleStore } from "./profile-lifecycle-store.js";
import { MAX_LIST_LIMIT, bool, clampLimit, datePlusMs, localBoundary, parseJson, stringify } from "./shared.js";

const RETENTION_DAYS = 7;

type CaptureRow = typeof proactiveCaptures.$inferSelect;
type ObservationRow = typeof proactiveObservations.$inferSelect;

function asIso(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return new Date().toISOString();
  return new Date(value).toISOString();
}

function toCapture(row: CaptureRow, includePayload = true, cipher?: ProactiveVaultCipher): ProactiveCaptureModel {
  const payloadText = decodeWithCipher(row.payloadText, cipher, `capture:${row.id}`);
  const payloadJson = decodeWithCipher(row.payloadJson, cipher, `capture:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
    sourceGrantId: row.sourceGrantId,
    sourceKey: row.sourceKey,
    contentType: row.contentType,
    ...(includePayload
      ? { payloadText, payload: parseJson(payloadJson, undefined) }
      : {}),
    checksum: row.checksum,
    byteSize: row.byteSize,
    processingBoundary: localBoundary(row.processingBoundary),
    observedAt: row.observedAt,
    ingestedAt: row.ingestedAt,
    retentionUntil: row.retentionUntil,
    distillationStatus: row.distillationStatus as ProactiveCaptureModel["distillationStatus"],
    distillationAttemptCount: row.distillationAttemptCount,
    lastDistillationError: row.lastDistillationError,
    retentionBlockedAt: row.retentionBlockedAt,
    distilledAt: row.distilledAt,
    distilledMemoryIds: parseJson<string[]>(row.distilledMemoryIdsJson, []),
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toObservation(row: ObservationRow, cipher?: ProactiveVaultCipher): ProactiveBehaviorObservationModel {
  const payloadJson = decodeWithCipher(row.payloadJson, cipher, `observation:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
    sourceGrantId: row.sourceGrantId,
    sourceKey: row.sourceKey,
    observationType: row.observationType,
    subjectKey: decodeWithCipher(row.subjectKey, cipher, `observation:${row.id}`) ?? "",
    payload: parseJson(payloadJson, {}),
    checksum: row.checksum,
    processingBoundary: localBoundary(row.processingBoundary),
    algorithmVersion: row.algorithmVersion,
    observedAt: row.observedAt,
    normalizedAt: row.normalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CaptureStore {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly lifecycle: ProfileLifecycleStore,
    private readonly audit: AuditExportStore,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  async createCapture(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createCapture"]>[1],
  ): Promise<ProactiveCaptureModel> {
    const [existingCapture] = await this.db
      .select()
      .from(proactiveCaptures)
      .where(
        and(
          eq(proactiveCaptures.id, input.id),
        ),
      )
      .limit(1);
    if (existingCapture) {
      if (
        existingCapture.revisionId !== input.revisionId
        || existingCapture.sourceGrantId !== input.sourceGrantId
        || existingCapture.sourceKey !== input.sourceKey
        || existingCapture.checksum !== input.checksum
      ) {
        throw new DomainConflictError("capture idempotency key reused with different content");
      }
      return toCapture(existingCapture, true, this.cipher);
    }
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    if (revision.status !== "active" || revision.desiredState !== "enabled") {
      throw new DomainConflictError("proactive profile is not accepting captures");
    }
    if (!input.checksum.trim()) throw new DomainConflictError("capture checksum is required");
    const [source] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, input.sourceGrantId),
          eq(proactiveSourceGrants.revisionId, revision.id),
          eq(proactiveSourceGrants.sourceKey, input.sourceKey),
        ),
      )
      .limit(1);
    if (!source) throw new RepositoryNotFoundError("proactive source grant not found");
    if (source.state !== "granted") throw new DomainConflictError("source grant is not active");
    const ingestedAt = asIso(input.ingestedAt);
    const observedAt = asIso(input.observedAt ?? ingestedAt);
    const payloadJson = input.payload === undefined ? null : stringify(input.payload, "null");
    const computedSize = input.byteSize ??
      (input.payloadText !== undefined && input.payloadText !== null
        ? new TextEncoder().encode(input.payloadText).byteLength
        : payloadJson
          ? new TextEncoder().encode(payloadJson).byteLength
          : 0);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveCaptures)
      .values({
        id: input.id,
        revisionId: revision.id,
        sourceGrantId: source.id,
        sourceKey: input.sourceKey,
        contentType: input.contentType,
        payloadText: encrypt(input.payloadText ?? null, "capture", input.id, this.cipher) ?? null,
        payloadJson: encrypt(payloadJson, "capture", input.id, this.cipher) ?? null,
        checksum: input.checksum,
        byteSize: computedSize,
        processingBoundary: "local_only",
        observedAt,
        ingestedAt,
        // 业务保留窗口以观察发生时间计算；摄取延迟只用于管道审计。
        retentionUntil: datePlusMs(observedAt, RETENTION_DAYS * 24 * 60 * 60 * 1000),
        distillationStatus: "pending",
        distillationAttemptCount: 0,
        lastDistillationError: null,
        retentionBlockedAt: null,
        distilledMemoryIdsJson: "[]",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive capture");
    // 仅记录元数据；绝不将 payload 写入审计。
    await this.audit.recordAudit(ctx, {
      id: `${input.id}_audit_ingested`,
      revisionId: revision.id,
      eventType: "capture.ingested",
      actorId: "local-host",
      resourceType: "capture",
      resourceId: input.id,
      payload: { sourceKey: input.sourceKey, checksum: input.checksum, byteSize: computedSize },
    });
    return toCapture(created, true, this.cipher);
  }

  async listCaptures(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listCaptures"]>[1],
  ): Promise<ProactiveCaptureModel[]> {
    const conditions = [
    ];
    if (options?.revisionId) conditions.push(eq(proactiveCaptures.revisionId, options.revisionId));
    if (options?.sourceKey) conditions.push(eq(proactiveCaptures.sourceKey, options.sourceKey));
    if (!options?.includeDeleted) conditions.push(isNull(proactiveCaptures.deletedAt));
    const rows = await this.db
      .select()
      .from(proactiveCaptures)
      .where(and(...conditions))
      .orderBy(desc(proactiveCaptures.observedAt))
      .limit(clampLimit(options?.limit));
    return rows.map((row) => toCapture(row, true, this.cipher));
  }

  async createObservation(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createObservation"]>[1],
  ): Promise<ProactiveBehaviorObservationModel> {
    const [existingObservation] = await this.db
      .select()
      .from(proactiveObservations)
      .where(eq(proactiveObservations.id, input.id))
      .limit(1);
    if (existingObservation) {
      if (
        existingObservation.revisionId !== input.revisionId
        || existingObservation.sourceGrantId !== input.sourceGrantId
        || existingObservation.sourceKey !== input.sourceKey
        || existingObservation.checksum !== input.checksum
      ) {
        throw new DomainConflictError("observation idempotency key reused with different content");
      }
      return toObservation(existingObservation, this.cipher);
    }
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    if (revision.status !== "active" || revision.desiredState !== "enabled") {
      throw new DomainConflictError("proactive profile is not accepting observations");
    }
    const [source] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, input.sourceGrantId),
          eq(proactiveSourceGrants.revisionId, revision.id),
          eq(proactiveSourceGrants.sourceKey, input.sourceKey),
        ),
      )
      .limit(1);
    if (!source) throw new RepositoryNotFoundError("proactive source grant not found");
    if (source.state !== "granted") throw new DomainConflictError("source grant is not active");
    const now = new Date().toISOString();
    const observedAt = asIso(input.observedAt);
    const normalizedAt = asIso(input.normalizedAt ?? now);
    const [created] = await this.db
      .insert(proactiveObservations)
      .values({
        id: input.id,
        revisionId: revision.id,
        sourceGrantId: source.id,
        sourceKey: input.sourceKey,
        observationType: input.observationType,
        subjectKey: encrypt(input.subjectKey, "observation", input.id, this.cipher) ?? "",
        payloadJson: encrypt(stringify(input.payload), "observation", input.id, this.cipher) ?? "{}",
        checksum: input.checksum,
        processingBoundary: "local_only",
        algorithmVersion: input.algorithmVersion ?? "local-observation-v1",
        observedAt,
        normalizedAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive observation");
    await this.audit.recordAudit(ctx, {
      id: `${input.id}_audit_normalized`,
      revisionId: revision.id,
      eventType: "observation.normalized",
      actorId: "local-observation-adapter",
      resourceType: "observation",
      resourceId: input.id,
      payload: { sourceKey: input.sourceKey, checksum: input.checksum, algorithmVersion: input.algorithmVersion ?? "local-observation-v1" },
    });
    return toObservation(created, this.cipher);
  }

  async listObservations(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listObservations"]>[1],
  ): Promise<ProactiveBehaviorObservationModel[]> {
    const conditions = [
    ];
    if (options?.revisionId) conditions.push(eq(proactiveObservations.revisionId, options.revisionId));
    if (options?.sourceKey) conditions.push(eq(proactiveObservations.sourceKey, options.sourceKey));
    const rows = await this.db
      .select()
      .from(proactiveObservations)
      .where(and(...conditions))
      .orderBy(desc(proactiveObservations.observedAt))
      .limit(clampLimit(options?.limit));
    return rows.map((row) => toObservation(row, this.cipher));
  }

  async markCaptureDistilled(ctx: LocalContext, captureId: string, memoryIds: string[]): Promise<ProactiveCaptureModel | null> {
    const ids = [...new Set(memoryIds.filter((id) => typeof id === "string" && id.length > 0))];
    if (ids.length === 0) throw new DomainConflictError("at least one memory id is required before capture deletion");
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveCaptures)
      .set({
        distillationStatus: "distilled",
        distilledAt: now,
        distilledMemoryIdsJson: JSON.stringify(ids),
        lastDistillationError: null,
        retentionBlockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveCaptures.id, captureId),
          isNull(proactiveCaptures.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.audit.recordAudit(ctx, {
      id: `${captureId}_audit_distilled_${Date.now().toString(36)}`,
      revisionId: updated.revisionId,
      eventType: "capture.distilled",
      actorId: "local-memory-pipeline",
      resourceType: "capture",
      resourceId: captureId,
      payload: { memoryIds: ids },
    });
    return toCapture(updated, true, this.cipher);
  }

  async markCaptureDistillationFailed(ctx: LocalContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null> {
    const [updated] = await this.db
      .update(proactiveCaptures)
      .set({
        distillationStatus: "failed",
        distillationAttemptCount: sql`${proactiveCaptures.distillationAttemptCount} + 1`,
        lastDistillationError: reason ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(proactiveCaptures.id, captureId),
          isNull(proactiveCaptures.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.audit.recordAudit(ctx, {
      id: `${captureId}_audit_distill_failed_${Date.now().toString(36)}`,
      revisionId: updated.revisionId,
      eventType: "capture.distillation_failed",
      actorId: "local-memory-pipeline",
      resourceType: "capture",
      resourceId: captureId,
      payload: reason ? { reason } : {},
    });
    return toCapture(updated, true, this.cipher);
  }

  async purgeEligibleCaptures(ctx?: LocalContext, now = new Date().toISOString(), limit = 200): Promise<number> {
    const conditions = [
      lte(proactiveCaptures.retentionUntil, now),
      eq(proactiveCaptures.distillationStatus, "distilled"),
      isNull(proactiveCaptures.deletedAt),
    ];
    // 到期但尚未提炼的副本进入 blocked，而不是被删除；这会给 Worker 一个
    // 可观测的告警状态，后续仍可在本地完成提炼后再清理。
    const blockedConditions = [
      lte(proactiveCaptures.retentionUntil, now),
      inArray(proactiveCaptures.distillationStatus, ["pending", "failed"]),
      isNull(proactiveCaptures.deletedAt),
    ];
    const blockedRows = await this.db
      .select({ id: proactiveCaptures.id, revisionId: proactiveCaptures.revisionId })
      .from(proactiveCaptures)
      .where(and(...blockedConditions))
      .limit(clampLimit(limit, 200));
    if (blockedRows.length > 0) {
      const blockedAt = new Date().toISOString();
      await this.db
        .update(proactiveCaptures)
        .set({
          distillationStatus: "blocked",
          retentionBlockedAt: blockedAt,
          lastDistillationError: "retention_expired_before_distillation",
          updatedAt: blockedAt,
        })
        .where(
          and(
            inArray(proactiveCaptures.id, blockedRows.map((row) => row.id)),
            inArray(proactiveCaptures.distillationStatus, ["pending", "failed"]),
            isNull(proactiveCaptures.deletedAt),
          ),
        );
      // 每个租户分别写一条不含正文的 retention blocked 告警。
      for (const row of blockedRows) {
        await this.db.insert(proactiveAuditEvents).values({
          id: `${row.id}_audit_retention_blocked_${Date.now().toString(36)}`,
          revisionId: row.revisionId,
          eventType: "capture.retention_blocked",
          actorId: "local-retention-worker",
          resourceType: "capture",
          resourceId: row.id,
          payloadJson: JSON.stringify({ reason: "retention_expired_before_distillation" }),
          processingBoundary: "local_only",
          occurredAt: blockedAt,
          createdAt: blockedAt,
        });
      }
    }

    const rows = await this.db
      .select({ id: proactiveCaptures.id })
      .from(proactiveCaptures)
      .where(and(...conditions))
      .orderBy(asc(proactiveCaptures.retentionUntil))
      .limit(clampLimit(limit, 200));
    if (rows.length === 0) return 0;
    const deletedAt = new Date().toISOString();
    const updated = await this.db
      .update(proactiveCaptures)
      .set({ payloadText: null, payloadJson: null, byteSize: 0, distillationStatus: "deleted", deletedAt, updatedAt: deletedAt })
      .where(
        and(
          inArray(proactiveCaptures.id, rows.map((row) => row.id)),
          eq(proactiveCaptures.distillationStatus, "distilled"),
          isNull(proactiveCaptures.deletedAt),
        ),
      )
      .returning({ id: proactiveCaptures.id });
    return updated.length;
  }

  async listCaptureRows(ctx: LocalContext, includeRaw: boolean): Promise<ProactiveCaptureModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveCaptures)
      .where(
        and(
        ),
      )
      .orderBy(desc(proactiveCaptures.observedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map((row) => toCapture(row, includeRaw, this.cipher));
  }
}
