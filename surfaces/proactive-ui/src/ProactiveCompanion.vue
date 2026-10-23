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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Component } from 'vue';
import { useUISurfaceContext } from '@aervox/ui-host';
import { AervoxBrandMark, PetWithFallback, UserQuestionComposer, readCompanionIdentity } from '@aervox/ui';
import { createConversationController, getTransport, useAervoxSessions } from '@aervox/api-client';
import { ArrowUpRight, MessageSquare, RotateCcw, Settings, Square, X } from 'lucide-vue-next';
import type { AskUserQuestionAnswerItem } from '@aervox/contracts';
import { useDialogueTyper } from './dialogue-typer';
import MobileSettingsDialog from './MobileSettingsDialog.vue';

const props = withDefaults(defineProps<{
  settingsPanels?: readonly { category: string; component: Component }[];
}>(), { settingsPanels: () => [] });
const settingsOpen = ref(false);

const surface = useUISurfaceContext();
const sessions = useAervoxSessions();

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
const turnFeedback = ref<{ kind: 'connection-error' | 'observer-error' | 'cancel-error' | 'stopped' | 'completed'; message: string }>();
interface FailedTurn {
  content: string;
  source: 'suggestion' | 'whisper';
  sessionId?: string;
  idempotencyKey?: string;
}
const failedTurn = ref<FailedTurn>();
const turnController = createConversationController(getTransport(), surface.signal);
const conversationState = ref(turnController.state);
const unsubscribeConversation = turnController.subscribe(state => { conversationState.value = state; });
const interactionBusy = ref(false);
let stopPreparing = false;

async function stopTurn() {
  if (!sending.value || stopping.value) return;
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

function dialogueCallbacks(previousContext: string) {
  let receivedReply = false;
  return {
    get hasReply() { return receivedReply; },
    onDelta(text: string) {
      if (surface.signal.aborted || !text) return;
      if (!receivedReply) { say(''); receivedReply = true; waitingForReply.value = false; }
      appendDelta(text);
    },
    onDone() {
      if (surface.signal.aborted) return;
      finish(); waitingForReply.value = false;
      dialogueCtx.value = receivedReply ? companionName.value + ' · 刚刚回复' : previousContext;
      turnFeedback.value = receivedReply ? undefined : {kind: 'completed', message: '本次回复已完成。'};
    },
    onError(error: unknown) { throw error; },
    onUserQuestion() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待你的回答'; },
    onToolApproval() { finish(); waitingForReply.value = false; dialogueCtx.value = '等待工具授权'; },
  };
}

async function sendTurn(content: string, source: 'suggestion' | 'whisper' = 'suggestion', retry?: FailedTurn) {
  if (sending.value || surface.signal.aborted) return false;
  sending.value = true; waitingForReply.value = true; stopPreparing = false;
  turnFeedback.value = undefined; failedTurn.value = undefined; finish();
  const previousContext = dialogueCtx.value;
  let submission: FailedTurn = {content, source};
  const callbacks = dialogueCallbacks(previousContext);
  try {
    if (!sessions.sessions.value.some(session => session.id === sessions.activeSessionId.value)) await sessions.createNewSession();
    surface.signal.throwIfAborted();
    if (stopPreparing) { turnFeedback.value = {kind: 'stopped', message: '已停止回复。'}; return false; }
    const sessionId = sessions.activeSessionId.value;
    const idempotencyKey = retry?.content === content && retry.source === source && retry.sessionId === sessionId ? retry.idempotencyKey : undefined;
    submission = {content, source, sessionId, idempotencyKey};
    dialogueCtx.value = '正在回复';
    await turnController.submit(sessionId, content, callbacks, {
      signal: surface.signal, idempotencyKey,
      metadata: {...identity},
    });
    if (turnController.state.status === 'stopped') turnFeedback.value = {kind: 'stopped', message: '已停止回复。'};
    return turnController.state.status !== 'stopped';
  } catch {
    if (!surface.signal.aborted) {
      finish(); waitingForReply.value = false;
      if (turnController.state.status === 'observer-error') {
        turnFeedback.value = {kind: 'observer-error', message: '连接中断，原请求可能仍在处理。可在完整工作台查看。'};
      } else {
        // Controller.retry owns uncertain submissions and their idempotency reservation.
        failedTurn.value = submission;
        turnFeedback.value = {kind: 'connection-error', message: callbacks.hasReply ? '连接中断，已保留收到的回复。' : '未能收到回复，请重试。'};
      }
    }
    return false;
  } finally { sending.value = false; stopping.value = false; waitingForReply.value = false; }
}

async function answerQuestion(answers: AskUserQuestionAnswerItem[]) {
  if (interactionBusy.value) return;
  interactionBusy.value = true;
  try { await turnController.answer(answers); }
  catch { turnFeedback.value = {kind: 'connection-error', message: '回答没有保存，请重试。'}; }
  finally { interactionBusy.value = false; }
}
async function decideApproval(decision: 'granted' | 'denied') {
  if (interactionBusy.value || sending.value) return;
  interactionBusy.value = true; sending.value = true;
  try { await turnController.decide(decision, dialogueCallbacks(dialogueCtx.value)); }
  catch { turnFeedback.value = {kind: 'observer-error', message: '授权或续跑连接失败，可在完整工作台查看。'}; }
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
const whisperInput = ref<HTMLInputElement>();
const whisperPill = ref<HTMLButtonElement>();
async function openWhisper() {
  whisperOpen.value = true;
  await nextTick();
  whisperInput.value?.focus();
}
async function closeWhisper() {
  whisperOpen.value = false;
  await nextTick();
  whisperPill.value?.focus({ preventScroll: true });
}
function onWhisperKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    void sendWhisper();
  } else if (event.key === 'Escape') void closeWhisper();
}
async function sendWhisper(retry?: FailedTurn) {
  const text = whisperText.value.trim();
  if (!text || sending.value) return;
  if (await sendTurn(text, 'whisper', retry) && whisperText.value.trim() === text) {
    whisperText.value = '';
    closeWhisper();
  }
}

