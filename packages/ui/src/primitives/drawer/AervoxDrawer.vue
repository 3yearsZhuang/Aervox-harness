<script setup lang="ts">
import { onUnmounted, watch, type Component } from 'vue';
import { X } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    icon?: Component;
    width?: string;
    placement?: 'right' | 'left';
    showClose?: boolean;
    noPadding?: boolean;
    lockScroll?: boolean;
    ariaLabel?: string;
    teleportTo?: string;
  }>(),
  {
    title: '',
    icon: undefined,
    width: '440px',
    placement: 'right',
    showClose: true,
    noPadding: false,
    lockScroll: true,
    ariaLabel: '抽屉面板',
    teleportTo: 'body',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  close: [];
}>();

function close() {
  emit('update:modelValue', false);
  emit('close');
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.modelValue) {
    e.stopPropagation();
    close();
  }
}

let prevOverflow = '';
let isLocked = false;

function applyScrollLock(lock: boolean) {
  if (!props.lockScroll || typeof document === 'undefined') return;
  if (lock) {
    if (!isLocked) {
      prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      isLocked = true;
    }
  } else if (isLocked) {
    document.body.style.overflow = prevOverflow;
    isLocked = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      applyScrollLock(true);
      window.addEventListener('keydown', handleKeydown);
    } else {
      applyScrollLock(false);
      window.removeEventListener('keydown', handleKeydown);
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  applyScrollLock(false);
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport :to="teleportTo">
    <Transition name="aervox-drawer-fade">
      <div
        v-if="modelValue"
        class="aervox-drawer-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="ariaLabel"
        @click.self="close"
      >
        <div
          class="aervox-drawer-panel"
          :class="`placement-${placement}`"
          :style="{ width, maxWidth: 'calc(100vw - 32px)' }"
        >
          <header v-if="$slots.header || title" class="drawer-header">
            <slot name="header">
              <div class="drawer-title">
                <component :is="icon" v-if="icon" :size="17" class="drawer-icon" />
                <span>{{ title }}</span>
              </div>
              <button
                v-if="showClose"
                type="button"
                class="drawer-close-btn"
                aria-label="关闭"
                @click="close"
              >
                <X :size="17" />
              </button>
            </slot>
          </header>

          <div class="drawer-body" :class="{ 'is-no-padding': noPadding }">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="drawer-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.aervox-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.aervox-drawer-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-main, #fcfdfe);
  box-shadow: 0 0 32px rgba(0, 0, 0, 0.22);
  box-sizing: border-box;
}

.placement-right {
  margin-left: auto;
  border-left: 1px solid var(--border);
}

.placement-left {
  margin-right: auto;
  border-right: 1px solid var(--border);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.drawer-icon {
  color: var(--accent);
}

.drawer-close-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.drawer-close-btn:hover {
  background: var(--border);
  color: var(--text-primary);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong, var(--border)) transparent;
}

.drawer-body.is-no-padding {
  padding: 0;
  display: flex;
  flex-direction: column;
}

.drawer-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
}

/* 过渡动画 */
.aervox-drawer-fade-enter-active,
.aervox-drawer-fade-leave-active {
  transition: opacity 0.24s ease;
}

.aervox-drawer-fade-enter-active .placement-right,
.aervox-drawer-fade-leave-active .placement-right {
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
}

.aervox-drawer-fade-enter-from,
.aervox-drawer-fade-leave-to {
  opacity: 0;
}

.aervox-drawer-fade-enter-from .placement-right,
.aervox-drawer-fade-leave-to .placement-right {
  transform: translateX(100%);
}

.aervox-drawer-fade-enter-from .placement-left,
.aervox-drawer-fade-leave-to .placement-left {
  transform: translateX(-100%);
}
</style>
