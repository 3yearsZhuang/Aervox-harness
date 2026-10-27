<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useMobileBackNavigation, type MobileBackLayer } from './mobile-back-navigation';
defineOptions({ inheritAttrs: false });

const props = withDefaults(defineProps<{
  modelValue: boolean; title: string; width: string; height?: string;
  appendToBody?: boolean; destroyOnClose?: boolean;
  closeOnClickModal?: boolean; closeOnPressEscape?: boolean;
}>(), { appendToBody: true, destroyOnClose: false, closeOnClickModal: true, closeOnPressEscape: true });
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; open: []; opened: []; close: []; closed: [] }>();
const dialog = ref<HTMLElement & { open: boolean }>();
const keepContent = ref(props.modelValue);
let backdropClick = false;
let backdropTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let nativeClosing = false;
const backNavigation = useMobileBackNavigation();
let backLayer: MobileBackLayer | undefined;
watch(() => props.modelValue, open => {
  if (open && !backLayer) backLayer = backNavigation?.registerLayer({
    onBack: () => { emit('update:modelValue', false); },
    canDismiss: () => props.closeOnPressEscape,
  });
  else if (!open) { backLayer?.close(); backLayer = undefined; }
}, { immediate: true });
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
  if (event.key === 'Escape' && !props.closeOnPressEscape) event.preventDefault();
}
function onClick(event: MouseEvent) {
  const target = event.composedPath()[0];
  // Material dispatches backdrop cancel synchronously from its shadow <dialog>.
  // CloseWatcher/system Back has no keydown and must use the Escape/Back policy.
  backdropClick = target instanceof HTMLElement && target.tagName === 'DIALOG'
    && target.getRootNode() === dialog.value?.shadowRoot;
  if (backdropTimer) clearTimeout(backdropTimer);
  backdropTimer = setTimeout(() => { backdropClick = false; }, 0);
}
function onCancel(event: Event) {
  const allowed = backdropClick ? props.closeOnClickModal : props.closeOnPressEscape;
  backdropClick = false;
  if (!allowed) event.preventDefault();
}
function onClose() { nativeClosing = true; emit('update:modelValue', false); emit('close'); }
function onClosed() {
  nativeClosing = false;
  if (props.modelValue && dialog.value) dialog.value.open = true;
  if (props.destroyOnClose && !props.modelValue) keepContent.value = false;
  emit('closed');
}
onBeforeUnmount(() => { backLayer?.dispose(); backLayer = undefined; disposed = true; motion?.removeEventListener('change', updateMotion); if (backdropTimer) clearTimeout(backdropTimer); });
</script>

<template>
  <Teleport to="body" :disabled="!appendToBody">
    <component :is="'md-dialog'" ref="dialog" :quick="reducedMotion" v-bind="$attrs" class="avx-material-dialog" :aria-label="title"
      :style="{ width, height: height || undefined }"
      @keydown.capture="onKeydown" @click.capture="onClick" @cancel="onCancel" @open="emit('open')" @opened="emit('opened')"
      @close="onClose" @closed="onClosed"
    >
      <div v-if="keepContent" slot="headline" class="avx-material-dialog-headline" :aria-label="title"><slot name="header" /></div>
      <div v-if="keepContent" slot="content" class="avx-material-dialog-content"><slot /></div>
      <div v-if="keepContent && $slots.footer" slot="actions" class="avx-material-dialog-actions"><slot name="footer" /></div>
    </component>
  </Teleport>
</template>
