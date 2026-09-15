<script setup lang="ts">
import { type Component } from 'vue';
import AervoxDialog from './AervoxDialog.vue';

export interface NavDialogItem {
  id: string;
  label: string;
  description?: string;
  icon?: Component;
  badge?: string | number;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    subtitle?: string;
    icon?: Component;
    items?: NavDialogItem[];
    activeKey: string;
    width?: string;
    height?: string;
    navAriaLabel?: string;
    contentCentered?: boolean;
    showClose?: boolean;
    customClass?: string;
  }>(),
  {
    title: '',
    subtitle: '',
    icon: undefined,
    items: () => [],
    width: 'min(860px, calc(100vw - 28px))',
    height: 'min(640px, calc(100vh - 48px))',
    navAriaLabel: '分类导航',
    contentCentered: false,
    showClose: true,
    customClass: '',
  },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  'update:activeKey': [key: string];
  change: [key: string];
  close: [];
  closed: [];
  open: [];
}>();

function selectItem(id: string) {
  if (id !== props.activeKey) {
    emit('update:activeKey', id);
    emit('change', id);
  }
}
</script>

<template>
  <AervoxDialog
    :model-value="modelValue"
    :title="title"
    :subtitle="subtitle"
    :icon="icon"
    :width="width"
    :height="height"
    :show-close="showClose"
    size="lg"
    :custom-class="[customClass, 'aervox-nav-dialog'].filter(Boolean).join(' ')"
    body-max-height="none"
    no-padding
    @update:model-value="emit('update:modelValue', $event)"
    @close="emit('close')"
    @closed="emit('closed')"
    @open="emit('open')"
  >
    <template v-if="$slots.header" #header>
      <slot name="header" />
    </template>

    <div class="aervox-nav-layout">
      <nav class="aervox-nav-sidebar" :aria-label="navAriaLabel">
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="nav-sidebar-item"
          :class="{ active: item.id === activeKey }"
          :aria-current="item.id === activeKey ? 'true' : undefined"
          @click="selectItem(item.id)"
        >
          <slot name="nav-item" :item="item" :active="item.id === activeKey">
            <component :is="item.icon" v-if="item.icon" :size="18" class="nav-item-icon" />
            <span class="nav-item-text">
              <strong>{{ item.label }}</strong>
              <small v-if="item.description">{{ item.description }}</small>
            </span>
            <span v-if="item.badge !== undefined" class="nav-item-badge">{{ item.badge }}</span>
          </slot>
        </button>
        <slot name="nav-footer" />
      </nav>

      <section class="aervox-nav-detail" :class="{ 'content-centered': contentCentered }">
        <slot name="content" :active-key="activeKey" />
        <slot />
      </section>
    </div>

    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </AervoxDialog>
</template>

<style scoped>
.aervox-nav-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100%;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background: var(--bg-main, #fcfdfe);
}

.aervox-nav-sidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 12px;
  border-right: 1px solid var(--border);
  background: var(--bg-soft, #f2f4f8);
  overflow-y: auto;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.nav-sidebar-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 9px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all 0.18s ease;
  user-select: none;
}

.nav-sidebar-item:hover {
  background: var(--bg-input, rgba(0, 0, 0, 0.04));
  color: var(--text-primary);
}

.nav-sidebar-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}

.nav-item-icon {
  flex-shrink: 0;
}

.nav-item-text {
  display: grid;
  gap: 1px;
  min-width: 0;
  flex: 1;
}

.nav-item-text strong {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
}

.nav-item-text small {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-sidebar-item.active .nav-item-text small {
  color: color-mix(in srgb, var(--accent) 80%, black);
}

.nav-item-badge {
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  background: var(--border);
  color: var(--text-secondary);
}

.aervox-nav-detail {
  padding: 20px 24px 32px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  background: var(--bg-main, #fcfdfe);
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong, var(--border)) transparent;
}

.aervox-nav-detail.content-centered {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

@media (max-width: 680px) {
  .aervox-nav-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
  .aervox-nav-sidebar {
    height: auto;
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 8px;
  }
  .nav-sidebar-item {
    width: auto;
    white-space: nowrap;
  }
  .nav-item-text small {
    display: none;
  }
}
</style>
