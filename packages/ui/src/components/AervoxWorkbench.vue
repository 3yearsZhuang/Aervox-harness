<script setup lang="ts">
import {type Component, computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue'
import {
  AlertTriangle,
  Activity,
  Bell,
  BookOpen,
  BrainCircuit,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  ClipboardList,
  Clock3,
  CalendarDays,
  Database,
  Download,
  FileText,
  Gauge,
  Heart,
  Home,
  History,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  ListTodo,
  Menu,
  MessageCircle,
  Mic,
  MicOff,
  Moon,
  Music,
  NotebookPen,
  Paperclip,
  Pause,
  PauseCircle,
  Play,
  PlayCircle,
  Plus,
  Puzzle,
  RotateCcw,
  Route,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  TimerReset,
  Trash2,
  Users,
  Volume2,
  Workflow,
  X,
  Zap,
} from 'lucide-vue-next'
import {decideToolApproval, streamAervoxTurn, submitQuestionAnswers, uploadAervoxAttachment, useAervoxApi, useAervoxVoiceInput} from '@aervox/api-client'
import type {AskUserQuestionAnswerItem, AttachmentPurpose, ExtractedTerm, ToolApprovalMode, ToolApprovalRequiredEventData, TurnAttachmentRef, UserQuestionRequiredEventData} from '@aervox/contracts'
import {allowedMediaTypesSchema, MAX_ATTACHMENT_SIZE} from '@aervox/contracts'
import type {
  ProfileAuthorizationRequest,
  ProfileCapabilityState,
  ProfileDesiredState,
  ProfilePersistenceUpdate,
  ProactiveDesktopBridge,
  ProactiveHealthSampleView,
  ProactiveHomeEntityView,
  ProactiveIntelligenceDashboard,
  ProactiveProfileClaimView,
  ProactiveProfileStatus,
} from '@aervox/contracts/proactive'
import {profileStatusLabel} from '@aervox/contracts/proactive'
import PetHero from './PetHero.vue'
import PluginManagerPanel from './plugin/PluginManagerPanel.vue'
import Live2DPet from './Live2DPet.vue'
import PersonaManagerPanel from './persona/PersonaManagerPanel.vue'
import LocalVoiceConfigPanel from './voice/LocalVoiceConfigPanel.vue'
import LLMConfigPanel from './llm/LLMConfigPanel.vue'
import UserQuestionComposer from './UserQuestionComposer.vue'
import TermExploreDialog from './TermExploreDialog.vue'
import { renderMarkdown } from '../utils/markdown'
import { petReact } from '../live2d/petReactions'
import { MizukiExpression, MizukiMotion } from '../live2d/model'

type Platform = 'desktop' | 'web'
type Speaker = 'assistant' | 'user'

interface StoryLineAttachment {
  name: string
  mediaType: string
  previewUrl?: string
}

interface StoryLine {
  id: number
  speaker: Speaker
  text: string
  state?: 'streaming' | 'complete' | 'error'
  attachments?: StoryLineAttachment[]
}

type CardId = 'study' | 'todo' | 'timer' | 'history' | 'mistake' | 'quiz'

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
const mistakeOpen = ref(false)
const settingsOpen = ref(false)
const settingsCategory = ref<'tools' | 'appearance' | 'conversation' | 'model' | 'persona' | 'notifications' | 'voice' | 'plugins' | 'proactive'>('tools')
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
// UQ-01: 侧边提问卡（第一槽临时覆盖）的本地多选暂存
const questionCardSelected = ref<string[]>([])

// PET-05: 写工具审批待决（授权后重发相同请求命中已授予权限）
const pendingApproval = ref<(ToolApprovalRequiredEventData & { turnId: string; outgoing: string }) | null>(null)
const approvalBusy = ref(false)
const approvalToolLabels: Record<string, string> = {
  aervox_diary_write: '把今天的日记写进日记本',
  aervox_memory_store: '保存一条长期记忆',
}
const approvalToolLabel = computed(() => {
  const name = pendingApproval.value?.toolName ?? ''
  return approvalToolLabels[name] ?? `执行工具 ${name}`
})

// CAP-007 / CAP-002: 术语抽取与追问探索弹窗
const currentExtractedTerms = ref<ExtractedTerm[]>([])
const exploreDialogOpen = ref(false)
const selectedTerm = ref<ExtractedTerm | null>(null)
const practiceBusy = ref(false)
const practiceError = ref<string | null>(null)
const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active')
const mistakeReasonFilter = ref<string>('all')
const selectedMistakeIds = ref<string[]>([])
const mistakeBusyId = ref<string | null>(null)
const mistakeInsightDrafts = ref<Record<string, {reasonCode: string; note: string}>>({})
const reviewBusyId = ref<string | null>(null)
const newPlanTopic = ref('')
const newPlanLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner')
const newPlanMinutes = ref(25)
const planGenerating = ref(false)
const planBusyId = ref<string | null>(null)
const planError = ref<string | null>(null)
const input = ref('')
const isComposing = ref(false)
const composerPlaceholder = '和思隅聊聊学习或任何事…'
const cardSlots = ref<Array<CardId | null>>([null, null])
// 学习模式卡片联动：开启前的槽位快照（仅存内存，不写 localStorage，退出/回落时恢复）
let savedCardSlots: Array<CardId | null> | null = null
const timerSeconds = ref(25 * 60)
const timerRunning = ref(false)
const streaming = ref(false)
const isDark = ref(false)
const assistantDisplayName = ref(props.assistantName)
const enterToSend = ref(true)
const compactMode = ref(false)
const studyModeEnabled = ref(false)
const timerMinutes = ref(25)
const desktopCompanionEnabled = ref(props.showCompanion)
const dailyReminder = ref(true)
const toolApprovalMode = ref<ToolApprovalMode>('ask')
const fullAccessDialogOpen = ref(false)
const fullAccessAcknowledged = ref(false)
const proactiveStatus = ref<ProactiveProfileStatus | null>(null)
const proactiveClaims = ref<readonly ProactiveProfileClaimView[]>([])
const proactiveDialogOpen = ref(false)
const proactiveAcknowledged = ref(false)
const proactiveAutostart = ref(true)
const proactiveBackground = ref(true)
const proactiveBusy = ref(false)
const proactiveError = ref<string | null>(null)
const proactiveNotice = ref<string | null>(null)
const proactiveDashboard = ref<ProactiveIntelligenceDashboard | null>(null)
const proactiveView = ref<'overview' | 'integrations'>('overview')
const homeAssistantForm = ref({displayName: '家庭', endpoint: 'http://homeassistant.local:8123', accessToken: ''})
const xiaomiHealthForm = ref({
  displayName: '小米运动健康',
  apiBaseUrl: '',
  accessToken: '',
  refreshToken: '',
  tokenEndpoint: '',
  clientId: '',
  clientSecret: '',
  dailyPath: '/v1/health/daily',
})
const homeEntityOpsDrafts = ref<Record<string, string>>({})
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
  learningPlans,
  activePracticeSession,
  error: apiError,
} = api
let nextStoryId = 2

const isWeb = computed(() => props.platform === 'web')
const proactiveBridge = (): ProactiveDesktopBridge | undefined => {
  if (typeof window === 'undefined') return undefined
  return (window as Window & {fairyDesktop?: {proactive?: ProactiveDesktopBridge}}).fairyDesktop?.proactive
}
function recordProactiveActivity(
  source: 'aervox.activity' | 'aervox.operation',
  eventType: string,
  payloadText?: string,
  metadata?: Record<string, unknown>,
) {
  if (isWeb.value || proactiveStatus.value?.desiredState !== 'enabled') return
  void proactiveBridge()?.recordActivity(source, {eventType, payloadText, metadata}).catch(() => undefined)
}
const proactiveActive = computed(() => proactiveStatus.value?.effectiveState === 'active')
const homeAssistantConnections = computed(() => proactiveDashboard.value?.connections.filter((item) => item.provider === 'home_assistant') ?? [])
const xiaomiHealthConnections = computed(() => proactiveDashboard.value?.connections.filter((item) => item.provider === 'xiaomi_health') ?? [])
const homeAssistantEntities = computed(() => proactiveDashboard.value?.homeEntities ?? [])
const proactiveIntelligenceCapabilities = computed(() => {
  const dashboard = proactiveDashboard.value
  return [
    {id: 'timeline', label: '统一个人时间线', icon: History, count: dashboard?.timeline.length ?? 0},
    {id: 'projects', label: '项目与意图图谱', icon: Route, count: dashboard?.projects.length ?? 0},
    {id: 'workflows', label: '操作流程学习', icon: Workflow, count: dashboard?.workflows.length ?? 0},
    {id: 'triggers', label: '情境主动触发', icon: Zap, count: dashboard?.triggers.length ?? 0},
    {id: 'verification', label: '计划执行验证', icon: Check, count: dashboard?.verifications.length ?? 0},
    {id: 'conflicts', label: '画像冲突纠正', icon: AlertTriangle, count: dashboard?.conflicts.length ?? 0},
    {id: 'preparations', label: '主动准备包', icon: Sparkles, count: dashboard?.preparations.length ?? 0},
    {id: 'attention', label: '注意力与疲劳', icon: Gauge, count: dashboard?.attention.length ?? 0},
    {id: 'drift', label: '行为漂移检测', icon: Activity, count: dashboard?.drift.length ?? 0},
    {id: 'relationships', label: '关系与沟通上下文', icon: Users, count: dashboard?.relationships.length ?? 0},
    {id: 'scenes', label: '本地场景模型', icon: Home, count: dashboard?.scenes.length ?? 0},
    {id: 'reviews', label: '每日与每周回顾', icon: CalendarDays, count: dashboard?.reviews.length ?? 0},
  ]
})
const accessChipLabel = computed(() => proactiveActive.value ? '主动智能模式' : toolApprovalMode.value === 'full_access' ? '完全访问' : '操作需确认')
const accessChipIcon = computed(() => proactiveActive.value ? BrainCircuit : toolApprovalMode.value === 'full_access' ? ShieldAlert : ShieldCheck)
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
  {id: 'proactive', label: '主动智能', description: '全量画像与本地权限', icon: BrainCircuit},
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
  {id: 'study', label: '学习规划', description: 'AI 生成里程碑式学习路线图', icon: BookOpen, summary: () => `${learningPlans.value.length} 份进行中规划`, action: () => openTool('study')},
  {id: 'mistake', label: '错题本', description: '针对性练习未掌握的题', icon: Puzzle, summary: () => `${activeMistakeCount.value} 题待掌握`, action: () => openTool('mistake')},
  {id: 'quiz', label: '刷题模式', description: 'AI 现场出题，答错自动进错题本', icon: ClipboardList, summary: () => activePracticeSession.value ? '进行中的练习' : 'AI 出题 · 即时判定', action: () => startQuiz()},
  {id: 'todo', label: '待办清单', description: '勾选完成今天的待办事项', icon: ListTodo, summary: () => `待完成 ${unfinishedTodos.value.length} 件`, action: () => openTool('todo')},
  {id: 'timer', label: '番茄钟', description: '专注计时，劳逸结合', icon: Clock3, summary: () => timerRunning.value ? `${formattedTime.value} 专注中` : `${formattedTime.value} 待开始`, action: () => openTool('timer')},
  {id: 'history', label: '对话回看', description: '回顾与思隅的历史对话', icon: History, summary: () => `${story.value.length} 条对话记录`, action: () => openTool('history')},
])

const slotCards = computed(() => cardSlots.value.map((id) => id ? cardCatalog.value.find((card) => card.id === id) ?? null : null))

/** 侧边提问卡展示的问题（UQ-01：覆盖第一槽，多题时只展示第一题，完整交互见消息面板） */
const questionCardData = computed(() => activeQuestion.value?.questions[0] ?? null)

/** 学习模式卡片联动：把两个槽位临时替换为「今日学习 + 番茄钟」（不写 localStorage，刷新后回落持久化配置） */
function applyStudyCardLayout() {
  savedCardSlots = [...cardSlots.value]
  cardSlots.value = ['study', 'timer']
}

/** 学习模式卡片联动：恢复开启前的槽位快照 */
function restoreStudyCardLayout() {
  if (!savedCardSlots) return
  cardSlots.value = savedCardSlots
  savedCardSlots = null
}

/** 每日一题入口：经系统浏览器打开牛客每日一题（纯跳转，不抓取数据） */
const DAILY_PROBLEM_URL = 'https://www.nowcoder.com/problem/tracker'

