<script setup lang="ts">
/**
 * Aervox｜思隅 @aervox/ui — 桌宠（Fairy 精灵）结构组件
 *
 * 只承载 DOM 骨架；视觉由共享样式 packages/ui/src/theme/hero.css
 * （原样取自桌面 story.css 的 .hero-*，唯一事实源）提供，两端 import '@aervox/ui' 即共用。
 * 尺寸缩放请在使用端以 transform:scale 包裹组件；浮动动画/点击交互属壳层，由使用端负责。
 */
</script>

<template>
  <div class="pet-hero" role="img" aria-label="Aervox 桌宠">
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