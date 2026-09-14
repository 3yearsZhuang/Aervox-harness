/**
 * Aervox｜思隅 @aervox/api — 本地模型降级阶梯决策器服务 (CR-034/CR-042 N1)
 *
 * 规则依据：docs/reference/changes/CR-034-local-model-fallback-ladder.md
 * - 会话级粘滞（Session Stickiness）：避免逐回合抖动；
 * - 恢复回切（Recovery Switchback）：连续 N 次成功探测后新回合回切；
 * - 诚实标识与审计追溯：每回合明确标识 L0/L1/L2 及其原因并留痕。
 */
import type {
  CapabilityTier,
  HealthSnapshot,
  HealthStatus,
  LLMProviderType,
  ModelRoutingEvent,
  ModelRoutingPolicy,
  ModelRoutingPort,
  ModelRoutingSnapshot,
  ModelRoutingTier,
} from "@aervox/contracts";
import { isLiteralLoopbackUrl, mapTierToCapability } from "@aervox/contracts";
import type {
  LocalContext,
  SqliteLLMConfigRepository,
  SqliteModelRoutingRepository,
} from "@aervox/repositories";
import { LlmHealthProber } from "./health-prober.js";

export interface DegradationServiceOptions {
  policy?: Partial<ModelRoutingPolicy>;
  prober?: LlmHealthProber;
}

export class LlmDegradationService implements ModelRoutingPort {
  private readonly prober: LlmHealthProber;
  private readonly policy: ModelRoutingPolicy;
  /** 会话级粘滞状态记录：sessionId -> { tier, presetId, timestamp } */
  private readonly sessionTiers = new Map<
    string,
    { tier: ModelRoutingTier; presetId: string | null; updatedAt: number }
  >();

  constructor(
    private readonly llmRepo: SqliteLLMConfigRepository,
    private readonly routingRepo: SqliteModelRoutingRepository,
    options: DegradationServiceOptions = {},
  ) {
    this.prober = options.prober ?? new LlmHealthProber();
    this.policy = {
      probeIntervalMs: options.policy?.probeIntervalMs ?? 30_000,
      failureThreshold: options.policy?.failureThreshold ?? 3,
      successThreshold: options.policy?.successThreshold ?? 2,
      probeTimeoutMs: options.policy?.probeTimeoutMs ?? 5_000,
      manualLockTier: options.policy?.manualLockTier ?? null,
      autoFallbackEnabled: options.policy?.autoFallbackEnabled ?? true,
    };
  }

  /** 获取当前策略配置 */
  getPolicy(): ModelRoutingPolicy {
    return { ...this.policy };
  }

  /** 更新策略配置（设置面板联动） */
  updatePolicy(patch: Partial<ModelRoutingPolicy>): void {
    Object.assign(this.policy, patch);
  }

  /** 清理会话粘滞记录 */
  clearSessionStickiness(sessionId?: string): void {
    if (sessionId) {
      this.sessionTiers.delete(sessionId);
    } else {
      this.sessionTiers.clear();
    }
  }

