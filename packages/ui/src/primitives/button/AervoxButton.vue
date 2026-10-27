<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, type Component } from 'vue';
import './button.css';
import { useMaterial3 } from '../../material3/context';
import { bindMaterialButtonSemantics } from '../../material3/button-semantics';
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

const material3 = useMaterial3();
const materialTag = computed(() => props.iconOnly ? 'md-icon-button' : props.variant === 'primary' || props.variant === 'danger'
  ? 'md-filled-button' : props.variant === 'ghost' ? 'md-text-button' : 'md-filled-tonal-button');
const iconSlot = computed(() => material3 && !props.iconOnly ? 'icon' : undefined);
const button = ref<HTMLElement>();
let semantics: ReturnType<typeof bindMaterialButtonSemantics> | undefined;
let semanticsHost: HTMLElement | undefined;
function syncSemantics() {
  const host = material3 ? button.value : undefined;
  if (host !== semanticsHost) {
    semantics?.dispose();
    semanticsHost = host;
    semantics = host ? bindMaterialButtonSemantics(host) : undefined;
  }
  semantics?.sync();
}
onMounted(syncSemantics);
onUpdated(syncSemantics);
onBeforeUnmount(() => { semantics?.dispose(); });
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
  <component
    :is="material3 ? materialTag : 'button'"
    ref="button"
    :type="type"
    :trailing-icon="material3 && !iconOnly && iconRight ? true : undefined"
    data-aervox-button
    :class="material3 ? ['avx-material-button', { 'is-block': block, 'is-danger': variant === 'danger' }] : classes"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="handleClick"
  >
    <Loader2 v-if="loading" :size="size === 'sm' ? 12 : 14" :slot="iconSlot" class="btn-spinner" />
    <template v-else>
      <component
        :is="icon"
        v-if="icon && !iconRight"
        :size="size === 'sm' ? 13 : 15"
        :slot="iconSlot" class="btn-icon"
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
      :slot="iconSlot" class="btn-icon btn-icon--right"
    />
  </component>
</template>
