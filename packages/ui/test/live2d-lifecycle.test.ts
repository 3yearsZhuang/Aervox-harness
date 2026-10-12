import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { configureAervoxClient } from '@aervox/api-client';

const mock = vi.hoisted(() => ({ load: vi.fn(), destroy: vi.fn() }));
vi.mock('../src/live2d/controller', () => ({
  AervoxLive2DController: class {
    load = mock.load;
    destroy = mock.destroy;
  },
}));
import Live2DPet from '../src/components/Live2DPet.vue';

afterEach(() => {
  vi.restoreAllMocks();
  mock.load.mockReset();
  mock.destroy.mockReset();
  delete window.aervoxLive2D;
});

it('a model load completing after unmount cannot register listeners or publish its API', async () => {
  let resolve!: () => void;
  mock.load.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
  const subscribe = vi.fn(() => vi.fn());
  configureAervoxClient({ platform: { onPetCommand: subscribe } });
  const listen = vi.spyOn(window, 'addEventListener');
  const wrapper = mount(Live2DPet);
  wrapper.unmount();
  resolve();
  await flushPromises();
  expect(mock.destroy).toHaveBeenCalledOnce();
  expect(subscribe).not.toHaveBeenCalled();
  expect(listen.mock.calls.some(([type]) => type === 'aervox:pet-react')).toBe(false);
  expect(window.aervoxLive2D).toBeUndefined();
});

it('unmounting an older visual does not remove a newer visual API', async () => {
  mock.load.mockResolvedValue(undefined);
  configureAervoxClient({ platform: {} });
  const older = mount(Live2DPet);
  await flushPromises();
  const newer = mount(Live2DPet);
  await flushPromises();
  const current = window.aervoxLive2D;
  older.unmount();
  expect(window.aervoxLive2D).toBe(current);
  newer.unmount();
  expect(window.aervoxLive2D).toBeUndefined();
});
