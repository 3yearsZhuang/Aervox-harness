/**
 * Aervox｜思隅 plugins/focus-mode — 刷题 / 错题 / 学习规划状态机（CR-060 §B9b 自宿主迁入）
 *
 * 迁入理由：这三条链路的**状态与请求编排**原寄居在宿主通用组合式函数
 * `packages/ui/src/composables/useWorkbenchCards.ts`，而该状态只被本插件组件消费。
 * 迁出后宿主只保留与插件无关的卡片目录、槽位、待办、日记与目标同步。
 *
 * 数据来源：宿主经 `context.cards.api` 暴露的**通用** `@aervox/api-client` 端口实例
 * （宿主仍是唯一请求编排者与本地上下文持有者；插件只消费该实例，不自行新建，
 * 以免出现两份互相不可见的 API 状态）。
 *
 * 生命周期：每个工作台上下文独立创建，插件清理时解除 API 引用。
 */
import { computed, ref, shallowRef } from 'vue';
import type { useAervoxApi } from '@aervox/api-client';
import { aervoxConfirm, useWorkbenchContext, type WorkbenchContext } from '@aervox/ui/plugin-api';

type FocusLearningApi = ReturnType<typeof useAervoxApi>;

/** 练习会话视图（与宿主 `practiceSession` 契约一致） */
interface PracticeSessionView {
  sessionId: string;
  items: Array<{ id: string; prompt: string }>;
  nextQuestionIndex?: number;
}

export const mistakeReasonOptions = [
  { value: 'concept_gap', label: '概念不清' },
  { value: 'calculation', label: '计算失误' },
  { value: 'careless', label: '粗心' },
  { value: 'misread', label: '审题偏差' },
  { value: 'other', label: '其他' },
] as const;

const instances = new WeakMap<WorkbenchContext, ReturnType<typeof createFocusLearning>>();

export function useFocusLearning(context: WorkbenchContext = useWorkbenchContext()) {
  let learning = instances.get(context);
  if (!learning) { learning = createFocusLearning(context.cards?.api ?? null); instances.set(context, learning); }
  return learning;
}

export function disposeFocusLearning(context: WorkbenchContext): void {
  instances.get(context)?.dispose();
  instances.delete(context);
}

