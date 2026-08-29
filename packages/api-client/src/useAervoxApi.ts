/**
 * Aervox｜思隅 @aervox/api-client — API 状态封装
 *
 * 基于统一 Transport 提供学习/复习/日记/通知等数据组合；桌面与 Web 共用一份。
 */
import { computed, onMounted, ref } from 'vue';
import type { LearningGoalLevel, LearningGoalStatus, UpdateLearningGoal } from '@aervox/contracts';
import { getTimeZone, getTransport } from './transport';

export interface GoalDto {
  id: string;
  topic: string;
  level: LearningGoalLevel;
  availableMinutes: number;
  status: LearningGoalStatus;
  idempotencyKey?: string | null;
}

export interface ReviewItemDto {
  id: string;
  knowledgeId: string;
  dueAt: string;
  intervalDays: number;
  schedulerVersion: number;
  timezoneSnapshot: string;
  status: string;
  completionIsCorrect?: boolean | null;
  nextReviewId?: string | null;
  updatedAt?: string;
}

export interface ReviewSummaryDto {
  dueCount: number;
  overdueCount: number;
  dueTodayCount: number;
  estimatedMinutes: number;
  timeZone: string;
}

export interface PracticeQuestionDto {
  id: string;
  prompt: string;
  knowledgeId?: string | null;
}

export interface PracticeSessionDto {
  sessionId: string;
  items: PracticeQuestionDto[];
  startedAt?: string;
  answeredQuestionIds?: string[];
  nextQuestionIndex?: number;
}

export interface PracticeReportDto {
  sessionId: string;
  questionCount: number;
  answeredCount: number;
  remainingCount: number;
  correctCount: number;
  incorrectCount: number;
  unverifiableCount: number;
  accuracy: number | null;
  avgTimeSpentSec: number | null;
  totalHintsUsed: number;
  guidance: {
    difficulty: 'ease' | 'maintain' | 'increase';
    reasonCode: 'insufficient_judged_answers' | 'low_accuracy' | 'high_accuracy_fast_no_hints' | 'steady_progress';
    message: string;
  };
  nextStep: 'continue' | 'review_scheduled' | 'await_review';
}

export interface PlanTaskDto {
  id: string;
  milestoneId: string;
  order: number;
  title: string;
  description?: string | null;
  hints: string[];
  status: string;
}

export interface PlanMilestoneDto {
  id: string;
  planId: string;
  order: number;
  title: string;
  description?: string | null;
  briefing?: string | null;
  completionCriteria?: string | null;
  debrief?: string | null;
  status: string;
  tasks: PlanTaskDto[];
}

export interface LearningPlanDto {
  id: string;
  topic: string;
  level: string;
  title: string;
  description: string;
  learningObjective: string;
  gains: string[];
  dailyAvailableMinutes: number;
  status: string;
  milestones: PlanMilestoneDto[];
}

export interface MistakeItemDto {
  questionId: string;
  knowledgeId?: string | null;
  prompt: string;
  latestAnswer: string;
  latestAttemptAt: string;
  wrongCount: number;
  masteryState: string;
  status: 'active' | 'mastered' | 'dismissed';
  reasonCode: MistakeReasonCode | null;
  note: string | null;
}

export type MistakeReasonCode = 'concept_gap' | 'calculation' | 'careless' | 'misread' | 'other';

