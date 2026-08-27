<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref} from 'vue'
import {
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Clock3,
  Copy,
  Heart,
  History,
  LayoutGrid,
  ListTodo,
  MessageCircle,
  Moon,
  Pause,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Sun,
  Volume2,
  TimerReset,
  X,
} from 'lucide-vue-next'
import {streamAervoxTurn, useAervoxApi} from '@aervox/api-client'
import PetHero from './PetHero.vue'
import PluginManagerPanel from './plugin/PluginManagerPanel.vue'
import Live2DPet from './Live2DPet.vue'
import PersonaManagerPanel from './persona/PersonaManagerPanel.vue'
import LocalVoiceConfigPanel from './voice/LocalVoiceConfigPanel.vue'

type Platform = 'desktop' | 'web'
type Speaker = 'assistant' | 'user'

interface StoryLine {
  id: number
  speaker: Speaker
  text: string
  state?: 'streaming' | 'complete' | 'error'
}

const props = withDefaults(defineProps<{
  platform?: Platform
  showCompanion?: boolean
  assistantName?: string
}>(), {
  platform: 'web',
  showCompanion: false,
  assistantName: '思隅',
})

const toolsOpen = ref(false)
const composerOpen = ref(true)
const historyOpen = ref(false)
const todoOpen = ref(false)
const timerOpen = ref(false)
const studyOpen = ref(false)
const settingsOpen = ref(false)
const settingsCategory = ref<'appearance' | 'conversation' | 'persona' | 'focus' | 'notifications' | 'voice' | 'plugins'>('appearance')
const newGoalTopic = ref('')
const newGoalLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner')
const newGoalMinutes = ref(25)
const showArchivedGoals = ref(false)
const goalBusyId = ref<string | null>(null)
const practiceSession = ref<{sessionId: string; items: Array<{id: string; prompt: string}>} | null>(null)
const practiceIndex = ref(0)
const practiceAnswer = ref('')
const practiceFeedback = ref<{judgement: string; nextStep: string} | null>(null)
const practiceReport = ref<{answeredCount: number; questionCount: number; remainingCount: number; correctCount: number; incorrectCount: number; unverifiableCount: number; accuracy: number | null; nextStep: string} | null>(null)
const practiceBusy = ref(false)
const practiceError = ref<string | null>(null)
const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active')
const selectedMistakeIds = ref<string[]>([])
const mistakeBusyId = ref<string | null>(null)
const reviewBusyId = ref<string | null>(null)
const input = ref('')
const timerSeconds = ref(25 * 60)
const timerRunning = ref(false)
const streaming = ref(false)
const copied = ref(false)
const isDark = ref(false)
const assistantDisplayName = ref(props.assistantName)
const enterToSend = ref(true)
const compactMode = ref(false)
const timerMinutes = ref(25)
const desktopCompanionEnabled = ref(props.showCompanion)
const dailyReminder = ref(true)
const newTodo = ref('')
const storyViewport = ref<HTMLElement | null>(null)
const todos = ref<Array<{id: number; text: string; done: boolean}>>([])
const story = ref<StoryLine[]>([
  {
    id: 1,
    speaker: 'assistant',
    text: '你好，我是思隅。告诉我你正在学什么，或者把卡住的地方直接发来，我们一起拆成下一步。',
    state: 'complete',
  },
])
const api = useAervoxApi()
const {
  goals,
  dueReviews,
  completedReviews,
  mistakes,
  notifications,
  todayDiary,
  error: apiError,
} = api
let nextStoryId = 2

