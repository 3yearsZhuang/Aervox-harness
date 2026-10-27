<script setup lang="ts">
/**
 * 思隅·主动陪伴（方向 D 落地）——主界面替代根组件。
 *
 * 设计原则（用户确认的设计方向）：
 * - 一级页面元素极精简：品牌、两个静音按钮、桌宠、对话盒、两张建议卡；
 * - 两张建议卡是主要入口，由主动智能依据学习记录给出，并附「为什么推荐」理由行；
 * - 输入框淡化为一枚药丸，展开时建议卡让位（mode-whisper），发送后收回；
 * - 对话盒为思隅唯一声音出口：问候、流式回复、动作确认都经打字机呈现。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { useUISurfaceContext } from '@aervox/ui-host';
import { useMaterial3, useMobileBackNavigation } from '@aervox/ui/material3';
import { AervoxBrandMark, PetWithFallback, UserQuestionComposer, readCompanionIdentity, useSessionDraft } from '@aervox/ui/companion';
import { createConversationController, getClientTransport, useAervoxSessions } from '@aervox/api-client';
import { ArrowUpRight, History, MessagesSquare, MessageSquare, RotateCcw, Settings, Square, X } from 'lucide-vue-next';
import type { AskUserQuestionAnswerItem } from '@aervox/contracts';
import { useDialogueTyper } from './dialogue-typer';
import MobileSettingsDialog from './MobileSettingsDialog.vue';
import MobileSessionsDialog from './MobileSessionsDialog.vue';
import MobileHistoryDialog from './MobileHistoryDialog.vue';
import '@aervox/ui/theme/companion';
import type { SurfaceNavigation } from '@aervox/ui/companion';

const props = withDefaults(defineProps<{
  surfaceNavigation?: SurfaceNavigation;
  settingsPanels?: readonly { category: string; component: Component }[];
}>(), { settingsPanels: () => [] });
const settingsOpen = ref(false);

const surface = useUISurfaceContext();
const material3 = useMaterial3();
const mobileBack = useMobileBackNavigation();
const mobileScreen = ref<HTMLElement>();
// The Android composition root registers the official Material Web elements.
// Other hosts keep their existing native controls and visual language.
const buttonTag = (materialTag: string) => material3 ? materialTag : 'button';
const sessions = useAervoxSessions();
const sessionsOpen = ref(false);
const historyOpen = ref(false);
const historySessionId = ref('');
const historyTitle = ref('');
const sessionsReady = ref(false);
const sessionChanging = ref(false);
const preparingSession = ref(false);
const sessionFeedback = ref('');
const sessionCreationError = ref('');
const sessionListError = ref<string | null>(null);
const mobileSessionTitle = computed(() => sessions.activeSession.value?.title ?? (!sessionsReady.value ? '正在读取会话…' : sessionListError.value ? '会话读取失败' : sessions.activeSessionId.value && sessions.activeSessionId.value !== 'web_default' ? '当前会话不可用' : '新对话'));

/* ---------- 对话盒 ---------- */
const identity = readCompanionIdentity();
const companionName = ref(identity.companionName);
const greeting = '你好' + (identity.userAddress === '你' ? '' : '，' + identity.userAddress) + '，我是' + identity.companionName + '。今天想继续昨天的进度，还是先安静专注一会儿？';
const dialogueCtx = ref('主动陪伴 · 每日开场');
const { shown: dialogueText, streaming: dialogueTyping, say, appendDelta, finish } = useDialogueTyper(greeting);

/* ---------- 建议卡（主动建议，附理由） ---------- */
interface Suggestion {
  key: string;
  label: string;
  reason: string;
  primary: boolean;
  reply: string;
  ctx: string;
  action: () => Promise<boolean> | void;
}

