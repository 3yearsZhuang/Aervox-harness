<script setup lang="ts">
/**
 * 紧凑工作台（多根界面试验田，CR-065 切片六）：复用完整工作台根，
 * 以 variant="compact" 强制单栏标准模式——无侧栏、无模式切换、聚焦当前对话。
 * 所有 props / 事件 / 注入（platform、plugins、settingsPanels 等）原样透传。
 */
import AervoxWorkbench from './AervoxWorkbench.vue';

defineOptions({ inheritAttrs: false });
</script>

<template>
  <AervoxWorkbench v-bind="$attrs" variant="compact" />
</template>
