import { getClientTransport, useAervoxClient } from './client-context.js';
/** Composition of independent, lazy learning resources for the workbench. */
import { computed } from 'vue';

import { useAervoxFeedback } from './useAervoxFeedback';
import { createGoalStore, createReviewStore, createPracticeStore, createPlanStore, createMistakeStore } from './learning-stores.js';
import type { LearningStorePort } from './learning-store-port.js';

export type * from './learning-types.js';

export function useAervoxApi(): LearningStorePort {
  const transport = getClientTransport();
  const timeZone = useAervoxClient().timeZone;
  const feedback = useAervoxFeedback(transport);
  const {resource: goals, ...goalStore} = createGoalStore(transport);
  const {resource: reviews, ...reviewStore} = createReviewStore(transport, timeZone);
  const {resource: practice, ...practiceStore} = createPracticeStore(transport, timeZone);
  const {resource: plans, ...planStore} = createPlanStore(transport);
  const {resource: mistakes, ...mistakeStore} = createMistakeStore(transport);
  const resources = {goals, reviews, practice, plans, mistakes};
  return {
    ...goalStore, ...reviewStore, ...practiceStore, ...planStore, ...mistakeStore,
    resources,
    loading: computed(() => Object.values(resources).some(resource => resource.loading.value)),
    error: computed(() => Object.values(resources).map(resource => resource.error.value).filter(Boolean).join('；') || null),
    hasData: computed(() => goalStore.goals.value.length > 0 || reviewStore.dueReviews.value.length > 0),
    async submitFeedback(subjectType: string, subjectId: string, type: string, note?: string): Promise<void> {
      await feedback.createFeedback({subjectType, subjectId, type, note});
    },
    async trackEvent(eventName: string, context?: unknown): Promise<void> {
      await transport.request('POST', '/v1/analytics/events', {eventName, context}).catch(() => undefined);
    },
  };
}
