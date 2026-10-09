<script setup lang="ts">
import { BookOpen } from 'lucide-vue-next';
import { AervoxSwitch } from '@aervox/ui/primitives';
import { useFocusModeState } from './plugin-state';
const { focusModeEnabled, setFocusModeEnabled } = useFocusModeState();
</script>

<template>
  <label
    class="floating-study-switch-wrap"
    :class="{ on: focusModeEnabled }"
    :title="focusModeEnabled ? '专注模式已开启（点击关闭）' : '专注模式已关闭（点击开启）'"
  >
    <BookOpen :size="15" class="study-switch-icon" />
    <span class="study-switch-label">专注模式</span>
    <AervoxSwitch
      :model-value="focusModeEnabled"
      :aria-label="focusModeEnabled ? '关闭专注模式' : '开启专注模式'"
      @update:model-value="setFocusModeEnabled"
    />
  </label>
</template>