function relativeDay(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '最近';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return '今天早些时候';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

const sending = ref(false);
const stopping = ref(false);
const waitingForReply = ref(false);
const turnFeedback = ref<{ kind: 'connection-error' | 'observer-error' | 'turn-error' | 'cancel-error' | 'stopped' | 'completed'; message: string }>();
interface FailedTurn {
  content: string;
  source: 'suggestion' | 'whisper';
  sessionId?: string;
}
const failedTurn = ref<FailedTurn>();
const turnController = createConversationController(getClientTransport(), surface.signal);
const conversationState = ref(turnController.state);
const unsubscribeConversation = turnController.subscribe(state => { conversationState.value = state; });
const interactionBusy = ref(false);
let stopPreparing = false;
let hasTurnReply = false;
const sessionSwitchLocked = computed(() => sending.value || stopping.value || interactionBusy.value || sessionChanging.value
  || ['submitting', 'observing', 'awaiting-input', 'awaiting-approval', 'observer-error'].includes(conversationState.value.status)
  || conversationState.value.retryAvailable === true);
const switchLockReason = computed(() => conversationState.value.retryAvailable && !conversationState.value.turnId
  ? '上一条消息的提交结果尚未确认，请先重试。回看记录不会再次发送消息。'
  : conversationState.value.question ? '请先回答当前问题，或明确停止当前回复，再切换会话。'
  : conversationState.value.approval ? '请先处理当前工具授权，或明确停止当前回复，再切换会话。'
  : '回复尚未结束。可以回看记录，结束当前回复后再切换或新建。');
const observationFailed = () => turnController.state.status === 'observer-error';
const canStop = computed(() => sending.value || ['observing', 'awaiting-input', 'awaiting-approval', 'observer-error'].includes(conversationState.value.status));

async function stopTurn() {
  if (!canStop.value || stopping.value) return;
  stopping.value = true;
  stopPreparing = true;
  turnFeedback.value = undefined;
  try {
    await turnController.stop();
    if (turnController.state.status === 'stopped') {
      finish(); waitingForReply.value = false;
      turnFeedback.value = {kind: 'stopped', message: '已停止回复。'};
    }
  } catch {
    stopPreparing = false;
    turnFeedback.value = {kind: 'cancel-error', message: '停止失败，回复仍在继续。可以再试一次。'};
  } finally { stopping.value = false; }
}

function dialogueCallbacks(previousContext: string, preserveReply = false) {
  let receivedReply = preserveReply;
  return {
    get hasReply() { return receivedReply; },
    onDelta(text: string) {
      if (surface.signal.aborted || !text) return;
      if (!receivedReply) { say(''); receivedReply = true; }
      hasTurnReply = true; waitingForReply.value = false;
      appendDelta(text);
    },
    onDone() {
      if (surface.signal.aborted) return;
      finish(); waitingForReply.value = false;
      dialogueCtx.value = turnController.state.question ? '等待你的回答' : turnController.state.approval ? '等待工具授权' : receivedReply ? companionName.value + ' · 刚刚回复' : previousContext;
      turnFeedback.value = receivedReply || turnController.state.question || turnController.state.approval ? undefined : {kind: 'completed', message: '本次回复已完成。'};
    },
    onError(error: unknown) { throw error; },
    onUserQuestion() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待你的回答'; },
    onToolApproval() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待工具授权'; },
  };
}

async function sendTurn(content: string, source: 'suggestion' | 'whisper' = 'suggestion', draftText?: string) {
  if (sending.value || surface.signal.aborted || material3 && sessionSwitchLocked.value) return false;
  if (material3 && (!sessionsReady.value || sessionListError.value)) {
    sessionFeedback.value = '请先读取会话列表，再发送消息。你的草稿会保留。'; sessionsOpen.value = true; return false;
  }
  if (material3 && sessions.activeSessionId.value && sessions.activeSessionId.value !== 'web_default'
    && !sessions.sessions.value.some(session => session.id === sessions.activeSessionId.value)) {
    sessionFeedback.value = '当前会话已不可用，请选择其他会话或新建。草稿仍保留在原会话。'; sessionsOpen.value = true; return false;
  }
  sending.value = true; waitingForReply.value = true; stopPreparing = false;
  turnFeedback.value = undefined; failedTurn.value = undefined; finish();
  const previousContext = dialogueCtx.value;
  let submission: FailedTurn = {content, source};
  hasTurnReply = false;
  const callbacks = dialogueCallbacks(previousContext);
  try {
    if (!sessions.sessions.value.some(session => session.id === sessions.activeSessionId.value)) {
      const previousId = sessions.activeSessionId.value;
      preparingSession.value = material3;
      try { await sessions.createNewSession(); } finally { preparingSession.value = false; }
      if (material3 && draftText !== undefined) drafts.transferUnsubmittedDraft(previousId, sessions.activeSessionId.value, draftText);
    }
    surface.signal.throwIfAborted();
    if (stopPreparing) { turnFeedback.value = {kind: 'stopped', message: '已停止回复。'}; return false; }
    const sessionId = sessions.activeSessionId.value;
    submission = {content, source, sessionId};
    if (material3 && draftText !== undefined) drafts.beginDraftSubmission(draftText, sessionId);
    dialogueCtx.value = '正在回复';
    await turnController.submit(sessionId, content, callbacks, {
      signal: surface.signal,
      metadata: {...identity},
      onAccepted: material3 && source === 'whisper' ? () => {
        if (surface.signal.aborted) return;
        drafts.acceptDraftSubmission(sessionId);
      } : undefined,
    });
    if (turnController.state.status === 'stopped') turnFeedback.value = {kind: 'stopped', message: '已停止回复。'};
    return turnController.state.status !== 'stopped';
  } catch {
    if (!surface.signal.aborted) {
      finish(); waitingForReply.value = false;
      if (material3 && source === 'whisper') {
        if (turnController.state.turnId) drafts.acceptDraftSubmission(submission.sessionId);
        else if (draftText !== undefined) drafts.restoreFailedDraft();
      }
      if (observationFailed()) {
        turnFeedback.value = {kind: 'observer-error', message: '连接中断，已保留收到的回复。可恢复接收。'};
      } else {
        // Controller.retry owns uncertain submissions and their idempotency reservation.
        failedTurn.value = submission;
        turnFeedback.value = turnController.state.turnId
          ? {kind: 'turn-error', message: '本次回复未完成，已保留收到的内容。'}
          : {kind: 'connection-error', message: callbacks.hasReply ? '连接中断，已保留收到的回复。' : '未能收到回复，请重试。'};
        if (turnController.state.turnId) dialogueCtx.value = '回复未完成';
      }
    }
    return false;
  } finally { sending.value = false; stopping.value = false; waitingForReply.value = false; }
}

async function resumeAfterSavedAnswer() {
  if (!material3 || sending.value || turnController.state.status !== 'observing' || !turnController.state.turnId) return;
  sending.value = true; waitingForReply.value = true;
  try { await turnController.observe(turnController.state.turnId, dialogueCallbacks(dialogueCtx.value, hasTurnReply), {
    afterEventId: turnController.state.afterEventId, signal: surface.signal,
  }); } catch {
    if (!surface.signal.aborted) turnFeedback.value = {kind: 'observer-error', message: '回答已保存，接收回复失败。可以恢复接收。'};
  } finally { sending.value = false; waitingForReply.value = false; }
}
async function answerQuestion(answers: AskUserQuestionAnswerItem[]) {
  if (interactionBusy.value) return;
  interactionBusy.value = true;
  let saved = false;
  try {
    await turnController.answer(answers); saved = true;
    dialogueCtx.value = '正在继续回复';
    await nextTick();
  } catch { turnFeedback.value = {kind: 'connection-error', message: '回答没有保存，请重试。'}; }
  finally { interactionBusy.value = false; }
  // A transport can finish its first stream while awaiting a question. Observe
  // the same turn without holding the answer control busy through its next question.
  if (saved) void resumeAfterSavedAnswer();
}
async function decideApproval(decision: 'granted' | 'denied') {
  if (interactionBusy.value || sending.value) return;
  interactionBusy.value = true; sending.value = true;
  turnFeedback.value = undefined;
  try { await turnController.decide(decision, dialogueCallbacks(dialogueCtx.value, hasTurnReply)); }
  catch { turnFeedback.value = {kind: observationFailed() ? 'observer-error' : 'connection-error', message: '授权或续跑连接失败，请重试。'}; }
  finally { interactionBusy.value = false; sending.value = false; }
}

const suggestions = computed<Suggestion[]>(() => {
  const list: Suggestion[] = [];
  const recent = [...sessions.sessions.value]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (recent) {
    list.push({
      key: 'resume',
      label: `继续「${recent.title}」`,
      reason: `${relativeDay(recent.updatedAt)}聊到这里 · 点击接续`,
      primary: true,
      reply: `好，我们回到「${recent.title}」。接着上次的地方继续——你还记得到哪里了吗？`,
      ctx: '接续最近会话',
      action: () => {
        if (material3) { selectMobileSession(recent.id); return; }
        // Keep the actual reply and its recovery cursor together when reselecting
        // the current conversation; a canned greeting must never replace it.
        if (sessions.activeSessionId.value === recent.id && turnController.state.turnId) return;
        turnController.reset(); failedTurn.value = undefined; turnFeedback.value = undefined;
        hasTurnReply = false; waitingForReply.value = false;
        sessions.switchSession(recent.id);
        say(`好，我们回到「${recent.title}」。接着上次的地方继续——你还记得到哪里了吗？`, '接续最近会话');
      },
    });
  }
  list.push({
    key: 'focus',
    label: '先专注 25 分钟',
    reason: '番茄钟 · 到点' + companionName.value + '提醒你',
    primary: list.length === 0,
    reply: '',
    ctx: '番茄钟',
    action: () => sendTurn('我想专注 25 分钟，帮我开始一个番茄钟。'),
  });
  if (list.length === 1) {
    list.unshift({
      key: 'first-goal',
      label: '定下今天的学习目标',
      reason: '还没有学习记录 · 从一句目标开始',
      primary: true,
      reply: '',
      ctx: '新的起点',
      action: () => sendTurn('今天我想开始学习一个新的目标，帮我拆解第一步。'),
    });
  }
  return list.slice(0, 2);
});

/* ---------- 悄悄话输入（淡化） ---------- */
const whisperOpen = ref(false);
const whisperText = ref('');
const whisperInput = ref<HTMLInputElement | HTMLTextAreaElement>();
const whisperPill = ref<HTMLButtonElement>();
const drafts = useSessionDraft({ input: whisperText, sessionId: sessions.activeSessionId,
  enabled: computed(() => material3), onRestore: () => { if (!sessionsOpen.value && !historyOpen.value && !settingsOpen.value) whisperOpen.value = true; } });
let inputLayer: ReturnType<NonNullable<typeof mobileBack>['registerLayer']> | undefined;
watch(whisperOpen, open => {
  if (open && material3) inputLayer ??= mobileBack?.registerLayer({ onBack: () => { void closeWhisper(); } });
  else { inputLayer?.close(); inputLayer = undefined; }
}, { immediate: true });
function resizeWhisper() {
  if (!material3 || !(whisperInput.value instanceof HTMLTextAreaElement)) return;
  const input = whisperInput.value;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}
watch(whisperText, () => { void nextTick(resizeWhisper); }, { immediate: true });
async function openWhisper() {
  whisperOpen.value = true;
  await nextTick();
  whisperInput.value?.focus();
}
async function closeWhisper() {
  whisperOpen.value = false;
  await nextTick();
  if (material3) { whisperInput.value?.blur(); mobileScreen.value?.focus({ preventScroll: true }); }
  else whisperPill.value?.focus({ preventScroll: true });
}
function onWhisperKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && (!material3 || event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendWhisper();
  } else if (event.key === 'Escape') void closeWhisper();
}
async function sendWhisper() {
  const raw = whisperText.value;
  const text = raw.trim();
  if (!text || sending.value) return;
  const sent = await sendTurn(text, 'whisper', material3 ? raw : undefined);
  if (!material3 && sent && whisperText.value.trim() === text) {
    whisperText.value = '';
    closeWhisper();
  }
}

