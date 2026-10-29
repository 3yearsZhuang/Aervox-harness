// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from '../src/App.vue';
import { UISurfaceHost } from '@aervox/ui-host';
import { hydrateNativeStorage, nativeStorage } from '../src/mobile/native-storage';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));

vi.mock('@aervox/ui-host', async () => {
  const { defineComponent } = await import('vue');
  return {
    UISurfaceHost: defineComponent({ name: 'UISurfaceHost', props: ['plugin', 'plugins', 'settingsPanels', 'viewProps'], template: '<main />' }),
    resolveWebPlatform: () => 'mobile',
    resolveSurfaceChoice: (surfaces: { id: string }[]) => surfaces[0],
    createSurfaceNavigation: (surfaces: { id: string }[]) => ({ currentId: surfaces[0]!.id, options: surfaces.map(item => ({ value: item.id, label: item.id })) }),
  };
});
vi.mock('@aervox/ui/material3', () => ({ useMaterial3: () => true, useMobileBackNavigation: () => undefined }));
vi.mock('@aervox/plugin-workbench-ui', () => ({ default: { id: 'desktop' }, compactSurface: { id: 'compact' } }));
vi.mock('@aervox/plugin-proactive-ui', () => ({ default: { id: 'proactive' } }));
vi.mock('@aervox/plugin-focus-mode/ui', () => ({ default: { id: 'focus' } }));
vi.mock('@aervox/plugin-panels-ui', () => ({ settingsPanels: [{ category: 'voice', component: { name: 'WebSettings' } }] }));
vi.mock('../src/mobile/NativeRuntimePanel.vue', () => ({ default: { name: 'NativeRuntimePanel', render: () => null } }));
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: vi.fn() } }));
afterEach(() => { delete window.AervoxM0Native; });

it('registers only the independent conversation surface and native settings in the fixed asset host', () => {
  window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null };
  const wrapper = mount(App);
  const props = wrapper.getComponent(UISurfaceHost).props();
  expect(props.plugin.id).toBe('proactive');
  expect(props.plugins).toEqual([]);
  expect(props.settingsPanels).toEqual([{ category: 'model', component: expect.objectContaining({ name: 'NativeRuntimePanel' }) }]);
  expect(props.viewProps.nativeRuntime).toBe(true);
  expect(props.viewProps.draftStorage).toBe(nativeStorage);
  expect(props.viewProps.surfaceNavigation.options.map((item: { value: string }) => item.value)).toEqual(['proactive']);
  wrapper.unmount();
});

it('preserves the existing web surfaces, first-party plugin and settings when no native host is present', () => {
  const wrapper = mount(App);
  const props = wrapper.getComponent(UISurfaceHost).props();
  expect(props.plugin.id).toBe('desktop');
  expect(props.plugins).toEqual([{ id: 'focus' }]);
  expect(props.settingsPanels).toEqual([{ category: 'voice', component: { name: 'WebSettings' } }]);
  expect(props.viewProps.nativeRuntime).toBe(false);
  expect(props.viewProps.draftStorage).toBeUndefined();
  expect(props.viewProps.surfaceNavigation.options.map((item: { value: string }) => item.value)).toEqual(['desktop', 'compact', 'proactive']);
  wrapper.unmount();
});

it('makes a failed native draft save visible while retaining the text for copying', async () => {
  window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null };
  request.mockResolvedValueOnce({ kind: 'preferences', values: {} });
  await hydrateNativeStorage();
  const wrapper = mount(App);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  request.mockRejectedValueOnce(new Error('private native error'));
  nativeStorage.setItem('aervox-mobile-draft:phone_session', '复制前保留的内容');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('草稿暂未保存到手机');
  expect(wrapper.text()).not.toContain('private native error');
  expect(nativeStorage.getItem('aervox-mobile-draft:phone_session')).toBe('复制前保留的内容');
  wrapper.unmount();
});
