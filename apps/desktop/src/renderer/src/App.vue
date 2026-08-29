<script setup lang="ts">
import {defineAsyncComponent, ref} from 'vue'
import AppTitlebar from '@/components/AppTitlebar.vue'
import {hasCompletedOnboarding, markOnboardingCompleted} from '@/onboarding-state'
import {AervoxWorkbench} from '@aervox/ui'

const OnboardingFlow = defineAsyncComponent(() => import('@/components/OnboardingFlow.vue'))
const showOnboarding = ref(!hasCompletedOnboarding(window.localStorage))

function completeOnboarding() {
  markOnboardingCompleted(window.localStorage)
  showOnboarding.value = false
}

/** 设置里的「重看新手引导」：完成标记保持不变，仅重新挂载引导流程 */
function replayOnboarding() {
  showOnboarding.value = true
}
</script>

<template>
  <div class="window-shell">
    <AppTitlebar />
    <OnboardingFlow v-if="showOnboarding" @complete="completeOnboarding" />
    <AervoxWorkbench v-else platform="desktop" :show-companion="true" @replay-onboarding="replayOnboarding" />
  </div>
</template>
