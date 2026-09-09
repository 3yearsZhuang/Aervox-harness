<script setup lang="ts">
import type { ExtractedTerm } from '@aervox/contracts';
import TermExploreDialog from '../plugins/study-mode/TermExploreDialog.vue';

defineProps<{
  modelValue: boolean;
  term: ExtractedTerm | null;
  contextText?: string;
  sessionId?: string;
}>();

defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();
</script>

<template>
  <TermExploreDialog
    :model-value="modelValue"
    :term="term"
    :context-text="contextText"
    :session-id="sessionId"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>
