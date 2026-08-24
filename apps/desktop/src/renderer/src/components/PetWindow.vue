<script setup lang="ts">
import {ref} from 'vue'
import {Flame, Heart, MessageCircle, Moon, Sparkles} from 'lucide-vue-next'

const enabled = ref(true)
const mood = ref('心情不错')
const bubble = ref('今天也要元气满满！')
const petActions = [{label: '摸一摸', icon: Heart, text: '摸摸我～'}, {
  label: '喂能量',
  icon: Flame,
  text: '好耶！继续出发～'
}, {label: '安静', icon: Moon, text: '我会安静陪着你。'}]

function act(text: string) {
  bubble.value = text
  mood.value = text.includes('安静') ? '安静陪伴中' : '心情超好'
}
</script>

<template>
  <main class="pet-window" :class="{ muted: !enabled }">
    <div class="pet-stage">
      <Sparkles class="sparkle sparkle-a" :size="18"/>
      <Sparkles class="sparkle sparkle-b" :size="16"/>
      <div class="pet-shadow"/>
      <div class="pet-character" @click="act('被发现啦！')">
        <div class="pet-wing wing-left"/>
        <div class="pet-wing wing-right"/>
        <div class="pet-head"><span class="ear ear-left"/><span class="ear ear-right"/><span class="hair">⌁</span><span
            class="eye eye-left"/><span class="eye eye-right"/><span class="cheek cheek-left"/><span
            class="cheek cheek-right"/><span class="mouth">⌣</span></div>
        <div class="pet-body"><span class="pet-collar"/><span class="pet-star">✦</span></div>
        <div class="pet-foot foot-left"/>
        <div class="pet-foot foot-right"/>
      </div>
      <div class="mood-bubble">{{ bubble }}</div>
    </div>
    <section class="pet-card">
      <div class="pet-card-header"><span><Sparkles :size="17"/><span>{{ mood }}</span></span>
        <el-switch v-model="enabled" size="small"/>
      </div>
      <div class="pet-actions">
        <button v-for="action in petActions" :key="action.label" class="pet-action" @click="act(action.text)">
          <component :is="action.icon" :size="19" :stroke-width="2"/>
          <small>{{ action.label }}</small></button>
      </div>
      <div class="pet-card-footer">
        <MessageCircle :size="18"/>
        <span class="pet-footer-label">桌面陪伴 · 始终置顶</span></div>
    </section>
  </main>
</template>
