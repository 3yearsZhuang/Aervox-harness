<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, ref, watch, type Component} from 'vue'
import {
  Bell,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Heart,
  History,
  LayoutGrid,
  ListTodo,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Moon,
  NotebookPen,
  Pause,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Volume2,
  TimerReset,
  X,
} from 'lucide-vue-next'
import {streamAervoxTurn, submitQuestionAnswers, useAervoxApi, useAervoxVoiceInput} from '@aervox/api-client'
import type {AskUserQuestionAnswerItem, ToolApprovalMode, UserQuestionRequiredEventData} from '@aervox/contracts'
import PetHero from './PetHero.vue'
import PluginManagerPanel from './plugin/PluginManagerPanel.vue'
import Live2DPet from './Live2DPet.vue'
import PersonaManagerPanel from './persona/PersonaManagerPanel.vue'
import LocalVoiceConfigPanel from './voice/LocalVoiceConfigPanel.vue'
import LLMConfigPanel from './llm/LLMConfigPanel.vue'
import UserQuestionComposer from './UserQuestionComposer.vue'

type Platform = 'desktop' | 'web'
type Speaker = 'assistant' | 'user'

interface StoryLine {
  id: number
  speaker: Speaker
  text: string
  state?: 'streaming' | 'complete' | 'error'
}

type CardId = 'study' | 'todo' | 'timer' | 'history' | 'review' | 'mistake' | 'diary' | 'notifications'

interface CardDefinition {
  id: CardId
  label: string
  description: string
  icon: Component
  summary: () => string
  action: () => void
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

const composerOpen = ref(false)
const historyOpen = ref(false)
const todoOpen = ref(false)
const timerOpen = ref(false)
const studyOpen = ref(false)
const settingsOpen = ref(false)
const settingsCategory = ref<'tools' | 'appearance' | 'conversation' | 'model' | 'persona' | 'notifications' | 'voice' | 'plugins'>('tools')
const newGoalTopic = ref('')
const newGoalLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner')
const newGoalMinutes = ref(25)
const showArchivedGoals = ref(false)
const goalBusyId = ref<string | null>(null)
const practiceSession = ref<{sessionId: string; items: Array<{id: string; prompt: string}>; nextQuestionIndex?: number} | null>(null)
const practiceIndex = ref(0)
const practiceReadyToComplete = ref(false)
const practiceAnswer = ref('')
const practiceFeedback = ref<{judgement: string; nextStep: string} | null>(null)
const practiceSubmission = ref<{sessionId: string; questionId: string; answer: string; idempotencyKey: string} | null>(null)
const practiceReport = ref<{answeredCount: number; questionCount: number; remainingCount: number; correctCount: number; incorrectCount: number; unverifiableCount: number; accuracy: number | null; avgTimeSpentSec: number | null; totalHintsUsed: number; guidance: {difficulty: 'ease' | 'maintain' | 'increase'; reasonCode: string; message: string}; nextStep: string} | null>(null)
const questionStartTime = ref<number>(0)

// UQ-01: 挂起向用户提问数据与提交状态
const activeQuestion = ref<UserQuestionRequiredEventData | null>(null)
const questionSubmitting = ref(false)
const currentTurnId = ref<string | null>(null)
const practiceBusy = ref(false)
const practiceError = ref<string | null>(null)
const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active')
const mistakeReasonFilter = ref<string>('all')
const selectedMistakeIds = ref<string[]>([])
const mistakeBusyId = ref<string | null>(null)
const mistakeInsightDrafts = ref<Record<string, {reasonCode: string; note: string}>>({})
const reviewBusyId = ref<string | null>(null)
const newPlanTitle = ref('')
const newPlanEndDate = ref('')
const planBusyId = ref<string | null>(null)
const planDrafts = ref<Record<string, {endDate: string; dailyAvailableMinutes: number}>>({})
const input = ref('')
const isComposing = ref(false)
const composerPlaceholder = '和思隅聊聊学习或任何事…'
const cardSlots = ref<Array<CardId | null>>([null, null])
const timerSeconds = ref(25 * 60)
const timerRunning = ref(false)
const streaming = ref(false)
const isDark = ref(false)
const assistantDisplayName = ref(props.assistantName)
const enterToSend = ref(true)
const compactMode = ref(false)
const timerMinutes = ref(25)
const desktopCompanionEnabled = ref(props.showCompanion)
const dailyReminder = ref(true)
const toolApprovalMode = ref<ToolApprovalMode>('ask')
const fullAccessDialogOpen = ref(false)
const fullAccessAcknowledged = ref(false)
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
const voiceInput = useAervoxVoiceInput()
const composerTextarea = ref<HTMLTextAreaElement | null>(null)
const voiceInputError = ref<string | null>(null)
const {
  goals,
  dueReviews,
  completedReviews,
  reviewSummary,
  mistakes,
  studyPlans,
  notifications,
  todayDiary,
  activePracticeSession,
  error: apiError,
} = api
let nextStoryId = 2

const isWeb = computed(() => props.platform === 'web')
// Web always presents its companion; the desktop-only preference must not
// leak through shared localStorage and hide the Web companion.
const showCompanionEnabled = computed(() => props.showCompanion && (isWeb.value || desktopCompanionEnabled.value))
const unfinishedTodos = computed(() => todos.value.filter((todo) => !todo.done))
const completedTodoCount = computed(() => todos.value.length - unfinishedTodos.value.length)
const formattedTime = computed(() => {
  const minutes = String(Math.floor(timerSeconds.value / 60)).padStart(2, '0')
  const seconds = String(timerSeconds.value % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
})
const settingCategories = [
  {id: 'tools', label: '快捷工具', description: '学习面板与小工具', icon: LayoutGrid},
  {id: 'appearance', label: '外观', description: '主题与界面密度', icon: Sun},
  {id: 'conversation', label: '对话', description: '称呼与输入方式', icon: MessageCircle},
  {id: 'model', label: '模型与服务', description: '大语言模型与供应商配置', icon: Bot},
  {id: 'persona', label: '人格设定', description: '管理人格角色设定', icon: Heart},
  {id: 'notifications', label: '提醒', description: '学习节奏与通知', icon: Bell},
  {id: 'voice', label: '语音', description: '本地语音模型配置', icon: Volume2},
  {id: 'plugins', label: '插件', description: '插件配置与页面', icon: Puzzle},
] as const

const activeMistakeCount = computed(() => mistakes.value.filter((item) => item.status === 'active').length)

const cardCatalog = computed<CardDefinition[]>(() => [
  {id: 'study', label: '今日学习', description: '学习目标 · 复习 · 错题 · 日记', icon: BookOpen, summary: () => `${goals.value.length} 个目标 · ${dueReviews.value.length} 项复习`, action: () => openTool('study')},
  {id: 'todo', label: '待办清单', description: '勾选完成今天的待办事项', icon: ListTodo, summary: () => `待完成 ${unfinishedTodos.value.length} 件`, action: () => openTool('todo')},
  {id: 'timer', label: '番茄钟', description: '专注计时，劳逸结合', icon: Clock3, summary: () => timerRunning.value ? `${formattedTime.value} 专注中` : `${formattedTime.value} 待开始`, action: () => openTool('timer')},
  {id: 'history', label: '对话回看', description: '回顾与思隅的历史对话', icon: History, summary: () => `${story.value.length} 条对话记录`, action: () => openTool('history')},
  {id: 'review', label: '待复习', description: '间隔复习到期内容', icon: RotateCcw, summary: () => `${dueReviews.value.length} 项到期`, action: () => openTool('study')},
  {id: 'mistake', label: '错题本', description: '针对性练习未掌握的题', icon: Puzzle, summary: () => `${activeMistakeCount.value} 题待掌握`, action: () => openTool('study')},
  {id: 'diary', label: '今日日记', description: 'AI 汇总的学习日记', icon: NotebookPen, summary: () => todayDiary.value?.title ?? '生成后在这里展示', action: () => openTool('study')},
  {id: 'notifications', label: '提醒', description: '学习节奏与日常通知', icon: Bell, summary: () => `${notifications.value.length} 条提醒`, action: () => openTool('study')},
])

const slotCards = computed(() => cardSlots.value.map((id) => id ? cardCatalog.value.find((card) => card.id === id) ?? null : null))

const menuOpen = ref(false)
const menuPillRef = ref<HTMLElement | null>(null)

/** 主导航：全部映射到既有功能（工具抽屉与设置弹窗），不引入新能力 */
const menuItems: Array<{ id: string; label: string; icon: Component; action: () => void }> = [
  {id: 'study', label: '学习', icon: BookOpen, action: () => openTool('study')},
  {id: 'todo', label: '待办', icon: ListTodo, action: () => openTool('todo')},
  {id: 'timer', label: '番茄钟', icon: Clock3, action: () => openTool('timer')},
  {id: 'history', label: '回看', icon: History, action: () => openTool('history')},
  {id: 'settings', label: '设置', icon: Settings, action: () => {settingsOpen.value = true}},
]

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

/** 收起态点击胶囊任意区域（含边缘空白）均可展开 */
function handlePillClick() {
  if (!menuOpen.value) menuOpen.value = true
}

function runMenuAction(action: () => void) {
  menuOpen.value = false
  action()
}

/** 点击菜单胶囊外部时自动收起 */
function handleMenuDocumentClick(event: MouseEvent) {
  if (!menuOpen.value) return
  if (menuPillRef.value?.contains(event.target as Node)) return
  menuOpen.value = false
}

function createStoryLine(speaker: Speaker, text: string, state: StoryLine['state'] = 'complete'): StoryLine {
  return {id: nextStoryId++, speaker, text, state}
}

async function scrollStoryToBottom() {
  await nextTick()
  storyViewport.value?.scrollTo({top: storyViewport.value.scrollHeight, behavior: 'smooth'})
}

/** 主对话框只保留最新一条 AI 回复，完整上下文由二级回看窗口承载 */
const latestAssistantLine = computed<StoryLine | null>(() => {
  for (let i = story.value.length - 1; i >= 0; i--) {
    if (story.value[i].speaker === 'assistant') return story.value[i]
  }
  return null
})

/** 视觉小说式对话回看：打开时滚到最新一条 */
const historyViewport = ref<HTMLElement | null>(null)

watch(historyOpen, async (open) => {
  if (!open) return
  await nextTick()
  historyViewport.value?.scrollTo({top: historyViewport.value.scrollHeight})
})

function handleHistoryEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && historyOpen.value) historyOpen.value = false
}

