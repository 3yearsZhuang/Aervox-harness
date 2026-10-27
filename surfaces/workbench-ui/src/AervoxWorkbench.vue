<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, type Component } from 'vue';
import { useMaterial3 } from '@aervox/ui/material3';
import {
  readCompanionIdentity,
  type Platform,
  PetWithFallback,
  createWorkbenchPluginRuntime,
  type BuiltinUIPlugin,
  WorkbenchHeader,
  WorkbenchSidebar,
  PomodoroToast,
  ProactiveToast,
  WorkbenchNavPill,
  WorkbenchSideCards,
  ConversationConsole,
  StandardConversation,
  ComposerDock,
  ExtensionSlot,
  ToolsDrawer,
  HistoryDrawer,
  TaskCenterDrawer,
  SettingsModal,
  CommandPalette,
  ProjectManagerModal,
  ImportSessionModal,
  AervoxButton,
  useWorkbenchLayout,
  useWorkbenchTimer,
  useWorkbenchComposer,
  createStreamingDeltaBatcher,
  useWorkbenchConversation,
  useWorkbenchCards,
  todayLocalDate,
  type CardId,
  useWorkbenchProactive,
  proactiveBridge,
  provideWorkbenchContext,
  provideUIPluginContext,
  type UIPluginContext,
  createPluginEventBus,
  createPluginStateStore,
  resolveStartupQuiet,
  runStartupDiary,
  createUIRegistry,
  provideUIRegistry,
  type SurfaceNavigation,
  resolveOutgoingMessage,
  MizukiExpression,
  petReact,
  petReactKind,
} from '@aervox/ui/workbench';
import { useUISurfaceContext } from '@aervox/ui-host';
import { PanelLeft } from 'lucide-vue-next';

import { createConversationController, getClientTransport, useAervoxApi, useAervoxPlugins, useAervoxProjects, useAervoxSessions } from '@aervox/api-client';
import type { TurnCallbacks } from '@aervox/api-client';
import type { TurnAttachmentRef } from '@aervox/contracts';

const surfaceContext = useUISurfaceContext();
const desktopProactiveBridge = proactiveBridge();

const material3 = useMaterial3();
const props = withDefaults(
  defineProps<{
    platform?: Platform;
    surfaceNavigation?: SurfaceNavigation;
    showCompanion?: boolean;
    /** ADR-027：陪伴角色名（默认「小隅」）；「思隅」是空间名，不再是角色名 */
    companionName?: string;
    /**
     * CR-060：第一方插件定义清单由**组合根**（Web / 桌面壳）显式注入。
     * 宿主工作台不内建任何具体插件，从而保证"删掉插件后宿主仍可构建运行"。
     */
    plugins?: BuiltinUIPlugin[];
    /**
     * CR-065 切片四：内置设置面板（模型/本地模型/人格/语音/插件管理）由组合根
     * 以受信构建输入显式注入；工作台根注册进 settings:panel:<category> 槽位，
     * 设置弹层按分类经 ExtensionSlot 渲染，宿主不内建任何具体面板。
     */
    settingsPanels?: readonly { category: string; component: Component }[];
    /**
     * 界面变体：'full' 完整双形态；'compact' 紧凑单栏（强制标准模式，无侧栏与模式切换）。
     * 用于多根界面试验田（CR-065 切片六），由组合根按用户选择装配不同界面插件。
     */
    variant?: 'full' | 'compact';
  }>(),
  {
    platform: 'web',
    showCompanion: false,
    companionName: undefined,
    plugins: () => [],
    settingsPanels: () => [],
    variant: 'full',
  },
);

const emit = defineEmits<{
  'replay-onboarding': [];
  'open-intro-deck': [];
}>();

const isCompactVariant = computed(() => props.variant === 'compact');
const showStandardWorkbench = computed(() => isCompactVariant.value || layout.workbenchMode.value === 'standard');

const registry = createUIRegistry();
provideUIRegistry(registry);

// CR-065 切片四：注册组合根注入的内置设置面板（始终可用，不受插件启停门控）
type PanelSlotName = Parameters<typeof registry.registerSlotComponent>[0];
for (const panel of props.settingsPanels) {
  registry.registerSlotComponent(
    `settings:panel:${panel.category}` as PanelSlotName,
    panel.component,
    { id: `settings-panel-${panel.category}` },
  );
}

