<script setup lang="ts">
import {AervoxWorkbench} from '@aervox/ui'

const platform = import.meta.env.VITE_AERVOX_PLATFORM === 'mobile' ? 'mobile' : 'web'
</script>

<template>
  <AervoxWorkbench :platform="platform" :show-companion="platform === 'web'" />
</template>
