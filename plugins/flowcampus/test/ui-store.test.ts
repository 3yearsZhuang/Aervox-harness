import { afterEach, describe, expect, it, vi } from 'vitest';
import { AervoxHttpError, type AervoxTransport } from '@aervox/api-client';
import { calculateCampusPlan, createEmptyCampusState, type CampusStateSnapshot } from '../src/domain/index.js';
import { createCampusClient, type CampusClient } from '../src/ui/api.js';
import { createCampusUIStore } from '../src/ui/store.js';
import { absoluteDateTime, localDateTime } from '../src/ui/time.js';

const at = '2026-10-27T00:00:00.000Z';
const snapshot = (): CampusStateSnapshot => ({ state: createEmptyCampusState(), revision: 0, lifecycleGeneration: 'generation_1' });
function client() {
  const value = snapshot();
  return { load: vi.fn(async () => value), save: vi.fn(async state => ({ ...value, state, revision: 1 })),
    plan: vi.fn(async () => ({ plan: calculateCampusPlan(value.state, at), revision: value.revision, lifecycleGeneration: value.lifecycleGeneration })) } satisfies CampusClient;
}
afterEach(() => vi.useRealTimers());

describe('campus UI state ownership', () => {
  it('exports a fresh saved snapshot without clearing a conflict or replacing the editor snapshot', async () => {
    const api = client();
    const store = createCampusUIStore(api);
    await store.reload();
    const original = store.snapshot.value;
    store.conflict.value = true;
    const latest = { ...snapshot(), revision: 9, state: { ...snapshot().state,
      tasks: [{ id: 'remote', title: '已保存任务', estimatedMinutes: 10, priority: 'high' as const, status: 'pending' as const }] } };
    api.load.mockResolvedValue(latest);
    expect(await store.readForExport()).toEqual(latest);
    expect(store.snapshot.value).toBe(original);
    expect(store.conflict.value).toBe(true);
    expect(api.save).not.toHaveBeenCalled();
    store.dispose();
    expect(await store.readForExport()).toBeNull();
  });
  it('loads genuine empty data and does not manufacture a course or route', async () => {
    const api = client();
    const store = createCampusUIStore(api);
    await store.reload();
    await store.refreshPlan();
    expect(store.state.value?.events).toEqual([]);
    expect(store.plan.value?.departureStatus).toBe('no_schedule');
    expect(store.plan.value?.departureAt).toBeNull();
    expect(api.save).not.toHaveBeenCalled();
    store.dispose();
  });

  it('requires a fresh read after CAS conflict or an uncertain write, without retrying', async () => {
    const api = client();
    api.save.mockRejectedValueOnce(new AervoxHttpError(409, '/state', { code: 'PLUGIN_CONFIG_REVISION_CONFLICT' }));
    const store = createCampusUIStore(api);
    await store.reload();
    const next = { ...snapshot().state, tasks: [{ id: 'task_1', title: '背单词', estimatedMinutes: 10, priority: 'medium' as const, status: 'pending' as const }] };
    expect(await store.save(next)).toBe(false);
    expect(store.conflict.value).toBe(true);
    expect(store.state.value?.tasks).toEqual([]);
    expect(store.error.value).toContain('草稿已保留');
    expect(await store.save(next)).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(1);
    await store.reload();
    api.save.mockRejectedValueOnce(new Error('network outcome unknown'));
    expect(await store.save(next)).toBe(false);
    expect(store.error.value).toContain('保存结果尚未确认');
    expect(await store.save(next)).toBe(false);
    expect(api.save).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it('clears a plan from another data revision and blocks overwriting newer data', async () => {
    const api = client();
    const store = createCampusUIStore(api);
    await store.reload();
    api.plan.mockResolvedValue({ plan: calculateCampusPlan(snapshot().state, at), revision: 1, lifecycleGeneration: 'generation_1' });
    await store.refreshPlan();
    expect(store.plan.value).toBeNull();
    expect(store.writable.value).toBe(false);
    expect(store.error.value).toContain('其他页面');
    store.dispose();
  });

  it('aborts reads and rejects their late results on disable', async () => {
    const api = client();
    let resolve!: (value: CampusStateSnapshot) => void;
    api.load.mockImplementation(() => new Promise(done => { resolve = done; }));
    const parent = new AbortController();
    const store = createCampusUIStore(api, parent.signal);
    const pending = store.reload();
    const signal = api.load.mock.calls[0]?.[0];
    parent.abort();
    expect(signal?.aborted).toBe(true);
    resolve(snapshot());
    expect(await pending).toBe(false);
    expect(store.snapshot.value).toBeNull();
    store.open();
    expect(store.drawerOpen.value).toBe(false);
    expect(api.plan).not.toHaveBeenCalled();
  });

  it('does not resurrect data after a write finishes during disposal', async () => {
    const api = client();
    const store = createCampusUIStore(api);
    await store.reload();
    let resolve!: (value: CampusStateSnapshot) => void;
    api.save.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = store.save(snapshot().state);
    store.dispose();
    resolve({ ...snapshot(), revision: 1 });
    expect(await pending).toBe(false);
    expect(store.state.value).toBeNull();
    expect(store.feedback.value).toBe('');
  });

  it('removes its foreground refresh timer when uninstalled', async () => {
    vi.useFakeTimers();
    const api = client();
    const store = createCampusUIStore(api);
    store.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.plan.mock.calls.length).toBeGreaterThan(1);
    store.dispose();
    const count = api.plan.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(api.plan).toHaveBeenCalledTimes(count);
  });
});

describe('campus UI API boundary and timezone', () => {
  it('uses the same revision and lifecycle generation in a write and rejects malformed receipts', async () => {
    const request = vi.fn().mockResolvedValueOnce({ ...snapshot(), revision: 4 }).mockResolvedValueOnce({ ...snapshot(), lifecycleGeneration: 3 });
    const api = createCampusClient({ request } as unknown as AervoxTransport);
    const parent = new AbortController();
    await api.save(snapshot().state, { revision: 3, lifecycleGeneration: 'generation_1' }, parent.signal);
    expect(request.mock.calls[0]).toEqual(['PUT', '/v1/plugins/flowcampus/state', { state: snapshot().state,
      expectedRevision: 3, expectedLifecycleGeneration: 'generation_1' }, { signal: parent.signal }]);
    await expect(api.load()).rejects.toThrow();
  });

  it('preserves a Shanghai course time regardless of browser timezone', () => {
    expect(absoluteDateTime('2026-10-27T08:00', 'Asia/Shanghai')).toBe('2026-10-27T00:00:00.000Z');
    expect(localDateTime('2026-10-27T00:00:00.000Z', 'Asia/Shanghai')).toBe('2026-10-27T08:00');
    expect(absoluteDateTime('2026-10-27T08:00', 'America/New_York')).toBe('2026-10-27T12:00:00.000Z');
  });

  it('rejects nonexistent and ambiguous daylight-saving local times', () => {
    expect(() => absoluteDateTime('2026-03-08T02:30', 'America/New_York')).toThrow('不存在');
    expect(() => absoluteDateTime('2026-11-01T01:30', 'America/New_York')).toThrow('歧义');
    expect(() => absoluteDateTime('2026-02-30T12:00', 'Asia/Shanghai')).toThrow();
  });
});
