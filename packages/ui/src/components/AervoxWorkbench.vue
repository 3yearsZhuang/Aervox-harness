<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Platform } from '../composables/useWorkbenchLayout';
import PetHero from './PetHero.vue';
import { createWorkbenchPluginRuntime } from '../plugins';
import WorkbenchHeader from './workbench/WorkbenchHeader.vue';
import PomodoroToast from './workbench/PomodoroToast.vue';
import WorkbenchNavPill from './workbench/WorkbenchNavPill.vue';
import WorkbenchSideCards from './workbench/WorkbenchSideCards.vue';
import ConversationConsole from './workbench/ConversationConsole.vue';
import ComposerDock from './workbench/ComposerDock.vue';

const Live2DPet = defineAsyncComponent(() => import('./Live2DPet.vue'));
const ToolsDrawer = defineAsyncComponent(() => import('./workbench/drawers/ToolsDrawer.vue'));
const LearningDrawer = defineAsyncComponent(() => import('./workbench/drawers/LearningDrawer.vue'));
const HistoryDrawer = defineAsyncComponent(() => import('./workbench/drawers/HistoryDrawer.vue'));
const SettingsModal = defineAsyncComponent(() => import('./workbench/drawers/SettingsModal.vue'));

import { useWorkbenchLayout } from '../composables/useWorkbenchLayout';
import { useWorkbenchTimer } from '../composables/useWorkbenchTimer';
import { useWorkbenchComposer } from '../composables/useWorkbenchComposer';
import { useWorkbenchConversation } from '../composables/useWorkbenchConversation';
import { useWorkbenchCards, todayLocalDate, type CardId } from '../composables/useWorkbenchCards';
import { useWorkbenchProactive, proactiveBridge } from '../composables/useWorkbenchProactive';
import { provideWorkbenchContext } from '../composables/workbench-context';
import { useUIRegistry, provideUIRegistry } from '../registry/ui-registry';
import { streamAervoxTurn, useAervoxPlugins } from '@aervox/api-client';
import type { TurnAttachmentRef } from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { petReact, petReactKind } from '../live2d/petReactions';

const props = withDefaults(
  defineProps<{
    platform?: Platform;
    showCompanion?: boolean;
    assistantName?: string;
  }>(),
  {
    platform: 'web',
    showCompanion: false,
    assistantName: '思隅',
  },
);

const emit = defineEmits<{
  'replay-onboarding': [];
  'open-intro-deck': [];
}>();

const registry = useUIRegistry();
provideUIRegistry(registry);


// 1. Proactive Composable
const proactive = useWorkbenchProactive({
  isWeb: computed(() => props.platform === 'web'),
  toolApprovalMode: computed(() => conversation?.toolApprovalMode.value ?? 'ask'),
});

