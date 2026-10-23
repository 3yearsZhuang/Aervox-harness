import { afterEach, expect, it, vi } from 'vitest';
import { configureAervoxClient, createFetchTransport } from '../src/transport';
import { useAervoxApi } from '../src/useAervoxApi';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const request = vi.fn().mockResolvedValue({items: []});
  configureAervoxClient({transport: {...createFetchTransport('http://unused'), request}});
  return {api: useAervoxApi(), request};
}
it('is lazy and a goal mutation refreshes only goals', async () => {
  const {api, request} = fixture();
  expect(request).not.toHaveBeenCalled();
  await api.createGoal({topic: 'loops'});
  expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
    ['POST', '/v1/learning/goals'], ['GET', '/v1/learning/goals'],
  ]);
});
it('retains successful resources and previous values when another query fails', async () => {
  const {api, request} = fixture();
  request.mockResolvedValueOnce({items: [{id: 'goal'}]});
  await api.loadGoals();
  request.mockRejectedValueOnce(new Error('goals offline')).mockResolvedValueOnce({items: [{id: 'plan'}]});
  await Promise.allSettled([api.loadGoals(), api.loadPlans()]);
  expect(api.goals.value).toEqual([{id: 'goal'}]);
  expect(api.learningPlans.value).toEqual([{id: 'plan'}]);
  expect(api.resources.goals.error.value).toBe('goals offline');
  expect(api.error.value).toContain('goals offline');
});
it('does not turn a saved mutation into a failure because its refresh failed', async () => {
  const {api, request} = fixture();
  request.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('refresh offline'));
  await expect(api.updateGoal('g', {status: 'completed'})).resolves.toBeUndefined();
  expect(api.resources.goals.error.value).toBe('refresh offline');
});
it('the refresh after a mutation wins over an older in-flight query', async () => {
  const {api, request} = fixture();
  let old!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => {old = resolve;}))
    .mockResolvedValueOnce({}).mockResolvedValueOnce({items: [{id: 'fresh'}]});
  const previous = api.loadGoals();
  await api.updateGoal('fresh', {status: 'completed'});
  old({items: [{id: 'stale'}]}); await previous;
  expect(api.goals.value).toEqual([{id: 'fresh'}]);
});

it('a new practice session wins over an older in-flight active-session query', async () => {
  const {api, request} = fixture();
  let finishLoad!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => {finishLoad = resolve;}))
    .mockResolvedValueOnce({sessionId: 'new', items: []});
  const loading = api.loadPractice();
  await api.startPracticeSession();
  finishLoad({sessionId: 'old', items: []});
  await loading;
  expect(api.activePracticeSession.value?.sessionId).toBe('new');
});