function openDailyProblem() {
  recordProactiveActivity('aervox.operation', 'workbench.daily_problem_opened', DAILY_PROBLEM_URL)
  petReactKind('forward', {lookAtEl: '.side-cards'})
  const desktopBridge = (window as Window & {fairyDesktop?: {openExternal?: (url: string) => Promise<void>}}).fairyDesktop
  if (desktopBridge?.openExternal) void desktopBridge.openExternal(DAILY_PROBLEM_URL)
  else window.open(DAILY_PROBLEM_URL, '_blank', 'noopener')
}

/** 侧边提问卡选项点击：单选直接提交，多选本地暂存 */
function handleQuestionCardOption(label: string) {
  const question = questionCardData.value
  if (!question) return
  if (question.multiSelect) {
    questionCardSelected.value = questionCardSelected.value.includes(label)
      ? questionCardSelected.value.filter((item) => item !== label)
      : [...questionCardSelected.value, label]
    return
  }
  void handleQuestionSubmit([{id: question.id, selected: [label]}])
}

/** 侧边提问卡多选提交 */
function submitQuestionCardAnswers() {
  const question = questionCardData.value
  if (!question || questionCardSelected.value.length === 0) return
  void handleQuestionSubmit([{id: question.id, selected: [...questionCardSelected.value]}])
}

// 提问结束后清空侧边提问卡的本地多选暂存
watch(activeQuestion, (value) => {
  if (!value) questionCardSelected.value = []
})

const menuOpen = ref(false)
const menuPillRef = ref<HTMLElement | null>(null)

/** 主导航：全部映射到既有功能（全部为居中弹窗），不引入新能力 */
const menuItems: Array<{ id: string; label: string; icon: Component; action: () => void }> = [
  {id: 'study', label: '规划', icon: BookOpen, action: () => openTool('study')},
  {id: 'mistake', label: '错题本', icon: Puzzle, action: () => openTool('mistake')},
  {id: 'todo', label: '待办', icon: ListTodo, action: () => openTool('todo')},
  {id: 'timer', label: '番茄钟', icon: Clock3, action: () => openTool('timer')},
  {id: 'history', label: '回看', icon: History, action: () => openTool('history')},
]

/** 功能弹窗左侧导航：五个功能统一入口，当前弹窗高亮，点击即切换 */
const toolNavItems: Array<{ id: ToolId; label: string; description: string; icon: Component }> = [
  {id: 'study', label: '学习规划', description: 'AI 生成学习路线图', icon: BookOpen},
  {id: 'mistake', label: '错题本', description: '针对性重练未掌握题', icon: Puzzle},
  {id: 'todo', label: '待办清单', description: '勾选完成今天的待办', icon: ListTodo},
  {id: 'timer', label: '番茄钟', description: '专注计时，劳逸结合', icon: Clock3},
  {id: 'history', label: '对话回看', description: '回顾历史对话记录', icon: History},
]

/** Live2D 操作反馈动作池：按语义挑选 Mizuki 动作子集，随机取用避免重复 */
const PET_MOTION_POOLS = {
  glad: [MizukiMotion.w_cute_glad01, MizukiMotion.w_cute_glad03, MizukiMotion.w_adult_glad01, MizukiMotion.w_happy_glad01, MizukiMotion.w_normal_glad01],
  nod: [MizukiMotion.w_cute_nod01, MizukiMotion.w_normal_nod01, MizukiMotion.w_adult_nod01, MizukiMotion.w_happy_nod01],
  think: [MizukiMotion.w_adult_think01, MizukiMotion.w_adult_think02],
  shake: [MizukiMotion.w_normal_shakehead01, MizukiMotion.w_happy_shakehead01, MizukiMotion.w_cute_shakehead01],
  greet: [MizukiMotion.w_normal_greeting01, MizukiMotion.w_cute_poseforward02],
  forward: [MizukiMotion.w_cute_forward01, MizukiMotion.w_normal_forward01, MizukiMotion.w_happy_forward01],
  tilthead: [MizukiMotion.w_normal_tilthead01, MizukiMotion.w_cute_tilthead01, MizukiMotion.w_adult_tilthead01],
  sad: [MizukiMotion.w_normal_sad01, MizukiMotion.w_happy_sad01, MizukiMotion.w_cool_sad01],
} as const

type PetReactionKind = keyof typeof PET_MOTION_POOLS

/** 按语义派发桌宠反馈：动作 + 表情 + 看向目标 + 说话 */
function petReactKind(kind: PetReactionKind, options: {expression?: MizukiExpression; lookAtEl?: string | Element; speak?: string; lookDuration?: number} = {}) {
  const pool = PET_MOTION_POOLS[kind]
  petReact({
    motion: pool[Math.floor(Math.random() * pool.length)],
    expression: options.expression,
    lookAtEl: options.lookAtEl,
    lookDuration: options.lookDuration,
    speak: options.speak,
  })
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) petReactKind('greet', {lookAtEl: '.menu-pill', lookDuration: 3200})
  else petReactKind('nod')
}

/** 收起态点击胶囊任意区域（含边缘空白）均可展开 */
function handlePillClick() {
  if (!menuOpen.value) {
    menuOpen.value = true
    petReactKind('greet', {lookAtEl: '.menu-pill', lookDuration: 3200})
  }
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

// ============ 多模态输入（CAP-012）：输入框附件上传 ============

interface PendingAttachment {
  key: string
  file: File
  name: string
  mediaType: string
  size: number
  previewUrl?: string
}

const pendingAttachments = ref<PendingAttachment[]>([])
const attachmentError = ref<string | null>(null)
const attachmentUploading = ref(false)
const attachmentFileInput = ref<HTMLInputElement | null>(null)

/** 扩展名 → MIME（file.type 缺失时的兜底映射，与 contracts allowedMediaTypesSchema 对齐） */
const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  weba: 'audio/webm',
}

const ALLOWED_MEDIA_TYPES = allowedMediaTypesSchema.options as readonly string[]

const attachmentAccept = [...ALLOWED_MEDIA_TYPES, ...Object.keys(EXTENSION_MEDIA_TYPES).map((ext) => `.${ext}`)].join(',')

function resolveMediaType(file: File): string | null {
  const type = file.type || EXTENSION_MEDIA_TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''] || ''
  return ALLOWED_MEDIA_TYPES.includes(type) ? type : null
}

function purposeForMediaType(mediaType: string): AttachmentPurpose {
  if (mediaType.startsWith('image/')) return 'question'
  if (mediaType === 'application/pdf') return 'reading'
  if (mediaType.startsWith('audio/')) return 'audio'
  return 'file'
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function attachmentIconFor(mediaType: string) {
  if (mediaType.startsWith('image/')) return ImageIcon
  if (mediaType.startsWith('audio/')) return Music
  return FileText
}

function triggerAttachmentPicker() {
  attachmentFileInput.value?.click()
  petReactKind('tilthead', {lookAtEl: '.composer-dock', lookDuration: 2000})
}

function handleFilesChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  attachmentError.value = null
  for (const file of files) {
    if (pendingAttachments.value.length >= 10) {
      attachmentError.value = '一次最多携带 10 个附件。'
      break
    }
    const mediaType = resolveMediaType(file)
    if (!mediaType) {
      attachmentError.value = `「${file.name}」的类型暂不支持（支持图片 / PDF / 文档 / 音频）。`
      continue
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      attachmentError.value = `「${file.name}」超过 10MB 上限。`
      continue
    }
    pendingAttachments.value.push({
      key: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name,
      mediaType,
      size: file.size,
      previewUrl: mediaType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    })
  }
  if (pendingAttachments.value.length > 0) {
    petReactKind('glad', {expression: MizukiExpression.face_notice_01, lookAtEl: '.composer-attachments', lookDuration: 2600})
  }
}

function removePendingAttachment(key: string) {
  const index = pendingAttachments.value.findIndex((item) => item.key === key)
  if (index < 0) return
  const [removed] = pendingAttachments.value.splice(index, 1)
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
  petReactKind('shake', {lookAtEl: '.composer-dock'})
}

/** 发送前上传全部待发附件，返回 turn 消息引用清单 */
async function uploadPendingAttachments(): Promise<TurnAttachmentRef[]> {
  const refs: TurnAttachmentRef[] = []
  for (const item of pendingAttachments.value) {
    const uploaded = await uploadAervoxAttachment({
      file: item.file,
      name: item.name,
      mediaType: item.mediaType,
      purpose: purposeForMediaType(item.mediaType),
    })
    refs.push({attachmentId: uploaded.id, name: item.name, mediaType: item.mediaType})
  }
  return refs
}

function clearPendingAttachments() {
  for (const item of pendingAttachments.value) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  }
  pendingAttachments.value = []
}

async function scrollStoryToBottom() {
  await nextTick()
  storyViewport.value?.scrollTo({top: storyViewport.value.scrollHeight, behavior: 'smooth'})
  // 分句模式下当前句 markdown-body 自身限高滚动：跟随打字/切句位置滚到末尾
  const sentenceBody = storyViewport.value?.querySelector('.message-novel-text .markdown-body, .message-text > .markdown-body') as HTMLElement | null
  if (sentenceBody) sentenceBody.scrollTop = sentenceBody.scrollHeight
}

/** 主对话框只保留最新一条 AI 回复，完整上下文由二级回看窗口承载 */
const latestAssistantLine = computed<StoryLine | null>(() => {
  for (let i = story.value.length - 1; i >= 0; i--) {
    if (story.value[i].speaker === 'assistant') return story.value[i]
  }
  return null
})

/* ── 视觉小说式分句呈现（CAP-001）：流式只显示第一句，余句缓存，「下一句」逐句释放 ── */

/** 当前显示的句子索引（视觉小说切换模式：一次只显示一句，非追加） */
const novelIndex = ref(0)

/** 对话区域收起开关（高度折叠为细条，只留摘要行 + 展开按钮；内存态，刷新回落展开） */
const consoleCollapsed = ref(false)

/** 收起态摘要：流式显示首句打字、完成显示当前句，单行省略 */
const collapsedSummaryText = computed(() => {
  const line = latestAssistantLine.value
  if (!line) return '正在连接 Aervox…'
  if (line.state === 'streaming') return novelStreamingText.value || '思隅正在回应…'
  if (line.state === 'error') return line.text
  return novelDisplayText.value || '这次没有收到可展示的回答。'
})

/** 把回复按句末标点（。！？…）或换行切段，保留句末标点 */
function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  return normalized
    .split(/(?<=[。!?!?…])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

const novelSentences = computed(() => {
  const line = latestAssistantLine.value
  return line ? splitIntoSentences(line.text) : []
})

/** 流式期间只显示第一句：打字机效果自然落在首句上，后续句子静默缓存 */
const novelStreamingText = computed(() => novelSentences.value[0] ?? '')

/** 完成态只显示当前句（切换而非追加，对话框高度恒定不超限） */
const novelDisplayText = computed(() => novelSentences.value[Math.min(novelIndex.value, novelSentences.value.length - 1)] ?? '')

/** 剩余未读句数（不含当前句） */
const queuedSentenceCount = computed(() => Math.max(0, novelSentences.value.length - novelIndex.value - 1))
const hasQueuedSentence = computed(() => queuedSentenceCount.value > 0)

/** 新回复（或重发）开始时重置到第一句 */
watch(latestAssistantLine, (_line, old) => {
  if (old !== undefined) novelIndex.value = 0
})

/** 「下一句」：切换显示缓存中的下一句（替换当前句），桌宠同步念出该句 */
function showNextSentence() {
  if (!hasQueuedSentence.value) return
  novelIndex.value++
  const sentence = novelSentences.value[novelIndex.value]
  if (sentence) petReact({speak: sentence})
  // 新句从顶部开始显示（限高滚动容器复位）
  void nextTick(() => {
    const sentenceBody = storyViewport.value?.querySelector('.message-novel-text .markdown-body') as HTMLElement | null
    if (sentenceBody) sentenceBody.scrollTop = 0
  })
}

/** 视觉小说式对话回看：打开时滚到最新一条 */
const historyViewport = ref<HTMLElement | null>(null)

watch(historyOpen, async (open) => {
  if (open) {
    petReactKind('think', {expression: MizukiExpression.face_notice_01, lookAtEl: '.history-overlay', lookDuration: 3200})
    await nextTick()
    historyViewport.value?.scrollTo({top: historyViewport.value.scrollHeight})
  } else {
    petReactKind('nod')
  }
})

/** 设置弹窗开合的桌宠反馈：开启时看向弹窗、关闭时点头 */
watch(settingsOpen, async (open) => {
  if (open) {
    petReactKind('tilthead', {expression: MizukiExpression.face_notice_01})
    await nextTick()
    petReact({lookAtEl: '.el-dialog.settings-dialog', lookDuration: 3600})
  } else {
    petReactKind('nod')
  }
})

function handleHistoryEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && historyOpen.value) historyOpen.value = false
}

