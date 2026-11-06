<script setup lang="ts">
import { AervoxButton } from '../../primitives';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { conversation, layout } = useWorkbenchContext();
</script>

<template>
  <div class="conversation-history-status" :aria-busy="conversation.historyLoading?.value">
    <p v-if="conversation.historyLoading?.value" role="status">正在读取已保存的对话…</p>
    <p v-else-if="conversation.historyError?.value" role="alert">{{ conversation.historyError.value }}</p>
    <p v-else-if="conversation.historyNotice?.value" role="status">{{ conversation.historyNotice.value }}</p>
    <div v-if="conversation.historyEnabled" class="conversation-history-actions">
      <AervoxButton variant="ghost" size="sm" type="button" :disabled="conversation.historyLoading?.value || conversation.historyBlocked?.value" @click="conversation.refreshHistory()">刷新已保存记录</AervoxButton>
      <AervoxButton v-if="conversation.historyHasEarlier?.value" variant="ghost" size="sm" type="button" @click="layout.historyOpen.value = true">回看更早记录</AervoxButton>
    </div>
  </div>
</template>

<style scoped>
.conversation-history-status { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.conversation-history-status p { margin: 8px 0; }
.conversation-history-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