export function createFocusLearning(api: FocusLearningApi | null) {
const boundApi = shallowRef(api);
// ── 练习状态 ──
const practiceSession = ref<PracticeSessionView | null>(null);
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

// ── 错题状态 ──
const mistakeFilter = ref<'active' | 'mastered' | 'dismissed' | 'all'>('active');
const mistakeReasonFilter = ref<string>('all');
const selectedMistakeIds = ref<string[]>([]);
const mistakeBusyId = ref<string | null>(null);
const mistakeInsightDrafts = ref<Record<string, { reasonCode: string; note: string }>>({});

// ── 学习规划状态 ──
const newPlanTopic = ref('');
const newPlanLevel = ref<'beginner' | 'intermediate' | 'advanced'>('beginner');
const newPlanMinutes = ref(25);
const planGenerating = ref(false);
const planBusyId = ref<string | null>(null);
const planError = ref<string | null>(null);

function requireApi(): FocusLearningApi {
  if (!boundApi.value) throw new Error('[focus-mode] initFocusLearning() 必须先于使用学习状态调用');
  return boundApi.value;
}

/**
 * 绑定宿主 api 实例（幂等）；换绑——含解绑为 `null`——时清空视图态，
 * 避免沿用上一个实例的数据。
 *
 * 宿主未提供 api 端口（自定义嵌入 / 降级上下文）时传 `null` **显式解绑**：
 * 只读视图回落为空，写操作经 `requireApi()` 明确失败，而不是静默读到别的渲染器的数据。
 */
function bindApi(api: FocusLearningApi | null): void {
  if (boundApi.value === api) return;
  boundApi.value = api;
  practiceSession.value = null;
  practiceIndex.value = 0;
  practiceReadyToComplete.value = false;
  practiceAnswer.value = '';
  practiceFeedback.value = null;
  practiceSubmission.value = null;
  practiceReport.value = null;
  practiceBusy.value = false;
  practiceError.value = null;
  mistakeFilter.value = 'active';
  mistakeReasonFilter.value = 'all';
  selectedMistakeIds.value = [];
  mistakeBusyId.value = null;
  mistakeInsightDrafts.value = {};
  newPlanTopic.value = '';
  newPlanLevel.value = 'beginner';
  newPlanMinutes.value = 25;
  planGenerating.value = false;
  planBusyId.value = null;
  planError.value = null;
}


  // 宿主 api 实例上的只读视图（插件不持有数据真源，只消费）
  const mistakes = computed(() => boundApi.value?.mistakes.value ?? []);
  const learningPlans = computed(() => boundApi.value?.learningPlans.value ?? []);
  const apiError = computed(() => boundApi.value?.error.value ?? null);

  const activeMistakeCount = computed(() => mistakes.value.filter((item) => item.status === 'active').length);
  const currentPracticeQuestion = computed(() => practiceSession.value?.items[practiceIndex.value] ?? null);
  const visibleMistakes = computed(() =>
    mistakes.value.filter(
      (item) =>
        (mistakeFilter.value === 'all' || item.status === mistakeFilter.value)
        && (mistakeReasonFilter.value === 'all' || item.reasonCode === mistakeReasonFilter.value),
    ),
  );

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

  function restorePracticeSession(session: PracticeSessionView) {
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
      practiceFeedback.value = await requireApi().submitPracticeAnswer(
        submission.sessionId,
        submission.questionId,
        submission.answer,
        submission.idempotencyKey,
        elapsedSeconds,
      );
    } catch {
      practiceError.value = '作答没有保存，请重试。';
    } finally {
      practiceBusy.value = false;
    }
  }

  async function finishPractice(showArchivedGoals = false) {
    if (!practiceSession.value) return;
    practiceBusy.value = true;
    practiceError.value = null;
    try {
      practiceReport.value = await requireApi().completePracticeSession(practiceSession.value.sessionId);
      practiceFeedback.value = null;
      practiceReadyToComplete.value = false;
      await requireApi().loadAll(showArchivedGoals);
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
      restorePracticeSession(await requireApi().startMistakePractice(questionIds));
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
      await requireApi().setMistakeStatus(questionId, status);
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
      await requireApi().setMistakeInsight(item.questionId, {
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

  async function generatePlan() {
    const topic = newPlanTopic.value.trim();
    if (!topic || planGenerating.value) return;
    planGenerating.value = true;
    planError.value = null;
    try {
      await requireApi().generateLearningPlan({ topic, level: newPlanLevel.value, dailyMinutes: newPlanMinutes.value });
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
      await requireApi().setPlanTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
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
      await requireApi().archiveLearningPlan(planId);
    } catch {
      planError.value = '规划归档失败，请稍后重试。';
    } finally {
      planBusyId.value = null;
    }
  }

  function planMilestoneStatusLabel(status: string) {
    return ({ active: '进行中', completed: '已完成', locked: '未解锁' } as Record<string, string>)[status] ?? status;
  }

  async function reloadGoals() {
    await requireApi().loadAll();
  }

  return {
    dispose: () => bindApi(null),
    // 宿主 api 只读视图
    mistakes,
    learningPlans,
    apiError,
    reloadGoals,
    // 错题
    activeMistakeCount,
    visibleMistakes,
    mistakeFilter,
    mistakeReasonFilter,
    mistakeReasonOptions,
    selectedMistakeIds,
    mistakeBusyId,
    mistakeReasonLabel,
    mistakeInsightDraft,
    updateMistakeInsightDraft,
    setMistakeStatus,
    saveMistakeInsight,
    // 练习
    practiceSession,
    practiceIndex,
    practiceReadyToComplete,
    practiceAnswer,
    practiceFeedback,
    practiceReport,
    practiceBusy,
    practiceError,
    currentPracticeQuestion,
    submitPracticeAnswer,
    finishPractice,
    nextPracticeQuestion,
    startMistakePractice,
    // 学习规划
    newPlanTopic,
    newPlanLevel,
    newPlanMinutes,
    planGenerating,
    planBusyId,
    planError,
    generatePlan,
    togglePlanTask,
    archivePlan,
    planMilestoneStatusLabel,
  };
}
