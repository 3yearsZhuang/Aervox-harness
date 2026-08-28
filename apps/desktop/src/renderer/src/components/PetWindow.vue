<script setup lang="ts">
import {Hand, Smile, X} from 'lucide-vue-next'
import {onBeforeUnmount, onMounted, ref} from 'vue'
import {PetHero} from '@aervox/ui'
import Live2DPet from './Live2DPet.vue'

const bubbleText = ref('')
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

onMounted(() => window.addEventListener('aervox:pet-bubble', onBubble))
onBeforeUnmount(() => window.removeEventListener('aervox:pet-bubble', onBubble))
</script>

<template>
  <main class="pet-window">
    <transition name="pet-bubble-fade">
      <section v-if="bubbleText" class="pet-bubble" aria-live="polite">
        <p>{{ bubbleText }}</p>
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
