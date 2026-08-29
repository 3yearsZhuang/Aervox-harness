<script setup lang="ts">
import {ChevronDown, ChevronUp, Hand, Smile, X} from 'lucide-vue-next'
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {PetHero} from '@aervox/ui'
import {streamAervoxTurn, submitQuestionAnswers} from '@aervox/api-client'
import type {AskUserQuestionAnswerItem, UserQuestionRequiredEventData} from '@aervox/contracts'
import {replyBubbleDurationMs, stripMarkdownForBubble} from '../quick-chat'
import {pickPetButtonPose, type PetButtonPose, type PetButtonPoseKind} from '../pet-button-poses'
import Live2DPet from './Live2DPet.vue'

const bubbleText = ref('')
const activeQuestion = ref<UserQuestionRequiredEventData | null>(null)
let bubbleTimer: number | null = null
let closingTimer: number | null = null

// 快捷对话状态：dock 展开开关为内存态（刷新回落展开，不写 localStorage）
const dockOpen = ref(true)
const quickInput = ref('')
const quickChatPending = ref(false)
// 流式回复占用气泡期间，忽略 emote speak 等外部气泡事件，避免覆盖正在展示的回复
const replyBubbleActive = ref(false)
const questionBubbleActive = ref(false)
let replyRaw = ''

function clearBubbleTimer() {
    if (bubbleTimer !== null) {
        window.clearTimeout(bubbleTimer)
        bubbleTimer = null
    }
}

function showBubble(text: string) {
    if (!text.trim()) return
    bubbleText.value = text
    clearBubbleTimer()
    // 展示时长与口型动画节奏一致（650ms ~ 5s）
    bubbleTimer = window.setTimeout(() => {
        bubbleText.value = ''
        bubbleTimer = null
    }, Math.min(5_000, Math.max(2_600, text.length * 120)))
}

/** 流式气泡：不设自动消失，由 onDone/onError 调度 */
function showStreamingBubble(text: string) {
    bubbleText.value = text
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
    if (questionBubbleActive.value) return
    clearBubbleTimer()
    bubbleText.value = ''
    bubbleTimer = null
    replyBubbleActive.value = false
}

async function sendQuickChat() {
    const content = quickInput.value.trim()
    if (!content || quickChatPending.value) return
    quickInput.value = ''
    quickChatPending.value = true
    replyBubbleActive.value = true
    replyRaw = ''
    playButtonPose('think')
    showStreamingBubble('思考中…')
    try {
        await streamAervoxTurn(content, {
            onDelta: (text) => {
                replyRaw += text
                showStreamingBubble(stripMarkdownForBubble(replyRaw) || '…')
            },
            onDone: () => {
                const finalText = stripMarkdownForBubble(replyRaw)
                if (finalText && !questionBubbleActive.value) showStreamingBubble(finalText)
                scheduleReplyDismiss(finalText || bubbleText.value)
            },
            onError: (err) => {
                const message = err instanceof Error ? err.message : '回复失败，请稍后再试'
                showStreamingBubble(`出了点小问题：${message}`)
                scheduleReplyDismiss(`出了点小问题：${message}`)
            },
            onUserQuestion: (data) => {
                questionBubbleActive.value = true
                handleQuestionPrompt(data)
            },
            onToolApproval: () => {
                showStreamingBubble('这个请求需要到工作台确认工具使用哦')
                scheduleReplyDismiss('这个请求需要到工作台确认工具使用哦')
            },
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Aervox 请求失败'
        showStreamingBubble(`出了点小问题：${message}`)
        scheduleReplyDismiss(`出了点小问题：${message}`)
    } finally {
        quickChatPending.value = false
    }
}

function handleQuestionPrompt(qData: UserQuestionRequiredEventData) {
    activeQuestion.value = qData
    const firstQ = qData.questions[0]
    if (firstQ) {
        window.aervoxLive2D?.playMotion('w-adult-think02')
        showBubble(firstQ.question)
    }
}

async function selectPetOption(questionId: string, optionLabel: string) {
    if (!activeQuestion.value) return
    window.aervoxLive2D?.playMotion('w-normal-nod01')
    const answers: AskUserQuestionAnswerItem[] = [{
        id: questionId,
        selected: [optionLabel],
    }]
    try {
        await submitQuestionAnswers(activeQuestion.value.turnId, answers)
        activeQuestion.value = null
        questionBubbleActive.value = false
        showBubble(`已确认：${optionLabel}`)
    } catch (err) {
        console.error('桌宠提问回答提交失败', err)
    }
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
    closingTimer = window.setTimeout(() => window.close(), 1_600)
}

/** 展开/收起功能坞，两个方向各有独立的动作+表情响应 */
function toggleDock() {
    dockOpen.value = !dockOpen.value
    playButtonPose(dockOpen.value ? 'expand' : 'collapse')
}

const onBubble = (event: Event) => {
    if (replyBubbleActive.value || questionBubbleActive.value) return
    showBubble((event as CustomEvent<string>).detail ?? '')
}
const onPetQuestion = (event: Event) => handleQuestionPrompt((event as CustomEvent<UserQuestionRequiredEventData>).detail)

onMounted(() => {
    window.addEventListener('aervox:pet-bubble', onBubble)
    window.addEventListener('aervox:pet-question', onPetQuestion)
})
onBeforeUnmount(() => {
    window.removeEventListener('aervox:pet-bubble', onBubble)
    window.removeEventListener('aervox:pet-question', onPetQuestion)
    clearBubbleTimer()
    if (closingTimer !== null) window.clearTimeout(closingTimer)
})
</script>

<template>
  <main class="pet-window">
    <transition name="pet-bubble-fade">
      <section
        v-if="bubbleText"
        class="pet-bubble"
        :class="{'pet-bubble-reply': replyBubbleActive}"
        aria-live="polite"
        @click.stop="dismissBubble"
      >
        <p>{{ bubbleText }}</p>
        <!-- VN 分支选择肢 -->
        <div v-if="activeQuestion && activeQuestion.questions[0]?.options" class="pet-choices">
          <button
            v-for="opt in activeQuestion.questions[0].options"
            :key="opt.label"
            type="button"
            class="pet-choice-btn"
            @click.stop="selectPetOption(activeQuestion.questions[0].id, opt.label)"
          >
            <span>{{ opt.label }}</span>
          </button>
        </div>
      </section>
    </transition>
    <div class="pet-stage">
      <div class="pet-character">
        <Live2DPet>
          <template #fallback>
            <span class="pet-hero-scale"><PetHero /></span>
          </template>
        </Live2DPet>
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
