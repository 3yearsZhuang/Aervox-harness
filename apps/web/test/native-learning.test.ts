import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAnswerOutcome, deriveMilestoneStatuses } from '@aervox/practice-review';
import type { LearningAnswerPolicy, LocalContext } from '@aervox/repositories/learning';
import { createLearningRouteHandler, type LearningRouteDeps } from '../src/mobile/native-learning';

const ctx: LocalContext = { workspaceId: 'local', subjectUserId: 'local' };

function stubRepo(overrides: Record<string, unknown> = {}) {
  return {
    listDueReviewItems: vi.fn(async () => []),
    listCompletedReviewItems: vi.fn(async () => []),
    completeReviewAndSchedule: vi.fn(async () => null),
    createLearningGoal: vi.fn(async () => ({ id: 'goal_1' })),
    createLearningGoalIdempotent: vi.fn(async () => ({ goal: { id: 'goal_1' }, created: true })),
    getLearningGoal: vi.fn(async () => ({ id: 'goal_1', status: 'active' })),
    listLearningGoals: vi.fn(async () => []),
    updateLearningGoal: vi.fn(async () => ({ id: 'goal_1' })),
    createQuestion: vi.fn(async () => ({ id: 'q_1' })),
    getQuestion: vi.fn(async () => ({ id: 'q_1', answerSpec: { answer: '4' } })),
    listActiveQuestions: vi.fn(async () => []),
    listAttemptsByQuestion: vi.fn(async () => []),
    listAttemptsBySession: vi.fn(async () => []),
    createPracticeSession: vi.fn(async () => ({ id: 'practice_1', startedAt: '2026-11-01T00:00:00.000Z' })),
    getPracticeSession: vi.fn(async () => null),
    getLatestActivePracticeSession: vi.fn(async () => null),
    completePracticeSession: vi.fn(async () => null),
    listPracticeAnswerOutcomes: vi.fn(async () => []),
    recordAnswer: vi.fn(async () => ({ attempt: { id: 'att_1', judgement: 'correct' }, nextStep: 'continue', created: true })),
    listMistakes: vi.fn(async () => []),
    setMistakeDisposition: vi.fn(async () => {}),
    setMistakeInsight: vi.fn(async () => {}),
    clearMistakeInsight: vi.fn(async () => {}),
    updateMastery: vi.fn(async () => ({ masteryState: 'mastered' })),
    getKnowledgeItem: vi.fn(async () => null),
    listLearningPlans: vi.fn(async () => []),
    getLearningPlan: vi.fn(async () => null),
    transitionPlanTask: vi.fn(async () => null),
    archiveLearningPlan: vi.fn(async () => null),
    createLearningPlan: vi.fn(async () => ({ id: 'plan_1', milestones: [] })),
    ...overrides,
  } as unknown as LearningRouteDeps['repo'];
}

const digestRequest = vi.fn(() => 'a'.repeat(64));
const planOutput = {
  title: '高数项目式学习', description: '围绕高数的项目式学习路线', learningObjective: '建立高数框架',
  gains: ['收获一', '收获二', '收获三'],
  milestones: [
    { title: '阶段一', description: '准备', briefing: 'b', completionCriteria: 'c', debrief: 'd',
      tasks: [{ title: '任务一', description: 'x', hints: ['h'] }, { title: '任务二' }] },
    { title: '阶段二：整合收尾', description: '整合', briefing: 'b', completionCriteria: 'c', debrief: 'd',
      tasks: [{ title: '任务三' }, { title: '任务四' }] },
  ],
};
const generateText = vi.fn(async () => JSON.stringify(planOutput));
const makeHandler = (repo: Record<string, unknown> = {}, model = generateText) =>
  createLearningRouteHandler({ repo: stubRepo(repo), ctx, digestRequest, generateText: model });