// CR-060：通用插件事件总线与命名空间化插件状态——宿主只提供容器，不解释语义
const pluginEvents = createPluginEventBus();
const pluginState = createPluginStateStore();

// 1. Proactive Composable
const proactive = useWorkbenchProactive({
  isWeb: computed(() => props.platform !== 'desktop'),
  toolApprovalMode: computed(() => conversation?.toolApprovalMode.value ?? 'ask'),
});

// 2. Layout Composable
const layout = useWorkbenchLayout(props, {
  recordActivity: proactive.recordProactiveActivity,
  getTimerMinutes: () => timer.timerMinutes.value,
  onOpenDiary: () => {
    void cards.openDiary();
  },
});

// 3. Timer Composable
const timer = useWorkbenchTimer({
  onSaveSettings: () => layout.saveSettings(timer.timerMinutes.value),
  onPetReact: (kind) => {
    if (kind === 'nod') petReactKind('nod', { expression: MizukiExpression.face_serious_01 });
    else petReactKind('tilthead', { expression: MizukiExpression.face_smile_01 });
  },
});

// 4. Shared conversation policy and surface presentation
const turnController = createConversationController(getClientTransport(), surfaceContext.signal);
const conversation = useWorkbenchConversation({
  recordActivity: proactive.recordProactiveActivity,
  onRefreshProactiveStatus: proactive.refreshProactiveStatus,
  controller: turnController,
  onApprovalDecision: resumeApprovedTurn,
  onRetrySubmission: retrySubmission,
});

// 5. Session identity is created before the composer so mobile drafts stay
// isolated per conversation across WebView restarts and session switches.
const sessions = useAervoxSessions();

// 6. Composer Composable
const composer = useWorkbenchComposer({
  onSendMessage: (value) => sendMessage(value),
  streaming: conversation.streaming,
  fullAccessDialogOpen: conversation.fullAccessDialogOpen,
  enterToSend: layout.enterToSend,
  draftSessionId: sessions.activeSessionId,
  draftsEnabled: layout.isMobile,
});

// 7. The composition root owns domain stores; cards and plugins receive explicit ports.
const learning = useAervoxApi();
const cards = useWorkbenchCards({
  learning,
  timerRunning: timer.timerRunning,
  formattedTime: timer.formattedTime,
  storyCount: computed(() => conversation.story.value.length),
  onOpenTool: layout.openTool,
  recordActivity: proactive.recordProactiveActivity,
  registry,
});

// 8. Projects Composable (CR-048 / W3)
const projects = useAervoxProjects();

const commandPaletteOpen = ref(false);
const projectManagerOpen = ref(false);
const importSessionOpen = ref(false);

watch(() => sessions.activeSessionId.value, (newId, oldId) => {
  if (newId && oldId && newId !== oldId && !conversation.streaming.value) {
    conversation.resetStory();
  }
});

// 抽屉与弹窗组件懒挂载守卫（首次打开时才挂载对应异步组件实例，消除首屏初始加载开销）
const toolsMounted = ref(false);
const historyMounted = ref(false);
const taskCenterMounted = ref(false);
const settingsMounted = ref(false);
const commandPaletteMounted = ref(false);
const projectManagerMounted = ref(false);
const importSessionMounted = ref(false);

watch(() => layout.toolsOpen.value, (open) => { if (open) toolsMounted.value = true; }, { immediate: true });
watch(() => layout.historyOpen.value, (open) => { if (open) historyMounted.value = true; }, { immediate: true });
watch(() => layout.taskCenterOpen.value, (open) => { if (open) taskCenterMounted.value = true; }, { immediate: true });
// Permission confirmations share this lazy shell and can open before settings.
watch([
  () => layout.settingsOpen.value,
  () => conversation.fullAccessDialogOpen.value,
  () => proactive.proactiveDialogOpen.value,
], (open) => { if (open.some(Boolean)) settingsMounted.value = true; }, { immediate: true });
watch(() => commandPaletteOpen.value, (open) => { if (open) commandPaletteMounted.value = true; }, { immediate: true });
watch(() => projectManagerOpen.value, (open) => { if (open) projectManagerMounted.value = true; }, { immediate: true });
watch(() => importSessionOpen.value, (open) => { if (open) importSessionMounted.value = true; }, { immediate: true });

