<script setup lang="ts">
import { type Component } from 'vue';

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: Component;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options: readonly SegmentedOption[];
  label: string;
  variant?: 'options' | 'tabs';
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

function handleKeydown(event: KeyboardEvent, value: string) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const enabled = props.options.filter(option => !option.disabled);
  if (!enabled.length) return;
  const index = enabled.findIndex(option => option.value === value);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
  emit('update:modelValue', enabled[next]!.value);
  const container = (event.currentTarget as HTMLElement).parentElement;
  container?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')[next]?.focus();
}
</script>

<template>
  <div class="aervox-segmented" :class="{ 'is-tabs': variant === 'tabs' }" role="group" :aria-label="label">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :disabled="option.disabled"
      :aria-pressed="modelValue === option.value"
      :class="{ active: modelValue === option.value }"
      @click="emit('update:modelValue', option.value)"
      @keydown="handleKeydown($event, option.value)"
    >
      <component :is="option.icon" v-if="option.icon" :size="15" />
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.aervox-segmented {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft);
  width: fit-content;
  max-width: 100%;
}
.aervox-segmented button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1 0 auto;
  min-height: 36px;
  padding: 7px 12px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease;
}
.aervox-segmented button:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
.aervox-segmented button.active { color: var(--text-primary); background: var(--bg-main); border-color: var(--border); }
.aervox-segmented button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.aervox-segmented button:disabled { opacity: 0.5; cursor: not-allowed; }
.aervox-segmented.is-tabs { padding: 0; gap: 20px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; width: 100%; }
.aervox-segmented.is-tabs button { flex: 0 0 auto; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 10px 0; background: transparent; }
.aervox-segmented.is-tabs button.active { border-bottom-color: var(--text-primary); color: var(--text-primary); }
.aervox-segmented.is-tabs button svg { display: none; }
@media (pointer: coarse) { .aervox-segmented button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .aervox-segmented button { transition: none; } }
</style>
