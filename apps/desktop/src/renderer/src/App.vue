<script setup lang="ts">
import AppTitlebar from '@/components/AppTitlebar.vue'
import {AervoxWorkbench} from '@aervox/ui'
</script>

<template>
  <div class="window-shell">
    <AppTitlebar />
    <AervoxWorkbench platform="desktop" :show-companion="false" />
  </div>
</template>
