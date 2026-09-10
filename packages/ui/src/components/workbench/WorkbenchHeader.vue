<script setup lang="ts">
import { Settings } from 'lucide-vue-next';
import ExtensionSlot from '../extension/ExtensionSlot.vue';
import { useWorkbenchContext } from '../../composables/workbench-context';

const { layout } = useWorkbenchContext();
const { isWeb, settingsOpen } = layout;
</script>

<template>
  <div class="floating-top-actions">
    <ExtensionSlot name="header:before" />
    <ExtensionSlot name="header:actions" />

    <button v-if="isWeb" class="floating-settings" type="button" aria-label="打开设置" @click="settingsOpen = true">
      <Settings :size="19" />
    </button>
  </div>
</template>
