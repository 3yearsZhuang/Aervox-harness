<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  AlertTriangle,
  Bell,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  Heart,
  LayoutGrid,
  Link2,
  MessageCircle,
  Minus,
  Moon,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  Trash2,
  Volume2,
} from 'lucide-vue-next';
import LLMConfigPanel from '../../llm/LLMConfigPanel.vue';
import PersonaManagerPanel from '../../persona/PersonaManagerPanel.vue';
import VoicePresetManagerPanel from '../../voice/VoicePresetManagerPanel.vue';
import PluginManagerPanel from '../../plugin/PluginManagerPanel.vue';
import ExtensionSlot from '../../extension/ExtensionSlot.vue';
import { useAervoxPlugins } from '@aervox/api-client';
import type { CardDefinition } from '../../../composables/useWorkbenchCards';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import { AervoxNavDialog, AervoxConfirmDialog, AervoxDialog, AervoxButton } from '../../../primitives';

const props = withDefaults(
  defineProps<{
    showCompanion?: boolean;
    focusModeAvailable?: boolean;
    studyModeAvailable?: boolean;
  }>(),
  {
    focusModeAvailable: undefined,
    studyModeAvailable: undefined,
  },
);

const emit = defineEmits<{
  'replay-onboarding': [];
  'open-intro-deck': [];
}>();

const { layout, timer, cards, conversation, proactive, pluginRuntime } = useWorkbenchContext();

const isFocusModeAvailable = computed(() => {
  if (typeof props.focusModeAvailable === 'boolean') {
    return props.focusModeAvailable;
  }
  if (typeof props.studyModeAvailable === 'boolean') {
    return props.studyModeAvailable;
  }
  return pluginRuntime?.isPluginAvailable('focus-mode') ?? pluginRuntime?.isPluginAvailable('study-mode') ?? true;
});
const isStudyModeAvailable = isFocusModeAvailable;

function handleFocusModeChange(checked: boolean) {
  if (isFocusModeAvailable.value === false) return;
  layout.setFocusModeEnabled(checked);
}
const handleStudyModeChange = handleFocusModeChange;

const activeQuickCards = cards.activeQuickCards ?? cards.cardCatalog;
const availableQuickCards = cards.availableQuickCards ?? ref<CardDefinition[]>([]);
const addQuickTool = cards.addQuickTool ?? (() => {});
const removeQuickTool = cards.removeQuickTool ?? (() => {});
const moveQuickTool = cards.moveQuickTool ?? (() => {});
const resetQuickTools = cards.resetQuickTools ?? (() => {});

const isEditingQuickTools = ref(false);

function handleQuickToolClick(card: CardDefinition) {
  settingsOpen.value = false;
  card.action();
}

const {
  isWeb,
  isDark,
  compactMode,
  focusModeEnabled,
  studyModeEnabled,
  enterToSend,
  desktopCompanionEnabled,
  assistantDisplayName,
  settingsOpen,
  settingsCategory,
  settingsScope,
  scopedSettingCategories,
  switchSettingsCategory,
  openTool,
  workbenchMode,
  switchWorkbenchMode,
  setTheme,
  saveSettings,
} = layout;

const { timerMinutes } = timer;
const { toolApprovalMode } = conversation;

const {
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
  toggleProactiveCapability,
  proactiveCapabilitySwitchDisabled,
  proactiveCapabilitySwitchTitle,
  exportProactiveData,
} = proactive;

const pluginApi = useAervoxPlugins();

async function onPluginChange(): Promise<void> {
  if (pluginRuntime) {
    try {
      await pluginApi.loadPlugins();
      await pluginRuntime.sync(pluginApi.plugins.value, (id) => pluginApi.getConfig(id));
    } catch {
      // 忽略非致命同步异常
    }
  }
}
</script>

