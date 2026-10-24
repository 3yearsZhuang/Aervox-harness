<script setup lang="ts">
import {ChevronDown, ChevronUp, Hand, Smile, X} from 'lucide-vue-next'
import {computed, onBeforeUnmount, onMounted, ref, shallowRef} from 'vue'
import {PetWithFallback, UserQuestionComposer} from '@aervox/ui/companion'
import {createConversationController, getClientTransport, useAervoxClient} from '@aervox/api-client'
import type {AskUserQuestionAnswerItem, UserQuestionRequiredEventData} from '@aervox/contracts'
import {replyBubbleDurationMs, stripMarkdownForBubble} from './quick-chat'
import {pickPetButtonPose, type PetButtonPose, type PetButtonPoseKind} from './pet-button-poses'

import './pet.css'
import '@aervox/ui/theme/companion'
import {useUISurfaceContext} from '@aervox/ui-host'
const surfaceContext = useUISurfaceContext()
const client = useAervoxClient()
const turnController = createConversationController(getClientTransport(), surfaceContext.signal)

const bubbleText = ref('')
const turnState = shallowRef(turnController.state)
const unsubscribeTurn = turnController.subscribe(state => { turnState.value = state })
const activeQuestion = computed(() => turnState.value.question)
const pendingApproval = computed(() => turnState.value.approval)
const interactionBusy = ref(false)
const turnFeedback = ref('')
const stopping = ref(false)
const canStop = computed(() => quickChatPending.value || ['awaiting-input', 'awaiting-approval', 'observer-error'].includes(turnState.value.status))
let bubbleTimer: number | null = null
let closingTimer: number | null = null

// 快捷对话状态：dock 展开开关为内存态（刷新回落展开，不写 localStorage）
const dockOpen = ref(true)
const quickInput = ref('')
const quickChatPending = ref(false)
// 流式回复占用气泡期间，忽略 emote speak 等外部气泡事件，避免覆盖正在展示的回复
const replyBubbleActive = ref(false)
const questionBubbleActive = computed(() => !!activeQuestion.value)
let submittedContent = ''
let replyRaw = ''

function clearBubbleTimer() {
    if (bubbleTimer !== null) {
        window.clearTimeout(bubbleTimer)
        bubbleTimer = null
    }
}

// CR-032：主动插件气泡预设注册表（样式类 + 停留时长节奏）
const BUBBLE_PRESETS: Record<string, {className: string; minMs: number; maxMs: number; perCharMs: number}> = {
    gentle_care: {className: 'pet-bubble--gentle', minMs: 3_400, maxMs: 6_500, perCharMs: 150},
    firm_nudge: {className: 'pet-bubble--firm', minMs: 3_000, maxMs: 5_600, perCharMs: 140},
    cheer: {className: 'pet-bubble--cheer', minMs: 2_600, maxMs: 5_000, perCharMs: 130},
}
const bubblePresetClass = ref('')

function showBubble(text: string, preset?: string) {
    if (!text.trim()) return
    bubbleText.value = text
    const presetConfig = preset ? BUBBLE_PRESETS[preset] : undefined
    bubblePresetClass.value = presetConfig?.className ?? ''
    clearBubbleTimer()
    // 展示时长与口型动画节奏一致（650ms ~ 5s；预设可覆盖节奏）
    const minMs = presetConfig?.minMs ?? 2_600
    const maxMs = presetConfig?.maxMs ?? 5_000
    const perCharMs = presetConfig?.perCharMs ?? 120
    bubbleTimer = window.setTimeout(() => {
        bubbleText.value = ''
        bubblePresetClass.value = ''
        bubbleTimer = null
    }, Math.min(maxMs, Math.max(minMs, text.length * perCharMs)))
}

/** 流式气泡：不设自动消失，由 onDone/onError 调度 */
function showStreamingBubble(text: string) {
    bubbleText.value = text
    bubblePresetClass.value = ''
    clearBubbleTimer()
}

function scheduleReplyDismiss(text: string) {
    clearBubbleTimer()
    bubbleTimer = window.setTimeout(() => {
        bubbleText.value = ''
        bubbleTimer = null
        replyBubbleActive.value = false
    }, replyBubbleDurationMs(text))
}

/** 点击气泡提前关闭（提问选择肢展示期间不关闭） */
function dismissBubble() {
    if (questionBubbleActive.value || pendingApproval.value || quickChatPending.value || turnState.value.retryAvailable) return
    clearBubbleTimer()
    bubbleText.value = ''
    bubbleTimer = null
    replyBubbleActive.value = false
}

