<script setup lang="ts">
withDefaults(defineProps<{size?: number; label?: string}>(), {size: 24, label: 'Aervox 思隅'})
</script>

<template>
  <svg class="aervox-brand-mark" viewBox="0 0 100 100" fill="currentColor" :width="size" :height="size" role="img" :aria-label="label">
    <rect x="18" y="60" width="16" height="16" rx="6"/>
    <rect x="18" y="40" width="16" height="16" rx="6" opacity=".84"/>
    <rect x="18" y="20" width="16" height="16" rx="6" opacity=".64"/>
    <rect x="38" y="60" width="16" height="16" rx="6" opacity=".84"/>
    <rect x="58" y="60" width="16" height="16" rx="6" opacity=".64"/>
    <circle cx="62" cy="35" r="10"/>
  </svg>
</template>

<style scoped>.aervox-brand-mark { display:block; flex:none; }</style>
