/**
 * Aervox｜思隅 @aervox/api-client — API 状态封装
 *
 * 基于统一 Transport 提供学习/复习/日记/通知等数据组合；桌面与 Web 共用一份。
 */
import { computed, onMounted, ref } from 'vue';
import type { LearningGoalLevel, LearningGoalStatus, UpdateLearningGoal } from '@aervox/contracts';
import { getTransport } from './transport';

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
  status: string;
}

export interface PracticeQuestionDto {
  id: string;
  prompt: string;
  knowledgeId?: string | null;
}

export interface PracticeSessionDto {
  sessionId: string;
  items: PracticeQuestionDto[];
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
  nextStep: 'continue' | 'review_scheduled' | 'await_review';
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
}

export interface NotificationDto {
  id: string;
  type: string;
  scheduledAt: string;
  sentAt: string | null;
  channel: string;
  status: string;
}

export interface DiaryDto {
  id: string;
  localDate: string;
  title: string;
  content: string;
  status: string;
}

const todayLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function useAervoxApi() {
  const goals = ref<GoalDto[]>([]);
  const dueReviews = ref<ReviewItemDto[]>([]);
  const mistakes = ref<MistakeItemDto[]>([]);
  const notifications = ref<NotificationDto[]>([]);
  const todayDiary = ref<DiaryDto | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const transport = getTransport();

  const loadAll = async (includeArchived = false): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const [g, r, m, n, d] = await Promise.all([
        transport.request<{ items: GoalDto[] }>('GET', `/v1/learning/goals${includeArchived ? '?includeArchived=true' : ''}`).catch(() => ({ items: [] })),
        transport.request<{ items: ReviewItemDto[] }>('GET', '/v1/review-items').catch(() => ({ items: [] })),
        transport.request<{ items: MistakeItemDto[] }>('GET', '/v1/mistakes?status=all').catch(() => ({ items: [] })),
        transport.request<{ items: NotificationDto[] }>('GET', '/v1/notifications').catch(() => ({ items: [] })),
        transport
          .request<DiaryDto>(`GET`, `/v1/diaries?localDate=${encodeURIComponent(todayLocal())}`)
          .catch(() => null),
      ]);
      goals.value = g.items;
      dueReviews.value = r.items;
      mistakes.value = m.items;
      notifications.value = n.items;
      todayDiary.value = d;
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

  const submitPracticeAnswer = async (sessionId: string, questionId: string, answer: string): Promise<{ judgement: string; nextStep: string }> =>
    transport.request('POST', `/v1/questions/${encodeURIComponent(questionId)}/attempts`, { sessionId, answer });

  const completePracticeSession = async (sessionId: string): Promise<PracticeReportDto> =>
    transport.request('POST', `/v1/practice/sessions/${encodeURIComponent(sessionId)}/complete`);

  const completeReview = async (reviewId: string, isCorrect: boolean): Promise<void> => {
    await transport.request('POST', `/v1/review-items/${encodeURIComponent(reviewId)}/complete`, { isCorrect });
    await loadAll();
  };

  const setMistakeStatus = async (questionId: string, status: 'active' | 'mastered' | 'dismissed'): Promise<void> => {
    await transport.request('PATCH', `/v1/mistakes/${encodeURIComponent(questionId)}`, { status });
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
    mistakes,
    notifications,
    todayDiary,
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
    setMistakeStatus,
    startMistakePractice,
    submitFeedback,
    trackEvent,
  };
}
