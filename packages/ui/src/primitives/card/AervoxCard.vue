<script setup lang="ts">
withDefaults(defineProps<{ as?: 'article' | 'section' | 'div' | 'li'; selected?: boolean; layout?: 'default' | 'record' }>(), { as: 'article', selected: false, layout: 'default' });
</script>

<template>
  <component :is="as" class="aervox-card" :class="{ 'is-selected': selected, 'is-record': layout === 'record' }"><slot /></component>
</template>

<style scoped>
.aervox-card.aervox-card { min-width: 0; padding: var(--control-card-padding, 16px); border: 1px solid var(--border); border-radius: var(--control-card-radius, 10px); background: var(--bg-main); color: var(--text-primary); box-shadow: none; }
.aervox-card:is(.is-selected, .active, .selected) { border-color: var(--accent); }
.aervox-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.aervox-card.is-record { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.aervox-card.is-record :deep(.record-main) { min-width: 0; overflow-wrap: anywhere; }
.aervox-card.is-record :deep(.record-actions) { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.aervox-card.is-record :deep(.record-detail) { grid-column: 1 / -1; }
@media (max-width: 680px) {
  .aervox-card.is-record { grid-template-columns: auto minmax(0, 1fr); }
  .aervox-card.is-record :deep(.record-actions) { grid-column: 1 / -1; justify-content: flex-end; }
}
</style>
