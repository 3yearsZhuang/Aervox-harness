<script setup lang="ts">
import { CalendarClock } from 'lucide-vue-next';
import { useUIPluginContext } from '@aervox/ui/plugin-api';
import { useCampusStore } from './store.js';
const context = useUIPluginContext();
const store = useCampusStore(context);
function open() { context.navigation.runMenuAction(() => store.open()); }
</script>
<template>
  <button class="menu-item campus-nav-item" type="button" :class="{ 'is-active': store.drawerOpen.value }" aria-label="只争朝夕" @click.stop="open"><CalendarClock :size="16" aria-hidden="true" /><span>只争朝夕</span></button>
</template>