export function useAervoxApi() {
  const goals = ref<GoalDto[]>([]);
  const dueReviews = ref<ReviewItemDto[]>([]);
  const completedReviews = ref<ReviewItemDto[]>([]);
  const reviewSummary = ref<ReviewSummaryDto | null>(null);
  const mistakes = ref<MistakeItemDto[]>([]);
  const learningPlans = ref<LearningPlanDto[]>([]);
  const activePracticeSession = ref<PracticeSessionDto | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const transport = getTransport();
  const timeZone = getTimeZone();

  const loadAll = async (includeArchived = false): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const [g, r, summary, history, m, plans, activeSession] = await Promise.all([
        transport.request<{ items: GoalDto[] }>('GET', `/v1/learning/goals${includeArchived ? '?includeArchived=true' : ''}`).catch(() => ({ items: [] })),
        transport.request<{ items: ReviewItemDto[] }>('GET', '/v1/review-items').catch(() => ({ items: [] })),
        transport.request<ReviewSummaryDto>('GET', `/v1/review-items/summary?timeZone=${encodeURIComponent(timeZone)}`).catch(() => null),
        transport.request<{ items: ReviewItemDto[] }>('GET', '/v1/review-items/history?limit=5').catch(() => ({ items: [] })),
        transport.request<{ items: MistakeItemDto[] }>('GET', '/v1/mistakes?status=all').catch(() => ({ items: [] })),
        transport.request<{ items: LearningPlanDto[] }>('GET', '/v1/learning-plans').catch(() => ({ items: [] })),
        transport.request<PracticeSessionDto>('GET', '/v1/practice/sessions/active').catch(() => null),
      ]);
      goals.value = g.items;
      dueReviews.value = r.items;
      reviewSummary.value = summary;
      completedReviews.value = history.items;
      mistakes.value = m.items;
      learningPlans.value = plans.items;
      activePracticeSession.value = activeSession;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading.value = false;
    }
  };

  const createGoal = async (goal: { topic: string; level?: LearningGoalLevel; availableMinutes?: number }): Promise<void> => {
    await transport.request('POST', '/v1/learning/goals', goal);
    await loadAll();
  };

  const updateGoal = async (goalId: string, update: UpdateLearningGoal): Promise<void> => {
    await transport.request('PATCH', `/v1/learning/goals/${encodeURIComponent(goalId)}`, update);
    await loadAll();
  };

  const archiveGoal = async (goalId: string): Promise<void> => {
    await transport.request('DELETE', `/v1/learning/goals/${encodeURIComponent(goalId)}`);
    await loadAll();
  };

  const startPracticeSession = async (count = 3): Promise<PracticeSessionDto> =>
    transport.request('POST', '/v1/practice/sessions', { count });

  const submitPracticeAnswer = async (sessionId: string, questionId: string, answer: string, idempotencyKey: string, elapsedSeconds?: number, hintsUsed?: number): Promise<{ judgement: string; nextStep: string }> =>
    transport.request('POST', `/v1/questions/${encodeURIComponent(questionId)}/attempts`, { sessionId, answer, timeZone, elapsedSeconds, hintsUsed }, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });

  const completePracticeSession = async (sessionId: string): Promise<PracticeReportDto> =>
    transport.request('POST', `/v1/practice/sessions/${encodeURIComponent(sessionId)}/complete`);

  const completeReview = async (reviewId: string, isCorrect: boolean): Promise<void> => {
    await transport.request('POST', `/v1/review-items/${encodeURIComponent(reviewId)}/complete`, { isCorrect, timeZone });
    await loadAll();
  };

  const generateLearningPlan = async (
    input: { topic: string; level?: 'beginner' | 'intermediate' | 'advanced'; dailyMinutes?: number },
  ): Promise<LearningPlanDto> => {
    const plan = await transport.request<LearningPlanDto>('POST', '/v1/learning-plans/generate', input);
    await loadAll();
    return plan;
  };

  const setPlanTaskStatus = async (taskId: string, status: 'todo' | 'done'): Promise<LearningPlanDto | null> => {
    const plan = await transport
      .request<LearningPlanDto>('PATCH', `/v1/plan-tasks/${encodeURIComponent(taskId)}`, { status })
      .catch(() => null);
    await loadAll();
    return plan;
  };

  const archiveLearningPlan = async (planId: string): Promise<void> => {
    await transport.request('POST', `/v1/learning-plans/${encodeURIComponent(planId)}/archive`);
    await loadAll();
  };

  const setMistakeStatus = async (questionId: string, status: 'active' | 'mastered' | 'dismissed'): Promise<void> => {
    await transport.request('PATCH', `/v1/mistakes/${encodeURIComponent(questionId)}`, { status });
    await loadAll();
  };

  const setMistakeInsight = async (
    questionId: string,
    insight: { reasonCode: MistakeReasonCode | null; note?: string | null },
  ): Promise<void> => {
    await transport.request('PATCH', `/v1/mistakes/${encodeURIComponent(questionId)}`, insight);
    await loadAll();
  };

  const startMistakePractice = async (questionIds: string[]): Promise<PracticeSessionDto> =>
    transport.request('POST', '/v1/mistakes/repractice', { questionIds });

  const submitFeedback = async (subjectType: string, subjectId: string, type: string, note?: string): Promise<void> => {
    await transport.request('POST', '/v1/feedback', { subjectType, subjectId, type, note });
  };

  const trackEvent = async (eventName: string, context?: unknown): Promise<void> => {
    await transport.request('POST', '/v1/analytics/events', { eventName, context }).catch(() => undefined);
  };

  const hasData = computed(() => goals.value.length > 0 || dueReviews.value.length > 0);

  onMounted(() => {
    void loadAll();
  });

  return {
    goals,
    dueReviews,
    completedReviews,
    reviewSummary,
    mistakes,
    learningPlans,
    activePracticeSession,
    loading,
    error,
    hasData,
    loadAll,
    createGoal,
    updateGoal,
    archiveGoal,
    startPracticeSession,
    submitPracticeAnswer,
    completePracticeSession,
    completeReview,
    generateLearningPlan,
    setPlanTaskStatus,
    archiveLearningPlan,
    setMistakeStatus,
    setMistakeInsight,
    startMistakePractice,
    submitFeedback,
    trackEvent,
  };
}