  /**
   * 核心决策方法：解析当前生效路由快照（L0/L1/L2）。
   * 满足 ModelRoutingPort 统一接口规范。
   */
  async getRoutingSnapshot(sessionContext?: {
    sessionId?: string;
    turnId?: string;
    requireLocalOnly?: boolean;
    tenant?: LocalContext;
  }): Promise<ModelRoutingSnapshot> {
    const tenant = sessionContext?.tenant ?? {
      workspaceId: "local",
      subjectUserId: "local_user",
    };
    const sessionId = sessionContext?.sessionId;
    const turnId = sessionContext?.turnId;
    const requireLocalOnly = Boolean(sessionContext?.requireLocalOnly);

    // 1. 获取所有预设
    const presetRows = await this.llmRepo.listPresets(tenant);
    const activePreset = presetRows.find((p) => p.isActive === 1) ?? presetRows[0] ?? null;

    // 2. 筛选本地候选预设（回环地址或原生 ollama）
    const localPresets = presetRows.filter(
      (p) =>
        p.enabled === 1 &&
        (isLiteralLoopbackUrl(p.baseUrl) || p.providerType === "ollama"),
    );

    const now = new Date().toISOString();
    const configRevision = activePreset ? `cfg_${activePreset.id}_${activePreset.updatedAt}` : "cfg_empty";

    // 3. 用户手动锁定层级判断
    if (this.policy.manualLockTier) {
      const lockedTier = this.policy.manualLockTier;
      return this.resolveLockedTier(lockedTier, activePreset, localPresets, sessionId, turnId, configRevision, now);
    }

    // 4. 主动画像与隐私严格边界（CR-023/ADR-018：仅允许本机回环模型，云端绝不出网）
    if (requireLocalOnly) {
      return this.resolveLocalOnly(localPresets, sessionId, turnId, configRevision, now);
    }

    // 5. 常规三层降级阶梯逻辑
    // 5.1 若无任何可用预设或未开启自动降级
    if (!activePreset || activePreset.enabled !== 1) {
      return this.resolveFallbackL1OrL2(localPresets, sessionId, turnId, configRevision, now, "active_preset_disabled_or_empty");
    }

    // 5.2 探测激活预设（L0 候选）
    const l0Health = await this.probeAndAssess(activePreset);
    const isL0Available = l0Health.status === "healthy" || l0Health.consecutiveFailures < this.policy.failureThreshold;

    // 5.3 检查会话级粘滞与恢复回切
    if (sessionId && this.sessionTiers.has(sessionId)) {
      const sticky = this.sessionTiers.get(sessionId)!;
      if (sticky.tier === "L1") {
        // 若之前已降级到 L1：检查 L0 是否已连续成功恢复
        if (isL0Available && l0Health.consecutiveSuccesses >= this.policy.successThreshold) {
          // 连续成功达到门限，回切 L0
          return this.applyTierSwitch(
            "L0",
            activePreset,
            "l0_recovered_from_sticky_l1",
            sessionId,
            turnId,
            configRevision,
            l0Health,
            false,
            now,
          );
        }
        // 否则保持粘滞在 L1
        const stickyLocal = localPresets.find((p) => p.id === sticky.presetId) ?? localPresets[0];
        if (stickyLocal) {
          const l1Health = await this.probeAndAssess(stickyLocal);
          if (l1Health.status === "healthy" || l1Health.consecutiveFailures < this.policy.failureThreshold) {
            return {
              tier: "L1",
              capabilityTier: "restricted",
              presetId: stickyLocal.id,
              presetName: stickyLocal.name ?? null,
              providerType: stickyLocal.providerType as LLMProviderType,
              modelId: stickyLocal.modelId,
              baseUrl: stickyLocal.baseUrl,
              isLocal: true,
              localAttestation: isLiteralLoopbackUrl(stickyLocal.baseUrl),
              reason: "session_sticky_l1",
              configRevision,
              healthRevision: `h_${l1Health.presetId}_${l1Health.lastProbeAt}`,
              stickySession: true,
              evaluatedAt: now,
            };
          }
        }
      }
    }

    // 5.4 L0 正常可用
    if (isL0Available) {
      return this.applyTierSwitch(
        "L0",
        activePreset,
        "active_preset_healthy",
        sessionId,
        turnId,
        configRevision,
        l0Health,
        false,
        now,
      );
    }

    // 5.5 L0 不可用，触发降级到 L1（本地模型）或 L2（规则回应）
    return this.resolveFallbackL1OrL2(
      localPresets,
      sessionId,
      turnId,
      configRevision,
      now,
      `l0_unavailable_consecutive_failures_${l0Health.consecutiveFailures}`,
    );
  }