async function sendMessage(value = input.value) {
  const text = value.trim()
  if (!text || streaming.value) return

  const outgoing = text

  const assistantLine = createStoryLine('assistant', '', 'streaming')
  story.value.push(createStoryLine('user', text), assistantLine)
  input.value = ''
  streaming.value = true
  activeQuestion.value = null
  await scrollStoryToBottom()

  try {
    await streamAervoxTurn(
      outgoing,
      {
        onDelta: (delta) => {
          assistantLine.text += delta
          void scrollStoryToBottom()
        },
        onDone: () => {
          assistantLine.state = 'complete'
          activeQuestion.value = null
          if (!assistantLine.text) assistantLine.text = '这次没有收到可展示的回答，请再试一次。'
        },
        onUserQuestion: (qData) => {
          activeQuestion.value = qData
          currentTurnId.value = qData.turnId
          void scrollStoryToBottom()
        },
      },
      {toolApprovalMode: toolApprovalMode.value},
    )
  } catch (error) {
    assistantLine.state = 'error'
    assistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。'
  } finally {
    streaming.value = false
    if (!input.value.trim()) composerOpen.value = false
    await scrollStoryToBottom()
  }
}

async function handleQuestionSubmit(answers: AskUserQuestionAnswerItem[]) {
  if (!currentTurnId.value || questionSubmitting.value) return
  questionSubmitting.value = true
  try {
    await submitQuestionAnswers(currentTurnId.value, answers)
    activeQuestion.value = null
  } catch (err) {
    console.error('提交回答失败', err)
  } finally {
    questionSubmitting.value = false
  }
}

