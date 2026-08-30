<script setup lang="ts">
import {defineAsyncComponent, onBeforeUnmount, onMounted, ref} from 'vue'
import {X} from 'lucide-vue-next'
import AppTitlebar from '@/components/AppTitlebar.vue'
import {hasCompletedOnboarding, markOnboardingCompleted} from '@/onboarding-state'
import {AervoxWorkbench} from '@aervox/ui'

const OnboardingFlow = defineAsyncComponent(() => import('@/components/OnboardingFlow.vue'))
const showOnboarding = ref(!hasCompletedOnboarding(window.localStorage))
const showIntroDeck = ref(false)

function completeOnboarding() {
  markOnboardingCompleted(window.localStorage)
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
    <AervoxWorkbench v-else platform="desktop" :show-companion="true" @replay-onboarding="replayOnboarding" @open-intro-deck="openIntroDeck" />
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
