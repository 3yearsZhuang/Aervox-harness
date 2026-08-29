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
</script>

<template>
  <div class="window-shell">
    <AppTitlebar />
    <OnboardingFlow v-if="showOnboarding" @complete="completeOnboarding" />
    <AervoxWorkbench v-else platform="desktop" :show-companion="true" />
  </div>
</template>