const isWeb = computed(() => props.platform === 'web')
// Web always presents its companion card; the desktop-only preference must not
// leak through shared localStorage and hide the Web companion.
const showCompanionEnabled = computed(() => props.showCompanion && (isWeb.value || desktopCompanionEnabled.value))
const currentLine = computed(() => story.value.at(-1) ?? null)
const currentAssistantLine = computed(() => [...story.value].reverse().find((line) => line.speaker === 'assistant') ?? null)
const unfinishedTodos = computed(() => todos.value.filter((todo) => !todo.done))
const completedTodoCount = computed(() => todos.value.length - unfinishedTodos.value.length)
const formattedTime = computed(() => {
  const minutes = String(Math.floor(timerSeconds.value / 60)).padStart(2, '0')
  const seconds = String(timerSeconds.value % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
const settingCategories = [
  {id: 'appearance', label: '外观', description: '主题与界面密度', icon: Sun},
  {id: 'conversation', label: '对话', description: '称呼与输入方式', icon: MessageCircle},
  {id: 'persona', label: '人格设定', description: '管理人格角色设定', icon: Heart},
  {id: 'focus', label: '专注', description: '番茄钟工作时长', icon: Clock3},
  {id: 'notifications', label: '提醒', description: '学习节奏与通知', icon: Bell},
  {id: 'voice', label: '语音', description: '本地语音模型配置', icon: Volume2},
  {id: 'plugins', label: '插件', description: '插件配置与页面', icon: Puzzle},
] as const
const workbenchState = computed(() => {
  if (streaming.value) return '正在思考并组织回答'
  if (currentLine.value?.state === 'error') return '连接遇到问题，可以重新发送'
  return '随时可以开始今天的学习'
})
const suggestions = [
  '帮我把今天的学习目标拆小一点',
  '解释一下递归，但先不要直接给答案',
  '用 10 分钟带我复习二分查找',
]

function createStoryLine(speaker: Speaker, text: string, state: StoryLine['state'] = 'complete'): StoryLine {
  return {id: nextStoryId++, speaker, text, state}
}

async function scrollStoryToBottom() {
  await nextTick()
  storyViewport.value?.scrollTo({top: storyViewport.value.scrollHeight, behavior: 'smooth'})
}

async function sendMessage(value = input.value) {
  const text = value.trim()
  if (!text || streaming.value) return

  const assistantLine = createStoryLine('assistant', '', 'streaming')
  story.value.push(createStoryLine('user', text), assistantLine)
  input.value = ''
  composerOpen.value = true
  streaming.value = true
  await scrollStoryToBottom()

  try {
    await streamAervoxTurn(text, {
      onDelta: (delta) => {
        assistantLine.text += delta
        void scrollStoryToBottom()
      },
      onDone: () => {
        assistantLine.state = 'complete'
        if (!assistantLine.text) assistantLine.text = '这次没有收到可展示的回答，请再试一次。'
      },
    })
  } catch (error) {
    assistantLine.state = 'error'
    assistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。'
  } finally {
    streaming.value = false
    await scrollStoryToBottom()
  }
}

function addTodo() {
  const text = newTodo.value.trim()
  if (!text) return
  todos.value.unshift({id: Date.now(), text, done: false})
  newTodo.value = ''
}

async function submitNewGoal() {
  const topic = newGoalTopic.value.trim()
  if (!topic) return
  try {
    await api.createGoal({topic, level: newGoalLevel.value, availableMinutes: newGoalMinutes.value})
    newGoalTopic.value = ''
    newGoalLevel.value = 'beginner'
    newGoalMinutes.value = 25
  } catch (error) {
    console.error('创建学习目标失败', error)
  }
}

function goalStatusLabel(status: string) {
  return ({active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档'} as Record<string, string>)[status] ?? status
}

async function reloadGoals() {
  await api.loadAll(showArchivedGoals.value)
}

async function setGoalStatus(goalId: string, status: 'active' | 'paused' | 'completed') {
  goalBusyId.value = goalId
  try {
    await api.updateGoal(goalId, {status})
    await reloadGoals()
  } catch (error) {
    console.error('更新学习目标失败', error)
  } finally {
    goalBusyId.value = null
  }
}

async function archiveGoal(goalId: string) {
  if (!window.confirm('归档后目标将从默认列表隐藏，但学习记录仍会保留。确定归档吗？')) return
  goalBusyId.value = goalId
  try {
    await api.archiveGoal(goalId)
    await reloadGoals()
  } catch (error) {
    console.error('归档学习目标失败', error)
  } finally {
    goalBusyId.value = null
  }
}

const currentPracticeQuestion = computed(() => practiceSession.value?.items[practiceIndex.value] ?? null)
const visibleMistakes = computed(() => mistakes.value.filter((item) => mistakeFilter.value === 'all' || item.status === mistakeFilter.value))

async function startPractice() {
  practiceBusy.value = true
  practiceError.value = null
  practiceReport.value = null
  practiceFeedback.value = null
  try {
    practiceSession.value = await api.startPracticeSession()
    practiceIndex.value = 0
    practiceAnswer.value = ''
  } catch (error) {
    practiceError.value = error instanceof Error ? '当前没有可练习的题目，请先创建题目。' : '启动练习失败，请稍后再试。'
  } finally {
    practiceBusy.value = false
  }
}

async function submitPracticeAnswer() {
  const question = currentPracticeQuestion.value
  const answer = practiceAnswer.value.trim()
  if (!practiceSession.value || !question || !answer || practiceBusy.value) return
  practiceBusy.value = true
  practiceError.value = null
  try {
    practiceFeedback.value = await api.submitPracticeAnswer(practiceSession.value.sessionId, question.id, answer)
  } catch (error) {
    practiceError.value = error instanceof Error ? '作答没有保存，请重试。' : '作答失败，请重试。'
  } finally {
    practiceBusy.value = false
  }
}

async function finishPractice() {
  if (!practiceSession.value) return
  practiceBusy.value = true
  practiceError.value = null
  try {
    practiceReport.value = await api.completePracticeSession(practiceSession.value.sessionId)
    practiceFeedback.value = null
    await api.loadAll(showArchivedGoals.value)
  } catch {
    practiceError.value = '暂时无法生成练习报告，请稍后再试。'
  } finally {
    practiceBusy.value = false
  }
}

async function startMistakePractice() {
  const activeIds = mistakes.value.filter((item) => item.status === 'active').map((item) => item.questionId)
  const questionIds = (selectedMistakeIds.value.length ? selectedMistakeIds.value : activeIds).slice(0, 5)
  if (!questionIds.length) {
    practiceError.value = '当前没有可重练的错题。'
    return
  }
  practiceBusy.value = true
  practiceError.value = null
  practiceReport.value = null
  practiceFeedback.value = null
  try {
    practiceSession.value = await api.startMistakePractice(questionIds)
    practiceIndex.value = 0
    practiceAnswer.value = ''
    selectedMistakeIds.value = []
  } catch {
    practiceError.value = '错题重练启动失败，请刷新后重试。'
  } finally {
    practiceBusy.value = false
  }
}

async function setMistakeStatus(questionId: string, status: 'active' | 'mastered' | 'dismissed') {
  mistakeBusyId.value = questionId
  try {
    await api.setMistakeStatus(questionId, status)
    selectedMistakeIds.value = selectedMistakeIds.value.filter((id) => id !== questionId)
  } catch {
    practiceError.value = '错题状态没有保存，请稍后重试。'
  } finally {
    mistakeBusyId.value = null
  }
}

async function completeReview(reviewId: string, isCorrect: boolean) {
  reviewBusyId.value = reviewId
  practiceError.value = null
  try {
    await api.completeReview(reviewId, isCorrect)
  } catch {
    practiceError.value = '复习结果没有保存，请使用相同结果重试。'
  } finally {
    reviewBusyId.value = null
  }
}

function nextPracticeQuestion() {
  if (!practiceSession.value) return
  if (practiceIndex.value + 1 >= practiceSession.value.items.length) {
    void finishPractice()
    return
  }
  practiceIndex.value += 1
  practiceAnswer.value = ''
  practiceFeedback.value = null
}

function toggleTimer() {
  timerRunning.value = !timerRunning.value
}

function resetTimer() {
  timerRunning.value = false
  timerSeconds.value = timerMinutes.value * 60
}

function handleComposerEnter(event: KeyboardEvent) {
  if (event.shiftKey || !enterToSend.value) return
  event.preventDefault()
  void sendMessage()
}

function saveSettings() {
  const settings = {
    theme: isDark.value ? 'dark' : 'light',
    assistantName: assistantDisplayName.value.trim() || props.assistantName,
    enterToSend: enterToSend.value,
    compactMode: compactMode.value,
    timerMinutes: timerMinutes.value,
    desktopCompanionEnabled: desktopCompanionEnabled.value,
    dailyReminder: dailyReminder.value,
  }
  assistantDisplayName.value = settings.assistantName
  timerSeconds.value = timerRunning.value ? timerSeconds.value : settings.timerMinutes * 60
  localStorage.setItem('aervox-settings', JSON.stringify(settings))
}

async function copyCurrentAnswer() {
  const text = currentAssistantLine.value?.text
  if (!text) return
  await navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1400)
}

function applyTheme(theme: 'light' | 'dark') {
  isDark.value = theme === 'dark'
  document.documentElement.dataset.theme = theme
  if (isWeb.value) localStorage.setItem('aervox-theme', theme)
}

async function setTheme(theme: 'light' | 'dark') {
  const desktopBridge = (window as Window & {fairyDesktop?: {setTheme: (value: 'light' | 'dark') => Promise<'light' | 'dark'>}}).fairyDesktop
  const appliedTheme = isWeb.value ? theme : await desktopBridge?.setTheme(theme) ?? theme
  applyTheme(appliedTheme)
  saveSettings()
}

function toggleWebTheme() {
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  applyTheme(nextTheme)
  saveSettings()
}

let timer: number | undefined
const openSettings = () => {
  settingsOpen.value = true
}

onMounted(() => {
  window.addEventListener('aervox:open-settings', openSettings)
  try {
    const savedSettings = JSON.parse(localStorage.getItem('aervox-settings') ?? '{}') as Partial<{
      theme: 'light' | 'dark'
      assistantName: string
      enterToSend: boolean
      compactMode: boolean
      timerMinutes: number
      desktopCompanionEnabled: boolean
      dailyReminder: boolean
    }>
    if (savedSettings.assistantName) assistantDisplayName.value = savedSettings.assistantName
    if (typeof savedSettings.enterToSend === 'boolean') enterToSend.value = savedSettings.enterToSend
    if (typeof savedSettings.compactMode === 'boolean') compactMode.value = savedSettings.compactMode
    if (typeof savedSettings.timerMinutes === 'number' && [15, 25, 45, 60].includes(savedSettings.timerMinutes)) timerMinutes.value = savedSettings.timerMinutes
    if (typeof savedSettings.desktopCompanionEnabled === 'boolean') desktopCompanionEnabled.value = savedSettings.desktopCompanionEnabled
    if (typeof savedSettings.dailyReminder === 'boolean') dailyReminder.value = savedSettings.dailyReminder
    timerSeconds.value = timerMinutes.value * 60
  } catch {
    // Ignore malformed local preferences and use defaults.
  }

  if (isWeb.value) {
    const saved = localStorage.getItem('aervox-theme')
    const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    applyTheme(saved === 'dark' || saved === 'light' ? saved : fallback)
  } else {
    const saved = document.documentElement.dataset.theme
    isDark.value = saved === 'dark'
  }

  timer = window.setInterval(() => {
    if (timerRunning.value && timerSeconds.value > 0) timerSeconds.value -= 1
    if (timerSeconds.value === 0) timerRunning.value = false
  }, 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  window.removeEventListener('aervox:open-settings', openSettings)
})
</script>

<template>
  <section
    class="aervox-workbench"
    :class="[`is-${platform}`, {'has-companion': showCompanionEnabled, 'is-compact': compactMode}]"
    :data-aervox-platform="platform"
  >
    <header v-if="isWeb" class="web-workbench-bar">
      <a class="web-brand" href="#conversation" aria-label="Aervox 思隅首页">
        <span class="web-brand-mark"><Sparkles :size="18" /></span>
        <span><strong>Aervox｜思隅</strong><small>陪伴式学习工作台</small></span>
      </a>
      <nav class="web-nav" aria-label="工作台导航">
        <a href="#conversation"><MessageCircle :size="17" />对话</a>
        <button type="button" @click="studyOpen = true"><BookOpen :size="17" />学习</button>
      </nav>
      <div class="web-bar-actions">
        <span class="web-status"><i />服务已连接</span>
        <button class="web-icon-button" type="button" aria-label="打开设置" @click="settingsOpen = true">
          <Settings :size="18" />
        </button>
        <button class="web-icon-button" type="button" aria-label="切换明暗主题" @click="toggleWebTheme">
          <Moon v-if="isDark" :size="18" />
          <Sun v-else :size="18" />
        </button>
      </div>
    </header>

    <main class="workbench-main">
      <section v-if="showCompanionEnabled" class="companion-column" aria-label="桌宠区域">
        <section class="companion-stage" :class="{'tools-open': toolsOpen}">
          <div class="pet-identity">
            <span class="identity-dot" />
            <span><strong>{{ assistantDisplayName }}</strong><small>Aervox 桌面伴学伙伴</small></span>
          </div>

          <div class="hero-pet-stage">
            <button class="hero-pet-button" type="button" aria-label="打开桌宠工具菜单" @click="toolsOpen = !toolsOpen">
              <Live2DPet>
                <template #fallback><PetHero /></template>
              </Live2DPet>
            </button>
            <div class="pet-speech">{{ streaming ? '我正在整理思路…' : '今天也一起稳稳前进。' }}</div>
          </div>

          <div class="pet-tool-menu" :class="{open: toolsOpen}">
            <div class="pet-tool-menu-head">
              <span>快捷工具</span>
              <button type="button" aria-label="关闭工具菜单" @click="toolsOpen = false"><X :size="18" /></button>
            </div>
            <button class="tool-menu-item" type="button" @click="todoOpen = true">
              <span class="tool-icon"><ListTodo :size="21" /></span>
              <span><strong>待办清单</strong><small>{{ unfinishedTodos.length }} 件待完成</small></span>
            </button>
            <button class="tool-menu-item" type="button" @click="timerOpen = true">
              <span class="tool-icon"><Clock3 :size="21" /></span>
              <span><strong>番茄钟</strong><small>{{ formattedTime }} 专注计时</small></span>
            </button>
            <button class="tool-menu-item" type="button" @click="historyOpen = true">
              <span class="tool-icon"><History :size="21" /></span>
              <span><strong>对话回看</strong><small>{{ story.length }} 条对话记录</small></span>
            </button>
            <button class="tool-menu-item" type="button" @click="studyOpen = true">
              <span class="tool-icon"><BookOpen :size="21" /></span>
              <span><strong>今日学习</strong><small>{{ dueReviews.length }} 项待复习</small></span>
            </button>
          </div>

          <button class="pet-menu-toggle" type="button" @click="toolsOpen = !toolsOpen">
            <LayoutGrid :size="19" />
            <span>快捷菜单</span>
            <ChevronUp v-if="toolsOpen" :size="16" />
            <ChevronDown v-else :size="16" />
          </button>
        </section>

        <section class="companion-status-card" aria-live="polite">
          <span class="status-icon"><Sparkles :size="20" /></span>
          <span><small>当前状态</small><strong>{{ workbenchState }}</strong></span>
        </section>
      </section>

      <section id="conversation" class="dialogue-column" aria-label="伴学对话区域">
        <section class="story-dialog">
          <div class="story-dialog-top">
            <span class="story-label"><MessageCircle :size="18" />与 {{ assistantDisplayName }} 对话</span>
            <div class="story-top-actions">
              <button type="button" :disabled="!currentAssistantLine?.text" @click="copyCurrentAnswer">
                <Check v-if="copied" :size="17" /><Copy v-else :size="17" />{{ copied ? '已复制' : '复制回答' }}
              </button>
              <button type="button" @click="historyOpen = true"><History :size="17" />完整记录</button>
            </div>
          </div>

          <div ref="storyViewport" class="story-content" aria-live="polite">
            <article
              v-for="line in story"
              :key="line.id"
              class="story-line"
              :class="[line.speaker, line.state]"
            >
              <div class="story-speaker">
                <span class="speaker-mark"><Sparkles v-if="line.speaker === 'assistant'" :size="17" /><span v-else>你</span></span>
                <span>
                  <small>{{ line.speaker === 'assistant' ? '伴学回应' : '你的输入' }}</small>
                  <strong>{{ line.speaker === 'assistant' ? assistantDisplayName : '你' }}</strong>
                </span>
                <span v-if="line.state === 'streaming'" class="response-badge">生成中</span>
                <span v-else-if="line.state === 'error'" class="response-badge error">未完成</span>
              </div>
              <p>{{ line.text || '正在连接 Aervox…' }}<span v-if="line.state === 'streaming'" class="stream-cursor" /></p>
            </article>
          </div>

          <div class="story-progress">
            <span><i :style="{width: `${Math.min(100, 18 + story.length * 8)}%`}" /></span>
            <small>{{ story.length }} 条对话 · 内容来自 Aervox API</small>
          </div>
        </section>

        <section class="interaction-area">
          <header class="interaction-heading">
            <span><Sparkles :size="19" /><span><small>继续学习</small><strong>把问题、代码或下一步目标发给思隅</strong></span></span>
            <span class="keyboard-hint">Enter 发送 · Shift + Enter 换行</span>
          </header>

          <div class="suggestions" aria-label="建议问题">
            <button v-for="suggestion in suggestions" :key="suggestion" type="button" :disabled="streaming" @click="sendMessage(suggestion)">
              <CircleHelp :size="17" /><span>{{ suggestion }}</span>
            </button>
          </div>

          <section class="interaction-block composer-block">
            <button class="collapse-trigger" type="button" @click="composerOpen = !composerOpen">
              <span>自由输入</span>
              <ChevronUp v-if="composerOpen" :size="18" />
              <ChevronDown v-else :size="18" />
            </button>
            <form v-if="composerOpen" class="story-composer" @submit.prevent="sendMessage()">
              <label class="sr-only" for="aervox-composer">输入要发送给思隅的内容</label>
              <textarea
                id="aervox-composer"
                v-model="input"
                rows="3"
                :disabled="streaming"
                placeholder="描述你卡住的地方，或告诉我今天想完成什么…"
                @keydown.enter="handleComposerEnter"
              />
              <button type="submit" :disabled="!input.trim() || streaming" :aria-label="streaming ? '正在生成回答' : '发送消息'">
                <span v-if="streaming" class="sending-dot" />
                <Send v-else :size="21" />
              </button>
            </form>
          </section>
        </section>
      </section>

      <aside class="utility-rail" aria-label="今日工具面板">
        <header class="rail-heading">
          <span><LayoutGrid :size="19" />今日面板</span>
          <span class="rail-heading-actions">
            <small>让学习节奏更轻一点</small>
            <button class="rail-settings-button" type="button" aria-label="打开设置" @click="settingsOpen = true"><Settings :size="16" /></button>
          </span>
        </header>

        <button class="overview-card learning-overview" type="button" @click="studyOpen = true">
          <span class="overview-copy">
            <small>学习概览</small>
            <strong>{{ goals.length }} 个目标 · {{ dueReviews.length }} 项复习</strong>
          </span>
          <span class="overview-orb"><BookOpen :size="22" /></span>
        </button>

        <section class="utility-card focus-card">
          <div class="utility-card-head">
            <span class="utility-card-icon"><Clock3 :size="20" /></span>
            <span><small>番茄钟</small><strong>{{ timerRunning ? '正在专注' : '准备开始' }}</strong></span>
            <button type="button" aria-label="打开番茄钟" @click="timerOpen = true"><ChevronUp :size="17" /></button>
          </div>
          <div class="compact-timer">
            <strong>{{ formattedTime }}</strong>
            <span><i :class="{running: timerRunning}" /></span>
          </div>
          <div class="compact-actions">
            <button class="primary" type="button" @click="toggleTimer">
              <Pause v-if="timerRunning" :size="18" /><Play v-else :size="18" />{{ timerRunning ? '暂停' : '开始专注' }}
            </button>
            <button type="button" aria-label="重置计时器" @click="resetTimer"><RotateCcw :size="18" /></button>
          </div>
        </section>

        <section class="utility-card todo-preview">
          <div class="utility-card-head">
            <span class="utility-card-icon"><ListTodo :size="20" /></span>
            <span><small>待办清单</small><strong>{{ unfinishedTodos.length }} 件待完成</strong></span>
            <button type="button" aria-label="打开待办清单" @click="todoOpen = true"><ChevronUp :size="17" /></button>
          </div>
          <div v-if="todos.length" class="compact-todo-list">
            <label v-for="todo in todos.slice(0, 3)" :key="todo.id" :class="{done: todo.done}">
              <input v-model="todo.done" type="checkbox" />
              <span>{{ todo.text }}</span>
              <Check v-if="todo.done" :size="16" />
            </label>
          </div>
          <p v-else class="utility-empty">把今天最重要的一件事放在这里。</p>
          <button class="add-todo-entry" type="button" @click="todoOpen = true"><Plus :size="17" />添加待办</button>
        </section>

        <button class="history-entry" type="button" @click="historyOpen = true">
          <span class="utility-card-icon"><History :size="20" /></span>
          <span><small>对话记录</small><strong>回看完整学习过程</strong></span>
          <span class="history-count">{{ story.length }}</span>
        </button>
      </aside>
    </main>

    <el-drawer v-model="historyOpen" title="对话回看" direction="rtl" size="min(440px, 94vw)">
      <div class="history-list">
        <article v-for="line in story" :key="line.id" :class="line.speaker">
          <span>{{ line.speaker === 'assistant' ? assistantDisplayName : '你' }}</span>
          <p>{{ line.text || '正在生成…' }}</p>
        </article>
      </div>
    </el-drawer>

    <el-drawer v-model="todoOpen" title="待办清单" direction="rtl" size="min(400px, 92vw)">
      <p class="drawer-intro">用小任务保持节奏，不需要一次完成所有事情。</p>
      <form class="todo-form" @submit.prevent="addTodo">
        <label class="sr-only" for="new-todo">添加待办</label>
        <input id="new-todo" v-model="newTodo" placeholder="添加一件小事" />
        <button type="submit" aria-label="添加待办"><Plus :size="20" /></button>
      </form>
      <div class="todo-summary">已完成 {{ completedTodoCount }} 件 · 待完成 {{ unfinishedTodos.length }} 件</div>
      <div class="todo-list">
        <label v-for="todo in todos" :key="todo.id" class="todo-item" :class="{done: todo.done}">
          <input v-model="todo.done" type="checkbox" />
          <span>{{ todo.text }}</span>
          <Check v-if="todo.done" :size="18" />
        </label>
        <p v-if="todos.length === 0" class="drawer-empty">暂无待办，先从一件五分钟能完成的小事开始。</p>
      </div>
    </el-drawer>

    <el-drawer v-model="timerOpen" title="番茄钟" direction="rtl" size="min(400px, 92vw)">
      <div class="timer-panel">
        <div class="timer-ring" :class="{running: timerRunning}"><strong>{{ formattedTime }}</strong><small>专注时间</small></div>
        <p>{{ timerRunning ? '保持当前节奏，结束后记得休息。' : '准备好后开始一个 25 分钟的小回合。' }}</p>
        <div class="timer-actions">
          <button type="button" @click="toggleTimer"><Pause v-if="timerRunning" :size="20" /><Play v-else :size="20" />{{ timerRunning ? '暂停' : '开始专注' }}</button>
          <button type="button" @click="resetTimer"><TimerReset :size="20" />重置</button>
        </div>
      </div>
    </el-drawer>

    <el-drawer v-model="studyOpen" title="今日学习" direction="rtl" size="min(520px, 96vw)" @open="reloadGoals">
      <p class="drawer-intro">目标、复习和日记都来自同一份 Aervox 学习数据。</p>
      <p v-if="apiError" class="drawer-error">{{ apiError }}</p>

      <section class="study-section">
        <div class="study-section-title-row">
          <h4>快速练习</h4>
          <button class="practice-start" type="button" :disabled="practiceBusy" @click="startPractice"><Sparkles :size="15" />开始 3 题练习</button>
        </div>
        <p v-if="practiceError" class="drawer-error">{{ practiceError }}</p>
        <article v-if="practiceReport" class="practice-report">
          <strong>本次练习完成</strong>
          <p>已作答 {{ practiceReport.answeredCount }}/{{ practiceReport.questionCount }} 题 · 正确 {{ practiceReport.correctCount }} · 错误 {{ practiceReport.incorrectCount }} · 待确认 {{ practiceReport.unverifiableCount }}</p>
          <p v-if="practiceReport.accuracy !== null">可判定题正确率：{{ Math.round(practiceReport.accuracy * 100) }}%</p>
          <small>{{ practiceReport.remainingCount > 0 ? `还有 ${practiceReport.remainingCount} 题未作答；` : '' }}{{ practiceReport.nextStep === 'review_scheduled' ? '错题已进入后续复习。' : practiceReport.nextStep === 'await_review' ? '待确认题暂不计入掌握度。' : '继续保持这个节奏。' }}</small>
        </article>
        <article v-else-if="currentPracticeQuestion" class="practice-panel">
          <small>第 {{ practiceIndex + 1 }}/{{ practiceSession?.items.length }} 题</small>
          <strong>{{ currentPracticeQuestion.prompt }}</strong>
          <form v-if="!practiceFeedback" @submit.prevent="submitPracticeAnswer">
            <label class="sr-only" for="practice-answer">你的答案</label>
            <input id="practice-answer" v-model="practiceAnswer" placeholder="输入你的答案" :disabled="practiceBusy" />
            <button type="submit" :disabled="practiceBusy || !practiceAnswer.trim()">提交答案</button>
          </form>
          <div v-else class="practice-feedback">
            <p>{{ practiceFeedback.judgement === 'correct' ? '回答正确。' : practiceFeedback.judgement === 'incorrect' ? '这题暂不正确，已安排后续复习。' : '这题需要进一步确认，暂不计入掌握度。' }}</p>
            <button type="button" :disabled="practiceBusy" @click="nextPracticeQuestion">{{ practiceIndex + 1 === practiceSession?.items.length ? '查看报告' : '下一题' }}</button>
          </div>
          <button class="practice-end" type="button" :disabled="practiceBusy" @click="finishPractice">提前结束并查看报告</button>
        </article>
        <p v-else class="study-empty">每次 3 题，答完立即反馈；也可以随时结束并查看报告。</p>
      </section>

      <section class="study-section">
        <div class="study-section-title-row">
          <h4>错题本 <small>{{ visibleMistakes.length }}</small></h4>
          <button class="practice-start" type="button" :disabled="practiceBusy || !mistakes.some((item) => item.status === 'active')" @click="startMistakePractice">
            <RotateCcw :size="15" />{{ selectedMistakeIds.length ? `重练所选 ${selectedMistakeIds.length} 题` : '重练错题' }}
          </button>
        </div>
        <div class="mistake-filters" aria-label="错题筛选">
          <button v-for="option in (['active', 'mastered', 'dismissed', 'all'] as const)" :key="option" type="button" :class="{active: mistakeFilter === option}" @click="mistakeFilter = option">
            {{ option === 'active' ? '待掌握' : option === 'mastered' ? '已掌握' : option === 'dismissed' ? '已忽略' : '全部' }}
          </button>
        </div>
        <ul class="study-list mistake-list">
          <li v-for="item in visibleMistakes" :key="item.questionId">
            <div class="mistake-heading">
              <label v-if="item.status === 'active'">
                <input v-model="selectedMistakeIds" type="checkbox" :value="item.questionId" :disabled="selectedMistakeIds.length >= 5 && !selectedMistakeIds.includes(item.questionId)" />
                <span class="study-item-title">{{ item.prompt }}</span>
              </label>
              <span v-else class="study-item-title">{{ item.prompt }}</span>
              <span class="goal-status" :class="{'is-completed': item.status === 'mastered'}">{{ item.status === 'mastered' ? '已掌握' : item.status === 'dismissed' ? '已忽略' : '待掌握' }}</span>
            </div>
            <small>最近答案：{{ item.latestAnswer }} · 共答错 {{ item.wrongCount }} 次 · {{ item.latestAttemptAt.slice(0, 10) }}</small>
            <div v-if="item.knowledgeId" class="goal-actions">
              <button v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'mastered')"><Check :size="14" />标记已掌握</button>
              <button v-else-if="item.status === 'mastered'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />继续学习</button>
              <button v-else type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'active')"><RotateCcw :size="14" />恢复错题</button>
              <button v-if="item.status === 'active'" type="button" :disabled="mistakeBusyId === item.questionId" @click="setMistakeStatus(item.questionId, 'dismissed')">忽略</button>
            </div>
            <small v-else>这道题尚未关联知识点，可以重练，但暂不能标记掌握。</small>
          </li>
          <li v-if="visibleMistakes.length === 0" class="study-empty">{{ mistakeFilter === 'mastered' ? '还没有已掌握的错题。' : '当前没有待处理错题。' }}</li>
        </ul>
      </section>

      <section class="study-section">
        <div class="study-section-title-row">
          <h4>学习目标 <small>{{ goals.length }}</small></h4>
          <label class="study-archive-toggle"><input v-model="showArchivedGoals" type="checkbox" @change="reloadGoals" />显示归档</label>
        </div>
        <form class="study-goal-form" @submit.prevent="submitNewGoal">
          <label class="sr-only" for="new-goal">添加学习目标</label>
          <input id="new-goal" v-model="newGoalTopic" placeholder="例如：掌握二叉树遍历" />
          <select v-model="newGoalLevel" aria-label="学习水平">
            <option value="beginner">入门</option>
            <option value="intermediate">进阶</option>
            <option value="advanced">熟练</option>
          </select>
          <select v-model.number="newGoalMinutes" aria-label="每日可用时间">
            <option :value="15">15 分钟</option>
            <option :value="25">25 分钟</option>
            <option :value="45">45 分钟</option>
            <option :value="60">60 分钟</option>
          </select>
          <button type="submit" aria-label="创建学习目标"><Plus :size="18" /></button>
        </form>
        <ul class="study-list">
          <li v-for="goal in goals" :key="goal.id">
            <div class="goal-item-heading"><span class="study-item-title">{{ goal.topic }}</span><span class="goal-status" :class="`is-${goal.status}`">{{ goalStatusLabel(goal.status) }}</span></div>
            <small>{{ goal.level === 'beginner' ? '入门' : goal.level === 'intermediate' ? '进阶' : '熟练' }} · {{ goal.availableMinutes }} 分钟/天</small>
            <div v-if="goal.status !== 'archived'" class="goal-actions">
              <button v-if="goal.status === 'active'" type="button" :disabled="goalBusyId === goal.id" @click="setGoalStatus(goal.id, 'paused')"><Pause :size="14" />暂停</button>
              <button v-else-if="goal.status === 'paused'" type="button" :disabled="goalBusyId === goal.id" @click="setGoalStatus(goal.id, 'active')"><Play :size="14" />继续</button>
              <button v-if="goal.status !== 'completed'" type="button" :disabled="goalBusyId === goal.id" @click="setGoalStatus(goal.id, 'completed')"><Check :size="14" />完成</button>
              <button v-if="goal.status === 'completed'" type="button" :disabled="goalBusyId === goal.id" @click="setGoalStatus(goal.id, 'active')"><RotateCcw :size="14" />重新开始</button>
              <button type="button" class="danger" :disabled="goalBusyId === goal.id" @click="archiveGoal(goal.id)"><X :size="14" />归档</button>
            </div>
          </li>
          <li v-if="goals.length === 0" class="study-empty">暂无学习目标，先添加一个想完成的主题。</li>
        </ul>
      </section>

      <section class="study-section">
        <h4>待复习 <small>{{ dueReviews.length }}</small></h4>
        <ul class="study-list">
          <li v-for="item in dueReviews" :key="item.id">
            <span class="study-item-title">知识点 #{{ item.knowledgeId }}</span>
            <small>到期 {{ item.dueAt.slice(0, 10) }} · 间隔 {{ item.intervalDays }} 天 · 规则 v{{ item.schedulerVersion }}</small>
            <div class="goal-actions">
              <button type="button" :disabled="reviewBusyId === item.id" @click="completeReview(item.id, true)"><Check :size="14" />记得</button>
              <button type="button" :disabled="reviewBusyId === item.id" @click="completeReview(item.id, false)"><RotateCcw :size="14" />忘了</button>
            </div>
          </li>
          <li v-if="dueReviews.length === 0" class="study-empty">今天没有到期复习，可以继续当前目标。</li>
        </ul>
      </section>

      <section class="study-section">
        <h4>最近复习 <small>{{ completedReviews.length }}</small></h4>
        <ul class="study-list">
          <li v-for="item in completedReviews" :key="item.id">
            <span class="study-item-title">知识点 #{{ item.knowledgeId }}</span>
            <small>{{ item.completionIsCorrect === true ? '记得' : item.completionIsCorrect === false ? '忘了' : '旧记录' }} · {{ item.updatedAt?.slice(0, 10) }}<template v-if="item.nextReviewId"> · 下一项 #{{ item.nextReviewId }}</template></small>
          </li>
          <li v-if="completedReviews.length === 0" class="study-empty">完成复习后，这里会保留最近记录。</li>
        </ul>
      </section>

      <section class="study-section">
        <h4>今日日记 <small v-if="todayDiary">{{ todayDiary.status }}</small></h4>
        <article v-if="todayDiary" class="study-diary">
          <strong>{{ todayDiary.title }}</strong>
          <p>{{ todayDiary.content }}</p>
        </article>
        <p v-else class="study-empty">今日日记将在 Worker 生成后显示。</p>
      </section>

      <section v-if="dailyReminder" class="study-section">
        <h4>提醒 <small>{{ notifications.length }}</small></h4>
        <ul class="study-list">
          <li v-for="notification in notifications" :key="notification.id">
            <span class="study-item-title">{{ notification.type }} 提醒</span>
            <small>{{ notification.channel }} · {{ notification.status }}</small>
          </li>
          <li v-if="notifications.length === 0" class="study-empty">暂无提醒。</li>
        </ul>
      </section>
    </el-drawer>

    <el-dialog v-model="settingsOpen" title="设置" class="settings-dialog" width="min(860px, calc(100vw - 28px))" align-center>
      <div class="settings-layout">
        <nav class="settings-categories" aria-label="设置分类">
          <button v-for="category in settingCategories" :key="category.id" type="button" :class="{active: settingsCategory === category.id}" @click="settingsCategory = category.id">
            <component :is="category.icon" :size="18" />
            <span><strong>{{ category.label }}</strong><small>{{ category.description }}</small></span>
          </button>
        </nav>
        <section class="settings-detail">
          <div v-if="settingsCategory === 'appearance'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><Sun :size="18" /></span>
              <span><strong>外观</strong><small>让工作台更符合你的节奏与喜好</small></span>
            </div>
            <div class="settings-row settings-choice-row"><span><strong>主题</strong><small>选择工作台的明暗模式</small></span><span class="settings-segmented"><button type="button" :class="{active: !isDark}" @click="setTheme('light')"><Sun :size="16" />亮色</button><button type="button" :class="{active: isDark}" @click="setTheme('dark')"><Moon :size="16" />暗色</button></span></div>
            <label class="settings-row settings-choice-row"><span><strong>界面密度</strong><small>紧凑模式会减少面板间距</small></span><input v-model="compactMode" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
            <label v-if="!isWeb && props.showCompanion" class="settings-row settings-choice-row"><span><strong>工作台桌宠</strong><small>控制桌面端主窗口中的桌宠区域</small></span><input v-model="desktopCompanionEnabled" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
          </div>
          <div v-else-if="settingsCategory === 'conversation'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><MessageCircle :size="18" /></span>
              <span><strong>对话</strong><small>调整你与思隅交流的输入与展示方式</small></span>
            </div>
            <label class="settings-field"><span><strong>助手称呼</strong><small>工作台中显示的名字</small></span><input v-model="assistantDisplayName" maxlength="12" @change="saveSettings" /></label>
            <label class="settings-row settings-choice-row"><span><strong>回车发送</strong><small>关闭后，回车只换行</small></span><input v-model="enterToSend" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
          </div>
          <PersonaManagerPanel v-else-if="settingsCategory === 'persona'" class="settings-section" />
          <div v-else-if="settingsCategory === 'focus'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><Clock3 :size="18" /></span>
              <span><strong>专注</strong><small>设置番茄钟的默认工作与休息时长</small></span>
            </div>
            <div class="settings-row settings-choice-row"><span><strong>专注时长</strong><small>重置计时器时使用该时长</small></span><span class="settings-segmented"><button v-for="minutes in [15, 25, 45, 60]" :key="minutes" type="button" :class="{active: timerMinutes === minutes}" @click="timerMinutes = minutes; saveSettings()">{{ minutes }} 分钟</button></span></div>
          </div>
          <div v-else-if="settingsCategory === 'notifications'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><Bell :size="18" /></span>
              <span><strong>提醒</strong><small>控制学习过程中的轻量通知与节奏提醒</small></span>
            </div>
            <label class="settings-row settings-choice-row"><span><strong>学习提醒</strong><small>允许工作台显示复习和目标提醒</small></span><input v-model="dailyReminder" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
            <div class="settings-note"><Check :size="16" />设置会自动保存在当前设备</div>
          </div>
          <LocalVoiceConfigPanel v-else-if="settingsCategory === 'voice'" class="settings-section" />
          <PluginManagerPanel v-else class="settings-section" />
        </section>
      </div>
    </el-dialog>
  </section>
</template>
