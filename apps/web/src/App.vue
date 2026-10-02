<script setup lang="ts">
import {AervoxWorkbench} from '@aervox/ui'
// CR-060：第一方插件按**包路径**装配，宿主不绑定插件私有符号（见 check-host-domain-purity）
import * as firstPartyPlugin from '@aervox/plugin-focus-mode/ui'

const firstPartyPlugins = [firstPartyPlugin.default]

const platform = import.meta.env.VITE_AERVOX_PLATFORM === 'mobile' ? 'mobile' : 'web'
</script>

<template>
  <!-- CR-060：第一方插件由组合根显式注入 -->
  <AervoxWorkbench
    :platform="platform"
    :show-companion="platform === 'web'"
    :plugins="firstPartyPlugins"
  />
</template>
