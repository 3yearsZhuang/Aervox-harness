<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue';
import { AervoxDialog } from '@aervox/ui/primitives';
import { useMaterial3 } from '@aervox/ui/material3';

const props = defineProps<{
  modelValue: boolean;
  panels: readonly { category: string; component: Component }[];
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const categories = [
  { id: 'model', label: '模型服务' },
  { id: 'persona', label: '角色' },
  { id: 'voice', label: '语音' },
];
const material3 = useMaterial3();
const selected = ref('model');
const available = computed(() => categories.filter(item => props.panels.some(panel => panel.category === item.id)));
watch(available, items => {
  if (items.length && !items.some(item => item.id === selected.value)) selected.value = items[0]!.id;
}, { immediate: true });
const activePanel = computed(() => props.panels.find(panel => panel.category === selected.value)?.component);
const activeTabIndex = computed(() => Math.max(0, available.value.findIndex(item => item.id === selected.value)));
function selectMaterialTab(event: Event) {
  const index = (event.target as HTMLElement & { activeTabIndex?: number }).activeTabIndex;
  if (typeof index !== 'number' || !Number.isInteger(index)) return;
  const item = available.value[index];
  if (item) selected.value = item.id;
}
</script>

<template>
  <AervoxDialog
    :model-value="modelValue"
    title="设置"
    size="md"
    body-max-height="calc(100dvh - 160px)"
    custom-class="mobile-settings-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <component
      v-if="material3 && available.length"
      :is="'md-tabs'"
      class="mobile-settings-material-tabs"
      role="tablist"
      aria-label="设置分类"
      :activeTabIndex.prop="activeTabIndex"
      @change="selectMaterialTab"
    >
      <component
        v-for="item in available"
        :is="'md-primary-tab'"
        :key="item.id"
        :id="'mobile-settings-tab-' + item.id"
        role="tab"
        :aria-selected="selected === item.id"
        :aria-controls="'mobile-settings-panel-' + item.id"
        @click="selected = item.id"
      >{{ item.label }}</component>
    </component>
    <nav v-else class="mobile-settings-tabs" aria-label="设置分类">
      <button
        v-for="item in available"
        :key="item.id"
        type="button"
        :aria-pressed="selected === item.id"
        @click="selected = item.id"
      >{{ item.label }}</button>
    </nav>
    <div :id="'mobile-settings-panel-' + selected" :role="material3 ? 'tabpanel' : undefined" :aria-labelledby="material3 ? 'mobile-settings-tab-' + selected : undefined" class="mobile-settings-panel">
      <KeepAlive>
        <component :is="activePanel" v-if="activePanel" :key="selected" />
      </KeepAlive>
    </div>
    <p v-if="!activePanel">当前宿主未提供此设置面板，可返回完整工作台进行配置。</p>
  </AervoxDialog>
</template>

<style scoped>
.mobile-settings-tabs { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
.mobile-settings-tabs button {
  min-height: 44px; padding: 0 16px; border: 1px solid var(--border); border-radius: 10px;
  font: inherit; color: var(--text-secondary); background: var(--bg-main); cursor: pointer;
}
.mobile-settings-tabs button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.mobile-settings-tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.mobile-settings-material-tabs {
  --md-tabs-container-color: var(--md-sys-color-surface-container-high);
  display: block; margin: -4px -4px 24px;
}
.mobile-settings-material-tabs md-primary-tab { min-height: 48px; }
.mobile-settings-panel { min-width: 0; }
</style>

<style>
.mobile-settings-dialog .dialog-close-btn { min-width: 44px; min-height: 44px; }
.mobile-settings-dialog .aervox-dialog-body { overflow: auto; overscroll-behavior: contain; }
.mobile-settings-dialog :is(input, textarea, select) { min-width: 0; font-size: 16px; }
.mobile-settings-dialog { overflow-wrap: anywhere; }
</style>