  /** 降级尝试 L1 本地端点，若不可用退至 L2 规则 */
  private async resolveFallbackL1OrL2(
    localPresets: Array<import("@aervox/repositories").LLMConfigModel>,
    sessionId: string | undefined,
    turnId: string | undefined,
    configRevision: string,
    now: string,
    triggerReason: string,
  ): Promise<ModelRoutingSnapshot> {
    for (const localPreset of localPresets) {
      const health = await this.probeAndAssess(localPreset);
      if (health.status === "healthy") {
        return this.applyTierSwitch(
          "L1",
          localPreset,
          triggerReason,
          sessionId,
          turnId,
          configRevision,
          health,
          true,
          now,
        );
      }
    }

    // 无任何健康的本地模型端点，安全降级至 L2 规则回应
    return this.applyTierSwitch(
      "L2",
      null,
      `${triggerReason}_no_healthy_local_model`,
      sessionId,
      turnId,
      configRevision,
      null,
      false,
      now,
    );
  }

  /** 仅允许本地回环时解析 */
  private async resolveLocalOnly(
    localPresets: Array<import("@aervox/repositories").LLMConfigModel>,
    sessionId: string | undefined,
    turnId: string | undefined,
    configRevision: string,
    now: string,
  ): Promise<ModelRoutingSnapshot> {
    for (const localPreset of localPresets) {
      const health = await this.probeAndAssess(localPreset);
      if (health.status === "healthy") {
        return this.applyTierSwitch(
          "L1",
          localPreset,
          "proactive_local_only_boundary",
          sessionId,
          turnId,
          configRevision,
          health,
          true,
          now,
        );
      }
    }

    return this.applyTierSwitch(
      "L2",
      null,
      "proactive_local_only_no_local_model_fallback_l2",
      sessionId,
      turnId,
      configRevision,
      null,
      false,
      now,
    );
  }

  /** 用户手动锁定某层级时的处理 */
  private async resolveLockedTier(
    lockedTier: ModelRoutingTier,
    activePreset: import("@aervox/repositories").LLMConfigModel | null,
    localPresets: Array<import("@aervox/repositories").LLMConfigModel>,
    sessionId: string | undefined,
    turnId: string | undefined,
    configRevision: string,
    now: string,
  ): Promise<ModelRoutingSnapshot> {
    if (lockedTier === "L2") {
      return this.applyTierSwitch("L2", null, "manual_locked_l2", sessionId, turnId, configRevision, null, false, now);
    }
    if (lockedTier === "L1") {
      const local = localPresets[0] ?? null;
      if (!local) {
        return this.applyTierSwitch("L2", null, "manual_locked_l1_no_preset_fallback_l2", sessionId, turnId, configRevision, null, false, now);
      }
      const health = await this.probeAndAssess(local);
      return this.applyTierSwitch("L1", local, "manual_locked_l1", sessionId, turnId, configRevision, health, true, now);
    }
    // lockedTier === "L0"
    if (!activePreset) {
      return this.applyTierSwitch("L2", null, "manual_locked_l0_no_preset_fallback_l2", sessionId, turnId, configRevision, null, false, now);
    }
    const health = await this.probeAndAssess(activePreset);
    return this.applyTierSwitch("L0", activePreset, "manual_locked_l0", sessionId, turnId, configRevision, health, false, now);
  }

