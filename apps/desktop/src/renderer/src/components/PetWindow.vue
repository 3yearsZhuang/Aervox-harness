<script setup lang="ts">
import {Hand, Smile, X, Check} from 'lucide-vue-next'
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {PetHero} from '@aervox/ui'
import {submitQuestionAnswers} from '@aervox/api-client'
import type {AskUserQuestionAnswerItem, UserQuestionRequiredEventData} from '@aervox/contracts'
import Live2DPet from './Live2DPet.vue'

const bubbleText = ref('')
const activeQuestion = ref<UserQuestionRequiredEventData | null>(null)
let bubbleTimer: number | null = null

function showBubble(text: string) {
    if (!text.trim()) return
    bubbleText.value = text
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer)
    // 展示时长与口型动画节奏一致（650ms ~ 5s）
    bubbleTimer = window.setTimeout(() => {
        bubbleText.value = ''
        bubbleTimer = null
    }, Math.min(5_000, Math.max(2_600, text.length * 120)))
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
        showBubble(`已确认：${optionLabel}`)
    } catch (err) {
        console.error('桌宠提问回答提交失败', err)
    }
}

function playGreeting() {
    window.aervoxLive2D?.playMotion('w-normal-greeting01')
    showBubble('嗨～我在这儿哦')
}

function playHappy() {
    window.aervoxLive2D?.playExpression('face_smile_01')
    showBubble('嘿嘿，开心！')
}

function closePet() {
    window.close()
}

const onBubble = (event: Event) => showBubble((event as CustomEvent<string>).detail ?? '')
const onPetQuestion = (event: Event) => handleQuestionPrompt((event as CustomEvent<UserQuestionRequiredEventData>).detail)

onMounted(() => {
    window.addEventListener('aervox:pet-bubble', onBubble)
    window.addEventListener('aervox:pet-question', onPetQuestion)
})
onBeforeUnmount(() => {
    window.removeEventListener('aervox:pet-bubble', onBubble)
    window.removeEventListener('aervox:pet-question', onPetQuestion)
})
</script>

<template>
  <main class="pet-window">
    <transition name="pet-bubble-fade">
      <section v-if="bubbleText" class="pet-bubble" aria-live="polite">
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
    <nav class="pet-dock" aria-label="桌宠基础操作">
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
  </main>
</template>
