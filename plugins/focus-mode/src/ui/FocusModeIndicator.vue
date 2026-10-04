<script setup lang="ts">
import { focusModeEnabled, toggleFocusMode } from './plugin-state';

/**
 * 输入区模式指示器（插件自有）。
 *
 * CR-060：宿主 Composer 只提供 `composer:indicator` 通用插槽，
 * 标记的文案、样式与交互全部归插件。
 */
</script>

<template>
  <button
    v-if="focusModeEnabled"
    type="button"
    class="composer-mode-chip"
    title="专注模式已开启（点击关闭）"
    @click.stop="toggleFocusMode"
  >
    专注模式
  </button>
</template>
