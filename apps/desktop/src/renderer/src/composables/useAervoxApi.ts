import {computed, onMounted, ref} from 'vue'

/**
 * Aervox｜思隅 @aervox/desktop — API 桥接封装
 *
 * 通过 preload 暴露的 apiRequest 调后端用户侧路由（学习/日记/通知/同意/反馈/埋点）。
 * 未注入桥时回退到直连 fetch（开发预览环境）。
 */

export interface GoalDto {
  id: string
  topic: string
  level: string
  availableMinutes: number
  status: string
}

export interface ReviewItemDto {
  id: string
  knowledgeId: string
  dueAt: string
  intervalDays: number
  status: string
}

export interface NotificationDto {
  id: string
  type: string
  scheduledAt: string
  sentAt: string | null
  channel: string
  status: string
}

export interface DiaryDto {
  id: string
  localDate: string
  title: string
  content: string
  status: string
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (window.fairyDesktop?.apiRequest) {
    const res = await window.fairyDesktop.apiRequest<T>(method, path, body)
    if (!res.ok) throw new Error(`API ${method} ${path} → HTTP ${res.status}: ${res.text}`)
    return res.json as T
  }
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:3000'
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`API ${method} ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

const todayLocal = (): string => {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function useAervoxApi() {
  const goals = ref<GoalDto[]>([])
  const dueReviews = ref<ReviewItemDto[]>([])
  const notifications = ref<NotificationDto[]>([])
  const todayDiary = ref<DiaryDto | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const loadAll = async (): Promise<void> => {
    loading.value = true
    error.value = null
    try {
      const [g, r, n, d] = await Promise.all([
        request<{items: GoalDto[]}>('GET', '/v1/learning/goals').catch(() => ({items: []})),
        request<{items: ReviewItemDto[]}>('GET', '/v1/review-items').catch(() => ({items: []})),
        request<{items: NotificationDto[]}>('GET', '/v1/notifications').catch(() => ({items: []})),
        request<DiaryDto>('GET', `/v1/diaries?localDate=${encodeURIComponent(todayLocal())}`).catch(() => null),
      ])
      goals.value = g.items
      dueReviews.value = r.items
      notifications.value = n.items
      todayDiary.value = d
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载失败'
    } finally {
      loading.value = false
    }
  }

  const createGoal = async (topic: string): Promise<void> => {
    await request('POST', '/v1/learning/goals', {topic})
    await loadAll()
  }

  const submitFeedback = async (subjectType: string, subjectId: string, type: string, note?: string): Promise<void> => {
    await request('POST', '/v1/feedback', {subjectType, subjectId, type, note})
  }

  const trackEvent = async (eventName: string, context?: unknown): Promise<void> => {
    await request('POST', '/v1/analytics/events', {eventName, context}).catch(() => undefined)
  }

  onMounted(() => {
    void loadAll()
  })

  return {
    goals,
    dueReviews,
    notifications,
    todayDiary,
    loading,
    error,
    loadAll,
    createGoal,
    submitFeedback,
    trackEvent,
  }
}

// 导出类型用于模板
export type {DiaryDto}
