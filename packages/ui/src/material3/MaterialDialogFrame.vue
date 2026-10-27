<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  modelValue: boolean; title: string; width: string; height?: string;
  appendToBody?: boolean; destroyOnClose?: boolean;
  closeOnClickModal?: boolean; closeOnPressEscape?: boolean;
}>(), { appendToBody: true, destroyOnClose: false, closeOnClickModal: true, closeOnPressEscape: true });
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; open: []; opened: []; close: []; closed: [] }>();
const dialog = ref<HTMLElement & { open: boolean }>();
const keepContent = ref(props.modelValue);
let escape = false;
let escapeTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let nativeClosing = false;
const reducedMotion = ref(false);
let motion: MediaQueryList | undefined;
const updateMotion = () => { reducedMotion.value = motion?.matches ?? false; };
onMounted(() => {
  motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  updateMotion();
  motion.addEventListener('change', updateMotion);
});
watch(() => props.modelValue, async open => {
  if (open) keepContent.value = true;
  await nextTick();
  if (!disposed && dialog.value && !nativeClosing) dialog.value.open = props.modelValue;
}, { immediate: true });
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  escape = true;
  if (escapeTimer) clearTimeout(escapeTimer);
  escapeTimer = setTimeout(() => { escape = false; }, 0);
  if (!props.closeOnPressEscape) event.preventDefault();
}
function onCancel(event: Event) {
  if (escape ? !props.closeOnPressEscape : !props.closeOnClickModal) event.preventDefault();
}
function onClose() { nativeClosing = true; emit('update:modelValue', false); emit('close'); }
function onClosed() {
  nativeClosing = false;
  if (props.modelValue && dialog.value) dialog.value.open = true;
  if (props.destroyOnClose && !props.modelValue) keepContent.value = false;
  emit('closed');
}
onBeforeUnmount(() => { disposed = true; motion?.removeEventListener('change', updateMotion); if (escapeTimer) clearTimeout(escapeTimer); });
</script>

<template>
  <Teleport to="body" :disabled="!appendToBody">
    <component :is="'md-dialog'" ref="dialog" :quick="reducedMotion" v-bind="$attrs" class="avx-material-dialog" :aria-label="title"
      :style="{ width, height: height || undefined }"
      @keydown.capture="onKeydown" @cancel="onCancel" @open="emit('open')" @opened="emit('opened')"
      @close="onClose" @closed="onClosed"
    >
      <div v-if="keepContent" slot="headline" class="avx-material-dialog-headline" :aria-label="title"><slot name="header" /></div>
      <div v-if="keepContent" slot="content" class="avx-material-dialog-content"><slot /></div>
      <div v-if="keepContent && $slots.footer" slot="actions" class="avx-material-dialog-actions"><slot name="footer" /></div>
    </component>
  </Teleport>
</template>