async function retryTurn() {
  const failed = failedTurn.value;
  if (!failed || sending.value) return;
  const content = failed.source === 'whisper' ? whisperText.value.trim() : failed.content;
  if (content !== failed.content || failed.sessionId !== sessions.activeSessionId.value) {
    if (failed.source === 'whisper') await sendWhisper();
    else await sendTurn(content, failed.source);
    return;
  }
  sending.value = true; waitingForReply.value = true; turnFeedback.value = undefined;
  try {
    await turnController.retry(dialogueCallbacks(dialogueCtx.value));
    failedTurn.value = undefined;
    if (failed.source === 'whisper' && whisperText.value.trim() === failed.content) { whisperText.value = ''; closeWhisper(); }
  } catch (error) {
    if (error instanceof Error && error.message === 'submission_not_retryable') {
      sending.value = false;
      if (failed.source === 'whisper') await sendWhisper();
      else await sendTurn(failed.content, failed.source);
    } else if (!surface.signal.aborted) {
      turnFeedback.value = {kind: turnController.state.status === 'observer-error' ? 'observer-error' : 'connection-error', message: '连接失败，请稍后重试。'};
      if (turnController.state.status === 'observer-error') failedTurn.value = undefined;
    }
  } finally { sending.value = false; waitingForReply.value = false; }
}

/* ---------- 回到默认工作台（逃生口） ---------- */
function backToDefaultSurface() {
  try {
    localStorage.setItem('aervox.surface.main', 'workbench-ui');
  } catch { /* 存储不可用时忽略 */ }
  const target = new URL(window.location.href);
  target.searchParams.set('surface', 'workbench-ui');
  window.location.replace(target.toString());
}

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
  void sessions.fetchSessions();
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
});
onBeforeUnmount(() => {
  unsubscribeConversation(); turnController.dispose();
  finish();
  window.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('resize', syncViewport);
  window.visualViewport?.removeEventListener('scroll', syncViewport);
});
</script>

