<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue';
import type { ExtensionSlotName } from '../../registry/types';
import { useUIRegistry } from '../../registry/ui-registry';

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

const items = computed(() => {
  return registry.getSlotComponents(props.name).filter(
    (item) => !failedComponentIds.value.has(item.id),
  );
});

onErrorCaptured((err, instance, info) => {
  console.error(`[ExtensionSlot:${props.name}] Error in injected extension component:`, err, info);
  // 隔离错误，防止插件异常导致主应用崩溃
  return false;
});
</script>

<template>
  <div v-if="items.length > 0" :class="wrapperClass" :data-slot-name="name">
    <component
      :is="item.component"
      v-for="item in items"
      :key="item.id"
      v-bind="{ ...context, ...item.props }"
      :data-extension-id="item.id"
    />
  </div>
</template>