async function retryTurn() {
  if (observationFailed()) {
    if (sending.value || !turnController.state.retryAvailable) return;
    sending.value = true; turnFeedback.value = undefined;
    try { await turnController.retry(dialogueCallbacks(dialogueCtx.value, hasTurnReply)); }
    catch { if (!surface.signal.aborted) turnFeedback.value = {kind: 'observer-error', message: '连接失败，已保留回复。可再次恢复接收。'}; }
    finally { sending.value = false; waitingForReply.value = false; }
    return;
  }
  const failed = failedTurn.value;
  if (!failed || sending.value) return;
  const content = material3 ? failed.content : failed.source === 'whisper' ? whisperText.value.trim() : failed.content;
  if (content !== failed.content || failed.sessionId !== sessions.activeSessionId.value) {
    if (failed.source === 'whisper') await sendWhisper();
    else await sendTurn(content, failed.source);
    return;
  }
  sending.value = true; waitingForReply.value = true; turnFeedback.value = undefined;
  try {
    await turnController.retry(dialogueCallbacks(dialogueCtx.value));
    failedTurn.value = undefined;
    if (!material3 && failed.source === 'whisper' && whisperText.value.trim() === failed.content) { whisperText.value = ''; closeWhisper(); }
  } catch (error) {
    if (error instanceof Error && error.message === 'submission_not_retryable') {
      sending.value = false;
      if (material3) await sendTurn(failed.content, failed.source);
      else if (failed.source === 'whisper') await sendWhisper();
      else await sendTurn(failed.content, failed.source);
    } else if (!surface.signal.aborted) {
      turnFeedback.value = {kind: observationFailed() ? 'observer-error' : 'connection-error', message: '连接失败，请稍后重试。'};
      if (observationFailed()) failedTurn.value = undefined;
    }
  } finally { sending.value = false; waitingForReply.value = false; }
}

async function refreshMobileSessions() {
  sessionCreationError.value = '';
  await sessions.fetchSessions({ preserveSelection: true });
  sessionsReady.value = true; sessionListError.value = sessions.error.value;
}
function openMobileHistory(id = sessions.activeSessionId.value, title = sessions.activeSession.value?.title ?? '当前会话') {
  historySessionId.value = id; historyTitle.value = title; historyOpen.value = true;
}
function resetMobilePresentation() {
  turnController.reset(); failedTurn.value = undefined; turnFeedback.value = undefined;
  hasTurnReply = false; waitingForReply.value = false; sessionFeedback.value = ''; whisperOpen.value = false;
}
function selectMobileSession(id: string) {
  if (sessionSwitchLocked.value || !sessions.sessions.value.some(item => item.id === id)) return;
  if (id !== sessions.activeSessionId.value) {
    resetMobilePresentation(); sessions.switchSession(id);
    say('已切换会话。可以回看已保存的记录，或继续发送消息。', '继续对话');
  }
  sessionsOpen.value = false;
}
async function createMobileSession() {
  if (sessionSwitchLocked.value || sessions.loading.value) return;
  sessionChanging.value = true; sessionFeedback.value = ''; sessionCreationError.value = '';
  const previous = sessions.activeSessionId.value, draft = whisperText.value;
  try {
    await sessions.createNewSession();
    if (surface.signal.aborted) return;
    // Explicit creation supplies an authoritative selected session even if the
    // earlier list read failed. Do not keep that stale read error blocking it.
    sessionsReady.value = true; sessionListError.value = null;
    if (previous === 'web_default' && draft.trim()) drafts.transferUnsubmittedDraft(previous, sessions.activeSessionId.value, draft);
    resetMobilePresentation(); sessionsOpen.value = false;
    say('新的对话准备好了。想聊什么，直接告诉我。', '新对话');
  } catch { sessionCreationError.value = '新对话没有创建成功，草稿已保留。可以再次点击“新对话”。'; }
  finally { sessionChanging.value = false; }
}

/* ---------- 回到默认工作台（逃生口） ---------- */
function backToDefaultSurface() { props.surfaceNavigation?.openDefault(); }

/* Follow the visible viewport when a mobile keyboard or browser toolbar moves. */
const viewportHeight = ref<number>();
const viewportTop = ref(0);
function syncViewport() {
  const viewport = window.visualViewport;
  // Pinch zoom must remain available without resizing the app's layout.
  if (viewport && viewport.scale !== 1) return;
  viewportHeight.value = viewport?.height ?? window.innerHeight;
  viewportTop.value = viewport?.offsetTop ?? 0;
}

