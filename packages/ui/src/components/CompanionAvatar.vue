<script setup lang="ts">
import Live2DPet from './Live2DPet.vue'
import { DEFAULT_AERVOX_MODEL, type AervoxLive2DModel } from '../live2d/model'
import type { CompanionAvatarBindingState } from '../composables/useCompanionAvatarBinding'

withDefaults(defineProps<{
  model?: AervoxLive2DModel
  bindingState?: CompanionAvatarBindingState
}>(), { model: () => DEFAULT_AERVOX_MODEL, bindingState: 'default' })

const emit = defineEmits<{
  onSpeak: [text: string, preset?: string]
  retryBinding: []
}>()
</script>

<template>
  <div class="aervox-companion-avatar" :class="{ 'has-binding-notice': bindingState === 'missing' || bindingState === 'error' }" :data-model-id="model.id" :data-binding-state="bindingState">
    <Live2DPet :key="model.id" :model="model" @on-speak="(text, preset) => emit('onSpeak', text, preset)" />
    <div v-if="bindingState === 'missing' || bindingState === 'error'" class="aervox-companion-avatar__notice" role="status">
      <span v-if="bindingState === 'missing'">绑定的形象不可用，正在使用 Mizuki。</span>
      <template v-else>
        <span>暂时无法读取人格形象。</span>
        <button type="button" @click="emit('retryBinding')">重新读取</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.aervox-companion-avatar { position: relative; width: 100%; height: 100%; min-height: 220px; }
.aervox-companion-avatar__notice { position: absolute; top: 28px; right: 24px; left: 24px; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; color: var(--avx-text-secondary, #737d90); font-size: 12px; text-align: center; }
.aervox-companion-avatar.has-binding-notice :deep(.aervox-live2d-pet__status) { top: 80px; }
.aervox-companion-avatar__notice button { border: 0; padding: 0; color: inherit; background: none; font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
</style>
