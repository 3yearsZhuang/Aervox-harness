<script setup lang="ts">
import { History, RefreshCw } from 'lucide-vue-next';
import type { SessionHistoryMessage } from '@aervox/contracts';
import { useWorkbenchContext } from '../../../composables/workbench-context';
import { useSessionHistory } from '../../../composables/useSessionHistory';
import { renderMarkdown } from '../../../utils/markdown';
import { AervoxButton, AervoxDrawer } from '../../../primitives';

const { layout, sessions } = useWorkbenchContext();
const { companionDisplayName, historyOpen } = layout;
const { page, limit, loading, error, atLatest, refresh, earlier } = useSessionHistory(historyOpen, sessions.activeSessionId);
const labels: Record<string, string> = {
  Created: '等待执行', Running: '执行中', CancelRequested: '正在取消',
  Completed: '已完成', Failed: '失败', Interrupted: '已中断', Cancelled: '已取消',
};
function speaker(message: SessionHistoryMessage) {
  if (message.contentKind === 'accepted_input') return '本轮输入';
  if (message.role === 'assistant') return companionDisplayName.value;
  return message.role === 'system' ? '系统记录' : '用户记录';
}
</script>

<template>
  <AervoxDrawer v-model="historyOpen" title="对话回看" :icon="History" width="480px" aria-label="对话回看" no-padding>
    <div class="history-controls">
      <label>每页轮数
        <select v-model.number="limit" aria-label="历史每页轮数" :disabled="loading">
          <option v-for="count in [1, 5, 10, 20]" :key="count" :value="count">{{ count }}</option>
        </select>
      </label>
      <AervoxButton variant="ghost" size="sm" :icon="RefreshCw" :disabled="loading || !sessions.activeSessionId.value" @click="refresh">
        {{ atLatest ? '刷新最新记录' : '回到最新记录' }}
      </AervoxButton>
    </div>
    <div class="vn-history-list" aria-label="已保存的对话记录" :aria-busy="loading">
      <p v-if="loading" role="status">正在读取对话记录…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <template v-else-if="page">
        <section v-for="turn in page.items" :key="turn.turnId" class="history-turn" :aria-label="`对话轮次 · ${labels[turn.status] ?? turn.status}`">
          <p class="history-turn-status">{{ labels[turn.status] ?? turn.status }}<span v-if="!turn.isComplete"> · 未完成</span></p>
          <p v-for="message in turn.messages" :key="message.versionId" class="vn-history-line" :class="message.role">
            <span class="vn-history-speaker">{{ speaker(message) }} <small v-if="message.readOnly">只读记录</small></span>
            <span v-if="message.visibility === 'withheld'" class="vn-history-text history-withheld">这条记录当前不可显示。</span>
            <span v-else class="vn-history-text">
              <span v-if="message.role === 'assistant'" class="markdown-body" v-html="renderMarkdown(message.content || '（空记录）')" />
              <template v-else>{{ message.content || '（空记录）' }}</template>
            </span>
          </p>
          <p v-if="!turn.messages.length" class="history-turn-status">这一轮暂无可显示的消息。</p>
        </section>
        <p v-if="!page.items.length" class="vn-history-empty">这一页暂无可显示的对话记录。</p>
        <AervoxButton v-if="page.nextCursor" variant="secondary" class="history-earlier" @click="earlier">更早一页</AervoxButton>
        <p v-else class="history-page-end">已到当前可读取记录的起点。</p>
      </template>
      <p v-else class="vn-history-empty">请先选择一段对话。</p>
    </div>
    <template #footer>
      每次显示一页已保存的记录；发送中的回复可能尚未保存，刷新可更新。Esc 或点击空白处关闭。
    </template>
  </AervoxDrawer>
</template>

<style scoped>
.history-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--border); }
.history-controls label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.history-controls select { padding: 5px 8px; color: var(--text-primary); background: var(--bg-main); border: 1px solid var(--border); border-radius: 6px; }
.history-turn { display: grid; gap: 16px; }
.history-turn + .history-turn { padding-top: 18px; border-top: 1px solid var(--border); }
.history-turn-status, .history-page-end { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.vn-history-speaker small { font-weight: 400; letter-spacing: normal; }
.history-withheld { color: var(--text-muted); }
.history-earlier { align-self: center; }
</style>
