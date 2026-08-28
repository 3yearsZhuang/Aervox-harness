<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { AervoxLive2DController } from '../live2d/controller'
import { DEFAULT_AERVOX_MODEL } from '../live2d/model'
import { MIZUKI_EXPRESSIONS, MIZUKI_MOTIONS, type Live2DPose } from '../live2d/model'
import type { PetCommand } from '@aervox/contracts'

const canvasHost = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
let controller: AervoxLive2DController | null = null
let removePetCommandListener: (() => void) | null = null

function exposeLive2DApi() {
  window.aervoxLive2D = {
    motions: MIZUKI_MOTIONS,
    expressions: MIZUKI_EXPRESSIONS,
    playMotion: (motion) => controller?.playNamedMotion('Motion', motion) ?? false,
    playExpression: (expression) => {
      controller?.playFacialByName(expression)
    },
    playPose: (pose: Live2DPose) => {
      controller?.playPose(pose)
    },
  }
}
const onPetCommand = (value: unknown) => {
  const command = value as PetCommand
  if (!controller || !command) return
  if (command.type === 'emote' && command.emote) {
    const names: Record<string, string> = { happy: 'happy', cheer: 'cheer', worry: 'worry', sad: 'sad', surprise: 'surprise', think: 'think' }
    controller.playExpressionByName(names[command.emote] ?? command.emote)
  }
  if (command.type === 'gesture' && command.gesture) {
    const patterns: Record<string, RegExp> = { wave: /wave|greeting/i, nod: /nod|yes/i, shake: /shake|no/i, stretch: /stretch/i, yawn: /yawn/i }
    controller.playFirstAvailableMotion(patterns[command.gesture] ?? new RegExp(command.gesture, 'i'))
  }
  if (command.type === 'react') controller.playFirstAvailableMotion(/react|tap|touch|idle/i)
  if (command.type === 'speak' && command.text) {
    controller.speakText(command.text)
    // 同步给桌宠窗口的对话气泡展示
    window.dispatchEvent(new CustomEvent('aervox:pet-bubble', {detail: command.text}))
  }
  if (command.type === 'move' && typeof command.x === 'number' && typeof command.y === 'number') controller.setFocus(command.x, command.y)
}

async function mountModel() {
  if (!canvasHost.value) return
  controller = new AervoxLive2DController(canvasHost.value)
  try {
    await controller.load(DEFAULT_AERVOX_MODEL)
    controller.model?.on('pointertap', () => controller?.playFirstAvailableMotion(/tap|touch|idle/i))
    removePetCommandListener = window.fairyDesktop?.onPetCommand(onPetCommand) ?? null
    exposeLive2DApi()
    status.value = 'ready'
  } catch (error) {
    console.warn('[Aervox] own Live2D model unavailable; using fallback', error)
    status.value = 'error'
  }
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    status.value = 'error'
    return
  }
  void mountModel()
})

onBeforeUnmount(() => {
  removePetCommandListener?.()
  removePetCommandListener = null
  controller?.destroy()
  controller = null
  delete window.aervoxLive2D
})
</script>

<template>
  <div class="live2d-pet" :data-status="status" role="img" aria-label="Aervox Live2D 桌宠">
    <div ref="canvasHost" class="live2d-pet__canvas" aria-hidden="true" />
    <slot v-if="status === 'error'" name="fallback" />
    <span v-if="status === 'loading'" class="live2d-pet__status">正在加载桌宠…</span>
  </div>
</template>

<style scoped>
.live2d-pet { position: relative; width: 100%; height: 100%; min-height: 220px; }
.live2d-pet__canvas { position: absolute; inset: 0; }
.live2d-pet__canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
.live2d-pet__status { position: absolute; inset: 50% 0 auto; text-align: center; color: var(--text-secondary, #536284); font-size: 11px; }
</style>
