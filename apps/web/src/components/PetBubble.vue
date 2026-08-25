<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="pet-bubble" @click="router.push('/chat')">
    <span class="emoji">🐣</span>
    <span class="label">桌宠</span>
  </div>
</template>

<style scoped>
.pet-bubble {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 14px;
  border-radius: 999px;
  background: var(--el-color-primary);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 6px 20px rgb(0 0 0 / 15%);
  transition: transform 0.15s ease;
}
.pet-bubble:hover {
  transform: translateY(-2px);
}
.emoji {
  font-size: 20px;
  line-height: 1;
}
.label {
  font-size: 11px;
}
</style>