function expandComposer() {
  composerOpen.value = true
  void nextTick(() => composerTextarea.value?.focus())
}

function collapseComposer() {
  if (voiceInput.isListening.value) voiceInput.stopListening()
  composerOpen.value = false
}

/** 点击控制台外部的空白输入区时自动收起（输入法组合/焦点转移期间不误收起） */
function handleDockFocusOut(event: FocusEvent) {
  if (!composerOpen.value || isComposing.value) return
  if (fullAccessDialogOpen.value) return
  if (input.value.trim() || voiceInput.isListening.value) return
  const dock = event.currentTarget as HTMLElement
  const next = event.relatedTarget as Node | null
  if (next && dock.contains(next)) return
  // IME 候选窗等程序性焦点转移会让 relatedTarget 为空：
  // 延迟复查真实焦点位置，避免输入中途输入框被销毁导致文字丢失。
  window.setTimeout(() => {
    if (!composerOpen.value || isComposing.value) return
    if (fullAccessDialogOpen.value) return
    if (input.value.trim() || voiceInput.isListening.value) return
    if (dock.contains(document.activeElement)) return
    composerOpen.value = false
  }, 160)
}

function saveToolApprovalMode(mode: ToolApprovalMode) {
  toolApprovalMode.value = mode
  sessionStorage.setItem('aervox-tool-approval-mode', mode)
}

function toggleToolApprovalMode() {
  if (streaming.value) return
  if (toolApprovalMode.value === 'full_access') {
    saveToolApprovalMode('ask')
    return
  }
  fullAccessAcknowledged.value = false
  fullAccessDialogOpen.value = true
}

function enableFullAccess() {
  if (!fullAccessAcknowledged.value) return
  saveToolApprovalMode('full_access')
  fullAccessDialogOpen.value = false
}

function resetFullAccessConfirmation() {
  fullAccessAcknowledged.value = false
}

function openTool(target: 'study' | 'todo' | 'timer' | 'history') {
  settingsOpen.value = false
  if (target === 'study') studyOpen.value = true
  else if (target === 'todo') todoOpen.value = true
  else if (target === 'timer') timerOpen.value = true
  else historyOpen.value = true
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
  if (!practiceSession.value && activePracticeSession.value) {
    restorePracticeSession(activePracticeSession.value)
  }
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
const visibleMistakes = computed(() => mistakes.value.filter((item) =>
  (mistakeFilter.value === 'all' || item.status === mistakeFilter.value)
  && (mistakeReasonFilter.value === 'all' || item.reasonCode === mistakeReasonFilter.value),
))

const mistakeReasonOptions = [
  {value: 'concept_gap', label: '概念不清'},
  {value: 'calculation', label: '计算失误'},
  {value: 'careless', label: '粗心'},
  {value: 'misread', label: '审题偏差'},
  {value: 'other', label: '其他'},
] as const

function mistakeReasonLabel(reasonCode: string | null) {
  return mistakeReasonOptions.find((item) => item.value === reasonCode)?.label ?? '未记录错因'
}

function mistakeInsightDraft(item: {questionId: string; reasonCode: string | null; note: string | null}) {
  return mistakeInsightDrafts.value[item.questionId] ?? {reasonCode: item.reasonCode ?? '', note: item.note ?? ''}
}

function updateMistakeInsightDraft(questionId: string, update: Partial<{reasonCode: string; note: string}>) {
  const current = mistakeInsightDrafts.value[questionId] ?? {reasonCode: '', note: ''}
  mistakeInsightDrafts.value[questionId] = {...current, ...update}
}

function restorePracticeSession(session: {sessionId: string; items: Array<{id: string; prompt: string}>; nextQuestionIndex?: number}) {
  practiceSession.value = session
  const nextIndex = session.nextQuestionIndex ?? 0
  practiceReadyToComplete.value = nextIndex >= session.items.length
  practiceIndex.value = Math.min(nextIndex, Math.max(session.items.length - 1, 0))
  practiceAnswer.value = ''
  practiceSubmission.value = null
  practiceFeedback.value = null
  questionStartTime.value = Date.now()
}

async function startPractice() {
  practiceBusy.value = true
  practiceError.value = null
  practiceReport.value = null
  practiceFeedback.value = null
  try {
    restorePracticeSession(await api.startPracticeSession())
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
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - questionStartTime.value) / 1000))
    const existing = practiceSubmission.value
    const submission = existing?.sessionId === practiceSession.value.sessionId && existing.questionId === question.id && existing.answer === answer
      ? existing
      : { sessionId: practiceSession.value.sessionId, questionId: question.id, answer, idempotencyKey: `attempt_${crypto.randomUUID()}` }
    practiceSubmission.value = submission
    practiceFeedback.value = await api.submitPracticeAnswer(submission.sessionId, submission.questionId, submission.answer, submission.idempotencyKey, elapsedSeconds)
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
    practiceReadyToComplete.value = false
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
    restorePracticeSession(await api.startMistakePractice(questionIds))
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