async function sendQuickChat() {
    const content = quickInput.value.trim()
    if (!content || quickChatPending.value || interactionBusy.value) return
    submittedContent = content
    quickChatPending.value = true
    replyBubbleActive.value = true
    replyRaw = ''
    turnFeedback.value = ''
    playButtonPose('think')
    showStreamingBubble('思考中…')
    try {
        await turnController.submit(client.sessionId, content, quickChatCallbacks(), {
            signal: surfaceContext.signal,
            onAccepted() { if (quickInput.value.trim() === content) quickInput.value = '' },
        })
    } catch (err) {
        if (!surfaceContext.signal.aborted) showTurnFailure(err)
    } finally { quickChatPending.value = false }
}

function showTurnFailure(error: unknown) {
    turnFeedback.value = turnController.state.status === 'observer-error'
        ? '连接中断，已保留收到的回复。可恢复接收。'
        : turnController.state.turnId ? '本次回复未完成，已保留收到的内容。'
        : error instanceof Error ? `请求失败：${error.message}` : '请求失败，请重试。'
    if (replyRaw) showStreamingBubble(stripMarkdownForBubble(replyRaw))
    else if (!activeQuestion.value && !pendingApproval.value) showStreamingBubble('暂时没有收到回复。')
    clearBubbleTimer()
}

function quickChatCallbacks() { return {
    onDelta: (text: string) => {
        replyRaw += text
        showStreamingBubble(stripMarkdownForBubble(replyRaw) || '…')
    },
    onDone: () => {
        if (quickInput.value.trim() === submittedContent) quickInput.value = ''
        const finalText = stripMarkdownForBubble(replyRaw)
        if (finalText && !questionBubbleActive.value && !pendingApproval.value) showStreamingBubble(finalText)
        if (!pendingApproval.value && !activeQuestion.value) scheduleReplyDismiss(finalText || bubbleText.value)
    },
    onError: (error: unknown) => { throw error },
    onUserQuestion: (_data: UserQuestionRequiredEventData) => {
        window.aervoxLive2D?.playMotion('w-adult-think02')
        showStreamingBubble('等待你的回答')
    },
    onToolApproval: () => { showStreamingBubble('执行工具前需要你的确认。') },
} }

async function retryQuickChat() {
    if (quickChatPending.value || interactionBusy.value || !turnState.value.retryAvailable) return
    if (!turnState.value.turnId && quickInput.value.trim() !== submittedContent) { await sendQuickChat(); return }
    quickChatPending.value = true
    turnFeedback.value = ''
    if (!turnState.value.turnId) { replyRaw = ''; showStreamingBubble('思考中…') }
    try { await turnController.retry(quickChatCallbacks()) }
    catch (error) { if (!surfaceContext.signal.aborted) showTurnFailure(error) }
    finally { quickChatPending.value = false }
}

async function stopQuickChat() {
    if (stopping.value) return
    stopping.value = true
    try {
        await turnController.stop()
        if (turnController.state.status === 'stopped') {
            turnFeedback.value = '已停止回复。'
            if (!replyRaw) showStreamingBubble('已停止回复。')
            clearBubbleTimer()
        }
    } catch { turnFeedback.value = '停止失败，可以重试。' }
    finally { stopping.value = false }
}

async function decidePetApproval(decision: 'granted' | 'denied') {
    if (!pendingApproval.value || quickChatPending.value || interactionBusy.value) return
    quickChatPending.value = true
    turnFeedback.value = ''
    try { await turnController.decide(decision, quickChatCallbacks()) }
    catch (error) { if (!surfaceContext.signal.aborted) showTurnFailure(error) }
    finally { quickChatPending.value = false }
}

async function answerPetQuestion(answers: AskUserQuestionAnswerItem[]) {
    if (!activeQuestion.value || interactionBusy.value) return
    interactionBusy.value = true
    turnFeedback.value = ''
    try {
        await turnController.answer(answers)
        if (!turnController.state.question) {
            window.aervoxLive2D?.playMotion('w-normal-nod01')
            showStreamingBubble(replyRaw ? stripMarkdownForBubble(replyRaw) : '已提交回答，等待回复…')
        }
    } catch { turnFeedback.value = '回答提交失败，请重试。' }
    finally { interactionBusy.value = false }
}

/** dock 按钮 Live2D 响应：每个按钮绑定独立动作+表情池，随机取用避免连续重复 */
const lastPoseByKind: Partial<Record<PetButtonPoseKind, PetButtonPose>> = {}

function playButtonPose(kind: PetButtonPoseKind) {
    const pose = pickPetButtonPose(kind, lastPoseByKind[kind])
    lastPoseByKind[kind] = pose
    window.aervoxLive2D?.playPose(pose)
}

function playGreeting() {
    playButtonPose('greet')
    showBubble('嗨～我在这儿哦')
}

function playHappy() {
    playButtonPose('happy')
    showBubble('嘿嘿，开心！')
}