// 2. Layout Composable
const layout = useWorkbenchLayout(props, {
  recordActivity: proactive.recordProactiveActivity,
  getTimerMinutes: () => timer.timerMinutes.value,
  onStudyModeChange: (enabled) => {
    if (enabled) {
      cards.applyStudyCardLayout();
    } else {
      cards.restoreStudyCardLayout();
      conversation.currentExtractedTerms.value = [];
      conversation.exploreDialogOpen.value = false;
    }
  },
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

// 4. Conversation Composable
const conversation = useWorkbenchConversation({
  focusModeEnabled: layout.focusModeEnabled,
  studyModeEnabled: layout.studyModeEnabled,
  recordActivity: proactive.recordProactiveActivity,
  onRefreshProactiveStatus: proactive.refreshProactiveStatus,
});

// 5. Composer Composable
const composer = useWorkbenchComposer({
  onSendMessage: (value) => sendMessage(value),
  streaming: conversation.streaming,
  fullAccessDialogOpen: conversation.fullAccessDialogOpen,
  enterToSend: layout.enterToSend,
});

// 6. Cards Composable
const cards = useWorkbenchCards({
  activeQuestion: conversation.activeQuestion,
  timerRunning: timer.timerRunning,
  formattedTime: timer.formattedTime,
  storyCount: computed(() => conversation.story.value.length),
  onOpenTool: layout.openTool,
  onStartQuiz: () => {
    if (conversation.streaming.value) return;
    void sendMessage(composer.input.value.trim() || '来几道题', { quizMode: true });
  },
  onSubmitQuestionAnswers: conversation.handleQuestionSubmit,
  recordActivity: proactive.recordProactiveActivity,
});

// 抽屉与弹窗组件懒挂载守卫（首次打开时才挂载对应异步组件实例，消除首屏初始加载开销）
const toolsMounted = ref(false);
const learningMounted = ref(false);
const historyMounted = ref(false);
const settingsMounted = ref(false);

watch(() => layout.toolsOpen.value, (open) => { if (open) toolsMounted.value = true; }, { immediate: true });
watch(() => layout.learningOpen.value, (open) => { if (open) learningMounted.value = true; }, { immediate: true });
watch(() => layout.historyOpen.value, (open) => { if (open) historyMounted.value = true; }, { immediate: true });
watch(() => layout.settingsOpen.value, (open) => { if (open) settingsMounted.value = true; }, { immediate: true });

let isSendingMessage = false;

// 统一整合发送消息逻辑
async function sendMessage(value = composer.input.value, options?: { quizMode?: boolean; resend?: boolean }) {
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

  const activeMode = options?.quizMode ? 'quiz' : (layout.focusModeEnabled.value ? 'focus' : undefined);
  const outgoing = registry.transformMessage(outgoingText, {
    quizMode: Boolean(options?.quizMode),
    useMetadata: Boolean(activeMode),
  });


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
  conversation.streaming.value = true;
  conversation.activeQuestion.value = null;
  conversation.currentExtractedTerms.value = [];
  petReactKind('think', { lookAtEl: '.message-panel' });
  await conversation.scrollStoryToBottom();
  proactive.recordProactiveActivity('aervox.activity', 'conversation.turn_submitted', text, {
    focusModeEnabled: layout.focusModeEnabled.value,
    studyModeEnabled: layout.studyModeEnabled.value,
    toolApprovalMode: conversation.toolApprovalMode.value,
    characterCount: text.length,
  });

  let lastSpeakAt = 0;
  const thinkingPlaceholder = '思考中…';
  let thinkingVisible = false;

  try {
    const turnMetadata = options?.quizMode
      ? { mode: 'focus', intent: 'quiz' }
      : (layout.focusModeEnabled.value ? { mode: 'focus' } : undefined);

    await streamAervoxTurn(
      outgoing,
      {
        onReasoning: () => {
          if (!liveAssistantLine.text) {
            thinkingVisible = true;
            liveAssistantLine.text = thinkingPlaceholder;
            void conversation.scrollStoryToBottom();
          }
        },
        onDelta: (delta) => {
          if (thinkingVisible && !liveAssistantLine.text.replace(thinkingPlaceholder, '')) {
            thinkingVisible = false;
            liveAssistantLine.text = '';
          }
          liveAssistantLine.text += delta;
          void conversation.scrollStoryToBottom();
          const now = Date.now();
          if (now - lastSpeakAt > 1200 && delta.trim()) {
            lastSpeakAt = now;
            petReact({ speak: delta });
          }
        },
        onDone: () => {
          liveAssistantLine.state = 'complete';
          conversation.activeQuestion.value = null;
          if (thinkingVisible && !liveAssistantLine.text.replace(thinkingPlaceholder, '')) {
            thinkingVisible = false;
            liveAssistantLine.text = '';
          }
          if (!liveAssistantLine.text) liveAssistantLine.text = '这次没有收到可展示的回答，请再试一次。';
          petReactKind('glad', { expression: MizukiExpression.face_smile_01, speak: liveAssistantLine.text });
        },
        onUserQuestion: (qData) => {
          conversation.activeQuestion.value = qData;
          conversation.currentTurnId.value = qData.turnId;
          petReactKind('tilthead', { lookAtEl: '.side-cards', lookDuration: 3200 });
          void conversation.scrollStoryToBottom();
        },
        onTermsExtracted: (tData) => {
          conversation.currentExtractedTerms.value = tData.terms;
        },
        onToolApproval: (aData) => {
          conversation.pendingApproval.value = { ...aData, outgoing };
          void conversation.scrollStoryToBottom();
        },
      },
      {
        toolApprovalMode: conversation.toolApprovalMode.value,
        attachments: attachmentRefs.length > 0 ? attachmentRefs : undefined,
        metadata: turnMetadata,
      },
    );
  } catch (error) {
    console.error('对话流式失败', error);
    liveAssistantLine.state = 'error';
    liveAssistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。';
    petReactKind('sad', { expression: MizukiExpression.face_sad_01 });
  } finally {
    conversation.streaming.value = false;
    if (!composer.input.value.trim()) composer.composerOpen.value = false;
    await conversation.scrollStoryToBottom();
  }
  } finally {
    isSendingMessage = false;
  }
}

// 插件运行时管理
let pluginRuntime: ReturnType<typeof createWorkbenchPluginRuntime> | undefined;

// 提供全局上下文供所有子组件和插件使用
const workbenchContext = {
  layout,
  timer,
  composer,
  conversation,
  cards,
  proactive,
  registry,
  get pluginRuntime() {
    return pluginRuntime;
  },
  sendMessage,
};
provideWorkbenchContext(workbenchContext);

pluginRuntime = createWorkbenchPluginRuntime(registry, () => workbenchContext);


// 组件替换支持（允许插件通过 uiRegistry.overrideComponent('ComposerDock', CustomComp) 替换输入底座）
const resolvedComposerComponent = computed(() => {
  return registry.getComponent('ComposerDock', ComposerDock);
});

function handleComposerInputUpdate(val: string) {
  composer.input.value = val;
}


let removeProactiveStatusListener: (() => void) | undefined;

onMounted(() => {
  window.addEventListener('aervox:open-settings', layout.openSettings);

  try {
    const savedSettings = JSON.parse(localStorage.getItem('aervox-settings') ?? '{}') as Partial<{
      theme: 'light' | 'dark';
      assistantName: string;
      enterToSend: boolean;
      compactMode: boolean;
      focusModeEnabled: boolean;
      studyModeEnabled: boolean;
      timerMinutes: number;
      desktopCompanionEnabled: boolean;
      dailyReminder: boolean;
    }>;
    if (savedSettings.assistantName) layout.assistantDisplayName.value = savedSettings.assistantName;
    if (typeof savedSettings.enterToSend === 'boolean') layout.enterToSend.value = savedSettings.enterToSend;
    if (typeof savedSettings.compactMode === 'boolean') layout.compactMode.value = savedSettings.compactMode;
    if (typeof savedSettings.focusModeEnabled === 'boolean') {
      layout.focusModeEnabled.value = savedSettings.focusModeEnabled;
    } else if (typeof savedSettings.studyModeEnabled === 'boolean') {
      layout.focusModeEnabled.value = savedSettings.studyModeEnabled;
    }
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

  if (layout.focusModeEnabled.value) cards.applyStudyCardLayout();

  void (async () => {
    if (layout.focusModeEnabled.value) return;
    const marker = `aervox-diary-first-open-${todayLocalDate()}`;
    if (localStorage.getItem(marker)) return;
    try {
      const result = await cards.diaryApi.generateToday();
      if (result?.content) {
        cards.todayDiary.value = result;
        cards.setDiarySlotRestore(cards.cardSlots.value[0]);
        cards.cardSlots.value[0] = 'diary';
      }
      localStorage.setItem(marker, '1');
    } catch {
      // 失败不写标记
    }
  })();

  if (layout.isWeb.value) {
    const saved = localStorage.getItem('aervox-theme');
    const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    layout.applyTheme(saved === 'dark' || saved === 'light' ? saved : fallback);
  } else {
    const saved = document.documentElement.dataset.theme;
    layout.isDark.value = saved === 'dark';
  }

  if (!layout.isWeb.value) {
    const bridge = proactiveBridge();
    removeProactiveStatusListener = bridge?.onStatusChange((status) => {
      proactive.proactiveStatus.value = status;
      proactive.proactiveAutostart.value = status.persistence.autostart;
      proactive.proactiveBackground.value = status.persistence.background;
    });
    void proactive.refreshProactiveStatus();
  }

  void (async () => {
    try {
      const pluginApi = useAervoxPlugins();
      await pluginApi.loadPlugins();
      await pluginRuntime?.sync(pluginApi.plugins.value, (id) => pluginApi.getConfig(id));
    } catch {
      // Ignore plugin sync failures in offline/mock environments
    }
  })();

  void conversation.scrollStoryToBottom();

  document.addEventListener('click', layout.handleMenuDocumentClick);
  document.addEventListener('keydown', layout.handleHistoryEscape);
});

onUnmounted(() => {
  pluginRuntime?.destroy();
  document.removeEventListener('click', layout.handleMenuDocumentClick);

  document.removeEventListener('keydown', layout.handleHistoryEscape);
  window.removeEventListener('aervox:open-settings', layout.openSettings);
  removeProactiveStatusListener?.();
  composer.clearPendingAttachments();
});
</script>

<template>
  <section
    class="aervox-workbench"
    :class="[`is-${platform}`, { 'has-companion': layout.showCompanionEnabled.value, 'is-compact': layout.compactMode.value }]"
    :data-aervox-platform="platform"
  >
    <div v-if="layout.showCompanionEnabled.value" class="immersive-pet" aria-label="桌宠区域">
      <Live2DPet>
        <template #fallback><PetHero /></template>
      </Live2DPet>
    </div>

    <WorkbenchHeader />
    <PomodoroToast />
    <WorkbenchNavPill />
    <WorkbenchSideCards />

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

    <ToolsDrawer v-if="toolsMounted" />
    <LearningDrawer v-if="learningMounted" />
    <HistoryDrawer v-if="historyMounted" />
    <SettingsModal
      v-if="settingsMounted"
      :show-companion="showCompanion"
      @replay-onboarding="emit('replay-onboarding')"
      @open-intro-deck="emit('open-intro-deck')"
    />

  </section>
</template>
