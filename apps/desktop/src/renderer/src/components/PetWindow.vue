<script setup lang="ts">
import {MessageCircle, Sparkles} from 'lucide-vue-next'
</script>

<template>
  <main class="pet-window">
    <div class="pet-stage">
      <Sparkles class="sparkle sparkle-a" :size="18"/>
      <Sparkles class="sparkle sparkle-b" :size="16"/>
      <div class="pet-shadow"/>
      <div class="pet-character">
        <div class="pet-wing wing-left"/>
        <div class="pet-wing wing-right"/>
        <div class="pet-head"><span class="ear ear-left"/><span class="ear ear-right"/><span class="hair">⌁</span><span
            class="eye eye-left"/><span class="eye eye-right"/><span class="cheek cheek-left"/><span
            class="cheek cheek-right"/><span class="mouth">⌣</span></div>
        <div class="pet-body"><span class="pet-collar"/><span class="pet-star">✦</span></div>
        <div class="pet-foot foot-left"/>
        <div class="pet-foot foot-right"/>
      </div>
    </div>
    <section class="pet-card">
      <div class="pet-card-header"><span><Sparkles :size="17"/><span>Aervox 桌面端</span></span></div>
      <div class="pet-card-footer">
        <MessageCircle :size="18"/>
        <span class="pet-footer-label">对话内容来自 Aervox API</span></div>
    </section>
  </main>
</template>
