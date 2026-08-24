<script setup lang="ts">
import {computed, onMounted, onUnmounted, ref} from 'vue'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  LayoutGrid,
  ListTodo,
  MessageCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  TimerReset,
  X,
} from 'lucide-vue-next'
import AppTitlebar from '@/components/AppTitlebar.vue'
import {streamAervoxTurn} from '@/composables/useAervoxTurn'

interface StoryLine {
  id: number
  speaker: 'fairy' | 'user'
  text: string
  fullText?: string
  revealed: boolean
}

const toolsOpen = ref(false)
const suggestionsOpen = ref(true)
const composerOpen = ref(true)
const historyOpen = ref(false)
const todoOpen = ref(false)
const timerOpen = ref(false)
const input = ref('')
const timerSeconds = ref(25 * 60)
const timerRunning = ref(false)
const newTodo = ref('')
const todos = ref([
  {id: 1, text: '确认周末的旅行路线', done: false},
  {id: 2, text: '给小精灵补充能量', done: true},
])
const story = ref<StoryLine[]>([
  {id: 1, speaker: 'fairy', text: '早上好，Moe。今天想让我陪你做什么？', revealed: true},
  {
    id: 2,
    speaker: 'fairy',
    text: '我可以陪你规划旅行、整理想法，也可以安静地待在这里。',
    fullText: '我可以陪你规划旅行、整理想法，也可以安静地待在这里。如果你愿意，我们还可以一起把今天最重要的一件事完成。',
    revealed: false,
  },
])

