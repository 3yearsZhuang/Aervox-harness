<script setup lang="ts">
import { BookOpen, Settings } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout } = useWorkbenchContext();
const { isWeb, studyModeEnabled, toggleStudyMode, settingsOpen } = layout;
</script>

<template>
  <div class="floating-top-actions">
    <ExtensionSlot name="header:before" />
    <label
      class="floating-study-switch-wrap"
      :class="{ on: studyModeEnabled }"
      :title="studyModeEnabled ? '专注模式已开启（点击关闭）' : '专注模式已关闭（点击开启）'"
    >
      <BookOpen :size="15" class="study-switch-icon" />
      <span class="study-switch-label">专注模式</span>
      <button
        type="button"
        role="switch"
        class="study-switch-track"
        :class="{ active: studyModeEnabled }"
        :aria-checked="studyModeEnabled"
        :aria-label="studyModeEnabled ? '关闭专注模式' : '开启专注模式'"
        @click="toggleStudyMode"
      >
        <span class="study-switch-thumb" />
      </button>
    </label>

    <ExtensionSlot name="header:actions" />

    <button v-if="isWeb" class="floating-settings" type="button" aria-label="打开设置" @click="settingsOpen = true">
      <Settings :size="19" />
    </button>
  </div>
</template>
