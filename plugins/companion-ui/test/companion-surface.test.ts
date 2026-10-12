import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { configureAervoxClient } from '@aervox/api-client';
import { UISurfaceHost } from '@aervox/ui-host';
import definition from '../src';

enableAutoUnmount(afterEach);
it('detaches an active quick chat when the companion root is removed', async () => {
  await definition.load();
  let signal!: AbortSignal;
  const streamTurn = vi.fn((_session, _content, _callbacks, options) => {
    signal = options.signal;
    return new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  configureAervoxClient({
    transport: { request: vi.fn(), streamTurn, submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn() },
    platform: {},
  });
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'companion', platform: 'desktop' },
    global: { stubs: { Live2DPet: true, PetHero: true } },
  });
  await vi.waitFor(() => expect(wrapper.find('input').exists()).toBe(true), { timeout: 5000 });
  await wrapper.get('input').setValue('你好');
  await wrapper.get('input').trigger('keydown.enter');
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(false);
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  await flushPromises();
});
