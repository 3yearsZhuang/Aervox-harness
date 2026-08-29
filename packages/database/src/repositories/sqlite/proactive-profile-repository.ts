/**
 * Aervox｜思隅 @aervox/database — CAP-033 主动智能模式 SQLite 仓储
 *
 * 本仓储是主动画像数据的唯一数据库入口。它不使用 outbox，也不把原始捕获
 * 写入普通 analytics/audit 表；所有读取和写入都强制带租户边界。
 */
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  FULL_PROFILE_SOURCE_MANIFEST,
  proactiveActions,
  proactiveActivationLeases,
  proactiveAuditEvents,
  proactiveCaptures,
  consentGrants,
  proactiveProfileClaims,
  proactiveProfileRevisions,
  proactiveObservations,
  proactiveSourceGrants,
} from "../../schema/index.js";
import { DomainConflictError, NotFoundInTenantError } from "../../errors.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { ProactiveVaultCipher } from "../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveActionModel,
  ProactiveActivationLeaseModel,
  ProactiveAuditEventModel,
  ProactiveCaptureModel,
  ProactiveBehaviorObservationModel,
  ProactiveClaimState,
  ProactiveConsentModel,
  ProactiveEffectiveStatus,
  ProactiveProfileClaimModel,
  ProactiveProfileRevisionModel,
  ProactiveSourceGrantModel,
  ProactiveSourceDeletionResult,
} from "../types.js";

const RETENTION_DAYS = 7;
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const MAX_LIST_LIMIT = 500;

type RevisionRow = typeof proactiveProfileRevisions.$inferSelect;
type SourceRow = typeof proactiveSourceGrants.$inferSelect;
type LeaseRow = typeof proactiveActivationLeases.$inferSelect;
type CaptureRow = typeof proactiveCaptures.$inferSelect;
type ObservationRow = typeof proactiveObservations.$inferSelect;
type ClaimRow = typeof proactiveProfileClaims.$inferSelect;
type ActionRow = typeof proactiveActions.$inferSelect;
type AuditRow = typeof proactiveAuditEvents.$inferSelect;

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown, fallback = "{}"): string {
  if (value === undefined) return fallback;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? fallback : encoded;
  } catch {
    return fallback;
  }
}

function clampLimit(value: number | undefined, fallback = 100): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value!)));
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function localBoundary(value: string): "local_only" {
  if (value !== "local_only") throw new DomainConflictError("proactive record is outside the local-only boundary");
  return "local_only";
}

function datePlusMs(iso: string, ms: number): string {
  const timestamp = Date.parse(iso);
  const base = Number.isFinite(timestamp) ? timestamp : Date.now();
  return new Date(base + ms).toISOString();
}

function asIso(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return new Date().toISOString();
  return new Date(value).toISOString();
}

function sourceDefaults(sourceKey: string): { purpose: string; osCapability: string } {
  const found = FULL_PROFILE_SOURCE_MANIFEST.find((item) => item.sourceKey === sourceKey);
  return found ?? { purpose: "profile.observe", osCapability: `os.${sourceKey}` };
}

const ACTION_SCOPES = new Set(["action.local", "action.external", "action.privileged", "action.irreversible"]);

function parseActionScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function toRevision(row: RevisionRow, cipher?: ProactiveVaultCipher): ProactiveProfileRevisionModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    profileVersion: row.profileVersion,
    revision: row.revision,
    deviceId: row.deviceId,
    desiredState: row.desiredState as ProactiveProfileRevisionModel["desiredState"],
    status: row.status as ProactiveProfileRevisionModel["status"],
    fullAccessRequired: bool(row.fullAccessRequired),
    processingBoundary: localBoundary(row.processingBoundary),
    manifest: parseJson(decodeWithCipher(row.manifestJson, cipher, `profile:${row.id}`), {}),
    grantSetHash: row.grantSetHash,
    confirmedAt: row.confirmedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSource(row: SourceRow, cipher?: ProactiveVaultCipher): ProactiveSourceGrantModel {
  return {
    id: row.id,
    revisionId: row.revisionId,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    sourceKey: row.sourceKey,
    purpose: row.purpose,
    scope: row.scope,
    osCapability: row.osCapability,
    state: row.state as ProactiveSourceGrantModel["state"],
    mandatory: bool(row.mandatory),
    processingBoundary: localBoundary(row.processingBoundary),
    grantVersion: row.grantVersion,
    metadata: parseJson(decodeWithCipher(row.metadataJson, cipher, `source:${row.id}`), {}),
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    lastVerifiedAt: row.lastVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLease(row: LeaseRow): ProactiveActivationLeaseModel {
  return {
    id: row.id,
    revisionId: row.revisionId,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    deviceId: row.deviceId,
    epoch: row.epoch,
    status: row.status as ProactiveActivationLeaseModel["status"],
    localReady: bool(row.localReady),
    fullAccessSnapshot: bool(row.fullAccessSnapshot),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    heartbeatAt: row.heartbeatAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    metadata: parseJson(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function decodeWithCipher(
  value: string | null | undefined,
  cipher: ProactiveVaultCipher | undefined,
  associatedData: string,
): string | null | undefined {
  if (value === null || value === undefined || !cipher || !cipher.isEncrypted(value)) return value;
  return cipher.decrypt(value, associatedData);
}

function toCapture(row: CaptureRow, includePayload = true, cipher?: ProactiveVaultCipher): ProactiveCaptureModel {
  const payloadText = decodeWithCipher(row.payloadText, cipher, `capture:${row.id}`);
  const payloadJson = decodeWithCipher(row.payloadJson, cipher, `capture:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
    sourceGrantId: row.sourceGrantId,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
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
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
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

function toClaim(row: ClaimRow, cipher?: ProactiveVaultCipher): ProactiveProfileClaimModel {
  const evidenceRefsJson = decodeWithCipher(row.evidenceRefsJson, cipher, `claim:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    claimType: row.claimType,
    subjectKey: decodeWithCipher(row.subjectKey, cipher, `claim:${row.id}`) ?? "",
    content: decodeWithCipher(row.content, cipher, `claim:${row.id}`) ?? "",
    state: row.state as ProactiveClaimState,
    confidence: row.confidence,
    algorithmVersion: row.algorithmVersion,
    processingBoundary: localBoundary(row.processingBoundary),
    evidenceCaptureIds: parseJson<string[]>(row.evidenceCaptureIdsJson, []),
    evidenceRefs: parseJson<unknown[]>(evidenceRefsJson, []),
    sourceGrantIds: parseJson<string[]>(row.sourceGrantIdsJson, []),
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    confirmedAt: row.confirmedAt,
    rejectedAt: row.rejectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAction(row: ActionRow, cipher?: ProactiveVaultCipher): ProactiveActionModel {
  const requestJson = decodeWithCipher(row.requestJson, cipher, `action:${row.id}`);
  const outcomeJson = decodeWithCipher(row.outcomeJson, cipher, `action:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
    activationLeaseId: row.activationLeaseId,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    actionType: row.actionType,
    target: decodeWithCipher(row.target, cipher, `action:${row.id}`) ?? "",
    request: parseJson(requestJson, {}),
    authorizationScope: row.authorizationScope,
    actionGrantRevision: row.actionGrantRevision,
    state: row.state as ProactiveActionModel["state"],
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    reversible: bool(row.reversible),
    external: bool(row.external),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outcome: parseJson(outcomeJson, undefined),
    error: decodeWithCipher(row.error, cipher, `action:${row.id}`),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toAudit(row: AuditRow): ProactiveAuditEventModel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectUserId: row.subjectUserId,
    revisionId: row.revisionId,
    eventType: row.eventType,
    actorId: row.actorId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    payload: parseJson(row.payloadJson, {}),
    processingBoundary: localBoundary(row.processingBoundary),
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

export class SqliteProactiveProfileRepository implements IProactiveProfileRepository {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  private encrypt(value: string | null | undefined, resourceType: string, resourceId: string): string | null | undefined {
    if (value === null || value === undefined || !this.cipher) return value;
    if (this.cipher.isEncrypted(value)) return value;
    return this.cipher.encrypt(value, `${resourceType}:${resourceId}`);
  }

  async confirmProfile(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["confirmProfile"]>[1],
  ): Promise<{ revision: ProactiveProfileRevisionModel; sources: ProactiveSourceGrantModel[] }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const profileVersion = input.profileVersion ?? "full_profile_v1";

    // id 作为客户端幂等键：重复确认不会产生第二份修订。
    const [existing] = await this.db
      .select()
      .from(proactiveProfileRevisions)
      .where(
        and(
          eq(proactiveProfileRevisions.id, input.id),
          eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
          eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        revision: toRevision(existing, this.cipher),
        sources: await this.listSourceGrants(tenant, existing.id),
      };
    }

    return this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ revision: proactiveProfileRevisions.revision })
        .from(proactiveProfileRevisions)
        .where(
          and(
            eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
            eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
            eq(proactiveProfileRevisions.profileVersion, profileVersion),
            eq(proactiveProfileRevisions.deviceId, input.deviceId),
          ),
        )
        .orderBy(desc(proactiveProfileRevisions.revision))
        .limit(1);
      const revisionNumber = (latest?.revision ?? 0) + 1;

      // 同一设备同一版本只保留一个 active 修订，历史修订仍可导出。
      await tx
        .update(proactiveProfileRevisions)
        .set({ status: "superseded", updatedAt: now })
        .where(
          and(
            eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
            eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
            eq(proactiveProfileRevisions.profileVersion, profileVersion),
            eq(proactiveProfileRevisions.deviceId, input.deviceId),
            eq(proactiveProfileRevisions.status, "active"),
          ),
        );

      const [revisionRow] = await tx
        .insert(proactiveProfileRevisions)
        .values({
          id: input.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          profileVersion,
          revision: revisionNumber,
          deviceId: input.deviceId,
          desiredState: "enabled",
          status: "active",
          fullAccessRequired: true,
          processingBoundary: "local_only",
          manifestJson: this.encrypt(
            stringify(input.manifest ?? { profileVersion, sources: FULL_PROFILE_SOURCE_MANIFEST }),
            "profile",
            input.id,
          ) ?? "{}",
          grantSetHash: input.grantSetHash ?? null,
          confirmedAt: now,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!revisionRow) throw new Error("failed to create proactive profile revision");

      const sourceInputs = input.sources?.length
        ? input.sources
        : FULL_PROFILE_SOURCE_MANIFEST.map((item, index) => ({
            id: `${input.id}_source_${index + 1}`,
            sourceKey: item.sourceKey,
            purpose: item.purpose,
            scope: "all",
            osCapability: item.osCapability,
            // 未收到 OS/adapter 回执时只能是 requested；显式 sources.state=granted
            // 才能让该能力参与 effectiveGrantSet。mandatory 以服务端 manifest 为准。
            state: "requested" as const,
            mandatory: item.mandatory,
            grantVersion: 1,
            metadata: {},
            grantedAt: null,
            lastVerifiedAt: null,
          }));
      const deduped = new Map(sourceInputs.map((source) => [source.sourceKey, source]));
      const sourceRows: SourceRow[] = [];
      for (const source of deduped.values()) {
        const defaults = sourceDefaults(source.sourceKey);
        const state = source.state ?? "granted";
        const [row] = await tx
          .insert(proactiveSourceGrants)
          .values({
            id: source.id,
            revisionId: revisionRow.id,
            workspaceId: tenant.workspaceId,
            subjectUserId: tenant.subjectUserId,
            sourceKey: source.sourceKey,
            purpose: source.purpose ?? defaults.purpose,
            scope: source.scope ?? "all",
            osCapability: source.osCapability ?? defaults.osCapability,
            state,
            mandatory: source.mandatory ?? true,
            processingBoundary: "local_only",
            grantVersion: source.grantVersion ?? 1,
            metadataJson: this.encrypt(stringify(source.metadata), "source", source.id) ?? "{}",
            grantedAt: state === "granted" ? source.grantedAt ?? now : null,
            revokedAt: state === "revoked" ? now : null,
            lastVerifiedAt: source.lastVerifiedAt ?? (state === "granted" ? now : null),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (row) sourceRows.push(row);
      }

      // Project the user's separate proactive-purpose consent in the same Vault
      // transaction. A new profile revision supersedes prior source consents;
      // revocation remains explicit and queryable in the privacy domain.
      for (const source of sourceRows) {
        await tx
          .update(consentGrants)
          .set({ revokedAt: now })
          .where(
            and(
              eq(consentGrants.workspaceId, tenant.workspaceId),
              eq(consentGrants.subjectUserId, tenant.subjectUserId),
              eq(consentGrants.purpose, "proactive_profile"),
              eq(consentGrants.scope, source.sourceKey),
              sql`${consentGrants.revokedAt} IS NULL`,
            ),
          );
        await tx
          .insert(consentGrants)
          .values({
            id: `${input.id}_consent_${source.sourceKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
            workspaceId: tenant.workspaceId,
            subjectUserId: tenant.subjectUserId,
            actorId: input.actorId,
            purpose: "proactive_profile",
            scope: source.sourceKey,
            policyVersion: profileVersion,
            grantedAt: now,
            revokedAt: null,
            createdAt: now,
          });
      }

      await tx.insert(proactiveAuditEvents).values({
        id: `${input.id}_audit_confirmed`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        revisionId: revisionRow.id,
        eventType: "profile.confirmed",
        actorId: input.actorId,
        resourceType: "profile_revision",
        resourceId: revisionRow.id,
        payloadJson: stringify({ profileVersion, revision: revisionNumber, sourceCount: sourceRows.length }),
        processingBoundary: "local_only",
        occurredAt: now,
        createdAt: now,
      });
      return {
        revision: toRevision(revisionRow, this.cipher),
        sources: sourceRows.map((row) => toSource(row, this.cipher)),
      };
    });
  }

  async createDraft(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createDraft"]>[1],
  ): Promise<ProactiveProfileRevisionModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const profileVersion = input.profileVersion ?? "full_profile_v1";
    const [latest] = await this.db
      .select({ revision: proactiveProfileRevisions.revision })
      .from(proactiveProfileRevisions)
      .where(
        and(
          eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
          eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
          eq(proactiveProfileRevisions.profileVersion, profileVersion),
          eq(proactiveProfileRevisions.deviceId, input.deviceId),
        ),
      )
      .orderBy(desc(proactiveProfileRevisions.revision))
      .limit(1);
    const [created] = await this.db
      .insert(proactiveProfileRevisions)
      .values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        profileVersion,
        revision: (latest?.revision ?? 0) + 1,
        deviceId: input.deviceId,
        desiredState: "none",
        status: "draft",
        fullAccessRequired: true,
        processingBoundary: "local_only",
        manifestJson: this.encrypt(
          stringify(input.manifest ?? { profileVersion, sources: FULL_PROFILE_SOURCE_MANIFEST }),
          "profile",
          input.id,
        ) ?? "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive profile draft");
    await this.recordAudit(tenant, {
      id: `${input.id}_audit_draft`,
      revisionId: input.id,
      eventType: "profile.draft_created",
      actorId: input.actorId,
      resourceType: "profile_revision",
      resourceId: input.id,
    });
    return toRevision(created, this.cipher);
  }

  async getRevision(tenant: TenantContext, revisionId?: string): Promise<ProactiveProfileRevisionModel | null> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
      eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
    ];
    if (revisionId) conditions.push(eq(proactiveProfileRevisions.id, revisionId));
    const [row] = await this.db
      .select()
      .from(proactiveProfileRevisions)
      .where(and(...conditions))
      .orderBy(desc(proactiveProfileRevisions.revision))
      .limit(1);
    return row ? toRevision(row, this.cipher) : null;
  }

  async listRevisions(tenant: TenantContext, limit?: number): Promise<ProactiveProfileRevisionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(proactiveProfileRevisions)
      .where(
        and(
          eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
          eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(proactiveProfileRevisions.revision))
      .limit(clampLimit(limit));
    return rows.map((row) => toRevision(row, this.cipher));
  }

  async setDesiredState(
    tenant: TenantContext,
    state: Parameters<IProactiveProfileRepository["setDesiredState"]>[1],
    actorId: string,
    revisionId?: string,
  ): Promise<ProactiveProfileRevisionModel | null> {
    assertTenantContext(tenant);
    const revision = await this.getRevision(tenant, revisionId);
    if (!revision) return null;
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveProfileRevisions)
      .set({
        desiredState: state,
        status: state === "revoked" ? "revoked" : revision.status,
        revokedAt: state === "revoked" ? now : revision.revokedAt ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveProfileRevisions.id, revision.id),
          eq(proactiveProfileRevisions.workspaceId, tenant.workspaceId),
          eq(proactiveProfileRevisions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    if (!updated) return null;
    if (state === "revoked") {
      await this.db
        .update(consentGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(consentGrants.workspaceId, tenant.workspaceId),
            eq(consentGrants.subjectUserId, tenant.subjectUserId),
            eq(consentGrants.purpose, "proactive_profile"),
            sql`${consentGrants.revokedAt} IS NULL`,
          ),
        );
    }
    await this.recordAudit(tenant, {
      id: `${revision.id}_audit_state_${Date.now().toString(36)}`,
      revisionId: revision.id,
      eventType: `profile.desired_${state}`,
      actorId,
      resourceType: "profile_revision",
      resourceId: revision.id,
      payload: { desiredState: state },
    });
    return toRevision(updated, this.cipher);
  }

  async listSourceGrants(tenant: TenantContext, revisionId?: string): Promise<ProactiveSourceGrantModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
      eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
    ];
    if (revisionId) conditions.push(eq(proactiveSourceGrants.revisionId, revisionId));
    const rows = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(and(...conditions))
      .orderBy(asc(proactiveSourceGrants.sourceKey));
    return rows.map((row) => toSource(row, this.cipher));
  }

  async updateSourceGrant(
    tenant: TenantContext,
    sourceGrantId: string,
    input: Parameters<IProactiveProfileRepository["updateSourceGrant"]>[2],
  ): Promise<ProactiveSourceGrantModel | null> {
    assertTenantContext(tenant);
    const [existing] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
          eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
          eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveSourceGrants)
      .set({
        state: input.state,
        metadataJson: input.metadata === undefined
          ? existing.metadataJson
          : this.encrypt(stringify(input.metadata), "source", sourceGrantId) ?? "{}",
        grantedAt: input.state === "granted" ? existing.grantedAt ?? now : existing.grantedAt,
        revokedAt: input.state === "revoked" || input.state === "expired" ? now : null,
        lastVerifiedAt: input.lastVerifiedAt === undefined ? existing.lastVerifiedAt : input.lastVerifiedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
          eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
          eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    if (!updated) return null;
    if (input.state === "revoked" || input.state === "expired") {
      await this.db
        .update(consentGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(consentGrants.workspaceId, tenant.workspaceId),
            eq(consentGrants.subjectUserId, tenant.subjectUserId),
            eq(consentGrants.purpose, "proactive_profile"),
            eq(consentGrants.scope, existing.sourceKey),
            sql`${consentGrants.revokedAt} IS NULL`,
          ),
        );
    }
    await this.recordAudit(tenant, {
      id: `${sourceGrantId}_audit_${Date.now().toString(36)}`,
      revisionId: existing.revisionId,
      eventType: `source.${input.state}`,
      actorId: input.actorId,
      resourceType: "source_grant",
      resourceId: sourceGrantId,
      payload: { sourceKey: existing.sourceKey, state: input.state },
    });
    return toSource(updated, this.cipher);
  }

  async deleteSourceData(
    tenant: TenantContext,
    sourceGrantId: string,
    actorId: string,
  ): Promise<ProactiveSourceDeletionResult | null> {
    assertTenantContext(tenant);
    const [source] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
          eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
          eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!source) return null;

    const now = new Date().toISOString();
    const result = await this.db.transaction(async (tx) => {
      const captures = await tx
        .update(proactiveCaptures)
        .set({
          payloadText: null,
          payloadJson: null,
          byteSize: 0,
          distillationStatus: "deleted",
          deletedAt: now,
          lastDistillationError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(proactiveCaptures.sourceGrantId, sourceGrantId),
            eq(proactiveCaptures.workspaceId, tenant.workspaceId),
            eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
            isNull(proactiveCaptures.deletedAt),
          ),
        )
        .returning({ id: proactiveCaptures.id });

      const observations = await tx
        .delete(proactiveObservations)
        .where(
          and(
            eq(proactiveObservations.sourceGrantId, sourceGrantId),
            eq(proactiveObservations.workspaceId, tenant.workspaceId),
            eq(proactiveObservations.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning({ id: proactiveObservations.id });

      const claimRows = await tx
        .select({ id: proactiveProfileClaims.id, sourceGrantIdsJson: proactiveProfileClaims.sourceGrantIdsJson })
        .from(proactiveProfileClaims)
        .where(
          and(
            eq(proactiveProfileClaims.revisionId, source.revisionId),
            eq(proactiveProfileClaims.workspaceId, tenant.workspaceId),
            eq(proactiveProfileClaims.subjectUserId, tenant.subjectUserId),
          ),
        );
      const claimIds = claimRows
        .filter((row) => parseJson<string[]>(row.sourceGrantIdsJson, []).includes(sourceGrantId))
        .map((row) => row.id);
      const claims = claimIds.length > 0
        ? await tx.delete(proactiveProfileClaims)
          .where(
            and(
              inArray(proactiveProfileClaims.id, claimIds),
              eq(proactiveProfileClaims.workspaceId, tenant.workspaceId),
              eq(proactiveProfileClaims.subjectUserId, tenant.subjectUserId),
            ),
          )
          .returning({ id: proactiveProfileClaims.id })
        : [];

      const actionRows = source.sourceKey.startsWith("action.")
        ? await tx.select().from(proactiveActions).where(
          and(
            eq(proactiveActions.revisionId, source.revisionId),
            eq(proactiveActions.workspaceId, tenant.workspaceId),
            eq(proactiveActions.subjectUserId, tenant.subjectUserId),
          ),
        )
        : [];
      const matchingActions = actionRows.filter((row) =>
        parseActionScopes(row.authorizationScope).includes(source.sourceKey),
      );
      for (const action of matchingActions) {
        const terminal = ["executed", "denied", "failed", "revoked"].includes(action.state);
        await tx
          .update(proactiveActions)
          .set({
            state: terminal ? action.state : "revoked",
            target: this.encrypt("[deleted]", "action", action.id) ?? "[deleted]",
            requestJson: this.encrypt("{}", "action", action.id) ?? "{}",
            outcomeJson: null,
            error: null,
            finishedAt: terminal ? action.finishedAt : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(proactiveActions.id, action.id),
              eq(proactiveActions.workspaceId, tenant.workspaceId),
              eq(proactiveActions.subjectUserId, tenant.subjectUserId),
            ),
          );
      }

      await tx
        .update(proactiveSourceGrants)
        .set({ state: "revoked", revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(proactiveSourceGrants.id, sourceGrantId),
            eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
            eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
          ),
        );
      await tx
        .update(consentGrants)
        .set({ revokedAt: now })
        .where(
          and(
            eq(consentGrants.workspaceId, tenant.workspaceId),
            eq(consentGrants.subjectUserId, tenant.subjectUserId),
            eq(consentGrants.purpose, "proactive_profile"),
            eq(consentGrants.scope, source.sourceKey),
            sql`${consentGrants.revokedAt} IS NULL`,
          ),
        );

      return {
        sourceGrantId,
        capturesScrubbed: captures.length,
        observationsDeleted: observations.length,
        claimsDeleted: claims.length,
        actionsScrubbed: matchingActions.length,
      };
    });

    await this.recordAudit(tenant, {
      id: `${sourceGrantId}_audit_data_deleted_${Date.now().toString(36)}`,
      revisionId: source.revisionId,
      eventType: "source.data_deleted",
      actorId,
      resourceType: "source_grant",
      resourceId: sourceGrantId,
      payload: result,
    });
    return result;
  }

  async createActivationLease(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createActivationLease"]>[1],
  ): Promise<ProactiveActivationLeaseModel> {
    assertTenantContext(tenant);
    const revision = await this.getRevision(tenant, input.revisionId);
    if (!revision) throw new NotFoundInTenantError("proactive profile revision not found");
    const now = new Date().toISOString();
    const expiresAt = datePlusMs(now, input.ttlMs ?? DEFAULT_LEASE_TTL_MS);
    await this.db
      .update(proactiveActivationLeases)
      .set({ status: "ended", endedAt: now, endReason: "superseded", updatedAt: now })
      .where(
        and(
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
          eq(proactiveActivationLeases.deviceId, input.deviceId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      );
    const [created] = await this.db
      .insert(proactiveActivationLeases)
      .values({
        id: input.id,
        revisionId: revision.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
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
    if (!created) throw new Error("failed to create proactive activation lease");
    await this.recordAudit(tenant, {
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

  async heartbeatActivationLease(
    tenant: TenantContext,
    leaseId: string,
    input: Parameters<IProactiveProfileRepository["heartbeatActivationLease"]>[2],
  ): Promise<ProactiveActivationLeaseModel | null> {
    assertTenantContext(tenant);
    const [existing] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
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
      return this.getLease(tenant, leaseId);
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
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return updated ? toLease(updated) : null;
  }

  async endActivationLease(tenant: TenantContext, leaseId: string, reason: string, actorId: string): Promise<ProactiveActivationLeaseModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveActivationLeases)
      .set({ status: "ended", endedAt: now, endReason: reason, updatedAt: now })
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.recordAudit(tenant, {
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

  private async getLease(tenant: TenantContext, leaseId: string): Promise<ProactiveActivationLeaseModel | null> {
    const [row] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.id, leaseId),
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return row ? toLease(row) : null;
  }

  async getEffectiveStatus(tenant: TenantContext, now = new Date().toISOString()): Promise<ProactiveEffectiveStatus> {
    assertTenantContext(tenant);
    const revision = await this.getRevision(tenant);
    if (!revision) {
      return {
        desiredState: "none",
        effectiveState: "inactive",
        reason: "no_profile_grant",
        revision: null,
        sources: [],
        activationLease: null,
        mandatorySources: { total: 0, granted: 0, missing: [] },
        expiredUndistilledCaptures: 0,
      };
    }
    const sources = await this.listSourceGrants(tenant, revision.id);
    const mandatory = sources.filter((source) => source.mandatory);
    const missing = mandatory.filter((source) => source.state !== "granted").map((source) => source.sourceKey);
    const granted = mandatory.length - missing.length;
    const [leaseRow] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.revisionId, revision.id),
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
          eq(proactiveActivationLeases.status, "active"),
        ),
      )
      .orderBy(desc(proactiveActivationLeases.heartbeatAt))
      .limit(1);
    let lease = leaseRow ? toLease(leaseRow) : null;
    if (lease && Date.parse(lease.expiresAt) <= Date.parse(now)) {
      await this.db
        .update(proactiveActivationLeases)
        .set({ status: "expired", endedAt: now, endReason: "lease_expired", updatedAt: now })
        .where(eq(proactiveActivationLeases.id, lease.id));
      lease = { ...lease, status: "expired", endedAt: now, endReason: "lease_expired" };
    }
    const [expiredRow] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(proactiveCaptures)
      .where(
        and(
          eq(proactiveCaptures.workspaceId, tenant.workspaceId),
          eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
          lte(proactiveCaptures.retentionUntil, now),
          isNull(proactiveCaptures.deletedAt),
          inArray(proactiveCaptures.distillationStatus, ["pending", "failed", "blocked"]),
        ),
      );
    const expiredUndistilledCaptures = Number(expiredRow?.count ?? 0);

    let effectiveState: ProactiveEffectiveStatus["effectiveState"];
    let reason: string;
    if (revision.desiredState === "revoking" || revision.desiredState === "revoked" || revision.status === "revoked") {
      effectiveState = "revoking";
      reason = "profile_revoking";
    } else if (revision.desiredState === "paused") {
      effectiveState = "suspended";
      reason = "user_paused";
    } else if (revision.desiredState !== "enabled") {
      effectiveState = revision.status === "draft" ? "configuring" : "inactive";
      reason = revision.status === "draft" ? "profile_draft" : "user_disabled";
    } else if (!lease) {
      effectiveState = "suspended";
      reason = "activation_lease_missing";
    } else if (lease.status !== "active") {
      effectiveState = "suspended";
      reason = "activation_lease_expired";
    } else if (!lease.localReady) {
      effectiveState = "limited";
      reason = "local_processing_not_ready";
    } else if (!lease.fullAccessSnapshot) {
      effectiveState = "limited";
      reason = "full_access_turn_snapshot_missing";
    } else if (missing.length > 0) {
      effectiveState = "limited";
      reason = "mandatory_source_grant_missing";
    } else {
      effectiveState = "active";
      reason = expiredUndistilledCaptures > 0 ? "active_with_retention_backlog" : "ready";
    }
    return {
      desiredState: revision.desiredState,
      effectiveState,
      reason,
      revision,
      sources,
      activationLease: lease,
      mandatorySources: { total: mandatory.length, granted, missing },
      expiredUndistilledCaptures,
    };
  }

  async createCapture(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createCapture"]>[1],
  ): Promise<ProactiveCaptureModel> {
    assertTenantContext(tenant);
    const [existingCapture] = await this.db
      .select()
      .from(proactiveCaptures)
      .where(
        and(
          eq(proactiveCaptures.id, input.id),
          eq(proactiveCaptures.workspaceId, tenant.workspaceId),
          eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
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
    const revision = await this.getRevision(tenant, input.revisionId);
    if (!revision) throw new NotFoundInTenantError("proactive profile revision not found");
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
          eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
          eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
          eq(proactiveSourceGrants.sourceKey, input.sourceKey),
        ),
      )
      .limit(1);
    if (!source) throw new NotFoundInTenantError("proactive source grant not found");
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
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sourceKey: input.sourceKey,
        contentType: input.contentType,
        payloadText: this.encrypt(input.payloadText ?? null, "capture", input.id) ?? null,
        payloadJson: this.encrypt(payloadJson, "capture", input.id) ?? null,
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
    await this.recordAudit(tenant, {
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
    tenant: TenantContext,
    options?: Parameters<IProactiveProfileRepository["listCaptures"]>[1],
  ): Promise<ProactiveCaptureModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveCaptures.workspaceId, tenant.workspaceId),
      eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
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
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createObservation"]>[1],
  ): Promise<ProactiveBehaviorObservationModel> {
    assertTenantContext(tenant);
    const revision = await this.getRevision(tenant, input.revisionId);
    if (!revision) throw new NotFoundInTenantError("proactive profile revision not found");
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
          eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
          eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
          eq(proactiveSourceGrants.sourceKey, input.sourceKey),
        ),
      )
      .limit(1);
    if (!source) throw new NotFoundInTenantError("proactive source grant not found");
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
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sourceKey: input.sourceKey,
        observationType: input.observationType,
        subjectKey: this.encrypt(input.subjectKey, "observation", input.id) ?? "",
        payloadJson: this.encrypt(stringify(input.payload), "observation", input.id) ?? "{}",
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
    await this.recordAudit(tenant, {
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
    tenant: TenantContext,
    options?: Parameters<IProactiveProfileRepository["listObservations"]>[1],
  ): Promise<ProactiveBehaviorObservationModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveObservations.workspaceId, tenant.workspaceId),
      eq(proactiveObservations.subjectUserId, tenant.subjectUserId),
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

  async markCaptureDistilled(tenant: TenantContext, captureId: string, memoryIds: string[]): Promise<ProactiveCaptureModel | null> {
    assertTenantContext(tenant);
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
          eq(proactiveCaptures.workspaceId, tenant.workspaceId),
          eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
          isNull(proactiveCaptures.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.recordAudit(tenant, {
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

  async markCaptureDistillationFailed(tenant: TenantContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null> {
    assertTenantContext(tenant);
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
          eq(proactiveCaptures.workspaceId, tenant.workspaceId),
          eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
          isNull(proactiveCaptures.deletedAt),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.recordAudit(tenant, {
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

  async purgeEligibleCaptures(tenant?: TenantContext, now = new Date().toISOString(), limit = 200): Promise<number> {
    if (tenant) assertTenantContext(tenant);
    const conditions = [
      lte(proactiveCaptures.retentionUntil, now),
      eq(proactiveCaptures.distillationStatus, "distilled"),
      isNull(proactiveCaptures.deletedAt),
    ];
    if (tenant) {
      conditions.push(eq(proactiveCaptures.workspaceId, tenant.workspaceId));
      conditions.push(eq(proactiveCaptures.subjectUserId, tenant.subjectUserId));
    }
    // 到期但尚未提炼的副本进入 blocked，而不是被删除；这会给 Worker 一个
    // 可观测的告警状态，后续仍可在本地完成提炼后再清理。
    const blockedConditions = [
      lte(proactiveCaptures.retentionUntil, now),
      inArray(proactiveCaptures.distillationStatus, ["pending", "failed"]),
      isNull(proactiveCaptures.deletedAt),
    ];
    if (tenant) {
      blockedConditions.push(eq(proactiveCaptures.workspaceId, tenant.workspaceId));
      blockedConditions.push(eq(proactiveCaptures.subjectUserId, tenant.subjectUserId));
    }
    const blockedRows = await this.db
      .select({ id: proactiveCaptures.id, revisionId: proactiveCaptures.revisionId, workspaceId: proactiveCaptures.workspaceId, subjectUserId: proactiveCaptures.subjectUserId })
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
          workspaceId: row.workspaceId,
          subjectUserId: row.subjectUserId,
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

  async createClaim(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createClaim"]>[1],
  ): Promise<ProactiveProfileClaimModel> {
    assertTenantContext(tenant);
    const revision = await this.getRevision(tenant, input.revisionId);
    if (!revision) throw new NotFoundInTenantError("proactive profile revision not found");
    const evidenceCaptureIds = [...new Set(input.evidenceCaptureIds ?? [])];
    if (evidenceCaptureIds.length > 0) {
      const evidenceRows = await this.db
        .select({ id: proactiveCaptures.id })
        .from(proactiveCaptures)
        .where(
          and(
            inArray(proactiveCaptures.id, evidenceCaptureIds),
            eq(proactiveCaptures.revisionId, revision.id),
            eq(proactiveCaptures.workspaceId, tenant.workspaceId),
            eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
          ),
        );
      if (evidenceRows.length !== evidenceCaptureIds.length) {
        throw new DomainConflictError("claim evidence capture is not in the same profile revision");
      }
    }
    const sourceGrantIds = [...new Set(input.sourceGrantIds ?? [])];
    if (sourceGrantIds.length > 0) {
      const sourceRows = await this.db
        .select({ id: proactiveSourceGrants.id })
        .from(proactiveSourceGrants)
        .where(
          and(
            inArray(proactiveSourceGrants.id, sourceGrantIds),
            eq(proactiveSourceGrants.revisionId, revision.id),
            eq(proactiveSourceGrants.workspaceId, tenant.workspaceId),
            eq(proactiveSourceGrants.subjectUserId, tenant.subjectUserId),
          ),
        );
      if (sourceRows.length !== sourceGrantIds.length) {
        throw new DomainConflictError("claim source grant is not in the same profile revision");
      }
    }
    const now = new Date().toISOString();
    const state = input.state ?? "inferred";
    const [created] = await this.db
      .insert(proactiveProfileClaims)
      .values({
        id: input.id,
        revisionId: revision.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        claimType: input.claimType,
        subjectKey: this.encrypt(input.subjectKey, "claim", input.id) ?? "",
        content: this.encrypt(input.content, "claim", input.id) ?? "",
        state,
        confidence: Math.max(0, Math.min(100, Math.floor(input.confidence ?? 0))),
        algorithmVersion: input.algorithmVersion ?? "local-profile-v1",
        processingBoundary: "local_only",
        evidenceCaptureIdsJson: JSON.stringify(evidenceCaptureIds),
        evidenceRefsJson: this.encrypt(JSON.stringify(input.evidenceRefs ?? []), "claim", input.id) ?? "[]",
        sourceGrantIdsJson: JSON.stringify(sourceGrantIds),
        firstObservedAt: input.firstObservedAt ?? null,
        lastObservedAt: input.lastObservedAt ?? null,
        confirmedAt: state === "confirmed" ? now : null,
        rejectedAt: state === "rejected" ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive profile claim");
    return toClaim(created, this.cipher);
  }

  async listClaims(
    tenant: TenantContext,
    options?: Parameters<IProactiveProfileRepository["listClaims"]>[1],
  ): Promise<ProactiveProfileClaimModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveProfileClaims.workspaceId, tenant.workspaceId),
      eq(proactiveProfileClaims.subjectUserId, tenant.subjectUserId),
    ];
    if (options?.revisionId) conditions.push(eq(proactiveProfileClaims.revisionId, options.revisionId));
    if (options?.state) conditions.push(eq(proactiveProfileClaims.state, options.state));
    const rows = await this.db
      .select()
      .from(proactiveProfileClaims)
      .where(and(...conditions))
      .orderBy(desc(proactiveProfileClaims.updatedAt))
      .limit(clampLimit(options?.limit));
    return rows.map((row) => toClaim(row, this.cipher));
  }

  async updateClaimState(tenant: TenantContext, claimId: string, state: ProactiveClaimState, actorId: string): Promise<ProactiveProfileClaimModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(proactiveProfileClaims)
      .set({
        state,
        confirmedAt: state === "confirmed" ? now : null,
        rejectedAt: state === "rejected" ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveProfileClaims.id, claimId),
          eq(proactiveProfileClaims.workspaceId, tenant.workspaceId),
          eq(proactiveProfileClaims.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.recordAudit(tenant, {
      id: `${claimId}_audit_state_${Date.now().toString(36)}`,
      revisionId: updated.revisionId,
      eventType: `claim.${state}`,
      actorId,
      resourceType: "profile_claim",
      resourceId: claimId,
      payload: { state },
    });
    return toClaim(updated, this.cipher);
  }

  async createAction(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["createAction"]>[1],
  ): Promise<ProactiveActionModel> {
    assertTenantContext(tenant);
    if (!input.authorizationScope.trim()) throw new DomainConflictError("authorizationScope is required");
    const revision = await this.getRevision(tenant, input.revisionId);
    if (!revision) throw new NotFoundInTenantError("proactive profile revision not found");
    const scopes = parseActionScopes(input.authorizationScope);
    if (scopes.length === 0 || scopes.some((scope) => !ACTION_SCOPES.has(scope))) {
      throw new DomainConflictError("authorizationScope contains an unsupported action scope");
    }
    const grants = await this.listSourceGrants(tenant, revision.id);
    const missingScopes = scopes.filter((scope) => grants.find((grant) => grant.sourceKey === scope)?.state !== "granted");
    if (missingScopes.length > 0) {
      throw new DomainConflictError(`action grant missing: ${missingScopes.join(",")}`);
    }
    // 授权指纹由服务端从真实 granted grant 版本派生，禁止调用方伪造 actionGrantRevision
    const actionGrantRevision = scopes
      .map((scope) => {
        const grant = grants.find((grant) => grant.sourceKey === scope);
        return `${scope}@${grant?.grantVersion ?? 1}`;
      })
      .join("+");
    if (input.activationLeaseId) {
      const lease = await this.getLease(tenant, input.activationLeaseId);
      if (!lease || lease.revisionId !== revision.id) throw new NotFoundInTenantError("activation lease not found");
    }
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveActions)
      .values({
        id: input.id,
        revisionId: revision.id,
        activationLeaseId: input.activationLeaseId ?? null,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        actionType: input.actionType,
        target: this.encrypt(input.target, "action", input.id) ?? "",
        requestJson: this.encrypt(stringify(input.request), "action", input.id) ?? "{}",
        authorizationScope: input.authorizationScope,
        actionGrantRevision,
        state: "pending",
        requestedBy: input.requestedBy,
        approvedBy: null,
        approvedAt: null,
        reversible: input.reversible ?? !scopes.includes("action.irreversible"),
        external: input.external ?? scopes.includes("action.external"),
        startedAt: null,
        finishedAt: null,
        outcomeJson: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive action");
    await this.recordAudit(tenant, {
      id: `${input.id}_audit_requested`,
      revisionId: revision.id,
      eventType: "action.requested",
      actorId: input.requestedBy,
      resourceType: "proactive_action",
      resourceId: input.id,
      payload: { actionType: input.actionType, external: input.external ?? false },
    });
    return toAction(created, this.cipher);
  }

  async listActions(
    tenant: TenantContext,
    options?: Parameters<IProactiveProfileRepository["listActions"]>[1],
  ): Promise<ProactiveActionModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveActions.workspaceId, tenant.workspaceId),
      eq(proactiveActions.subjectUserId, tenant.subjectUserId),
    ];
    if (options?.revisionId) conditions.push(eq(proactiveActions.revisionId, options.revisionId));
    if (options?.state) conditions.push(eq(proactiveActions.state, options.state));
    const rows = await this.db
      .select()
      .from(proactiveActions)
      .where(and(...conditions))
      .orderBy(desc(proactiveActions.createdAt))
      .limit(clampLimit(options?.limit));
    return rows.map((row) => toAction(row, this.cipher));
  }

  async updateAction(
    tenant: TenantContext,
    actionId: string,
    input: Parameters<IProactiveProfileRepository["updateAction"]>[2],
  ): Promise<ProactiveActionModel | null> {
    assertTenantContext(tenant);
    const [existing] = await this.db
      .select()
      .from(proactiveActions)
      .where(
        and(
          eq(proactiveActions.id, actionId),
          eq(proactiveActions.workspaceId, tenant.workspaceId),
          eq(proactiveActions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!existing) return null;
    // 动作状态机约束：approved 只能来自 pending；running/executed 只能从 approved 前进。
    // 调用方不能把未决动作直接置为执行态，也不能二次批准已批准动作。
    const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
      pending: ["approved", "denied", "revoked"],
      approved: ["running", "revoked", "failed"],
      running: ["executed", "failed", "revoked"],
      executed: [],
      denied: [],
      failed: ["revoked"],
      revoked: [],
    };
    const allowed = ALLOWED_TRANSITIONS[existing.state] ?? [];
    if (!allowed.includes(input.state)) {
      throw new DomainConflictError(`state transition ${existing.state} -> ${input.state} not allowed`);
    }
    const now = new Date().toISOString();
    const terminal = ["executed", "denied", "failed", "revoked"].includes(input.state);
    const [updated] = await this.db
      .update(proactiveActions)
      .set({
        state: input.state,
        approvedBy: input.state === "approved" ? input.actorId ?? "user" : existing.approvedBy,
        approvedAt: input.state === "approved" ? now : existing.approvedAt,
        startedAt: input.state === "running" ? existing.startedAt ?? now : existing.startedAt,
        finishedAt: terminal ? now : existing.finishedAt,
        outcomeJson: input.outcome === undefined
          ? existing.outcomeJson
          : this.encrypt(stringify(input.outcome, "null"), "action", actionId) ?? "null",
        error: input.error === undefined
          ? existing.error
          : this.encrypt(input.error, "action", actionId) ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveActions.id, actionId),
          eq(proactiveActions.workspaceId, tenant.workspaceId),
          eq(proactiveActions.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.recordAudit(tenant, {
      id: `${actionId}_audit_${input.state}_${Date.now().toString(36)}`,
      revisionId: updated.revisionId,
      eventType: `action.${input.state}`,
      actorId: input.actorId ?? "system",
      resourceType: "proactive_action",
      resourceId: actionId,
      payload: input.error ? { failed: true } : {},
    });
    return toAction(updated, this.cipher);
  }

  async recordAudit(
    tenant: TenantContext,
    input: Parameters<IProactiveProfileRepository["recordAudit"]>[1],
  ): Promise<ProactiveAuditEventModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveAuditEvents)
      .values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        revisionId: input.revisionId ?? null,
        eventType: input.eventType,
        actorId: input.actorId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payloadJson: stringify(input.payload),
        processingBoundary: "local_only",
        occurredAt: now,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to record proactive audit event");
    return toAudit(created);
  }

  async listAuditEvents(tenant: TenantContext, limit?: number): Promise<ProactiveAuditEventModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(proactiveAuditEvents)
      .where(
        and(
          eq(proactiveAuditEvents.workspaceId, tenant.workspaceId),
          eq(proactiveAuditEvents.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(proactiveAuditEvents.occurredAt))
      .limit(clampLimit(limit));
    return rows.map(toAudit);
  }

  async exportSnapshot(
    tenant: TenantContext,
    options?: Parameters<IProactiveProfileRepository["exportSnapshot"]>[1],
  ) {
    assertTenantContext(tenant);
    const includeRaw = options?.includeRaw === true;
    const [revisions, sources, leases, captures, observations, claims, actions, auditEvents, consents] = await Promise.all([
      this.listRevisions(tenant, MAX_LIST_LIMIT),
      this.listSourceGrants(tenant),
      this.listLeases(tenant),
      this.listCaptureRows(tenant, includeRaw),
      this.listObservations(tenant, { limit: MAX_LIST_LIMIT }),
      this.listClaims(tenant, { limit: MAX_LIST_LIMIT }),
      this.listActions(tenant, { limit: MAX_LIST_LIMIT }),
      this.listAuditEvents(tenant, MAX_LIST_LIMIT),
      this.listProactiveConsents(tenant),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: "cap-033-proactive-v1",
      tenant: { workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId },
      profileRevisions: revisions,
      sourceGrants: sources,
      activationLeases: leases,
      captures,
      observations,
      claims,
      actions,
      auditEvents,
      consents,
    };
  }

  private async listLeases(tenant: TenantContext): Promise<ProactiveActivationLeaseModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.workspaceId, tenant.workspaceId),
          eq(proactiveActivationLeases.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(proactiveActivationLeases.issuedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map(toLease);
  }

  private async listProactiveConsents(tenant: TenantContext): Promise<ProactiveConsentModel[]> {
    const rows = await this.db
      .select()
      .from(consentGrants)
      .where(
        and(
          eq(consentGrants.workspaceId, tenant.workspaceId),
          eq(consentGrants.subjectUserId, tenant.subjectUserId),
          eq(consentGrants.purpose, "proactive_profile"),
        ),
      )
      .orderBy(desc(consentGrants.grantedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      subjectUserId: row.subjectUserId,
      actorId: row.actorId,
      purpose: row.purpose,
      scope: row.scope,
      policyVersion: row.policyVersion,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
  }

  private async listCaptureRows(tenant: TenantContext, includeRaw: boolean): Promise<ProactiveCaptureModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveCaptures)
      .where(
        and(
          eq(proactiveCaptures.workspaceId, tenant.workspaceId),
          eq(proactiveCaptures.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(proactiveCaptures.observedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map((row) => toCapture(row, includeRaw, this.cipher));
  }
}
