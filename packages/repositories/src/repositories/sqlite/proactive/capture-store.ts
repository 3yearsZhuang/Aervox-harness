/**
 * Aervox｜思隅 @aervox/repositories — 原始捕获/观察数据摄取、提炼与保留清理 Store
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  proactiveAuditEvents,
  proactiveCaptures,
  proactiveObservations,
  proactiveProfileClaims,
  proactiveProfileRevisions,
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
import { captureDistillationFailureCode, captureDistillationReceiptId, findEligibleCaptureDistillation,
  publishCaptureDistillation } from "./capture-distillation-store.js";
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

  publishCaptureDistillation(ctx: LocalContext, input: Parameters<IProactiveProfileRepository["publishCaptureDistillation"]>[1]) {
    return publishCaptureDistillation(this.db, this.cipher, input);
  }

  /** Select and decode the exact work batch; presentation windows never determine queue visibility. */
  async listDistillationCandidates(ctx: LocalContext, options: { retryBefore: string; limit?: number }): Promise<ProactiveCaptureModel[]> {
    const rows = await this.db.select({ capture: proactiveCaptures }).from(proactiveCaptures)
      .innerJoin(proactiveProfileRevisions, eq(proactiveProfileRevisions.id, proactiveCaptures.revisionId))
      .innerJoin(proactiveSourceGrants, eq(proactiveSourceGrants.id, proactiveCaptures.sourceGrantId))
      .where(and(isNull(proactiveCaptures.deletedAt), eq(proactiveProfileRevisions.status, "active"),
        eq(proactiveProfileRevisions.desiredState, "enabled"), eq(proactiveSourceGrants.state, "granted"),
        or(eq(proactiveCaptures.distillationStatus, "pending"),
          and(inArray(proactiveCaptures.distillationStatus, ["failed", "blocked"]), lte(proactiveCaptures.updatedAt, options.retryBefore)))))
      .orderBy(asc(proactiveCaptures.ingestedAt), asc(proactiveCaptures.id)).limit(clampLimit(options.limit, 50));
    return rows.map(row => toCapture(row.capture, true, this.cipher));
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
    const ids = [...new Set(memoryIds.filter((id) => typeof id === "string" && id.trim().length > 0))];
    if (ids.length === 0) throw new DomainConflictError("at least one memory id is required before capture deletion");
    return this.db.transaction(async tx => {
      const capture = await findEligibleCaptureDistillation(tx, captureId);
      if (!capture) return null;
      const [receipt] = await tx.select().from(proactiveAuditEvents)
        .where(eq(proactiveAuditEvents.id, captureDistillationReceiptId(captureId)));
      if (receipt && capture.distillationStatus !== "distilled") {
        throw new DomainConflictError("capture_distillation_receipt_unavailable");
      }
      if (capture.distillationStatus === "distilled"
        && JSON.stringify(ids) !== capture.distilledMemoryIdsJson) {
        throw new DomainConflictError("capture_distillation_intent_mismatch");
      }
      if (receipt) {
        const metadata = parseJson<{ version?: number; memoryIds?: string[] }>(receipt.payloadJson, {});
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
          || receipt.eventType !== "capture.distilled" || receipt.resourceType !== "capture" || receipt.resourceId !== captureId
          || receipt.revisionId !== capture.revisionId || receipt.processingBoundary !== "local_only" || metadata.version !== 1
          || JSON.stringify(metadata.memoryIds) !== capture.distilledMemoryIdsJson) {
          throw new DomainConflictError("capture_distillation_receipt_unavailable");
        }
      }
      // A manual completion is an explicit declaration, but every declared result must exist
      // and retain this capture's source provenance. Arbitrary IDs cannot unlock raw deletion.
      const claims = await tx.select().from(proactiveProfileClaims).where(inArray(proactiveProfileClaims.id, ids));
      const observations = await tx.select().from(proactiveObservations).where(inArray(proactiveObservations.id, ids));
      for (const id of ids) {
        const claim = claims.find(row => row.id === id);
        const observation = observations.find(row => row.id === id);
        const validClaim = claim?.revisionId === capture.revisionId && claim.processingBoundary === "local_only"
          && parseJson<string[]>(claim.evidenceCaptureIdsJson, []).includes(captureId)
          && parseJson<string[]>(claim.sourceGrantIdsJson, []).includes(capture.sourceGrantId);
        const validObservation = observation?.revisionId === capture.revisionId
          && observation.processingBoundary === "local_only" && observation.sourceGrantId === capture.sourceGrantId
          && observation.sourceKey === capture.sourceKey && observation.checksum === capture.checksum
          && parseJson<{ captureId?: string }>(decodeWithCipher(observation.payloadJson, this.cipher, `observation:${id}`), {}).captureId === captureId;
        if (!validClaim && !validObservation) throw new DomainConflictError("capture_distillation_result_unavailable");
      }
      if (capture.distillationStatus === "distilled") return toCapture(capture, true, this.cipher);
      const now = new Date().toISOString();
      const [updated] = await tx.update(proactiveCaptures).set({ distillationStatus: "distilled", distilledAt: now,
        distilledMemoryIdsJson: JSON.stringify(ids), lastDistillationError: null, retentionBlockedAt: null, updatedAt: now })
        .where(eq(proactiveCaptures.id, captureId)).returning();
      await tx.insert(proactiveAuditEvents).values({ id: `${captureDistillationReceiptId(captureId)}_manual`,
        revisionId: capture.revisionId, eventType: "capture.distilled", actorId: "local-memory-pipeline",
        resourceType: "capture", resourceId: captureId, payloadJson: JSON.stringify({ origin: "manual", memoryIds: ids }),
        processingBoundary: "local_only", occurredAt: now, createdAt: now });
      return updated ? toCapture(updated, true, this.cipher) : null;
    }, { behavior: "immediate" });
  }

  async markCaptureDistillationFailed(ctx: LocalContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null> {
    const code = captureDistillationFailureCode(reason);
    return this.db.transaction(async tx => {
      const capture = await findEligibleCaptureDistillation(tx, captureId);
      if (!capture || capture.distillationStatus === "distilled") return null;
      const now = new Date().toISOString();
      const [updated] = await tx.update(proactiveCaptures).set({ distillationStatus: "failed",
        distillationAttemptCount: sql`${proactiveCaptures.distillationAttemptCount} + 1`, lastDistillationError: code, updatedAt: now })
        .where(eq(proactiveCaptures.id, captureId)).returning();
      await tx.insert(proactiveAuditEvents).values({ id: `${captureId}_audit_distill_failed_${randomUUID()}`,
        revisionId: capture.revisionId, eventType: "capture.distillation_failed", actorId: "local-memory-pipeline",
        resourceType: "capture", resourceId: captureId, payloadJson: JSON.stringify({ reason: code }),
        processingBoundary: "local_only", occurredAt: now, createdAt: now });
      return updated ? toCapture(updated, true, this.cipher) : null;
    }, { behavior: "immediate" });
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
      // 每条受阻 capture 分别写一条不含正文的 retention blocked 告警。
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
      .orderBy(desc(proactiveCaptures.observedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map((row) => toCapture(row, includeRaw, this.cipher));
  }
}