/** 关闭前先播放挥手告别的动作+表情，动画结束后再关窗 */
function closePet() {
    if (closingTimer !== null) return
    playButtonPose('farewell')
    showBubble('那下次再见啦～')
    closingTimer = window.setTimeout(() => surfaceContext.requestClose?.(), 1_600)
}

/** 展开/收起功能坞，两个方向各有独立的动作+表情响应 */
function toggleDock() {
    dockOpen.value = !dockOpen.value
    playButtonPose(dockOpen.value ? 'expand' : 'collapse')
}

const onBubble = (event: Event) => {
    if (replyBubbleActive.value || questionBubbleActive.value || pendingApproval.value) return
    const detail = (event as CustomEvent<string | {text?: string; preset?: string}>).detail
    const text = typeof detail === 'string' ? detail : detail?.text ?? ''
    const preset = typeof detail === 'string' ? undefined : detail?.preset
    showBubble(text, preset)
}

/** ui 共享 Live2DPet 的 speak 事件 → 桌宠窗口气泡（宿主职责，沿用 aervox:pet-bubble 窗口事件契约；CR-032 起可携带气泡预设） */
const onSpeak = (text: string, preset?: string) => {
    window.dispatchEvent(new CustomEvent('aervox:pet-bubble', {detail: {text, preset}}))
}

onMounted(() => {
    window.addEventListener('aervox:pet-bubble', onBubble)
})
onBeforeUnmount(() => {
    unsubscribeTurn()
    turnController.dispose()
    window.removeEventListener('aervox:pet-bubble', onBubble)
    clearBubbleTimer()
    if (closingTimer !== null) window.clearTimeout(closingTimer)
})
</script>

<template>
  <main class="pet-window">
    <transition name="pet-bubble-fade">
      <section
        v-if="bubbleText || activeQuestion || pendingApproval || turnFeedback"
        class="pet-bubble"
        :class="[{'pet-bubble-reply': replyBubbleActive}, bubblePresetClass]"
        aria-live="polite"
        @click.stop="dismissBubble"
      >
        <p>{{ bubbleText }}</p>
        <p v-if="turnFeedback" class="pet-turn-feedback" role="status">{{ turnFeedback }}</p>
        <div v-if="turnState.retryAvailable" class="pet-choices">
          <button type="button" :disabled="quickChatPending || interactionBusy" @click.stop="retryQuickChat">{{ turnState.status === 'observer-error' ? '恢复接收回复' : '重试发送' }}</button>
        </div>
        <div v-if="pendingApproval" class="pet-choices" aria-label="工具授权">
          <button type="button" :disabled="quickChatPending" @click.stop="decidePetApproval('granted')">批准</button>
          <button type="button" :disabled="quickChatPending" @click.stop="decidePetApproval('denied')">拒绝</button>
        </div>
        <div v-if="activeQuestion" class="pet-question" @click.stop>
          <UserQuestionComposer :question-data="activeQuestion" :submitting="interactionBusy" @submit="answerPetQuestion" />
        </div>
      </section>
    </transition>
    <div class="pet-stage">
      <div class="pet-character">
        <PetWithFallback @on-speak="onSpeak" />
      </div>
    </div>
    <!-- 底部常驻条：快捷输入 + 展开/收起按钮；功能坞向上展开 -->
    <div class="pet-dock-wrap">
      <transition name="pet-dock-slide">
        <nav v-show="dockOpen" class="pet-dock" aria-label="桌宠基础操作">
          <button class="pet-dock-btn" type="button" @click.stop="playGreeting">
            <Hand :size="16"/>
            <span>打招呼</span>
          </button>
          <button class="pet-dock-btn" type="button" @click.stop="playHappy">
            <Smile :size="16"/>
            <span>开心</span>
          </button>
          <button class="pet-dock-btn pet-dock-btn-close" type="button" @click.stop="closePet">
            <X :size="16"/>
            <span>关闭</span>
          </button>
        </nav>
      </transition>
      <div class="pet-dock-bar">
        <input
          v-model="quickInput"
          class="pet-quick-input"
          type="text"
          :placeholder="quickChatPending ? '思考中…' : '和我聊聊，回车发送'"
          :disabled="quickChatPending"
          aria-label="桌宠快捷对话输入"
          @keydown.enter.prevent="sendQuickChat"
        />
        <button v-if="canStop" type="button" class="pet-dock-btn pet-stop" :disabled="stopping" @click.stop="stopQuickChat">{{ stopping ? '停止中' : '停止' }}</button>
        <button
          class="pet-dock-btn pet-dock-toggle"
          type="button"
          :aria-expanded="dockOpen"
          :aria-label="dockOpen ? '收起功能坞' : '展开功能坞'"
          @click.stop="toggleDock"
        >
          <ChevronDown v-if="dockOpen" :size="16"/>
          <ChevronUp v-else :size="16"/>
        </button>
      </div>
    </div>
  </main>
</template>
