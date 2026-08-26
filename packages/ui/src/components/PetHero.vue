<script setup lang="ts">
/**
 * Aervox｜思隅 @aervox/ui — 桌宠（Fairy 精灵）结构组件
 *
 * 只承载 DOM 骨架；视觉由共享样式 packages/ui/src/theme/hero.css 提供。
 * Electron 与共享工作台 import '@aervox/ui' 后共用同一表现层。
 * 尺寸缩放请在使用端以 transform:scale 包裹组件；浮动动画/点击交互属壳层，由使用端负责。
 *
 * PET-01 表现：本组件可通过 activeEmote / activeGesture props 表达表情与肢体动作
 * （枚举见 @aervox/contracts petEmoteSchema / petGestureSchema），
 * 视觉由本组件 scoped style 中最小化的 transform 类驱动，不侵入 hero.css。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    activeEmote?: string;
    activeGesture?: string;
  }>(),
  {
    activeEmote: undefined,
    activeGesture: undefined,
  },
);

const rootClasses = computed(() => [
  'pet-hero',
  `emote-${props.activeEmote ?? 'idle'}`,
  ...(props.activeGesture ? [`gesture-${props.activeGesture}`] : []),
]);
</script>

<template>
  <div class="pet-hero" role="img" aria-label="Aervox 桌宠" :class="rootClasses">
    <span
      v-if="activeEmote && activeEmote !== 'idle'"
      class="emote-bubble"
      aria-live="polite"
    >
      {{ activeEmote }}
    </span>
    <span class="hero-wing wing-left" />
    <span class="hero-wing wing-right" />
    <span class="hero-head">
      <span class="hero-ear ear-left" />
      <span class="hero-ear ear-right" />
      <span class="hero-hair">⌁</span>
      <span class="hero-eye eye-left" />
      <span class="hero-eye eye-right" />
      <span class="hero-cheek cheek-left" />
      <span class="hero-cheek cheek-right" />
      <span class="hero-mouth">⌣</span>
    </span>
    <span class="hero-body"><span class="hero-collar" /></span>
    <span class="hero-foot foot-left" />
    <span class="hero-foot foot-right" />
  </div>
</template>

<style scoped>
.pet-hero {
  position: relative;
  width: 178px;
  height: 240px;
}
</style>
