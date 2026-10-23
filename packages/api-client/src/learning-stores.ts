import { ref } from 'vue';
import type { LearningGoalLevel, UpdateLearningGoal } from '@aervox/contracts';
import type { AervoxTransport } from './transport.js';
import { createResource } from './resource.js';
import type { GoalStorePort, ReviewStorePort, PracticeStorePort, PlanStorePort, MistakeStorePort, LearningStorePort } from './learning-store-port.js';
import type { GoalDto, LearningPlanDto, MistakeItemDto, MistakeReasonCode, PracticeReportDto, PracticeSessionDto, ReviewItemDto, ReviewSummaryDto } from './learning-types.js';

// A committed mutation stays successful when its projection refresh is offline.
// Each resource retains the refresh error and the last successful value.
const refresh = async (load: () => Promise<void>): Promise<void> => { await Promise.allSettled([load()]); };

export function createGoalStore(transport: AervoxTransport): GoalStorePort & {resource: LearningStorePort['resources']['goals']} {
  const goals = ref<GoalDto[]>([]);
  const resource = createResource(async (includeArchived = false) =>
    (await transport.request<{items: GoalDto[]}>('GET', `/v1/learning/goals${includeArchived ? '?includeArchived=true' : ''}`)).items,
  items => { goals.value = items; });
  return {
    goals, resource, loadGoals: resource.load,
    async createGoal(goal: {topic: string; level?: LearningGoalLevel; availableMinutes?: number}): Promise<void> {
      await transport.request('POST', '/v1/learning/goals', goal);
      await refresh(resource.load);
    },
    async updateGoal(goalId: string, update: UpdateLearningGoal): Promise<void> {
      await transport.request('PATCH', `/v1/learning/goals/${encodeURIComponent(goalId)}`, update);
      await refresh(resource.load);
    },
    async archiveGoal(goalId: string): Promise<void> {
      await transport.request('DELETE', `/v1/learning/goals/${encodeURIComponent(goalId)}`);
      await refresh(resource.load);
    },
  };
}

export function createReviewStore(transport: AervoxTransport, timeZone: string): ReviewStorePort & {resource: LearningStorePort['resources']['reviews']} {
  const dueReviews = ref<ReviewItemDto[]>([]);
  const completedReviews = ref<ReviewItemDto[]>([]);
  const reviewSummary = ref<ReviewSummaryDto | null>(null);
  const resource = createResource(() => Promise.all([
    transport.request<{items: ReviewItemDto[]}>('GET', '/v1/review-items'),
    transport.request<ReviewSummaryDto>('GET', `/v1/review-items/summary?timeZone=${encodeURIComponent(timeZone)}`),
    transport.request<{items: ReviewItemDto[]}>('GET', '/v1/review-items/history?limit=5'),
  ]), ([due, summary, history]) => { dueReviews.value = due.items; reviewSummary.value = summary; completedReviews.value = history.items; });
  return {
    dueReviews, completedReviews, reviewSummary, resource, loadReviews: resource.load,
    async completeReview(reviewId: string, isCorrect: boolean): Promise<void> {
      await transport.request('POST', `/v1/review-items/${encodeURIComponent(reviewId)}/complete`, {isCorrect, timeZone});
      await refresh(resource.load);
    },
  };
}

export function createPracticeStore(transport: AervoxTransport, timeZone: string): PracticeStorePort & {resource: LearningStorePort['resources']['practice']} {
  const activePracticeSession = ref<PracticeSessionDto | null>(null);
  const resource = createResource(() => transport.request<PracticeSessionDto | null>('GET', '/v1/practice/sessions/active'),
    value => { activePracticeSession.value = value; });
  return {
    activePracticeSession, resource, loadPractice: resource.load,
    async startPracticeSession(count = 3): Promise<PracticeSessionDto> {
      const session = await transport.request<PracticeSessionDto>('POST', '/v1/practice/sessions', {count});
      resource.replace(session);
      return session;
    },
    submitPracticeAnswer(sessionId: string, questionId: string, answer: string, idempotencyKey: string, elapsedSeconds?: number, hintsUsed?: number): Promise<{judgement: string; nextStep: string}> {
      return transport.request('POST', `/v1/questions/${encodeURIComponent(questionId)}/attempts`, {sessionId, answer, timeZone, elapsedSeconds, hintsUsed}, {headers: {'Idempotency-Key': idempotencyKey}});
    },
    async completePracticeSession(sessionId: string): Promise<PracticeReportDto> {
      const report = await transport.request<PracticeReportDto>('POST', `/v1/practice/sessions/${encodeURIComponent(sessionId)}/complete`);
      if (activePracticeSession.value?.sessionId === sessionId) resource.replace(null);
      return report;
    },
    async startMistakePractice(questionIds: string[]): Promise<PracticeSessionDto> {
      const session = await transport.request<PracticeSessionDto>('POST', '/v1/mistakes/repractice', {questionIds});
      resource.replace(session);
      return session;
    },
  };
}

export function createPlanStore(transport: AervoxTransport): PlanStorePort & {resource: LearningStorePort['resources']['plans']} {
  const learningPlans = ref<LearningPlanDto[]>([]);
  const resource = createResource(async () => (await transport.request<{items: LearningPlanDto[]}>('GET', '/v1/learning-plans')).items,
    items => { learningPlans.value = items; });
  return {
    learningPlans, resource, loadPlans: resource.load,
    async generateLearningPlan(input: {topic: string; level?: LearningGoalLevel; dailyMinutes?: number}): Promise<LearningPlanDto> {
      const plan = await transport.request<LearningPlanDto>('POST', '/v1/learning-plans/generate', input);
      await refresh(resource.load);
      return plan;
    },
    async setPlanTaskStatus(taskId: string, status: 'todo' | 'done'): Promise<LearningPlanDto> {
      const plan = await transport.request<LearningPlanDto>('PATCH', `/v1/plan-tasks/${encodeURIComponent(taskId)}`, {status});
      await refresh(resource.load);
      return plan;
    },
    async archiveLearningPlan(planId: string): Promise<void> {
      await transport.request('POST', `/v1/learning-plans/${encodeURIComponent(planId)}/archive`);
      await refresh(resource.load);
    },
  };
}

export function createMistakeStore(transport: AervoxTransport): MistakeStorePort & {resource: LearningStorePort['resources']['mistakes']} {
  const mistakes = ref<MistakeItemDto[]>([]);
  const resource = createResource(async () => (await transport.request<{items: MistakeItemDto[]}>('GET', '/v1/mistakes?status=all')).items,
    items => { mistakes.value = items; });
  return {
    mistakes, resource, loadMistakes: resource.load,
    async setMistakeStatus(questionId: string, status: 'active' | 'mastered' | 'dismissed'): Promise<void> {
      await transport.request('PATCH', `/v1/mistakes/${encodeURIComponent(questionId)}`, {status});
      await refresh(resource.load);
    },
    async setMistakeInsight(questionId: string, insight: {reasonCode: MistakeReasonCode | null; note?: string | null}): Promise<void> {
      await transport.request('PATCH', `/v1/mistakes/${encodeURIComponent(questionId)}`, insight);
      await refresh(resource.load);
    },
  };
}
