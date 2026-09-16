/**
 * Aervox｜思隅 @aervox/repositories — proactive-profile 仓储类型（自 types.ts 机械拆分）
 */
import type { LocalContext } from "../../local-context.js";

export type ProactiveDesiredState = "none" | "enabled" | "paused" | "revoking" | "revoked";

export type ProactiveRevisionStatus = "draft" | "active" | "superseded" | "revoked";

export type ProactiveSourceGrantState = "requested" | "granted" | "denied" | "revoked" | "expired";

export type ProactiveActivationStatus = "active" | "expired" | "ended" | "revoked";

export type ProactiveCaptureDistillationStatus = "pending" | "distilled" | "failed" | "blocked" | "deleted";

export type ProactiveClaimState = "observed" | "inferred" | "user_asserted" | "confirmed" | "rejected";

export type ProactiveActionState =
  | "pending"
  | "approved"
  | "running"
  | "executed"
  | "denied"
  | "failed"
  | "revoked";

export interface ProactiveProfileRevisionModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  profileVersion: string;
  revision: number;
  deviceId: string;
  desiredState: ProactiveDesiredState;
  status: ProactiveRevisionStatus;
  fullAccessRequired: boolean;
  processingBoundary: "local_only";
  manifest: unknown;
  grantSetHash?: string | null;
  confirmedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveSourceGrantModel {
  id: string;
  revisionId: string;
  workspaceId?: string;
  subjectUserId?: string;
  sourceKey: string;
  purpose: string;
  scope: string;
  osCapability: string;
  state: ProactiveSourceGrantState;
  mandatory: boolean;
  processingBoundary: "local_only";
  grantVersion: number;
  metadata: unknown;
  grantedAt?: string | null;
  revokedAt?: string | null;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveActivationLeaseModel {
  id: string;
  revisionId: string;
  workspaceId?: string;
  subjectUserId?: string;
  deviceId: string;
  epoch: string;
  status: ProactiveActivationStatus;
  localReady: boolean;
  fullAccessSnapshot: boolean;
  issuedAt: string;
  expiresAt: string;
  heartbeatAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveCaptureModel {
  id: string;
  revisionId: string;
  sourceGrantId: string;
  workspaceId?: string;
  subjectUserId?: string;
  sourceKey: string;
  contentType: string;
  payloadText?: string | null;
  payload?: unknown;
  checksum: string;
  byteSize: number;
  processingBoundary: "local_only";
  observedAt: string;
  ingestedAt: string;
  retentionUntil: string;
  distillationStatus: ProactiveCaptureDistillationStatus;
  distillationAttemptCount: number;
  lastDistillationError?: string | null;
  retentionBlockedAt?: string | null;
  distilledAt?: string | null;
  distilledMemoryIds: string[];
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveBehaviorObservationModel {
  id: string;
  revisionId: string;
  sourceGrantId: string;
  workspaceId?: string;
  subjectUserId?: string;
  sourceKey: string;
  observationType: string;
  subjectKey: string;
  payload: unknown;
  checksum: string;
  processingBoundary: "local_only";
  algorithmVersion: string;
  observedAt: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveProfileClaimModel {
  id: string;
  revisionId: string;
  workspaceId?: string;
  subjectUserId?: string;
  claimType: string;
  subjectKey: string;
  content: string;
  state: ProactiveClaimState;
  confidence: number;
  algorithmVersion: string;
  processingBoundary: "local_only";
  evidenceCaptureIds: string[];
  evidenceRefs: unknown[];
  sourceGrantIds: string[];
  firstObservedAt?: string | null;
  lastObservedAt?: string | null;
  confirmedAt?: string | null;
  rejectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveActionModel {
  id: string;
  revisionId: string;
  activationLeaseId?: string | null;
  workspaceId?: string;
  subjectUserId?: string;
  actionType: string;
  target: string;
  request: unknown;
  authorizationScope: string;
  actionGrantRevision: string;
  state: ProactiveActionState;
  requestedBy: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  reversible: boolean;
  external: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  outcome?: unknown;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProactiveAuditEventModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  revisionId?: string | null;
  eventType: string;
  actorId: string;
  resourceType: string;
  resourceId: string;
  payload: unknown;
  processingBoundary: "local_only";
  occurredAt: string;
  createdAt: string;
}

export interface ProactiveConsentModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  actorId: string;
  purpose: string;
  scope: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

export interface ProactiveEffectiveStatus {
  desiredState: ProactiveDesiredState;
  effectiveState: "inactive" | "configuring" | "active" | "limited" | "suspended" | "revoking";
  reason: string;
  revision: ProactiveProfileRevisionModel | null;
  sources: ProactiveSourceGrantModel[];
  activationLease: ProactiveActivationLeaseModel | null;
  mandatorySources: { total: number; granted: number; missing: string[] };
  expiredUndistilledCaptures: number;
}

export interface ProactiveExportSnapshot {
  exportedAt: string;
  schemaVersion: string;
  profileRevisions: ProactiveProfileRevisionModel[];
  sourceGrants: ProactiveSourceGrantModel[];
  activationLeases: ProactiveActivationLeaseModel[];
  captures: ProactiveCaptureModel[];
  observations: ProactiveBehaviorObservationModel[];
  claims: ProactiveProfileClaimModel[];
  actions: ProactiveActionModel[];
  auditEvents: ProactiveAuditEventModel[];
  consents: ProactiveConsentModel[];
}

export interface ProactiveSourceDeletionResult {
  sourceGrantId: string;
  capturesScrubbed: number;
  observationsDeleted: number;
  claimsDeleted: number;
  actionsScrubbed: number;
}

export interface IProactiveProfileRepository {
  /** 原子确认一套版本化全量画像授权包，并写入逐来源授权回执。 */
  confirmProfile(
    ctx: LocalContext,
    input: {
      id: string;
      profileVersion?: string;
      deviceId: string;
      manifest?: unknown;
      grantSetHash?: string | null;
      fullAccessSnapshot?: boolean;
      actorId: string;
      sources?: Array<{
        id: string;
        sourceKey: string;
        purpose?: string;
        scope?: string;
        osCapability?: string;
        state?: ProactiveSourceGrantState;
        mandatory?: boolean;
        grantVersion?: number;
        metadata?: unknown;
        grantedAt?: string | null;
        lastVerifiedAt?: string | null;
      }>;
    },
  ): Promise<{ revision: ProactiveProfileRevisionModel; sources: ProactiveSourceGrantModel[] }>;
  createDraft(
    ctx: LocalContext,
    input: {
      id: string;
      profileVersion?: string;
      deviceId: string;
      manifest?: unknown;
      actorId: string;
    },
  ): Promise<ProactiveProfileRevisionModel>;
  getRevision(ctx: LocalContext, revisionId?: string): Promise<ProactiveProfileRevisionModel | null>;
  listRevisions(ctx: LocalContext, limit?: number): Promise<ProactiveProfileRevisionModel[]>;
  setDesiredState(
    ctx: LocalContext,
    state: ProactiveDesiredState,
    actorId: string,
    revisionId?: string,
  ): Promise<ProactiveProfileRevisionModel | null>;
  listSourceGrants(ctx: LocalContext, revisionId?: string): Promise<ProactiveSourceGrantModel[]>;
  updateSourceGrant(
    ctx: LocalContext,
    sourceGrantId: string,
    input: {
      state: ProactiveSourceGrantState;
      metadata?: unknown;
      lastVerifiedAt?: string | null;
      actorId: string;
    },
  ): Promise<ProactiveSourceGrantModel | null>;
  deleteSourceData(
    ctx: LocalContext,
    sourceGrantId: string,
    actorId: string,
  ): Promise<ProactiveSourceDeletionResult | null>;
  createActivationLease(
    ctx: LocalContext,
    input: {
      id: string;
      revisionId: string;
      deviceId: string;
      epoch: string;
      ttlMs?: number;
      localReady: boolean;
      fullAccessSnapshot: boolean;
      metadata?: unknown;
      actorId: string;
    },
  ): Promise<ProactiveActivationLeaseModel>;
  heartbeatActivationLease(
    ctx: LocalContext,
    leaseId: string,
    input: { ttlMs?: number; localReady?: boolean; fullAccessSnapshot?: boolean; metadata?: unknown },
  ): Promise<ProactiveActivationLeaseModel | null>;
  endActivationLease(ctx: LocalContext, leaseId: string, reason: string, actorId: string): Promise<ProactiveActivationLeaseModel | null>;
  getEffectiveStatus(ctx: LocalContext, now?: string): Promise<ProactiveEffectiveStatus>;
  createCapture(
    ctx: LocalContext,
    input: {
      id: string;
      revisionId: string;
      sourceGrantId: string;
      sourceKey: string;
      contentType: string;
      payloadText?: string | null;
      payload?: unknown;
      checksum: string;
      byteSize?: number;
      observedAt?: string;
      ingestedAt?: string;
    },
  ): Promise<ProactiveCaptureModel>;
  listCaptures(ctx: LocalContext, options?: { revisionId?: string; sourceKey?: string; includeDeleted?: boolean; limit?: number }): Promise<ProactiveCaptureModel[]>;
  createObservation(
    ctx: LocalContext,
    input: {
      id: string;
      revisionId: string;
      sourceGrantId: string;
      sourceKey: string;
      observationType: string;
      subjectKey: string;
      payload?: unknown;
      checksum: string;
      algorithmVersion?: string;
      observedAt?: string;
      normalizedAt?: string;
    },
  ): Promise<ProactiveBehaviorObservationModel>;
  listObservations(ctx: LocalContext, options?: { revisionId?: string; sourceKey?: string; limit?: number }): Promise<ProactiveBehaviorObservationModel[]>;
  markCaptureDistilled(ctx: LocalContext, captureId: string, memoryIds: string[]): Promise<ProactiveCaptureModel | null>;
  markCaptureDistillationFailed(ctx: LocalContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null>;
  purgeEligibleCaptures(ctx?: LocalContext, now?: string, limit?: number): Promise<number>;
  createClaim(
    ctx: LocalContext,
    input: {
      id: string;
      revisionId: string;
      claimType: string;
      subjectKey: string;
      content: string;
      state?: ProactiveClaimState;
      confidence?: number;
      algorithmVersion?: string;
      evidenceCaptureIds?: string[];
      evidenceRefs?: unknown[];
      sourceGrantIds?: string[];
      firstObservedAt?: string | null;
      lastObservedAt?: string | null;
    },
  ): Promise<ProactiveProfileClaimModel>;
  listClaims(ctx: LocalContext, options?: { revisionId?: string; state?: ProactiveClaimState; limit?: number }): Promise<ProactiveProfileClaimModel[]>;
  updateClaimState(ctx: LocalContext, claimId: string, state: ProactiveClaimState, actorId: string): Promise<ProactiveProfileClaimModel | null>;
  createAction(
    ctx: LocalContext,
    input: {
      id: string;
      revisionId: string;
      activationLeaseId?: string | null;
      actionType: string;
      target: string;
      request?: unknown;
      authorizationScope: string;
      actionGrantRevision: string;
      requestedBy: string;
      reversible?: boolean;
      external?: boolean;
    },
  ): Promise<ProactiveActionModel>;
  listActions(ctx: LocalContext, options?: { revisionId?: string; state?: ProactiveActionState; limit?: number }): Promise<ProactiveActionModel[]>;
  updateAction(
    ctx: LocalContext,
    actionId: string,
    input: { state: ProactiveActionState; actorId?: string; outcome?: unknown; error?: string | null },
  ): Promise<ProactiveActionModel | null>;
  recordAudit(ctx: LocalContext, input: { id: string; revisionId?: string | null; eventType: string; actorId: string; resourceType: string; resourceId: string; payload?: unknown }): Promise<ProactiveAuditEventModel>;
  listAuditEvents(ctx: LocalContext, limit?: number): Promise<ProactiveAuditEventModel[]>;
  exportSnapshot(ctx: LocalContext, options?: { includeRaw?: boolean }): Promise<ProactiveExportSnapshot>;
}
