<script setup lang="ts">
/**
 * Aervox｜思隅 @aervox/ui — 桌宠（Fairy 精灵）结构组件
 *
 * 只承载 DOM 骨架；视觉由共享样式 packages/ui/src/theme/hero.css
 * （原样取自桌面 story.css 的 .hero-*，唯一事实源）提供，两端 import '@aervox/ui' 即共用。
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

/* ---- PET-01 表情/动作最小视觉类（CSS transform，不侵入 hero.css） ---- */
.pet-hero > *,
.pet-hero .hero-head,
.pet-hero .hero-head > * {
  transition: transform 0.15s ease;
}

/* 表情：眼睛/嘴形变换 */
.emote-happy .hero-mouth,
.emote-cheer .hero-mouth {
  transform: translateY(-2px) scaleY(1.2);
}
.emote-sad .hero-eye {
  transform: scaleY(1.3) translateY(-1px);
}
.emote-sad .hero-mouth {
  transform: rotate(180deg) scaleY(0.6) translateY(2px);
}
.emote-surprise .hero-mouth {
  transform: scale(1.5);
}
.emote-surprise .hero-eye {
  transform: scale(1.3);
}
.emote-think .hero-head {
  transform: rotate(-8deg);
}
.emote-worry .hero-head {
  transform: rotate(6deg) translateY(1px);
}

/* 动作：肢体变换 */
.gesture-wave .wing-right {
  transform: rotate(-18deg) translateY(-10px);
}
.gesture-nod .hero-head {
  animation: pet-nod 0.5s ease;
}
.gesture-shake .hero-head {
  animation: pet-shake 0.4s ease;
}
.gesture-stretch .hero-body {
  transform: scaleY(1.06);
}
.gesture-yawn .hero-mouth {
  transform: scaleY(2.4);
}

@keyframes pet-nod {
  0%,
  100% {
    transform: rotate(0);
  }
  50% {
    transform: rotate(-10deg);
  }
}
@keyframes pet-shake {
  0%,
  100% {
    transform: rotate(0);
  }
  25% {
    transform: rotate(-6deg);
  }
  75% {
    transform: rotate(6deg);
  }
}

/* 文本气泡（aria-live，弱视觉） */
.emote-bubble {
  position: absolute;
  top: -18px;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
}
</style>