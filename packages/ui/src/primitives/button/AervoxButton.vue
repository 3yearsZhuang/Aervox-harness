<script setup lang="ts">
import { computed, type Component } from 'vue';
import { Loader2 } from 'lucide-vue-next';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant;
    size?: ButtonSize;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    icon?: Component;
    iconRight?: boolean;
    block?: boolean;
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    iconRight: false,
    block: false,
  },
);

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const classes = computed(() => [
  'aervox-btn',
  `aervox-btn--${props.variant}`,
  `aervox-btn--${props.size}`,
  {
    'is-loading': props.loading,
    'is-disabled': props.disabled || props.loading,
    'is-block': props.block,
  },
]);

function handleClick(e: MouseEvent) {
  if (props.disabled || props.loading) {
    e.preventDefault();
    return;
  }
  emit('click', e);
}
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="handleClick"
  >
    <Loader2 v-if="loading" :size="size === 'sm' ? 12 : 14" class="btn-spinner" />
    <template v-else>
      <component
        :is="icon"
        v-if="icon && !iconRight"
        :size="size === 'sm' ? 13 : 15"
        class="btn-icon"
      />
      <slot name="icon" />
    </template>
    <span v-if="$slots.default" class="btn-text">
      <slot />
    </span>
    <component
      :is="icon"
      v-if="icon && iconRight && !loading"
      :size="size === 'sm' ? 13 : 15"
      class="btn-icon btn-icon--right"
    />
  </button>
</template>

<style scoped>
.aervox-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 8px;
  font-family: inherit;
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  text-decoration: none;
  box-sizing: border-box;
}

.aervox-btn.is-block {
  display: flex;
  width: 100%;
}

/* 尺寸变体 */
.aervox-btn--sm {
  padding: 4px 10px;
  font-size: 11px;
  border-radius: 6px;
}

.aervox-btn--md {
  padding: 7px 14px;
  font-size: 12px;
  border-radius: 8px;
}

.aervox-btn--lg {
  padding: 10px 18px;
  font-size: 14px;
  border-radius: 10px;
}

/* 风格变体 */
.aervox-btn--primary {
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.aervox-btn--primary:hover:not(.is-disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.12);
}

.aervox-btn--primary:active:not(.is-disabled) {
  filter: brightness(0.95);
  transform: translateY(0);
}

.aervox-btn--secondary {
  background: var(--bg-main, #fcfdfe);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.aervox-btn--secondary:hover:not(.is-disabled) {
  background: var(--bg-hover, #e9edf4);
  border-color: var(--border-strong, var(--border));
  transform: translateY(-1px);
}

.aervox-btn--secondary:active:not(.is-disabled) {
  transform: translateY(0);
}

.aervox-btn--danger {
  background: var(--danger);
  color: #fff;
  border: 1px solid var(--danger);
}

.aervox-btn--danger:hover:not(.is-disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.aervox-btn--ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
}

.aervox-btn--ghost:hover:not(.is-disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 禁用与加载态 */
.aervox-btn.is-disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none !important;
}

.btn-spinner {
  animation: aervox-spin 0.9s linear infinite;
}

.btn-icon {
  flex-shrink: 0;
}

.btn-text {
  display: inline-block;
}

@keyframes aervox-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
