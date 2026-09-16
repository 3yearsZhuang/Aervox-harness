/**
 * Aervox｜思隅 @aervox/repositories — 逐来源授权状态与来源数据删除 Store
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  consentGrants,
  proactiveActions,
  proactiveCaptures,
  proactiveObservations,
  proactiveProfileClaims,
  proactiveSourceGrants,
} from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveSourceDeletionResult,
  ProactiveSourceGrantModel,
} from "../../types/index.js";
import { AuditExportStore } from "./audit-export-store.js";
import { encrypt } from "./crypto.js";
import { parseActionScopes, parseJson, stringify, toSource } from "./shared.js";

export class SourceGrantStore {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly audit: AuditExportStore,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  async listSourceGrants(ctx: LocalContext, revisionId?: string): Promise<ProactiveSourceGrantModel[]> {
    const conditions = [
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
    ctx: LocalContext,
    sourceGrantId: string,
    input: Parameters<IProactiveProfileRepository["updateSourceGrant"]>[2],
  ): Promise<ProactiveSourceGrantModel | null> {
    const [existing] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
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
          : encrypt(stringify(input.metadata), "source", sourceGrantId, this.cipher) ?? "{}",
        grantedAt: input.state === "granted" ? existing.grantedAt ?? now : existing.grantedAt,
        revokedAt: input.state === "revoked" || input.state === "expired" ? now : null,
        lastVerifiedAt: input.lastVerifiedAt === undefined ? existing.lastVerifiedAt : input.lastVerifiedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
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
            eq(consentGrants.purpose, "proactive_profile"),
            eq(consentGrants.scope, existing.sourceKey),
            sql`${consentGrants.revokedAt} IS NULL`,
          ),
        );
    }
    await this.audit.recordAudit(ctx, {
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
    ctx: LocalContext,
    sourceGrantId: string,
    actorId: string,
  ): Promise<ProactiveSourceDeletionResult | null> {
    const [source] = await this.db
      .select()
      .from(proactiveSourceGrants)
      .where(
        and(
          eq(proactiveSourceGrants.id, sourceGrantId),
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
            isNull(proactiveCaptures.deletedAt),
          ),
        )
        .returning({ id: proactiveCaptures.id });

      const observations = await tx
        .delete(proactiveObservations)
        .where(
          and(
            eq(proactiveObservations.sourceGrantId, sourceGrantId),
          ),
        )
        .returning({ id: proactiveObservations.id });

      const claimRows = await tx
        .select({ id: proactiveProfileClaims.id, sourceGrantIdsJson: proactiveProfileClaims.sourceGrantIdsJson })
        .from(proactiveProfileClaims)
        .where(
          and(
            eq(proactiveProfileClaims.revisionId, source.revisionId),
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
            ),
          )
          .returning({ id: proactiveProfileClaims.id })
        : [];

      const actionRows = source.sourceKey.startsWith("action.")
        ? await tx.select().from(proactiveActions).where(
          and(
            eq(proactiveActions.revisionId, source.revisionId),
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
            target: encrypt("[deleted]", "action", action.id, this.cipher) ?? "[deleted]",
            requestJson: encrypt("{}", "action", action.id, this.cipher) ?? "{}",
            outcomeJson: null,
            error: null,
            finishedAt: terminal ? action.finishedAt : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(proactiveActions.id, action.id),
            ),
          );
      }

      await tx
        .update(proactiveSourceGrants)
        .set({ state: "revoked", revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(proactiveSourceGrants.id, sourceGrantId),
          ),
        );
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

      return {
        sourceGrantId,
        capturesScrubbed: captures.length,
        observationsDeleted: observations.length,
        claimsDeleted: claims.length,
        actionsScrubbed: matchingActions.length,
      };
    });

    await this.audit.recordAudit(ctx, {
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
}
