<script setup lang="ts">
/**
 * 思隅·素简文档（方向 G 落地，minimalist-ui 语言）——主界面替代根组件。
 *
 * 与 proactive-ui 同一信息结构（对话盒 + 双主动建议卡 + 悄悄话输入），
 * 设计语言换成暖纸文档式：桌宠收为小像边栏，建议条目化（编号 + 理由 + 箭头），
 * 全平无阴影，唯一色彩是主建议左侧的灰绿条。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useUISurfaceContext } from '@aervox/ui-host';
import { PetWithFallback, readCompanionIdentity } from '@aervox/ui';
import { streamAervoxTurn, useAervoxSessions } from '@aervox/api-client';
import { useDialogueTyper } from './dialogue-typer';

const surface = useUISurfaceContext();
const sessions = useAervoxSessions();

const identity = readCompanionIdentity();
const companionName = ref(identity.companionName);
const greeting = '你好' + (identity.userAddress === '你' ? '' : '，' + identity.userAddress) + '，我是' + identity.companionName + '。今天想继续昨天的进度，还是先安静专注一会儿？';
const dialogueCtx = ref(companionName.value + ' · 每日开场');
const { shown: dialogueText, streaming: dialogueTyping, say, appendDelta, finish } = useDialogueTyper(greeting);

interface Suggestion {
  key: string;
  label: string;
  reason: string;
  primary: boolean;
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

function reportConnectionError(err: unknown) {
  if (surface.signal.aborted) return;
  finish();
  dialogueCtx.value = '连接异常';
  say(`出了点小问题：${err instanceof Error ? err.message : '回复失败，请稍后再试'}`, '连接异常');
}

async function sendTurn(content: string) {
  if (sending.value || surface.signal.aborted) return false;
  sending.value = true;
  try {
    if (!sessions.sessions.value.some(session => session.id === sessions.activeSessionId.value)) {
      await sessions.createNewSession();
    }
    surface.signal.throwIfAborted();
    const sessionId = sessions.activeSessionId.value;
    say('', '你刚刚说');
    await streamAervoxTurn(content, {
      onDelta: text => { if (!surface.signal.aborted) appendDelta(text); },
      onDone: () => {
        if (surface.signal.aborted) return;
        finish();
        dialogueCtx.value = companionName.value + ' · 刚刚回复';
      },
      onError: err => { throw err; },
    }, { signal: surface.signal, sessionId, metadata: { ...identity } });
    return !surface.signal.aborted;
  } catch (err) {
    reportConnectionError(err);
    return false;
  } finally {
    sending.value = false;
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
    action: () => sendTurn('我想专注 25 分钟，帮我开始一个番茄钟。'),
  });
  if (list.length === 1) {
    list.unshift({
      key: 'first-goal',
      label: '定下今天的学习目标',
      reason: '还没有学习记录 · 从一句目标开始',
      primary: true,
      action: () => sendTurn('今天我想开始学习一个新的目标，帮我拆解第一步。'),
    });
  }
  return list.slice(0, 2);
});

const whisperOpen = ref(false);
const whisperText = ref('');
function openWhisper() {
  whisperOpen.value = true;
}
function closeWhisper() {
  whisperOpen.value = false;
}
async function sendWhisper() {
  const text = whisperText.value.trim();
  if (!text || sending.value) return;
  if (await sendTurn(text) && whisperText.value.trim() === text) {
    whisperText.value = '';
    closeWhisper();
  }
}

function backToDefaultSurface() {
  try {
    localStorage.setItem('aervox.surface.main', 'workbench-ui');
  } catch { /* 存储不可用时忽略 */ }
  const target = new URL(window.location.href);
  target.searchParams.delete('surface');
  window.location.replace(target.toString());
}

onMounted(() => {
  void sessions.fetchSessions();
});
onBeforeUnmount(() => {
  finish();
});
</script>