let isSendingMessage = false;
let lastSubmissionView: {sessionId: string; lineId: number} | undefined;
async function retrySubmission() {
  if (!lastSubmissionView || lastSubmissionView.sessionId !== sessions.activeSessionId.value) return;
  if (conversation.latestAssistantLine.value?.id !== lastSubmissionView.lineId) return;
  await continueTurn(callbacks => turnController.retry(callbacks));
}

// 统一整合发送消息逻辑
async function sendMessage(value = composer.input.value, options?: { metadata?: Record<string, unknown>; resend?: boolean }) {
  if (isSendingMessage) return;
  const text = value.trim();
  if ((!text && composer.pendingAttachments.value.length === 0) || conversation.streaming.value || composer.attachmentUploading.value) return;

  isSendingMessage = true;
  try {
    let attachmentRefs: TurnAttachmentRef[] = [];
    if (composer.pendingAttachments.value.length > 0) {
      composer.attachmentUploading.value = true;
      try {
        attachmentRefs = await composer.uploadPendingAttachments();
      } catch (error) {
        composer.attachmentError.value = error instanceof Error ? `附件上传失败：${error.message}` : '附件上传失败，请重试。';
        petReactKind('sad', { expression: MizukiExpression.face_trouble_01, lookAtEl: '.composer-attachments' });
        return;
      } finally {
        composer.attachmentUploading.value = false;
      }
    }

  const displayText = text || '（发送了附件）';
  const outgoingText = text || '请查看我上传的附件。';

  // CR-060：模式等插件私有语义一律经 metadata 出站，宿主不解释其取值。
  // 插件自述元数据由消息变换管道返回，宿主显式元数据优先（插件不得覆盖宿主语义）；
  // 携带元数据时不再改写消息文本（避免语义双写）。
  const turnMetadataIn = options?.metadata;
  const resolvedOutgoing = resolveOutgoingMessage(registry, outgoingText, turnMetadataIn);
  const outgoing = resolvedOutgoing.text;
  const turnMetadata = resolvedOutgoing.metadata;
  const submittedSessionId = sessions.activeSessionId.value;
  composer.beginDraftSubmission(displayText, submittedSessionId);

  const assistantLine = conversation.createStoryLine('assistant', '', 'streaming');

  if (options?.resend) {
    conversation.story.value.push(assistantLine);
  } else {
    const userLine = conversation.createStoryLine('user', displayText);
    if (attachmentRefs.length > 0) {
      userLine.attachments = composer.pendingAttachments.value.map((item) => ({
        name: item.name,
        mediaType: item.mediaType,
        previewUrl: item.previewUrl,
      }));
      composer.clearPendingAttachments();
    }
    conversation.story.value.push(userLine, assistantLine);
  }

  const liveAssistantLine = conversation.story.value[conversation.story.value.length - 1];
  composer.input.value = '';
  lastSubmissionView = {sessionId: submittedSessionId, lineId: liveAssistantLine.id};
  conversation.streaming.value = true;
  petReactKind('think', { lookAtEl: '.message-panel' });
  await conversation.scrollStoryToBottom();
  proactive.recordProactiveActivity('aervox.activity', 'conversation.turn_submitted', text, {
    hasMetadata: Boolean(turnMetadata),
    toolApprovalMode: conversation.toolApprovalMode.value,
    characterCount: text.length,
  });

  let lastSpeakAt = 0;
  const thinkingPlaceholder = '思考中…';
  let thinkingVisible = false;
  const deltaBatch = createStreamingDeltaBatcher((text) => {
    if (thinkingVisible && !liveAssistantLine.text.replace(thinkingPlaceholder, '')) {
      thinkingVisible = false;
      liveAssistantLine.text = '';
    }
    liveAssistantLine.text += text;
    void conversation.scrollStoryToBottom({ instant: true });
  });

  try {
    const callbacks: TurnCallbacks = {
        onTurnIdentified: (turnId) => {
          liveAssistantLine.turnId = turnId;
        },
        onError: (error) => {
          throw error instanceof Error ? error : new Error(String(error));
        },
        onReasoning: () => {
          deltaBatch.flush();
          if (!liveAssistantLine.text) {
            thinkingVisible = true;
            liveAssistantLine.text = thinkingPlaceholder;
            void conversation.scrollStoryToBottom();
          }
        },
        onDelta: (delta) => {
          deltaBatch.append(delta);
          const now = Date.now();
          if (now - lastSpeakAt > 1200 && delta.trim()) {
            lastSpeakAt = now;
            petReact({ speak: delta });
          }
        },
        onDone: () => {
          deltaBatch.flush();
          composer.completeDraftSubmission(submittedSessionId);
          liveAssistantLine.state = 'complete';
          if (thinkingVisible && !liveAssistantLine.text.replace(thinkingPlaceholder, '')) {
            thinkingVisible = false;
            liveAssistantLine.text = '';
          }
          if (!liveAssistantLine.text && !conversation.pendingApproval.value && !conversation.activeQuestion.value) liveAssistantLine.text = '这次没有收到可展示的回答，请再试一次。';
          void conversation.scrollStoryToBottom();
          petReactKind('glad', { expression: MizukiExpression.face_smile_01, speak: liveAssistantLine.text });
        },
        onUserQuestion: () => {
          deltaBatch.flush();
          petReactKind('tilthead', { lookAtEl: '.side-cards', lookDuration: 3200 });
          void conversation.scrollStoryToBottom();
        },
        // CR-060：宿主只把通用插件事件转发到总线，不解释事件类型与载荷
        onPluginEvent: (eventType, data) => {
          deltaBatch.flush();
          pluginEvents.emit(eventType, data);
        },
        onToolApproval: () => {
          deltaBatch.flush();
          void conversation.scrollStoryToBottom();
        },
      };
    await turnController.submit(submittedSessionId, outgoing, callbacks, {
        signal: surfaceContext.signal,
        onAccepted: turnId => {
          liveAssistantLine.turnId = turnId;
          if (composer.input.value.trim() === displayText) composer.input.value = '';
        },
        toolApprovalMode: conversation.toolApprovalMode.value,
        attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
        // ADR-027：宿主显式元数据（角色名/用户称呼）优先级最高，插件变换不得覆盖
        metadata: { ...turnMetadata, ...readCompanionIdentity() },
      });
  } catch (error) {
    if (surfaceContext.signal.aborted) return;
    console.error('对话流式失败', error);
    deltaBatch.flush();
    liveAssistantLine.state = 'error';
    if (thinkingVisible && liveAssistantLine.text === thinkingPlaceholder) liveAssistantLine.text = '';
    if (turnController.state.turnId) {
      composer.completeDraftSubmission(submittedSessionId);
    } else {
      liveAssistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。';
      composer.restoreFailedDraft();
    }
    petReactKind('sad', { expression: MizukiExpression.face_sad_01 });
  } finally {
    deltaBatch.flush();
    conversation.streaming.value = false;
    if (!composer.input.value.trim()) composer.composerOpen.value = false;
    await conversation.scrollStoryToBottom();
  }
  } finally {
    isSendingMessage = false;
  }
}