const currentLine = computed(() => story.value[story.value.length - 1])
const unfinishedTodos = computed(() => todos.value.filter((todo) => !todo.done))
const formattedTime = computed(() => {
  const minutes = String(Math.floor(timerSeconds.value / 60)).padStart(2, '0')
  const seconds = String(timerSeconds.value % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
const suggestions = ['帮我规划一次旅行', '把今天安排得更有条理', '我想找个人聊聊']

function advanceStory() {
  const line = currentLine.value
  if (line.fullText && !line.revealed) {
    line.text = line.fullText
    line.revealed = true
    return
  }
  story.value.push({id: Date.now(), speaker: 'fairy', text: '那就从现在开始吧。我会一直在这里。', revealed: true})
}

async function sendMessage(value = input.value) {
  const text = value.trim()
  if (!text) return
  const assistantLine: StoryLine = {id: Date.now() + 1, speaker: 'fairy', text: '正在连接 Aervox…', revealed: true}
  story.value.push({id: Date.now(), speaker: 'user', text, revealed: true}, assistantLine)
  input.value = ''
  composerOpen.value = true
  try {
    await streamAervoxTurn(text, {
      onDelta: (delta) => {
        if (assistantLine.text === '正在连接 Aervox…') assistantLine.text = ''
        assistantLine.text += delta
      },
      onDone: (done) => {
        if (!assistantLine.text) {
          assistantLine.text = done.status === 'Completed'
            ? '本次 Turn 已完成，但当前服务没有返回可展示的正文。'
            : `本次 Turn 以「${done.status}」结束。`
        }
      },
    })
  } catch (error) {
    assistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。'
  }
}

function addTodo() {
  const text = newTodo.value.trim()
  if (!text) return
  todos.value.unshift({id: Date.now(), text, done: false})
  newTodo.value = ''
}

function toggleTimer() {
  timerRunning.value = !timerRunning.value
}

function resetTimer() {
  timerRunning.value = false
  timerSeconds.value = 25 * 60
}

let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => {
    if (timerRunning.value && timerSeconds.value > 0) timerSeconds.value -= 1
    if (timerSeconds.value === 0) timerRunning.value = false
  }, 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="window-shell pet-centric-shell">
    <AppTitlebar />

    <main class="pet-centric-main">
      <section class="companion-column" aria-label="桌宠区域">
        <section class="pet-hero" :class="{'tools-open': toolsOpen}">
          <div class="pet-identity">
            <span class="identity-dot" />
            <span><strong>Fairy</strong><small>在线陪伴</small></span>
          </div>

          <div class="hero-pet-stage">
            <button class="hero-pet" type="button" aria-label="打开桌宠工具菜单" @click="toolsOpen = !toolsOpen">
              <span class="hero-wing wing-left" />
              <span class="hero-wing wing-right" />
              <span class="hero-head">
                <span class="hero-ear ear-left" />
                <span class="hero-ear ear-right" />
                <span class="hero-hair">⌁</span>
                <span class="hero-eye eye-left" />
                <span class="hero-eye eye-right" />
                <span class="hero-cheek cheek-left" />
                <span class="hero-cheek cheek-right" />
                <span class="hero-mouth">⌣</span>
              </span>
              <span class="hero-body"><span class="hero-collar" /></span>
              <span class="hero-foot foot-left" />
              <span class="hero-foot foot-right" />
            </button>
            <div class="pet-speech">今天想一起做什么？</div>
          </div>

          <div class="pet-tool-menu" :class="{open: toolsOpen}">
            <div class="pet-tool-menu-head">
              <span>桌宠工具</span>
              <button type="button" aria-label="关闭工具菜单" @click="toolsOpen = false"><X :size="18" /></button>
            </div>
            <button class="tool-menu-item" type="button" @click="todoOpen = true">
              <span class="tool-icon"><ListTodo :size="22" /></span>
              <span><strong>待办清单</strong><small>{{ unfinishedTodos.length }} 件待完成</small></span>
            </button>
            <button class="tool-menu-item" type="button" @click="timerOpen = true">
              <span class="tool-icon"><Clock3 :size="22" /></span>
              <span><strong>番茄钟</strong><small>{{ formattedTime }} 专注计时</small></span>
            </button>
            <button class="tool-menu-item" type="button" @click="historyOpen = true">
              <span class="tool-icon"><History :size="22" /></span>
              <span><strong>对话回看</strong><small>{{ story.length }} 段剧情记录</small></span>
            </button>
          </div>

          <button class="pet-menu-toggle" type="button" @click="toolsOpen = !toolsOpen">
            <LayoutGrid :size="20" />
            <span>桌宠菜单</span>
            <ChevronUp v-if="toolsOpen" :size="17" />
            <ChevronDown v-else :size="17" />
          </button>
        </section>

        <section class="companion-status-card">
          <span class="status-icon"><Sparkles :size="21" /></span>
          <span><small>当前状态</small><strong>精力充沛，随时可以陪你</strong></span>
          <span class="energy-bars" aria-label="精力值 80%"><i /><i /><i /><i /><i class="empty" /></span>
        </section>
      </section>

      <section class="dialogue-column" aria-label="剧情对话区域">
        <section class="story-dialog">
          <div class="story-dialog-top">
            <span class="story-label"><MessageCircle :size="19" />Fairy 的故事</span>
            <button class="dialog-history" type="button" @click="historyOpen = true"><History :size="18" />完整记录</button>
          </div>

          <div class="story-content">
            <div class="story-speaker">
              <span class="speaker-mark"><Sparkles :size="18" /></span>
              <span><small>正在与你对话</small><strong>{{ currentLine.speaker === 'fairy' ? 'Fairy' : '你' }}</strong></span>
              <span class="speaker-line" />
            </div>
            <p class="story-text">{{ currentLine.text }}</p>
            <div class="story-actions">
              <button v-if="currentLine.fullText && !currentLine.revealed" class="next-line" type="button" @click="advanceStory">
                继续阅读<ChevronDown :size="19" />
              </button>
              <button v-else class="next-line subtle" type="button" @click="advanceStory">
                下一句<ChevronDown :size="19" />
              </button>
              <button class="read-all" type="button" @click="historyOpen = true"><History :size="18" />展开全文</button>
            </div>
          </div>

          <div class="story-progress">
            <span><i /></span>
            <small>{{ story.length }} 段对话</small>
          </div>
        </section>

        <section class="interaction-area">
          <header class="interaction-heading">
            <span><Sparkles :size="20" /><span><small>继续这段故事</small><strong>你想对 Fairy 说什么？</strong></span></span>
          </header>

          <section class="interaction-block suggestion-block">
            <button class="collapse-trigger" type="button" @click="suggestionsOpen = !suggestionsOpen">
              <span>推荐话题</span>
              <ChevronUp v-if="suggestionsOpen" :size="19" />
              <ChevronDown v-else :size="19" />
            </button>
            <div v-if="suggestionsOpen" class="suggestions">
              <button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="sendMessage(suggestion)">
                <span>{{ suggestion }}</span><Send :size="17" />
              </button>
            </div>
          </section>

          <section class="interaction-block composer-block">
            <button class="collapse-trigger" type="button" @click="composerOpen = !composerOpen">
              <span>自由输入</span>
              <ChevronUp v-if="composerOpen" :size="19" />
              <ChevronDown v-else :size="19" />
            </button>
            <form v-if="composerOpen" class="story-composer" @submit.prevent="sendMessage()">
              <textarea v-model="input" rows="2" placeholder="告诉 Fairy 你此刻在想什么…" @keydown.enter.exact.prevent="sendMessage()" />
              <button type="submit" :disabled="!input.trim()" aria-label="发送消息"><Send :size="22" /></button>
            </form>
          </section>
        </section>
      </section>

      <aside class="utility-rail" aria-label="今日工具面板">
        <header class="rail-heading">
          <span><LayoutGrid :size="20" />今日面板</span>
          <small>常用工具一览</small>
        </header>

        <section class="utility-card focus-card">
          <div class="utility-card-head">
            <span class="utility-card-icon"><Clock3 :size="21" /></span>
            <span><small>番茄钟</small><strong>{{ timerRunning ? '正在专注' : '准备开始' }}</strong></span>
            <button type="button" aria-label="打开番茄钟" @click="timerOpen = true"><ChevronUp :size="18" /></button>
          </div>
          <div class="compact-timer">
            <strong>{{ formattedTime }}</strong>
            <span><i :class="{running: timerRunning}" /></span>
          </div>
          <div class="compact-actions">
            <button class="primary" type="button" @click="toggleTimer">
              <Pause v-if="timerRunning" :size="19" /><Play v-else :size="19" />{{ timerRunning ? '暂停' : '开始专注' }}
            </button>
            <button type="button" aria-label="重置计时器" @click="resetTimer"><RotateCcw :size="19" /></button>
          </div>
        </section>

        <section class="utility-card todo-preview">
          <div class="utility-card-head">
            <span class="utility-card-icon"><ListTodo :size="21" /></span>
            <span><small>待办清单</small><strong>{{ unfinishedTodos.length }} 件待完成</strong></span>
            <button type="button" aria-label="打开待办清单" @click="todoOpen = true"><ChevronUp :size="18" /></button>
          </div>
          <div class="compact-todo-list">
            <label v-for="todo in todos.slice(0, 3)" :key="todo.id" :class="{done: todo.done}">
              <input v-model="todo.done" type="checkbox" />
              <span>{{ todo.text }}</span>
              <Check v-if="todo.done" :size="17" />
            </label>
          </div>
          <button class="add-todo-entry" type="button" @click="todoOpen = true"><Plus :size="18" />添加待办</button>
        </section>

        <button class="history-entry" type="button" @click="historyOpen = true">
          <span class="utility-card-icon"><History :size="21" /></span>
          <span><small>剧情档案</small><strong>查看完整对话</strong></span>
          <span class="history-count">{{ story.length }}</span>
        </button>
      </aside>
    </main>

    <el-drawer v-model="historyOpen" title="对话回看" direction="rtl" size="min(420px, 90vw)">
      <div class="history-list">
        <article v-for="line in story" :key="line.id" :class="line.speaker">
          <span>{{ line.speaker === 'fairy' ? 'Fairy' : '你' }}</span>
          <p>{{ line.fullText ?? line.text }}</p>
        </article>
      </div>
    </el-drawer>

    <el-drawer v-model="todoOpen" title="待办清单" direction="rtl" size="min(380px, 88vw)">
      <form class="todo-form" @submit.prevent="addTodo">
        <input v-model="newTodo" placeholder="添加一件小事" />
        <button type="submit" aria-label="添加待办"><Plus :size="20" /></button>
      </form>
      <div class="todo-list">
        <label v-for="todo in todos" :key="todo.id" class="todo-item" :class="{done: todo.done}">
          <input v-model="todo.done" type="checkbox" />
          <span>{{ todo.text }}</span>
          <Check v-if="todo.done" :size="18" />
        </label>
      </div>
    </el-drawer>

    <el-drawer v-model="timerOpen" title="番茄钟" direction="rtl" size="min(380px, 88vw)">
      <div class="timer-panel">
        <div class="timer-ring"><strong>{{ formattedTime }}</strong><small>专注时间</small></div>
        <div class="timer-actions">
          <button type="button" @click="toggleTimer"><Pause v-if="timerRunning" :size="20" /><Play v-else :size="20" />{{ timerRunning ? '暂停' : '开始专注' }}</button>
          <button type="button" @click="resetTimer"><TimerReset :size="20" />重置</button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>