async function saveMistakeInsight(item: {questionId: string; reasonCode: string | null; note: string | null}) {
  const draft = mistakeInsightDraft(item)
  mistakeBusyId.value = item.questionId
  practiceError.value = null
  try {
    await api.setMistakeInsight(item.questionId, {
      reasonCode: (draft.reasonCode || null) as 'concept_gap' | 'calculation' | 'careless' | 'misread' | 'other' | null,
      note: draft.note,
    })
    delete mistakeInsightDrafts.value[item.questionId]
  } catch {
    practiceError.value = '错因记录没有保存，请稍后重试。'
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

async function submitStudyPlan() {
  if (!newPlanTitle.value.trim() || !newPlanEndDate.value) return
  planBusyId.value = 'new'
  try {
    await api.createStudyPlan({ title: newPlanTitle.value.trim(), startDate: new Date().toISOString().slice(0, 10), endDate: newPlanEndDate.value })
    newPlanTitle.value = ''
    newPlanEndDate.value = ''
  } catch {
    practiceError.value = '学习计划没有保存，请稍后重试。'
  } finally { planBusyId.value = null }
}

async function setPlanPrediction(planId: string, prediction: 'on_track' | 'at_risk') {
  planBusyId.value = planId
  try { await api.updateStudyPlanPrediction(planId, prediction) } catch { practiceError.value = '计划状态没有保存，请稍后重试。' } finally { planBusyId.value = null }
}

function planDraft(plan: {id: string; endDate: string; dailyAvailableMinutes: number}) {
  return planDrafts.value[plan.id] ?? {endDate: plan.endDate, dailyAvailableMinutes: plan.dailyAvailableMinutes}
}

async function saveStudyPlan(plan: {id: string; endDate: string; dailyAvailableMinutes: number}) {
  const draft = planDraft(plan)
  planBusyId.value = plan.id
  try {
    await api.updateStudyPlan(plan.id, draft)
    delete planDrafts.value[plan.id]
  } catch { practiceError.value = '计划调整没有保存，请稍后重试。' } finally { planBusyId.value = null }
}

async function archiveStudyPlan(planId: string) {
  planBusyId.value = planId
  try { await api.archiveStudyPlan(planId) } catch { practiceError.value = '计划归档失败，请稍后重试。' } finally { planBusyId.value = null }
}

function nextPracticeQuestion() {
  if (!practiceSession.value) return
  if (practiceIndex.value + 1 >= practiceSession.value.items.length) {
    practiceReadyToComplete.value = true
    return
  }
  practiceIndex.value += 1
  practiceAnswer.value = ''
  practiceSubmission.value = null
  practiceFeedback.value = null
  questionStartTime.value = Date.now()
}

function toggleTimer() {
  timerRunning.value = !timerRunning.value
}

function resetTimer() {
  timerRunning.value = false
  timerSeconds.value = timerMinutes.value * 60
}

const timerDialRef = ref<SVGSVGElement | null>(null)
const isDraggingDial = ref(false)

// 环形表盘几何常数 (SVG viewBox 0 0 200 200, 中心 100,100, 半径 80)
const DIAL_RADIUS = 80
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS

const timerRatio = computed(() => {
  if (timerRunning.value) {
    const total = Math.max(timerMinutes.value * 60, 1)
    return Math.max(0, Math.min(1, timerSeconds.value / total))
  }
  return Math.max(0, Math.min(1, timerMinutes.value / 60))
})

const timerArcDashoffset = computed(() => {
  return DIAL_CIRCUMFERENCE * (1 - timerRatio.value)
})

// 滑块手柄（白点）旋转角度（顺时针度数，0° = 12 点钟方向）
const thumbAngle = computed(() => {
  return timerRatio.value * 360
})

function calculateMinutesFromEvent(event: MouseEvent | TouchEvent): number | null {
  const svg = timerDialRef.value
  if (!svg) return null
  const rect = svg.getBoundingClientRect()
  const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX
  const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const dx = clientX - cx
  const dy = clientY - cy
  // 极坐标角度，正上方为 0度，顺时针增长
  let deg = Math.atan2(dy, dx) * (180 / Math.PI) + 90
  if (deg < 0) deg += 360
  // 360 度对应 60 分钟
  const rawMin = (deg / 360) * 60
  const clamped = Math.max(1, Math.min(60, Math.round(rawMin)))
  return clamped
}

function handleDialPointerDown(event: MouseEvent | TouchEvent) {
  if (timerRunning.value) return
  isDraggingDial.value = true
  const min = calculateMinutesFromEvent(event)
  if (min !== null) {
    timerMinutes.value = min
    timerSeconds.value = min * 60
  }
  window.addEventListener('mousemove', handleDialPointerMove)
  window.addEventListener('mouseup', handleDialPointerUp)
  window.addEventListener('touchmove', handleDialPointerMove, {passive: false})
  window.addEventListener('touchend', handleDialPointerUp)
}

function handleDialPointerMove(event: MouseEvent | TouchEvent) {
  if (!isDraggingDial.value || timerRunning.value) return
  if ('touches' in event) event.preventDefault()
  const min = calculateMinutesFromEvent(event)
  if (min !== null && min !== timerMinutes.value) {
    timerMinutes.value = min
    timerSeconds.value = min * 60
  }
}

function handleDialPointerUp() {
  if (isDraggingDial.value) {
    isDraggingDial.value = false
    saveSettings()
  }
  window.removeEventListener('mousemove', handleDialPointerMove)
  window.removeEventListener('mouseup', handleDialPointerUp)
  window.removeEventListener('touchmove', handleDialPointerMove)
  window.removeEventListener('touchend', handleDialPointerUp)
}

function selectPresetMinutes(minutes: number) {
  if (timerRunning.value) return
  timerMinutes.value = minutes
  timerSeconds.value = minutes * 60
  saveSettings()
}

function handleComposerEnter(event: KeyboardEvent) {
  // 输入法候选确认的 Enter 不发送消息（组合中的文字尚未落定）。
  if (event.isComposing || isComposing.value) return
  if (voiceInput.isListening.value) {
    voiceInput.stopListening()
  }
  if (event.shiftKey || !enterToSend.value) return
  event.preventDefault()
  void sendMessage()
}

/** 输入法组合开始/结束：阻止收起逻辑在组合期间销毁输入框 */
function handleCompositionStart() {
  isComposing.value = true
  handleComposerInputOrKey()
}

function handleCompositionEnd() {
  isComposing.value = false
}

/** 键盘自停：检测到键盘输入/粘贴/输入法开始时，自动停止录音 */
function handleComposerInputOrKey() {
  if (voiceInput.isListening.value) {
    voiceInput.stopListening()
  }
}

function isCardPicked(id: CardId) {
  return cardSlots.value.includes(id)
}

function handleCardCommand(slot: number, command: unknown) {
  if (command === '__clear__') {
    selectCard(slot, null)
    return
  }
  if (typeof command === 'string' && cardCatalog.value.some((card) => card.id === command)) {
    selectCard(slot, command as CardId)
  }
}

function selectCard(slot: number, id: CardId | null) {
  cardSlots.value = cardSlots.value.map((current, index) => index === slot ? id : current)
  localStorage.setItem('aervox-side-cards', JSON.stringify(cardSlots.value))
}

function activateCard(card: CardDefinition) {
  card.action()
}

/** 语音输入插入当前光标处 */
function insertTranscribedText(text: string) {
  if (!text) return
  const textarea = composerTextarea.value
  if (!textarea) {
    input.value += (input.value ? ' ' : '') + text
    return
  }

  const start = textarea.selectionStart ?? input.value.length
  const end = textarea.selectionEnd ?? input.value.length
  const before = input.value.substring(0, start)
  const after = input.value.substring(end)

  input.value = before + (before && !before.endsWith(' ') ? ' ' : '') + text + after
  nextTick(() => {
    const newPos = start + text.length + (before && !before.endsWith(' ') ? 1 : 0)
    textarea.focus()
    textarea.setSelectionRange(newPos, newPos)
  })
}

/** 切换麦克风录音状态 */
async function toggleVoiceInput() {
  voiceInputError.value = null
  if (voiceInput.isListening.value) {
    voiceInput.stopListening()
    return
  }

  try {
    const config = await voiceInput.getInputConfig()
    await voiceInput.startListening({
      silenceThresholdMs: config.vadSilenceThresholdMs,
      onText: (text) => {
        insertTranscribedText(text)
      },
      onError: (err) => {
        voiceInputError.value = err.message
      },
    })
  } catch (err) {
    voiceInputError.value = err instanceof Error ? err.message : '启动语音输入失败'
  }
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
    if (typeof savedSettings.timerMinutes === 'number' && savedSettings.timerMinutes >= 1 && savedSettings.timerMinutes <= 60) timerMinutes.value = savedSettings.timerMinutes
    if (typeof savedSettings.desktopCompanionEnabled === 'boolean') desktopCompanionEnabled.value = savedSettings.desktopCompanionEnabled
    if (typeof savedSettings.dailyReminder === 'boolean') dailyReminder.value = savedSettings.dailyReminder
    timerSeconds.value = timerMinutes.value * 60
  } catch {
    // Ignore malformed local preferences and use defaults.
  }

  const savedMode = localStorage.getItem('aervox-composer-mode')
  if (savedMode && companionModes.some((mode) => mode.id === savedMode)) activeModeId.value = savedMode as CompanionModeId

  const savedToolApprovalMode = sessionStorage.getItem('aervox-tool-approval-mode')
  if (savedToolApprovalMode === 'full_access') toolApprovalMode.value = 'full_access'

  try {
    const savedCards = JSON.parse(localStorage.getItem('aervox-side-cards') ?? 'null') as unknown
    if (Array.isArray(savedCards)) {
      cardSlots.value = [0, 1].map((index) => {
        const id = savedCards[index]
        return cardCatalog.value.some((card) => card.id === id) ? (id as CardId) : null
      })
    }
  } catch {
    // Ignore malformed card preferences and keep placeholders.
  }

  if (isWeb.value) {
    const saved = localStorage.getItem('aervox-theme')
    const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    applyTheme(saved === 'dark' || saved === 'light' ? saved : fallback)
  } else {
    const saved = document.documentElement.dataset.theme
    isDark.value = saved === 'dark'
  }

  void scrollStoryToBottom()

  document.addEventListener('click', handleMenuDocumentClick)
  document.addEventListener('keydown', handleHistoryEscape)

  timer = window.setInterval(() => {
    if (timerRunning.value && timerSeconds.value > 0) timerSeconds.value -= 1
    if (timerSeconds.value === 0) timerRunning.value = false
  }, 1000)
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  document.removeEventListener('click', handleMenuDocumentClick)
  document.removeEventListener('keydown', handleHistoryEscape)
  window.removeEventListener('aervox:open-settings', openSettings)
})
</script>