// Recovery and approval append to the same reply; the controller owns the cursor and reservation.
async function resumeApprovedTurn(decision: 'granted' | 'denied') {
  await continueTurn(callbacks => turnController.decide(decision, callbacks));
}
async function continueTurn(run: (callbacks: TurnCallbacks) => Promise<void>) {
  const line = conversation.latestAssistantLine.value;
  if (!line || conversation.streaming.value) return;
  if (!turnController.state.turnId && turnController.state.retryAvailable) line.text = '';
  conversation.streaming.value = true;
  line.state = 'streaming';
  const batch = createStreamingDeltaBatcher(text => {
    line.text += text;
    void conversation.scrollStoryToBottom({ instant: true });
  });
  try {
    await run({
      onTurnIdentified: turnId => { line.turnId = turnId; },
      onDelta: text => batch.append(text),
      onDone: () => {
        batch.flush(); line.state = 'complete';
        if (lastSubmissionView) composer.completeDraftSubmission(lastSubmissionView.sessionId);
      },
      onError: error => { throw error; },
      onUserQuestion: () => { batch.flush(); },
      onToolApproval: () => { batch.flush(); },
      onPluginEvent: (type, data) => { batch.flush(); pluginEvents.emit(type, data); },
    });
  } catch (error) {
    if (!surfaceContext.signal.aborted) {
      batch.flush();
      line.state = 'error';
    }
  } finally {
    batch.flush();
    if (line.state === 'streaming' && turnController.state.status === 'completed') line.state = 'complete';
    conversation.streaming.value = false;
    await conversation.scrollStoryToBottom();
  }
}

