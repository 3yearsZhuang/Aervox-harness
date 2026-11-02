/** The learning surface on the phone over the local SQLite business truth:
 * goals, questions, practice sessions, answers, mistakes, reviews and plans.
 * Desktop routes in host-runtime's learning module remain the semantic
 * reference; judgement, scheduling and report assembly come from
 * @aervox/practice-review so outcomes cannot drift between hosts. Answer and
 * review replays keep the repository's receipt discipline: a mismatching
 * replay is a 409, never a second write. Plan generation needs the host LLM
 * assembly and stays honestly disconnected until it is wired to the native
 * model bridge.
 */
import { AervoxHttpError } from '@aervox/api-client';
import {
  createLearningGoalSchema,
  generateLearningPlanSchema,
  updateLearningGoalSchema,
  updateMistakeRequestSchema,
  updatePlanTaskStatusSchema,
} from '@aervox/contracts';
import {
  buildPracticeReport,
  deriveAnswerOutcome,
  deriveMilestoneStatuses,
  getLocalDayBounds,
  getPracticeSessionProgress,
  judgeAnswer,
  normalizeMistakeNote,
} from '@aervox/practice-review';
import {
  canonicalAnswerRequest,
  type ILearningRepository,
  type LearningAnswerCommand,
  type LearningAnswerPolicy,
  type LocalContext,
} from '@aervox/repositories/learning';

const ESTIMATED_MINUTES_PER_REVIEW = 2;
const fail = (status: number, code: string): never => { throw new AervoxHttpError(status, 'native', { code, message: code }); };
const validTimeZone = (value: string): boolean => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
};
let seq = 0;
const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;
const answerPolicy: LearningAnswerPolicy = { judge: judgeAnswer, derive: deriveAnswerOutcome };

type LearningRepoPort = Pick<ILearningRepository,
  | 'listDueReviewItems' | 'listCompletedReviewItems' | 'completeReviewAndSchedule'
  | 'createLearningGoal' | 'createLearningGoalIdempotent' | 'getLearningGoal' | 'listLearningGoals' | 'updateLearningGoal'
  | 'createQuestion' | 'getQuestion' | 'listActiveQuestions' | 'listAttemptsByQuestion' | 'listAttemptsBySession'
  | 'createPracticeSession' | 'getPracticeSession' | 'getLatestActivePracticeSession' | 'completePracticeSession'
  | 'listPracticeAnswerOutcomes' | 'recordAnswer'
  | 'listMistakes' | 'setMistakeDisposition' | 'setMistakeInsight' | 'clearMistakeInsight' | 'updateMastery'
  | 'getKnowledgeItem'
  | 'listLearningPlans' | 'getLearningPlan' | 'transitionPlanTask' | 'archiveLearningPlan'>;

export interface LearningRouteDeps {
  repo: LearningRepoPort;
  ctx: LocalContext;
  /** SHA-256 hex over the stable JSON of a canonical answer request. */
  digestRequest: (value: unknown) => string;
}

export type LearningRouteResult = { handled: true; result: unknown } | { handled: false };
export interface LearningRouteOptions { headers?: Record<string, string> }

const headerValue = (options: LearningRouteOptions | undefined, name: string): string | undefined => {
  const headers = options?.headers;
  if (!headers) return undefined;
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined;
};
const identifier = (value: string) => {
  if (!value || value.length > 128 || value.includes('\0')) return fail(400, 'INVALID_IDENTIFIER');
  return value;
};

