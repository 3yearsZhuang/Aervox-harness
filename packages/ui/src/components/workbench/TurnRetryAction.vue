<script setup lang="ts">
import { AervoxButton } from '../../primitives';
import { useWorkbenchContext } from '../../composables/workbench-context';
const {conversation} = useWorkbenchContext();
</script>
<template>
  <AervoxButton v-if="conversation.retryAvailable?.value" variant="secondary" type="button" :disabled="conversation.streaming.value" @click="conversation.retrySubmission()">重试发送</AervoxButton>
</template>
