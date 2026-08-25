<script setup lang="ts">
import {MessageCircle, Sparkles} from 'lucide-vue-next'
import {PetHero} from '@aervox/ui'
</script>

<template>
  <main class="pet-window">
    <div class="pet-stage">
      <Sparkles class="sparkle sparkle-a" :size="18"/>
      <Sparkles class="sparkle sparkle-b" :size="16"/>
      <div class="pet-shadow"/>
      <div class="pet-character">
        <span class="pet-hero-scale"><PetHero /></span>
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