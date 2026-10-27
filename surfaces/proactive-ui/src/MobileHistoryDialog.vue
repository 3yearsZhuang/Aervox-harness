<script setup lang="ts">
import { toRef } from 'vue';
import type { SessionHistoryMessage } from '@aervox/contracts';
import { useSessionHistory } from '@aervox/ui/companion';
import { renderMarkdown } from '@aervox/ui/markdown';
import { AervoxButton, AervoxDialog } from '@aervox/ui/primitives';
const props = defineProps<{ modelValue: boolean; sessionId: string; title: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const { page, limit, loading, error, atLatest, refresh, earlier } = useSessionHistory(toRef(props, 'modelValue'), toRef(props, 'sessionId'));
const states: Record<string, string> = { Created: '等待执行', Running: '执行中', CancelRequested: '正在取消', Completed: '已完成', Failed: '失败', Interrupted: '已中断', Cancelled: '已取消' };
function speaker(message: SessionHistoryMessage) {
  return message.contentKind === 'accepted_input' ? '本轮输入' : message.role === 'assistant' ? '思隅' : message.role === 'system' ? '系统记录' : '用户记录';
}
</script>

<template>
  <AervoxDialog :model-value="modelValue" title="对话回看" :subtitle="title" custom-class="mobile-history-dialog" body-max-height="calc(100dvh - 180px)" @update:model-value="emit('update:modelValue', $event)">
    <p class="mobile-history-note">这里只显示已保存的记录；回看不会切换会话或停止当前回复。</p>
    <div class="mobile-history-controls">
      <label>每页轮数<select v-model.number="limit" class="aervox-field" aria-label="历史每页轮数" :disabled="loading"><option v-for="count in [1, 5, 10, 20]" :key="count" :value="count">{{ count }}</option></select></label>
      <AervoxButton variant="ghost" :disabled="loading || !sessionId" @click="refresh">{{ atLatest ? '刷新记录' : '回到最新记录' }}</AervoxButton>
    </div>
    <div class="mobile-history-records" aria-label="已保存的对话记录" :aria-busy="loading">
      <p v-if="loading" role="status">正在读取对话记录…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <template v-else-if="page">
        <section v-for="turn in page.items" :key="turn.turnId" class="mobile-history-turn" :aria-label="`对话轮次 · ${states[turn.status] ?? turn.status}`">
          <p class="mobile-history-status">{{ states[turn.status] ?? turn.status }}<span v-if="!turn.isComplete"> · 未完成</span></p>
          <article v-for="message in turn.messages" :key="message.versionId" class="mobile-history-message">
            <p class="mobile-history-speaker">{{ speaker(message) }} <small>版本 {{ message.version }}<template v-if="message.readOnly"> · 只读记录</template></small></p>
            <p v-if="message.visibility === 'withheld'" class="mobile-history-note">这条记录当前不可显示。</p>
            <div v-else-if="message.role === 'assistant'" class="markdown-body" v-html="renderMarkdown(message.content || '（空记录）')" />
            <p v-else class="mobile-history-text">{{ message.content || '（空记录）' }}</p>
          </article>
          <p v-if="!turn.messages.length">这一轮暂无可显示的消息。</p>
        </section>
        <p v-if="!page.items.length">暂无可显示的记录。</p>
        <AervoxButton v-if="page.nextCursor" :disabled="loading" @click="earlier">更早一页</AervoxButton>
        <p v-else class="mobile-history-note">已到当前可读取记录的起点。</p>
      </template>
    </div>
  </AervoxDialog>
</template>

<style scoped>
.mobile-history-note, .mobile-history-status { color: var(--md-sys-color-on-surface-variant); font-size: 12px; line-height: 18px; }
.mobile-history-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-block: 16px; }
.mobile-history-controls label { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.mobile-history-controls select { min-width: 72px; }
.mobile-history-turn { margin-block: 20px; border-bottom: 1px solid var(--md-sys-color-outline-variant); }
.mobile-history-message { margin-block: 16px; padding: 12px 16px; border-radius: 16px; background: var(--md-sys-color-surface-container); overflow-wrap: anywhere; }
.mobile-history-speaker { margin: 0 0 8px; font-size: 14px; line-height: 20px; font-weight: 500; }
.mobile-history-speaker small { font-size: 12px; color: var(--md-sys-color-on-surface-variant); font-weight: 400; }
.mobile-history-text { margin: 0; white-space: pre-wrap; font-size: 16px; line-height: 24px; }
.mobile-history-records { min-width: 0; }
</style>