onMounted(() => {
  if (surface.platform !== 'desktop') {
    let savedTheme: string | null = null;
    try { savedTheme = localStorage.getItem('aervox-theme'); } catch { /* Follow the system when storage is unavailable. */ }
    document.documentElement.dataset.theme = savedTheme === 'dark' || savedTheme === 'light'
      ? savedTheme : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  if (material3) void refreshMobileSessions(); else void sessions.fetchSessions();
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
});
onBeforeUnmount(() => {
  inputLayer?.dispose(); inputLayer = undefined;
  unsubscribeConversation(); turnController.dispose();
  finish();
  window.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('scroll', syncViewport);
});
</script>

<template>
  <div
    ref="mobileScreen"
    :tabindex="material3 ? -1 : undefined"
    class="proactive-companion"
    :class="{ 'pc-viewport--short': viewportHeight !== undefined && viewportHeight < 500 }"
    :data-platform="surface.platform"
    :data-design-system="material3 ? 'material3' : undefined"
    :style="{ '--pc-viewport-height': viewportHeight === undefined ? undefined : `${viewportHeight}px`, '--pc-viewport-top': `${viewportTop}px` }"
  >
    <header class="pc-header">
      <div class="pc-brand"><AervoxBrandMark class="pc-brand-mark" :size="28" aria-hidden="true" /><span>思隅</span></div>
      <div class="pc-top-right">
        <component :is="buttonTag('md-icon-button')" v-if="!material3" class="pc-quiet-btn" type="button" title="设置" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="material3 ? 24 : 18" aria-hidden="true" /></component>
        <component :is="buttonTag('md-icon-button')" v-if="surfaceNavigation && !material3" class="pc-quiet-btn" type="button" title="回到完整工作台" aria-label="回到完整工作台" @click="backToDefaultSurface"><ArrowUpRight :size="material3 ? 24 : 19" aria-hidden="true" /></component>
      </div>
    </header>

    <p v-if="material3" class="pc-current-session">{{ mobileSessionTitle }}</p>
    <main class="pc-content">
    <div class="pc-stage">
      <div class="pc-pet-wrap">
        <div class="pc-pet-status">伴学中</div>
        <PetWithFallback :show-fallback-while-loading="material3" />
      </div>
    </div>

    <section class="pc-dialogue" aria-label="陪伴对话">
      <div class="pc-dialogue-name">{{ companionName }}</div>
      <div class="pc-dialogue-box">
        <p v-if="waitingForReply" class="pc-dialogue-waiting" role="status">
          <component v-if="material3" :is="'md-linear-progress'" class="pc-material-progress" indeterminate aria-hidden="true" />
          <span v-else class="pc-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>正在等待回复…</span>
        </p>
        <p v-else class="pc-dialogue-text" aria-live="polite">{{ dialogueText }}<span v-if="dialogueTyping" class="pc-caret" aria-hidden="true" /></p>
        <div class="pc-dialogue-foot">
          <span class="pc-dialogue-ctx">{{ dialogueCtx }}</span>
        </div>
      </div>
      <div v-if="turnFeedback" class="pc-feedback" :data-kind="turnFeedback.kind" role="status">
        <span>{{ turnFeedback.message }}</span>
        <component :is="buttonTag('md-text-button')"
          v-if="failedTurn"
          type="button"
          class="pc-retry pc-feedback-action"
          :disabled="sending || (!material3 && failedTurn.source === 'whisper' && !whisperText.trim())"
          @click="retryTurn"
        ><RotateCcw :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 14" aria-hidden="true" />重试发送</component>
        <component :is="buttonTag('md-text-button')" v-else-if="conversationState.status === 'observer-error' && conversationState.retryAvailable" type="button" class="pc-resume pc-feedback-action" :disabled="sending" @click="retryTurn"><RotateCcw :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 14" aria-hidden="true" />恢复接收回复</component>
        <component :is="buttonTag('md-text-button')" v-else-if="turnFeedback.kind === 'cancel-error' && sending" type="button" class="pc-retry pc-feedback-action" :disabled="stopping" @click="stopTurn">重试停止</component>
      </div>
    </section>

    <section v-if="conversationState.question" class="pc-interaction" aria-label="回答问题">
      <UserQuestionComposer :question-data="conversationState.question" :submitting="interactionBusy" @submit="answerQuestion" />
    </section>
    <section v-if="conversationState.approval" class="pc-interaction" aria-label="工具授权">
      <p>请求执行 {{ conversationState.approval.toolName }}，需要你的确认。</p>
      <component :is="buttonTag('md-filled-button')" type="button" :disabled="interactionBusy || sending" @click="decideApproval('granted')">批准</component>
      <component :is="buttonTag('md-text-button')" type="button" :disabled="interactionBusy || sending" @click="decideApproval('denied')">拒绝</component>
    </section>

    <section v-if="!whisperOpen" class="pc-choices" aria-label="今日建议">
      <component :is="buttonTag('button')"
        v-for="(card, index) in suggestions"
        :key="card.key"
        type="button"
        class="pc-choice"
        :class="{ 'pc-choice--primary': card.primary && (!material3 || index === 0) }"
        :disabled="sending || material3 && (sessionSwitchLocked || !sessionsReady)"
        @click="card.action"
      >
        <component v-if="material3" :is="'md-ripple'" aria-hidden="true" />
        <span class="pc-choice-label">{{ card.label }}</span>
        <span class="pc-choice-reason">{{ card.reason }}</span>
      </component>
    </section>
    </main>

    <p v-if="preparingSession || sessionChanging" class="pc-mobile-preparing" role="status">正在准备新对话，草稿会保留…</p>
    <p v-if="material3 && sessionFeedback" class="pc-mobile-session-feedback" role="alert">{{ sessionFeedback }}</p>
    <nav v-if="material3" class="pc-mobile-actions" aria-label="移动端操作">
      <component :is="'md-text-button'" type="button" aria-label="会话列表" @click="sessionsOpen = true"><MessagesSquare slot="icon" :size="20" />会话</component>
      <component :is="'md-text-button'" type="button" aria-label="回看当前会话" :disabled="!sessions.activeSession.value" @click="openMobileHistory()"><History slot="icon" :size="20" />回看</component>
      <component :is="'md-icon-button'" type="button" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="24" /></component>
    </nav>
    <aside class="pc-whisper" :class="{ 'pc-whisper--open': whisperOpen }" aria-label="对话输入">
      <template v-if="!whisperOpen && !material3">
        <component :is="buttonTag('md-filled-tonal-button')" ref="whisperPill" type="button" class="pc-whisper-pill" @click="openWhisper"><MessageSquare :slot="material3 ? 'icon' : undefined" :size="material3 ? 20 : 15" aria-hidden="true" /><span>悄悄对{{ companionName }}说…</span></component>
        <component :is="buttonTag('md-filled-tonal-button')" v-if="canStop" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn"><Square :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 12" aria-hidden="true" />{{ stopping ? '停止中' : '停止' }}</component>
      </template>
      <div v-else class="pc-whisper-input">
        <label v-if="material3" class="pc-whisper-label" for="pc-material-whisper">悄悄对{{ companionName }}说</label>
        <textarea v-if="material3" :readonly="preparingSession || sessionChanging" id="pc-material-whisper" ref="whisperInput" v-model="whisperText" rows="1"
          :aria-label="'悄悄对' + companionName + '说'" :placeholder="'想到什么，直接告诉' + companionName" enterkeyhint="enter"
          @focus="openWhisper()" @input="resizeWhisper" @keydown="onWhisperKeydown" />
        <input v-else ref="whisperInput" v-model="whisperText" :aria-label="'悄悄对' + companionName + '说'"
          :placeholder="'想到什么，直接告诉' + companionName" enterkeyhint="send" @keydown="onWhisperKeydown" />
        <component :is="buttonTag('md-filled-tonal-button')" v-if="canStop" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn"><Square :slot="material3 ? 'icon' : undefined" :size="material3 ? 18 : 12" aria-hidden="true" />{{ stopping ? '停止中' : '停止' }}</component>
        <component :is="buttonTag('md-filled-button')" v-else type="button" :disabled="!whisperText.trim() || material3 && (sessionSwitchLocked || !sessionsReady)" @click="sendWhisper()">发送</component>
        <component :is="buttonTag('md-icon-button')" type="button" v-if="!material3 || whisperOpen" class="pc-whisper-close" title="收起" aria-label="收起输入" @click="closeWhisper"><X :size="material3 ? 24 : 18" aria-hidden="true" /></component>
      </div>
    </aside>
    <MobileSessionsDialog v-if="material3" v-model="sessionsOpen" :sessions="sessions.sessions.value" :active-session-id="sessions.activeSessionId.value"
      :loading="sessions.loading.value" :error="sessionListError" :notice="sessionCreationError || sessionFeedback" :changing="sessionChanging" :switch-locked="sessionSwitchLocked" :lock-reason="switchLockReason"
      @refresh="refreshMobileSessions" @new="createMobileSession" @select="selectMobileSession" @history="session => openMobileHistory(session.id, session.title)" />
    <MobileHistoryDialog v-if="material3" v-model="historyOpen" :session-id="historySessionId" :title="historyTitle" />
    <MobileSettingsDialog v-model="settingsOpen" :panels="props.settingsPanels" />
  </div>
</template>

<style scoped>
/* 方向 D：Codex 式克制 × 视觉小说。自包含表面，不依赖工作台主题链。 */
.proactive-companion {
  --pc-bg: #fbfbfa;
  --pc-ink: #17181a;
  --pc-ink-2: #565b63;
  --pc-ink-3: #656d79;
  --pc-feedback: #994424;
  --pc-line: rgba(23, 24, 26, .09);
  --pc-line-soft: rgba(23, 24, 26, .055);
  --pc-accent: #2f5bd0;
  --pc-accent-soft: rgba(47, 91, 208, .07);
  --pc-card: #fff;
  --pc-radius: 12px;
  --pc-ease: cubic-bezier(.22, 1, .36, 1);

  position: fixed;
  inset: var(--pc-viewport-top, 0px) 0 auto;
  height: var(--pc-viewport-height, 100dvh);
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  background:
    radial-gradient(46% 40% at 42% 62%, rgba(47, 91, 208, .05), transparent 70%),
    var(--pc-bg);
  color: var(--pc-ink);
  font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
}
.proactive-companion,
.proactive-companion :deep(*) { box-sizing: border-box; }
:root[data-theme="dark"] .proactive-companion {
  --pc-bg: #101318;
  --pc-ink: #e7ebf2;
  --pc-ink-2: #a4adbd;
  --pc-ink-3: #a0aabc;
  --pc-feedback: #f1b08d;
  --pc-line: rgba(231, 235, 242, .1);
  --pc-line-soft: rgba(231, 235, 242, .06);
  --pc-accent: #7ea2f8;
  --pc-accent-soft: rgba(126, 162, 248, .1);
  --pc-card: #171b22;
}

/* 顶栏与输入各占一行；只有中间内容随可用视口滚动。 */
.pc-header {
  z-index: 10;
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-width: 0;
  padding: calc(8px + env(safe-area-inset-top, 0px))
    max(16px, env(safe-area-inset-right, 0px)) 8px
    max(16px, env(safe-area-inset-left, 0px));
}
.pc-brand {
  display: flex; align-items: center; gap: 9px; min-width: 0;
  font-size: 13.5px; font-weight: 600; letter-spacing: .02em; overflow-wrap: anywhere;
}
.pc-brand-mark {
  flex: 0 0 28px; color: var(--pc-ink);
}
.pc-top-right { display: flex; align-items: center; gap: 2px; }
.pc-quiet-btn {
  display: grid; place-items: center;
  width: 44px; height: 44px; flex: 0 0 44px; border: 0; background: transparent; border-radius: 8px;
  color: var(--pc-ink-3); cursor: pointer; font-size: 15px;
}
.pc-quiet-btn:hover { color: var(--pc-ink); background: rgba(128, 134, 146, .12); }
.pc-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: max-content;
  align-content: start;
  gap: 18px;
  min-width: 0; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  padding: 16px max(16px, env(safe-area-inset-right, 0px)) 20px
    max(16px, env(safe-area-inset-left, 0px));
  scroll-padding-block: 16px;
}
.pc-content > * { min-width: 0; }

