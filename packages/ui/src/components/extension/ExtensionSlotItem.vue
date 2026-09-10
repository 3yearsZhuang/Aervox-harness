<script setup lang="ts">
import { onErrorCaptured } from 'vue';
import type { RegisteredSlotComponent } from '../../registry/types';

const props = defineProps<{
  item: RegisteredSlotComponent;
  context: Record<string, unknown>;
}>();

const emit = defineEmits<{
  (e: 'error', err: unknown): void;
}>();

onErrorCaptured((err, instance, info) => {
  console.error(`[ExtensionSlotItem:${props.item.id}] Error in injected extension component:`, err, info);
  emit('error', err);
  // 阻止错误继续向上传播以保证容器和主界面不受影响
  return false;
});
</script>

<template>
  <component
    :is="item.component"
    v-bind="{ ...context, ...item.props }"
    :data-extension-id="item.id"
  />
</template>
