import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAnswerOutcome } from '@aervox/practice-review';
import type { ILearningRepository, LocalContext } from '@aervox/repositories/learning';
import { createLearningRouteHandler } from '../src/mobile/native-learning';

const ctx: LocalContext = { workspaceId: 'local', subjectUserId: 'local' };

type Repo = Pick<ILearningRepository, 'listDueReviewItems' | 'listCompletedReviewItems' | 'completeReviewAndSchedule'>;

function stubRepo(overrides: Partial<Repo> = {}) {
  return {
    listDueReviewItems: vi.fn(async () => []),
    listCompletedReviewItems: vi.fn(async () => []),
    completeReviewAndSchedule: vi.fn(async () => null),
    ...overrides,
  };
}

const route = (path: string) => new URL(path, 'https://localhost');

afterEach(() => { vi.useRealTimers(); });

describe('native learning routes', () => {
  it('returns due items and forwards an explicit dueBefore', async () => {
    const repo = stubRepo({ listDueReviewItems: vi.fn(async () => [{ id: 'review_1' }]) });
    const handle = createLearningRouteHandler({ repo, ctx });
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
    const repo = stubRepo({ listDueReviewItems: vi.fn(async () => items) });
    const handle = createLearningRouteHandler({ repo, ctx });
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
    const handle = createLearningRouteHandler({ repo: stubRepo(), ctx });
    await expect(handle('GET', route('/v1/review-items/summary?dueBefore=not-a-date'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_DUE_BEFORE' });
    await expect(handle('GET', route('/v1/review-items/summary?timeZone=Mars/Olympus'), undefined))
      .rejects.toMatchObject({ code: 'INVALID_TIME_ZONE' });
  });

  it('caps history limits between 1 and 50 and defaults to 10', async () => {
    const repo = stubRepo({ listCompletedReviewItems: vi.fn(async () => []) });
    const handle = createLearningRouteHandler({ repo, ctx });
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
    const handle = createLearningRouteHandler({ repo, ctx });
    const response = await handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: true, timeZone: 'UTC' });
    expect(response).toEqual({ handled: true, result });
    expect(repo.completeReviewAndSchedule).toHaveBeenCalledWith(ctx, { reviewId: 'review_1', isCorrect: true, timeZone: 'UTC' }, deriveAnswerOutcome);
  });

  it('validates the completion body before touching the repository', async () => {
    const repo = stubRepo();
    const handle = createLearningRouteHandler({ repo, ctx });
    await expect(handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: 'yes' }))
      .rejects.toMatchObject({ code: 'INVALID_REVIEW_COMPLETION' });
    await expect(handle('POST', route('/v1/review-items/review_1/complete'), { isCorrect: true, timeZone: 'Mars/Olympus' }))
      .rejects.toMatchObject({ code: 'INVALID_TIME_ZONE' });
    await expect(handle('POST', route('/v1/review-items/%00/complete'), { isCorrect: true }))
      .rejects.toMatchObject({ code: 'INVALID_IDENTIFIER' });
    expect(repo.completeReviewAndSchedule).not.toHaveBeenCalled();
  });

  it('maps repository completion failures to fixed status codes', async () => {
    const handle = createLearningRouteHandler({
      repo: stubRepo({ completeReviewAndSchedule: vi.fn(async () => null) }), ctx,
    });
    await expect(handle('POST', route('/v1/review-items/review_x/complete'), { isCorrect: true }))
      .rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });

    for (const [message, code] of [
      ['review_completion_payload_mismatch', 'REVIEW_COMPLETION_PAYLOAD_MISMATCH'],
      ['review_completion_receipt_unavailable', 'REVIEW_COMPLETION_RECEIPT_UNAVAILABLE'],
    ] as const) {
      const failing = createLearningRouteHandler({
        repo: stubRepo({ completeReviewAndSchedule: vi.fn(async () => { throw new Error(message); }) }), ctx,
      });
      await expect(failing('POST', route('/v1/review-items/review_x/complete'), { isCorrect: true }))
        .rejects.toMatchObject({ code });
    }
  });

  it('leaves unrelated paths to the host dispatch', async () => {
    const handle = createLearningRouteHandler({ repo: stubRepo(), ctx });
    expect(await handle('GET', route('/v1/sessions'), undefined)).toEqual({ handled: false });
    expect(await handle('POST', route('/v1/review-items/review_1/complete/extra'), {})).toEqual({ handled: false });
    expect(await handle('DELETE', route('/v1/review-items/review_1/complete'), undefined)).toEqual({ handled: false });
  });
});