// 插件运行时管理
let pluginRuntime: ReturnType<typeof createWorkbenchPluginRuntime> | undefined;

// 提供全局上下文供所有子组件和插件使用
const workbenchContext = {
  surfaceNavigation: props.surfaceNavigation,
  layout,
  timer,
  composer,
  conversation,
  cards,
  proactive,
  registry,
  sessions,
  projects,
  openProjectManager: () => {
    projectManagerOpen.value = true;
  },
  openImportSession: () => {
    importSessionOpen.value = true;
  },
  openCommandPalette: () => {
    commandPaletteOpen.value = true;
  },
  get pluginRuntime() {
    return pluginRuntime;
  },
  pluginEvents,
  pluginState,
  sendMessage,
};
provideWorkbenchContext(workbenchContext);

const pluginApi = useAervoxPlugins();
const pluginContext: UIPluginContext = Object.freeze({
  navigation: Object.freeze({openTool: layout.openTool, runMenuAction: layout.runMenuAction,
    closeTaskCenter: () => { layout.taskCenterOpen.value = false; }, setQuietStartup: layout.setQuietStartup}),
  cards: Object.freeze({acquireSlotPreset: cards.acquireSlotPreset, reviewCount: cards.syncReviewCount}),
  conversation: Object.freeze({streaming: computed(() => conversation.streaming.value), latestAssistantText: computed(() => conversation.latestAssistantLine.value?.text ?? '')}),
  learning, pluginEvents, pluginState, sendMessage,
  async refreshPluginUI() {
    await pluginApi.loadPlugins();
    if (pluginApi.error.value) throw new Error(pluginApi.error.value);
    await pluginRuntime?.sync(pluginApi.plugins.value, (id) => pluginApi.getConfig(id));
  },
  isPluginAvailable: (id: string) => pluginRuntime?.isPluginAvailable(id) ?? false,
});
provideUIPluginContext(pluginContext);
pluginRuntime = createWorkbenchPluginRuntime(registry, () => pluginContext, props.plugins);

// 组件替换支持（允许插件通过 uiRegistry.overrideComponent('ComposerDock', CustomComp) 替换输入底座）
const resolvedComposerComponent = computed(() => {
  return registry.getComponent('ComposerDock', ComposerDock);
});

function handleComposerInputUpdate(val: string) {
  composer.input.value = val;
}

let removeProactiveStatusListener: (() => void) | undefined;
let materialThemeObserver: MutationObserver | undefined;

