<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PetCommand } from '@aervox/contracts'
import { AervoxLive2DController } from '../live2d/controller'
import { DEFAULT_AERVOX_MODEL, MIZUKI_EXPRESSIONS, MIZUKI_MOTIONS, type Live2DPose } from '../live2d/model'

const canvasHost = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
let controller: AervoxLive2DController | null = null

function exposeApi() {
  if (typeof window === 'undefined') return
  ;(window as Window & { aervoxLive2D?: unknown }).aervoxLive2D = {
    motions: MIZUKI_MOTIONS,
    expressions: MIZUKI_EXPRESSIONS,
    playMotion: (motion: string) => controller?.playNamedMotion('Motion', motion) ?? false,
    playExpression: (expression: string) => controller?.playFacialByName(expression),
    playPose: (pose: Live2DPose) => controller?.playPose(pose),
  }
}

function onCommand(command: PetCommand) {
  if (!controller) return
  if (command.type === 'emote' && command.emote) controller.playExpressionByName(command.emote)
  if (command.type === 'gesture' && command.gesture) controller.playFirstAvailableMotion(new RegExp(command.gesture, 'i'))
  if (command.type === 'react') controller.playFirstAvailableMotion(/react|tap|touch|idle/i)
  if (command.type === 'speak' && command.text) controller.speakText(command.text)
  if (command.type === 'move' && typeof command.x === 'number' && typeof command.y === 'number') controller.setFocus(command.x, command.y)
}

onMounted(async () => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !canvasHost.value) {
    status.value = 'error'
    return
  }
  controller = new AervoxLive2DController(canvasHost.value)
  try {
    await controller.load(DEFAULT_AERVOX_MODEL)
    exposeApi()
    status.value = 'ready'
  } catch (error) {
    console.warn('[Aervox] Live2D unavailable; using fallback', error)
    status.value = 'error'
  }
})

onBeforeUnmount(() => {
  controller?.destroy()
  controller = null
  if (typeof window !== 'undefined') delete (window as Window & { aervoxLive2D?: unknown }).aervoxLive2D
})
</script>

<template>
  <div class="aervox-live2d-pet" :data-status="status" role="img" aria-label="Aervox Live2D 桌宠">
    <div ref="canvasHost" class="aervox-live2d-pet__canvas" aria-hidden="true" />
    <slot v-if="status === 'error'" name="fallback" />
    <span v-if="status === 'loading'" class="aervox-live2d-pet__status">正在加载桌宠…</span>
  </div>
</template>

<style scoped>
.aervox-live2d-pet { position: relative; width: 100%; height: 100%; min-height: 220px; overflow: hidden; }
.aervox-live2d-pet__canvas { position: absolute; inset: 70px 0 0; height: auto; display: grid; place-items: center; }
.aervox-live2d-pet__canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
.aervox-live2d-pet__status { position: absolute; inset: 50% 0 auto; text-align: center; color: #737d90; font-size: 11px; }
</style>
