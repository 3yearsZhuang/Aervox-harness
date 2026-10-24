<script setup lang="ts">
import {defineAsyncComponent, onBeforeUnmount, onMounted, ref} from 'vue'
import {X} from 'lucide-vue-next'
import AppTitlebar from '@/components/AppTitlebar.vue'
import {hasCompletedOnboarding, markOnboardingCompleted} from '@/onboarding-state'
import {createSurfaceNavigation, resolveSurfaceChoice, UISurfaceHost} from '@aervox/ui-host'
import defaultSurface, {compactSurface} from '@aervox/plugin-workbench-ui'
import proactiveSurface from '@aervox/plugin-proactive-ui'
// CR-060：第一方插件按**包路径**装配，宿主不绑定插件私有符号（见 check-host-domain-purity）
import * as firstPartyPlugin from '@aervox/plugin-focus-mode/ui'
import { settingsPanels } from '@aervox/plugin-panels-ui'

const OnboardingFlow = defineAsyncComponent(() => import('@/components/OnboardingFlow.vue'))
let surfaceStorage: Storage | undefined
try { surfaceStorage = window.localStorage } catch { /* 无存储时使用本次窗口的默认值 */ }
const showOnboarding = ref(!hasCompletedOnboarding(surfaceStorage))
const reloadSurface = () => window.location.reload()
const firstPartyPlugins = [firstPartyPlugin.default]
const showIntroDeck = ref(false)
// CR-065 切片六：组合根按用户选择装配主界面（本地存储 aervox.surface.main）
const availableSurfaces = [defaultSurface, compactSurface, proactiveSurface]
const mainSurface = resolveSurfaceChoice(availableSurfaces, surfaceStorage, {
  storageKey: 'aervox.surface.main',
  defaultSurfaceId: defaultSurface.id,
  queryValue: new URLSearchParams(window.location.search).get('surface'),
})
const surfaceNavigation = createSurfaceNavigation(availableSurfaces, {
  currentSurfaceId: mainSurface.id, defaultSurfaceId: defaultSurface.id, storageKey: 'aervox.surface.main',
  storage: surfaceStorage, location: window.location,
})

function completeOnboarding() {
  markOnboardingCompleted(surfaceStorage)
  showOnboarding.value = false
}

/** 设置里的「重看新手引导」：完成标记保持不变，仅重新挂载引导流程 */
function replayOnboarding() {
  showOnboarding.value = true
}

/** 设置里的「完整产品介绍」：内嵌播放裁剪版宣讲包（public/aervox-intro） */
function openIntroDeck() {
  showIntroDeck.value = true
}

function closeIntroDeck() {
  showIntroDeck.value = false
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && showIntroDeck.value) closeIntroDeck()
}

onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <div class="window-shell">
    <AppTitlebar />
    <OnboardingFlow v-if="showOnboarding" @complete="completeOnboarding" />
    <UISurfaceHost
      :plugin="mainSurface"
      :request-reload="reloadSurface"
      surface="main"
      v-else
      platform="desktop"
      :view-props="{ showCompanion: true, surfaceNavigation }"
      :plugins="firstPartyPlugins"
      :settings-panels="settingsPanels"
      @replay-onboarding="replayOnboarding"
      @open-intro-deck="openIntroDeck"
    />
    <div v-if="showIntroDeck" class="intro-deck-overlay" role="dialog" aria-label="Aervox 产品介绍">
      <iframe class="intro-deck-frame" src="./aervox-intro/index.html" title="Aervox 产品介绍" />
      <button class="intro-deck-close" type="button" aria-label="关闭产品介绍" @click="closeIntroDeck">
        <X :size="15" /><span>关闭</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.intro-deck-overlay {
  position: fixed;
  z-index: 90;
  inset: 0;
  background: #050a13;
}

.intro-deck-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.intro-deck-close {
  position: absolute;
  top: 14px;
  right: 18px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 14px;
  border: 1px solid rgba(218, 234, 255, .24);
  border-radius: 8px;
  color: rgba(231, 237, 248, .82);
  background: rgba(9, 20, 38, .55);
  backdrop-filter: blur(14px);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: all .15s ease;
}

.intro-deck-close:hover {
  border-color: rgba(218, 234, 255, .5);
  color: #fff;
}
</style>
