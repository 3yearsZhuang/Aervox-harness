// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));
beforeEach(() => { vi.resetModules(); request.mockReset(); });
const draft = 'aervox-mobile-draft:phone_session';
const receipt = (values: Record<string, string>) => ({ kind: 'preferences', values });
async function storage(values: Record<string, string> = {}) {
  request.mockResolvedValueOnce(receipt(values));
  const module = await import('../src/mobile/native-storage');
  await module.hydrateNativeStorage();
  return module;
}

it('hydrates only allowed UI text and confirms writes from the native receipt', async () => {
  const module = await storage({ [draft]: '保留的草稿' });
  expect(module.nativeStorage.getItem(draft)).toBe('保留的草稿');
  request.mockImplementation(async body => receipt(body.values));
  module.nativeStorage.setItem(draft, '新的草稿');
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(module.nativeStorageFailed.value).toBe(false);
  expect(module.draftStorageFailure()).toBeUndefined();
  expect(() => module.nativeStorage.setItem('provider_key', 'secret')).toThrow('INVALID_UI_PREFERENCE');
  expect(() => module.nativeStorage.setItem(draft, '界'.repeat(11_000))).toThrow('INVALID_UI_PREFERENCE');
  expect(module.nativeStorage.getItem(draft)).toBe('新的草稿');
});

it.each([undefined, {}, { kind: 'preferences', values: {} }, { kind: 'preferences', values: { [draft]: 'older' } }])(
  'keeps an unconfirmed write visible as failed without discarding the in-memory draft', async value => {
    const module = await storage();
    request.mockResolvedValueOnce(value);
    module.nativeStorage.setItem(draft, '不能丢掉');
    await vi.waitFor(() => expect(module.nativeStorageFailed.value).toBe(true));
    expect(module.draftStorageFailure()?.message).toBe('DRAFT_SAVE_FAILED');
    expect(module.nativeStorage.getItem(draft)).toBe('不能丢掉');
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it('flushes the newer snapshot after a preceding receipt is lost and never replays the old write', async () => {
  const module = await storage();
  let reject!: (error: Error) => void;
  request.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  request.mockImplementation(async body => receipt(body.values));
  module.nativeStorage.setItem(draft, '第一段');
  module.nativeStorage.setItem(draft, '编辑后的第二段');
  expect(request).toHaveBeenCalledTimes(2);
  reject(new Error('private native diagnostic'));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  expect(request.mock.calls.slice(1).map(([body]) => body.values)).toEqual([{ [draft]: '第一段' }, { [draft]: '编辑后的第二段' }]);
  expect(module.nativeStorageFailed.value).toBe(false);
  expect(module.nativeStorage.getItem(draft)).toBe('编辑后的第二段');
});

it('rejects invalid persisted preferences before declaring the UI cache ready', async () => {
  const module = await import('../src/mobile/native-storage');
  request.mockResolvedValueOnce(receipt({ provider_key: 'sensitive' }));
  await expect(module.hydrateNativeStorage()).rejects.toThrow('INVALID_UI_PREFERENCES');
  expect(module.nativeStorage.getItem('provider_key')).toBeNull();
  expect(() => module.nativeStorage.setItem(draft, 'not hydrated')).toThrow('INVALID_UI_PREFERENCE');
});

it('reports a full native draft cache without evicting another session or submitting an invalid snapshot', async () => {
  const existing = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`aervox-mobile-draft:session_${index}`, `保留${index}`]));
  const module = await storage(existing);
  expect(() => module.nativeStorage.setItem(draft, '不能覆盖别人的草稿')).toThrow('DRAFT_STORAGE_FULL');
  expect(module.nativeStorageFailed.value).toBe(true);
  expect(module.nativeStorage.getItem(draft)).toBeNull();
  for (const [key, value] of Object.entries(existing)) expect(module.nativeStorage.getItem(key)).toBe(value);
  expect(request).toHaveBeenCalledTimes(1);
});

it('keeps a newer oversized draft failure visible when an older valid write later succeeds', async () => {
  const module = await storage();
  let finish!: (value: unknown) => void;
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  module.nativeStorage.setItem(draft, '旧草稿');
  expect(() => module.nativeStorage.setItem(draft, '界'.repeat(11_000))).toThrow('INVALID_UI_PREFERENCE');
  finish(receipt({ [draft]: '旧草稿' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(module.nativeStorageFailed.value).toBe(true);
  expect(module.nativeStorage.getItem(draft)).toBe('旧草稿');
  request.mockImplementation(async body => receipt(body.values));
  module.nativeStorage.setItem(draft, '用户修正后的草稿');
  await vi.waitFor(() => expect(module.nativeStorageFailed.value).toBe(false));
});
