import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { configureAervoxClient } from '@aervox/api-client';
import type { PetManifest } from '@aervox/contracts';

const mock = vi.hoisted(() => ({ load: vi.fn(), destroy: vi.fn() }));
vi.mock('../src/live2d/controller', () => ({
  AervoxLive2DController: class {
    load = mock.load;
    destroy = mock.destroy;
  },
}));
import PetWithFallback from '../src/components/PetWithFallback.vue';

afterEach(() => {
  vi.restoreAllMocks();
  mock.load.mockReset();
  mock.destroy.mockReset();
  delete window.aervoxLive2D;
});

const spriteManifest = {
  name: 'test-pet',
  atlas: '/pet.png',
  frameWidth: 192,
  frameHeight: 208,
} as unknown as PetManifest;

it('falls back to the CSS hero when Live2D is unavailable and no sprite sheet is provided', async () => {
  mock.load.mockRejectedValue(new Error('no webgl'));
  configureAervoxClient({ platform: {} });
  const wrapper = mount(PetWithFallback);
  await flushPromises();
  expect(wrapper.get('[data-status="error"]').exists()).toBe(true);
  expect(wrapper.get('.pet-hero').exists()).toBe(true);
});

it('prefers the sprite sheet over the CSS hero when a manifest is provided', async () => {
  mock.load.mockRejectedValue(new Error('no webgl'));
  configureAervoxClient({ platform: {} });
  const wrapper = mount(PetWithFallback, {
    props: { spriteManifest },
    global: { stubs: { SpritePet: { name: 'SpritePet', template: '<div class="sprite-stub" />' } } },
  });
  await flushPromises();
  expect(wrapper.find('.pet-hero').exists()).toBe(false);
  expect(wrapper.get('.sprite-stub').exists()).toBe(true);
});

it('keeps the Live2D stage when the model loads', async () => {
  mock.load.mockResolvedValue(undefined);
  configureAervoxClient({ platform: {} });
  const wrapper = mount(PetWithFallback);
  await flushPromises();
  expect(wrapper.get('[data-status="ready"]').exists()).toBe(true);
  expect(wrapper.find('.pet-hero').exists()).toBe(false);
});