export function createLearningRouteHandler({ repo, ctx, digestRequest }: LearningRouteDeps) {
  const practiceSessionResumePayload = async (session: { id: string; questionIds: string[]; startedAt: string }) => {
    const items = await Promise.all(session.questionIds.map(questionId => repo.getQuestion(ctx, questionId)));
    if (items.some(item => !item)) return null;
    const attempts = await repo.listAttemptsBySession(ctx, session.id);
    const { answeredQuestionIds, nextQuestionIndex } = getPracticeSessionProgress(session.questionIds, attempts);
    return { sessionId: session.id, items, startedAt: session.startedAt, answeredQuestionIds, nextQuestionIndex };
  };

  return async function handleLearningRoute(
    method: string, url: URL, body: unknown, options?: LearningRouteOptions,
  ): Promise<LearningRouteResult> {
    const path = url.pathname;
    const payload = (body ?? {}) as Record<string, unknown>;

    // ── 学习目标 ────────────────────────────────────────────────
    if (path === '/v1/learning/goals' && method === 'GET') {
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      return { handled: true, result: { items: await repo.listLearningGoals(ctx, includeArchived) } };
    }
    const goal = /^\/v1\/learning\/goals\/([^/]+)$/.exec(path);
    if (goal && method === 'GET') {
      const found = await repo.getLearningGoal(ctx, identifier(decodeURIComponent(goal[1]!)));
      if (!found) return fail(404, 'GOAL_NOT_FOUND');
      return { handled: true, result: found };
    }
    if (path === '/v1/learning/goals' && method === 'POST') {
      const parsed = createLearningGoalSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_GOAL');
      const idempotencyKey = headerValue(options, 'Idempotency-Key');
      if (idempotencyKey) {
        const result = await repo.createLearningGoalIdempotent(ctx,
          { id: id('goal'), topic: parsed.data.topic, level: parsed.data.level, availableMinutes: parsed.data.availableMinutes, idempotencyKey });
        return { handled: true, result: result.goal };
      }
      return { handled: true, result: await repo.createLearningGoal(ctx,
        { id: id('goal'), topic: parsed.data.topic, level: parsed.data.level, availableMinutes: parsed.data.availableMinutes }) };
    }
    if (goal && method === 'PATCH') {
      const parsed = updateLearningGoalSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_GOAL');
      const goalId = identifier(decodeURIComponent(goal[1]!));
      const existing = await repo.getLearningGoal(ctx, goalId);
      if (!existing || existing.status === 'archived') return fail(404, 'GOAL_NOT_FOUND');
      return { handled: true, result: await repo.updateLearningGoal(ctx, goalId, parsed.data) };
    }
    if (goal && method === 'DELETE') {
      const goalId = identifier(decodeURIComponent(goal[1]!));
      const existing = await repo.getLearningGoal(ctx, goalId);
      if (!existing || existing.status === 'archived') return fail(404, 'GOAL_NOT_FOUND');
      await repo.updateLearningGoal(ctx, goalId, { status: 'archived' });
      return { handled: true, result: undefined };
    }

    // ── 题目与作答 ──────────────────────────────────────────────
    if (path === '/v1/questions' && method === 'POST') {
      const prompt = payload.prompt;
      if (typeof prompt !== 'string' || !prompt) return fail(400, 'QUESTION_PROMPT_REQUIRED');
      if (typeof payload.knowledgeId === 'string' && payload.knowledgeId
        && !await repo.getKnowledgeItem(ctx, payload.knowledgeId)) return fail(400, 'KNOWLEDGE_ITEM_NOT_FOUND');
      return { handled: true, result: await repo.createQuestion(ctx, {
        id: id('q'), prompt, answerSpec: payload.answerSpec ?? {},
        sourceArtifactId: payload.sourceArtifactId as string | null | undefined,
        knowledgeId: payload.knowledgeId as string | null | undefined,
      }) };
    }
    const questionAttempts = /^\/v1\/questions\/([^/]+)\/attempts$/.exec(path);
    const question = /^\/v1\/questions\/([^/]+)$/.exec(path);
    if (questionAttempts && method === 'GET') {
      return { handled: true, result: { items: await repo.listAttemptsByQuestion(ctx, identifier(decodeURIComponent(questionAttempts[1]!))) } };
    }
    if (questionAttempts && method === 'POST') {
      const questionId = identifier(decodeURIComponent(questionAttempts[1]!));
      const answer = payload.answer;
      if (typeof answer !== 'string' || !answer) return fail(400, 'ANSWER_REQUIRED');
      if (payload.timeZone !== undefined
        && (typeof payload.timeZone !== 'string' || !validTimeZone(payload.timeZone))) return fail(400, 'INVALID_TIME_ZONE');
      const elapsedSeconds = typeof payload.elapsedSeconds === 'number' && Number.isInteger(payload.elapsedSeconds) && payload.elapsedSeconds >= 0
        ? payload.elapsedSeconds
        : payload.elapsedSeconds === undefined ? undefined : null;
      const hintsUsed = typeof payload.hintsUsed === 'number' && Number.isInteger(payload.hintsUsed) && payload.hintsUsed >= 0
        ? payload.hintsUsed
        : payload.hintsUsed === undefined ? undefined : null;
      if (elapsedSeconds === null) return fail(400, 'INVALID_ELAPSED_SECONDS');
      if (hintsUsed === null) return fail(400, 'INVALID_HINTS_USED');
      const idempotencyKey = headerValue(options, 'Idempotency-Key');
      const command: LearningAnswerCommand = {
        kind: 'existing-question', questionId, answer,
        ...(typeof payload.sessionId === 'string' ? { sessionId: payload.sessionId } : {}),
        ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
        ...(typeof payload.timeZone === 'string' ? { timeZone: payload.timeZone } : {}),
        ...(hintsUsed !== undefined ? { hintCount: hintsUsed } : {}),
        ...(elapsedSeconds !== undefined ? { timeSpentSec: elapsedSeconds } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      try {
        const { attempt, nextStep } = await repo.recordAnswer(ctx,
          { ...command, requestDigest: digestRequest(canonicalAnswerRequest(command)) }, answerPolicy);
        return { handled: true, result: { ...attempt, nextStep } };
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'question_not_found') return fail(404, 'QUESTION_NOT_FOUND');
        if (message === 'practice_session_not_active') return fail(409, 'PRACTICE_SESSION_NOT_ACTIVE');
        if (message === 'question_not_in_practice_session') return fail(400, 'QUESTION_NOT_IN_PRACTICE_SESSION');
        if (message === 'idempotency_key_reused') return fail(409, 'IDEMPOTENCY_KEY_REUSED');
        if (message === 'answer_receipt_unavailable') return fail(409, 'ANSWER_RECEIPT_UNAVAILABLE');
        throw error;
      }
    }
    if (question && method === 'GET') {
      const found = await repo.getQuestion(ctx, identifier(decodeURIComponent(question[1]!)));
      if (!found) return fail(404, 'QUESTION_NOT_FOUND');
      return { handled: true, result: found };
    }

    // ── 练习会话 ────────────────────────────────────────────────
    if (path === '/v1/practice/questions' && method === 'GET') {
      const raw = url.searchParams.get('count');
      const count = raw === null ? 3 : Number(raw);
      if (!Number.isInteger(count) || count < 3 || count > 5) return fail(400, 'INVALID_PRACTICE_COUNT');
      return { handled: true, result: { items: await repo.listActiveQuestions(ctx, count) } };
    }
    if (path === '/v1/practice/sessions' && method === 'POST') {
      const countValue = payload.count ?? 3;
      if (typeof countValue !== 'number' || !Number.isInteger(countValue) || countValue < 3 || countValue > 5) {
        return fail(400, 'INVALID_PRACTICE_COUNT');
      }
      const activeSession = await repo.getLatestActivePracticeSession(ctx);
      if (activeSession) {
        const resumed = await practiceSessionResumePayload(activeSession);
        if (!resumed) return fail(409, 'PRACTICE_QUESTION_UNAVAILABLE');
        return { handled: true, result: resumed };
      }
      const items = await repo.listActiveQuestions(ctx, countValue);
      if (items.length < countValue) return fail(409, 'PRACTICE_NOT_ENOUGH_QUESTIONS');
      const session = await repo.createPracticeSession(ctx,
        { id: id('practice'), questionCount: items.length, questionIds: items.map(item => item.id) });
      return { handled: true, result: { sessionId: session.id, items, startedAt: session.startedAt, answeredQuestionIds: [], nextQuestionIndex: 0 } };
    }
    if (path === '/v1/practice/sessions/active' && method === 'GET') {
      const session = await repo.getLatestActivePracticeSession(ctx);
      if (!session) return fail(404, 'PRACTICE_SESSION_NOT_FOUND');
      const resumed = await practiceSessionResumePayload(session);
      if (!resumed) return fail(409, 'PRACTICE_QUESTION_UNAVAILABLE');
      return { handled: true, result: resumed };
    }
    const practiceReport = /^\/v1\/practice\/sessions\/([^/]+)\/report$/.exec(path);
    const practiceComplete = /^\/v1\/practice\/sessions\/([^/]+)\/complete$/.exec(path);
    if (practiceReport && method === 'GET') {
      const sessionId = identifier(decodeURIComponent(practiceReport[1]!));
      const session = await repo.getPracticeSession(ctx, sessionId);
      if (!session) return fail(404, 'PRACTICE_SESSION_NOT_FOUND');
      return { handled: true, result: buildPracticeReport(sessionId, await repo.listPracticeAnswerOutcomes(ctx, sessionId), session.questionCount) };
    }
    if (practiceComplete && method === 'POST') {
      const sessionId = identifier(decodeURIComponent(practiceComplete[1]!));
      const session = await repo.completePracticeSession(ctx, sessionId);
      if (!session) return fail(404, 'PRACTICE_SESSION_NOT_FOUND');
      return { handled: true, result: buildPracticeReport(sessionId, await repo.listPracticeAnswerOutcomes(ctx, sessionId), session.questionCount) };
    }

    // ── 错题本 ──────────────────────────────────────────────────
    if (path === '/v1/mistakes/repractice' && method === 'POST') {
      const requested = payload.questionIds;
      if (requested !== undefined && (!Array.isArray(requested) || requested.some(value => typeof value !== 'string'))) {
        return fail(400, 'INVALID_QUESTION_IDS');
      }
      const activeSession = await repo.getLatestActivePracticeSession(ctx);
      if (activeSession) {
        const resumed = await practiceSessionResumePayload(activeSession);
        if (!resumed) return fail(409, 'PRACTICE_QUESTION_UNAVAILABLE');
        return { handled: true, result: resumed };
      }
      const activeMistakes = await repo.listMistakes(ctx, 'active');
      const available = new Map(activeMistakes.map(item => [item.questionId, item]));
      const questionIds = (requested as string[] | undefined) ?? activeMistakes.slice(0, 5).map(item => item.questionId);
      const uniqueQuestionIds = [...new Set(questionIds)];
      if (uniqueQuestionIds.length < 1 || uniqueQuestionIds.length > 5) return fail(400, 'INVALID_QUESTION_IDS');
      if (uniqueQuestionIds.some(questionId => !available.has(questionId))) return fail(400, 'INVALID_QUESTION_IDS');
      const items = await Promise.all(uniqueQuestionIds.map(questionId => repo.getQuestion(ctx, questionId)));
      if (items.some(item => !item)) return fail(409, 'MISTAKE_QUESTION_UNAVAILABLE');
      const session = await repo.createPracticeSession(ctx,
        { id: id('practice'), questionCount: uniqueQuestionIds.length, questionIds: uniqueQuestionIds });
      return { handled: true, result: { sessionId: session.id, items } };
    }
    if (path === '/v1/mistakes' && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'active';
      if (!['active', 'mastered', 'dismissed', 'all'].includes(status)) return fail(400, 'INVALID_MISTAKE_FILTER');
      const reasonCode = url.searchParams.get('reasonCode');
      if (reasonCode !== null && !['concept_gap', 'calculation', 'careless', 'misread', 'other'].includes(reasonCode)) {
        return fail(400, 'INVALID_MISTAKE_FILTER');
      }
      let items = await repo.listMistakes(ctx, status as 'active' | 'mastered' | 'dismissed' | 'all');
      const knowledgeId = url.searchParams.get('knowledgeId');
      if (knowledgeId) items = items.filter(item => item.knowledgeId === knowledgeId);
      const minWrongCount = url.searchParams.get('minWrongCount');
      if (minWrongCount) {
        const min = Number(minWrongCount);
        if (Number.isInteger(min) && min > 0) items = items.filter(item => item.wrongCount >= min);
      }
      if (url.searchParams.get('sortBy') === 'frequent') items = [...items].sort((a, b) => b.wrongCount - a.wrongCount);
      if (reasonCode !== null) items = items.filter(item => item.reasonCode === reasonCode);
      return { handled: true, result: { items } };
    }
    const mistake = /^\/v1\/mistakes\/([^/]+)$/.exec(path);
    if (mistake && method === 'PATCH') {
      const questionId = identifier(decodeURIComponent(mistake[1]!));
      const parsed = updateMistakeRequestSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_MISTAKE_UPDATE');
      const update = parsed.data;
      const mistakeItem = (await repo.listMistakes(ctx, 'all')).find(item => item.questionId === questionId);
      if (!mistakeItem) return fail(404, 'MISTAKE_NOT_FOUND');
      if (update.reasonCode !== undefined) {
        if (update.reasonCode === null) await repo.clearMistakeInsight(ctx, questionId);
        else await repo.setMistakeInsight(ctx,
          { id: id('mistake_insight'), questionId, reasonCode: update.reasonCode, note: normalizeMistakeNote(update.note) });
      }
      const refreshed = (await repo.listMistakes(ctx, 'all')).find(item => item.questionId === questionId) ?? mistakeItem;
      if (update.status === undefined) return { handled: true, result: refreshed };
      if (update.status === 'dismissed' || (update.status === 'active' && mistakeItem.status === 'dismissed')) {
        await repo.setMistakeDisposition(ctx, { id: id('mistake_disposition'), questionId, status: update.status });
        return { handled: true, result: { ...refreshed, status: update.status } };
      }
      if (!mistakeItem.knowledgeId) return fail(409, 'MISTAKE_NO_KNOWLEDGE');
      const updated = await repo.updateMastery(ctx, mistakeItem.knowledgeId,
        update.status === 'mastered' ? 'mastered' : 'learning',
        { source: 'user', action: update.status === 'mastered' ? 'mark_mastered' : 'resume_learning' });
      return { handled: true, result: { ...refreshed, masteryState: updated?.masteryState, status: update.status } };
    }

    // ── 知识点与复习项 ──────────────────────────────────────────
    const knowledge = /^\/v1\/knowledge-items\/([^/]+)$/.exec(path);
    if (knowledge && method === 'GET') {
      const item = await repo.getKnowledgeItem(ctx, identifier(decodeURIComponent(knowledge[1]!)));
      if (!item) return fail(404, 'KNOWLEDGE_ITEM_NOT_FOUND');
      return { handled: true, result: item };
    }
    const reviewComplete = /^\/v1\/review-items\/([^/]+)\/complete$/.exec(path);
    if (path === '/v1/review-items' && method === 'GET') {
      const dueBefore = url.searchParams.get('dueBefore') ?? new Date().toISOString();
      return { handled: true, result: { items: await repo.listDueReviewItems(ctx, dueBefore) } };
    }
    if (path === '/v1/review-items/summary' && method === 'GET') {
      const now = new Date();
      const dueBefore = url.searchParams.get('dueBefore') ?? now.toISOString();
      const timeZone = url.searchParams.get('timeZone') ?? 'UTC';
      if (Number.isNaN(Date.parse(dueBefore))) return fail(400, 'INVALID_DUE_BEFORE');
      if (!validTimeZone(timeZone)) return fail(400, 'INVALID_TIME_ZONE');
      const items = await repo.listDueReviewItems(ctx, dueBefore);
      const { start } = getLocalDayBounds(now, timeZone);
      const overdueCount = items.filter(item => Date.parse(item.dueAt) < start.getTime()).length;
      return { handled: true, result: {
        dueCount: items.length,
        overdueCount,
        dueTodayCount: items.length - overdueCount,
        estimatedMinutes: items.length * ESTIMATED_MINUTES_PER_REVIEW,
        timeZone,
        items,
      } };
    }
    if (path === '/v1/review-items/history' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 10 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(400, 'INVALID_REVIEW_LIMIT');
      return { handled: true, result: { items: await repo.listCompletedReviewItems(ctx, limit) } };
    }
    if (reviewComplete && method === 'POST') {
      const reviewId = identifier(decodeURIComponent(reviewComplete[1]!));
      if (typeof payload.isCorrect !== 'boolean') return fail(400, 'INVALID_REVIEW_COMPLETION');
      if (payload.timeZone !== undefined
        && (typeof payload.timeZone !== 'string' || !validTimeZone(payload.timeZone))) return fail(400, 'INVALID_TIME_ZONE');
      try {
        const result = await repo.completeReviewAndSchedule(ctx,
          { reviewId, isCorrect: payload.isCorrect, ...(typeof payload.timeZone === 'string' ? { timeZone: payload.timeZone } : {}) },
          deriveAnswerOutcome);
        if (!result) return fail(404, 'REVIEW_NOT_FOUND');
        return { handled: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message === 'review_completion_payload_mismatch') return fail(409, 'REVIEW_COMPLETION_PAYLOAD_MISMATCH');
        if (message === 'review_completion_receipt_unavailable') return fail(409, 'REVIEW_COMPLETION_RECEIPT_UNAVAILABLE');
        throw error;
      }
    }

    // ── 学习计划 ────────────────────────────────────────────────
    if (path === '/v1/learning-plans/generate' && method === 'POST') {
      const parsed = generateLearningPlanSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_PLAN_REQUEST');
      return fail(501, 'PLAN_GENERATION_NOT_CONNECTED');
    }
    if (path === '/v1/learning-plans' && method === 'GET') {
      const includeArchived = url.searchParams.get('includeArchived') === 'true';
      return { handled: true, result: { items: await repo.listLearningPlans(ctx, includeArchived) } };
    }
    const planArchive = /^\/v1\/learning-plans\/([^/]+)\/archive$/.exec(path);
    const plan = /^\/v1\/learning-plans\/([^/]+)$/.exec(path);
    if (planArchive && method === 'POST') {
      const archived = await repo.archiveLearningPlan(ctx, identifier(decodeURIComponent(planArchive[1]!)));
      if (!archived) return fail(404, 'PLAN_NOT_FOUND');
      return { handled: true, result: archived };
    }
    if (plan && method === 'GET') {
      const found = await repo.getLearningPlan(ctx, identifier(decodeURIComponent(plan[1]!)));
      if (!found) return fail(404, 'PLAN_NOT_FOUND');
      return { handled: true, result: found };
    }
    const planTask = /^\/v1\/plan-tasks\/([^/]+)$/.exec(path);
    if (planTask && method === 'PATCH') {
      const parsed = updatePlanTaskStatusSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_PLAN_TASK');
      const planResult = await repo.transitionPlanTask(ctx,
        identifier(decodeURIComponent(planTask[1]!)), parsed.data.status, deriveMilestoneStatuses);
      if (!planResult) return fail(404, 'TASK_NOT_FOUND');
      return { handled: true, result: planResult };
    }

    return { handled: false };
  };
}
