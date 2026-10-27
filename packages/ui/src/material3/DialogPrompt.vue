<script setup lang="ts">
import { ref } from 'vue';
import AervoxDialog from '../primitives/dialog/AervoxDialog.vue';
import AervoxButton from '../primitives/button/AervoxButton.vue';
import type { DialogPromptAction, DialogPromptOptions } from './dialog-prompts';
const props = defineProps<{ id: string; kind: 'confirm' | 'prompt'; title: string; message: string; options: DialogPromptOptions }>();
const emit = defineEmits<{ answer: [action: DialogPromptAction, value: string]; closed: [] }>();
const open = ref(true), value = ref(props.options.inputValue ?? ''), error = ref('');
let answered = false;
function answer(action: DialogPromptAction) {
  if (answered) return;
  answered = true; open.value = false; emit('answer', action, value.value);
}
function confirm() {
  if (props.kind === 'prompt') {
    const pattern = props.options.inputPattern;
    if (pattern && !new RegExp(pattern.source, pattern.flags).test(value.value)) {
      error.value = props.options.inputErrorMessage || '输入不合法'; return;
    }
    try {
      const result = props.options.inputValidator?.(value.value);
      if (result === false || typeof result === 'string') {
        error.value = typeof result === 'string' ? result : props.options.inputErrorMessage || '输入不合法'; return;
      }
    } catch { error.value = props.options.inputErrorMessage || '无法验证输入，请重试'; return; }
  }
  answer('confirm');
}
function enter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault(); confirm();
}
defineExpose({ dismiss: () => answer('close') });
</script>

<template>
  <AervoxDialog :model-value="open" :title="title" size="sm" custom-class="avx-dialog-prompt"
    :close-on-click-modal="options.closeOnClickModal !== false" :close-on-press-escape="options.closeOnPressEscape !== false"
    @update:model-value="visible => { if (!visible) answer('close'); }" @closed="emit('closed')">
    <p :id="id + '-message'">{{ message }}</p>
    <input v-if="kind === 'prompt'" v-model="value" class="aervox-field" autofocus :aria-label="title"
      :aria-describedby="id + '-message' + (error ? ' ' + id + '-error' : '')" :aria-invalid="Boolean(error)"
      :placeholder="options.inputPlaceholder" @input="error = ''" @keydown.enter="enter" />
    <p v-if="error" :id="id + '-error'" class="avx-dialog-prompt-error" role="alert">{{ error }}</p>
    <template #footer>
      <AervoxButton variant="secondary" @click="answer('cancel')">{{ options.cancelButtonText ?? '取消' }}</AervoxButton>
      <AervoxButton variant="primary" @click="confirm">{{ options.confirmButtonText ?? '确定' }}</AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
p { overflow-wrap: anywhere; font-size: 16px; line-height: 24px; }
input { width: 100%; min-width: 0; min-height: 48px; box-sizing: border-box; }
.avx-dialog-prompt-error { color: var(--md-sys-color-error); }
</style>
