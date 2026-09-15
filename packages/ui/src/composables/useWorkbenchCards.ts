import { computed, markRaw, ref, watch, type Component, type Ref } from 'vue';
import {
  Clock3,
  History,
  ListTodo,
  NotebookPen,
} from 'lucide-vue-next';
import {
  useAervoxApi,
  useAervoxDiary,
  type DiaryDto,
  type GenerateTodayResultDto,
} from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { petReactKind } from '../live2d/petReactions';
import { aervoxConfirm } from '../primitives';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchCardContribution } from '../registry/types';
import type { ToolId } from './useWorkbenchLayout';

export type CardId = string;

export interface CardDefinition extends WorkbenchCardContribution {}


export interface DiaryView {
  localDate: string;
  title: string;
  content: string;
  generatedBy: 'llm' | 'template';
  materialCount: number;
  mode: 'created' | 'rewritten' | 'existing';
}

const TEMPLATE_MARKER = '（本篇为非 LLM 模式的模板日记';
const toDiaryView = (result: GenerateTodayResultDto): DiaryView => ({
  localDate: result.localDate,
  title: result.title,
  content: result.content,
  generatedBy: result.generatedBy,
  materialCount: result.materialCount,
  mode: result.mode,
});
const toDiaryViewFromRow = (row: DiaryDto): DiaryView => ({
  localDate: row.localDate,
  title: row.title,
  content: row.content,
  generatedBy: row.content.includes(TEMPLATE_MARKER) ? 'template' : 'llm',
  materialCount: 0,
  mode: 'existing',
});

export const todayLocalDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const DAILY_PROBLEM_URL = 'https://www.nowcoder.com/problem/tracker';

