/**
 * Aervox｜思隅 @aervox/web — API 状态封装（移植自 desktop `useAervoxApi`，浏览器直连）
 */
import { computed, onMounted, ref } from 'vue';
import { http } from '../api/request';

export interface GoalDto {
  id: string;
  topic: string;
  level: string;
  availableMinutes: number;
  status: string;
}

export interface ReviewItemDto {
  id: string;
  knowledgeId: string;
  dueAt: string;
  intervalDays: number;
  status: string;
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
  const notifications = ref<NotificationDto[]>([]);
  const todayDiary = ref<DiaryDto | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadAll = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const [g, r, n, d] = await Promise.all([
        http.get<{ items: GoalDto[] }>('/v1/learning/goals').catch(() => ({ items: [] })),
        http.get<{ items: ReviewItemDto[] }>('/v1/review-items').catch(() => ({ items: [] })),
        http.get<{ items: NotificationDto[] }>('/v1/notifications').catch(() => ({ items: [] })),
        http
          .get<DiaryDto>(`/v1/diaries?localDate=${encodeURIComponent(todayLocal())}`)
          .catch(() => null),
      ]);
      goals.value = g.items;
      dueReviews.value = r.items;
      notifications.value = n.items;
      todayDiary.value = d;
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载失败';
    } finally {
      loading.value = false;
    }
  };

  const createGoal = async (topic: string): Promise<void> => {
    await http.post('/v1/learning/goals', { topic });
    await loadAll();
  };

  const submitFeedback = async (subjectType: string, subjectId: string, type: string, note?: string): Promise<void> => {
    await http.post('/v1/feedback', { subjectType, subjectId, type, note });
  };

  const trackEvent = async (eventName: string, context?: unknown): Promise<void> => {
    await http.post('/v1/analytics/events', { eventName, context }).catch(() => undefined);
  };

  const hasData = computed(() => goals.value.length > 0 || dueReviews.value.length > 0);

  onMounted(() => {
    void loadAll();
  });

  return {
    goals,
    dueReviews,
    notifications,
    todayDiary,
    loading,
    error,
    hasData,
    loadAll,
    createGoal,
    submitFeedback,
    trackEvent,
  };
}