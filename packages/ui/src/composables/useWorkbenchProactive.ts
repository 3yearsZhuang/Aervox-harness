import { computed, ref, type Ref } from 'vue';
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CalendarDays,
  Check,
  Gauge,
  Heart,
  History,
  Home,
  Route,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from 'lucide-vue-next';
import type {
  ProfileAuthorizationRequest,
  ProfileCapabilityState,
  ProfileDesiredState,
  ProfilePersistenceUpdate,
  ProactiveDesktopBridge,
  ProactiveHealthSampleView,
  ProactiveHomeEntityView,
  ProactiveIntelligenceDashboard,
  ProactiveProfileClaimView,
  ProactiveProfileStatus,
} from '@aervox/contracts/proactive';
import type { ToolApprovalMode } from '@aervox/contracts';
import { profileStatusLabel } from '@aervox/contracts/proactive';

export function proactiveBridge(): ProactiveDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { fairyDesktop?: { proactive?: ProactiveDesktopBridge } }).fairyDesktop?.proactive;
}

export function useWorkbenchProactive(options: {
  isWeb: Ref<boolean>;
  toolApprovalMode: Ref<ToolApprovalMode>;
}) {
  const proactiveStatus = ref<ProactiveProfileStatus | null>(null);
  const proactiveClaims = ref<readonly ProactiveProfileClaimView[]>([]);
  const proactiveDialogOpen = ref(false);
  const proactiveAcknowledged = ref(false);
  const proactiveAutostart = ref(true);
  const proactiveBackground = ref(true);
  const proactiveBusy = ref(false);
  const proactiveError = ref<string | null>(null);
  const proactiveNotice = ref<string | null>(null);
  const proactiveDashboard = ref<ProactiveIntelligenceDashboard | null>(null);
  const proactiveView = ref<'overview' | 'integrations'>('overview');

  const homeAssistantForm = ref({ displayName: '家庭', endpoint: 'http://homeassistant.local:8123', accessToken: '' });
  const xiaomiHealthForm = ref({
    displayName: '小米运动健康',
    apiBaseUrl: '',
    accessToken: '',
    refreshToken: '',
    tokenEndpoint: '',
    clientId: '',
    clientSecret: '',
    dailyPath: '/v1/health/daily',
  });
  const homeEntityOpsDrafts = ref<Record<string, string>>({});

  const proactiveActive = computed(() => proactiveStatus.value?.effectiveState === 'active');
  const homeAssistantConnections = computed(() => proactiveDashboard.value?.connections.filter((item) => item.provider === 'home_assistant') ?? []);
  const xiaomiHealthConnections = computed(() => proactiveDashboard.value?.connections.filter((item) => item.provider === 'xiaomi_health') ?? []);
  const homeAssistantEntities = computed(() => proactiveDashboard.value?.homeEntities ?? []);

  const proactiveIntelligenceCapabilities = computed(() => {
    const dashboard = proactiveDashboard.value;
    return [
      { id: 'timeline', label: '统一个人时间线', icon: History, count: dashboard?.timeline.length ?? 0 },
      { id: 'projects', label: '项目与意图图谱', icon: Route, count: dashboard?.projects.length ?? 0 },
      { id: 'workflows', label: '操作流程学习', icon: Workflow, count: dashboard?.workflows.length ?? 0 },
      { id: 'triggers', label: '情境主动触发', icon: Zap, count: dashboard?.triggers.length ?? 0 },
      { id: 'verification', label: '计划执行验证', icon: Check, count: dashboard?.verifications.length ?? 0 },
      { id: 'conflicts', label: '画像冲突纠正', icon: AlertTriangle, count: dashboard?.conflicts.length ?? 0 },
      { id: 'preparations', label: '主动准备包', icon: Sparkles, count: dashboard?.preparations.length ?? 0 },
      { id: 'attention', label: '注意力与疲劳', icon: Gauge, count: dashboard?.attention.length ?? 0 },
      { id: 'drift', label: '行为漂移检测', icon: Activity, count: dashboard?.drift.length ?? 0 },
      { id: 'relationships', label: '关系与沟通上下文', icon: Users, count: dashboard?.relationships.length ?? 0 },
      { id: 'scenes', label: '本地场景模型', icon: Home, count: dashboard?.scenes.length ?? 0 },
      { id: 'reviews', label: '每日与每周回顾', icon: CalendarDays, count: dashboard?.reviews.length ?? 0 },
    ];
  });

  function recordProactiveActivity(
    source: 'aervox.activity' | 'aervox.operation',
    eventType: string,
    payloadText?: string,
    metadata?: Record<string, unknown>,
  ) {
    if (options.isWeb.value || proactiveStatus.value?.desiredState !== 'enabled') return;
    void proactiveBridge()?.recordActivity(source, { eventType, payloadText, metadata }).catch(() => undefined);
  }

  function capabilityStatusLabel(status: ProfileCapabilityState['osStatus']): string {
    return {
      granted: '已授权',
      denied: '已拒绝',
      prompt: '等待授权',
      unavailable: '不可用',
      unknown: '待验证',
    }[status];
  }

  function capabilityStatusClass(status: ProfileCapabilityState['osStatus']): string {
    return `is-${status}`;
  }

  function proactiveStateLabel(status: ProactiveProfileStatus | null): string {
    if (!status) return options.isWeb.value ? '桌面端可用' : '未连接本地 Host';
    return profileStatusLabel(status.effectiveState);
  }

  function proactiveSuspendHint(status: ProactiveProfileStatus | null): string {
    if (!status || (status.effectiveState !== 'suspended' && status.effectiveState !== 'limited')) return '';
    if (status.host?.reason === 'unsigned_development_host') {
      return '未签名的开发构建默认不受信任；使用 ./aervox dev（已自动设置 AERVOX_TRUST_LOCAL_DEV_HOST=1）或手动设置该变量后重新打开。';
    }
    const reasonLabel: Record<string, string> = {
      tool_mode: '请先在输入区开启「完全访问」。',
      user_paused: '你已手动暂停观察，可点击「恢复观察」。',
      local_unavailable: '本地 API 不可达或 Host 未受信，请确认 API 已在本机运行。',
      os_permission: '存在未授予的必需系统权限，请在下方列表逐项授权。',
      lease_expired: '激活租约已过期，刷新状态即可续期。',
      watermark: '授权快照与服务端不一致，请重新确认授权。',
      policy_mismatch: '授权版本与服务端策略不一致，请重新确认授权。',
      source_revision_changed: '画像授权修订已变化，请重新确认授权。',
    };
    return status.suspendReason ? reasonLabel[status.suspendReason] ?? '' : '';
  }

  async function refreshProactiveStatus() {
    const bridge = proactiveBridge();
    if (options.isWeb.value || !bridge) {
      proactiveStatus.value = null;
      return;
    }
    try {
      const [status, claims, dashboard] = await Promise.all([
        bridge.getStatus(options.toolApprovalMode.value),
        bridge.listClaims().catch(() => []),
        bridge.getIntelligenceDashboard().catch(() => null),
      ]);
      proactiveStatus.value = status;
      proactiveClaims.value = claims;
      proactiveDashboard.value = dashboard;
      if (dashboard) {
        homeEntityOpsDrafts.value = Object.fromEntries(
          dashboard.homeEntities.map((entity) => [entity.id, entity.allowedOps.join(', ')]),
        );
      }
      proactiveAutostart.value = proactiveStatus.value.persistence.autostart;
      proactiveBackground.value = proactiveStatus.value.persistence.background;
      proactiveError.value = null;
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '无法读取主动智能状态';
    }
  }

  function integrationTime(value: string | null | undefined): string {
    if (!value) return '尚未同步';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
  }

  function healthMetricLabel(sample: ProactiveHealthSampleView): string {
    return {
      steps: '步数',
      sleep_minutes: '睡眠',
      resting_heart_rate: '静息心率',
    }[sample.metric] ?? sample.metric;
  }

  function healthMetricValue(sample: ProactiveHealthSampleView): string {
    if (sample.metric === 'sleep_minutes') return `${Math.floor(sample.value / 60)} 小时 ${sample.value % 60} 分`;
    return `${sample.value} ${sample.unit === 'count' ? '步' : sample.unit}`;
  }

  async function connectHomeAssistant() {
    const bridge = proactiveBridge();
    if (!bridge || !proactiveActive.value || !homeAssistantForm.value.endpoint.trim() || !homeAssistantForm.value.accessToken.trim()) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    proactiveNotice.value = null;
    try {
      await bridge.connectHomeAssistant({
        displayName: homeAssistantForm.value.displayName.trim() || '家庭',
        endpoint: homeAssistantForm.value.endpoint.trim(),
        accessToken: homeAssistantForm.value.accessToken,
        subscriptionEnabled: true,
      });
      homeAssistantForm.value.accessToken = '';
      proactiveNotice.value = 'Home Assistant 已连接并完成实体同步';
      await refreshProactiveStatus();
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : 'Home Assistant 连接失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function connectXiaomiHealth() {
    const bridge = proactiveBridge();
    if (!bridge || !proactiveActive.value || !xiaomiHealthForm.value.apiBaseUrl.trim() || !xiaomiHealthForm.value.accessToken.trim()) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    proactiveNotice.value = null;
    try {
      await bridge.connectXiaomiHealth({
        displayName: xiaomiHealthForm.value.displayName.trim() || '小米运动健康',
        apiBaseUrl: xiaomiHealthForm.value.apiBaseUrl.trim(),
        accessToken: xiaomiHealthForm.value.accessToken,
        refreshToken: xiaomiHealthForm.value.refreshToken.trim() || undefined,
        tokenEndpoint: xiaomiHealthForm.value.tokenEndpoint.trim() || undefined,
        clientId: xiaomiHealthForm.value.clientId.trim() || undefined,
        clientSecret: xiaomiHealthForm.value.clientSecret,
        dailyPath: xiaomiHealthForm.value.dailyPath.trim() || undefined,
        scopes: ['steps', 'sleep', 'resting_heart_rate'],
      });
      xiaomiHealthForm.value.accessToken = '';
      xiaomiHealthForm.value.refreshToken = '';
      xiaomiHealthForm.value.clientSecret = '';
      proactiveNotice.value = '小米运动健康已连接并完成今日同步';
      await refreshProactiveStatus();
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '小米运动健康连接失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function syncProactiveConnection(provider: string, connectionId: string) {
    const bridge = proactiveBridge();
    if (!bridge) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      if (provider === 'home_assistant') await bridge.syncHomeAssistant(connectionId);
      else await bridge.syncXiaomiHealth(connectionId);
      proactiveNotice.value = '同步完成';
      await refreshProactiveStatus();
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '外部连接同步失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function deleteProactiveConnection(provider: string, connectionId: string, displayName: string) {
    const bridge = proactiveBridge();
    if (!bridge || !window.confirm(`撤销“${displayName}”并删除本地凭据与缓存数据？`)) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      if (provider === 'home_assistant') await bridge.deleteHomeAssistant(connectionId);
      else await bridge.deleteXiaomiHealth(connectionId);
      proactiveNotice.value = `已撤销 ${displayName}`;
      await refreshProactiveStatus();
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '外部连接撤销失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function updateHomeEntity(entity: ProactiveHomeEntityView, patch: { enabled?: boolean; allowedOps?: string[] }) {
    const bridge = proactiveBridge();
    if (!bridge) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      const updated = await bridge.configureHomeAssistantEntity(entity.connectionId, entity.entityId, patch);
      if (proactiveDashboard.value) {
        proactiveDashboard.value = {
          ...proactiveDashboard.value,
          homeEntities: proactiveDashboard.value.homeEntities.map((item) => (item.id === updated.id ? updated : item)),
        };
      }
      homeEntityOpsDrafts.value[updated.id] = updated.allowedOps.join(', ');
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : 'Home Assistant 实体授权更新失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  function toggleHomeEntity(entity: ProactiveHomeEntityView, event: Event) {
    void updateHomeEntity(entity, { enabled: (event.target as HTMLInputElement).checked });
  }

  function saveHomeEntityOps(entity: ProactiveHomeEntityView) {
    const allowedOps = (homeEntityOpsDrafts.value[entity.id] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    void updateHomeEntity(entity, { allowedOps });
  }

  function proactiveClaimStateLabel(state: ProactiveProfileClaimView['state']): string {
    return {
      observed: '已观察',
      inferred: '推断',
      user_asserted: '用户提供',
      confirmed: '已确认',
      rejected: '已拒绝',
    }[state];
  }

  async function updateProactiveClaimState(claim: ProactiveProfileClaimView, state: 'confirmed' | 'rejected') {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      const updated = await bridge.updateClaimState(claim.id, state);
      proactiveClaims.value = proactiveClaims.value.map((item) => (item.id === updated.id ? updated : item));
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '画像记忆状态更新失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  function openProactiveAuthorization() {
    proactiveError.value = null;
    proactiveAcknowledged.value = false;
    proactiveAutostart.value = proactiveStatus.value?.persistence.autostart ?? true;
    proactiveBackground.value = proactiveStatus.value?.persistence.background ?? true;
    proactiveDialogOpen.value = true;
  }

  function resetProactiveAuthorization() {
    proactiveAcknowledged.value = false;
  }

  async function authorizeProactive() {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value || !proactiveAcknowledged.value || options.toolApprovalMode.value !== 'full_access') return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    const request: ProfileAuthorizationRequest = {
      acknowledged: true,
      enableAutostart: proactiveAutostart.value,
      enableBackground: proactiveBackground.value,
      requestAllOsCapabilities: true,
    };
    try {
      proactiveStatus.value = await bridge.authorize(request, options.toolApprovalMode.value);
      proactiveDialogOpen.value = false;
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '主动智能授权失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function setProactiveDesiredState(desiredState: Extract<ProfileDesiredState, 'enabled' | 'paused' | 'revoked'>) {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    if (desiredState === 'revoked' && !window.confirm('撤销后会立即停止新的观察、召回、分析、提醒和主动任务。已保存的本地数据不会自动删除。确定撤销吗？')) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      proactiveStatus.value = await bridge.setDesiredState(desiredState, options.toolApprovalMode.value);
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '主动智能状态更新失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function setProactivePersistence(update: ProfilePersistenceUpdate) {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      proactiveStatus.value = await bridge.setPersistence(update, options.toolApprovalMode.value);
      proactiveAutostart.value = proactiveStatus.value.persistence.autostart;
      proactiveBackground.value = proactiveStatus.value.persistence.background;
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '常驻设置更新失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function requestProactiveCapability(capability: ProfileCapabilityState) {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    if (!capability.canRequest && capability.reason !== 'user_revoked') return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    try {
      proactiveStatus.value = await bridge.requestCapability(capability.id, options.toolApprovalMode.value);
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '系统权限请求失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  async function deleteProactiveSource(capability: ProfileCapabilityState) {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    if (!window.confirm(`撤销“${capability.label}”并删除其本地捕获、观察和画像证据？此操作不可撤销。`)) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    proactiveNotice.value = null;
    try {
      proactiveStatus.value = await bridge.deleteSource(capability.id, options.toolApprovalMode.value);
      proactiveNotice.value = `已撤销并清理 ${capability.label}`;
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '来源撤销与删除失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  function canToggleProactiveCapability(capability: ProfileCapabilityState): boolean {
    if (capability.osStatus === 'granted') {
      const desired = proactiveStatus.value?.desiredState;
      return desired === 'enabled' || desired === 'paused';
    }
    return capability.canRequest || capability.reason === 'user_revoked';
  }

  function proactiveCapabilitySwitchDisabled(capability: ProfileCapabilityState): boolean {
    return proactiveBusy.value || !canToggleProactiveCapability(capability);
  }

  function proactiveCapabilitySwitchTitle(capability: ProfileCapabilityState): string {
    if (capability.osStatus === 'granted') return '关闭将撤销该来源并删除其本地捕获与画像证据';
    if (capability.canRequest) return '开启将请求系统权限或适配器授权';
    if (capability.reason === 'user_revoked') return '重新开启将清除撤销记录并恢复该来源';
    if (capability.id.startsWith('action.')) return '主动操作能力随授权向导统一确认，不能单独开启';
    return '等待平台接入，暂时无法单独开启';
  }

  async function toggleProactiveCapability(capability: ProfileCapabilityState, event: Event) {
    const inputEl = event.target as HTMLInputElement;
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value || proactiveBusy.value || !canToggleProactiveCapability(capability)) {
      inputEl.checked = capability.osStatus === 'granted';
      return;
    }
    if (inputEl.checked) {
      await requestProactiveCapability(capability);
    } else if (capability.id === 'background.persistent') {
      proactiveBackground.value = false;
      await setProactivePersistence({ background: false });
    } else {
      await deleteProactiveSource(capability);
    }
    const updated = proactiveStatus.value?.capabilities.find((item) => item.id === capability.id);
    inputEl.checked = updated?.osStatus === 'granted';
  }

  async function exportProactiveData(includeRaw: boolean) {
    const bridge = proactiveBridge();
    if (!bridge || options.isWeb.value) return;
    if (includeRaw && !window.confirm('导出文件将包含仍在 7 天保留期内的原始副本。确定继续吗？')) return;
    proactiveBusy.value = true;
    proactiveError.value = null;
    proactiveNotice.value = null;
    try {
      const result = await bridge.exportData(includeRaw);
      if (result) proactiveNotice.value = `已导出到 ${result.path}`;
    } catch (error) {
      proactiveError.value = error instanceof Error ? error.message : '主动画像导出失败';
    } finally {
      proactiveBusy.value = false;
    }
  }

  return {
    proactiveStatus,
    proactiveClaims,
    proactiveDialogOpen,
    proactiveAcknowledged,
    proactiveAutostart,
    proactiveBackground,
    proactiveBusy,
    proactiveError,
    proactiveNotice,
    proactiveDashboard,
    proactiveView,
    homeAssistantForm,
    xiaomiHealthForm,
    homeEntityOpsDrafts,
    proactiveActive,
    homeAssistantConnections,
    xiaomiHealthConnections,
    homeAssistantEntities,
    proactiveIntelligenceCapabilities,
    recordProactiveActivity,
    capabilityStatusLabel,
    capabilityStatusClass,
    proactiveStateLabel,
    proactiveSuspendHint,
    refreshProactiveStatus,
    integrationTime,
    healthMetricLabel,
    healthMetricValue,
    connectHomeAssistant,
    connectXiaomiHealth,
    syncProactiveConnection,
    deleteProactiveConnection,
    updateHomeEntity,
    toggleHomeEntity,
    saveHomeEntityOps,
    proactiveClaimStateLabel,
    updateProactiveClaimState,
    openProactiveAuthorization,
    resetProactiveAuthorization,
    authorizeProactive,
    setProactiveDesiredState,
    setProactivePersistence,
    requestProactiveCapability,
    deleteProactiveSource,
    toggleProactiveCapability,
    proactiveCapabilitySwitchDisabled,
    proactiveCapabilitySwitchTitle,
    exportProactiveData,
  };
}

export type WorkbenchProactiveComposable = ReturnType<typeof useWorkbenchProactive>;
