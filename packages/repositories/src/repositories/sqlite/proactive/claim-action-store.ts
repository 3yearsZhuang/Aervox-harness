/**
 * Aervox｜思隅 @aervox/repositories — 画像主张与主动动作（授权/状态机）Store
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  proactiveActions,
  proactiveActivationLeases,
  proactiveAuditEvents,
  proactiveProfileClaims,
  proactiveProfileRevisions,
  proactiveSourceGrants,
} from "@aervox/schema";
import { DomainConflictError, RepositoryNotFoundError } from "../../../errors.js";
import type { LocalContext } from "../../../local-context.js";
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveActionModel,
  ProactiveClaimState,
  ProactiveProfileClaimModel,
} from "../../types/index.js";
import { AuditExportStore } from "./audit-export-store.js";
import { decodeWithCipher, encrypt } from "./crypto.js";
import { findEligibleCaptureDistillation } from "./capture-distillation-store.js";
import {
  ACTION_SCOPES,
  bool,
  clampLimit,
  localBoundary,
  parseActionScopes,
  parseJson,
  stringify,
  toSource,
} from "./shared.js";

type ClaimRow = typeof proactiveProfileClaims.$inferSelect;
type ActionRow = typeof proactiveActions.$inferSelect;

function toClaim(row: ClaimRow, cipher?: ProactiveVaultCipher): ProactiveProfileClaimModel {
  const evidenceRefsJson = decodeWithCipher(row.evidenceRefsJson, cipher, `claim:${row.id}`);
  return {
    id: row.id,
    revisionId: row.revisionId,
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

export class ClaimActionStore {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly audit: AuditExportStore,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  async createClaim(
    ctx: LocalContext,
    submitted: Parameters<IProactiveProfileRepository["createClaim"]>[1],
  ): Promise<ProactiveProfileClaimModel> {
    // Capture the caller's intent before waiting for the writer. Its evidence
    // must not change after qualification while the same private text is saved.
    const input = { ...submitted,
      evidenceCaptureIds: [...new Set(submitted.evidenceCaptureIds ?? [])],
      sourceGrantIds: [...new Set(submitted.sourceGrantIds ?? [])],
    };
    const evidenceRefsJson = encrypt(JSON.stringify(submitted.evidenceRefs ?? []), "claim", input.id, this.cipher) ?? "[]";
    return this.db.transaction(async tx => {
      const [revision] = await tx.select().from(proactiveProfileRevisions).where(eq(proactiveProfileRevisions.id, input.revisionId));
      if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
      const { evidenceCaptureIds, sourceGrantIds } = input;
      const sourceDerived = evidenceCaptureIds.length > 0 || sourceGrantIds.length > 0;
      if (sourceDerived && (revision.status !== "active" || revision.desiredState !== "enabled" || revision.processingBoundary !== "local_only")) {
        throw new DomainConflictError("claim_source_unavailable");
      }
      for (const captureId of evidenceCaptureIds) {
        // Reuse publication's existing authorization definition. Do not invent
        // provenance for old callers: each capture's source must be declared.
        const capture = await findEligibleCaptureDistillation(tx, captureId);
        if (!capture || capture.revisionId !== revision.id || !sourceGrantIds.includes(capture.sourceGrantId)) {
          throw new DomainConflictError("claim_source_unavailable");
        }
      }
      if (sourceGrantIds.length > 0) {
        const sourceRows = await tx
          .select({ id: proactiveSourceGrants.id })
          .from(proactiveSourceGrants)
          .where(
            and(
              inArray(proactiveSourceGrants.id, sourceGrantIds),
              eq(proactiveSourceGrants.revisionId, revision.id),
              eq(proactiveSourceGrants.state, "granted"),
              eq(proactiveSourceGrants.processingBoundary, "local_only"),
            ),
          );
        if (sourceRows.length !== sourceGrantIds.length) {
          throw new DomainConflictError("claim_source_unavailable");
        }
      }
      const now = new Date().toISOString();
      const state = input.state ?? "inferred";
      const [created] = await tx
        .insert(proactiveProfileClaims)
        .values({
          id: input.id,
          revisionId: revision.id,
          claimType: input.claimType,
          subjectKey: encrypt(input.subjectKey, "claim", input.id, this.cipher) ?? "",
          content: encrypt(input.content, "claim", input.id, this.cipher) ?? "",
          state,
          confidence: Math.max(0, Math.min(100, Math.floor(input.confidence ?? 0))),
          algorithmVersion: input.algorithmVersion ?? "local-profile-v1",
          processingBoundary: "local_only",
          evidenceCaptureIdsJson: JSON.stringify(evidenceCaptureIds),
          evidenceRefsJson,
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
    }, { behavior: "immediate" });
  }

  /** Recovery addresses one capture, independently of the latest claims presentation window. */
  async listCaptureClaims(ctx: LocalContext, captureId: string): Promise<ProactiveProfileClaimModel[]> {
    const rows = await this.db.select().from(proactiveProfileClaims).where(
      sql`EXISTS (SELECT 1 FROM json_each(${proactiveProfileClaims.evidenceCaptureIdsJson}) WHERE value = ${captureId})`,
    ).orderBy(proactiveProfileClaims.id);
    return rows.map(row => toClaim(row, this.cipher));
  }

  async listClaims(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listClaims"]>[1],
  ): Promise<ProactiveProfileClaimModel[]> {
    const conditions = [
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

  async updateClaimState(ctx: LocalContext, claimId: string, state: ProactiveClaimState, actorId: string): Promise<ProactiveProfileClaimModel | null> {
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
        ),
      )
      .returning();
    if (!updated) return null;
    await this.audit.recordAudit(ctx, {
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
    ctx: LocalContext,
    submitted: Parameters<IProactiveProfileRepository["createAction"]>[1],
  ): Promise<ProactiveActionModel> {
    const input = { ...submitted };
    const requestJson = stringify(input.request);
    if (!input.authorizationScope.trim()) throw new DomainConflictError("authorizationScope is required");
    return this.db.transaction(async tx => {
      const [revision] = await tx.select().from(proactiveProfileRevisions).where(eq(proactiveProfileRevisions.id, input.revisionId));
      if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
      localBoundary(revision.processingBoundary);
      decodeWithCipher(revision.manifestJson, this.cipher, `profile:${revision.id}`);
      const scopes = parseActionScopes(input.authorizationScope);
      if (scopes.length === 0 || scopes.some((scope) => !ACTION_SCOPES.has(scope))) {
        throw new DomainConflictError("authorizationScope contains an unsupported action scope");
      }
      const grantRows = await tx.select().from(proactiveSourceGrants).where(eq(proactiveSourceGrants.revisionId, revision.id));
      // Retain the existing local-boundary and encrypted metadata validation of
      // listSourceGrants, while reading admission facts from this writer.
      const grants = grantRows.map(row => toSource(row, this.cipher));
      const missingScopes = scopes.filter(scope => grants.find(grant => grant.sourceKey === scope)?.state !== "granted");
      if (missingScopes.length > 0) throw new DomainConflictError(`action grant missing: ${missingScopes.join(",")}`);
      // The snapshot comes from actual grants; caller actionGrantRevision is not authority.
      const actionGrantRevision = scopes.map(scope => {
        const grant = grants.find(grant => grant.sourceKey === scope);
        return `${scope}@${grant?.grantVersion ?? 1}`;
      }).join("+");
      if (input.activationLeaseId) {
        const [lease] = await tx.select().from(proactiveActivationLeases).where(eq(proactiveActivationLeases.id, input.activationLeaseId));
        if (!lease || lease.revisionId !== revision.id) throw new RepositoryNotFoundError("activation lease not found");
      }
      const now = new Date().toISOString();
      const [created] = await tx.insert(proactiveActions).values({
        id: input.id,
        revisionId: revision.id,
        activationLeaseId: input.activationLeaseId ?? null,
        actionType: input.actionType,
        target: encrypt(input.target, "action", input.id, this.cipher) ?? "",
        requestJson: encrypt(requestJson, "action", input.id, this.cipher) ?? "{}",
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
      const [audit] = await tx.insert(proactiveAuditEvents).values({
        id: `${input.id}_audit_requested`,
        revisionId: revision.id,
        eventType: "action.requested",
        actorId: input.requestedBy,
        resourceType: "proactive_action",
        resourceId: input.id,
        payloadJson: JSON.stringify({ actionType: input.actionType, external: input.external ?? false }),
        processingBoundary: "local_only",
        occurredAt: now,
        createdAt: now,
      }).returning({ id: proactiveAuditEvents.id });
      if (!audit) throw new Error("failed to record proactive audit event");
      return toAction(created, this.cipher);
    }, { behavior: "immediate" });
  }

  async listActions(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listActions"]>[1],
  ): Promise<ProactiveActionModel[]> {
    const conditions = [
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
    ctx: LocalContext,
    actionId: string,
    submitted: Parameters<IProactiveProfileRepository["updateAction"]>[2],
  ): Promise<ProactiveActionModel | null> {
    // Preserve this call's intent while it waits for admission to the writer.
    const input = { ...submitted };
    const outcomeJson = input.outcome === undefined ? undefined : stringify(input.outcome, "null");
    return this.db.transaction(async tx => {
      const [existing] = await tx.select().from(proactiveActions).where(eq(proactiveActions.id, actionId)).limit(1);
      if (!existing) return null;
      // 动作状态机约束：approved 只能来自 pending；running/executed 只能从 approved 前进。
      // 在写者事务中读取和检查，避免并行状态变更或删除后使用旧快照。
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
      // Revocation can preserve or clear existing results; it cannot introduce
      // new content after a failed action's source data has been scrubbed.
      if (input.state === "revoked" && ((input.outcome !== undefined && input.outcome !== null)
        || (typeof input.error === "string" && input.error.length > 0))) {
        throw new DomainConflictError("revocation cannot introduce outcome or error content");
      }
      const now = new Date().toISOString();
      const terminal = ["executed", "denied", "failed", "revoked"].includes(input.state);
      const [updated] = await tx.update(proactiveActions).set({
        state: input.state,
        approvedBy: input.state === "approved" ? input.actorId ?? "user" : existing.approvedBy,
        approvedAt: input.state === "approved" ? now : existing.approvedAt,
        startedAt: input.state === "running" ? existing.startedAt ?? now : existing.startedAt,
        finishedAt: terminal ? now : existing.finishedAt,
        outcomeJson: outcomeJson === undefined ? existing.outcomeJson : encrypt(outcomeJson, "action", actionId, this.cipher) ?? "null",
        error: input.error === undefined ? existing.error : encrypt(input.error, "action", actionId, this.cipher) ?? null,
        updatedAt: now,
      }).where(eq(proactiveActions.id, actionId)).returning();
      if (!updated) return null;
      const [audit] = await tx.insert(proactiveAuditEvents).values({
        id: `${actionId}_audit_${input.state}_${Date.now().toString(36)}`,
        revisionId: updated.revisionId,
        eventType: `action.${input.state}`,
        actorId: input.actorId ?? "system",
        resourceType: "proactive_action",
        resourceId: actionId,
        payloadJson: JSON.stringify(input.error ? { failed: true } : {}),
        processingBoundary: "local_only",
        occurredAt: now,
        createdAt: now,
      }).returning({ id: proactiveAuditEvents.id });
      if (!audit) throw new Error("failed to record proactive audit event");
      return toAction(updated, this.cipher);
    }, { behavior: "immediate" });
  }
}
