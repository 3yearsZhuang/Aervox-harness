/**
 * Aervox｜思隅 @aervox/contracts — 练习会话 / 错题本（Learning）Zod 模式
 *
 * 规则依据：docs/reference/SRS.md（FR/BR 原子需求）与追踪基线 CAP-003/004/006。
 * 模式是 OpenAPI 生成与类型派生的事实源；实现见 apps/api/src/modules/learning。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// 必须在任何 schema 创建前调用：zod 4 的 .openapi 只对 extend 之后创建的 schema 生效
extendZodWithOpenApi(z);

/** 作答判定（与服务端判题协议一致） */
export const judgementSchema = z.enum(["correct", "incorrect", "unverifiable"]);

/** 练习/错题 API 暴露的题目项（QuestionModel 的对外视图） */
export const practiceQuestionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  subjectUserId: z.string(),
  sourceArtifactId: z.string().nullable().optional(),
  knowledgeId: z.string().nullable().optional(),
  prompt: z.string(),
  answerSpec: z.unknown(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** POST /v1/practice/sessions 请求体：可选题目数量（3~5，缺省 3） */
export const createPracticeSessionRequestSchema = z.object({
  count: z.number().int().min(3).max(5).optional(),
});

/** 创建练习会话 / 错题重练响应 */
export const createPracticeSessionResponseSchema = z.object({
  sessionId: z.string(),
  items: z.array(practiceQuestionSchema),
});

/** 活跃练习会话的题组快照与恢复进度 */
export const practiceSessionResumeResponseSchema = createPracticeSessionResponseSchema.extend({
  startedAt: z.string(),
  answeredQuestionIds: z.array(z.string()),
  nextQuestionIndex: z.number().int().nonnegative(),
});

/** 练习报告（report / complete 共用） */
export const practiceReportSchema = z.object({
  sessionId: z.string(),
  questionCount: z.number().int(),
  answeredCount: z.number().int(),
  remainingCount: z.number().int(),
  correctCount: z.number().int(),
  incorrectCount: z.number().int(),
  unverifiableCount: z.number().int(),
  accuracy: z.number().nullable(),
  nextStep: z.enum(["review_scheduled", "await_review", "continue"]),
});

/** 错题列表 status 查询参数 */
export const mistakeStatusEnumSchema = z.enum(["active", "mastered", "dismissed", "all"]);

/** 错题本条目（由不可变作答事实派生） */
export const mistakeItemSchema = z.object({
  questionId: z.string(),
  knowledgeId: z.string().nullable(),
  prompt: z.string(),
  latestAnswer: z.string(),
  latestAttemptAt: z.string(),
  wrongCount: z.number().int(),
  masteryState: z.string(),
  status: z.enum(["active", "mastered", "dismissed"]),
});

/** GET /v1/mistakes 响应 */
export const mistakeListResponseSchema = z.object({
  items: z.array(mistakeItemSchema),
});

/** PATCH /v1/mistakes/:questionId 请求体 */
export const updateMistakeRequestSchema = z.object({
  status: z.enum(["active", "mastered", "dismissed"]),
});

/** POST /v1/mistakes/repractice 请求体 */
export const repracticeRequestSchema = z.object({
  questionIds: z.array(z.string()).min(1).max(5).optional(),
});

/** 作答请求体（可关联练习会话，供会话校验；幂等键位于 HTTP Header） */
export const createAttemptRequestSchema = z.object({
  answer: z.string(),
  sessionId: z.string().optional(),
  timeZone: z.string().min(1).optional(),
});

export const reviewItemSchema = z.object({
  id: z.string(),
  knowledgeId: z.string(),
  dueAt: z.string(),
  intervalDays: z.number().int().positive(),
  schedulerVersion: z.number().int().positive(),
  timezoneSnapshot: z.string(),
  status: z.enum(["active", "completed", "dismissed", "archived"]),
});

export const reviewListResponseSchema = z.object({ items: z.array(reviewItemSchema) });
export const reviewHistoryItemSchema = reviewItemSchema.extend({
  completionIsCorrect: z.boolean().nullable(),
  nextReviewId: z.string().nullable(),
  updatedAt: z.string(),
});
export const reviewHistoryResponseSchema = z.object({ items: z.array(reviewHistoryItemSchema) });
export const reviewSummaryResponseSchema = z.object({
  dueCount: z.number().int().nonnegative(),
  overdueCount: z.number().int().nonnegative(),
  dueTodayCount: z.number().int().nonnegative(),
  estimatedMinutes: z.number().int().nonnegative(),
  timeZone: z.string(),
  items: z.array(reviewItemSchema),
});
export const completeReviewRequestSchema = z.object({
  isCorrect: z.boolean(),
  timeZone: z.string().min(1).optional(),
});
export const completeReviewResponseSchema = z.object({
  completed: reviewItemSchema,
  nextReview: reviewItemSchema,
  knowledge: z.object({
    id: z.string(),
    correctCount: z.number().int().nonnegative(),
    wrongCount: z.number().int().nonnegative(),
    correctStreak: z.number().int().nonnegative(),
    mastery: z.number().min(0).max(1),
    masteryState: z.string(),
  }),
});