<template>
  <div
    class="proactive-companion"
    :class="{ 'pc-viewport--short': viewportHeight !== undefined && viewportHeight < 500 }"
    :data-platform="surface.platform"
    :style="{ '--pc-viewport-height': viewportHeight === undefined ? undefined : `${viewportHeight}px`, '--pc-viewport-top': `${viewportTop}px` }"
  >
    <header class="pc-header">
      <div class="pc-brand"><AervoxBrandMark class="pc-brand-mark" :size="28" aria-hidden="true" /><span>思隅</span></div>
      <div class="pc-top-right">
        <button class="pc-quiet-btn" type="button" title="设置" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="18" aria-hidden="true" /></button>
        <button class="pc-quiet-btn" type="button" title="回到完整工作台" aria-label="回到完整工作台" @click="backToDefaultSurface"><ArrowUpRight :size="19" aria-hidden="true" /></button>
      </div>
    </header>

    <main class="pc-content">
    <div class="pc-stage">
      <div class="pc-pet-wrap">
        <div class="pc-pet-status">伴学中</div>
        <PetWithFallback />
      </div>
    </div>

    <section class="pc-dialogue" aria-label="陪伴对话">
      <div class="pc-dialogue-name">{{ companionName }}</div>
      <div class="pc-dialogue-box">
        <p v-if="waitingForReply" class="pc-dialogue-waiting" role="status">
          <span class="pc-waiting-dots" aria-hidden="true"><i /><i /><i /></span>
          <span>正在等待回复…</span>
        </p>
        <p v-else class="pc-dialogue-text" aria-live="polite">{{ dialogueText }}<span v-if="dialogueTyping" class="pc-caret" aria-hidden="true" /></p>
        <div class="pc-dialogue-foot">
          <span class="pc-dialogue-ctx">{{ dialogueCtx }}</span>
        </div>
      </div>
      <div v-if="turnFeedback" class="pc-feedback" :data-kind="turnFeedback.kind" role="status">
        <span>{{ turnFeedback.message }}</span>
        <button
          v-if="failedTurn"
          type="button"
          class="pc-retry pc-feedback-action"
          :disabled="sending || (failedTurn.source === 'whisper' && !whisperText.trim())"
          @click="retryTurn"
        ><RotateCcw :size="14" aria-hidden="true" />重试发送</button>
        <button v-else-if="turnFeedback.kind === 'observer-error'" type="button" class="pc-workbench-link pc-feedback-action" @click="backToDefaultSurface"><ArrowUpRight :size="14" aria-hidden="true" />查看完整工作台</button>
        <button v-else-if="turnFeedback.kind === 'cancel-error' && sending" type="button" class="pc-retry pc-feedback-action" :disabled="stopping" @click="stopTurn">重试停止</button>
      </div>
    </section>

    <section v-if="conversationState.question" class="pc-interaction" aria-label="回答问题">
      <UserQuestionComposer :question-data="conversationState.question" :submitting="interactionBusy" @submit="answerQuestion" />
    </section>
    <section v-if="conversationState.approval" class="pc-interaction" aria-label="工具授权">
      <p>请求执行 {{ conversationState.approval.toolName }}，需要你的确认。</p>
      <button type="button" :disabled="interactionBusy || sending" @click="decideApproval('granted')">批准</button>
      <button type="button" :disabled="interactionBusy || sending" @click="decideApproval('denied')">拒绝</button>
    </section>

    <section v-if="!whisperOpen" class="pc-choices" aria-label="今日建议">
      <button
        v-for="card in suggestions"
        :key="card.key"
        type="button"
        class="pc-choice"
        :class="{ 'pc-choice--primary': card.primary }"
        :disabled="sending"
        @click="card.action"
      >
        <span class="pc-choice-label">{{ card.label }}</span>
        <span class="pc-choice-reason">{{ card.reason }}</span>
      </button>
    </section>
    </main>

    <aside class="pc-whisper" :class="{ 'pc-whisper--open': whisperOpen }" aria-label="对话输入">
      <template v-if="!whisperOpen">
        <button ref="whisperPill" type="button" class="pc-whisper-pill" @click="openWhisper"><MessageSquare :size="15" aria-hidden="true" /><span>悄悄对{{ companionName }}说…</span></button>
        <button v-if="sending" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn"><Square :size="12" aria-hidden="true" />{{ stopping ? '停止中' : '停止' }}</button>
      </template>
      <div v-else class="pc-whisper-input">
        <input
          ref="whisperInput"
          v-model="whisperText"
          :aria-label="'悄悄对' + companionName + '说'"
          :placeholder="'想到什么，直接告诉' + companionName"
          enterkeyhint="send"
          @keydown="onWhisperKeydown"
        />
        <button v-if="sending" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn"><Square :size="12" aria-hidden="true" />{{ stopping ? '停止中' : '停止' }}</button>
        <button v-else type="button" :disabled="!whisperText.trim()" @click="sendWhisper()">发送</button>
        <button type="button" class="pc-whisper-close" title="收起" aria-label="收起输入" @click="closeWhisper"><X :size="18" aria-hidden="true" /></button>
      </div>
    </aside>
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

/* 舞台跟随内容流，不覆盖对话和输入。 */
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
@media (max-height: 520px) {
  .pc-stage { display: none; }
  .pc-content {
    grid-template-columns: minmax(0, 1fr); grid-template-rows: none;
    grid-auto-rows: max-content; align-content: start; gap: 12px; padding-block: 8px 12px;
  }
  .pc-dialogue, .pc-choices { grid-column: auto; grid-row: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .pc-caret, .pc-waiting-dots i { animation: none; }
  .pc-choice, .pc-quiet-btn, .pc-whisper-pill, .pc-stop, .pc-feedback-action, .pc-whisper-input button { transition: none; }
}
</style>
