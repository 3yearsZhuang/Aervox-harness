<script setup lang="ts">
import { computed, type Component } from 'vue';
import './button.css';
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
    iconOnly?: boolean;
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    disabled: false,
    loading: false,
    iconRight: false,
    block: false,
    iconOnly: false,
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
    'is-icon-only': props.iconOnly,
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