onMounted(() => {
  window.addEventListener('aervox:open-settings', layout.openSettings);

  try {
    const savedSettings = JSON.parse(localStorage.getItem('aervox-settings') ?? '{}') as Partial<{
      theme: 'light' | 'dark';
      enterToSend: boolean;
      compactMode: boolean;
      timerMinutes: number;
      desktopCompanionEnabled: boolean;
      dailyReminder: boolean;
    }>;
    // ADR-027：角色名与称呼由 readCompanionIdentity 统一读取（含旧字段迁移），此处不再恢复
    if (typeof savedSettings.enterToSend === 'boolean') layout.enterToSend.value = savedSettings.enterToSend;
    if (typeof savedSettings.compactMode === 'boolean') layout.compactMode.value = savedSettings.compactMode;
    if (typeof savedSettings.timerMinutes === 'number' && savedSettings.timerMinutes >= 1 && savedSettings.timerMinutes <= 60) {
      timer.timerMinutes.value = savedSettings.timerMinutes;
    }
    if (typeof savedSettings.desktopCompanionEnabled === 'boolean') layout.desktopCompanionEnabled.value = savedSettings.desktopCompanionEnabled;
    if (typeof savedSettings.dailyReminder === 'boolean') layout.dailyReminder.value = savedSettings.dailyReminder;
    timer.timerSeconds.value = timer.timerMinutes.value * 60;
  } catch {
    // Ignore malformed local preferences
  }

  const savedToolApprovalMode = localStorage.getItem('aervox-tool-approval-mode');
  if (savedToolApprovalMode === 'full_access') conversation.toolApprovalMode.value = 'full_access';

  try {
    const savedCards = JSON.parse(localStorage.getItem('aervox-side-cards') ?? 'null') as unknown;
    if (Array.isArray(savedCards)) {
      cards.cardSlots.value = [0, 1].map((index) => {
        const id = savedCards[index];
        return cards.cardCatalog.value.some((card) => card.id === id) ? (id as CardId) : null;
      });
    }
  } catch {
    // Ignore malformed card preferences
  }

  // CR-060：插件同步必须先于「启动期诉求」判定——插件在自身 setup() 阶段经通用接缝
  // （quietStartup）表达诉求，宿主不判断具体插件状态。顺序由 workbench-startup 保证并被单测覆盖。
  const pluginStartupReady = (async () => {
    try {
      await pluginContext.refreshPluginUI();
    } catch {
      // Ignore plugin sync failures in offline/mock environments
    }
  })();

  void (async () => {
    const quietStartup = await resolveStartupQuiet(pluginStartupReady, () => layout.quietStartup.value);
    if (surfaceContext.signal.aborted) return;
    await runStartupDiary({
      quietStartup,
      markerKey: `aervox-diary-first-open-${todayLocalDate()}`,
      storage: localStorage,
      generateToday: () => cards.diaryApi.generateToday(),
      applyGenerated: (result) => {
        if (surfaceContext.signal.aborted) return;
        cards.todayDiary.value = result;
        cards.setDiarySlotRestore(cards.cardSlots.value[0]);
        cards.cardSlots.value[0] = 'diary';
      },
    });
  })();

  if (layout.isWeb.value) {
    const saved = localStorage.getItem('aervox-theme');
    const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const initial = saved === 'dark' || saved === 'light' ? saved : fallback;
    if (material3) {
      // Initializing the palette must not turn a system preference into a saved
      // user choice. Keep settings indicators in sync with the mobile host.
      document.documentElement.dataset.theme = initial;
      layout.isDark.value = initial === 'dark';
      materialThemeObserver = new MutationObserver(() => {
        layout.isDark.value = document.documentElement.dataset.theme === 'dark';
      });
      materialThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } else layout.applyTheme(initial);
  } else {
    const saved = document.documentElement.dataset.theme;
    layout.isDark.value = saved === 'dark';
  }

  if (!layout.isWeb.value) {
    const bridge = desktopProactiveBridge;
    removeProactiveStatusListener = bridge?.onStatusChange((status) => {
      proactive.proactiveStatus.value = status;
      proactive.proactiveAutostart.value = status.persistence.autostart;
      proactive.proactiveBackground.value = status.persistence.background;
    });
    void proactive.refreshProactiveStatus();
  }

  void sessions.fetchSessions();
  void projects.fetchProjects();
  void conversation.scrollStoryToBottom();

  document.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('click', layout.handleMenuDocumentClick);
  document.addEventListener('keydown', layout.handleHistoryEscape);
});

function handleGlobalKeydown(e: KeyboardEvent) {
  const isCmdOrCtrl = e.metaKey || e.ctrlKey;
  if (isCmdOrCtrl && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    void sessions.createNewSession('新对话').catch(() => undefined);
  } else if (isCmdOrCtrl && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    commandPaletteOpen.value = !commandPaletteOpen.value;
  } else if (isCmdOrCtrl && e.key === '/') {
    e.preventDefault();
    layout.toggleStandardSidebar();
  }
}

onUnmounted(() => {
  turnController.dispose();
  pluginRuntime?.destroy();
  pluginState.dispose();
  registry.clear();
  document.removeEventListener('click', layout.handleMenuDocumentClick);
  document.removeEventListener('keydown', layout.handleHistoryEscape);
  document.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('aervox:open-settings', layout.openSettings);
  removeProactiveStatusListener?.();
  materialThemeObserver?.disconnect();
  composer.clearPendingAttachments();
});
</script>

