<script setup lang="ts">
import { AervoxButton } from '../../primitives';
import { useWorkbenchContext } from '../../composables/workbench-context';
const {conversation} = useWorkbenchContext();
</script>
<template>
  <p v-if="conversation.turnState.value.status === 'observer-error'" role="status">连接中断，已保留收到的回复。</p>
  <AervoxButton v-if="conversation.retryAvailable.value" variant="secondary" type="button" :disabled="conversation.streaming.value" @click="conversation.retrySubmission()">{{ conversation.retryLabel.value }}</AervoxButton>
</template>
