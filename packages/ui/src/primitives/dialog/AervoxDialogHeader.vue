<script setup lang="ts">
import { type Component } from 'vue';
import { X } from 'lucide-vue-next';

withDefaults(
  defineProps<{
    title?: string;
    subtitle?: string;
    icon?: Component;
    showClose?: boolean;
  }>(),
  {
    title: '',
    subtitle: '',
    icon: undefined,
    showClose: true,
  },
);

const emit = defineEmits<{
  close: [];
}>();
</script>

<template>
  <div class="aervox-dialog-header">
    <div class="header-main">
      <span v-if="icon || $slots.icon" class="heading-icon-wrap">
        <slot name="icon">
          <component :is="icon" :size="18" />
        </slot>
      </span>
      <div class="header-text">
        <strong v-if="title || $slots.title">
          <slot name="title">{{ title }}</slot>
        </strong>
        <small v-if="subtitle || $slots.subtitle">
          <slot name="subtitle">{{ subtitle }}</slot>
        </small>
      </div>
    </div>
    <div class="header-actions">
      <slot name="actions" />
      <button
        v-if="showClose"
        type="button"
        class="dialog-close-btn"
        aria-label="关闭"
        @click="emit('close')"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.aervox-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.header-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.heading-icon-wrap {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
}

.header-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.header-text strong {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-text small {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dialog-close-btn {
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

.dialog-close-btn:hover {
  background: var(--border);
  color: var(--text-primary);
}
</style>
