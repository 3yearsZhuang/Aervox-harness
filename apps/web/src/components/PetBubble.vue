<script setup lang="ts">
import { useRouter } from 'vue-router';
import { PetHero } from '@aervox/ui';

const router = useRouter();
</script>

<template>
  <div class="pet-bubble" @click="router.push('/chat')">
    <span class="pet-scale-box"><PetHero /></span>
    <span class="label">对话</span>
  </div>
</template>

<style scoped>
.pet-scale-box {
  display: inline-block;
  transform: scale(0.55);
  transform-origin: bottom center;
}
.pet-bubble {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
  border-radius: 999px;
  background: var(--aervox-primary, #409eff);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 6px 20px rgb(0 0 0 / 15%);
  transition: transform 0.15s ease;
}
.pet-bubble:hover {
  transform: translateY(-2px);
}
.label {
  font-size: 11px;
}
</style>