<template>
  <section
    class="aervox-workbench"
    :class="[
      `is-${platform}`,
      `mode-${layout.workbenchMode.value}`,
      {
        'has-companion': layout.showCompanionEnabled.value,
        'is-compact': layout.compactMode.value,
        'is-variant-compact': isCompactVariant,
        'sidebar-collapsed': layout.standardSidebarCollapsed.value,
      }
    ]"
    :data-aervox-platform="platform"
    :data-workbench-mode="layout.workbenchMode.value"
  >
    <!-- 标准工作台模式 (CR-035 / W1) -->
    <template v-if="showStandardWorkbench">
      <div
        v-if="!isCompactVariant && layout.narrowSidebar.value && !layout.standardSidebarCollapsed.value"
        class="sidebar-backdrop"
        aria-hidden="true"
        @click="layout.toggleStandardSidebar()"
      />
      <WorkbenchSidebar v-if="!isCompactVariant" />

      <main class="workbench-standard-main" :inert="layout.narrowSidebar.value && !layout.standardSidebarCollapsed.value">
        <header class="standard-topbar">
          <div class="topbar-left">
            <AervoxButton variant="ghost" icon-only
              v-if="!isCompactVariant && layout.standardSidebarCollapsed.value"
              type="button"
              class="topbar-icon-btn"
              title="展开侧边栏 (⌘/)"
              aria-label="展开侧边栏"
              aria-controls="workbench-sidebar"
              :aria-expanded="!layout.standardSidebarCollapsed.value"
              @click="layout.toggleStandardSidebar()"
            >
              <PanelLeft :size="18" />
            </AervoxButton>
            <h2 class="session-active-title">{{ sessions.activeSession.value?.title || '新对话' }}</h2>
          </div>

          <div class="topbar-right">
            <WorkbenchHeader />
          </div>
        </header>

        <div class="standard-chat-container">
          <StandardConversation />
          <div class="standard-composer-wrap">
            <component
              :is="resolvedComposerComponent"
              :input="composer.input.value"
              :streaming="conversation.streaming.value"
              :is-composing="composer.isComposing.value"
              :enter-to-send="layout.enterToSend.value"
              :placeholder="composer.composerPlaceholder"
              :on-send="sendMessage"
              :on-voice-trigger="composer.toggleVoiceInput"
              :on-attachment-picker="composer.triggerAttachmentPicker"
              @update:input="handleComposerInputUpdate"
              @send="sendMessage"
              @voice-trigger="composer.toggleVoiceInput"
              @attachment-picker="composer.triggerAttachmentPicker"
            />
          </div>
        </div>
      </main>
    </template>

    <!-- 桌宠陪伴模式 (经典沉浸式双形态) -->
    <template v-else>
      <div class="companion-stage">
        <div v-if="layout.showCompanionEnabled.value" class="immersive-pet" aria-label="桌宠区域">
          <PetWithFallback />
        </div>
        <WorkbenchSideCards />
      </div>

      <WorkbenchHeader />
      <PomodoroToast />
      <ProactiveToast />
      <WorkbenchNavPill />

      <div class="immersive-console">
        <ConversationConsole />
        <component
          :is="resolvedComposerComponent"
          :input="composer.input.value"
          :streaming="conversation.streaming.value"
          :is-composing="composer.isComposing.value"
          :enter-to-send="layout.enterToSend.value"
          :placeholder="composer.composerPlaceholder"
          :on-send="sendMessage"
          :on-voice-trigger="composer.toggleVoiceInput"
          :on-attachment-picker="composer.triggerAttachmentPicker"
          @update:input="handleComposerInputUpdate"
          @send="sendMessage"
          @voice-trigger="composer.toggleVoiceInput"
          @attachment-picker="composer.triggerAttachmentPicker"
        />
      </div>
    </template>

    <ToolsDrawer v-if="toolsMounted" />
    <ExtensionSlot name="workbench:drawers" />
    <HistoryDrawer v-if="historyMounted" />
    <TaskCenterDrawer v-if="taskCenterMounted" />
    <SettingsModal
      v-if="settingsMounted"
      :show-companion="showCompanion"
      @replay-onboarding="emit('replay-onboarding')"
      @open-intro-deck="emit('open-intro-deck')"
    />
    <CommandPalette
      v-if="commandPaletteMounted"
      v-model:open="commandPaletteOpen"
    />
    <ProjectManagerModal
      v-if="projectManagerMounted"
      v-model:open="projectManagerOpen"
    />
    <ImportSessionModal
      v-if="importSessionMounted"
      v-model:open="importSessionOpen"
    />
  </section>
</template>
