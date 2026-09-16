/**
 * Aervox｜思隅 @aervox/repositories — CAP-033 主动智能模式 SQLite 仓储 Facade
 *
 * 本仓储是主动画像数据的唯一数据库入口。它不使用 outbox，也不把原始捕获
 * 写入普通 analytics/audit 表；所有读取和写入都强制带本地边界。
 *
 * 机械拆分（B1 先例模式，零行为变更）：实现委托给 proactive/ 目录下
 * 6 个协作 Store 与共享辅助模块；对外导出面（类名、构造签名）与
 * IProactiveProfileRepository 契约保持不变。exportSnapshot 为纯快照编排
 * （聚合各 Store 的 list 能力，无直接 SQL），保留在本 Facade。
 */
import type { AervoxDatabase } from "../../client.js";
import type { LocalContext } from "../../local-context.js";
import type { ProactiveVaultCipher } from "../../proactive-vault-crypto.js";
import type {
  IProactiveProfileRepository,
  ProactiveActionModel,
  ProactiveActivationLeaseModel,
  ProactiveAuditEventModel,
  ProactiveBehaviorObservationModel,
  ProactiveCaptureModel,
  ProactiveClaimState,
  ProactiveConsentModel,
  ProactiveEffectiveStatus,
  ProactiveProfileClaimModel,
  ProactiveProfileRevisionModel,
  ProactiveSourceDeletionResult,
  ProactiveSourceGrantModel,
} from "../types/index.js";
import { ActivationLeaseStore } from "./proactive/activation-lease-store.js";
import { AuditExportStore } from "./proactive/audit-export-store.js";
import { CaptureStore } from "./proactive/capture-store.js";
import { ClaimActionStore } from "./proactive/claim-action-store.js";
import { ProfileLifecycleStore } from "./proactive/profile-lifecycle-store.js";
import { SourceGrantStore } from "./proactive/source-grant-store.js";
import { MAX_LIST_LIMIT } from "./proactive/shared.js";

export class SqliteProactiveProfileRepository implements IProactiveProfileRepository {
  private readonly lifecycleStore: ProfileLifecycleStore;
  private readonly sourceGrantStore: SourceGrantStore;
  private readonly activationLeaseStore: ActivationLeaseStore;
  private readonly captureStore: CaptureStore;
  private readonly claimActionStore: ClaimActionStore;
  private readonly auditStore: AuditExportStore;

  constructor(db: AervoxDatabase, cipher?: ProactiveVaultCipher) {
    this.auditStore = new AuditExportStore(db);
    this.sourceGrantStore = new SourceGrantStore(db, this.auditStore, cipher);
    this.lifecycleStore = new ProfileLifecycleStore(db, this.sourceGrantStore, this.auditStore, cipher);
    this.activationLeaseStore = new ActivationLeaseStore(db, this.lifecycleStore, this.auditStore);
    this.captureStore = new CaptureStore(db, this.lifecycleStore, this.auditStore, cipher);
    this.claimActionStore = new ClaimActionStore(
      db,
      this.lifecycleStore,
      this.sourceGrantStore,
      this.activationLeaseStore,
      this.auditStore,
      cipher,
    );
  }

  async confirmProfile(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["confirmProfile"]>[1],
  ): Promise<{ revision: ProactiveProfileRevisionModel; sources: ProactiveSourceGrantModel[] }> {
    return this.lifecycleStore.confirmProfile(ctx, input);
  }

  async createDraft(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createDraft"]>[1],
  ): Promise<ProactiveProfileRevisionModel> {
    return this.lifecycleStore.createDraft(ctx, input);
  }

  async getRevision(ctx: LocalContext, revisionId?: string): Promise<ProactiveProfileRevisionModel | null> {
    return this.lifecycleStore.getRevision(ctx, revisionId);
  }

  async listRevisions(ctx: LocalContext, limit?: number): Promise<ProactiveProfileRevisionModel[]> {
    return this.lifecycleStore.listRevisions(ctx, limit);
  }

  async setDesiredState(
    ctx: LocalContext,
    state: Parameters<IProactiveProfileRepository["setDesiredState"]>[1],
    actorId: string,
    revisionId?: string,
  ): Promise<ProactiveProfileRevisionModel | null> {
    return this.lifecycleStore.setDesiredState(ctx, state, actorId, revisionId);
  }

  async listSourceGrants(ctx: LocalContext, revisionId?: string): Promise<ProactiveSourceGrantModel[]> {
    return this.sourceGrantStore.listSourceGrants(ctx, revisionId);
  }

  async updateSourceGrant(
    ctx: LocalContext,
    sourceGrantId: string,
    input: Parameters<IProactiveProfileRepository["updateSourceGrant"]>[2],
  ): Promise<ProactiveSourceGrantModel | null> {
    return this.sourceGrantStore.updateSourceGrant(ctx, sourceGrantId, input);
  }

  async deleteSourceData(
    ctx: LocalContext,
    sourceGrantId: string,
    actorId: string,
  ): Promise<ProactiveSourceDeletionResult | null> {
    return this.sourceGrantStore.deleteSourceData(ctx, sourceGrantId, actorId);
  }

  async createActivationLease(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createActivationLease"]>[1],
  ): Promise<ProactiveActivationLeaseModel> {
    return this.activationLeaseStore.createActivationLease(ctx, input);
  }

