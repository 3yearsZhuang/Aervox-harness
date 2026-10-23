/** Network shapes are derived from the shared response schemas. */
import type {
  learningGoalResponseSchema, reviewItemSchema, reviewHistoryItemSchema, reviewSummaryResponseSchema,
  practiceQuestionSchema, createPracticeSessionResponseSchema, practiceSessionResumeResponseSchema,
  practiceReportSchema, mistakeItemSchema, mistakeReasonCodeSchema,
  planTaskResponseSchema, planMilestoneResponseSchema, learningPlanResponseSchema,
} from '@aervox/contracts';
export type GoalDto = typeof learningGoalResponseSchema['_output'];
export type ReviewItemDto = typeof reviewItemSchema['_output'] & Partial<typeof reviewHistoryItemSchema['_output']>;
export type ReviewSummaryDto = typeof reviewSummaryResponseSchema['_output'];
export type PracticeQuestionDto = typeof practiceQuestionSchema['_output'];
export type PracticeSessionDto = typeof createPracticeSessionResponseSchema['_output'] & Partial<typeof practiceSessionResumeResponseSchema['_output']>;
export type PracticeReportDto = typeof practiceReportSchema['_output'];
export type PlanTaskDto = typeof planTaskResponseSchema['_output'];
export type PlanMilestoneDto = typeof planMilestoneResponseSchema['_output'];
export type LearningPlanDto = typeof learningPlanResponseSchema['_output'];
export type MistakeItemDto = typeof mistakeItemSchema['_output'];
export type MistakeReasonCode = typeof mistakeReasonCodeSchema['_output'];
