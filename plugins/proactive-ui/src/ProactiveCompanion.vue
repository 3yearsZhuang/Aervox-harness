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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useUISurfaceContext } from '@aervox/ui-host';
import { PetWithFallback } from '@aervox/ui';
import { streamAervoxTurn, useAervoxSessions } from '@aervox/api-client';
import { useDialogueTyper } from './dialogue-typer';

const surface = useUISurfaceContext();
const sessions = useAervoxSessions();

/* ---------- 对话盒 ---------- */
const greeting = '你好，我是思隅。今天想继续昨天的进度，还是先安静专注一会儿？';
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
  action: () => Promise<void> | void;
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

async function sendTurn(content: string) {
  if (sending.value) return;
  sending.value = true;
  if (!sessions.activeSessionId.value) {
    await sessions.createNewSession();
  }
  say('', '你刚刚说');
  await streamAervoxTurn(content, {
    onDelta: (text) => appendDelta(text),
    onDone: () => {
      finish();
      dialogueCtx.value = '思隅 · 刚刚回复';
    },
    onError: (err) => {
      finish();
      say(`出了点小问题：${err instanceof Error ? err.message : '回复失败，请稍后再试'}`, '连接异常');
    },
  }, { signal: surface.signal });
  sending.value = false;
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
    reason: '番茄钟 · 到点思隅提醒你',
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
function openWhisper() {
  whisperOpen.value = true;
}
function closeWhisper() {
  whisperOpen.value = false;
}
async function sendWhisper() {
  const text = whisperText.value.trim();
  if (!text) return;
  whisperText.value = '';
  closeWhisper();
  await sendTurn(text);
}

/* ---------- 回到默认工作台（逃生口） ---------- */
function backToDefaultSurface() {
  try {
    localStorage.setItem('aervox.surface.main', 'workbench-ui');
  } catch { /* 存储不可用时忽略 */ }
  window.location.reload();
}

onMounted(() => {
  void sessions.fetchSessions();
});
onBeforeUnmount(() => {
  finish();
});
</script>

<template>
  <div class="proactive-companion" :data-platform="surface.platform">
    <header class="pc-header">
      <div class="pc-brand"><span class="pc-brand-mark">思</span>思隅</div>
      <div class="pc-top-right">
        <button class="pc-quiet-btn" type="button" title="回到完整工作台" @click="backToDefaultSurface">⇱</button>
      </div>
    </header>

    <main class="pc-stage">
      <div class="pc-pet-wrap">
        <div class="pc-pet-status">伴学中</div>
        <PetWithFallback />
      </div>
    </main>

    <section class="pc-dialogue" aria-live="polite">
      <div class="pc-dialogue-name">思隅</div>
      <div class="pc-dialogue-box">
        <p class="pc-dialogue-text">{{ dialogueText }}<span v-if="dialogueTyping" class="pc-caret" /></p>
        <div class="pc-dialogue-foot">
          <span class="pc-dialogue-ctx">{{ dialogueCtx }}</span>
        </div>
      </div>
    </section>

    <section class="pc-choices" aria-label="今日建议">
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

    <aside class="pc-whisper" :class="{ 'pc-whisper--open': whisperOpen }">
      <button v-if="!whisperOpen" type="button" class="pc-whisper-pill" @click="openWhisper">✎&nbsp;&nbsp;悄悄对思隅说…</button>
      <div v-else class="pc-whisper-input">
        <input
          v-model="whisperText"
          placeholder="想到什么，直接告诉思隅"
          @keydown.enter="sendWhisper"
        />
        <button type="button" :disabled="sending" @click="sendWhisper">发送</button>
        <button type="button" class="pc-whisper-close" title="收起" @click="closeWhisper">✕</button>
      </div>
    </aside>
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
  inset: 0;
  background:
    radial-gradient(46% 40% at 42% 62%, rgba(47, 91, 208, .05), transparent 70%),
    var(--pc-bg);
  color: var(--pc-ink);
  font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
}
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

/* 顶栏：只剩品牌与一个逃生口 */
.pc-header {
  position: absolute; inset: 0 0 auto 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 24px;
}
.pc-brand { display: flex; align-items: center; gap: 9px; font-size: 13.5px; font-weight: 600; letter-spacing: .02em; }
.pc-brand-mark {
  width: 22px; height: 22px; border-radius: 7px; background: var(--pc-ink);
  color: var(--pc-bg); display: grid; place-items: center; font-size: 11px; font-weight: 700;
}
.pc-quiet-btn {
  width: 32px; height: 32px; border: 0; background: transparent; border-radius: 8px;
  color: var(--pc-ink-3); cursor: pointer; font-size: 15px;
}
.pc-quiet-btn:hover { color: var(--pc-ink); background: rgba(128, 134, 146, .12); }

/* 舞台：桌宠是绝对主角 */
.pc-stage {
  position: absolute; inset: 0;
  display: grid; place-items: center;
  pointer-events: none;
}
.pc-pet-wrap {
  position: relative;
  width: min(300px, 34vw);
  height: min(400px, 52vh);
  transform: translate(-14vw, -5vh);
  pointer-events: auto;
}
.pc-pet-status {
  position: absolute; top: -30px; left: 50%; transform: translateX(-50%);
  font-size: 11px; color: var(--pc-ink-3); letter-spacing: .12em; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
}
.pc-pet-status::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #35a06f; }

