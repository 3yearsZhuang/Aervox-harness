<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

const props = withDefaults(defineProps<{ modelValue?: boolean; checked?: boolean; disabled?: boolean }>(), {
  modelValue: undefined, checked: false, disabled: false,
});
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; change: [event: Event] }>();
const input = ref<HTMLInputElement | null>(null);
const enabled = computed(() => props.modelValue ?? props.checked ?? false);
function onChange(event: Event) {
  if (props.disabled) return;
  emit('update:modelValue', (event.target as HTMLInputElement).checked);
  emit('change', event);
  // Controlled authorization switches reflect the accepted state, including a declined request.
  void nextTick(() => { if (input.value) input.value.checked = enabled.value; });
}
</script>

<template>
  <input ref="input" class="aervox-switch" type="checkbox" role="switch" :checked="enabled" :disabled="disabled" @change="onChange" />
</template>

<style scoped>
.aervox-switch.aervox-switch {
  appearance: none;
  display: inline-block;
  position: relative;
  width: 40px;
  height: 24px;
  min-width: 40px;
  min-height: 24px;
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-hover);
  cursor: pointer;
  vertical-align: middle;
  transition: background-color 160ms ease, border-color 160ms ease;
}
.aervox-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-secondary); transition: transform 160ms ease, background-color 160ms ease; }
.aervox-switch:checked { background: var(--accent); border-color: var(--accent); }
.aervox-switch:checked::after { transform: translateX(16px); background: var(--bg-main); }
.aervox-switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.aervox-switch:disabled { opacity: 0.45; cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) { .aervox-switch, .aervox-switch::after { transition: none; } }
</style>
