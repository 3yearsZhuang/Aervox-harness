<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { PetCommand } from '@aervox/contracts'
import { AervoxLive2DController } from '../live2d/controller'
import { PET_REACT_EVENT, resolveLookAtElement, type PetReactionDetail } from '../live2d/petReactions'
import { DEFAULT_AERVOX_MODEL, MIZUKI_EXPRESSIONS, MIZUKI_MOTIONS, type Live2DPose } from '../live2d/model'

const emit = defineEmits<{ onSpeak: [text: string] }>()

const canvasHost = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
let controller: AervoxLive2DController | null = null
let removePetCommandListener: (() => void) | null = null

function exposeApi() {
  if (typeof window === 'undefined') return
  ;(window as Window & { aervoxLive2D?: unknown }).aervoxLive2D = {
    motions: MIZUKI_MOTIONS,
    expressions: MIZUKI_EXPRESSIONS,
    playMotion: (motion: string) => controller?.playNamedMotion('Motion', motion) ?? false,
    playExpression: (expression: string) => controller?.playFacialByName(expression),
    playPose: (pose: Live2DPose) => controller?.playPose(pose),
    lookAt: (target: string | Element) => {
      const element = resolveLookAtElement(target)
      if (!element) return
      const rect = element.getBoundingClientRect()
      controller?.focusViewportPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    },
  }
}

function onCommand(command: PetCommand) {
  if (!controller) return
  if (command.type === 'emote' && command.emote) controller.playExpressionByName(command.emote)
  if (command.type === 'gesture' && command.gesture) {
    const patterns: Record<string, RegExp> = { wave: /wave|greeting/i, nod: /nod|yes/i, shake: /shake|no/i, stretch: /stretch/i, yawn: /yawn/i }
    controller.playFirstAvailableMotion(patterns[command.gesture] ?? new RegExp(command.gesture, 'i'))
  }
  if (command.type === 'react') controller.playFirstAvailableMotion(/react|tap|touch|idle/i)
  if (command.type === 'speak' && command.text) {
    controller.speakText(command.text)
    // 气泡展示是宿主职责：speak 文本由 emit 上抛，宿主决定是否展示
    emit('onSpeak', command.text)
  }
  if (command.type === 'move' && typeof command.x === 'number' && typeof command.y === 'number') controller.setFocus(command.x, command.y)
}

/**
 * 操作反馈：动作 + 表情 + 看向目标元素 + 说话口型。
 * 视线不做全程鼠标跟随（快速移动会鬼畜），只在用户操作（如点击卡片）时看向对应元素，
 * 到时后回到中心，待机期间由控制器做轻微视线游移。
 */
const handlePetReact = (event: Event) => {
  const detail = (event as CustomEvent<PetReactionDetail>).detail
  if (!controller || !detail) return
  const element = resolveLookAtElement(detail.lookAtEl)
  if (element) {
    const rect = element.getBoundingClientRect()
    const duration = detail.lookDuration ?? 2600
    controller.focusViewportPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, duration)
    if (duration > 0) {
      window.setTimeout(() => {
        controller?.focusViewportCenter()
      }, duration)
    }
  }
  if (detail.motion) controller.playNamedMotion('Motion', detail.motion)
  if (detail.expression) controller.playFacialByName(detail.expression)
  if (detail.speak) controller.speakText(detail.speak)
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
    // 桌面端专属：桌宠独立窗口通过 preload 桥下发 PetCommand
    // （web 工作台无 fairyDesktop，特性探测自动跳过）
    removePetCommandListener = (window as Window & { fairyDesktop?: { onPetCommand: (callback: (command: unknown) => void) => () => void } }).fairyDesktop?.onPetCommand((value: unknown) => onCommand(value as PetCommand)) ?? null
    status.value = 'ready'
  } catch (error) {
    console.warn('[Aervox] Live2D unavailable; using fallback', error)
    status.value = 'error'
  }
  window.addEventListener(PET_REACT_EVENT, handlePetReact)
})

onBeforeUnmount(() => {
  removePetCommandListener?.()
  removePetCommandListener = null
  window.removeEventListener(PET_REACT_EVENT, handlePetReact)
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