const route = (path: string) => new URL(path, 'https://localhost');

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('native learning routes', () => {
  it('returns due items and forwards an explicit dueBefore', async () => {
    const repo = stubRepo({ listDueReviewItems: vi.fn(async () => [{ id: 'review_1' }]) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    const result = await handle('GET', route('/v1/review-items?dueBefore=2026-11-02T00:00:00.000Z'), undefined);
    expect(result).toEqual({ handled: true, result: { items: [{ id: 'review_1' }] } });
    expect(repo.listDueReviewItems).toHaveBeenCalledWith(ctx, '2026-11-02T00:00:00.000Z');
  });

  it('splits the summary by local day bounds and estimates two minutes per review', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T02:00:00.000Z'));
    const items = [
      { id: 'boundary', dueAt: '2026-11-01T18:00:00.000Z' },
      { id: 'fresh', dueAt: '2026-11-02T01:00:00.000Z' },
    ];
    const handle = makeHandler({ listDueReviewItems: vi.fn(async () => items) });
    const result = await handle('GET', route('/v1/review-items/summary?timeZone=Asia/Shanghai'), undefined);
    // 2026-11-02T02:00Z is 10:00 in Shanghai: 18:00Z yesterday is already today there.
    expect(result).toEqual({ handled: true, result: {
      dueCount: 2, overdueCount: 0, dueTodayCount: 2, estimatedMinutes: 4, timeZone: 'Asia/Shanghai', items,
    } });
    // In UTC the same boundary item is still yesterday: overdue.
    const utc = await handle('GET', route('/v1/review-items/summary'), undefined);
    expect(utc).toMatchObject({ handled: true, result: { overdueCount: 1, dueTodayCount: 1, timeZone: 'UTC' } });
  });

  it('rejects a malformed dueBefore and an unknown time zone', async () => {
    const handle = makeHandler();
    await expect(handle('GET', route('/v1/review-items/summary?dueBefore=not-a-date'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_DUE_BEFORE' });
    await expect(handle('GET', route('/v1/review-items/summary?timeZone=Mars/Olympus'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_TIME_ZONE' });
  });

  it('caps history limits between 1 and 50 and defaults to 10', async () => {
    const repo = stubRepo({ listCompletedReviewItems: vi.fn(async () => []) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    await handle('GET', route('/v1/review-items/history'), undefined);
    expect(repo.listCompletedReviewItems).toHaveBeenCalledWith(ctx, 10);
    await handle('GET', route('/v1/review-items/history?limit=50'), undefined);
    expect(repo.listCompletedReviewItems).toHaveBeenLastCalledWith(ctx, 50);
    for (const limit of ['0', '51', '2.5', 'x']) {
      await expect(handle('GET', route(`/v1/review-items/history?limit=${limit}`), undefined))
        .rejects.toMatchObject({ code: 'INVALID_REVIEW_LIMIT' });
    }
  });

  it('completes a review through the shared derive policy', async () => {
    const result = {
      completed: { id: 'review_1', status: 'completed' },
      nextReview: { id: 'review_2', status: 'active' },
      knowledge: { id: 'k_1', correctStreak: 1 },
    };
    const repo = stubRepo({ completeReviewAndSchedule: vi.fn(async () => result) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    const response = await handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: true, timeZone: 'UTC' });
    expect(response).toEqual({ handled: true, result });
    expect(repo.completeReviewAndSchedule).toHaveBeenCalledWith(ctx, { reviewId: 'review_1', isCorrect: true, timeZone: 'UTC' }, deriveAnswerOutcome);
  });

  it('validates the completion body before touching the repository', async () => {
    const repo = stubRepo();
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    await expect(handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: 'yes' }))
      .rejects.toMatchObject({ code: 'INVALID_REVIEW_COMPLETION' });
    await expect(handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: true, timeZone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ code: 'INVALID_TIME_ZONE' });
    await expect(handle('POST', route('/v1/review-items/%00/complete'), { isCorrect: true }))
      .rejects.toMatchObject({ code: 'INVALID_IDENTIFIER' });
    expect(repo.completeReviewAndSchedule).not.toHaveBeenCalled();
  });

  it('maps repository completion failures to fixed status codes', async () => {
    const handle = makeHandler({ completeReviewAndSchedule: vi.fn(async () => null) });
    await expect(handle('POST', route('/v1/review-items/review_x/complete'), { isCorrect: true }))
      .rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });

    for (const [message, code] of [
      ['review_completion_payload_mismatch', 'REVIEW_COMPLETION_PAYLOAD_MISMATCH'],
      ['review_completion_receipt_unavailable', 'REVIEW_COMPLETION_RECEIPT_UNAVAILABLE'],
    ] as const) {
      const failing = makeHandler({ completeReviewAndSchedule: vi.fn(async () => { throw new Error(message); }) });
      await expect(failing('POST', route('/v1/review-items/review_x/complete'), { isCorrect: true }))
        .rejects.toMatchObject({ code });
    }
  });

  it('manages goals with the shared request schemas and idempotent creation', async () => {
    const repo = stubRepo({
      listLearningGoals: vi.fn(async () => [{ id: 'goal_1' }]),
      getLearningGoal: vi.fn(async (_ctx: unknown, goalId: string) => goalId === 'goal_1' ? { id: 'goal_1', status: 'active' } : null),
    });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    expect(await handle('GET', route('/v1/learning/goals?includeArchived=true'), undefined))
      .toEqual({ handled: true, result: { items: [{ id: 'goal_1' }] } });
    expect(repo.listLearningGoals).toHaveBeenCalledWith(ctx, true);

    await expect(handle('POST', route('/v1/learning/goals'), { topic: '' }))
      .rejects.toMatchObject({ code: 'INVALID_GOAL' });
    await handle('POST', route('/v1/learning/goals'), { topic: '高数' },
      { headers: { 'Idempotency-Key': 'key_1' } });
    expect(repo.createLearningGoalIdempotent).toHaveBeenCalledWith(ctx,
      expect.objectContaining({ topic: '高数', idempotencyKey: 'key_1' }));
    await handle('POST', route('/v1/learning/goals'), { topic: '高数' });
    expect(repo.createLearningGoal).toHaveBeenCalled();

    await expect(handle('PATCH', route('/v1/learning/goals/goal_missing'), { topic: 'x' }))
      .rejects.toMatchObject({ code: 'GOAL_NOT_FOUND' });
    expect((await handle('DELETE', route('/v1/learning/goals/goal_1'), undefined))).toEqual({ handled: true, result: undefined });
    expect(repo.updateLearningGoal).toHaveBeenCalledWith(ctx, 'goal_1', { status: 'archived' });
  });

  it('creates questions and serves their attempt histories', async () => {
    const repo = stubRepo({
      listAttemptsByQuestion: vi.fn(async () => [{ id: 'att_1' }]),
      getQuestion: vi.fn(async (_ctx: unknown, questionId: string) =>
        questionId === 'q_1' ? { id: 'q_1', answerSpec: { answer: '4' } } : null),
    });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    await expect(handle('POST', route('/v1/questions'), {}))
      .rejects.toMatchObject({ code: 'QUESTION_PROMPT_REQUIRED' });
    await expect(handle('POST', route('/v1/questions'), { prompt: '1+1=?', knowledgeId: 'k_missing' }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_ITEM_NOT_FOUND' });
    expect(await handle('POST', route('/v1/questions'), { prompt: '1+1=?', answerSpec: { answer: '2' } }))
      .toEqual({ handled: true, result: { id: 'q_1' } });
    expect(await handle('GET', route('/v1/questions/q_1/attempts'), undefined))
      .toEqual({ handled: true, result: { items: [{ id: 'att_1' }] } });
    await expect(handle('GET', route('/v1/questions/q_missing'), undefined))
      .rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
  });

  it('records attempts with the shared digest and maps domain failures', async () => {
    const repo = stubRepo({
      recordAnswer: vi.fn(async () => ({ attempt: { id: 'att_1', judgement: 'correct' }, nextStep: 'continue', created: true })),
    });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    const response = await handle('POST', route('/v1/questions/q_1/attempts'),
      { sessionId: 'practice_1', answer: '2', timeZone: 'UTC' }, { headers: { 'Idempotency-Key': 'key_2' } });
    expect(response).toEqual({ handled: true, result: { id: 'att_1', judgement: 'correct', nextStep: 'continue' } });
    expect(digestRequest).toHaveBeenCalledTimes(1);
    expect(repo.recordAnswer).toHaveBeenCalledWith(ctx,
      expect.objectContaining({ kind: 'existing-question', questionId: 'q_1', answer: '2', idempotencyKey: 'key_2', requestDigest: 'a'.repeat(64) }),
      { judge: expect.any(Function), derive: deriveAnswerOutcome } as LearningAnswerPolicy);

    await expect(handle('POST', route('/v1/questions/q_1/attempts'), {}))
      .rejects.toMatchObject({ code: 'ANSWER_REQUIRED' });
    await expect(handle('POST', route('/v1/questions/q_1/attempts'), { answer: '2', elapsedSeconds: -1 }))
      .rejects.toMatchObject({ code: 'INVALID_ELAPSED_SECONDS' });
    await expect(handle('POST', route('/v1/questions/q_1/attempts'), { answer: '2', hintsUsed: 1.5 }))
      .rejects.toMatchObject({ code: 'INVALID_HINTS_USED' });
    for (const [message, code] of [
      ['question_not_found', 'QUESTION_NOT_FOUND'],
      ['practice_session_not_active', 'PRACTICE_SESSION_NOT_ACTIVE'],
      ['question_not_in_practice_session', 'QUESTION_NOT_IN_PRACTICE_SESSION'],
      ['idempotency_key_reused', 'IDEMPOTENCY_KEY_REUSED'],
      ['answer_receipt_unavailable', 'ANSWER_RECEIPT_UNAVAILABLE'],
    ] as const) {
      const failing = makeHandler({ recordAnswer: vi.fn(async () => { throw new Error(message); }) });
      await expect(failing('POST', route('/v1/questions/q_1/attempts'), { answer: '2' }))
        .rejects.toMatchObject({ code });
    }
  });

  it('bounds practice counts and resumes an active session', async () => {
    const handle = makeHandler();
    for (const count of ['2', '6', '3.5']) {
      await expect(handle('POST', route('/v1/practice/sessions'), { count: Number(count) }))
        .rejects.toMatchObject({ code: 'INVALID_PRACTICE_COUNT' });
      await expect(handle('GET', route(`/v1/practice/questions?count=${count}`), undefined))
        .rejects.toMatchObject({ code: 'INVALID_PRACTICE_COUNT' });
    }
    await expect(handle('POST', route('/v1/practice/sessions'), {}))
      .rejects.toMatchObject({ code: 'PRACTICE_NOT_ENOUGH_QUESTIONS' });

    const session = { id: 'practice_9', questionIds: ['q_1'], startedAt: '2026-11-01T00:00:00.000Z' };
    const repo = stubRepo({
      getLatestActivePracticeSession: vi.fn(async () => session),
      listAttemptsBySession: vi.fn(async () => [{ questionId: 'q_1' }]),
    });
    const resuming = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    expect(await resuming('GET', route('/v1/practice/sessions/active'), undefined)).toEqual({ handled: true, result: {
      sessionId: 'practice_9', items: [{ id: 'q_1', answerSpec: { answer: '4' } }], startedAt: '2026-11-01T00:00:00.000Z',
      answeredQuestionIds: ['q_1'], nextQuestionIndex: 1,
    } });

    const created = makeHandler({ listActiveQuestions: vi.fn(async () => [{ id: 'q_1' }, { id: 'q_2' }, { id: 'q_3' }]) });
    expect(await created('POST', route('/v1/practice/sessions'), { count: 3 })).toMatchObject({
      handled: true,
      result: { sessionId: 'practice_1', answeredQuestionIds: [], nextQuestionIndex: 0 },
    });
  });

  it('reports and completes sessions through the shared report builder', async () => {
    const outcomes = [
      { judgement: 'correct', hintCount: 0, timeSpentSec: 10, nextStep: 'continue' },
      { judgement: 'incorrect', hintCount: 1, timeSpentSec: 20, nextStep: 'review_scheduled' },
    ];
    const repo = stubRepo({
      completePracticeSession: vi.fn(async () => ({ id: 'practice_1', questionCount: 3 })),
      listPracticeAnswerOutcomes: vi.fn(async () => outcomes),
    });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    const report = await handle('POST', route('/v1/practice/sessions/practice_1/complete'), undefined);
    expect(report).toMatchObject({ handled: true, result: {
      sessionId: 'practice_1', questionCount: 3, answeredCount: 2, remainingCount: 1,
      correctCount: 1, incorrectCount: 1, accuracy: 0.5, nextStep: 'review_scheduled',
    } });
    const missing = makeHandler();
    await expect(missing('POST', route('/v1/practice/sessions/practice_x/complete'), undefined))
      .rejects.toMatchObject({ code: 'PRACTICE_SESSION_NOT_FOUND' });
  });

  it('filters mistakes and applies insight/disposition updates', async () => {
    const mistakes = [
      { questionId: 'q_1', knowledgeId: 'k_1', status: 'active', wrongCount: 3, reasonCode: null },
      { questionId: 'q_2', knowledgeId: 'k_2', status: 'dismissed', wrongCount: 1, reasonCode: 'careless' },
    ];
    const repo = stubRepo({ listMistakes: vi.fn(async () => mistakes) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    expect(await handle('GET', route('/v1/mistakes?status=all&sortBy=frequent'), undefined))
      .toMatchObject({ handled: true, result: { items: [{ questionId: 'q_1' }, { questionId: 'q_2' }] } });
    await expect(handle('GET', route('/v1/mistakes?status=weird'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_MISTAKE_FILTER' });
    await expect(handle('GET', route('/v1/mistakes?reasonCode=nope'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_MISTAKE_FILTER' });

    await handle('PATCH', route('/v1/mistakes/q_1'), { reasonCode: 'concept_gap', note: '概念不清' });
    expect(repo.setMistakeInsight).toHaveBeenCalledWith(ctx,
      expect.objectContaining({ questionId: 'q_1', reasonCode: 'concept_gap' }));
    await handle('PATCH', route('/v1/mistakes/q_1'), { reasonCode: null });
    expect(repo.clearMistakeInsight).toHaveBeenCalledWith(ctx, 'q_1');
    await handle('PATCH', route('/v1/mistakes/q_2'), { status: 'active' });
    expect(repo.setMistakeDisposition).toHaveBeenCalledWith(ctx, expect.objectContaining({ questionId: 'q_2', status: 'active' }));
    await handle('PATCH', route('/v1/mistakes/q_1'), { status: 'mastered' });
    expect(repo.updateMastery).toHaveBeenCalledWith(ctx, 'k_1', 'mastered', { source: 'user', action: 'mark_mastered' });
    await expect(handle('PATCH', route('/v1/mistakes/q_missing'), { status: 'active' }))
      .rejects.toMatchObject({ code: 'MISTAKE_NOT_FOUND' });
    await expect(handle('PATCH', route('/v1/mistakes/q_1'), { status: 'nope' }))
      .rejects.toMatchObject({ code: 'INVALID_MISTAKE_UPDATE' });
  });

  it('re-practices mistakes within 1 to 5 questions', async () => {
    const mistakes = [{ questionId: 'q_1', knowledgeId: 'k_1', status: 'active', wrongCount: 1 }];
    const repo = stubRepo({ listMistakes: vi.fn(async () => mistakes) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    expect(await handle('POST', route('/v1/mistakes/repractice'), {})).toMatchObject({
      handled: true, result: { sessionId: 'practice_1', items: [{ id: 'q_1' }] },
    });
    await expect(handle('POST', route('/v1/mistakes/repractice'), { questionIds: [] }))
      .rejects.toMatchObject({ code: 'INVALID_QUESTION_IDS' });
    await expect(handle('POST', route('/v1/mistakes/repractice'), { questionIds: ['q_x'] }))
      .rejects.toMatchObject({ code: 'INVALID_QUESTION_IDS' });
    await expect(handle('POST', route('/v1/mistakes/repractice'), { questionIds: 'q_1' }))
      .rejects.toMatchObject({ code: 'INVALID_QUESTION_IDS' });
  });

  it('generates plans through the shared pipeline and serves task updates', async () => {
    const repo = stubRepo({
      transitionPlanTask: vi.fn(async (_ctx: unknown, taskId: string) => taskId === 'task_1' ? { id: 'plan_1' } : null),
      createLearningPlan: vi.fn(async (_ctx: unknown, draft: { id: string; title: string }) => ({ ...draft, milestones: [] })),
    });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });
    expect(await handle('GET', route('/v1/learning-plans'), undefined))
      .toEqual({ handled: true, result: { items: [] } });

    const generated = await handle('POST', route('/v1/learning-plans/generate'), { topic: '高数' });
    expect(generated).toMatchObject({ handled: true, result: { generatedBy: 'llm', title: '高数项目式学习' } });
    expect(repo.createLearningPlan).toHaveBeenCalledWith(ctx, expect.objectContaining({ topic: '高数' }));
    await expect(handle('POST', route('/v1/learning-plans/generate'), {}))
      .rejects.toMatchObject({ code: 'INVALID_PLAN_REQUEST' });

    expect(await handle('PATCH', route('/v1/plan-tasks/task_1'), { status: 'done' }))
      .toEqual({ handled: true, result: { id: 'plan_1' } });
    expect(repo.transitionPlanTask).toHaveBeenCalledWith(ctx, 'task_1', 'done', deriveMilestoneStatuses);
    await expect(handle('PATCH', route('/v1/plan-tasks/task_x'), { status: 'done' }))
      .rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await expect(handle('PATCH', route('/v1/plan-tasks/task_1'), { status: 'nope' }))
      .rejects.toMatchObject({ code: 'INVALID_PLAN_TASK' });
    await expect(handle('POST', route('/v1/learning-plans/plan_x/archive'), undefined))
      .rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
  });

  it('retries once with gaps, then fails or surfaces model errors', async () => {
    const retryModel = vi.fn(async () => '')
      .mockResolvedValueOnce('{"title":""}')
      .mockResolvedValueOnce(JSON.stringify(planOutput));
    const retried = makeHandler({}, retryModel);
    expect(await retried('POST', route('/v1/learning-plans/generate'), { topic: '高数' }))
      .toMatchObject({ handled: true, result: { generatedBy: 'llm' } });
    expect(retryModel).toHaveBeenCalledTimes(2);
    expect(retryModel.mock.calls[1]![1]).toContain('你上一次的输出存在以下问题');

    const alwaysBad = makeHandler({}, vi.fn(async () => '{}'));
    await expect(alwaysBad('POST', route('/v1/learning-plans/generate'), { topic: '高数' }))
      .rejects.toMatchObject({ code: 'PLAN_GENERATION_FAILED' });

    const providerDown = makeHandler({}, vi.fn(async () => { throw new Error('PROVIDER_REQUEST_FAILED'); }));
    await expect(providerDown('POST', route('/v1/learning-plans/generate'), { topic: '高数' }))
      .rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED' });
    const unknown = makeHandler({}, vi.fn(async () => { throw new Error('boom'); }));
    await expect(unknown('POST', route('/v1/learning-plans/generate'), { topic: '高数' }))
      .rejects.toMatchObject({ code: 'PLAN_MODEL_CALL_FAILED' });
  });

  it('imports question banks from inline JSON or CSV content', async () => {
    const repo = stubRepo({ createQuestion: vi.fn(async (_ctx: unknown, q: { id: string }) => q) });
    const handle = createLearningRouteHandler({ repo, ctx, digestRequest, generateText });

    expect(await handle('GET', route('/v1/questions/import/providers'), undefined)).toMatchObject({
      handled: true,
      result: { providers: [{ id: 'json-question-bank' }, { id: 'csv-question-bank' }] },
    });

    const imported = await handle('POST', route('/v1/questions/import'),
      { content: JSON.stringify([{ prompt: '1+1', answer: '2', explanation: '加法', tags: ['math'] }]), knowledgeId: 'k_1' });
    expect(imported).toMatchObject({ handled: true, result: {
      providerId: 'json-question-bank', importedCount: 1,
      questions: [expect.objectContaining({
        prompt: '1+1', knowledgeId: 'k_1',
        answerSpec: { answer: '2', explanation: '加法', tags: ['math'] },
      })],
    } });

    const csv = await handle('POST', route('/v1/questions/import'), { content: 'Q1,A1\nQ2,A2', format: 'csv' });
    expect(csv).toMatchObject({ handled: true, result: { providerId: 'csv-question-bank', importedCount: 2 } });

    await expect(handle('POST', route('/v1/questions/import'), {}))
      .rejects.toMatchObject({ code: 'IMPORT_CONTENT_REQUIRED' });
    await expect(handle('POST', route('/v1/questions/import'), { content: '# 只有注释' }))
      .rejects.toMatchObject({ code: 'NO_VALID_QUESTIONS' });
    await expect(handle('POST', route('/v1/questions/import'), { content: '中'.repeat(Math.ceil(1024 * 1024 / 3)) }))
      .rejects.toMatchObject({ code: 'QUESTION_BANK_TOO_LARGE' });
  });

  it('leaves unrelated paths to the host dispatch', async () => {
    const handle = makeHandler();
    expect(await handle('GET', route('/v1/sessions'), undefined)).toEqual({ handled: false });
    expect(await handle('POST', route('/v1/review-items/review_1/complete/extra'), {})).toEqual({ handled: false });
    expect(await handle('DELETE', route('/v1/review-items/review_1/complete'), undefined)).toEqual({ handled: false });
  });
});
