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
import { PetWithFallback, readCompanionIdentity } from '@aervox/ui';
import { getTransport, useAervoxSessions } from '@aervox/api-client';
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
let activeTurn: { controller: AbortController; turnId?: string; stopRequested: boolean; cancelSent: boolean } | undefined;

async function cancelActiveTurn(turn: NonNullable<typeof activeTurn>) {
  if (!turn.turnId || turn.cancelSent) return;
  turn.cancelSent = true;
  try {
    await getTransport().request('POST', `/v1/turns/${encodeURIComponent(turn.turnId)}/cancel`, {}, { signal: surface.signal });
    turn.controller.abort();
    if (activeTurn === turn && !surface.signal.aborted) {
      finish();
      dialogueCtx.value = '已停止回复';
    }
  } catch (err) {
    turn.cancelSent = false;
    turn.stopRequested = false;
    if (activeTurn === turn && !surface.signal.aborted) {
      dialogueCtx.value = `停止失败：${err instanceof Error ? err.message : '请重试'}`;
    }
  } finally {
    if (activeTurn === turn) stopping.value = false;
  }
}

async function stopTurn() {
  const turn = activeTurn;
  if (!turn || stopping.value) return;
  stopping.value = true;
  turn.stopRequested = true;
  // Stop before acceptance still cancels the accepted server turn once its id arrives.
  if (turn.turnId) await cancelActiveTurn(turn);
}

function reportConnectionError(err: unknown) {
  if (surface.signal.aborted) return;
  finish();
  dialogueCtx.value = '连接异常';
  say(`出了点小问题：${err instanceof Error ? err.message : '回复失败，请稍后再试'}`, '连接异常');
}

async function sendTurn(content: string) {
  if (sending.value || surface.signal.aborted) return false;
  sending.value = true;
  const turn = { controller: new AbortController(), stopRequested: false, cancelSent: false, turnId: undefined as string | undefined };
  activeTurn = turn;
  const signal = AbortSignal.any([surface.signal, turn.controller.signal]);
  function identifyTurn(turnId: string) {
    turn.turnId ??= turnId;
    if (turn.stopRequested) return cancelActiveTurn(turn);
  }
  try {
    if (!sessions.sessions.value.some(session => session.id === sessions.activeSessionId.value)) {
      await sessions.createNewSession();
    }
    signal.throwIfAborted();
    if (turn.stopRequested) {
      dialogueCtx.value = '已停止回复';
      return false;
    }
    const sessionId = sessions.activeSessionId.value;
    say('', '你刚刚说');
    dialogueCtx.value = '正在回复';
    await getTransport().streamTurn(sessionId, content, {
      onTurnIdentified: identifyTurn,
      onDelta: text => { if (activeTurn === turn && !signal.aborted) appendDelta(text); },
      onDone: () => {
        if (activeTurn !== turn || signal.aborted) return;
        finish();
        dialogueCtx.value = companionName.value + ' · 刚刚回复';
      },
      onError: err => { throw err; },
    }, { signal, onAccepted: identifyTurn, metadata: { ...identity } });
    return !signal.aborted;
  } catch (err) {
    if (activeTurn === turn && !signal.aborted) reportConnectionError(err);
    return false;
  } finally {
    if (activeTurn === turn) {
      activeTurn = undefined;
      sending.value = false;
      stopping.value = false;
    }
  }
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
async function sendWhisper() {
  const text = whisperText.value.trim();
  if (!text || sending.value) return;
  if (await sendTurn(text) && whisperText.value.trim() === text) {
    whisperText.value = '';
    closeWhisper();
  }
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
  void sessions.fetchSessions();
  syncViewport();
  window.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
});
onBeforeUnmount(() => {
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
      <div class="pc-brand"><span class="pc-brand-mark">思</span>思隅</div>
      <div class="pc-top-right">
        <button class="pc-quiet-btn" type="button" title="设置" aria-label="打开设置" @click="settingsOpen = true">⚙</button>
        <button class="pc-quiet-btn" type="button" title="回到完整工作台" aria-label="回到完整工作台" @click="backToDefaultSurface">⇱</button>
      </div>
    </header>

    <main class="pc-content">
    <div class="pc-stage">
      <div class="pc-pet-wrap">
        <div class="pc-pet-status">伴学中</div>
        <PetWithFallback />
      </div>
    </div>

    <section class="pc-dialogue" aria-live="polite">
      <div class="pc-dialogue-name">{{ companionName }}</div>
      <div class="pc-dialogue-box">
        <p class="pc-dialogue-text">{{ dialogueText }}<span v-if="dialogueTyping" class="pc-caret" /></p>
        <div class="pc-dialogue-foot">
          <span class="pc-dialogue-ctx">{{ dialogueCtx }}</span>
        </div>
      </div>
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
        <button ref="whisperPill" type="button" class="pc-whisper-pill" @click="openWhisper">✎&nbsp;&nbsp;悄悄对{{ companionName }}说…</button>
        <button v-if="sending" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn">{{ stopping ? '停止中' : '停止' }}</button>
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
        <button v-if="sending" type="button" class="pc-stop" :disabled="stopping" @click="stopTurn">{{ stopping ? '停止中' : '停止' }}</button>
        <button v-else type="button" :disabled="!whisperText.trim()" @click="sendWhisper">发送</button>
        <button type="button" class="pc-whisper-close" title="收起" aria-label="收起输入" @click="closeWhisper">✕</button>
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
  --pc-ink-3: #9aa0a8;
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
  --pc-ink-3: #6b7484;
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
  width: 22px; height: 22px; flex: 0 0 22px; border-radius: 7px; background: var(--pc-ink);
  color: var(--pc-bg); display: grid; place-items: center; font-size: 11px; font-weight: 700;
}
.pc-quiet-btn {
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
.pc-choice--primary .pc-choice-label::before { content: "◆"; font-size: 8px; margin-right: 8px; }

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
.pc-stop { min-width: 44px; min-height: 44px; margin-left: 8px; border: 1px solid var(--pc-line); border-radius: 10px; background: var(--pc-card); color: var(--pc-ink); font: inherit; cursor: pointer; }
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
.pc-whisper-input button {
  flex: 0 0 auto; min-width: 44px; min-height: 44px;
  border: 0; background: var(--pc-ink); color: var(--pc-bg); border-radius: 8px;
  padding: 8px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.pc-whisper-input button:disabled { opacity: .5; cursor: default; }
.pc-whisper-close { background: transparent !important; color: var(--pc-ink-3) !important; padding: 8px !important; }
.pc-quiet-btn:focus-visible,
.pc-choice:focus-visible,
.pc-whisper-pill:focus-visible,
.pc-whisper-input button:focus-visible { outline: 2px solid var(--pc-accent); outline-offset: 3px; }
.pc-whisper-input:focus-within { border-color: var(--pc-accent); }

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
  .pc-caret { animation: none; }
  .pc-choice { transition: none; }
}
</style>
