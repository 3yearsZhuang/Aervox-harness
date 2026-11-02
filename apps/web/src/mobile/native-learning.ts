/** Today's review on the phone: the review-items surface of the learning
 * domain over the local SQLite business truth. Desktop routes in
 * host-runtime's learning module remain the semantic reference; scheduling
 * derives through @aervox/practice-review so intervals cannot drift between
 * hosts. Completion keeps the repository's receipt discipline: a mismatching
 * replay is a 409, never a second schedule.
 */
import { AervoxHttpError } from '@aervox/api-client';
import { deriveAnswerOutcome, getLocalDayBounds } from '@aervox/practice-review';
import type { ILearningRepository, LocalContext } from '@aervox/repositories/learning';

const ESTIMATED_MINUTES_PER_REVIEW = 2;
const fail = (status: number, code: string): never => { throw new AervoxHttpError(status, 'native', { code, message: code }); };
const validTimeZone = (value: string): boolean => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
};

export interface LearningRouteDeps {
  repo: Pick<ILearningRepository, 'listDueReviewItems' | 'listCompletedReviewItems' | 'completeReviewAndSchedule'>;
  ctx: LocalContext;
}

export type LearningRouteResult = { handled: true; result: unknown } | { handled: false };

export function createLearningRouteHandler({ repo, ctx }: LearningRouteDeps) {
  return async function handleLearningRoute(method: string, url: URL, body: unknown): Promise<LearningRouteResult> {
    const complete = /^\/v1\/review-items\/([^/]+)\/complete$/.exec(url.pathname);
    if (url.pathname === '/v1/review-items' && method === 'GET') {
      const dueBefore = url.searchParams.get('dueBefore') ?? new Date().toISOString();
      return { handled: true, result: { items: await repo.listDueReviewItems(ctx, dueBefore) } };
    }
    if (url.pathname === '/v1/review-items/summary' && method === 'GET') {
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
    if (url.pathname === '/v1/review-items/history' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 10 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(400, 'INVALID_REVIEW_LIMIT');
      return { handled: true, result: { items: await repo.listCompletedReviewItems(ctx, limit) } };
    }
    if (complete && method === 'POST') {
      const reviewId = decodeURIComponent(complete[1]!);
      if (!reviewId || reviewId.length > 128 || reviewId.includes('\0')) return fail(400, 'INVALID_IDENTIFIER');
      const payload = (body ?? {}) as { isCorrect?: unknown; timeZone?: unknown };
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
    return { handled: false };
  };
}