function openTermExplore(term: ExtractedTerm) {
  selectedTerm.value = term
  exploreDialogOpen.value = true
}

async function sendMessage(value = input.value, options?: { quizMode?: boolean; resend?: boolean }) {
  const text = value.trim()
  if ((!text && pendingAttachments.value.length === 0) || streaming.value) return

  // 附件先行上传（CAP-012 多模态输入），失败则保留待发清单供重试
  let attachmentRefs: TurnAttachmentRef[] = []
  if (pendingAttachments.value.length > 0) {
    attachmentUploading.value = true
    try {
      attachmentRefs = await uploadPendingAttachments()
    } catch (error) {
      attachmentError.value = error instanceof Error ? `附件上传失败：${error.message}` : '附件上传失败，请重试。'
      petReactKind('sad', {expression: MizukiExpression.face_trouble_01, lookAtEl: '.composer-attachments'})
      return
    } finally {
      attachmentUploading.value = false
    }
  }

  // 纯附件发送时使用占位文案满足 content 契约（min(1)）；对话记录展示用户原文或附件标记
  const displayText = text || '（发送了附件）'
  const outgoingText = text || '请查看我上传的附件。'

  // 若开启专注模式则自动附带专注模式前缀触发专属启发式教学 Prompt，对话记录仍展示用户原文。
  // 刷题触发时刷题前缀优先于专注模式前缀：本回合由刷题规范接管教学规则。
  const quizPrefix = options?.quizMode ? '[模式：刷题模式] ' : ''
  const modePrefix = quizPrefix || (studyModeEnabled.value ? '[模式：专注模式] ' : '')
  const outgoing = modePrefix && !outgoingText.startsWith(modePrefix) ? modePrefix + outgoingText : outgoingText

  const assistantLine = createStoryLine('assistant', '', 'streaming')
  // 授权重发不重复展示用户气泡（原文已在对话记录中）
  if (options?.resend) {
    story.value.push(assistantLine)
  } else {
    const userLine = createStoryLine('user', displayText)
    if (attachmentRefs.length > 0) {
      userLine.attachments = pendingAttachments.value.map((item) => ({name: item.name, mediaType: item.mediaType, previewUrl: item.previewUrl}))
      clearPendingAttachments()
    }
    story.value.push(userLine, assistantLine)
  }
  // 关键：push 后从 reactive 数组取回代理引用（resend 与普通发送两个分支的最后一条都是 assistantLine）；
  // 若继续持有原始对象，onDelta/onDone 的赋值将绕过代理 set trap，不触发响应式更新
  // （novelSentences 等 computed 依赖代理的 .text/.state，收不到通知就会永远停在空值）。
  const liveAssistantLine: StoryLine = story.value[story.value.length - 1]
  input.value = ''
  streaming.value = true
  activeQuestion.value = null
  currentExtractedTerms.value = []
  petReactKind('think', {lookAtEl: '.message-panel'})
  await scrollStoryToBottom()
  recordProactiveActivity('aervox.activity', 'conversation.turn_submitted', text, {
    studyModeEnabled: studyModeEnabled.value,
    toolApprovalMode: toolApprovalMode.value,
    characterCount: text.length,
  })

  /** 流式期间每 1.2s 驱动一次口型，让桌宠"开口说话" */
  let lastSpeakAt = 0
  try {
    await streamAervoxTurn(
      outgoing,
      {
        onDelta: (delta) => {
          liveAssistantLine.text += delta
          void scrollStoryToBottom()
          const now = Date.now()
          if (now - lastSpeakAt > 1200 && delta.trim()) {
            lastSpeakAt = now
            petReact({speak: delta})
          }
        },
        onDone: () => {
          liveAssistantLine.state = 'complete'
          activeQuestion.value = null
          if (!liveAssistantLine.text) liveAssistantLine.text = '这次没有收到可展示的回答，请再试一次。'
          petReactKind('glad', {expression: MizukiExpression.face_smile_01, speak: liveAssistantLine.text})
        },
        onUserQuestion: (qData) => {
          activeQuestion.value = qData
          currentTurnId.value = qData.turnId
          // 侧边第一槽临时切换为提问卡，桌宠看向卡片区提示作答入口
          petReactKind('tilthead', {lookAtEl: '.side-cards', lookDuration: 3200})
          void scrollStoryToBottom()
        },
        onTermsExtracted: (tData) => {
          currentExtractedTerms.value = tData.terms
        },
        onToolApproval: (aData) => {
          pendingApproval.value = {...aData, outgoing}
          void scrollStoryToBottom()
        },
      },
      {toolApprovalMode: toolApprovalMode.value, attachments: attachmentRefs},
    )
  } catch (error) {
    console.error('对话流式失败', error)
    liveAssistantLine.state = 'error'
    liveAssistantLine.text = error instanceof Error ? `连接失败：${error.message}` : '连接失败，请稍后重试。'
    petReactKind('sad', {expression: MizukiExpression.face_sad_01})
  } finally {
    streaming.value = false
    if (!input.value.trim()) composerOpen.value = false
    await scrollStoryToBottom()
  }
}

