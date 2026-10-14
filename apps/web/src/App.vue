<script setup lang="ts">
import {resolveSurfaceChoice, UISurfaceHost} from '@aervox/ui-host'
import defaultSurface, {compactSurface} from '@aervox/plugin-workbench-ui'
import proactiveSurface from '@aervox/plugin-proactive-ui'
import documentSurface from '@aervox/plugin-document-ui'
// CR-060：第一方插件按**包路径**装配，宿主不绑定插件私有符号（见 check-host-domain-purity）
import * as firstPartyPlugin from '@aervox/plugin-focus-mode/ui'
// CR-065 切片四：内置设置面板同为受信构建输入，由组合根显式注入
import { settingsPanels } from '@aervox/plugin-panels-ui'

const reloadSurface = () => window.location.reload()
const firstPartyPlugins = [firstPartyPlugin.default]

const platform = import.meta.env.VITE_AERVOX_PLATFORM === 'mobile' ? 'mobile' : 'web'
// CR-065 切片六：组合根显式持有受信界面清单，按用户选择（?surface= 或本地存储）装配根界面
const mainSurface = resolveSurfaceChoice([defaultSurface, compactSurface, proactiveSurface, documentSurface], window.localStorage, {
  storageKey: 'aervox.surface.main',
  queryValue: new URLSearchParams(window.location.search).get('surface'),
})
</script>

<template>
  <!-- CR-060：第一方插件由组合根显式注入 -->
  <UISurfaceHost
    :plugin="mainSurface"
    :request-reload="reloadSurface"
    surface="main"
    :platform="platform"
    :view-props="{ showCompanion: platform === 'web' }"
    :plugins="firstPartyPlugins"
    :settings-panels="settingsPanels"
  />
</template>
