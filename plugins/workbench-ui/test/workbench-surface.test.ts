import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { configureAervoxClient } from '@aervox/api-client';
import type { BuiltinUIPlugin, UIRegistry } from '@aervox/ui/plugin-api';
import definition, { compactSurface } from '../src';

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('aervox-workbench-mode', 'standard');
  configureAervoxClient({
    transport: {
      request: vi.fn(async <T>(_method: string, path: string) => ({
        items: path === '/v1/plugins' ? [{ id: 'fixture-extension', enabled: 1 }] : [],
      }) as T),
      streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

it('loads the real workbench on each client platform through the same definition', async () => {
  await definition.load();
  for (const platform of ['web', 'desktop', 'mobile'] as const) {
    const wrapper = mount(UISurfaceHost, { props: {
      plugin: definition, surface: 'main', platform, viewProps: { showCompanion: false },
    } });
    // The async module import and mounted session/extension requests both settle.
    await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
    await flushPromises();
    expect(wrapper.find('.standard-conversation').exists()).toBe(true);
    wrapper.unmount();
  }
});

it('compact surface mounts the same workbench as a single-column variant without sidebar', async () => {
  const wrapper = mount(UISurfaceHost, { props: {
    plugin: compactSurface, surface: 'main', platform: 'web', viewProps: { showCompanion: false },
  } });
  await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  expect(wrapper.find('.aervox-workbench.is-variant-compact').exists()).toBe(true);
  expect(wrapper.find('.workbench-standard-sidebar').exists()).toBe(false);
  expect(wrapper.find('.menu-pill').exists()).toBe(false);
  expect(wrapper.find('.standard-conversation').exists()).toBe(true);
});

it('keeps extension registries and cleanup separate across mounted workbenches', async () => {
  await definition.load();
  const registries: UIRegistry[] = [];
  const cleanups = [vi.fn(), vi.fn()];
  const extension: BuiltinUIPlugin = {
    id: 'fixture-extension',
    setup(registry, context) {
      const index = registries.push(registry) - 1;
      context!.layout.quietStartup.value = true;
      return cleanups[index];
    },
  };
  const create = () => mount(UISurfaceHost, { props: {
    plugin: definition, surface: 'main', platform: 'web',
    viewProps: { plugins: [extension], showCompanion: false },
  } });
  const a = create();
  const b = create();
  await vi.waitFor(() => expect(registries).toHaveLength(2));
  expect(registries[0]).not.toBe(registries[1]);
  a.unmount();
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(cleanups[1]).not.toHaveBeenCalled();
  expect(b.find('.aervox-workbench').exists()).toBe(true);
});
