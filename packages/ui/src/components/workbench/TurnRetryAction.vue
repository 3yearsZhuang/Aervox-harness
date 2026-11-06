<script setup lang="ts">
import { AervoxButton } from '../../primitives';
import { computed } from 'vue';
import { useWorkbenchContext } from '../../composables/workbench-context';
const {conversation} = useWorkbenchContext();
const belongsToView = computed(() => {
  if (!conversation.historyEnabled) return true;
  const state = conversation.turnState.value;
  if (state.turnId) return conversation.story.value.some(line => line.turnId === state.turnId);
  // A retryable unknown receipt retains its local owner. A definite rejection
  // owns only its live error line, never another session's saved projection.
  return state.retryAvailable === true
    || conversation.story.value.some(line => line.state === 'error' && !line.readOnly);
});
</script>
<template>
  <template v-if="belongsToView">
    <p v-if="conversation.turnState.value.status === 'observer-error'" role="status">连接中断，已保留收到的回复。</p>
    <p v-else-if="conversation.turnState.value.status === 'failed' && conversation.turnState.value.turnId" role="status">本次回复未完成，已保留收到的内容。</p>
    <p v-else-if="conversation.turnState.value.error" role="alert">请求未完成，请重试。</p>
    <AervoxButton v-if="conversation.retryAvailable.value" variant="secondary" type="button" :disabled="conversation.streaming.value" @click="conversation.retrySubmission()">{{ conversation.retryLabel.value }}</AervoxButton>
  </template>
</template>
