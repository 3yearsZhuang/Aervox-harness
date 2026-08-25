<script setup lang="ts">
/**
 * Aervox｜思隅 @aervox/ui — 对话消息气泡（共享）
 */
defineProps<{ role: 'user' | 'assistant'; text: string; streaming?: boolean }>();
</script>

<template>
  <div class="message-bubble" :class="role">
    <div class="bubble">
      {{ text }}<span v-if="streaming && role === 'assistant'" class="cursor">▍</span>
    </div>
  </div>
</template>

<style scoped>
.message-bubble {
  display: flex;
}
.message-bubble.user {
  justify-content: flex-end;
}
.message-bubble.assistant {
  justify-content: flex-start;
  max-width: 82%;
}
.bubble {
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--aervox-fill-light, #f4f4f5);
  white-space: pre-wrap;
  line-height: 1.6;
  color: var(--aervox-text, #303133);
}
.user .bubble {
  background: var(--aervox-primary-light, #ecf5ff);
}
.cursor {
  animation: aervox-blink 1s steps(1) infinite;
}
@keyframes aervox-blink {
  50% {
    opacity: 0;
  }
}
</style>