/* 对话盒 */
.pc-dialogue {
  position: absolute; left: 50%; bottom: 176px; transform: translateX(-50%);
  width: min(620px, calc(100vw - 48px)); z-index: 5;
}
.pc-dialogue-name {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 11.5px; font-weight: 600; letter-spacing: .22em; color: var(--pc-ink-2);
  margin-bottom: 10px; margin-left: 4px;
}
.pc-dialogue-name::after { content: ""; width: 28px; height: 1px; background: var(--pc-line); }
.pc-dialogue-box {
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  padding: 20px 24px 18px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04), 0 12px 40px -12px rgba(23, 24, 26, .1);
}
.pc-dialogue-text { font-size: 15px; line-height: 1.85; min-height: 56px; white-space: pre-wrap; }
.pc-caret {
  display: inline-block; width: 2px; height: 1em; background: var(--pc-ink-3);
  vertical-align: -2px; margin-left: 2px; animation: pc-caret-blink 1s steps(1) infinite;
}
@keyframes pc-caret-blink { 50% { opacity: 0; } }
.pc-dialogue-foot {
  display: flex; justify-content: space-between; align-items: center;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--pc-line-soft);
}
.pc-dialogue-ctx { font-size: 11px; color: var(--pc-ink-3); letter-spacing: .04em; }

/* 两张建议卡 */
.pc-choices {
  position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%);
  width: min(620px, calc(100vw - 48px));
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px; z-index: 5;
  transition: opacity .2s var(--pc-ease), transform .2s var(--pc-ease);
}
.pc-whisper--open ~ .pc-choices, .pc-choices.pc-choices--hidden { opacity: 0; pointer-events: none; transform: translate(-50%, 8px); }
.pc-choice {
  text-align: left; cursor: pointer; font-family: inherit;
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  padding: 14px 18px 13px; color: var(--pc-ink);
  transition: transform .18s var(--pc-ease), border-color .18s, box-shadow .18s;
  display: flex; flex-direction: column;
}
.pc-choice:hover:not(:disabled) { transform: translateY(-2px); border-color: rgba(128, 134, 146, .4); box-shadow: 0 8px 24px -10px rgba(23, 24, 26, .14); }
.pc-choice:disabled { opacity: .55; cursor: default; }
.pc-choice-label { font-size: 13.5px; font-weight: 600; letter-spacing: .02em; }
.pc-choice-reason { font-size: 11.5px; color: var(--pc-ink-3); margin-top: 5px; line-height: 1.5; }
.pc-choice--primary { border-color: color-mix(in srgb, var(--pc-accent) 40%, transparent); background: linear-gradient(180deg, var(--pc-accent-soft), transparent 60%), var(--pc-card); }
.pc-choice--primary .pc-choice-label { color: var(--pc-accent); }
.pc-choice--primary .pc-choice-label::before { content: "◆"; font-size: 8px; margin-right: 8px; }

/* 悄悄话药丸 */
.pc-whisper { position: absolute; right: 24px; bottom: 30px; z-index: 6; }
.pc-whisper-pill {
  display: flex; align-items: center; gap: 7px;
  border: 1px solid var(--pc-line); background: var(--pc-card); border-radius: 999px;
  padding: 9px 16px; font-size: 12px; color: var(--pc-ink-3); cursor: text; font-family: inherit;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04);
}
.pc-whisper-pill:hover { color: var(--pc-ink-2); border-color: rgba(128, 134, 146, .4); }
.pc-whisper--open { left: 50%; right: auto; transform: translateX(-50%); width: min(620px, calc(100vw - 48px)); bottom: 36px; }
.pc-whisper-input {
  display: flex; width: 100%; align-items: center; gap: 10px;
  background: var(--pc-card); border: 1px solid var(--pc-line); border-radius: var(--pc-radius);
  padding: 12px 14px;
  box-shadow: 0 1px 2px rgba(23, 24, 26, .04), 0 12px 40px -12px rgba(23, 24, 26, .12);
}
.pc-whisper-input input {
  flex: 1; border: 0; outline: 0; font: inherit; font-size: 13.5px;
  color: var(--pc-ink); background: transparent;
}
.pc-whisper-input button {
  border: 0; background: var(--pc-ink); color: var(--pc-bg); border-radius: 8px;
  padding: 6px 16px; font-size: 12px; cursor: pointer; font-family: inherit;
}
.pc-whisper-input button:disabled { opacity: .5; cursor: default; }
.pc-whisper-close { background: transparent !important; color: var(--pc-ink-3) !important; padding: 4px 8px !important; }

/* 输入展开时建议卡让位 */
.proactive-companion:has(.pc-whisper--open) .pc-choices { opacity: 0; pointer-events: none; transform: translate(-50%, 8px); }

@media (max-width: 720px) {
  .pc-pet-wrap { transform: translate(0, -14vh) scale(.8); }
  .pc-choices { grid-template-columns: 1fr; }
  .pc-dialogue { bottom: 224px; }
}
</style>