  async heartbeatActivationLease(
    ctx: LocalContext,
    leaseId: string,
    input: Parameters<IProactiveProfileRepository["heartbeatActivationLease"]>[2],
  ): Promise<ProactiveActivationLeaseModel | null> {
    return this.activationLeaseStore.heartbeatActivationLease(ctx, leaseId, input);
  }

  async endActivationLease(ctx: LocalContext, leaseId: string, reason: string, actorId: string): Promise<ProactiveActivationLeaseModel | null> {
    return this.activationLeaseStore.endActivationLease(ctx, leaseId, reason, actorId);
  }

  async getEffectiveStatus(ctx: LocalContext, now = new Date().toISOString()): Promise<ProactiveEffectiveStatus> {
    return this.lifecycleStore.getEffectiveStatus(ctx, now);
  }

  async createCapture(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createCapture"]>[1],
  ): Promise<ProactiveCaptureModel> {
    return this.captureStore.createCapture(ctx, input);
  }

  async listCaptures(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listCaptures"]>[1],
  ): Promise<ProactiveCaptureModel[]> {
    return this.captureStore.listCaptures(ctx, options);
  }

  async createObservation(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createObservation"]>[1],
  ): Promise<ProactiveBehaviorObservationModel> {
    return this.captureStore.createObservation(ctx, input);
  }

  async listObservations(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listObservations"]>[1],
  ): Promise<ProactiveBehaviorObservationModel[]> {
    return this.captureStore.listObservations(ctx, options);
  }

  async markCaptureDistilled(ctx: LocalContext, captureId: string, memoryIds: string[]): Promise<ProactiveCaptureModel | null> {
    return this.captureStore.markCaptureDistilled(ctx, captureId, memoryIds);
  }

  async markCaptureDistillationFailed(ctx: LocalContext, captureId: string, reason?: string): Promise<ProactiveCaptureModel | null> {
    return this.captureStore.markCaptureDistillationFailed(ctx, captureId, reason);
  }

  async purgeEligibleCaptures(ctx?: LocalContext, now = new Date().toISOString(), limit = 200): Promise<number> {
    return this.captureStore.purgeEligibleCaptures(ctx, now, limit);
  }

  async createClaim(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createClaim"]>[1],
  ): Promise<ProactiveProfileClaimModel> {
    return this.claimActionStore.createClaim(ctx, input);
  }

  async listClaims(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listClaims"]>[1],
  ): Promise<ProactiveProfileClaimModel[]> {
    return this.claimActionStore.listClaims(ctx, options);
  }

  async updateClaimState(ctx: LocalContext, claimId: string, state: ProactiveClaimState, actorId: string): Promise<ProactiveProfileClaimModel | null> {
    return this.claimActionStore.updateClaimState(ctx, claimId, state, actorId);
  }

  async createAction(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["createAction"]>[1],
  ): Promise<ProactiveActionModel> {
    return this.claimActionStore.createAction(ctx, input);
  }

  async listActions(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["listActions"]>[1],
  ): Promise<ProactiveActionModel[]> {
    return this.claimActionStore.listActions(ctx, options);
  }

  async updateAction(
    ctx: LocalContext,
    actionId: string,
    input: Parameters<IProactiveProfileRepository["updateAction"]>[2],
  ): Promise<ProactiveActionModel | null> {
    return this.claimActionStore.updateAction(ctx, actionId, input);
  }

  async recordAudit(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["recordAudit"]>[1],
  ): Promise<ProactiveAuditEventModel> {
    return this.auditStore.recordAudit(ctx, input);
  }

  async listAuditEvents(ctx: LocalContext, limit?: number): Promise<ProactiveAuditEventModel[]> {
    return this.auditStore.listAuditEvents(ctx, limit);
  }

  async exportSnapshot(
    ctx: LocalContext,
    options?: Parameters<IProactiveProfileRepository["exportSnapshot"]>[1],
  ) {
    const includeRaw = options?.includeRaw === true;
    const [revisions, sources, leases, captures, observations, claims, actions, auditEvents, consents] = await Promise.all([
      this.listRevisions(ctx, MAX_LIST_LIMIT),
      this.listSourceGrants(ctx),
      this.listLeases(ctx),
      this.listCaptureRows(ctx, includeRaw),
      this.listObservations(ctx, { limit: MAX_LIST_LIMIT }),
      this.listClaims(ctx, { limit: MAX_LIST_LIMIT }),
      this.listActions(ctx, { limit: MAX_LIST_LIMIT }),
      this.listAuditEvents(ctx, MAX_LIST_LIMIT),
      this.listProactiveConsents(ctx),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: "cap-033-proactive-v1",
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

  private async listLeases(ctx: LocalContext): Promise<ProactiveActivationLeaseModel[]> {
    return this.activationLeaseStore.listLeases(ctx);
  }

  private async listProactiveConsents(ctx: LocalContext): Promise<ProactiveConsentModel[]> {
    return this.auditStore.listProactiveConsents(ctx);
  }

  private async listCaptureRows(ctx: LocalContext, includeRaw: boolean): Promise<ProactiveCaptureModel[]> {
    return this.captureStore.listCaptureRows(ctx, includeRaw);
  }
}
