/**
 * Aervox｜思隅 @aervox/repositories — 主动画像修订生命周期与有效状态聚合 Store
 */
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  FULL_PROFILE_SOURCE_MANIFEST,
  consentGrants,
  proactiveActivationLeases,
  proactiveAuditEvents,
  proactiveCaptures,
  proactiveProfileRevisions,
  proactiveSourceGrants,
} from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveEffectiveStatus,
  ProactiveProfileRevisionModel,
  ProactiveSourceGrantModel,
} from "../../types/index.js";
import { AuditExportStore } from "./audit-export-store.js";
import { decodeWithCipher, encrypt } from "./crypto.js";
import { SourceGrantStore } from "./source-grant-store.js";
import type { SourceRow } from "./shared.js";
import {
  bool,
  clampLimit,
  localBoundary,
  parseJson,
  stringify,
  toLease,
  toSource,
} from "./shared.js";

type RevisionRow = typeof proactiveProfileRevisions.$inferSelect;

function sourceDefaults(sourceKey: string): { purpose: string; osCapability: string } {
  const found = FULL_PROFILE_SOURCE_MANIFEST.find((item) => item.sourceKey === sourceKey);
  return found ?? { purpose: "profile.observe", osCapability: `os.${sourceKey}` };
}

function toRevision(row: RevisionRow, cipher?: ProactiveVaultCipher): ProactiveProfileRevisionModel {
  return {
    id: row.id,
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

export class ProfileLifecycleStore {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly sourceGrants: SourceGrantStore,
    private readonly audit: AuditExportStore,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  async confirmProfile(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["confirmProfile"]>[1],
  ): Promise<{ revision: ProactiveProfileRevisionModel; sources: ProactiveSourceGrantModel[] }> {
    const now = new Date().toISOString();
    const profileVersion = input.profileVersion ?? "full_profile_v1";

    // id 作为客户端幂等键：重复确认不会产生第二份修订。
    const [existing] = await this.db
      .select()
      .from(proactiveProfileRevisions)
      .where(
        and(
          eq(proactiveProfileRevisions.id, input.id),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        revision: toRevision(existing, this.cipher),
        sources: await this.sourceGrants.listSourceGrants(ctx, existing.id),
      };
    }

    return this.db.transaction(async (tx) => {
      const [latest] = await tx
        .select({ revision: proactiveProfileRevisions.revision })
        .from(proactiveProfileRevisions)
        .where(
          and(
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
            eq(proactiveProfileRevisions.profileVersion, profileVersion),
            eq(proactiveProfileRevisions.deviceId, input.deviceId),
            eq(proactiveProfileRevisions.status, "active"),
          ),
        );

      const [revisionRow] = await tx
        .insert(proactiveProfileRevisions)
        .values({
          id: input.id,
          profileVersion,
          revision: revisionNumber,
          deviceId: input.deviceId,
          desiredState: "enabled",
          status: "active",
          fullAccessRequired: true,
          processingBoundary: "local_only",
          manifestJson: encrypt(
            stringify(input.manifest ?? { profileVersion, sources: FULL_PROFILE_SOURCE_MANIFEST }),
            "profile",
            input.id,
            this.cipher,
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
            sourceKey: source.sourceKey,
            purpose: source.purpose ?? defaults.purpose,
            scope: source.scope ?? "all",
            osCapability: source.osCapability ?? defaults.osCapability,
            state,
            mandatory: source.mandatory ?? true,
            processingBoundary: "local_only",
            grantVersion: source.grantVersion ?? 1,
            metadataJson: encrypt(stringify(source.metadata), "source", source.id, this.cipher) ?? "{}",
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
              eq(consentGrants.purpose, "proactive_profile"),
              eq(consentGrants.scope, source.sourceKey),
              sql`${consentGrants.revokedAt} IS NULL`,
            ),
          );
        await tx
          .insert(consentGrants)
          .values({
            id: `${input.id}_consent_${source.sourceKey.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
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
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createDraft"]>[1],
  ): Promise<ProactiveProfileRevisionModel> {
    const now = new Date().toISOString();
    const profileVersion = input.profileVersion ?? "full_profile_v1";
    const [latest] = await this.db
      .select({ revision: proactiveProfileRevisions.revision })
      .from(proactiveProfileRevisions)
      .where(
        and(
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
        profileVersion,
        revision: (latest?.revision ?? 0) + 1,
        deviceId: input.deviceId,
        desiredState: "none",
        status: "draft",
        fullAccessRequired: true,
        processingBoundary: "local_only",
        manifestJson: encrypt(
          stringify(input.manifest ?? { profileVersion, sources: FULL_PROFILE_SOURCE_MANIFEST }),
          "profile",
          input.id,
          this.cipher,
        ) ?? "{}",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to create proactive profile draft");
    await this.audit.recordAudit(ctx, {
      id: `${input.id}_audit_draft`,
      revisionId: input.id,
      eventType: "profile.draft_created",
      actorId: input.actorId,
      resourceType: "profile_revision",
      resourceId: input.id,
    });
    return toRevision(created, this.cipher);
  }

  async getRevision(ctx: LocalContext, revisionId?: string): Promise<ProactiveProfileRevisionModel | null> {
    const conditions = [
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

  async listRevisions(ctx: LocalContext, limit?: number): Promise<ProactiveProfileRevisionModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveProfileRevisions)
      .where(
        and(
        ),
      )
      .orderBy(desc(proactiveProfileRevisions.revision))
      .limit(clampLimit(limit));
    return rows.map((row) => toRevision(row, this.cipher));
  }

  async setDesiredState(
    ctx: LocalContext,
    state: Parameters<IProactiveProfileRepository["setDesiredState"]>[1],
    actorId: string,
    revisionId?: string,
  ): Promise<ProactiveProfileRevisionModel | null> {
    const revision = await this.getRevision(ctx, revisionId);
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
            eq(consentGrants.purpose, "proactive_profile"),
            sql`${consentGrants.revokedAt} IS NULL`,
          ),
        );
    }
    await this.audit.recordAudit(ctx, {
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

  async getEffectiveStatus(ctx: LocalContext, now = new Date().toISOString()): Promise<ProactiveEffectiveStatus> {
    const revision = await this.getRevision(ctx);
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
    const sources = await this.sourceGrants.listSourceGrants(ctx, revision.id);
    const mandatory = sources.filter((source) => source.mandatory);
    const missing = mandatory.filter((source) => source.state !== "granted").map((source) => source.sourceKey);
    const granted = mandatory.length - missing.length;
    const [leaseRow] = await this.db
      .select()
      .from(proactiveActivationLeases)
      .where(
        and(
          eq(proactiveActivationLeases.revisionId, revision.id),
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
}