<template>
  <div class="document-companion" :data-platform="surface.platform">
    <header class="dc-header">
      <div class="dc-brand">思隅<span class="dc-brand-sub">伴学文档</span></div>
      <button class="dc-quiet" type="button" title="回到完整工作台" @click="backToDefaultSurface">工作台</button>
    </header>

    <div class="dc-page">
      <div class="dc-doc">
        <aside class="dc-side">
          <div class="dc-pet"><PetWithFallback /></div>
          <div class="dc-name">{{ companionName }}</div>
          <div class="dc-status">伴学中</div>
        </aside>
        <section class="dc-main">
          <div class="dc-who">{{ companionName }} · 今日建议</div>
          <p class="dc-dialogue" aria-live="polite">{{ dialogueText }}<span v-if="dialogueTyping" class="dc-caret" /></p>
          <div class="dc-ctx">{{ dialogueCtx }}</div>
          <div class="dc-choices">
            <button
              v-for="(card, i) in suggestions"
              :key="card.key"
              type="button"
              class="dc-choice"
              :class="{ 'dc-choice--primary': card.primary }"
              :disabled="sending"
              @click="card.action"
            >
              <span class="dc-choice-no">0{{ i + 1 }}</span>
              <span class="dc-choice-label">{{ card.label }}</span>
              <span class="dc-choice-arrow">→</span>
              <span class="dc-choice-reason">{{ card.reason }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>

    <aside class="dc-whisper" :class="{ 'dc-whisper--open': whisperOpen }">
      <button v-if="!whisperOpen" type="button" class="dc-whisper-pill" @click="openWhisper">对{{ companionName }}说…</button>
      <div v-else class="dc-whisper-input">
        <input
          v-model="whisperText"
          :placeholder="'想到什么，直接告诉' + companionName"
          @keydown.enter="sendWhisper"
        />
        <button type="button" :disabled="sending" @click="sendWhisper">发送</button>
        <button type="button" class="dc-whisper-close" title="收起" @click="closeWhisper">✕</button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* 方向 G：暖单色文档风。全平、无阴影、唯一色彩是主建议的灰绿条。 */
.document-companion {
  --dc-bg: #f4f2ee;
  --dc-ink: #1b1a17;
  --dc-ink-2: #55514a;
  --dc-ink-3: #98918a;
  --dc-line: rgba(27, 26, 23, .12);
  --dc-card: #fbfaf7;
  --dc-sage: #a8b8a0;
  --dc-sage-ink: #4c5d49;
  --dc-ease: cubic-bezier(.22, 1, .36, 1);

  position: fixed;
  inset: 0;
  background: var(--dc-bg);
  color: var(--dc-ink);
  font-family: "Avenir Next", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
:root[data-theme="dark"] .document-companion {
  --dc-bg: #1c1b18;
  --dc-ink: #eae7e0;
  --dc-ink-2: #b3aea2;
  --dc-ink-3: #716c61;
  --dc-line: rgba(234, 231, 224, .14);
  --dc-card: #23221e;
  --dc-sage: #8fa587;
  --dc-sage-ink: #b7c9b0;
}

.dc-header {
  position: absolute; inset: 0 0 auto 0; z-index: 10;
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 26px 36px;
}
.dc-brand { font-size: 15px; font-weight: 700; letter-spacing: .04em; }
.dc-brand-sub { color: var(--dc-ink-3); font-weight: 400; font-size: 12px; margin-left: 10px; }
.dc-quiet { border: 0; background: none; color: var(--dc-ink-3); font-size: 12px; cursor: pointer; font-family: inherit; }
.dc-quiet:hover { color: var(--dc-ink); }

.dc-page { position: absolute; inset: 0; display: grid; place-items: center; padding: 96px 36px 40px; }
.dc-doc {
  width: min(880px, 100%);
  display: grid; grid-template-columns: 220px 1fr; gap: 56px; align-items: start;
}

/* 桌宠小像边栏 */
.dc-side { text-align: center; padding-top: 8px; }
.dc-pet { width: 150px; height: 202px; margin: 0 auto; }
.dc-name { margin-top: 18px; font-size: 13px; font-weight: 700; letter-spacing: .3em; }
.dc-status { margin-top: 8px; font-size: 11px; color: var(--dc-ink-3); line-height: 1.7; }

.dc-who { font-size: 11px; letter-spacing: .28em; color: var(--dc-sage-ink); margin-bottom: 16px; }
.dc-dialogue { font-size: 17px; line-height: 2; min-height: 100px; white-space: pre-wrap; }
.dc-caret {
  display: inline-block; width: 2px; height: 1em; background: var(--dc-sage-ink);
  vertical-align: -2px; margin-left: 2px; animation: dc-blink 1.1s steps(1) infinite;
}
@keyframes dc-blink { 50% { opacity: 0; } }
.dc-ctx { margin-top: 14px; font-size: 11px; color: var(--dc-ink-3); }

/* 文档条目式建议卡 */
.dc-choices { margin-top: 44px; border-top: 1px solid var(--dc-line); transition: opacity .2s var(--dc-ease); }
.dc-choice {
  width: 100%; display: grid; grid-template-columns: 40px 1fr auto; gap: 18px; align-items: baseline;
  text-align: left; cursor: pointer; font-family: inherit;
  background: transparent; border: 0; border-bottom: 1px solid var(--dc-line);
  padding: 18px 4px; color: var(--dc-ink);
  transition: background .2s var(--dc-ease), padding-left .25s var(--dc-ease);
  position: relative;
}
.dc-choice:hover:not(:disabled) { background: var(--dc-card); padding-left: 14px; }
.dc-choice:disabled { opacity: .55; cursor: default; }
.dc-choice-no { font-size: 11px; color: var(--dc-ink-3); letter-spacing: .1em; }
.dc-choice-label { font-size: 15px; font-weight: 600; }
.dc-choice-arrow { color: var(--dc-ink-3); font-size: 13px; }
.dc-choice-reason { grid-column: 2; font-size: 11.5px; color: var(--dc-ink-3); margin-top: 2px; }
.dc-choice--primary::before {
  content: ""; position: absolute; left: -4px; top: 14px; bottom: 14px; width: 3px;
  background: var(--dc-sage); border-radius: 2px;
}
.dc-choice--primary .dc-choice-label { color: var(--dc-sage-ink); }

/* 悄悄话 */
.dc-whisper { position: absolute; right: 36px; bottom: 32px; z-index: 6; }
.dc-whisper-pill {
  border: 1px solid var(--dc-line); background: var(--dc-card); border-radius: 999px;
  padding: 8px 16px; font-size: 12px; color: var(--dc-ink-3); cursor: text; font-family: inherit;
}
.dc-whisper-pill:hover { color: var(--dc-ink); }
.dc-whisper--open { left: 50%; right: auto; transform: translateX(-50%); width: min(560px, calc(100vw - 48px)); bottom: 30px; }
.dc-whisper-input {
  display: flex; align-items: center; gap: 12px;
  background: var(--dc-card); border: 1px solid var(--dc-line); border-radius: 10px; padding: 12px 16px;
}
.dc-whisper-input input {
  flex: 1; min-width: 0; border: 0; outline: 0; font: inherit; font-size: 13.5px;
  color: var(--dc-ink); background: transparent;
}
.dc-whisper-input button {
  border: 0; background: var(--dc-ink); color: var(--dc-bg); border-radius: 6px;
  padding: 7px 18px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.dc-whisper-input button:disabled { opacity: .5; }
.dc-whisper-close { background: transparent !important; color: var(--dc-ink-3) !important; padding: 4px 8px !important; }
.document-companion:has(.dc-whisper--open) .dc-choices { opacity: 0; pointer-events: none; }

@media (max-width: 760px) {
  .dc-doc { grid-template-columns: 1fr; gap: 28px; }
  .dc-side { display: flex; align-items: center; gap: 18px; text-align: left; }
  .dc-pet { width: 84px; height: 112px; margin: 0; flex-shrink: 0; }
  .dc-name { margin-top: 0; }
  .dc-page { overflow-y: auto; }
}
</style>
