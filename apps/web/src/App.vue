<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus/es/components/message/index.mjs'
import { useMaterial3, useMobileBackNavigation } from '@aervox/ui/material3'
import type { BuiltinUIPlugin } from '@aervox/ui/plugin-api'
import { createMobileSurfaceLocation } from './mobile-surface-location'
import {createSurfaceNavigation, resolveSurfaceChoice, resolveWebPlatform, UISurfaceHost} from '@aervox/ui-host'
import defaultSurface, {compactSurface} from '@aervox/plugin-workbench-ui'
import proactiveSurface from '@aervox/plugin-proactive-ui'
// CR-060：第一方插件按**包路径**装配，宿主不绑定插件私有符号（见 check-host-domain-purity）
import * as firstPartyPlugin from '@aervox/plugin-focus-mode/ui'
import * as campusPlugin from '@aervox/plugin-flowcampus/ui'
// CR-065 切片四：内置设置面板同为受信构建输入，由组合根显式注入
import { settingsPanels } from '@aervox/plugin-panels-ui'

const reloadSurface = () => { if (mobileLocation) mobileLocation.reload(); else window.location.reload() }
const pluginDefinitions: BuiltinUIPlugin[] = [
  firstPartyPlugin.default,
  campusPlugin.default,
]

const platform = resolveWebPlatform({
  configuredPlatform: import.meta.env.VITE_AERVOX_PLATFORM,
  userAgent: window.navigator.userAgent,
  maxTouchPoints: window.navigator.maxTouchPoints,
})
let surfaceStorage: Storage | undefined
try { surfaceStorage = window.localStorage } catch { /* 浏览器禁止存储时仍按平台或 URL 打开 */ }
// CR-065 切片六：组合根显式持有受信界面清单，按用户选择（?surface= 或本地存储）装配根界面
const availableSurfaces = [defaultSurface, compactSurface, proactiveSurface]
const mainSurface = resolveSurfaceChoice(availableSurfaces, surfaceStorage, {
  storageKey: 'aervox.surface.main',
  defaultSurfaceId: platform === 'mobile' ? proactiveSurface.id : defaultSurface.id,
  queryValue: new URLSearchParams(window.location.search).get('surface'),
})
// Surface selection can be requested by any registered settings panel. Keep the
// barrier at the composition root so every mobile replace shares the same policy.
const mobileBack = useMobileBackNavigation()
const mobileLocation = useMaterial3() && mobileBack ? createMobileSurfaceLocation(
  window.location,
  () => mobileBack.whenSettled(),
  () => { ElMessage.error('暂时无法更新界面，请重试。') },
) : undefined
onBeforeUnmount(() => mobileLocation?.dispose())
const surfaceNavigation = createSurfaceNavigation(availableSurfaces, {
  currentSurfaceId: mainSurface.id, defaultSurfaceId: defaultSurface.id, storageKey: 'aervox.surface.main',
  storage: surfaceStorage, location: mobileLocation?.location ?? window.location,
})
</script>

<template>
  <!-- CR-060：第一方插件由组合根显式注入 -->
  <UISurfaceHost
    :plugin="mainSurface"
    :request-reload="reloadSurface"
    surface="main"
    :platform="platform"
    :view-props="{ showCompanion: platform === 'web', surfaceNavigation }"
    :plugins="pluginDefinitions"
    :settings-panels="settingsPanels"
  />
</template>
