<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue';
import type { ExtensionSlotName } from '../../registry/types';
import { useUIRegistry } from '../../registry/ui-registry';
import ExtensionSlotItem from './ExtensionSlotItem.vue';

const props = withDefaults(
  defineProps<{
    name: ExtensionSlotName;
    context?: Record<string, unknown>;
    wrapperClass?: string;
  }>(),
  {
    context: () => ({}),
    wrapperClass: 'aervox-extension-slot',
  },
);

const registry = useUIRegistry();
const failedComponentIds = ref<Set<string>>(new Set());

const allItems = computed(() => {
  return registry.getSlotComponents(props.name);
});

function handleComponentError(id: string, err: unknown) {
  console.warn(`[ExtensionSlot:${props.name}] Component "${id}" failed and has been isolated:`, err);
  const next = new Set(failedComponentIds.value);
  next.add(id);
  failedComponentIds.value = next;
}

onErrorCaptured((err, instance, info) => {
  console.error(`[ExtensionSlot:${props.name}] Fallback error capture:`, err, info);
  return false;
});
</script>

<template>
  <div v-if="allItems.length > 0" :class="wrapperClass" :data-slot-name="name">
    <template v-for="item in allItems" :key="item.id">
      <div
        v-if="failedComponentIds.has(item.id)"
        class="extension-slot-fallback"
        :data-failed-extension-id="item.id"
      >
        <slot name="fallback" :item="item">
          <!-- 降级占位符：轻量提醒并隔离，避免白屏与重复报错 -->
          <span class="extension-fallback-badge" :title="`插件组件 [${item.id}] 执行异常已隔离`">
            ⚠️ [插件 {{ item.id }} 异常]
          </span>
        </slot>
      </div>
      <ExtensionSlotItem
        v-else
        :item="item"
        :context="context"
        @error="(err) => handleComponentError(item.id, err)"
      />
    </template>
  </div>
</template>

