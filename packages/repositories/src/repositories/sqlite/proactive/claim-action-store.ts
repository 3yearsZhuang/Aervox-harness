/**
 * Aervox｜思隅 @aervox/repositories — 画像主张与主动动作（授权/状态机）Store
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import {
  proactiveActions,
  proactiveCaptures,
  proactiveProfileClaims,
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
import { ActivationLeaseStore } from "./activation-lease-store.js";
import { AuditExportStore } from "./audit-export-store.js";
import { decodeWithCipher, encrypt } from "./crypto.js";
import { ProfileLifecycleStore } from "./profile-lifecycle-store.js";
import { SourceGrantStore } from "./source-grant-store.js";
import {
  ACTION_SCOPES,
  bool,
  clampLimit,
  localBoundary,
  parseActionScopes,
  parseJson,
  stringify,
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
    private readonly lifecycle: ProfileLifecycleStore,
    private readonly sourceGrants: SourceGrantStore,
    private readonly leases: ActivationLeaseStore,
    private readonly audit: AuditExportStore,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  async createClaim(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createClaim"]>[1],
  ): Promise<ProactiveProfileClaimModel> {
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    const evidenceCaptureIds = [...new Set(input.evidenceCaptureIds ?? [])];
    if (evidenceCaptureIds.length > 0) {
      const evidenceRows = await this.db
        .select({ id: proactiveCaptures.id })
        .from(proactiveCaptures)
        .where(
          and(
            inArray(proactiveCaptures.id, evidenceCaptureIds),
            eq(proactiveCaptures.revisionId, revision.id),
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
        claimType: input.claimType,
        subjectKey: encrypt(input.subjectKey, "claim", input.id, this.cipher) ?? "",
        content: encrypt(input.content, "claim", input.id, this.cipher) ?? "",
        state,
        confidence: Math.max(0, Math.min(100, Math.floor(input.confidence ?? 0))),
        algorithmVersion: input.algorithmVersion ?? "local-profile-v1",
        processingBoundary: "local_only",
        evidenceCaptureIdsJson: JSON.stringify(evidenceCaptureIds),
        evidenceRefsJson: encrypt(JSON.stringify(input.evidenceRefs ?? []), "claim", input.id, this.cipher) ?? "[]",
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
    input: Parameters<IProactiveProfileRepository["createAction"]>[1],
  ): Promise<ProactiveActionModel> {
    if (!input.authorizationScope.trim()) throw new DomainConflictError("authorizationScope is required");
    const revision = await this.lifecycle.getRevision(ctx, input.revisionId);
    if (!revision) throw new RepositoryNotFoundError("proactive profile revision not found");
    const scopes = parseActionScopes(input.authorizationScope);
    if (scopes.length === 0 || scopes.some((scope) => !ACTION_SCOPES.has(scope))) {
      throw new DomainConflictError("authorizationScope contains an unsupported action scope");
    }
    const grants = await this.sourceGrants.listSourceGrants(ctx, revision.id);
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
      const lease = await this.leases.getLease(ctx, input.activationLeaseId);
      if (!lease || lease.revisionId !== revision.id) throw new RepositoryNotFoundError("activation lease not found");
    }
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveActions)
      .values({
        id: input.id,
        revisionId: revision.id,
        activationLeaseId: input.activationLeaseId ?? null,
        actionType: input.actionType,
        target: encrypt(input.target, "action", input.id, this.cipher) ?? "",
        requestJson: encrypt(stringify(input.request), "action", input.id, this.cipher) ?? "{}",
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
    await this.audit.recordAudit(ctx, {
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
    input: Parameters<IProactiveProfileRepository["updateAction"]>[2],
  ): Promise<ProactiveActionModel | null> {
    const [existing] = await this.db
      .select()
      .from(proactiveActions)
      .where(
        and(
          eq(proactiveActions.id, actionId),
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
          : encrypt(stringify(input.outcome, "null"), "action", actionId, this.cipher) ?? "null",
        error: input.error === undefined
          ? existing.error
          : encrypt(input.error, "action", actionId, this.cipher) ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(proactiveActions.id, actionId),
        ),
      )
      .returning();
    if (!updated) return null;
    await this.audit.recordAudit(ctx, {
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
}
