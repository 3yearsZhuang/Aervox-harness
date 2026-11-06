<script setup lang="ts">
import { getClientPlatformServices } from '@aervox/api-client'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PetCommand } from '@aervox/contracts'
import { AervoxLive2DController } from '../live2d/controller'
import { PET_REACT_EVENT, resolveLookAtElement, type PetReactionDetail } from '../live2d/petReactions'
import { DEFAULT_AERVOX_MODEL, MIZUKI_EXPRESSIONS, MIZUKI_MOTIONS, type AervoxLive2DModel, type Live2DPose } from '../live2d/model'

const props = withDefaults(defineProps<{ model?: AervoxLive2DModel }>(), { model: () => DEFAULT_AERVOX_MODEL })

const platformServices = getClientPlatformServices()
const emit = defineEmits<{ onSpeak: [text: string, preset?: string] }>()

const canvasHost = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'ready' | 'error'>('loading')
let controller: AervoxLive2DController | null = null
let disposed = false
let mounted = false
let generation = 0
const loadError = ref('')
let exposedApi: Window['aervoxLive2D']
let removePetCommandListener: (() => void) | null = null
const focusTimers = new Set<number>()

function exposeApi() {
  if (typeof window === 'undefined') return
  exposedApi = {
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
  window.aervoxLive2D = exposedApi
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
    // 气泡展示是宿主职责：speak 文本由 emit 上抛，宿主决定是否展示；
    // CR-032 主动插件 speak 可携带气泡预设（宿主映射样式与停留时长）
    emit('onSpeak', command.text, (command as {preset?: string}).preset)
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
      const currentController = controller
      const timer = window.setTimeout(() => {
        focusTimers.delete(timer)
        if (controller === currentController) controller?.focusViewportCenter()
      }, duration)
      focusTimers.add(timer)
    }
  }
  if (detail.motion) controller.playNamedMotion('Motion', detail.motion)
  if (detail.expression) controller.playFacialByName(detail.expression)
  if (detail.speak) controller.speakText(detail.speak)
}

function releaseController() {
  removePetCommandListener?.()
  removePetCommandListener = null
  window.removeEventListener(PET_REACT_EVENT, handlePetReact)
  for (const timer of focusTimers) window.clearTimeout(timer)
  focusTimers.clear()
  controller?.destroy()
  controller = null
  if (window.aervoxLive2D === exposedApi) delete window.aervoxLive2D
  exposedApi = undefined
}

async function loadModel() {
  if (disposed) return
  const current = ++generation
  // Every selection and retry gets a new controller. Destroyed controllers
  // cannot load again, and they dispose models that finish loading late.
  releaseController()
  status.value = 'loading'
  loadError.value = ''
  // Reduced motion must not block the model from loading: it only skips the
  // idle diversification below. A hard fail here silently pinned every
  // animation-off device to a missing visual.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!canvasHost.value) {
    status.value = 'error'
    return
  }
  try {
    controller = new AervoxLive2DController(canvasHost.value)
    await controller.load(props.model, { diversifyIdle: !reducedMotion })
    if (disposed || current !== generation) return
    exposeApi()
    removePetCommandListener = platformServices.onPetCommand?.((value: unknown) => onCommand(value as PetCommand)) ?? null
    status.value = 'ready'
    window.addEventListener(PET_REACT_EVENT, handlePetReact)
  } catch (error) {
    if (disposed || current !== generation) return
    releaseController()
    console.warn('[Aervox] Live2D model unavailable', error)
    loadError.value = error instanceof Error ? error.message : String(error)
    status.value = 'error'
  }
}

watch(() => props.model, () => { if (mounted) void loadModel() })
onMounted(() => {
  mounted = true
  void loadModel()
})

onBeforeUnmount(() => {
  disposed = true
  generation++
  releaseController()
})
</script>

<template>
  <div class="aervox-live2d-pet" :data-status="status" role="group" :aria-label="`${model.displayName} Live2D 形象`" :data-error="status === 'error' ? loadError : undefined">
    <div ref="canvasHost" class="aervox-live2d-pet__canvas" :class="{ 'is-pending': status !== 'ready' }" aria-hidden="true" />
    <div v-if="status !== 'ready'" class="aervox-live2d-pet__status" role="status" aria-live="polite">
      <span v-if="status === 'loading'">正在加载 {{ model.displayName }}…</span>
      <template v-else>
        <span>{{ model.displayName }} 暂时无法加载。</span>
        <button type="button" @click="loadModel">重试加载</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.aervox-live2d-pet { position: relative; width: 100%; height: 100%; min-height: 220px; overflow: hidden; }
.aervox-live2d-pet__canvas { position: absolute; inset: 70px 0 0; height: auto; display: grid; place-items: center; }
/* Keep the canvas measurable while the controller prepares the model. */
.aervox-live2d-pet__canvas.is-pending { visibility: hidden; }
.aervox-live2d-pet__canvas :deep(canvas) { display: block; width: 100%; height: 100%; }
.aervox-live2d-pet__status { position: absolute; inset: 40px 12px auto; display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; color: var(--avx-text-secondary, #737d90); font-size: 12px; }
.aervox-live2d-pet__status button { padding: 7px 12px; border: 1px solid currentColor; border-radius: 8px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
</style>
