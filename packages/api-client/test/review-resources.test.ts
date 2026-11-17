import { expect, it, vi } from 'vitest';
import { createReviewStore } from '../src/learning-stores.js';
import { createFetchTransport } from '../src/transport.js';

const active = {id: 'r1', knowledgeId: 'k1', dueAt: '2020-01-01T12:00:00.000Z', intervalDays: 1, schedulerVersion: 2, timezoneSnapshot: 'Asia/Shanghai', status: 'active'};
const knowledge = {id: 'k1', concept: '二次方程\0求根公式', sourceStatus: 'observed', masteryState: 'reviewing', correctCount: 1, wrongCount: 0, correctStreak: 1, mastery: 0.5, masteryBasis: null, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z'};
const receipt = {completed: {...active, status: 'completed', completionIsCorrect: false, nextReviewId: 'r2'}, nextReview: {...active, id: 'r2', dueAt: '2027-01-01T12:00:00.000Z', intervalDays: 2}, knowledge};
const summary = {dueCount: 1, overdueCount: 1, dueTodayCount: 0, estimatedMinutes: 2, timeZone: 'Asia/Shanghai', items: [active]};
const fixture = () => {
  const request = vi.fn();
  const store = createReviewStore({...createFetchTransport('http://unused'), request}, 'Asia/Shanghai');
  return {store, request};
};

it('distinguishes an unread resource, a verified empty result and a failed refresh', async () => {
  const {store, request} = fixture();
  expect(store.resource.loaded.value).toBe(false);
  request.mockResolvedValueOnce({items: []}).mockResolvedValueOnce({...summary, dueCount: 0, overdueCount: 0, estimatedMinutes: 0, items: []}).mockResolvedValueOnce({items: []});
  await store.loadReviews();
  expect(store.resource.loaded.value).toBe(true);
  request.mockRejectedValue(new Error('offline'));
  await expect(store.loadReviews()).rejects.toThrow('offline');
  expect(store.resource.error.value).toBe('offline');
  expect(store.resource.loaded.value).toBe(true);
});

it('returns the actual completion receipt even when its subsequent projection refresh fails', async () => {
  const {store, request} = fixture();
  request.mockResolvedValueOnce({items: [active]}).mockResolvedValueOnce(summary).mockResolvedValueOnce({items: []});
  await store.loadReviews();
  request.mockResolvedValueOnce(receipt).mockRejectedValue(new Error('refresh offline'));
  await expect(store.completeReview('r1', false)).resolves.toMatchObject({completed: {id: 'r1'}, nextReview: {id: 'r2', schedulerVersion: 2}});
  expect(store.dueReviews.value).toEqual([]);
  expect(store.resource.error.value).toBe('refresh offline');
  expect(request.mock.calls.find(([method]) => method === 'POST')?.[2]).toEqual({isCorrect: false, timeZone: 'Asia/Shanghai'});
});

it('rejects incomplete or mismatched completion receipts before displaying success', async () => {
  const {store, request} = fixture();
  for (const value of [{completed: {id: 'r1'}}, {...receipt, completed: {...receipt.completed, id: 'other'}}, {...receipt, nextReview: {...receipt.nextReview, knowledgeId: 'other'}}, {...receipt, completed: {...receipt.completed, nextReviewId: 'other'}}, receipt]) {
    request.mockResolvedValueOnce(value);
    await expect(store.completeReview('r1', true)).rejects.toThrow();
  }
  expect(request.mock.calls.every(([method]) => method === 'POST')).toBe(true);
});

it('reads validated knowledge content by exact identity and preserves embedded NUL', async () => {
  const {store, request} = fixture();
  request.mockResolvedValueOnce(knowledge);
  await expect(store.getKnowledgeItem('k1')).resolves.toMatchObject({id: 'k1', concept: knowledge.concept});
  request.mockResolvedValueOnce({...knowledge, id: 'other'});
  await expect(store.getKnowledgeItem('k1')).rejects.toThrow();
  expect(request.mock.calls[0]).toEqual(['GET', '/v1/knowledge-items/k1']);
});