<template>
  <section
    class="aervox-workbench"
    :class="[`is-${platform}`, {'has-companion': showCompanionEnabled, 'is-compact': compactMode}]"
    :data-aervox-platform="platform"
  >
    <div v-if="showCompanionEnabled" class="immersive-pet" aria-label="桌宠区域">
      <Live2DPet>
        <template #fallback><PetHero /></template>
      </Live2DPet>
    </div>

    <button v-if="isWeb" class="floating-settings" type="button" aria-label="打开设置" @click="settingsOpen = true">
      <Settings :size="19" />
    </button>

    <nav ref="menuPillRef" class="menu-pill" :class="{open: menuOpen}" aria-label="主导航" @click="handlePillClick">
      <button
        class="menu-toggle"
        type="button"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? '收起菜单' : '展开菜单'"
        @click.stop="toggleMenu"
      >
        <Menu v-if="!menuOpen" :size="19" />
        <X v-else :size="19" />
      </button>
      <div class="menu-items">
        <button
          v-for="item in menuItems"
          :key="item.id"
          class="menu-item"
          type="button"
          @click.stop="runMenuAction(item.action)"
        >
          <component :is="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
      </div>
    </nav>

    <aside class="side-cards" aria-label="功能卡片">
      <div v-for="(card, slotIndex) in slotCards" :key="slotIndex" class="side-card-slot">
        <template v-if="card">
          <article
            class="side-card"
            role="region"
            tabindex="0"
            :aria-label="`打开${card.label}`"
            @click="activateCard(card)"
            @keydown.enter="activateCard(card)"
          >
            <header class="side-card-head">
              <span class="side-card-icon"><component :is="card.icon" :size="24" /></span>
              <span class="side-card-title">
                <strong>{{ card.label }}</strong>
                <small>{{ card.description }}</small>
              </span>
              <el-dropdown trigger="click" :placement="slotIndex === 0 ? 'bottom-start' : 'top-start'" :popper-options="{modifiers: [{name: 'flip', enabled: false}]}" @command="(id: unknown) => handleCardCommand(slotIndex, id)">
                <button class="side-card-swap" type="button" aria-label="更换卡片功能" @click.stop>
                  <LayoutGrid :size="15" />
                </button>
                <template #dropdown>
                  <el-dropdown-menu class="side-card-menu">
                    <el-dropdown-item v-for="option in cardCatalog" :key="option.id" :command="option.id" :disabled="isCardPicked(option.id) && option.id !== card.id">
                      <span class="side-card-option"><component :is="option.icon" :size="15" /> {{ option.label }}</span>
                    </el-dropdown-item>
                    <el-dropdown-item divided command="__clear__">清空此卡片</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </header>
            <p class="side-card-summary">{{ card.summary() }}</p>
            <footer class="side-card-foot">
              <span>点击打开</span>
              <ChevronRight :size="15" />
            </footer>
          </article>
        </template>

        <el-dropdown v-else trigger="click" :placement="slotIndex === 0 ? 'bottom-start' : 'top-start'" :popper-options="{modifiers: [{name: 'flip', enabled: false}]}" @command="(id: unknown) => handleCardCommand(slotIndex, id)">
          <button class="side-card side-card-placeholder" type="button" aria-label="为此卡片选择功能">
            <span class="side-card-icon"><Plus :size="24" /></span>
            <span class="side-card-title">
              <strong>选择功能</strong>
              <small>把常用工具放到这里</small>
            </span>
          </button>
          <template #dropdown>
            <el-dropdown-menu class="side-card-menu">
              <el-dropdown-item v-for="option in cardCatalog" :key="option.id" :command="option.id" :disabled="isCardPicked(option.id)">
                <span class="side-card-option"><component :is="option.icon" :size="15" /> {{ option.label }}</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <div class="immersive-console">
      <section class="message-panel" aria-label="伴学对话">
        <div ref="storyViewport" class="message-viewport" aria-live="polite">
          <p
            v-if="latestAssistantLine"
            class="message-line"
            :class="latestAssistantLine.state"
          >
            <span class="message-speaker">{{ assistantDisplayName }}</span>
            <span class="message-text">{{ latestAssistantLine.text || '正在连接 Aervox…' }}<i v-if="latestAssistantLine.state === 'streaming'" class="stream-cursor" aria-hidden="true" /></span>
          </p>
          <p v-else class="message-line">
            <span class="message-speaker">{{ assistantDisplayName }}</span>
            <span class="message-text">正在连接 Aervox…</span>
          </p>

          <!-- UQ-01: 呈现向用户提问卡片 -->
          <UserQuestionComposer
            v-if="activeQuestion"
            :question-data="activeQuestion"
            :submitting="questionSubmitting"
            @submit="handleQuestionSubmit"
          />
        </div>
        <button class="message-history-entry" type="button" @click="historyOpen = true">
          <History :size="14" />
          <span>回看完整对话</span>
        </button>
      </section>

      <section class="composer-dock" :class="{open: composerOpen}" @focusout="handleDockFocusOut">
        <button v-if="!composerOpen" class="composer-collapsed" type="button" @click="expandComposer">
          <MessageCircle :size="16" />
          <span class="composer-collapsed-hint">{{ streaming ? '思隅正在回应…' : '点击输入消息' }}</span>
          <span class="composer-mode-chip">{{ activeMode.label }}</span>
          <span class="composer-access-chip" :class="{full: toolApprovalMode === 'full_access'}">
            <ShieldAlert v-if="toolApprovalMode === 'full_access'" :size="12" />
            <ShieldCheck v-else :size="12" />
            {{ toolApprovalMode === 'full_access' ? '完全访问' : '需确认' }}
          </span>
          <ChevronUp :size="15" />
        </button>

        <form v-else class="composer-expanded" @submit.prevent="sendMessage()">
          <label class="sr-only" for="aervox-composer">输入要发送给思隅的内容</label>
          <textarea
            id="aervox-composer"
            ref="composerTextarea"
            v-model="input"
            rows="3"
            :disabled="streaming"
            :placeholder="composerPlaceholder"
            @keydown.enter="handleComposerEnter"
            @input="handleComposerInputOrKey"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
          />
          <div class="composer-footer">
            <button
              type="button"
              class="permission-toggle"
              :class="{full: toolApprovalMode === 'full_access'}"
              :aria-pressed="toolApprovalMode === 'full_access'"
              :title="toolApprovalMode === 'full_access' ? '关闭完全访问' : '开启完全访问'"
              :disabled="streaming"
              @mousedown.prevent
              @click="toggleToolApprovalMode"
            >
              <ShieldAlert v-if="toolApprovalMode === 'full_access'" :size="16" />
              <ShieldCheck v-else :size="16" />
              <span>{{ toolApprovalMode === 'full_access' ? '完全访问' : '操作需确认' }}</span>
            </button>
            <div class="composer-actions">
              <button
                type="button"
                class="voice-input-btn"
                :class="{ active: voiceInput.isListening.value, transcribing: voiceInput.isTranscribing.value }"
                :title="voiceInput.isListening.value ? '点击停止语音输入 (说话停顿自动转写)' : '点击开始离线语音输入'"
                :disabled="streaming"
                @click="toggleVoiceInput"
              >
                <MicOff v-if="voiceInput.isListening.value" :size="19" />
                <Mic v-else :size="19" />
                <span v-if="voiceInput.isListening.value" class="recording-pulse" />
              </button>
              <button type="submit" :disabled="!input.trim() || streaming" :aria-label="streaming ? '正在生成回答' : '发送消息'">
                <span v-if="streaming" class="sending-dot" />
                <Send v-else :size="20" />
              </button>
              <button type="button" class="composer-collapse-btn" aria-label="收起输入框" :disabled="streaming" @click="collapseComposer">
                <ChevronDown :size="18" />
              </button>
            </div>
          </div>
        </form>

        <div v-if="voiceInputError" class="voice-input-inline-error">
          <span>{{ voiceInputError }}</span>
        </div>
      </section>
    </div>

    <Teleport to="body">
      <div v-if="historyOpen" class="history-overlay" @click.self="historyOpen = false">
        <section class="vn-history" role="dialog" aria-modal="true" aria-label="对话回看">
          <header class="vn-history-head">
            <span class="vn-history-title"><History :size="17" />对话回看</span>
            <button class="vn-history-close" type="button" aria-label="关闭对话回看" @click="historyOpen = false">
              <X :size="17" />
            </button>
          </header>
          <div ref="historyViewport" class="vn-history-list">
            <p v-for="line in story" :key="line.id" class="vn-history-line" :class="line.speaker">
              <span class="vn-history-speaker">{{ line.speaker === 'assistant' ? assistantDisplayName : '你' }}</span>
              <span class="vn-history-text">{{ line.text || (line.speaker === 'assistant' ? '…' : '') }}</span>
            </p>
            <p v-if="story.length === 0" class="vn-history-empty">还没有对话记录，先和思隅说句话吧。</p>
          </div>
          <footer class="vn-history-foot">上下滚动回溯完整对话 · Esc 或点击空白处关闭</footer>
        </section>
      </div>
    </Teleport>

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
        <div
          class="timer-dial-wrapper"
          :class="{running: timerRunning, dragging: isDraggingDial}"
          @mousedown="handleDialPointerDown"
          @touchstart="handleDialPointerDown"
        >
          <svg
            ref="timerDialRef"
            class="timer-dial-svg"
            viewBox="0 0 200 200"
            aria-hidden="true"
          >
            <!-- 浅色/半透明底轨 -->
            <circle
              class="timer-dial-track"
              cx="100"
              cy="100"
              :r="DIAL_RADIUS"
            />
            <!-- 高亮进度弧线 -->
            <circle
              class="timer-dial-progress"
              cx="100"
              cy="100"
              :r="DIAL_RADIUS"
              :stroke-dasharray="DIAL_CIRCUMFERENCE"
              :stroke-dashoffset="timerArcDashoffset"
            />
            <!-- 白色滑块圆圈手柄（引导用户拖拽，旋转中心为圆心 100,100，起始位置在正右方 180,100） -->
            <g
              v-if="!timerRunning"
              class="timer-dial-thumb-group"
              :style="{transform: `rotate(${thumbAngle}deg)`}"
            >
              <!-- 手柄外晕与白色实心圆点，位于 (100+DIAL_RADIUS, 100) = (180, 100) -->
              <circle
                class="timer-dial-thumb-halo"
                cx="180"
                cy="100"
                r="13"
              />
              <circle
                class="timer-dial-thumb"
                cx="180"
                cy="100"
                r="7.5"
              />
            </g>
          </svg>
          <div class="timer-dial-center">
            <strong>{{ formattedTime }}</strong>
            <small>{{ timerRunning ? '专注中' : '专注时间' }}</small>
          </div>
        </div>

        <p class="timer-guide-text">
          {{ timerRunning ? '保持当前节奏，结束后记得休息。' : `滑动圆环设定 ${timerMinutes} 分钟专注回合` }}
        </p>

        <div v-if="!timerRunning" class="timer-presets" role="radiogroup" aria-label="快捷预设时长">
          <button
            v-for="preset in [15, 25, 45, 60]"
            :key="preset"
            type="button"
            class="timer-preset-btn"
            :class="{active: timerMinutes === preset}"
            @click="selectPresetMinutes(preset)"
          >
            {{ preset }} 分钟
          </button>
        </div>

        <div class="timer-actions">
          <button type="button" @click="toggleTimer">
            <Pause v-if="timerRunning" :size="20" />
            <Play v-else :size="20" />
            {{ timerRunning ? '暂停' : '开始专注' }}
          </button>
          <button type="button" @click="resetTimer">
            <TimerReset :size="20" />
            重置
          </button>
        </div>
      </div>
    </el-drawer>

    <el-drawer v-model="studyOpen" title="今日学习" direction="rtl" size="min(520px, 96vw)" @open="reloadGoals">
      <p class="drawer-intro">目标、复习和日记都来自同一份 Aervox 学习数据。</p>
      <p v-if="apiError" class="drawer-error">{{ apiError }}</p>

      <section class="study-section">
        <div class="study-section-title-row">
          <h4>快速练习</h4>
            <button class="practice-start" type="button" :disabled="practiceBusy" @click="startPractice"><Sparkles :size="15" />{{ practiceSession ? '继续当前练习' : '开始 3 题练习' }}</button>
        </div>
        <p v-if="practiceError" class="drawer-error">{{ practiceError }}</p>
        <article v-if="practiceReport" class="practice-report">
          <strong>本次练习完成</strong>
          <p>已作答 {{ practiceReport.answeredCount }}/{{ practiceReport.questionCount }} 题 · 正确 {{ practiceReport.correctCount }} · 错误 {{ practiceReport.incorrectCount }} · 待确认 {{ practiceReport.unverifiableCount }}</p>
          <p v-if="practiceReport.accuracy !== null">可判定题正确率：{{ Math.round(practiceReport.accuracy * 100) }}%</p>
          <p v-if="practiceReport.avgTimeSpentSec !== null">平均用时：{{ practiceReport.avgTimeSpentSec }} 秒</p>
          <div class="practice-guidance" :class="`difficulty-${practiceReport.guidance.difficulty}`">
            <strong>
              {{ practiceReport.guidance.difficulty === 'ease' ? '📉 建议降低难度' : practiceReport.guidance.difficulty === 'increase' ? '📈 建议提高难度' : '➡️ 保持当前难度' }}
            </strong>
            <small>{{ practiceReport.guidance.message }}</small>
          </div>
          <small>{{ practiceReport.remainingCount > 0 ? `还有 ${practiceReport.remainingCount} 题未作答；` : '' }}{{ practiceReport.nextStep === 'review_scheduled' ? '错题已进入后续复习。' : practiceReport.nextStep === 'await_review' ? '待确认题暂不计入掌握度。' : '继续保持这个节奏。' }}</small>
        </article>
          <article v-else-if="practiceSession && practiceReadyToComplete" class="practice-panel">
            <strong>本次答案已保存</strong>
            <p>你可以结束练习并查看本次报告。</p>
            <button type="button" :disabled="practiceBusy" @click="finishPractice">生成练习报告</button>
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
        <label class="mistake-reason-filter">按错因筛选
          <select v-model="mistakeReasonFilter" aria-label="按错因筛选">
            <option value="all">全部错因</option>
            <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
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
            <p class="mistake-insight-summary">错因：{{ mistakeReasonLabel(item.reasonCode) }}</p>
            <div class="mistake-insight-editor">
              <label>错因
                <select :value="mistakeInsightDraft(item).reasonCode" :disabled="mistakeBusyId === item.questionId" @change="updateMistakeInsightDraft(item.questionId, {reasonCode: ($event.target as HTMLSelectElement).value})">
                  <option value="">清除错因记录</option>
                  <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <label>补充说明
                <input :value="mistakeInsightDraft(item).note" maxlength="500" placeholder="例如：循环边界少比较了一次" :disabled="mistakeBusyId === item.questionId" @input="updateMistakeInsightDraft(item.questionId, {note: ($event.target as HTMLInputElement).value})" />
              </label>
              <button type="button" :disabled="mistakeBusyId === item.questionId" @click="saveMistakeInsight(item)">保存错因</button>
            </div>
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
        <p v-if="reviewSummary" class="drawer-intro">今日 {{ reviewSummary.dueTodayCount }} 项 · 逾期 {{ reviewSummary.overdueCount }} 项 · 约 {{ reviewSummary.estimatedMinutes }} 分钟</p>
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
        <h4>学习计划 <small>{{ studyPlans.length }}</small></h4>
        <form class="study-goal-form" @submit.prevent="submitStudyPlan">
          <input v-model="newPlanTitle" placeholder="例如：期末考试复习" aria-label="计划名称" />
          <input v-model="newPlanEndDate" type="date" aria-label="计划结束日期" />
          <button type="submit" :disabled="planBusyId === 'new'" aria-label="创建学习计划"><Plus :size="18" /></button>
        </form>
        <ul class="study-list">
          <li v-for="plan in studyPlans" :key="plan.id">
            <div class="goal-item-heading"><span class="study-item-title">{{ plan.title }}</span><span class="goal-status">{{ plan.completionPrediction === 'at_risk' ? '需调整' : plan.completionPrediction === 'cannot_complete' ? '无法按期完成' : '进行中' }}</span></div>
            <small>{{ plan.startDate }} 至 {{ plan.endDate }} · {{ plan.dailyAvailableMinutes }} 分钟/天 · 已调整 {{ plan.revisionCount }} 次</small>
            <div class="study-goal-form">
              <input :value="planDraft(plan).endDate" type="date" aria-label="调整结束日期" @input="planDrafts[plan.id] = {...planDraft(plan), endDate: ($event.target as HTMLInputElement).value}" />
              <input :value="planDraft(plan).dailyAvailableMinutes" type="number" min="0" aria-label="调整每日可用时间" @input="planDrafts[plan.id] = {...planDraft(plan), dailyAvailableMinutes: Number(($event.target as HTMLInputElement).value)}" />
              <button type="button" :disabled="planBusyId === plan.id" @click="saveStudyPlan(plan)">调整</button>
            </div>
            <div class="goal-actions">
              <button type="button" :disabled="planBusyId === plan.id" @click="setPlanPrediction(plan.id, 'on_track')"><Check :size="14" />进度正常</button>
              <button type="button" :disabled="planBusyId === plan.id" @click="setPlanPrediction(plan.id, 'at_risk')">标记风险</button>
              <button type="button" class="danger" :disabled="planBusyId === plan.id" @click="archiveStudyPlan(plan.id)"><X :size="14" />归档</button>
            </div>
          </li>
          <li v-if="studyPlans.length === 0" class="study-empty">还没有学习计划，先设定一个结束日期。</li>
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
          <div v-if="settingsCategory === 'tools'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><LayoutGrid :size="18" /></span>
              <span><strong>快捷工具</strong><small>打开学习面板与常用小工具</small></span>
            </div>
            <div class="quick-tools">
              <button type="button" @click="openTool('study')">
                <BookOpen :size="19" />
                <span><strong>今日学习</strong><small>{{ goals.length }} 个目标 · {{ dueReviews.length }} 项复习</small></span>
              </button>
              <button type="button" @click="openTool('todo')">
                <ListTodo :size="19" />
                <span><strong>待办清单</strong><small>{{ unfinishedTodos.length }} 件待完成</small></span>
              </button>
              <button type="button" @click="openTool('timer')">
                <Clock3 :size="19" />
                <span><strong>番茄钟</strong><small>{{ formattedTime }} 专注计时</small></span>
              </button>
              <button type="button" @click="openTool('history')">
                <History :size="19" />
                <span><strong>对话回看</strong><small>{{ story.length }} 条对话记录</small></span>
              </button>
            </div>
          </div>
          <div v-else-if="settingsCategory === 'appearance'" class="settings-section">
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
          <LLMConfigPanel v-else-if="settingsCategory === 'model'" class="settings-section" />
          <PersonaManagerPanel v-else-if="settingsCategory === 'persona'" class="settings-section" />
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

    <el-dialog
      v-model="fullAccessDialogOpen"
      title="启用完全访问？"
      class="permission-confirm-dialog"
      width="min(500px, calc(100vw - 28px))"
      align-center
      @closed="resetFullAccessConfirmation"
    >
      <div class="permission-confirmation">
        <span class="permission-confirmation-icon"><ShieldAlert :size="24" /></span>
        <div>
          <p>完全访问会减少确认步骤，允许思隅在当前会话中直接执行普通写操作。</p>
          <small>管理员级操作、数据撤权、租户隔离与其它安全限制仍然生效。仅在你信任当前任务时开启。</small>
        </div>
      </div>
      <label class="permission-acknowledgement">
        <input v-model="fullAccessAcknowledged" type="checkbox" />
        <span>我已了解风险，并愿意继续</span>
      </label>
      <template #footer>
        <div class="permission-confirmation-actions">
          <button type="button" class="permission-cancel" @click="fullAccessDialogOpen = false">取消</button>
          <button type="button" class="permission-enable" :disabled="!fullAccessAcknowledged" @click="enableFullAccess">
            启用完全访问
          </button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