/** PET-05：提交写工具授权决定；批准后重发相同请求命中已授予权限 */
async function handleApprovalDecision(decision: 'granted' | 'denied') {
  const pending = pendingApproval.value
  if (!pending || approvalBusy.value) return
  approvalBusy.value = true
  try {
    await decideToolApproval(pending.turnId, pending.approvalId, decision)
    pendingApproval.value = null
    if (decision === 'granted') {
      await sendMessage(pending.outgoing, {resend: true})
    } else if (streaming.value) {
      streaming.value = false
    }
  } catch (err) {
    console.error('提交授权决定失败', err)
  } finally {
    approvalBusy.value = false
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
  petReactKind('tilthead', {lookAtEl: '.composer-dock'})
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
  localStorage.setItem('aervox-tool-approval-mode', mode)
  void refreshProactiveStatus()
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

type ToolId = 'study' | 'mistake' | 'todo' | 'timer' | 'history'

function capabilityStatusLabel(status: ProfileCapabilityState['osStatus']): string {
  return {
    granted: '已授权',
    denied: '已拒绝',
    prompt: '等待授权',
    unavailable: '不可用',
    unknown: '待验证',
  }[status]
}

function capabilityStatusClass(status: ProfileCapabilityState['osStatus']): string {
  return `is-${status}`
}

function proactiveStateLabel(status: ProactiveProfileStatus | null): string {
  if (!status) return isWeb.value ? '桌面端可用' : '未连接本地 Host'
  return profileStatusLabel(status.effectiveState)
}

function proactiveSuspendHint(status: ProactiveProfileStatus | null): string {
  if (!status || (status.effectiveState !== 'suspended' && status.effectiveState !== 'limited')) return ''
  if (status.host?.reason === 'unsigned_development_host') {
    return '未签名的开发构建默认不受信任；使用 ./aervox dev（已自动设置 AERVOX_TRUST_LOCAL_DEV_HOST=1）或手动设置该变量后重新打开。'
  }
  const reasonLabel: Record<string, string> = {
    tool_mode: '请先在输入区开启「完全访问」。',
    user_paused: '你已手动暂停观察，可点击「恢复观察」。',
    local_unavailable: '本地 API 不可达或 Host 未受信，请确认 API 已在本机运行。',
    os_permission: '存在未授予的必需系统权限，请在下方列表逐项授权。',
    lease_expired: '激活租约已过期，刷新状态即可续期。',
    watermark: '授权快照与服务端不一致，请重新确认授权。',
    policy_mismatch: '授权版本与服务端策略不一致，请重新确认授权。',
    source_revision_changed: '画像授权修订已变化，请重新确认授权。',
  }
  return status.suspendReason ? reasonLabel[status.suspendReason] ?? '' : ''
}

async function refreshProactiveStatus() {
  const bridge = proactiveBridge()
  if (isWeb.value || !bridge) {
    proactiveStatus.value = null
    return
  }
  try {
    const [status, claims, dashboard] = await Promise.all([
      bridge.getStatus(toolApprovalMode.value),
      bridge.listClaims().catch(() => []),
      bridge.getIntelligenceDashboard().catch(() => null),
    ])
    proactiveStatus.value = status
    proactiveClaims.value = claims
    proactiveDashboard.value = dashboard
    if (dashboard) {
      homeEntityOpsDrafts.value = Object.fromEntries(
        dashboard.homeEntities.map((entity) => [entity.id, entity.allowedOps.join(', ')]),
      )
    }
    proactiveAutostart.value = proactiveStatus.value.persistence.autostart
    proactiveBackground.value = proactiveStatus.value.persistence.background
    proactiveError.value = null
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '无法读取主动智能状态'
  }
}

function integrationTime(value: string | null | undefined): string {
  if (!value) return '尚未同步'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', {hour12: false})
}

function healthMetricLabel(sample: ProactiveHealthSampleView): string {
  return {
    steps: '步数',
    sleep_minutes: '睡眠',
    resting_heart_rate: '静息心率',
  }[sample.metric] ?? sample.metric
}

function healthMetricValue(sample: ProactiveHealthSampleView): string {
  if (sample.metric === 'sleep_minutes') return `${Math.floor(sample.value / 60)} 小时 ${sample.value % 60} 分`
  return `${sample.value} ${sample.unit === 'count' ? '步' : sample.unit}`
}

async function connectHomeAssistant() {
  const bridge = proactiveBridge()
  if (!bridge || !proactiveActive.value || !homeAssistantForm.value.endpoint.trim() || !homeAssistantForm.value.accessToken.trim()) return
  proactiveBusy.value = true
  proactiveError.value = null
  proactiveNotice.value = null
  try {
    await bridge.connectHomeAssistant({
      displayName: homeAssistantForm.value.displayName.trim() || '家庭',
      endpoint: homeAssistantForm.value.endpoint.trim(),
      accessToken: homeAssistantForm.value.accessToken,
      subscriptionEnabled: true,
    })
    homeAssistantForm.value.accessToken = ''
    proactiveNotice.value = 'Home Assistant 已连接并完成实体同步'
    await refreshProactiveStatus()
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : 'Home Assistant 连接失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function connectXiaomiHealth() {
  const bridge = proactiveBridge()
  if (!bridge || !proactiveActive.value || !xiaomiHealthForm.value.apiBaseUrl.trim() || !xiaomiHealthForm.value.accessToken.trim()) return
  proactiveBusy.value = true
  proactiveError.value = null
  proactiveNotice.value = null
  try {
    await bridge.connectXiaomiHealth({
      displayName: xiaomiHealthForm.value.displayName.trim() || '小米运动健康',
      apiBaseUrl: xiaomiHealthForm.value.apiBaseUrl.trim(),
      accessToken: xiaomiHealthForm.value.accessToken,
      refreshToken: xiaomiHealthForm.value.refreshToken.trim() || undefined,
      tokenEndpoint: xiaomiHealthForm.value.tokenEndpoint.trim() || undefined,
      clientId: xiaomiHealthForm.value.clientId.trim() || undefined,
      clientSecret: xiaomiHealthForm.value.clientSecret,
      dailyPath: xiaomiHealthForm.value.dailyPath.trim() || undefined,
      scopes: ['steps', 'sleep', 'resting_heart_rate'],
    })
    xiaomiHealthForm.value.accessToken = ''
    xiaomiHealthForm.value.refreshToken = ''
    xiaomiHealthForm.value.clientSecret = ''
    proactiveNotice.value = '小米运动健康已连接并完成今日同步'
    await refreshProactiveStatus()
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '小米运动健康连接失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function syncProactiveConnection(provider: string, connectionId: string) {
  const bridge = proactiveBridge()
  if (!bridge) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    if (provider === 'home_assistant') await bridge.syncHomeAssistant(connectionId)
    else await bridge.syncXiaomiHealth(connectionId)
    proactiveNotice.value = '同步完成'
    await refreshProactiveStatus()
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '外部连接同步失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function deleteProactiveConnection(provider: string, connectionId: string, displayName: string) {
  const bridge = proactiveBridge()
  if (!bridge || !window.confirm(`撤销“${displayName}”并删除本地凭据与缓存数据？`)) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    if (provider === 'home_assistant') await bridge.deleteHomeAssistant(connectionId)
    else await bridge.deleteXiaomiHealth(connectionId)
    proactiveNotice.value = `已撤销 ${displayName}`
    await refreshProactiveStatus()
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '外部连接撤销失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function updateHomeEntity(entity: ProactiveHomeEntityView, patch: {enabled?: boolean; allowedOps?: string[]}) {
  const bridge = proactiveBridge()
  if (!bridge) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    const updated = await bridge.configureHomeAssistantEntity(entity.connectionId, entity.entityId, patch)
    if (proactiveDashboard.value) {
      proactiveDashboard.value = {
        ...proactiveDashboard.value,
        homeEntities: proactiveDashboard.value.homeEntities.map((item) => item.id === updated.id ? updated : item),
      }
    }
    homeEntityOpsDrafts.value[updated.id] = updated.allowedOps.join(', ')
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : 'Home Assistant 实体授权更新失败'
  } finally {
    proactiveBusy.value = false
  }
}

function toggleHomeEntity(entity: ProactiveHomeEntityView, event: Event) {
  void updateHomeEntity(entity, {enabled: (event.target as HTMLInputElement).checked})
}

function saveHomeEntityOps(entity: ProactiveHomeEntityView) {
  const allowedOps = (homeEntityOpsDrafts.value[entity.id] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  void updateHomeEntity(entity, {allowedOps})
}

function proactiveClaimStateLabel(state: ProactiveProfileClaimView['state']): string {
  return {
    observed: '已观察',
    inferred: '推断',
    user_asserted: '用户提供',
    confirmed: '已确认',
    rejected: '已拒绝',
  }[state]
}

async function updateProactiveClaimState(claim: ProactiveProfileClaimView, state: 'confirmed' | 'rejected') {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    const updated = await bridge.updateClaimState(claim.id, state)
    proactiveClaims.value = proactiveClaims.value.map((item) => item.id === updated.id ? updated : item)
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '画像记忆状态更新失败'
  } finally {
    proactiveBusy.value = false
  }
}

function openProactiveAuthorization() {
  proactiveError.value = null
  proactiveAcknowledged.value = false
  proactiveAutostart.value = proactiveStatus.value?.persistence.autostart ?? true
  proactiveBackground.value = proactiveStatus.value?.persistence.background ?? true
  proactiveDialogOpen.value = true
}

function resetProactiveAuthorization() {
  proactiveAcknowledged.value = false
}

async function authorizeProactive() {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value || !proactiveAcknowledged.value || toolApprovalMode.value !== 'full_access') return
  proactiveBusy.value = true
  proactiveError.value = null
  const request: ProfileAuthorizationRequest = {
    acknowledged: true,
    enableAutostart: proactiveAutostart.value,
    enableBackground: proactiveBackground.value,
    requestAllOsCapabilities: true,
  }
  try {
    proactiveStatus.value = await bridge.authorize(request, toolApprovalMode.value)
    proactiveDialogOpen.value = false
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '主动智能授权失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function setProactiveDesiredState(desiredState: Extract<ProfileDesiredState, 'enabled' | 'paused' | 'revoked'>) {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value) return
  if (desiredState === 'revoked' && !window.confirm('撤销后会立即停止新的观察、召回、分析、提醒和主动任务。已保存的本地数据不会自动删除。确定撤销吗？')) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    proactiveStatus.value = await bridge.setDesiredState(desiredState, toolApprovalMode.value)
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '主动智能状态更新失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function setProactivePersistence(update: ProfilePersistenceUpdate) {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    proactiveStatus.value = await bridge.setPersistence(update, toolApprovalMode.value)
    proactiveAutostart.value = proactiveStatus.value.persistence.autostart
    proactiveBackground.value = proactiveStatus.value.persistence.background
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '常驻设置更新失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function requestProactiveCapability(capability: ProfileCapabilityState) {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value || !capability.canRequest) return
  proactiveBusy.value = true
  proactiveError.value = null
  try {
    proactiveStatus.value = await bridge.requestCapability(capability.id, toolApprovalMode.value)
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '系统权限请求失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function deleteProactiveSource(capability: ProfileCapabilityState) {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value) return
  if (!window.confirm(`撤销“${capability.label}”并删除其本地捕获、观察和画像证据？此操作不可撤销。`)) return
  proactiveBusy.value = true
  proactiveError.value = null
  proactiveNotice.value = null
  try {
    proactiveStatus.value = await bridge.deleteSource(capability.id, toolApprovalMode.value)
    proactiveNotice.value = `已撤销并清理 ${capability.label}`
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '来源撤销与删除失败'
  } finally {
    proactiveBusy.value = false
  }
}

async function exportProactiveData(includeRaw: boolean) {
  const bridge = proactiveBridge()
  if (!bridge || isWeb.value) return
  if (includeRaw && !window.confirm('导出文件将包含仍在 7 天保留期内的原始副本。确定继续吗？')) return
  proactiveBusy.value = true
  proactiveError.value = null
  proactiveNotice.value = null
  try {
    const result = await bridge.exportData(includeRaw)
    if (result) proactiveNotice.value = `已导出到 ${result.path}`
  } catch (error) {
    proactiveError.value = error instanceof Error ? error.message : '主动画像导出失败'
  } finally {
    proactiveBusy.value = false
  }
}

/** 打开（或切换到）指定功能弹窗：同一时间只保留一个功能弹窗 */
function openTool(target: ToolId) {
  recordProactiveActivity('aervox.operation', 'workbench.tool_opened', undefined, {target})
  settingsOpen.value = false
  studyOpen.value = false
  mistakeOpen.value = false
  todoOpen.value = false
  timerOpen.value = false
  historyOpen.value = false
  if (target === 'study') {
    studyOpen.value = true
  } else if (target === 'mistake') {
    mistakeOpen.value = true
  } else if (target === 'todo') {
    todoOpen.value = true
  } else if (target === 'timer') {
    timerOpen.value = true
  } else {
    historyOpen.value = true
  }
}

function addTodo() {
  const text = newTodo.value.trim()
  if (!text) return
  todos.value.unshift({id: Date.now(), text, done: false})
  newTodo.value = ''
}

async function reloadGoals() {
  await api.loadAll(showArchivedGoals.value)
  if (!practiceSession.value && activePracticeSession.value) {
    restorePracticeSession(activePracticeSession.value)
  }
}

/** 待办同步：进行中/暂停中的目标（勾选完成 / 暂停继续均回写后端状态） */
const syncGoals = computed(() => goals.value.filter((goal) => goal.status === 'active' || goal.status === 'paused'))

/** 待办同步：到期复习（勾选 = 记得；「忘了」作为旁侧按钮，保留间隔复习数据质量） */
const syncReviewCount = computed(() => dueReviews.value.length)

/** 待办同步合并计数（本地待办 + 学习同步待完成数） */
const syncedTodoCount = computed(() => syncGoals.value.length + syncReviewCount.value)

async function completeGoalFromTodo(goalId: string) {
  goalBusyId.value = goalId
  try {
    await api.updateGoal(goalId, {status: 'completed'})
  } catch {
    console.error('更新学习目标失败')
  } finally {
    goalBusyId.value = null
  }
}

async function toggleGoalPausedFromTodo(goalId: string, next: 'active' | 'paused') {
  goalBusyId.value = goalId
  try {
    await api.updateGoal(goalId, {status: next})
  } catch {
    console.error('更新学习目标失败')
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

/** 生成学习规划：单次 AI 调用，busy 态覆盖等待期 */
async function generatePlan() {
  const topic = newPlanTopic.value.trim()
  if (!topic || planGenerating.value) return
  planGenerating.value = true
  planError.value = null
  try {
    await api.generateLearningPlan({topic, level: newPlanLevel.value, dailyMinutes: newPlanMinutes.value})
    newPlanTopic.value = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    planError.value = message.includes('llm_disabled')
      ? '尚未配置 LLM，请先在「设置 → 模型与服务」完成配置。'
      : message.includes('plan_generation_failed')
        ? '模型未能产出有效的学习规划，请换个主题描述再试。'
        : '生成学习规划失败，请稍后重试。'
  } finally {
    planGenerating.value = false
  }
}

/** 勾选规划任务（done ⇄ todo），后端负责里程碑自动推进 */
async function togglePlanTask(task: {id: string; status: string}) {
  planBusyId.value = task.id
  planError.value = null
  try {
    await api.setPlanTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done')
  } catch {
    planError.value = '任务状态没有保存，请稍后重试。'
  } finally {
    planBusyId.value = null
  }
}

async function archivePlan(planId: string) {
  if (!window.confirm('归档后规划将从列表隐藏，但完成记录仍会保留。确定归档吗？')) return
  planBusyId.value = planId
  try {
    await api.archiveLearningPlan(planId)
  } catch {
    planError.value = '规划归档失败，请稍后重试。'
  } finally {
    planBusyId.value = null
  }
}

function planMilestoneStatusLabel(status: string) {
  return ({active: '进行中', completed: '已完成', locked: '未解锁'} as Record<string, string>)[status] ?? status
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
  if (timerRunning.value) petReactKind('nod', {expression: MizukiExpression.face_serious_01})
  else petReactKind('tilthead', {expression: MizukiExpression.face_smile_01})
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

// 番茄钟土司倒计时环几何常数 (SVG viewBox 0 0 44 44, 中心 22,22, 半径 18)
const TOAST_RING_RADIUS = 18
const TOAST_RING_CIRCUMFERENCE = 2 * Math.PI * TOAST_RING_RADIUS

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

const toastRingDashoffset = computed(() => {
  return TOAST_RING_CIRCUMFERENCE * (1 - timerRatio.value)
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
  return Math.max(1, Math.min(60, Math.round(rawMin)))
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

function selectCard(slot: number, id: CardId | null, event?: MouseEvent) {
  cardSlots.value = cardSlots.value.map((current, index) => index === slot ? id : current)
  localStorage.setItem('aervox-side-cards', JSON.stringify(cardSlots.value))
  // 桌宠反馈：看向被操作的那个卡片槽位，选功能时开心、移除时摇头
  const slotEl = (event?.target as HTMLElement | null)?.closest?.('.side-card-slot') ?? undefined
  if (id) petReactKind('glad', {expression: MizukiExpression.face_smile_03, lookAtEl: slotEl, lookDuration: 3600})
  else petReactKind('shake', {expression: MizukiExpression.face_trouble_01, lookAtEl: slotEl})
}

function activateCard(card: CardDefinition, event?: MouseEvent | KeyboardEvent) {
  const cardEl = (event?.currentTarget as HTMLElement | null)?.closest?.('.side-card') ?? undefined
  petReactKind('forward', {expression: MizukiExpression.face_notice_01, lookAtEl: cardEl})
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

function toggleStudyMode() {
  studyModeEnabled.value = !studyModeEnabled.value
  recordProactiveActivity('aervox.operation', 'conversation.study_mode_changed', undefined, {enabled: studyModeEnabled.value})
  if (studyModeEnabled.value) {
    petReactKind('glad', {expression: MizukiExpression.face_smile_01, lookAtEl: '.floating-study-switch-wrap'})
    applyStudyCardLayout()
  } else {
    petReactKind('shake', {expression: MizukiExpression.face_normal_01, lookAtEl: '.floating-study-switch-wrap'})
    restoreStudyCardLayout()
    currentExtractedTerms.value = []
    exploreDialogOpen.value = false
  }
  saveSettings()
}

/** 刷题一次性入口：发送带刷题模式前缀的消息，AI 进入出题-判定-落库闭环（答错自动进错题本）。 */
function startQuiz() {
  if (streaming.value) return
  void sendMessage(input.value.trim() || '来几道题', {quizMode: true})
}

function saveSettings() {
  const settings = {
    theme: isDark.value ? 'dark' : 'light',
    assistantName: assistantDisplayName.value.trim() || props.assistantName,
    enterToSend: enterToSend.value,
    compactMode: compactMode.value,
    studyModeEnabled: studyModeEnabled.value,
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
let removeProactiveStatusListener: (() => void) | undefined
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
      studyModeEnabled: boolean
      timerMinutes: number
      desktopCompanionEnabled: boolean
      dailyReminder: boolean
    }>
    if (savedSettings.assistantName) assistantDisplayName.value = savedSettings.assistantName
    if (typeof savedSettings.enterToSend === 'boolean') enterToSend.value = savedSettings.enterToSend
    if (typeof savedSettings.compactMode === 'boolean') compactMode.value = savedSettings.compactMode
    if (typeof savedSettings.studyModeEnabled === 'boolean') studyModeEnabled.value = savedSettings.studyModeEnabled
    if (typeof savedSettings.timerMinutes === 'number' && savedSettings.timerMinutes >= 1 && savedSettings.timerMinutes <= 60) timerMinutes.value = savedSettings.timerMinutes
    if (typeof savedSettings.desktopCompanionEnabled === 'boolean') desktopCompanionEnabled.value = savedSettings.desktopCompanionEnabled
    if (typeof savedSettings.dailyReminder === 'boolean') dailyReminder.value = savedSettings.dailyReminder
    timerSeconds.value = timerMinutes.value * 60
  } catch {
    // Ignore malformed local preferences and use defaults.
  }

  const savedToolApprovalMode = localStorage.getItem('aervox-tool-approval-mode')
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

  // 学习模式开启时刷新页面：仍按「今日学习 + 番茄钟」呈现，并记录快照供退出恢复
  if (studyModeEnabled.value) applyStudyCardLayout()

  if (isWeb.value) {
    const saved = localStorage.getItem('aervox-theme')
    const fallback = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    applyTheme(saved === 'dark' || saved === 'light' ? saved : fallback)
  } else {
    const saved = document.documentElement.dataset.theme
    isDark.value = saved === 'dark'
  }

  if (!isWeb.value) {
    const bridge = proactiveBridge()
    removeProactiveStatusListener = bridge?.onStatusChange((status) => {
      proactiveStatus.value = status
      proactiveAutostart.value = status.persistence.autostart
      proactiveBackground.value = status.persistence.background
    })
    void refreshProactiveStatus()
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
  removeProactiveStatusListener?.()
  clearPendingAttachments()
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

    <div class="floating-top-actions">
      <label
        class="floating-study-switch-wrap"
        :class="{on: studyModeEnabled}"
        :title="studyModeEnabled ? '专注模式已开启（点击关闭）' : '专注模式已关闭（点击开启）'"
      >
        <BookOpen :size="15" class="study-switch-icon" />
        <span class="study-switch-label">专注模式</span>
        <button
          type="button"
          role="switch"
          class="study-switch-track"
          :class="{ active: studyModeEnabled }"
          :aria-checked="studyModeEnabled"
          :aria-label="studyModeEnabled ? '关闭专注模式' : '开启专注模式'"
          @click="toggleStudyMode"
        >
          <span class="study-switch-thumb" />
        </button>
      </label>

      <button
        type="button"
        class="floating-quiz-btn"
        :disabled="streaming"
        aria-label="开始刷题"
        title="开始刷题：AI 现场出题，答错自动进错题本"
        @click="startQuiz"
      >
        <ClipboardList :size="15" />
        <span class="quiz-btn-label">刷题</span>
      </button>

      <button v-if="isWeb" class="floating-settings" type="button" aria-label="打开设置" @click="settingsOpen = true">
        <Settings :size="19" />
      </button>
    </div>

    <!-- 番茄钟运行土司：开启后右上流畅侧弹出，环形倒计时动画，暂停/重置即收回 -->
    <Transition name="timer-toast">
      <div v-if="timerRunning" class="timer-toast" role="status" aria-live="polite" aria-label="番茄钟倒计时通知">
        <svg class="timer-toast-ring" viewBox="0 0 44 44" aria-hidden="true">
          <circle class="timer-toast-track" cx="22" cy="22" :r="TOAST_RING_RADIUS" />
          <circle
            class="timer-toast-progress"
            cx="22"
            cy="22"
            :r="TOAST_RING_RADIUS"
            :stroke-dasharray="TOAST_RING_CIRCUMFERENCE"
            :stroke-dashoffset="toastRingDashoffset"
          />
        </svg>
        <div class="timer-toast-body">
          <strong class="timer-toast-time">{{ formattedTime }}</strong>
          <small class="timer-toast-label">专注中 · {{ timerMinutes }} 分钟回合</small>
        </div>
        <div class="timer-toast-ops">
          <button type="button" aria-label="暂停专注" @click="toggleTimer()">
            <Pause :size="14" />
          </button>
          <button type="button" aria-label="重置番茄钟" @click="resetTimer()">
            <TimerReset :size="14" />
          </button>
        </div>
      </div>
    </Transition>

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
        <Transition name="card-swap" mode="out-in">
          <div :key="slotIndex === 0 && questionCardData ? 'question' : card?.id ?? 'placeholder'" class="side-card-slot-inner">
            <!-- UQ-01: AI 提问时第一槽临时切换为提问卡，作答后自动恢复 -->
            <article
              v-if="slotIndex === 0 && questionCardData"
              class="side-card side-question-card"
              role="region"
              tabindex="0"
              :aria-label="`${assistantDisplayName}想问你`"
            >
              <header class="side-card-head">
                <span class="side-card-icon"><CircleHelp :size="24" /></span>
                <span class="side-card-title">
                  <strong>{{ assistantDisplayName }}想问你</strong>
                  <small>点选选项作答，答完卡片自动恢复</small>
                </span>
              </header>
              <p class="side-card-summary side-question-text">{{ questionCardData.question }}</p>
              <div v-if="questionCardData.options?.length" class="side-card-grid side-question-options">
                <button
                  v-for="option in questionCardData.options"
                  :key="option.label"
                  type="button"
                  class="side-card-grid-item"
                  :class="{picked: questionCardSelected.includes(option.label)}"
                  :disabled="questionSubmitting"
                  @click.stop="handleQuestionCardOption(option.label)"
                >
                  <span>{{ option.label }}</span>
                </button>
              </div>
              <button
                v-if="questionCardData.multiSelect && questionCardData.options?.length"
                type="button"
                class="side-question-submit"
                :disabled="questionSubmitting || questionCardSelected.length === 0"
                @click.stop="submitQuestionCardAnswers()"
              >
                {{ questionSubmitting ? '提交中…' : `提交（已选 ${questionCardSelected.length}）` }}
              </button>
              <footer class="side-card-foot">
                <span>{{ questionSubmitting ? '正在提交回答…' : '正在等待你的回答…' }}</span>
              </footer>
            </article>

            <article
              v-else-if="card"
              class="side-card"
              role="region"
              tabindex="0"
              :aria-label="`打开${card.label}`"
              @click="activateCard(card, $event)"
              @keydown.enter="activateCard(card, $event)"
            >
              <header class="side-card-head">
                <span class="side-card-icon"><component :is="card.icon" :size="24" /></span>
                <span class="side-card-title">
                  <strong>{{ card.label }}</strong>
                  <small>{{ card.description }}</small>
                </span>
                <button class="side-card-remove" type="button" aria-label="移除此卡片" @click.stop="selectCard(slotIndex, null, $event)">
                  <X :size="15" />
                </button>
              </header>
              <p class="side-card-summary">{{ card.summary() }}</p>
              <!-- 番茄钟基础操作：预设时长 + 开始/暂停/重置（点击卡片本体仍打开二级抽屉的完整表盘） -->
              <div v-if="card.id === 'timer'" class="timer-card-ops">
                <div v-if="!timerRunning" class="timer-card-presets" role="radiogroup" aria-label="快捷预设时长">
                  <button
                    v-for="preset in [15, 25, 45, 60]"
                    :key="preset"
                    type="button"
                    class="timer-chip"
                    :class="{active: timerMinutes === preset}"
                    :aria-pressed="timerMinutes === preset"
                    @click.stop="selectPresetMinutes(preset)"
                  >
                    {{ preset }}分
                  </button>
                </div>
                <div class="timer-card-actions">
                  <button type="button" class="side-card-grid-item" @click.stop="toggleTimer()">
                    <Pause v-if="timerRunning" :size="15" />
                    <Play v-else :size="15" />
                    <span>{{ timerRunning ? '暂停专注' : '开始专注' }}</span>
                  </button>
                  <button type="button" class="side-card-grid-item" @click.stop="resetTimer()">
                    <TimerReset :size="15" />
                    <span>重置</span>
                  </button>
                </div>
              </div>
              <!-- 学习模式下的今日学习富卡片：每日一题与学习快捷入口（点击卡片仍整体打开学习抽屉） -->
              <div v-if="card.id === 'study' && studyModeEnabled" class="side-card-grid side-card-actions">
                <button type="button" class="side-card-grid-item" @click.stop="openDailyProblem()">
                  <CircleHelp :size="15" />
                  <span>每日一题</span>
                </button>
                <button type="button" class="side-card-grid-item" @click.stop="openTool('timer')">
                  <Clock3 :size="15" />
                  <span>开始专注</span>
                </button>
                <button type="button" class="side-card-grid-item" @click.stop="openTool('mistake')">
                  <Puzzle :size="15" />
                  <span>错题重练</span>
                </button>
              </div>
              <footer class="side-card-foot">
                <span>点击打开</span>
                <ChevronRight :size="15" />
              </footer>
            </article>

            <div v-else class="side-card side-card-placeholder" role="group" aria-label="为此卡片选择功能">
              <header class="side-card-head">
                <span class="side-card-icon"><Plus :size="17" /></span>
                <span class="side-card-title">
                  <strong>选择功能</strong>
                  <small>把常用工具放到这里</small>
                </span>
              </header>
              <div class="side-card-grid">
                <button
                  v-for="option in cardCatalog"
                  :key="option.id"
                  type="button"
                  class="side-card-grid-item"
                  :disabled="isCardPicked(option.id)"
                  @click="selectCard(slotIndex, option.id, $event)"
                >
                  <component :is="option.icon" :size="15" />
                  <span>{{ option.label }}</span>
                </button>
              </div>
            </div>
          </div>
        </Transition>
      </div>
    </aside>

    <div class="immersive-console">
      <section class="message-panel" :class="{collapsed: consoleCollapsed}" aria-label="伴学对话">
        <!-- 收起态摘要行：说话人 + 当前句单行省略（视觉小说细条） -->
        <div v-if="consoleCollapsed" class="console-collapsed-summary" aria-hidden="true">
          <span class="console-collapsed-speaker">{{ assistantDisplayName }}</span>
          <span class="console-collapsed-text">{{ collapsedSummaryText }}</span>
        </div>
        <div ref="storyViewport" class="message-viewport" aria-live="polite">
          <p
            v-if="latestAssistantLine"
            class="message-line"
            :class="latestAssistantLine.state"
          >
            <span class="message-speaker">{{ assistantDisplayName }}</span>
            <span v-if="latestAssistantLine.state === 'streaming'" class="message-text">
              <span class="markdown-body" v-html="renderMarkdown(novelStreamingText)" />
              <i class="stream-cursor" aria-hidden="true" />
            </span>
            <span v-else class="message-text message-novel-text">
              <!-- 视觉小说分句（切换模式）：:key 随句索引变化，整句替换触发切换动画 -->
              <span :key="novelIndex" class="markdown-body" v-html="renderMarkdown(novelDisplayText || '正在连接 Aervox…')" />
              <span class="novel-meta-row">
                <span class="novel-progress" aria-hidden="true">{{ Math.min(novelIndex + 1, novelSentences.length) }} / {{ novelSentences.length }}</span>
                <button
                  v-if="hasQueuedSentence"
                  type="button"
                  class="novel-next-btn"
                  :aria-label="`切换到下一句，还剩 ${queuedSentenceCount} 句`"
                  @click="showNextSentence"
                >
                  <span>下一句</span>
                  <span class="novel-next-count" aria-hidden="true">{{ queuedSentenceCount }}</span>
                  <ChevronRight :size="14" />
                </button>
              </span>
            </span>
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

          <!-- PET-05: 写工具授权确认（如写日记落库前） -->
          <div v-if="pendingApproval" class="tool-approval-card">
            <div class="tool-approval-text">
              <strong>{{ assistantDisplayName }}请求执行写操作</strong>
              <span>{{ approvalToolLabel }} — 需要你的确认后才会执行。</span>
            </div>
            <div class="tool-approval-actions">
              <button type="button" :disabled="approvalBusy" @click="handleApprovalDecision('granted')">
                <Check :size="14" /> 批准
              </button>
              <button type="button" class="secondary" :disabled="approvalBusy" @click="handleApprovalDecision('denied')">
                <X :size="14" /> 拒绝
              </button>
            </div>
          </div>

          <!-- CAP-007 / CAP-002: 术语高亮芯片栏（仅在专注模式下展示） -->
          <div v-if="studyModeEnabled && currentExtractedTerms.length > 0 && !streaming" class="message-terms-bar">
            <div class="terms-bar-label">
              <Sparkles :size="13" />
              <span>核心概念</span>
            </div>
            <div class="terms-chips-list">
              <button
                v-for="t in currentExtractedTerms"
                :key="t.text"
                type="button"
                class="term-chip"
                :class="t.relation"
                title="点击查看名词解释与深度追问"
                @click="openTermExplore(t)"
              >
                <span class="term-chip-text">{{ t.text }}</span>
                <span class="term-chip-badge">{{ t.relation === 'background' ? '深挖' : '对比' }}</span>
              </button>
            </div>
          </div>
        </div>
        <button class="message-history-entry" type="button" @click="historyOpen = true">
          <History :size="14" />
          <span>回看完整对话</span>
        </button>
        <!-- 收起/展开开关：右上角常驻，收起态仍留在细条上 -->
        <button
          type="button"
          class="console-collapse-toggle"
          :aria-label="consoleCollapsed ? '展开对话区域' : '收起对话区域'"
          :aria-expanded="!consoleCollapsed"
          @click="consoleCollapsed = !consoleCollapsed"
        >
          <ChevronDown v-if="consoleCollapsed" :size="14" />
          <ChevronUp v-else :size="14" />
        </button>
      </section>

      <section class="composer-dock" :class="{open: composerOpen}" @focusout="handleDockFocusOut">
        <button v-if="!composerOpen" class="composer-collapsed" type="button" @click="expandComposer">
          <MessageCircle :size="16" />
          <span class="composer-collapsed-hint">{{ streaming ? '思隅正在回应…' : (studyModeEnabled ? '输入学习问题或卡点（专注模式已开启）…' : '点击输入消息…') }}</span>
          <span v-if="studyModeEnabled" class="composer-mode-chip">专注模式</span>
          <span class="composer-access-chip" :class="{full: toolApprovalMode === 'full_access', proactive: proactiveActive}">
            <component :is="accessChipIcon" :size="12" />
            {{ accessChipLabel }}
          </span>
          <ChevronUp :size="15" />
        </button>

        <form v-else class="composer-expanded" @submit.prevent="sendMessage()">
          <label class="sr-only" for="aervox-composer">输入要发送给思隅的内容</label>
          <input
            ref="attachmentFileInput"
            type="file"
            class="sr-only"
            multiple
            :accept="attachmentAccept"
            aria-label="选择要上传的附件（图片 / PDF / 文档 / 音频）"
            @change="handleFilesChosen"
          />
          <div v-if="pendingAttachments.length > 0" class="composer-attachments" aria-label="待发送附件">
            <div v-for="item in pendingAttachments" :key="item.key" class="attachment-chip">
              <img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.name" class="attachment-thumb" />
              <span v-else class="attachment-icon"><component :is="attachmentIconFor(item.mediaType)" :size="15" /></span>
              <span class="attachment-meta">
                <span class="attachment-name" :title="item.name">{{ item.name }}</span>
                <span class="attachment-size">{{ formatAttachmentSize(item.size) }}</span>
              </span>
              <button
                type="button"
                class="attachment-remove"
                :aria-label="`移除附件 ${item.name}`"
                :disabled="streaming || attachmentUploading"
                @click="removePendingAttachment(item.key)"
              >
                <X :size="13" />
              </button>
            </div>
          </div>
          <textarea
            id="aervox-composer"
            ref="composerTextarea"
            v-model="input"
            rows="3"
            :disabled="streaming"
            :placeholder="studyModeEnabled ? '告诉我你正在学什么，或者把卡住的地方发来（逐步引导与启发式解答）…' : composerPlaceholder"
            @keydown.enter="handleComposerEnter"
            @input="handleComposerInputOrKey"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
          />
          <div class="composer-footer">
            <button
              type="button"
              class="permission-toggle"
              :class="{full: toolApprovalMode === 'full_access', proactive: proactiveActive}"
              :aria-pressed="toolApprovalMode === 'full_access'"
              :title="toolApprovalMode === 'full_access' ? '关闭完全访问' : '开启完全访问'"
              :disabled="streaming"
              @mousedown.prevent
              @click="toggleToolApprovalMode"
            >
              <component :is="accessChipIcon" :size="16" />
              <span>{{ accessChipLabel }}</span>
            </button>
            <div class="composer-actions">
              <button
                type="button"
                class="attachment-picker-btn"
                title="上传附件（图片 / PDF / 文档 / 音频，≤10MB）"
                :aria-label="attachmentUploading ? '附件上传中' : '上传附件'"
                :disabled="streaming || attachmentUploading"
                @click="triggerAttachmentPicker"
              >
                <span v-if="attachmentUploading" class="sending-dot" />
                <Paperclip v-else :size="18" />
              </button>
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
              <button type="submit" :disabled="(!input.trim() && pendingAttachments.length === 0) || streaming || attachmentUploading" :aria-label="streaming ? '正在生成回答' : '发送消息'">
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
        <div v-if="attachmentError" class="voice-input-inline-error attachment-inline-error">
          <span>{{ attachmentError }}</span>
          <button type="button" class="attachment-error-dismiss" aria-label="关闭提示" @click="attachmentError = null">
            <X :size="13" />
          </button>
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
              <span class="vn-history-text">
                <span v-if="line.speaker === 'assistant'" class="markdown-body" v-html="renderMarkdown(line.text || '…')" />
                <template v-else>{{ line.text }}</template>
                <span v-if="line.attachments && line.attachments.length > 0" class="vn-history-attachments">
                  <span v-for="(att, attIndex) in line.attachments" :key="attIndex" class="vn-history-attachment">
                    <component :is="attachmentIconFor(att.mediaType)" :size="12" />
                    <span>{{ att.name }}</span>
                  </span>
                </span>
              </span>
            </p>
            <p v-if="story.length === 0" class="vn-history-empty">还没有对话记录，先和思隅说句话吧。</p>
          </div>
          <footer class="vn-history-foot">上下滚动回溯完整对话 · Esc 或点击空白处关闭</footer>
        </section>
      </div>
    </Teleport>

    <el-dialog
      v-model="todoOpen"
      title="待办清单"
      class="todo-dialog"
      width="min(860px, calc(100vw - 28px))"
      align-center
    >
      <div class="tool-dialog-layout">
        <nav class="tool-sidebar" aria-label="功能导航">
          <button
            v-for="item in toolNavItems"
            :key="item.id"
            type="button"
            :class="{active: item.id === 'todo'}"
            :aria-current="item.id === 'todo' ? 'true' : undefined"
            @click="item.id !== 'todo' && openTool(item.id)"
          >
            <component :is="item.icon" :size="18" />
            <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          </button>
        </nav>
        <div class="tool-dialog-content">
          <p class="drawer-intro">用小任务保持节奏，不需要一次完成所有事情。</p>
          <form class="todo-form" @submit.prevent="addTodo">
            <label class="sr-only" for="new-todo">添加待办</label>
            <input id="new-todo" v-model="newTodo" placeholder="添加一件小事" />
            <button type="submit" aria-label="添加待办"><Plus :size="20" /></button>
          </form>
          <div class="todo-summary">已完成 {{ completedTodoCount }} 件 · 待完成 {{ unfinishedTodos.length + syncedTodoCount }} 件（含学习同步）</div>
          <div class="todo-list">
            <label v-for="todo in todos" :key="todo.id" class="todo-item" :class="{done: todo.done}">
              <input v-model="todo.done" type="checkbox" />
              <span>{{ todo.text }}</span>
              <Check v-if="todo.done" :size="18" />
            </label>
            <p v-if="todos.length === 0" class="drawer-empty">暂无待办，先从一件五分钟能完成的小事开始。</p>
          </div>

          <!-- 学习同步：进行中目标 + 到期复习（勾选回写后端状态） -->
          <div v-if="syncGoals.length > 0 || dueReviews.length > 0" class="settings-section" style="margin-top: 18px;">
            <h4>学习同步 <small>{{ syncedTodoCount }}</small></h4>
            <ul class="study-list">
              <li v-for="goal in syncGoals" :key="goal.id">
                <label class="todo-item" :class="{done: goal.status === 'completed'}">
                  <input
                    type="checkbox"
                    :disabled="goalBusyId === goal.id"
                    @change="completeGoalFromTodo(goal.id)"
                  />
                  <span>目标：{{ goal.topic }} · {{ goal.availableMinutes }} 分钟/天</span>
                </label>
                <div class="goal-actions">
                  <button v-if="goal.status === 'active'" type="button" :disabled="goalBusyId === goal.id" @click="toggleGoalPausedFromTodo(goal.id, 'paused')"><Pause :size="14" />暂停</button>
                  <button v-else type="button" :disabled="goalBusyId === goal.id" @click="toggleGoalPausedFromTodo(goal.id, 'active')"><Play :size="14" />继续</button>
                </div>
              </li>
              <li v-for="item in dueReviews" :key="item.id">
                <label class="todo-item">
                  <input
                    type="checkbox"
                    :disabled="reviewBusyId === item.id"
                    @change="completeReview(item.id, true)"
                  />
                  <span>复习：知识点 #{{ item.knowledgeId }} · 间隔 {{ item.intervalDays }} 天</span>
                </label>
                <div class="goal-actions">
                  <button type="button" :disabled="reviewBusyId === item.id" @click="completeReview(item.id, false)"><RotateCcw :size="14" />忘了</button>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </el-dialog>

    <el-dialog
      v-model="timerOpen"
      title="番茄钟"
      class="timer-dialog"
      width="min(860px, calc(100vw - 28px))"
      align-center
    >
      <div class="tool-dialog-layout">
        <nav class="tool-sidebar" aria-label="功能导航">
          <button
            v-for="item in toolNavItems"
            :key="item.id"
            type="button"
            :class="{active: item.id === 'timer'}"
            :aria-current="item.id === 'timer' ? 'true' : undefined"
            @click="item.id !== 'timer' && openTool(item.id)"
          >
            <component :is="item.icon" :size="18" />
            <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          </button>
        </nav>
        <div class="tool-dialog-content">
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
        </div>
      </div>
    </el-dialog>

    <el-dialog
      v-model="studyOpen"
      title="学习规划"
      class="study-dialog single-panel-dialog"
      width="min(860px, calc(100vw - 28px))"
      align-center
      @open="reloadGoals"
    >
      <div class="tool-dialog-layout">
        <nav class="tool-sidebar" aria-label="功能导航">
          <button
            v-for="item in toolNavItems"
            :key="item.id"
            type="button"
            :class="{active: item.id === 'study'}"
            :aria-current="item.id === 'study' ? 'true' : undefined"
            @click="item.id !== 'study' && openTool(item.id)"
          >
            <component :is="item.icon" :size="18" />
            <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          </button>
        </nav>
        <div class="single-dialog-detail">
        <p v-if="apiError" class="drawer-error">{{ apiError }}</p>

          <!-- AI 学习规划生成 -->
          <div class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><BookOpen :size="18" /></span>
              <span><strong>AI 学习规划</strong><small>输入主题，生成「里程碑 + 任务」的项目式学习路线图</small></span>
            </div>
            <form class="study-goal-form" @submit.prevent="generatePlan">
              <label class="sr-only" for="new-plan-topic">学习主题</label>
              <input id="new-plan-topic" v-model="newPlanTopic" placeholder="例如：用 Vue 写一个番茄钟应用" :disabled="planGenerating" />
              <select v-model="newPlanLevel" aria-label="学习水平" :disabled="planGenerating">
                <option value="beginner">入门</option>
                <option value="intermediate">进阶</option>
                <option value="advanced">熟练</option>
              </select>
              <select v-model.number="newPlanMinutes" aria-label="每日可用时间" :disabled="planGenerating">
                <option :value="15">15 分钟</option>
                <option :value="25">25 分钟</option>
                <option :value="45">45 分钟</option>
                <option :value="60">60 分钟</option>
              </select>
              <button type="submit" class="practice-start" :disabled="planGenerating || !newPlanTopic.trim()">
                <Sparkles :size="15" />{{ planGenerating ? '正在生成…' : 'AI 生成规划' }}
              </button>
            </form>
            <p v-if="planError" class="drawer-error">{{ planError }}</p>
            <p class="study-section-desc">生成后按里程碑推进：勾选任务即可，完成一个阶段自动解锁下一阶段。</p>
          </div>

          <!-- 我的规划列表 -->
          <div class="settings-section">
            <h4>我的规划 <small>{{ learningPlans.length }}</small></h4>
            <ul class="study-list plan-list">
              <li v-for="plan in learningPlans" :key="plan.id" class="plan-card">
                <div class="goal-item-heading">
                  <span class="study-item-title">{{ plan.title }}</span>
                  <span class="goal-status">{{ plan.dailyAvailableMinutes }} 分钟/天</span>
                </div>
                <p class="plan-description">{{ plan.description }}</p>
                <p class="plan-objective">学习目标：{{ plan.learningObjective }}</p>
                <div class="plan-gains">
                  <span v-for="gain in plan.gains" :key="gain" class="subnav-badge">{{ gain }}</span>
                </div>
                <div v-for="milestone in plan.milestones" :key="milestone.id" class="plan-milestone" :class="`is-${milestone.status}`">
                  <div class="plan-milestone-heading">
                    <span class="study-item-title">{{ milestone.order + 1 }}. {{ milestone.title }}</span>
                    <span class="goal-status" :class="{'is-completed': milestone.status === 'completed'}">{{ planMilestoneStatusLabel(milestone.status) }}</span>
                  </div>
                  <small v-if="milestone.completionCriteria">完成标准：{{ milestone.completionCriteria }}</small>
                  <label
                    v-for="task in milestone.tasks"
                    :key="task.id"
                    class="plan-task"
                    :class="{done: task.status === 'done', locked: milestone.status === 'locked'}"
                  >
                    <input
                      type="checkbox"
                      :checked="task.status === 'done'"
                      :disabled="planBusyId === task.id || milestone.status === 'locked'"
                      @change="togglePlanTask(task)"
                    />
                    <span>
                      <strong>{{ task.title }}</strong>
                      <small v-if="task.description">{{ task.description }}</small>
                      <small v-if="task.hints.length" class="plan-hints">提示：{{ task.hints.join('；') }}</small>
                    </span>
                  </label>
                </div>
                <div class="goal-actions">
                  <button type="button" class="danger" :disabled="planBusyId === plan.id" @click="archivePlan(plan.id)"><X :size="14" />归档</button>
                </div>
              </li>
              <li v-if="learningPlans.length === 0" class="study-empty">还没有学习规划，输入主题让 AI 生成一份路线图。</li>
            </ul>
          </div>
      </div>
      </div>
    </el-dialog>

    <!-- 独立错题本弹窗 -->
    <el-dialog
      v-model="mistakeOpen"
      title="错题本"
      class="mistake-dialog single-panel-dialog"
      width="min(860px, calc(100vw - 28px))"
      align-center
      @open="reloadGoals"
    >
      <div class="tool-dialog-layout">
        <nav class="tool-sidebar" aria-label="功能导航">
          <button
            v-for="item in toolNavItems"
            :key="item.id"
            type="button"
            :class="{active: item.id === 'mistake'}"
            :aria-current="item.id === 'mistake' ? 'true' : undefined"
            @click="item.id !== 'mistake' && openTool(item.id)"
          >
            <component :is="item.icon" :size="18" />
            <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          </button>
        </nav>
        <div class="single-dialog-detail">
        <div class="settings-section">
          <div class="settings-section-heading">
            <span class="heading-icon-wrap"><Puzzle :size="18" /></span>
            <span><strong>错题管理与重练</strong><small>针对性练习未掌握题目，记录错因洞察</small></span>
          </div>

          <div class="study-section-title-row">
            <div class="mistake-filter-summary">
              <span>当前错题 <strong>{{ visibleMistakes.length }}</strong> 题</span>
              <span v-if="selectedMistakeIds.length" class="mistake-selected-badge">已选 {{ selectedMistakeIds.length }} 题</span>
            </div>
            <button
              class="practice-start"
              type="button"
              :disabled="practiceBusy || !mistakes.some((item) => item.status === 'active')"
              @click="startMistakePractice"
            >
              <RotateCcw :size="15" />{{ selectedMistakeIds.length ? `重练所选 ${selectedMistakeIds.length} 题` : '重练错题' }}
            </button>
          </div>

          <div class="mistake-filter-bar">
            <div class="mistake-status-tabs" aria-label="错题状态筛选">
              <button
                v-for="option in (['active', 'mastered', 'dismissed', 'all'] as const)"
                :key="option"
                type="button"
                class="mistake-tab-btn"
                :class="{active: mistakeFilter === option}"
                @click="mistakeFilter = option"
              >
                {{ option === 'active' ? '待掌握' : option === 'mastered' ? '已掌握' : option === 'dismissed' ? '已忽略' : '全部' }}
              </button>
            </div>

            <label class="mistake-reason-filter">错因：
              <select v-model="mistakeReasonFilter" aria-label="按错因筛选">
                <option value="all">全部错因</option>
                <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
          </div>

          <p v-if="practiceError" class="drawer-error">{{ practiceError }}</p>

          <!-- 练习作答面板（错题重练原地作答；自 fast practice 迁入） -->
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

          <ul class="study-list mistake-list">
            <li v-for="item in visibleMistakes" :key="item.questionId">
              <div class="mistake-heading">
                <label v-if="item.status === 'active'">
                  <input
                    v-model="selectedMistakeIds"
                    type="checkbox"
                    :value="item.questionId"
                    :disabled="selectedMistakeIds.length >= 5 && !selectedMistakeIds.includes(item.questionId)"
                  />
                  <span class="study-item-title">{{ item.prompt }}</span>
                </label>
                <span v-else class="study-item-title">{{ item.prompt }}</span>
                <span class="goal-status" :class="{'is-completed': item.status === 'mastered'}">
                  {{ item.status === 'mastered' ? '已掌握' : item.status === 'dismissed' ? '已忽略' : '待掌握' }}
                </span>
              </div>
              <small>最近答案：{{ item.latestAnswer }} · 共答错 {{ item.wrongCount }} 次 · {{ item.latestAttemptAt.slice(0, 10) }}</small>
              <p class="mistake-insight-summary">错因：{{ mistakeReasonLabel(item.reasonCode) }}</p>
              <div class="mistake-insight-editor">
                <label>错因
                  <select
                    :value="mistakeInsightDraft(item).reasonCode"
                    :disabled="mistakeBusyId === item.questionId"
                    @change="updateMistakeInsightDraft(item.questionId, {reasonCode: ($event.target as HTMLSelectElement).value})"
                  >
                    <option value="">清除错因记录</option>
                    <option v-for="option in mistakeReasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </select>
                </label>
                <label>补充说明
                  <input
                    :value="mistakeInsightDraft(item).note"
                    maxlength="500"
                    placeholder="例如：循环边界少比较了一次"
                    :disabled="mistakeBusyId === item.questionId"
                    @input="updateMistakeInsightDraft(item.questionId, {note: ($event.target as HTMLInputElement).value})"
                  />
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
            <li v-if="visibleMistakes.length === 0" class="study-empty">
              {{ mistakeFilter === 'mastered' ? '还没有已掌握的错题。' : '当前没有待处理错题。' }}
            </li>
          </ul>
        </div>
      </div>
      </div>
    </el-dialog>

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
                <span><strong>学习规划</strong><small>{{ learningPlans.length }} 份进行中规划</small></span>
              </button>
              <button type="button" @click="openTool('mistake')">
                <Puzzle :size="19" />
                <span><strong>错题本</strong><small>{{ activeMistakeCount }} 题待掌握</small></span>
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
          <div v-else-if="settingsCategory === 'proactive'" class="settings-section proactive-settings">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><BrainCircuit :size="18" /></span>
              <span><strong>主动智能模式</strong><small>全量画像、持续本地处理与主动操作授权</small></span>
            </div>

            <div class="proactive-status-banner" :class="`is-${proactiveStatus?.effectiveState ?? 'unavailable'}`">
              <component :is="proactiveActive ? BrainCircuit : AlertTriangle" :size="20" />
              <span>
                <strong>{{ proactiveStateLabel(proactiveStatus) }}</strong>
                <small v-if="proactiveStatus?.host">{{ proactiveStatus.host.localOnly ? '数据处理边界：仅本机' : '本地边界未验证' }} · {{ proactiveStatus.host.platform }}</small>
                <small v-else>主动智能模式需要受信的 Electron 本地 Host，Web 端不会伪造授权。</small>
                <small v-if="proactiveSuspendHint(proactiveStatus)" class="proactive-suspend-hint">{{ proactiveSuspendHint(proactiveStatus) }}</small>
              </span>
              <button v-if="!isWeb" type="button" class="proactive-icon-button" aria-label="刷新主动智能状态" title="刷新状态" :disabled="proactiveBusy" @click="refreshProactiveStatus"><RefreshCw :size="15" /></button>
            </div>

            <div v-if="isWeb" class="settings-note proactive-warning"><AlertTriangle :size="16" />请在桌面端完成设备授权；浏览器端不会读取系统级来源。</div>
            <template v-else>
              <p v-if="proactiveError" class="proactive-error" role="alert">{{ proactiveError }}</p>
              <p v-if="proactiveNotice" class="settings-note" role="status">{{ proactiveNotice }}</p>
              <div class="proactive-actions">
                <button
                  v-if="!proactiveStatus || proactiveStatus.desiredState === 'none' || proactiveStatus.desiredState === 'revoked'"
                  type="button"
                  class="proactive-primary-action"
                  :disabled="proactiveBusy || toolApprovalMode !== 'full_access'"
                  :title="toolApprovalMode !== 'full_access' ? '请先开启完全访问' : '打开全量画像授权向导'"
                  @click="openProactiveAuthorization"
                ><BrainCircuit :size="15" />授权并启用</button>
                <button v-else-if="proactiveStatus.desiredState === 'paused'" type="button" :disabled="proactiveBusy || toolApprovalMode !== 'full_access'" @click="setProactiveDesiredState('enabled')"><PlayCircle :size="15" />恢复观察</button>
                <button v-else type="button" :disabled="proactiveBusy" @click="setProactiveDesiredState('paused')"><PauseCircle :size="15" />暂停观察</button>
                <button v-if="proactiveStatus && (proactiveStatus.effectiveState === 'limited' || proactiveStatus.effectiveState === 'suspended') && proactiveStatus.desiredState !== 'none' && proactiveStatus.desiredState !== 'revoked'" type="button" :disabled="proactiveBusy || toolApprovalMode !== 'full_access'" @click="openProactiveAuthorization"><RefreshCw :size="15" />重新确认授权</button>
                <button v-if="proactiveStatus?.desiredState === 'enabled' || proactiveStatus?.desiredState === 'paused'" type="button" class="danger" :disabled="proactiveBusy" @click="setProactiveDesiredState('revoked')"><ShieldAlert :size="15" />撤销授权</button>
                <button v-if="proactiveStatus" type="button" :disabled="proactiveBusy" @click="exportProactiveData(false)"><Download :size="15" />导出画像</button>
                <button v-if="proactiveStatus" type="button" :disabled="proactiveBusy" @click="exportProactiveData(true)"><Database :size="15" />导出含原始副本</button>
              </div>

              <div class="settings-row settings-choice-row proactive-persistence-row">
                <span><strong>开机自启</strong><small>允许 Host 在设备登录后恢复；系统实际状态以权限回执为准</small></span>
                <input v-model="proactiveAutostart" type="checkbox" class="settings-switch" :disabled="proactiveBusy" @change="setProactivePersistence({autostart: proactiveAutostart})" />
              </div>
              <div class="settings-row settings-choice-row proactive-persistence-row">
                <span><strong>后台持续运行</strong><small>允许应用窗口关闭后保持主动 Host；平台不支持时会显示受限</small></span>
                <input v-model="proactiveBackground" type="checkbox" class="settings-switch" :disabled="proactiveBusy" @change="setProactivePersistence({background: proactiveBackground})" />
              </div>

              <div class="settings-segmented proactive-view-tabs" role="tablist" aria-label="主动智能视图">
                <button type="button" role="tab" :aria-selected="proactiveView === 'overview'" :class="{active: proactiveView === 'overview'}" @click="proactiveView = 'overview'"><BrainCircuit :size="15" />能力概览</button>
                <button type="button" role="tab" :aria-selected="proactiveView === 'integrations'" :class="{active: proactiveView === 'integrations'}" @click="proactiveView = 'integrations'"><Link2 :size="15" />外部连接</button>
              </div>

              <template v-if="proactiveView === 'overview'">
                <div class="proactive-capability-heading"><strong>主动智能能力</strong><small>数字表示当前本地 Vault 中可用于该能力的记录数。</small></div>
                <ul class="proactive-intelligence-grid">
                  <li v-for="capability in proactiveIntelligenceCapabilities" :key="capability.id" :class="{active: capability.count > 0}">
                    <component :is="capability.icon" :size="17" />
                    <span><strong>{{ capability.label }}</strong><small>{{ capability.count > 0 ? `${capability.count} 条本地记录` : '等待形成数据' }}</small></span>
                    <b>{{ capability.count }}</b>
                  </li>
                </ul>

                <div class="proactive-capability-heading"><strong>全量画像来源与动作</strong><small>每项状态来自 OS 或已接入适配器；“待验证”不会被当作已授权。</small></div>
                <ul class="proactive-capability-list">
                  <li v-for="capability in proactiveStatus?.capabilities ?? []" :key="capability.id" class="proactive-capability-item">
                    <span class="proactive-capability-marker" :class="capabilityStatusClass(capability.osStatus)" aria-hidden="true"><Check v-if="capability.osStatus === 'granted'" :size="13" /><AlertTriangle v-else :size="13" /></span>
                    <span class="proactive-capability-copy"><strong>{{ capability.label }}</strong><small>{{ capability.description }}<template v-if="capability.reason"> · {{ capability.reason }}</template></small></span>
                    <span class="proactive-capability-state" :class="capabilityStatusClass(capability.osStatus)">{{ capabilityStatusLabel(capability.osStatus) }}</span>
                    <span class="proactive-capability-actions">
                      <button v-if="capability.canRequest && capability.osStatus !== 'granted'" type="button" class="proactive-request-button" :disabled="proactiveBusy" @click="requestProactiveCapability(capability)">请求系统权限</button>
                      <button v-if="proactiveStatus?.desiredState === 'enabled' || proactiveStatus?.desiredState === 'paused'" type="button" class="proactive-delete-button" :disabled="proactiveBusy" :aria-label="`撤销并删除${capability.label}`" title="撤销并删除此来源" @click="deleteProactiveSource(capability)"><Trash2 :size="13" /></button>
                    </span>
                  </li>
                  <li v-if="!proactiveStatus" class="study-empty">等待桌面 Host 返回能力快照。</li>
                </ul>
                <div class="proactive-capability-heading"><strong>本地画像记忆</strong><small>推断可由你确认或拒绝；被拒绝的声明不会进入后续个性化上下文。</small></div>
                <ul class="proactive-claim-list">
                  <li v-for="claim in proactiveClaims" :key="claim.id" class="proactive-claim-item">
                    <span class="proactive-claim-copy"><strong>{{ claim.content }}</strong><small>{{ claim.claimType }} · 置信度 {{ claim.confidence }} · {{ proactiveClaimStateLabel(claim.state) }}</small></span>
                    <span class="proactive-claim-actions">
                      <button type="button" :class="{active: claim.state === 'confirmed'}" :disabled="proactiveBusy" title="确认这条画像记忆" aria-label="确认画像记忆" @click="updateProactiveClaimState(claim, 'confirmed')"><Check :size="14" /></button>
                      <button type="button" :class="{rejected: claim.state === 'rejected'}" :disabled="proactiveBusy" title="拒绝这条画像记忆" aria-label="拒绝画像记忆" @click="updateProactiveClaimState(claim, 'rejected')"><X :size="14" /></button>
                    </span>
                  </li>
                  <li v-if="proactiveClaims.length === 0" class="study-empty">尚未形成画像记忆。</li>
                </ul>
                <div class="settings-note proactive-retention-note"><Database :size="16" />原始屏幕、音频、输入、剪贴板和文件副本最多保留 7 天，并在成功提炼为用户记忆后才删除；控制面与画像数据留在本机。</div>
              </template>

              <template v-else>
                <section class="proactive-integration-section">
                  <div class="proactive-capability-heading"><strong>Home Assistant</strong><small>局域网状态订阅与实体级服务授权。</small></div>
                  <form class="proactive-integration-form" @submit.prevent="connectHomeAssistant">
                    <label><span>名称</span><input v-model="homeAssistantForm.displayName" autocomplete="off" /></label>
                    <label class="wide"><span>实例地址</span><input v-model="homeAssistantForm.endpoint" inputmode="url" autocomplete="url" /></label>
                    <label class="wide"><span>长期访问令牌</span><input v-model="homeAssistantForm.accessToken" type="password" autocomplete="off" /></label>
                    <button type="submit" :disabled="proactiveBusy || !proactiveActive"><Link2 :size="15" />连接</button>
                  </form>
                  <ul class="proactive-connection-list">
                    <li v-for="connection in homeAssistantConnections" :key="connection.id">
                      <span><strong>{{ connection.displayName }}</strong><small>{{ connection.endpoint }} · {{ integrationTime(connection.lastSyncAt) }}</small></span>
                      <em :class="`is-${connection.state}`">{{ connection.state }}</em>
                      <button type="button" title="立即同步" aria-label="立即同步 Home Assistant" :disabled="proactiveBusy" @click="syncProactiveConnection(connection.provider, connection.id)"><RefreshCw :size="14" /></button>
                      <button type="button" title="撤销连接" aria-label="撤销 Home Assistant 连接" :disabled="proactiveBusy" @click="deleteProactiveConnection(connection.provider, connection.id, connection.displayName)"><Trash2 :size="14" /></button>
                    </li>
                    <li v-if="homeAssistantConnections.length === 0" class="study-empty">尚未连接 Home Assistant。</li>
                  </ul>
                  <ul v-if="homeAssistantEntities.length > 0" class="proactive-entity-list">
                    <li v-for="entity in homeAssistantEntities" :key="entity.id">
                      <input :checked="entity.enabled" type="checkbox" class="settings-switch" :disabled="proactiveBusy" :aria-label="`授权 ${entity.displayName ?? entity.entityId}`" @change="toggleHomeEntity(entity, $event)" />
                      <span><strong>{{ entity.displayName ?? entity.entityId }}</strong><small>{{ entity.entityId }} · {{ entity.state.state ?? 'unknown' }}</small></span>
                      <input v-model="homeEntityOpsDrafts[entity.id]" class="proactive-ops-input" placeholder="turn_on, turn_off" :disabled="proactiveBusy || !entity.enabled" @change="saveHomeEntityOps(entity)" />
                    </li>
                  </ul>
                </section>

                <section class="proactive-integration-section">
                  <div class="proactive-capability-heading"><strong>小米运动健康</strong><small>使用用户自有的官方开放平台配置同步步数、睡眠与静息心率。</small></div>
                  <form class="proactive-integration-form" @submit.prevent="connectXiaomiHealth">
                    <label><span>名称</span><input v-model="xiaomiHealthForm.displayName" autocomplete="off" /></label>
                    <label class="wide"><span>API 地址</span><input v-model="xiaomiHealthForm.apiBaseUrl" inputmode="url" autocomplete="url" /></label>
                    <label><span>Access Token</span><input v-model="xiaomiHealthForm.accessToken" type="password" autocomplete="off" /></label>
                    <label><span>Refresh Token</span><input v-model="xiaomiHealthForm.refreshToken" type="password" autocomplete="off" /></label>
                    <label class="wide"><span>Token Endpoint</span><input v-model="xiaomiHealthForm.tokenEndpoint" inputmode="url" autocomplete="off" /></label>
                    <label><span>Client ID</span><input v-model="xiaomiHealthForm.clientId" autocomplete="off" /></label>
                    <label><span>Client Secret</span><input v-model="xiaomiHealthForm.clientSecret" type="password" autocomplete="off" /></label>
                    <label class="wide"><span>每日汇总路径</span><input v-model="xiaomiHealthForm.dailyPath" autocomplete="off" /></label>
                    <button type="submit" :disabled="proactiveBusy || !proactiveActive"><Heart :size="15" />连接</button>
                  </form>
                  <ul class="proactive-connection-list">
                    <li v-for="connection in xiaomiHealthConnections" :key="connection.id">
                      <span><strong>{{ connection.displayName }}</strong><small>{{ integrationTime(connection.lastSyncAt) }}</small></span>
                      <em :class="`is-${connection.state}`">{{ connection.state }}</em>
                      <button type="button" title="同步今日健康数据" aria-label="同步今日健康数据" :disabled="proactiveBusy" @click="syncProactiveConnection(connection.provider, connection.id)"><RefreshCw :size="14" /></button>
                      <button type="button" title="撤销连接" aria-label="撤销小米运动健康连接" :disabled="proactiveBusy" @click="deleteProactiveConnection(connection.provider, connection.id, connection.displayName)"><Trash2 :size="14" /></button>
                    </li>
                    <li v-if="xiaomiHealthConnections.length === 0" class="study-empty">尚未连接小米运动健康。</li>
                  </ul>
                  <ul v-if="proactiveDashboard?.health.length" class="proactive-health-list">
                    <li v-for="sample in proactiveDashboard.health" :key="sample.id"><span>{{ healthMetricLabel(sample) }}</span><strong>{{ healthMetricValue(sample) }}</strong><small>{{ sample.localDate }}</small></li>
                  </ul>
                </section>
              </template>
            </template>
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
            <label class="settings-row settings-choice-row"><span><strong>专注模式</strong><small>启用专属苏格拉底启发式教学与防剧透规则</small></span><input v-model="studyModeEnabled" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
            <label class="settings-row settings-choice-row"><span><strong>回车发送</strong><small>关闭后，回车只换行</small></span><input v-model="enterToSend" type="checkbox" class="settings-switch" @change="saveSettings" /></label>
          </div>
          <LLMConfigPanel v-else-if="settingsCategory === 'model'" class="settings-section" />
          <PersonaManagerPanel v-else-if="settingsCategory === 'persona'" class="settings-section" />
          <div v-else-if="settingsCategory === 'notifications'" class="settings-section">
            <div class="settings-section-heading">
              <span class="heading-icon-wrap"><Bell :size="18" /></span>
              <span><strong>提醒</strong><small>控制学习过程中的轻量通知与节奏提醒</small></span>
            </div>

            <div class="settings-note"><Check :size="16" />设置会自动保存在当前设备</div>
          </div>
          <LocalVoiceConfigPanel v-else-if="settingsCategory === 'voice'" class="settings-section" />
          <PluginManagerPanel v-else class="settings-section" />
        </section>
      </div>
    </el-dialog>

    <!-- CAP-007 / CAP-002: 术语名词解释弹窗 -->
    <TermExploreDialog
      v-model="exploreDialogOpen"
      :term="selectedTerm"
      :context-text="latestAssistantLine?.text"
    />
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

    <el-dialog
      v-model="proactiveDialogOpen"
      title="授权主动智能模式？"
      class="permission-confirm-dialog proactive-authorization-dialog"
      width="min(620px, calc(100vw - 28px))"
      align-center
      @closed="resetProactiveAuthorization"
    >
      <div class="permission-confirmation">
        <span class="permission-confirmation-icon proactive-confirmation-icon"><BrainCircuit :size="24" /></span>
        <div>
          <p>主动智能模式会在本机持续理解你的使用习惯、操作习惯和已授权私人资料，并可执行你单独授权的本地、外部、特权及不可逆动作。</p>
          <small>需要先保持“完全访问”。系统会逐项请求当前平台可以验证的权限；无法探测或未接入的来源会明确显示为“待验证”，不会静默开启。</small>
        </div>
      </div>
      <div class="proactive-authorization-scope">
        <strong>本次授权范围</strong>
        <span>应用与窗口、浏览器、键鼠与剪贴板、屏幕、文件、通信、音视频、位置、传感器、敏感私人资料，以及后台与主动动作权限。</span>
      </div>
      <label class="settings-row settings-choice-row proactive-dialog-choice"><span><strong>开机自启</strong><small>设备登录后恢复 Host（会告知系统设置结果）</small></span><input v-model="proactiveAutostart" type="checkbox" class="settings-switch" /></label>
      <label class="settings-row settings-choice-row proactive-dialog-choice"><span><strong>后台持续运行</strong><small>窗口关闭后继续运行已授权观察与处理</small></span><input v-model="proactiveBackground" type="checkbox" class="settings-switch" /></label>
      <label class="permission-acknowledgement proactive-acknowledgement">
        <input v-model="proactiveAcknowledged" type="checkbox" />
        <span>我已阅读全量画像范围，确认这些来源和动作由我单独授权，并知悉数据仅在本机持久化。</span>
      </label>
      <template #footer>
        <div class="permission-confirmation-actions">
          <button type="button" class="permission-cancel" @click="proactiveDialogOpen = false">取消</button>
          <button type="button" class="permission-enable proactive-enable" :disabled="!proactiveAcknowledged || proactiveBusy || toolApprovalMode !== 'full_access'" @click="authorizeProactive">
            <RefreshCw v-if="proactiveBusy" class="proactive-spinner" :size="15" />
            <BrainCircuit v-else :size="15" />
            {{ toolApprovalMode === 'full_access' ? '请求权限并启用' : '请先开启完全访问' }}
          </button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>