  /** 执行层级切换记录与快照生成 */
  private async applyTierSwitch(
    toTier: ModelRoutingTier,
    preset: import("@aervox/repositories").LLMConfigModel | null,
    reason: string,
    sessionId: string | undefined,
    turnId: string | undefined,
    configRevision: string,
    health: HealthSnapshot | null,
    stickySession: boolean,
    now: string,
  ): Promise<ModelRoutingSnapshot> {
    const prevSticky = sessionId ? this.sessionTiers.get(sessionId) : undefined;
    const fromTier = prevSticky?.tier ?? "L0";

    // 若发生了切层，写审计事件
    if (sessionId && prevSticky && prevSticky.tier !== toTier) {
      const event: ModelRoutingEvent = {
        id: `mre_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId: sessionId ?? null,
        turnId: turnId ?? null,
        fromTier,
        toTier,
        fromPresetId: prevSticky.presetId,
        toPresetId: preset?.id ?? null,
        reason,
        occurredAt: now,
      };
      await this.routingRepo.recordRoutingEvent(event).catch(() => undefined);
    }

    // 更新会话粘滞状态
    if (sessionId) {
      this.sessionTiers.set(sessionId, {
        tier: toTier,
        presetId: preset?.id ?? null,
        updatedAt: Date.now(),
      });
    }

    const isLocal = toTier !== "L0" || (preset ? isLiteralLoopbackUrl(preset.baseUrl) : true);
    const localAttestation = preset ? isLiteralLoopbackUrl(preset.baseUrl) : true;

    return {
      tier: toTier,
      capabilityTier: mapTierToCapability(toTier),
      presetId: preset?.id ?? null,
      presetName: preset?.name ?? null,
      providerType: preset ? (preset.providerType as LLMProviderType) : null,
      modelId: preset?.modelId ?? null,
      baseUrl: preset?.baseUrl ?? null,
      isLocal,
      localAttestation,
      reason,
      configRevision,
      healthRevision: health ? `h_${health.presetId}_${health.lastProbeAt}` : "h_none",
      stickySession,
      evaluatedAt: now,
    };
  }

  /** 对指定预设进行健康探测（带冷却与节流），更新仓储并返回最新快照 */
  private async probeAndAssess(
    preset: import("@aervox/repositories").LLMConfigModel,
  ): Promise<HealthSnapshot> {
    const existing = await this.routingRepo.getHealthSnapshot(preset.id);
    const now = Date.now();

    // 节流校验：若仍在 probeIntervalMs 内，复用已有健康快照
    if (existing?.lastProbeAt) {
      const lastProbeTime = new Date(existing.lastProbeAt).getTime();
      if (now - lastProbeTime < this.policy.probeIntervalMs) {
        return existing;
      }
    }

    // 发起探测
    const endpointIdentity = this.extractEndpointIdentity(preset.baseUrl);
    const result = await this.prober.probe({
      baseUrl: preset.baseUrl,
      apiKey: preset.apiKey ?? undefined,
      modelId: preset.modelId,
      providerType: preset.providerType as LLMProviderType,
      timeoutMs: this.policy.probeTimeoutMs,
    });

    const consecutiveSuccesses = result.ok ? (existing?.consecutiveSuccesses ?? 0) + 1 : 0;
    const consecutiveFailures = result.ok ? 0 : (existing?.consecutiveFailures ?? 0) + 1;
    const status: HealthStatus = result.ok
      ? "healthy"
      : consecutiveFailures >= this.policy.failureThreshold
      ? "unavailable"
      : "degraded";

    const snapshot: HealthSnapshot = {
      presetId: preset.id,
      providerType: preset.providerType as LLMProviderType,
      endpointIdentity,
      status,
      consecutiveSuccesses,
      consecutiveFailures,
      latencyMs: result.latencyMs,
      lastProbeAt: new Date(now).toISOString(),
      lastSuccessAt: result.ok ? new Date(now).toISOString() : existing?.lastSuccessAt ?? null,
      lastFailureAt: !result.ok ? new Date(now).toISOString() : existing?.lastFailureAt ?? null,
      errorCategory: result.errorCategory,
      errorMessage: result.errorMessage,
      cooldownUntil: null,
    };

    await this.routingRepo.saveHealthSnapshot(snapshot).catch(() => undefined);
    return snapshot;
  }

  /** 脱敏提取端点标识（仅提取 host:port） */
  private extractEndpointIdentity(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      return url.host;
    } catch {
      return "invalid_url";
    }
  }
}
