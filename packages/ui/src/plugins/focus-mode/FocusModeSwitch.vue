<script setup lang="ts">
import { BookOpen } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout } = useWorkbenchContext();
const { focusModeEnabled, toggleFocusMode } = layout;
</script>

<template>
  <label
    class="floating-study-switch-wrap"
    :class="{ on: focusModeEnabled }"
    :title="focusModeEnabled ? '专注模式已开启（点击关闭）' : '专注模式已关闭（点击开启）'"
  >
    <BookOpen :size="15" class="study-switch-icon" />
    <span class="study-switch-label">专注模式</span>
    <button
      type="button"
      role="switch"
      class="study-switch-track"
      :class="{ active: focusModeEnabled }"
      :aria-checked="focusModeEnabled"
      :aria-label="focusModeEnabled ? '关闭专注模式' : '开启专注模式'"
      @click="toggleFocusMode"
    >
      <span class="study-switch-thumb" />
    </button>
  </label>
</template>
