<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="settings-heading">
    <div class="settings-heading-copy">
      <h2>{{ title }}</h2>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.default" class="settings-heading-actions"><slot /></div>
  </header>
</template>

<style scoped>
.settings-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.settings-heading-copy { min-width: 0; }
.settings-heading h2 { margin: 0; color: var(--text-primary); font-size: 20px; line-height: 1.4; font-weight: 600; }
.settings-heading p { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.settings-heading-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
@media (max-width: 680px) { .settings-heading { flex-wrap: wrap; gap: 12px; } }
</style>