/* 舞台跟随内容流；手机的对话层可覆盖角色下半身。 */
.pc-stage {
  display: grid; place-items: center;
  min-width: 0;
  padding-top: 24px;
  pointer-events: none;
}
.pc-pet-wrap {
  position: relative;
  width: min(280px, 76vw);
  height: clamp(180px, 29dvh, 300px);
  max-width: 100%;
  pointer-events: auto;
}
/* Explicit phone hosts let dialogue overlap the larger character's lower body.
 * Short viewports still yield the stage to dialogue and the software keyboard. */
@media (max-width: 899px) {
  .proactive-companion[data-platform="mobile"] .pc-stage {
    position: relative;
    z-index: 0;
  }
  .proactive-companion[data-platform="mobile"] .pc-pet-wrap {
    width: min(400px, 94vw);
    height: clamp(360px, 64dvh, 600px);
  }
  /* Pixi sets an inline touch-action:none. Keep vertical page gestures while
   * retaining taps on the character in the larger phone stage. */
  .proactive-companion[data-platform="mobile"] .pc-pet-wrap :deep(canvas) {
    touch-action: pan-y pinch-zoom !important;
  }
  .proactive-companion[data-platform="mobile"] .pc-dialogue {
    position: relative;
    z-index: 1;
    margin-block-start: clamp(-200px, -22dvh, -120px);
  }
}
.pc-pet-wrap :deep(.aervox-live2d-pet) { min-height: 0; }
.pc-pet-wrap :deep(.aervox-live2d-pet__canvas) { inset: 0; }
.pc-pet-status {
  position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
  max-width: 100%;
  font-size: 11px; color: var(--pc-ink-3); letter-spacing: .12em;
  display: flex; align-items: center; gap: 6px; overflow-wrap: anywhere;
}
.pc-pet-status::before { content: ""; flex: 0 0 5px; width: 5px; height: 5px; border-radius: 50%; background: #35a06f; }

/* 对话盒 */
.pc-dialogue {
  width: 100%; max-width: 620px;
  justify-self: center;
  min-width: 0;
}
.pc-dialogue-name {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%;
  font-size: 11.5px; font-weight: 600; letter-spacing: .22em; color: var(--pc-ink-2);
  margin-bottom: 10px; margin-left: 4px; overflow-wrap: anywhere;
}
.pc-dialogue-name::after { content: ""; flex: 0 0 28px; width: 28px; height: 1px; background: var(--pc-line); }
.pc-dialogue-box {
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  min-width: 0; padding: 18px 18px 16px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04), 0 12px 40px -12px rgba(23, 24, 26, .1);
}
.pc-dialogue-text {
  font-size: 15px; line-height: 1.85; min-height: 56px;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal;
}
.pc-dialogue-waiting {
  display: flex; align-items: center; gap: 10px;
  min-height: 56px; margin-block: 1em;
  font-size: 13px; line-height: 1.6; color: var(--pc-ink-2);
}
.pc-waiting-dots { display: flex; flex: 0 0 auto; gap: 4px; }
.pc-waiting-dots i { width: 4px; height: 4px; border-radius: 50%; background: var(--pc-accent); animation: pc-waiting-pulse 1.2s var(--pc-ease) infinite; }
.pc-waiting-dots i:nth-child(2) { animation-delay: .15s; }
.pc-waiting-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes pc-waiting-pulse { 0%, 100% { opacity: .35; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.pc-caret {
  display: inline-block; width: 2px; height: 1em; background: var(--pc-ink-3);
  vertical-align: -2px; margin-left: 2px; animation: pc-caret-blink 1s steps(1) infinite;
}
@keyframes pc-caret-blink { 50% { opacity: 0; } }
.pc-dialogue-foot {
  display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;
  min-width: 0;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--pc-line-soft);
}
.pc-dialogue-ctx { min-width: 0; font-size: 11px; color: var(--pc-ink-3); letter-spacing: .04em; overflow-wrap: anywhere; }
.pc-dialogue-foot button { min-width: 44px; min-height: 44px; }
.pc-feedback {
  display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px;
  padding: 8px 4px 0; font-size: 12px; line-height: 1.6; color: var(--pc-ink-2);
}
.pc-feedback[data-kind$="error"] { color: var(--pc-feedback); }
.pc-feedback > span { min-width: 0; overflow-wrap: anywhere; }
.pc-feedback-action {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 44px; padding: 4px 8px; border: 0; border-radius: 8px;
  background: transparent; color: var(--pc-accent); font: inherit; font-weight: 600; cursor: pointer;
}
.pc-feedback-action:hover { background: var(--pc-accent-soft); }
.pc-feedback-action:disabled { color: var(--pc-ink-3); cursor: default; }

/* 建议卡留在滚动内容中，输入固定在独立底栏。 */
.pc-choices {
  width: 100%; max-width: 620px; min-width: 0;
  justify-self: center;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px;
}
.pc-choices.pc-choices--hidden,
.proactive-companion:has(.pc-whisper--open) .pc-choices { display: none; }
.pc-choice {
  min-width: 0; min-height: 44px;
  text-align: left; cursor: pointer; font-family: inherit;
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  padding: 14px 18px 13px; color: var(--pc-ink);
  transition: transform .18s var(--pc-ease), border-color .18s, box-shadow .18s;
  display: flex; flex-direction: column;
  white-space: normal; overflow-wrap: anywhere;
}
.pc-choice:hover:not(:disabled) { transform: translateY(-2px); border-color: rgba(128, 134, 146, .4); box-shadow: 0 8px 24px -10px rgba(23, 24, 26, .14); }
.pc-choice:disabled { opacity: .55; cursor: default; }
.pc-choice-label { font-size: 13.5px; font-weight: 600; letter-spacing: .02em; }
.pc-choice-reason { font-size: 11.5px; color: var(--pc-ink-3); margin-top: 5px; line-height: 1.5; }
.pc-choice--primary { border-color: color-mix(in srgb, var(--pc-accent) 40%, transparent); background: linear-gradient(180deg, var(--pc-accent-soft), transparent 60%), var(--pc-card); }
.pc-choice--primary .pc-choice-label { color: var(--pc-accent); }
.pc-choice--primary .pc-choice-label::before { content: ""; display: inline-block; width: 5px; height: 5px; margin-right: 8px; border-radius: 50%; background: currentColor; vertical-align: 2px; }

/* 悄悄话底栏随 visual viewport 缩放，始终留出安全区。 */
.pc-whisper {
  z-index: 6;
  display: flex; justify-content: flex-end;
  min-width: 0;
  padding: 10px max(16px, env(safe-area-inset-right, 0px))
    calc(12px + env(safe-area-inset-bottom, 0px))
    max(16px, env(safe-area-inset-left, 0px));
  background: var(--pc-bg);
}
.pc-stop { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 44px; min-height: 44px; margin-left: 8px; padding: 8px 12px; border: 1px solid var(--pc-line); border-radius: 10px; background: var(--pc-card); color: var(--pc-ink); font: inherit; font-size: 12px; cursor: pointer; }
.pc-stop:disabled { opacity: .5; cursor: default; }
.pc-stop:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-whisper-pill {
  display: flex; align-items: center; gap: 7px;
  max-width: 100%; min-height: 44px;
  border: 1px solid var(--pc-line); background: var(--pc-card); border-radius: 999px;
  padding: 9px 16px; font-size: 12px; color: var(--pc-ink-3); cursor: text; font-family: inherit;
  white-space: normal; overflow-wrap: anywhere;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04);
}
.pc-whisper-pill:hover { color: var(--pc-ink-2); border-color: rgba(128, 134, 146, .4); }
.pc-whisper--open { justify-content: center; }
.pc-whisper-input {
  display: flex; width: 100%; max-width: 620px; min-width: 0; align-items: center; gap: 6px;
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  padding: 6px 8px 6px 12px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04), 0 12px 40px -12px rgba(23, 24, 26, .12);
}
.pc-whisper-input input {
  flex: 1 1 0%; min-width: 0; width: 0; min-height: 44px;
  border: 0; outline: 0; font: inherit; font-size: 16px;
  color: var(--pc-ink); background: transparent;
}
.pc-whisper-input input::placeholder { color: var(--pc-ink-3); opacity: 1; }
.pc-whisper-input button {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  flex: 0 0 auto; min-width: 44px; min-height: 44px;
  border: 0; background: var(--pc-ink); color: var(--pc-bg); border-radius: 8px;
  padding: 8px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.pc-whisper-input button:disabled { opacity: .5; cursor: default; }
.pc-whisper-close { background: transparent !important; color: var(--pc-ink-3) !important; padding: 8px !important; }
.pc-quiet-btn:focus-visible,
.pc-choice:focus-visible,
.pc-whisper-pill:focus-visible,
.pc-feedback-action:focus-visible,
.pc-whisper-input button:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-whisper-input:focus-within { border-color: var(--pc-accent); }
.pc-quiet-btn, .pc-whisper-pill, .pc-stop, .pc-feedback-action, .pc-whisper-input button { transition: color .18s, background .18s, transform .18s var(--pc-ease); }
.pc-quiet-btn:active, .pc-choice:active:not(:disabled), .pc-whisper-pill:active, .pc-stop:active:not(:disabled), .pc-feedback-action:active:not(:disabled), .pc-whisper-input button:active:not(:disabled) { transform: scale(.98) translateY(1px); }

@media (min-width: 520px) {
  .pc-choices { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pc-dialogue-box { padding: 20px 24px 18px; }
}
@media (min-width: 900px) {
  .pc-header { padding-inline: max(24px, env(safe-area-inset-left, 0px)) max(24px, env(safe-area-inset-right, 0px)); }
  .pc-content {
    width: min(1120px, 100%); justify-self: center;
    grid-template-columns: minmax(0, .9fr) minmax(0, 1.2fr);
    grid-template-rows: minmax(min-content, 1fr) max-content;
    align-content: stretch; column-gap: 40px; row-gap: 18px;
    padding-block: 24px 32px;
  }
  .pc-stage { grid-column: 1; grid-row: 1 / 3; align-self: center; }
  .pc-pet-wrap { width: min(420px, 100%); height: clamp(340px, 55dvh, 560px); }
  .pc-dialogue { grid-column: 2; grid-row: 1; align-self: end; }
  .pc-choices { grid-column: 2; grid-row: 2; }
  .pc-whisper { padding-inline: max(24px, env(safe-area-inset-left, 0px)) max(24px, env(safe-area-inset-right, 0px)); }
}
.proactive-companion.pc-viewport--short .pc-stage,
.pc-viewport--short .pc-stage { display: none; }
.proactive-companion.pc-viewport--short .pc-content,
.pc-viewport--short .pc-content {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: none;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
  padding-block: 8px 12px;
}
.proactive-companion.pc-viewport--short .pc-dialogue,
.proactive-companion.pc-viewport--short .pc-choices,
.pc-viewport--short .pc-dialogue,
.pc-viewport--short .pc-choices { grid-column: auto; grid-row: auto; }
.proactive-companion[data-platform="mobile"].pc-viewport--short .pc-dialogue { margin-block-start: 0; }
@media (max-height: 520px) {
  .pc-stage { display: none; }
  .pc-content {
    grid-template-columns: minmax(0, 1fr); grid-template-rows: none;
    grid-auto-rows: max-content; align-content: start; gap: 12px; padding-block: 8px 12px;
  }
  .pc-dialogue, .pc-choices { grid-column: auto; grid-row: auto; }
  .proactive-companion[data-platform="mobile"] .pc-dialogue { margin-block-start: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .pc-caret, .pc-waiting-dots i { animation: none; }
  .pc-choice, .pc-quiet-btn, .pc-whisper-pill, .pc-stop, .pc-feedback-action, .pc-whisper-input button { transition: none; }
}

/* Android: Material 3 roles and official component states. The composition
 * root alone opts into this language; desktop/web retain the existing surface. */
.proactive-companion[data-design-system="material3"][data-platform] {
  --pc-bg: var(--md-sys-color-surface);
  --pc-ink: var(--md-sys-color-on-surface);
  --pc-ink-2: var(--md-sys-color-on-surface-variant);
  --pc-ink-3: var(--md-sys-color-on-surface-variant);
  --pc-feedback: var(--md-sys-color-error);
  --pc-line: var(--md-sys-color-outline-variant);
  --pc-line-soft: var(--md-sys-color-outline-variant);
  --pc-accent: var(--md-sys-color-primary);
  --pc-accent-soft: var(--md-sys-color-primary-container);
  --pc-card: var(--md-sys-color-surface-container-low);
  --pc-radius: 24px;
  --pc-ease: cubic-bezier(.2, 0, 0, 1);
  background: var(--pc-bg);
  font-family: var(--md-ref-typeface-plain, Roboto, "Noto Sans SC", sans-serif);
  letter-spacing: 0;
}
.proactive-companion[data-design-system="material3"] .pc-header {
  min-height: calc(64px + env(safe-area-inset-top, 0px));
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: 0;
  background: var(--md-sys-color-surface);
}
.proactive-companion[data-design-system="material3"] .pc-brand { gap: 12px; font-size: 22px; line-height: 28px; font-weight: 400; letter-spacing: 0; }
.proactive-companion[data-design-system="material3"] .pc-top-right { gap: 0; }
.proactive-companion[data-design-system="material3"] .pc-quiet-btn {
  --md-icon-button-icon-size: 24px;
  --md-icon-button-state-layer-shape: 50%;
  width: 48px; height: 48px; flex-basis: 48px; border-radius: 50%; padding: 0;
  background: transparent; color: var(--md-sys-color-on-surface-variant);
}
.proactive-companion[data-design-system="material3"] .pc-content { gap: 24px; padding-block: 20px 24px; }
.proactive-companion[data-design-system="material3"] .pc-stage { padding-top: 24px; }
.proactive-companion[data-design-system="material3"] .pc-pet-status { font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .5px; }
.proactive-companion[data-design-system="material3"] .pc-pet-status::before { background: var(--md-sys-color-tertiary); }
.proactive-companion[data-design-system="material3"] .pc-dialogue-name { margin: 0 16px 8px; font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: .1px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-name::after { display: none; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-box { padding: 20px 24px; border: 0; border-radius: 24px; box-shadow: none; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-text { margin-block: 0; font-size: 16px; line-height: 26px; letter-spacing: .2px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-foot { padding-top: 0; margin-top: 16px; border-top: 0; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-ctx { font-size: 12px; line-height: 16px; letter-spacing: .4px; }
.proactive-companion[data-design-system="material3"] .pc-dialogue-waiting { display: grid; gap: 12px; margin: 0; font-size: 14px; line-height: 20px; }
.pc-material-progress { width: min(160px, 100%); }
.proactive-companion[data-design-system="material3"] .pc-choices { gap: 12px; }
.proactive-companion[data-design-system="material3"] .pc-choice {
  position: relative; isolation: isolate; min-height: 88px; padding: 16px 20px;
  justify-content: center; border: 0; border-radius: 16px;
  background: var(--md-sys-color-surface-container); color: var(--md-sys-color-on-surface);
  box-shadow: none; transform: none; overflow: hidden;
}
.proactive-companion[data-design-system="material3"] .pc-choice:hover:not(:disabled) { transform: none; box-shadow: none; }
.proactive-companion[data-design-system="material3"] .pc-choice--primary { background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); }
.proactive-companion[data-design-system="material3"] .pc-choice-label { font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: .15px; color: inherit; }
.proactive-companion[data-design-system="material3"] .pc-choice--primary .pc-choice-label::before { display: none; }
.proactive-companion[data-design-system="material3"] .pc-choice-reason { margin-top: 4px; font-size: 12px; line-height: 18px; letter-spacing: .25px; color: var(--md-sys-color-on-surface-variant); }
.proactive-companion[data-design-system="material3"] .pc-choice--primary .pc-choice-reason { color: var(--md-sys-color-on-primary-container); }
.proactive-companion[data-design-system="material3"] .pc-feedback {
  gap: 4px 12px; margin-top: 12px; padding: 12px 16px; border-radius: 16px;
  color: var(--md-sys-color-on-surface-variant); background: var(--md-sys-color-surface-container-high);
  font-size: 14px; line-height: 20px;
}
.proactive-companion[data-design-system="material3"] .pc-feedback[data-kind$="error"] { background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.proactive-companion[data-design-system="material3"] .pc-feedback-action { min-height: 48px; padding: 0; background: transparent; font-weight: 500; border-radius: 24px; }
.proactive-companion[data-design-system="material3"] .pc-whisper { gap: 8px; align-items: center; background: var(--md-sys-color-surface); }
.proactive-companion[data-design-system="material3"] .pc-whisper-pill {
  --md-filled-tonal-button-container-height: 48px;
  flex: 1 1 auto; min-width: 0; min-height: 48px; padding: 0; border: 0; box-shadow: none;
  font-size: 14px; line-height: 20px;
  color: var(--md-sys-color-on-secondary-container); background: transparent; border-radius: 24px;
}
.proactive-companion[data-design-system="material3"] .pc-whisper-pill svg { width: 20px; height: 20px; }
.proactive-companion[data-design-system="material3"] .pc-stop {
  --md-filled-tonal-button-container-height: 48px;
  margin: 0; min-height: 48px; border: 0; padding: 0; border-radius: 24px; background: transparent;
}
.proactive-companion[data-design-system="material3"] .pc-whisper-input {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center;
  gap: 0 4px; padding: 8px 8px 8px 16px; background: var(--md-sys-color-surface-container-high);
  border: 0; border-radius: 28px; box-shadow: none;
}
.proactive-companion[data-design-system="material3"] .pc-whisper-label { grid-column: 1; grid-row: 1; color: var(--md-sys-color-on-surface-variant); font-size: 12px; line-height: 16px; letter-spacing: .4px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-input input { grid-column: 1; grid-row: 2; min-height: 32px; width: 100%; font-size: 16px; line-height: 24px; letter-spacing: .2px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-input > :is(md-filled-button, md-filled-tonal-button) { grid-column: 2; grid-row: 1 / 3; min-width: 64px; --md-filled-button-container-height: 48px; }
.proactive-companion[data-design-system="material3"] .pc-whisper-close { grid-column: 3; grid-row: 1 / 3; width: 48px; height: 48px; padding: 0 !important; --md-icon-button-icon-size: 24px; }
.proactive-companion[data-design-system="material3"] .pc-interaction {
  width: 100%; max-width: 620px; justify-self: center; padding: 20px; border-radius: 24px;
  background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-on-surface);
}
.proactive-companion[data-design-system="material3"] .pc-interaction > md-filled-button { margin-inline-end: 8px; }
.proactive-companion[data-design-system="material3"] .pc-choice:focus-visible,
.proactive-companion[data-design-system="material3"] .pc-whisper-input:focus-within { outline: 3px solid var(--md-sys-color-primary); outline-offset: 3px; }
.proactive-companion[data-design-system="material3"] :is(.pc-quiet-btn, .pc-whisper-pill, .pc-stop, .pc-feedback-action, .pc-whisper-close):active { transform: none; }
.proactive-companion[data-design-system="material3"].pc-viewport--short .pc-content { padding-block: 12px; gap: 16px; }
@media (max-width: 359px) {
  .proactive-companion[data-design-system="material3"] .pc-dialogue-box { padding: 16px; }
  .proactive-companion[data-design-system="material3"] .pc-whisper-input { padding-inline-start: 12px; }
  .proactive-companion[data-design-system="material3"] .pc-whisper-input > :is(md-filled-button, md-filled-tonal-button) { min-width: 48px; }
}
</style>

<style scoped>
.proactive-companion[data-design-system="material3"] { display: flex; flex-direction: column; }
.proactive-companion[data-design-system="material3"] > .pc-header,
.proactive-companion[data-design-system="material3"] > .pc-whisper { flex: 0 0 auto; }
.proactive-companion[data-design-system="material3"] > .pc-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.pc-mobile-preparing { flex: 0 0 auto; margin: 8px 16px; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; }
.pc-current-session { flex: 0 0 auto; margin: -4px 24px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--md-sys-color-on-surface-variant); font-size: 14px; line-height: 20px; }
.pc-mobile-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 8px; padding: 0 16px; background: var(--md-sys-color-surface); }
.pc-mobile-actions > md-text-button { flex: 1; }
.pc-mobile-actions > md-icon-button { width: 48px; height: 48px; }
.pc-mobile-session-feedback { flex: 0 0 auto; margin: 8px 16px; font-size: 14px; line-height: 20px; color: var(--md-sys-color-error); }
.proactive-companion[data-design-system="material3"] .pc-whisper-input textarea { grid-column: 1; grid-row: 2; width: 100%; min-width: 0; min-height: 32px; max-height: 120px; border: 0; padding: 0; resize: none; outline: none; background: transparent; color: var(--md-sys-color-on-surface); font: inherit; font-size: 16px; line-height: 24px; overflow-y: auto; }
</style>