export function useWorkbenchCards(options: {
  activeQuestion: Ref<UserQuestionRequiredEventData | null>;
  timerRunning: Ref<boolean>;
  formattedTime: Ref<string>;
  storyCount: Ref<number>;
  onOpenTool: (tool: ToolId) => void;
  onStartQuiz: () => void;
  onSubmitQuestionAnswers: (answers: Array<{ id: string; selected: string[] }>) => Promise<void>;
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
  registry?: UIRegistry;
}) {
  const api = useAervoxApi();
  const diaryApi = useAervoxDiary();

  const {
    goals,
    dueReviews,
    mistakes,
    learningPlans,
    activePracticeSession,
  } = api;

  const cardSlots = ref<Array<CardId | null>>([null, null]);
  let savedCardSlots: Array<CardId | null> | null = null;
  let diarySlotRestore: CardId | null | undefined = undefined;

  // 提问卡
  const questionCardSelected = ref<string[]>([]);
  const questionCardData = computed(() => options.activeQuestion.value?.questions[0] ?? null);

  watch(options.activeQuestion, (value) => {
    if (!value) questionCardSelected.value = [];
  });

  function handleQuestionCardOption(label: string) {
    const question = questionCardData.value;
    if (!question) return;
    if (question.multiSelect) {
      questionCardSelected.value = questionCardSelected.value.includes(label)
        ? questionCardSelected.value.filter((item) => item !== label)
        : [...questionCardSelected.value, label];
      return;
    }
    void options.onSubmitQuestionAnswers([{ id: question.id, selected: [label] }]);
  }

  function submitQuestionCardAnswers() {
    const question = questionCardData.value;
    if (!question || questionCardSelected.value.length === 0) return;
    void options.onSubmitQuestionAnswers([{ id: question.id, selected: [...questionCardSelected.value] }]);
  }

  // 日记状态
  const todayDiary = ref<GenerateTodayResultDto | null>(null);
  const viewingDiary = ref<DiaryView | null>(null);
  const diaryHistory = ref<DiaryDto[]>([]);
  const diaryBusy = ref(false);
  const diaryError = ref<string | null>(null);
  const diaryDisplayContent = computed(() =>
    (viewingDiary.value?.content ?? '').replace(/^标题[：:].*\n\n/, '').replace(/^标题[：:].*\n/, ''),
  );

  async function loadDiaryHistory() {
    try {
      diaryHistory.value = await diaryApi.listDiaries(30);
    } catch {
      diaryHistory.value = [];
    }
  }

  async function openDiary() {
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const result = await diaryApi.generateToday();
      todayDiary.value = result;
      viewingDiary.value = result ? toDiaryView(result) : null;
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '日记加载失败';
    } finally {
      diaryBusy.value = false;
    }
    await loadDiaryHistory();
  }

  async function selectDiaryDate(localDate: string) {
    if (viewingDiary.value?.localDate === localDate) return;
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const row = await diaryApi.getDiaryByDate(localDate);
      viewingDiary.value = toDiaryViewFromRow(row);
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '日记加载失败';
    } finally {
      diaryBusy.value = false;
    }
  }

  async function generateDiaryNow() {
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const result = await diaryApi.generateToday({ rewrite: true });
      todayDiary.value = result;
      viewingDiary.value = toDiaryView(result);
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '生成失败';
    } finally {
      diaryBusy.value = false;
    }
    await loadDiaryHistory();
  }

  // 待办清单
  const todos = ref<Array<{ id: number; text: string; done: boolean }>>([]);
  const newTodo = ref('');
  const unfinishedTodos = computed(() => todos.value.filter((todo) => !todo.done));
  const completedTodoCount = computed(() => todos.value.length - unfinishedTodos.value.length);
  const syncGoals = computed(() => goals.value.filter((goal) => goal.status === 'active' || goal.status === 'paused'));
  const syncReviewCount = computed(() => dueReviews.value.length);
  const syncedTodoCount = computed(() => syncGoals.value.length + syncReviewCount.value);
  const goalBusyId = ref<string | null>(null);

  function addTodo() {
    const text = newTodo.value.trim();
    if (!text) return;
    todos.value.unshift({ id: Date.now(), text, done: false });
    newTodo.value = '';
  }

  async function completeGoalFromTodo(goalId: string) {
    goalBusyId.value = goalId;
    try {
      await api.updateGoal(goalId, { status: 'completed' });
    } catch {
      console.error('更新学习目标失败');
    } finally {
      goalBusyId.value = null;
    }
  }

  async function toggleGoalPausedFromTodo(goalId: string, next: 'active' | 'paused') {
    goalBusyId.value = goalId;
    try {
      await api.updateGoal(goalId, { status: next });
    } catch {
      console.error('更新学习目标失败');
    } finally {
      goalBusyId.value = null;
    }
  }

  // 错题与练习
  const activeMistakeCount = computed(() => mistakes.value.filter((item) => item.status === 'active').length);
  const practiceSession = ref<{ sessionId: string; items: Array<{ id: string; prompt: string }>; nextQuestionIndex?: number } | null>(null);
  const practiceIndex = ref(0);
  const practiceReadyToComplete = ref(false);
  const practiceAnswer = ref('');
  const practiceFeedback = ref<{ judgement: string; nextStep: string } | null>(null);
  const practiceSubmission = ref<{ sessionId: string; questionId: string; answer: string; idempotencyKey: string } | null>(null);
  const practiceReport = ref<{
    answeredCount: number;
    questionCount: number;
    remainingCount: number;
    correctCount: number;
    incorrectCount: number;
    unverifiableCount: number;
    accuracy: number | null;
    avgTimeSpentSec: number | null;
    totalHintsUsed: number;
    guidance: { difficulty: 'ease' | 'maintain' | 'increase'; reasonCode: string; message: string };
    nextStep: string;
  } | null>(null);
  const questionStartTime = ref<number>(0);
  const practiceBusy = ref(false);
  const practiceError = ref<string | null>(null);

  const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active');
  const mistakeReasonFilter = ref<string>('all');
  const selectedMistakeIds = ref<string[]>([]);
  const mistakeBusyId = ref<string | null>(null);
  const mistakeInsightDrafts = ref<Record<string, { reasonCode: string; note: string }>>({});
  const reviewBusyId = ref<string | null>(null);

  const currentPracticeQuestion = computed(() => practiceSession.value?.items[practiceIndex.value] ?? null);
  const visibleMistakes = computed(() =>
    mistakes.value.filter(
      (item) =>
        (mistakeFilter.value === 'all' || item.status === mistakeFilter.value)
        && (mistakeReasonFilter.value === 'all' || item.reasonCode === mistakeReasonFilter.value),
    ),
  );

  const mistakeReasonOptions = [
    { value: 'concept_gap', label: '概念不清' },
    { value: 'calculation', label: '计算失误' },
    { value: 'careless', label: '粗心' },
    { value: 'misread', label: '审题偏差' },
    { value: 'other', label: '其他' },
  ] as const;

  function mistakeReasonLabel(reasonCode: string | null) {
    return mistakeReasonOptions.find((item) => item.value === reasonCode)?.label ?? '未记录错因';
  }

  function mistakeInsightDraft(item: { questionId: string; reasonCode: string | null; note: string | null }) {
    return mistakeInsightDrafts.value[item.questionId] ?? { reasonCode: item.reasonCode ?? '', note: item.note ?? '' };
  }

  function updateMistakeInsightDraft(questionId: string, update: Partial<{ reasonCode: string; note: string }>) {
    const current = mistakeInsightDrafts.value[questionId] ?? { reasonCode: '', note: '' };
    mistakeInsightDrafts.value[questionId] = { ...current, ...update };
  }

  function restorePracticeSession(session: { sessionId: string; items: Array<{ id: string; prompt: string }>; nextQuestionIndex?: number }) {
    practiceSession.value = session;
    const nextIndex = session.nextQuestionIndex ?? 0;
    practiceReadyToComplete.value = nextIndex >= session.items.length;
    practiceIndex.value = Math.min(nextIndex, Math.max(session.items.length - 1, 0));
    practiceAnswer.value = '';
    practiceSubmission.value = null;
    practiceFeedback.value = null;
    questionStartTime.value = Date.now();
  }

  async function submitPracticeAnswer() {
    const question = currentPracticeQuestion.value;
    const answer = practiceAnswer.value.trim();
    if (!practiceSession.value || !question || !answer || practiceBusy.value) return;
    practiceBusy.value = true;
    practiceError.value = null;
    try {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - questionStartTime.value) / 1000));
      const existing = practiceSubmission.value;
      const submission = existing?.sessionId === practiceSession.value.sessionId && existing.questionId === question.id && existing.answer === answer
        ? existing
        : { sessionId: practiceSession.value.sessionId, questionId: question.id, answer, idempotencyKey: `attempt_${crypto.randomUUID()}` };
      practiceSubmission.value = submission;
      practiceFeedback.value = await api.submitPracticeAnswer(submission.sessionId, submission.questionId, submission.answer, submission.idempotencyKey, elapsedSeconds);
    } catch (error) {
      practiceError.value = error instanceof Error ? '作答没有保存，请重试。' : '作答失败，请重试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  async function finishPractice(showArchivedGoals = false) {
    if (!practiceSession.value) return;
    practiceBusy.value = true;
    practiceError.value = null;
    try {
      practiceReport.value = await api.completePracticeSession(practiceSession.value.sessionId);
      practiceFeedback.value = null;
      practiceReadyToComplete.value = false;
      await api.loadAll(showArchivedGoals);
    } catch {
      practiceError.value = '暂时无法生成练习报告，请稍后再试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  function nextPracticeQuestion() {
    if (!practiceSession.value) return;
    if (practiceIndex.value + 1 >= practiceSession.value.items.length) {
      practiceReadyToComplete.value = true;
      return;
    }
    practiceIndex.value += 1;
    practiceAnswer.value = '';
    practiceSubmission.value = null;
    practiceFeedback.value = null;
    questionStartTime.value = Date.now();
  }

  async function startMistakePractice() {
    const activeIds = mistakes.value.filter((item) => item.status === 'active').map((item) => item.questionId);
    const questionIds = (selectedMistakeIds.value.length ? selectedMistakeIds.value : activeIds).slice(0, 5);
    if (!questionIds.length) {
      practiceError.value = '当前没有可重练的错题。';
      return;
    }
    practiceBusy.value = true;
    practiceError.value = null;
    practiceReport.value = null;
    practiceFeedback.value = null;
    try {
      restorePracticeSession(await api.startMistakePractice(questionIds));
      selectedMistakeIds.value = [];
    } catch {
      practiceError.value = '错题重练启动失败，请刷新后重试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  async function setMistakeStatus(questionId: string, status: 'active' | 'mastered' | 'dismissed') {
    mistakeBusyId.value = questionId;
    try {
      await api.setMistakeStatus(questionId, status);
      selectedMistakeIds.value = selectedMistakeIds.value.filter((id) => id !== questionId);
    } catch {
      practiceError.value = '错题状态没有保存，请稍后重试。';
    } finally {
      mistakeBusyId.value = null;
    }
  }

  async function saveMistakeInsight(item: { questionId: string; reasonCode: string | null; note: string | null }) {
    const draft = mistakeInsightDraft(item);
    mistakeBusyId.value = item.questionId;
    practiceError.value = null;
    try {
      await api.setMistakeInsight(item.questionId, {
        reasonCode: (draft.reasonCode || null) as 'concept_gap' | 'calculation' | 'careless' | 'misread' | 'other' | null,
        note: draft.note,
      });
      delete mistakeInsightDrafts.value[item.questionId];
    } catch {
      practiceError.value = '错因记录没有保存，请稍后重试。';
    } finally {
      mistakeBusyId.value = null;
    }
  }

  async function completeReview(reviewId: string, isCorrect: boolean) {
    reviewBusyId.value = reviewId;
    practiceError.value = null;
    try {
      await api.completeReview(reviewId, isCorrect);
    } catch {
      practiceError.value = '复习结果没有保存，请使用相同结果重试。';
    } finally {
      reviewBusyId.value = null;
    }
  }

  // 学习规划
  const newPlanTopic = ref('');
  const newPlanLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner');
  const newPlanMinutes = ref(25);
  const planGenerating = ref(false);
  const planBusyId = ref<string | null>(null);
  const planError = ref<string | null>(null);

  async function generatePlan() {
    const topic = newPlanTopic.value.trim();
    if (!topic || planGenerating.value) return;
    planGenerating.value = true;
    planError.value = null;
    try {
      await api.generateLearningPlan({ topic, level: newPlanLevel.value, dailyMinutes: newPlanMinutes.value });
      newPlanTopic.value = '';
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      planError.value = message.includes('llm_disabled')
        ? '尚未配置 LLM，请先在「设置 → 模型与服务」完成配置。'
        : message.includes('plan_generation_failed')
          ? '模型未能产出有效的学习规划，请换个主题描述再试。'
          : '生成学习规划失败，请稍后重试。';
    } finally {
      planGenerating.value = false;
    }
  }

  async function togglePlanTask(task: { id: string; status: string }) {
    planBusyId.value = task.id;
    planError.value = null;
    try {
      await api.setPlanTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
    } catch {
      planError.value = '任务状态没有保存，请稍后重试。';
    } finally {
      planBusyId.value = null;
    }
  }

  async function archivePlan(planId: string) {
    const confirmed = await aervoxConfirm({
      title: '归档学习规划',
      message: '归档后规划将从列表隐藏，但完成记录仍会保留。确定归档吗？',
      variant: 'danger',
      confirmText: '归档',
    });
    if (!confirmed) return;
    planBusyId.value = planId;
    try {
      await api.archiveLearningPlan(planId);
    } catch {
      planError.value = '规划归档失败，请稍后重试。';
    } finally {
      planBusyId.value = null;
    }
  }

  function planMilestoneStatusLabel(status: string) {
    return ({ active: '进行中', completed: '已完成', locked: '未解锁' } as Record<string, string>)[status] ?? status;
  }

  // 核心内置卡片
  const coreCards: CardDefinition[] = [
    {
      id: 'todo',
      label: '待办清单',
      description: '勾选完成今天的待办事项',
      icon: ListTodo,
      summary: () => `待完成 ${unfinishedTodos.value.length} 件`,
      action: () => options.onOpenTool('todo'),
      priority: 70,
    },
    {
      id: 'timer',
      label: '番茄钟',
      description: '专注计时，劳逸结合',
      icon: Clock3,
      summary: () => options.timerRunning.value ? `${options.formattedTime.value} 专注中` : `${options.formattedTime.value} 待开始`,
      action: () => options.onOpenTool('timer'),
      priority: 60,
    },
    {
      id: 'history',
      label: '对话回看',
      description: '回顾与思隅的历史对话',
      icon: History,
      summary: () => `${options.storyCount.value} 条对话记录`,
      action: () => options.onOpenTool('history'),
      priority: 50,
    },
    {
      id: 'diary',
      label: '今日日记',
      description: 'AI 按今天记忆写的日记',
      icon: NotebookPen,
      summary: () => todayDiary.value?.title ?? 'AI 每日日记',
      action: () => options.onOpenTool('diary'),
      priority: 40,
    },
  ];

  // 卡片目录：内置核心卡片与注册层插件卡片动态合并，按 priority 降序排序
  const cardCatalog = computed<CardDefinition[]>(() => {
    const pluginCards = options.registry?.getCards() ?? [];
    return [...coreCards, ...pluginCards].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  });

  const QUICK_TOOLS_STORAGE_KEY = 'aervox-quick-tools';

  function loadSavedQuickToolIds(): string[] | null {
    try {
      const raw = localStorage.getItem(QUICK_TOOLS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // 容错处理：忽略非法的 JSON 缓存
    }
    return null;
  }

  function persistQuickToolIds(ids: string[] | null) {
    try {
      if (ids === null) {
        localStorage.removeItem(QUICK_TOOLS_STORAGE_KEY);
      } else {
        localStorage.setItem(QUICK_TOOLS_STORAGE_KEY, JSON.stringify(ids));
      }
    } catch {
      // 忽略受限环境下的写入失败
    }
  }

  const customQuickToolIds = ref<string[] | null>(loadSavedQuickToolIds());

  // 当前已启用的快捷卡片列表：未自定义时呈现全量已注册卡片；自定义后严格遵循定制顺序并动态过滤未启用的插件卡片
  const activeQuickCards = computed<CardDefinition[]>(() => {
    if (customQuickToolIds.value === null) {
      return cardCatalog.value;
    }
    const map = new Map(cardCatalog.value.map((c) => [c.id, c]));
    const result: CardDefinition[] = [];
    for (const id of customQuickToolIds.value) {
      const card = map.get(id);
      if (card) result.push(card);
    }
    return result;
  });

  // 更多可添加的快捷卡片列表：已注册卡片中未被纳入当前快捷方式的项
  const availableQuickCards = computed<CardDefinition[]>(() => {
    if (customQuickToolIds.value === null) {
      return [];
    }
    const activeSet = new Set(customQuickToolIds.value);
    return cardCatalog.value.filter((card) => !activeSet.has(card.id));
  });

  function addQuickTool(id: string) {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    if (!current.includes(id)) {
      current.push(id);
    }
    customQuickToolIds.value = current;
    persistQuickToolIds(current);
  }

  function removeQuickTool(id: string) {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    const next = current.filter((item) => item !== id);
    customQuickToolIds.value = next;
    persistQuickToolIds(next);
  }

  function moveQuickTool(id: string, direction: 'up' | 'down') {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    const index = current.indexOf(id);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= current.length) return;
    const [removed] = current.splice(index, 1);
    current.splice(targetIndex, 0, removed);
    customQuickToolIds.value = current;
    persistQuickToolIds(current);
  }

  function resetQuickTools() {
    customQuickToolIds.value = null;
    persistQuickToolIds(null);
  }

  const slotCards = computed(() => cardSlots.value.map((id) => (id ? cardCatalog.value.find((card) => card.id === id) ?? null : null)));

  function isCardPicked(id: CardId) {
    return cardSlots.value.includes(id);
  }

  function selectCard(slot: number, id: CardId | null, event?: MouseEvent) {
    if (slot === 0 && id === null && cardSlots.value[0] === 'diary' && diarySlotRestore !== undefined) {
      cardSlots.value = cardSlots.value.map((current, index) => (index === 0 ? diarySlotRestore : current)) as Array<CardId | null>;
      diarySlotRestore = undefined;
      localStorage.setItem('aervox-side-cards', JSON.stringify(cardSlots.value));
      const slotEl = (event?.target as HTMLElement | null)?.closest?.('.side-card-slot') ?? undefined;
      petReactKind('shake', { expression: MizukiExpression.face_trouble_01, lookAtEl: slotEl });
      return;
    }
    cardSlots.value = cardSlots.value.map((current, index) => (index === slot ? id : current));
    localStorage.setItem('aervox-side-cards', JSON.stringify(cardSlots.value));
    const slotEl = (event?.target as HTMLElement | null)?.closest?.('.side-card-slot') ?? undefined;
    if (id) petReactKind('glad', { expression: MizukiExpression.face_smile_03, lookAtEl: slotEl, lookDuration: 3600 });
    else petReactKind('shake', { expression: MizukiExpression.face_trouble_01, lookAtEl: slotEl });
  }

  function activateCard(card: CardDefinition, event?: MouseEvent | KeyboardEvent) {
    const cardEl = (event?.currentTarget as HTMLElement | null)?.closest?.('.side-card') ?? undefined;
    petReactKind('forward', { expression: MizukiExpression.face_notice_01, lookAtEl: cardEl });
    card.action();
  }

  function applyStudyCardLayout() {
    savedCardSlots = [...cardSlots.value];
    cardSlots.value = ['study', 'timer'];
  }

  function restoreStudyCardLayout() {
    if (!savedCardSlots) return;
    cardSlots.value = savedCardSlots;
    savedCardSlots = null;
  }

  function openDailyProblem() {
    options.recordActivity('aervox.operation', 'workbench.daily_problem_opened', DAILY_PROBLEM_URL);
    petReactKind('forward', { lookAtEl: '.side-cards' });
    const desktopBridge = (window as Window & { fairyDesktop?: { openExternal?: (url: string) => Promise<void> } }).fairyDesktop;
    if (desktopBridge?.openExternal) void desktopBridge.openExternal(DAILY_PROBLEM_URL);
    else window.open(DAILY_PROBLEM_URL, '_blank', 'noopener');
  }

  function setDiarySlotRestore(val: CardId | null | undefined) {
    diarySlotRestore = val;
  }

  return {
    api,
    diaryApi,
    mistakes,
    cardSlots,
    slotCards,
    cardCatalog,
    customQuickToolIds,
    activeQuickCards,
    availableQuickCards,
    addQuickTool,
    removeQuickTool,
    moveQuickTool,
    resetQuickTools,
    questionCardData,
    questionCardSelected,
    todayDiary,
    viewingDiary,
    diaryHistory,
    diaryBusy,
    diaryError,
    diaryDisplayContent,
    todos,
    newTodo,
    unfinishedTodos,
    completedTodoCount,
    syncGoals,
    syncReviewCount,
    syncedTodoCount,
    goalBusyId,
    activeMistakeCount,
    practiceSession,
    practiceIndex,
    practiceReadyToComplete,
    practiceAnswer,
    practiceFeedback,
    practiceReport,
    practiceBusy,
    practiceError,
    currentPracticeQuestion,
    visibleMistakes,
    mistakeFilter,
    mistakeReasonFilter,
    selectedMistakeIds,
    mistakeBusyId,
    reviewBusyId,
    mistakeReasonOptions,
    newPlanTopic,
    newPlanLevel,
    newPlanMinutes,
    planGenerating,
    planBusyId,
    planError,
    handleQuestionCardOption,
    submitQuestionCardAnswers,
    openDiary,
    selectDiaryDate,
    generateDiaryNow,
    addTodo,
    completeGoalFromTodo,
    toggleGoalPausedFromTodo,
    mistakeReasonLabel,
    mistakeInsightDraft,
    updateMistakeInsightDraft,
    submitPracticeAnswer,
    finishPractice,
    nextPracticeQuestion,
    startMistakePractice,
    setMistakeStatus,
    saveMistakeInsight,
    completeReview,
    generatePlan,
    togglePlanTask,
    archivePlan,
    planMilestoneStatusLabel,
    isCardPicked,
    selectCard,
    activateCard,
    applyStudyCardLayout,
    restoreStudyCardLayout,
    openDailyProblem,
    setDiarySlotRestore,
  };
}

export type WorkbenchCardsComposable = ReturnType<typeof useWorkbenchCards>;