<template>
  <AervoxNavDialog
    v-model="settingsOpen"
    :title="settingsScope === 'siyu' ? '你的思隅' : '设置'"
    :items="scopedSettingCategories"
    :active-key="settingsCategory"
    nav-aria-label="设置分类"
    custom-class="settings-dialog"
    @update:active-key="switchSettingsCategory($event as any)"
  >
    <template #nav-footer>
      <ExtensionSlot name="settings:tabs" />
    </template>
    <template #content>
      <div v-if="settingsCategory === 'tools'" class="settings-section">
        <div class="settings-section-heading quick-tools-heading">
          <div class="quick-tools-heading-title">
            <span class="heading-icon-wrap"><LayoutGrid :size="18" /></span>
            <span><strong>快捷工具</strong><small>{{ isEditingQuickTools ? '自定义控制中心中的快捷方式' : '打开学习面板与常用小工具' }}</small></span>
          </div>
          <div class="quick-tools-actions">
            <button
              v-if="isEditingQuickTools"
              type="button"
              class="quick-tools-action-btn btn-reset"
              title="恢复默认快捷方式"
              @click="resetQuickTools()"
            >
              <RotateCcw :size="13" />
              <span>恢复默认</span>
            </button>
            <button
              type="button"
              class="quick-tools-action-btn"
              :class="{ 'btn-done': isEditingQuickTools }"
              @click="isEditingQuickTools = !isEditingQuickTools"
            >
              <component :is="isEditingQuickTools ? Check : SlidersHorizontal" :size="13" />
              <span>{{ isEditingQuickTools ? '完成' : '自定义' }}</span>
            </button>
          </div>
        </div>

        <!-- Normal Mode -->
        <div v-if="!isEditingQuickTools" class="quick-tools">
          <button
            v-for="card in activeQuickCards"
            :key="card.id"
            type="button"
            @click="handleQuickToolClick(card)"
          >
            <component :is="card.icon" :size="19" />
            <span><strong>{{ card.label }}</strong><small>{{ card.summary() }}</small></span>
          </button>
          <div v-if="activeQuickCards.length === 0" class="quick-tools-empty">
            <p>暂无启用的快捷工具，点击右上角「自定义」添加快捷方式。</p>
          </div>
        </div>

        <!-- Edit Mode (iOS / Android Control Center Style) -->
        <div v-else class="control-center-edit-container">
          <!-- Group 1: Included Controls -->
          <div class="control-center-group">
            <div class="control-center-group-header">
              <span>已包含的快捷工具</span>
              <small>点击减号移除，或调整展示次序</small>
            </div>
            <div class="control-center-group-list">
              <div
                v-for="(card, idx) in activeQuickCards"
                :key="card.id"
                class="control-center-item is-included"
              >
                <button
                  type="button"
                  class="action-circle-btn btn-minus"
                  :title="`从控制中心移除 ${card.label}`"
                  :aria-label="`移除 ${card.label}`"
                  @click="removeQuickTool(card.id)"
                >
                  <Minus :size="14" />
                </button>
                <div class="control-center-item-icon">
                  <component :is="card.icon" :size="18" />
                </div>
                <div class="control-center-item-info">
                  <strong>{{ card.label }}</strong>
                  <small>{{ card.description }}</small>
                </div>
                <div class="control-center-item-order">
                  <button
                    type="button"
                    class="order-btn"
                    :disabled="idx === 0"
                    :title="`上移 ${card.label}`"
                    :aria-label="`上移 ${card.label}`"
                    @click="moveQuickTool(card.id, 'up')"
                  >
                    <ChevronUp :size="14" />
                  </button>
                  <button
                    type="button"
                    class="order-btn"
                    :disabled="idx === activeQuickCards.length - 1"
                    :title="`下移 ${card.label}`"
                    :aria-label="`下移 ${card.label}`"
                    @click="moveQuickTool(card.id, 'down')"
                  >
                    <ChevronDown :size="14" />
                  </button>
                </div>
              </div>
              <div v-if="activeQuickCards.length === 0" class="control-center-empty-hint">
                暂无快捷工具，请从下方「更多可添加的快捷工具」中添加。
              </div>
            </div>
          </div>

          <!-- Group 2: More Available Controls -->
          <div v-if="availableQuickCards.length > 0" class="control-center-group">
            <div class="control-center-group-header">
              <span>更多可添加的快捷工具</span>
              <small>点击加号添加至控制中心</small>
            </div>
            <div class="control-center-group-list">
              <div
                v-for="card in availableQuickCards"
                :key="card.id"
                class="control-center-item is-available"
              >
                <button
                  type="button"
                  class="action-circle-btn btn-plus"
                  :title="`添加 ${card.label} 至控制中心`"
                  :aria-label="`添加 ${card.label}`"
                  @click="addQuickTool(card.id)"
                >
                  <Plus :size="14" />
                </button>
                <div class="control-center-item-icon">
                  <component :is="card.icon" :size="18" />
                </div>
                <div class="control-center-item-info">
                  <strong>{{ card.label }}</strong>
                  <small>{{ card.description }}</small>
                </div>
                <button
                  type="button"
                  class="btn-add-pill"
                  @click="addQuickTool(card.id)"
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
        <div v-else-if="settingsCategory === 'proactive'" class="settings-section proactive-settings">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><BrainCircuit :size="18" /></span>
            <span><strong>主动智能模式</strong><small>全量画像、持续本地处理与主动操作授权</small></span>
          </div>

          <div class="proactive-status-banner" :class="`is-${proactiveStatus?.effectiveState ?? 'unavailable'}`">
            <component :is="proactiveActive ? BrainCircuit : AlertTriangle" :size="20" />
            <span>
              <strong>{{ proactiveStateLabel(proactiveStatus) }}</strong>
              <small v-if="proactiveStatus?.host">{{ proactiveStatus.host.localOnly ? '数据处理边界：仅本机' : '本地边界未验证' }} · {{ proactiveStatus.host.platform }}</small>
              <small v-else>主动智能模式需要受信的 Electron 本地 Host，Web 端不会伪造授权。</small>
              <small v-if="proactiveSuspendHint(proactiveStatus)" class="proactive-suspend-hint">{{ proactiveSuspendHint(proactiveStatus) }}</small>
            </span>
            <button v-if="!isWeb" type="button" class="proactive-icon-button" aria-label="刷新主动智能状态" title="刷新状态" :disabled="proactiveBusy" @click="refreshProactiveStatus"><RefreshCw :size="15" /></button>
          </div>

          <div v-if="isWeb" class="settings-note proactive-warning"><AlertTriangle :size="16" />请在桌面端完成设备授权；浏览器端不会读取系统级来源。</div>
          <template v-else>
            <p v-if="proactiveError" class="proactive-error" role="alert">{{ proactiveError }}</p>
            <p v-if="proactiveNotice" class="settings-note" role="status">{{ proactiveNotice }}</p>
            <div class="proactive-actions">
              <button
                v-if="!proactiveStatus || proactiveStatus.desiredState === 'none' || proactiveStatus.desiredState === 'revoked'"
                type="button"
                class="proactive-primary-action"
                :disabled="proactiveBusy || toolApprovalMode !== 'full_access'"
                :title="toolApprovalMode !== 'full_access' ? '请先开启完全访问' : '打开全量画像授权向导'"
                @click="openProactiveAuthorization"
              ><BrainCircuit :size="15" />授权并启用</button>
              <button v-else-if="proactiveStatus.desiredState === 'paused'" type="button" :disabled="proactiveBusy || toolApprovalMode !== 'full_access'" @click="setProactiveDesiredState('enabled')"><PlayCircle :size="15" />恢复观察</button>
              <button v-else type="button" :disabled="proactiveBusy" @click="setProactiveDesiredState('paused')"><PauseCircle :size="15" />暂停观察</button>
              <button v-if="proactiveStatus && (proactiveStatus.effectiveState === 'limited' || proactiveStatus.effectiveState === 'suspended') && proactiveStatus.desiredState !== 'none' && proactiveStatus.desiredState !== 'revoked'" type="button" :disabled="proactiveBusy || toolApprovalMode !== 'full_access'" @click="openProactiveAuthorization"><RefreshCw :size="15" />重新确认授权</button>
              <button v-if="proactiveStatus?.desiredState === 'enabled' || proactiveStatus?.desiredState === 'paused'" type="button" class="danger" :disabled="proactiveBusy" @click="setProactiveDesiredState('revoked')"><ShieldAlert :size="15" />撤销授权</button>
              <button v-if="proactiveStatus" type="button" :disabled="proactiveBusy" @click="exportProactiveData(false)"><Download :size="15" />导出画像</button>
              <button v-if="proactiveStatus" type="button" :disabled="proactiveBusy" @click="exportProactiveData(true)"><Database :size="15" />导出含原始副本</button>
            </div>

            <div class="settings-row settings-choice-row proactive-persistence-row">
              <span><strong>开机自启</strong><small>允许 Host 在设备登录后恢复；系统实际状态以权限回执为准</small></span>
              <input v-model="proactiveAutostart" type="checkbox" class="settings-switch" :disabled="proactiveBusy" @change="setProactivePersistence({ autostart: proactiveAutostart })" />
            </div>
            <div class="settings-row settings-choice-row proactive-persistence-row">
              <span><strong>后台持续运行</strong><small>允许应用窗口关闭后保持主动 Host；平台不支持时会显示受限</small></span>
              <input v-model="proactiveBackground" type="checkbox" class="settings-switch" :disabled="proactiveBusy" @change="setProactivePersistence({ background: proactiveBackground })" />
            </div>

            <div class="settings-segmented proactive-view-tabs" role="tablist" aria-label="主动智能视图">
              <button type="button" role="tab" :aria-selected="proactiveView === 'overview'" :class="{ active: proactiveView === 'overview' }" @click="proactiveView = 'overview'"><BrainCircuit :size="15" />能力概览</button>
              <button type="button" role="tab" :aria-selected="proactiveView === 'integrations'" :class="{ active: proactiveView === 'integrations' }" @click="proactiveView = 'integrations'"><Link2 :size="15" />外部连接</button>
            </div>

            <template v-if="proactiveView === 'overview'">
              <div class="proactive-capability-heading"><strong>主动智能能力</strong><small>数字表示当前本地 Vault 中可用于该能力的记录数。</small></div>
              <ul class="proactive-intelligence-grid">
                <li v-for="capability in proactiveIntelligenceCapabilities" :key="capability.id" :class="{ active: capability.count > 0 }">
                  <component :is="capability.icon" :size="17" />
                  <span><strong>{{ capability.label }}</strong><small>{{ capability.count > 0 ? `${capability.count} 条本地记录` : '等待形成数据' }}</small></span>
                  <b>{{ capability.count }}</b>
                </li>
              </ul>

              <div class="proactive-capability-heading"><strong>全量画像来源与动作</strong><small>每项状态来自 OS 或已接入适配器；“待验证”不会被当作已授权。开关仅对可请求或已授权的来源可用；关闭已授权来源会撤销并删除其本地数据。</small></div>
              <ul class="proactive-capability-list">
                <li v-for="capability in proactiveStatus?.capabilities ?? []" :key="capability.id" class="proactive-capability-item">
                  <span class="proactive-capability-marker" :class="capabilityStatusClass(capability.osStatus)" aria-hidden="true"><Check v-if="capability.osStatus === 'granted'" :size="13" /><AlertTriangle v-else :size="13" /></span>
                  <span class="proactive-capability-copy"><strong>{{ capability.label }}</strong><small>{{ capability.description }}<template v-if="capability.reason"> · {{ capability.reason }}</template></small></span>
                  <span class="proactive-capability-state" :class="capabilityStatusClass(capability.osStatus)">{{ capabilityStatusLabel(capability.osStatus) }}</span>
                  <span class="proactive-capability-actions">
                    <input
                      type="checkbox"
                      class="settings-switch proactive-capability-switch"
                      :checked="capability.osStatus === 'granted'"
                      :disabled="proactiveCapabilitySwitchDisabled(capability)"
                      :title="proactiveCapabilitySwitchTitle(capability)"
                      :aria-label="`${capability.label}授权开关`"
                      @change="toggleProactiveCapability(capability, $event)"
                    />
                  </span>
                </li>
                <li v-if="!proactiveStatus" class="study-empty">等待桌面 Host 返回能力快照。</li>
              </ul>
              <div class="proactive-capability-heading"><strong>本地画像记忆</strong><small>推断可由你确认或拒绝；被拒绝的声明不会进入后续个性化上下文。</small></div>
              <ul class="proactive-claim-list">
                <li v-for="claim in proactiveClaims" :key="claim.id" class="proactive-claim-item">
                  <span class="proactive-claim-copy"><strong>{{ claim.content }}</strong><small>{{ claim.claimType }} · 置信度 {{ claim.confidence }} · {{ proactiveClaimStateLabel(claim.state) }}</small></span>
                  <span class="proactive-claim-actions">
                    <button type="button" :class="{ active: claim.state === 'confirmed' }" :disabled="proactiveBusy" title="确认这条画像记忆" aria-label="确认画像记忆" @click="updateProactiveClaimState(claim, 'confirmed')"><Check :size="14" /></button>
                    <button type="button" :class="{ rejected: claim.state === 'rejected' }" :disabled="proactiveBusy" title="拒绝这条画像记忆" aria-label="拒绝画像记忆" @click="updateProactiveClaimState(claim, 'rejected')"><Trash2 :size="14" /></button>
                  </span>
                </li>
                <li v-if="proactiveClaims.length === 0" class="study-empty">尚未形成画像记忆。</li>
              </ul>
              <div class="settings-note proactive-retention-note"><Database :size="16" />原始屏幕、音频、输入、剪贴板和文件副本最多保留 7 天，并在成功提炼为用户记忆后才删除；控制面与画像数据留在本机。</div>
            </template>

            <template v-else>
              <section class="proactive-integration-section">
                <div class="proactive-capability-heading"><strong>Home Assistant</strong><small>局域网状态订阅与实体级服务授权。</small></div>
                <form class="proactive-integration-form" @submit.prevent="connectHomeAssistant">
                  <label><span>名称</span><input v-model="homeAssistantForm.displayName" autocomplete="off" /></label>
                  <label class="wide"><span>实例地址</span><input v-model="homeAssistantForm.endpoint" inputmode="url" autocomplete="url" /></label>
                  <label class="wide"><span>长期访问令牌</span><input v-model="homeAssistantForm.accessToken" type="password" autocomplete="off" /></label>
                  <button type="submit" :disabled="proactiveBusy || !proactiveActive"><Link2 :size="15" />连接</button>
                </form>
                <ul class="proactive-connection-list">
                  <li v-for="connection in homeAssistantConnections" :key="connection.id">
                    <span><strong>{{ connection.displayName }}</strong><small>{{ connection.endpoint }} · {{ integrationTime(connection.lastSyncAt) }}</small></span>
                    <em :class="`is-${connection.state}`">{{ connection.state }}</em>
                    <button type="button" title="立即同步" aria-label="立即同步 Home Assistant" :disabled="proactiveBusy" @click="syncProactiveConnection(connection.provider, connection.id)"><RefreshCw :size="14" /></button>
                    <button type="button" title="撤销连接" aria-label="撤销 Home Assistant 连接" :disabled="proactiveBusy" @click="deleteProactiveConnection(connection.provider, connection.id, connection.displayName)"><Trash2 :size="14" /></button>
                  </li>
                  <li v-if="homeAssistantConnections.length === 0" class="study-empty">尚未连接 Home Assistant。</li>
                </ul>
                <ul v-if="homeAssistantEntities.length > 0" class="proactive-entity-list">
                  <li v-for="entity in homeAssistantEntities" :key="entity.id">
                    <input :checked="entity.enabled" type="checkbox" class="settings-switch" :disabled="proactiveBusy" :aria-label="`授权 ${entity.displayName ?? entity.entityId}`" @change="toggleHomeEntity(entity, $event)" />
                    <span><strong>{{ entity.displayName ?? entity.entityId }}</strong><small>{{ entity.entityId }} · {{ entity.state.state ?? 'unknown' }}</small></span>
                    <input v-model="homeEntityOpsDrafts[entity.id]" class="proactive-ops-input" placeholder="turn_on, turn_off" :disabled="proactiveBusy || !entity.enabled" @change="saveHomeEntityOps(entity)" />
                  </li>
                </ul>
              </section>

              <section class="proactive-integration-section">
                <div class="proactive-capability-heading"><strong>小米运动健康</strong><small>使用用户自有的官方开放平台配置同步步数、睡眠与静息心率。</small></div>
                <form class="proactive-integration-form" @submit.prevent="connectXiaomiHealth">
                  <label><span>名称</span><input v-model="xiaomiHealthForm.displayName" autocomplete="off" /></label>
                  <label class="wide"><span>API 地址</span><input v-model="xiaomiHealthForm.apiBaseUrl" inputmode="url" autocomplete="url" /></label>
                  <label><span>Access Token</span><input v-model="xiaomiHealthForm.accessToken" type="password" autocomplete="off" /></label>
                  <label><span>Refresh Token</span><input v-model="xiaomiHealthForm.refreshToken" type="password" autocomplete="off" /></label>
                  <label class="wide"><span>Token Endpoint</span><input v-model="xiaomiHealthForm.tokenEndpoint" inputmode="url" autocomplete="off" /></label>
                  <label><span>Client ID</span><input v-model="xiaomiHealthForm.clientId" autocomplete="off" /></label>
                  <label><span>Client Secret</span><input v-model="xiaomiHealthForm.clientSecret" type="password" autocomplete="off" /></label>
                  <label class="wide"><span>每日汇总路径</span><input v-model="xiaomiHealthForm.dailyPath" autocomplete="off" /></label>
                  <button type="submit" :disabled="proactiveBusy || !proactiveActive"><Heart :size="15" />连接</button>
                </form>
                <ul class="proactive-connection-list">
                  <li v-for="connection in xiaomiHealthConnections" :key="connection.id">
                    <span><strong>{{ connection.displayName }}</strong><small>{{ integrationTime(connection.lastSyncAt) }}</small></span>
                    <em :class="`is-${connection.state}`">{{ connection.state }}</em>
                    <button type="button" title="同步今日健康数据" aria-label="同步今日健康数据" :disabled="proactiveBusy" @click="syncProactiveConnection(connection.provider, connection.id)"><RefreshCw :size="14" /></button>
                    <button type="button" title="撤销连接" aria-label="撤销小米运动健康连接" :disabled="proactiveBusy" @click="deleteProactiveConnection(connection.provider, connection.id, connection.displayName)"><Trash2 :size="14" /></button>
                  </li>
                  <li v-if="xiaomiHealthConnections.length === 0" class="study-empty">尚未连接小米运动健康。</li>
                </ul>
                <ul v-if="proactiveDashboard?.health.length" class="proactive-health-list">
                  <li v-for="sample in proactiveDashboard.health" :key="sample.id"><span>{{ healthMetricLabel(sample) }}</span><strong>{{ healthMetricValue(sample) }}</strong><small>{{ sample.localDate }}</small></li>
                </ul>
              </section>
            </template>
          </template>
        </div>
        <div v-else-if="settingsCategory === 'appearance'" class="settings-section">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><Sun :size="18" /></span>
            <span><strong>外观</strong><small>让工作台更符合你的节奏与喜好</small></span>
          </div>
          <div class="settings-row settings-choice-row">
            <span><strong>交互模式</strong><small>切换标准工作台（侧栏多会话）或桌宠陪伴（沉浸式交互）</small></span>
            <span class="settings-segmented">
              <button type="button" :class="{ active: workbenchMode === 'companion' }" @click="switchWorkbenchMode('companion')">桌宠陪伴</button>
              <button type="button" :class="{ active: workbenchMode === 'standard' }" @click="switchWorkbenchMode('standard')">标准工作台</button>
            </span>
          </div>
          <div class="settings-row settings-choice-row"><span><strong>主题</strong><small>选择工作台的明暗模式</small></span><span class="settings-segmented"><button type="button" :class="{ active: !isDark }" @click="setTheme('light', timerMinutes)"><Sun :size="16" />亮色</button><button type="button" :class="{ active: isDark }" @click="setTheme('dark', timerMinutes)"><Moon :size="16" />暗色</button></span></div>
          <label class="settings-row settings-choice-row"><span><strong>界面密度</strong><small>紧凑模式会减少面板间距</small></span><input v-model="compactMode" type="checkbox" class="settings-switch" @change="saveSettings(timerMinutes)" /></label>
          <label v-if="!isWeb && showCompanion" class="settings-row settings-choice-row"><span><strong>工作台桌宠</strong><small>控制桌面端主窗口中的桌宠区域</small></span><input v-model="desktopCompanionEnabled" type="checkbox" class="settings-switch" @change="saveSettings(timerMinutes)" /></label>
          <div v-if="!isWeb" class="settings-row settings-choice-row">
            <span><strong>重看新手引导</strong><small>重新播放首次启动的相遇序章，回放期间会暂时离开工作台</small></span>
            <button type="button" class="settings-replay-action" @click="emit('replay-onboarding')"><PlayCircle :size="15" />回放</button>
          </div>
          <div v-if="!isWeb" class="settings-row settings-choice-row">
            <span><strong>完整产品介绍</strong><small>内嵌播放 10 页产品叙事（约 8 分钟），随时可以关闭</small></span>
            <button type="button" class="settings-replay-action" @click="emit('open-intro-deck')"><PlayCircle :size="15" />观看</button>
          </div>
        </div>
        <div v-else-if="settingsCategory === 'conversation'" class="settings-section">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><MessageCircle :size="18" /></span>
            <span><strong>对话</strong><small>调整你与思隅交流的输入与展示方式</small></span>
          </div>
          <label class="settings-field"><span><strong>助手称呼</strong><small>工作台中显示的名字</small></span><input v-model="assistantDisplayName" maxlength="12" @change="saveSettings(timerMinutes)" /></label>
          <label v-if="isFocusModeAvailable" class="settings-row settings-choice-row">
            <span>
              <strong>专注模式</strong>
              <small>启用专属苏格拉底启发式教学与防剧透规则</small>
            </span>
            <input
              :checked="focusModeEnabled"
              type="checkbox"
              class="settings-switch"
              @change="handleFocusModeChange(($event.target as HTMLInputElement).checked)"
            />
          </label>
          <label class="settings-row settings-choice-row"><span><strong>回车发送</strong><small>关闭后，回车只换行</small></span><input v-model="enterToSend" type="checkbox" class="settings-switch" @change="saveSettings(timerMinutes)" /></label>
        </div>
        <LLMConfigPanel v-else-if="settingsCategory === 'model'" class="settings-section" />
        <PersonaManagerPanel v-else-if="settingsCategory === 'persona'" class="settings-section" />
        <div v-else-if="settingsCategory === 'notifications'" class="settings-section">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><Bell :size="18" /></span>
            <span><strong>提醒</strong><small>控制学习过程中的轻量通知与节奏提醒</small></span>
          </div>
          <div class="settings-note"><Check :size="16" />设置会自动保存在当前设备</div>
        </div>
        <div v-else-if="settingsCategory === 'voice'" class="settings-section">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><Volume2 :size="18" /></span>
            <span><strong>语音</strong><small>多预设保存与切换本地或在线语音模型</small></span>
          </div>
          <VoicePresetManagerPanel />
        </div>
        <PluginManagerPanel v-else class="settings-section" @change="onPluginChange" />
    </template>
  </AervoxNavDialog>

  <!-- 完全访问确认弹窗 -->
  <AervoxConfirmDialog
    v-model="conversation.fullAccessDialogOpen.value"
    v-model:acknowledged="conversation.fullAccessAcknowledged.value"
    title="启用完全访问？"
    :icon="ShieldAlert"
    message="完全访问会减少确认步骤，允许思隅在当前会话中直接执行普通写操作。"
    description="管理员级操作、数据撤权、单用户安全隔离与其它安全限制仍然生效。仅在你信任当前任务时开启。"
    require-acknowledge
    acknowledge-text="我已了解风险，并愿意继续"
    confirm-text="启用完全访问"
    cancel-text="取消"
    custom-class="permission-confirm-dialog"
    @confirm="conversation.enableFullAccess"
    @cancel="conversation.fullAccessDialogOpen.value = false"
    @closed="conversation.resetFullAccessConfirmation"
  />

  <!-- 主动智能授权向导弹窗 -->
  <AervoxDialog
    v-model="proactiveDialogOpen"
    title="授权主动智能模式？"
    :icon="BrainCircuit"
    custom-class="permission-confirm-dialog proactive-authorization-dialog"
    width="min(620px, calc(100vw - 28px))"
    @closed="resetProactiveAuthorization"
  >
    <div class="permission-confirmation">
      <span class="permission-confirmation-icon proactive-confirmation-icon"><BrainCircuit :size="24" /></span>
      <div>
        <p>主动智能模式会在本机持续理解你的使用习惯、操作习惯和已授权私人资料，并可执行你单独授权的本地、外部、特权及不可逆动作。</p>
        <small>需要先保持“完全访问”。系统会逐项请求当前平台可以验证的权限；无法探测或未接入的来源会明确显示为“待验证”，不会静默开启。</small>
      </div>
    </div>
    <div class="proactive-authorization-scope">
      <strong>本次授权范围</strong>
      <span>应用与窗口、浏览器、键鼠与剪贴板、屏幕、文件、通信、音视频、位置、传感器、敏感私人资料，以及后台与主动动作权限。</span>
    </div>
    <label class="settings-row settings-choice-row proactive-dialog-choice"><span><strong>开机自启</strong><small>设备登录后恢复 Host（会告知系统设置结果）</small></span><input v-model="proactiveAutostart" type="checkbox" class="settings-switch" /></label>
    <label class="settings-row settings-choice-row proactive-dialog-choice"><span><strong>后台持续运行</strong><small>窗口关闭后继续运行已授权观察与处理</small></span><input v-model="proactiveBackground" type="checkbox" class="settings-switch" /></label>
    <label class="permission-acknowledgement proactive-acknowledgement">
      <input v-model="proactiveAcknowledged" type="checkbox" />
      <span>我已阅读全量画像范围，确认这些来源和动作由我单独授权，并知悉数据仅在本机持久化。</span>
    </label>
    <template #footer>
      <div class="permission-confirmation-actions">
        <AervoxButton variant="secondary" @click="proactiveDialogOpen = false">取消</AervoxButton>
        <AervoxButton
          variant="primary"
          class="proactive-enable"
          :disabled="!proactiveAcknowledged || proactiveBusy || toolApprovalMode !== 'full_access'"
          :loading="proactiveBusy"
          :icon="proactiveBusy ? RefreshCw : BrainCircuit"
          @click="authorizeProactive"
        >
          {{ toolApprovalMode === 'full_access' ? '请求权限并启用' : '请先开启完全访问' }}
        </AervoxButton>
      </div>
    </template>
  </AervoxDialog>
</template>
