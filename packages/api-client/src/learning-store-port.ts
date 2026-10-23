import type { Ref } from 'vue';
import type { LearningGoalLevel, UpdateLearningGoal } from '@aervox/contracts';
import type { GoalDto, LearningPlanDto, MistakeItemDto, MistakeReasonCode, PracticeReportDto, PracticeSessionDto, ReviewItemDto, ReviewSummaryDto } from './learning-types.js';

type View<T> = Readonly<Ref<T>>;
export interface ResourceStatePort { readonly loading: View<boolean>; readonly error: View<string | null>; }
export interface GoalStorePort {
  readonly goals: View<GoalDto[]>;
  loadGoals(includeArchived?: boolean): Promise<void>;
  createGoal(goal: {topic: string; level?: LearningGoalLevel; availableMinutes?: number}): Promise<void>;
  updateGoal(goalId: string, update: UpdateLearningGoal): Promise<void>;
  archiveGoal(goalId: string): Promise<void>;
}
export interface ReviewStorePort {
  readonly dueReviews: View<ReviewItemDto[]>;
  readonly completedReviews: View<ReviewItemDto[]>;
  readonly reviewSummary: View<ReviewSummaryDto | null>;
  loadReviews(): Promise<void>;
  completeReview(reviewId: string, isCorrect: boolean): Promise<void>;
}
export interface PracticeStorePort {
  readonly activePracticeSession: View<PracticeSessionDto | null>;
  loadPractice(): Promise<void>;
  startPracticeSession(count?: number): Promise<PracticeSessionDto>;
  submitPracticeAnswer(sessionId: string, questionId: string, answer: string, idempotencyKey: string, elapsedSeconds?: number, hintsUsed?: number): Promise<{judgement: string; nextStep: string}>;
  completePracticeSession(sessionId: string): Promise<PracticeReportDto>;
  startMistakePractice(questionIds: string[]): Promise<PracticeSessionDto>;
}
export interface PlanStorePort {
  readonly learningPlans: View<LearningPlanDto[]>;
  loadPlans(): Promise<void>;
  generateLearningPlan(input: {topic: string; level?: LearningGoalLevel; dailyMinutes?: number}): Promise<LearningPlanDto>;
  setPlanTaskStatus(taskId: string, status: 'todo' | 'done'): Promise<LearningPlanDto>;
  archiveLearningPlan(planId: string): Promise<void>;
}
export interface MistakeStorePort {
  readonly mistakes: View<MistakeItemDto[]>;
  loadMistakes(): Promise<void>;
  setMistakeStatus(questionId: string, status: 'active' | 'mastered' | 'dismissed'): Promise<void>;
  setMistakeInsight(questionId: string, insight: {reasonCode: MistakeReasonCode | null; note?: string | null}): Promise<void>;
}
/** Stable application capabilities, implemented by the Vue resource adapter. */
export interface LearningStorePort extends GoalStorePort, ReviewStorePort, PracticeStorePort, PlanStorePort, MistakeStorePort {
  readonly loading: View<boolean>;
  readonly error: View<string | null>;
  readonly hasData: View<boolean>;
  readonly resources: {
    goals: ResourceStatePort & {load(includeArchived?: boolean): Promise<void>};
    reviews: ResourceStatePort & {load(): Promise<void>};
    mistakes: ResourceStatePort & {load(): Promise<void>};
    plans: ResourceStatePort & {load(): Promise<void>};
    practice: ResourceStatePort & {load(): Promise<void>};
  };
  submitFeedback(subjectType: string, subjectId: string, type: string, note?: string): Promise<void>;
  trackEvent(eventName: string, context?: unknown): Promise<void>;
}
