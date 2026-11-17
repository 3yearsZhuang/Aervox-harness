// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from '../src/App.vue';
import { UISurfaceHost } from '@aervox/ui-host';
import { hydrateNativeStorage, nativeStorage } from '../src/mobile/native-storage';
import { OnboardingFlow } from '@aervox/plugin-panels-ui/onboarding';

const request = vi.hoisted(() => vi.fn());
const surfaceDisposed = vi.hoisted(() => vi.fn());
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));

vi.mock('@aervox/ui-host', async () => {
  const { defineComponent, onBeforeUnmount, ref } = await import('vue');
  return {
    UISurfaceHost: defineComponent({ name: 'UISurfaceHost', props: ['plugin', 'plugins', 'settingsPanels', 'viewProps'], setup() {
      const draft = ref('原草稿'); onBeforeUnmount(surfaceDisposed); return { draft };
    }, template: '<main><textarea v-model="draft" /><span>原会话 · 未知请求原键</span></main>' }),
    resolveWebPlatform: () => 'mobile',
    resolveSurfaceChoice: (surfaces: { id: string }[]) => surfaces[0],
    createSurfaceNavigation: (surfaces: { id: string }[]) => ({ currentId: surfaces[0]!.id, options: surfaces.map(item => ({ value: item.id, label: item.id })) }),
  };
});
vi.mock('@aervox/ui/material3', () => ({ useMaterial3: () => true, useMobileBackNavigation: () => undefined }));
vi.mock('@aervox/plugin-workbench-ui', () => ({ default: { id: 'desktop' }, compactSurface: { id: 'compact' } }));
vi.mock('@aervox/plugin-proactive-ui', () => ({ default: { id: 'proactive' } }));
vi.mock('@aervox/plugin-focus-mode/ui', () => ({ default: { id: 'focus' } }));
vi.mock('@aervox/plugin-flowcampus/ui', () => ({ default: { id: 'campus' } }));
vi.mock('@aervox/plugin-panels-ui', () => ({ settingsPanels: [{ category: 'voice', component: { name: 'WebSettings' } }] }));
vi.mock('@aervox/plugin-panels-ui/onboarding', async () => {
  const { defineComponent } = await import('vue');
  return { OnboardingFlow: defineComponent({ name: 'OnboardingFlow', props: ['replay', 'modelSetup'], emits: ['complete', 'dismiss', 'ready'], template: '<main class="shared-first-run-fixture" />' }) };
});
vi.mock('../src/mobile/NativeRuntimePanel.vue', () => ({ default: { name: 'NativeRuntimePanel', render: () => null } }));
vi.mock('../src/mobile/NativeLearningPanel.vue', () => ({ default: { name: 'NativeLearningPanel', render: () => null } }));
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: vi.fn() } }));
afterEach(() => { delete window.AervoxM0Native; localStorage.clear(); });

it('injects the native learning panel while retaining only the independent surface and native settings', () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
  window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null };
  const wrapper = mount(App);
  const props = wrapper.getComponent(UISurfaceHost).props();
  expect(props.plugin.id).toBe('proactive');
  expect(props.plugins).toEqual([]);
  expect(props.settingsPanels).toEqual([{ category: 'model', component: expect.objectContaining({ name: 'NativeRuntimePanel' }) }]);
  expect(props.viewProps.nativeRuntime).toBe(true);
  expect(props.viewProps.draftStorage).toBe(nativeStorage);
  expect(props.viewProps.learningPanel).toEqual(expect.objectContaining({ name: 'NativeLearningPanel' }));
  expect(props.viewProps.surfaceNavigation.options.map((item: { value: string }) => item.value)).toEqual(['proactive']);
  wrapper.unmount();
});

it('preserves the existing web surfaces, first-party plugin and settings when no native host is present', () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
  const wrapper = mount(App);
  const props = wrapper.getComponent(UISurfaceHost).props();
  expect(props.plugin.id).toBe('desktop');
  expect(props.plugins).toEqual([{ id: 'focus' }, { id: 'campus' }]);
  expect(props.settingsPanels).toEqual([{ category: 'voice', component: { name: 'WebSettings' } }]);
  expect(props.viewProps.nativeRuntime).toBe(false);
  expect(props.viewProps.draftStorage).toBeUndefined();
  expect(props.viewProps.learningPanel).toBeUndefined();
  expect(props.viewProps.surfaceNavigation.options.map((item: { value: string }) => item.value)).toEqual(['desktop', 'compact', 'proactive']);
  wrapper.unmount();
});

it('makes a failed native draft save visible while retaining the text for copying', async () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
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

it('uses the shared first-run flow with native model setup and completes only on an explicit event', async () => {
  window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null };
  const wrapper = mount(App);
  await flushPromises();
  const flow = wrapper.getComponent(OnboardingFlow);
  expect(flow.props('replay')).toBe(false);
  expect(flow.props('modelSetup')).toEqual(expect.objectContaining({ name: 'NativeRuntimePanel' }));
  expect(wrapper.findComponent(UISurfaceHost).exists()).toBe(false);
  expect(localStorage.getItem('aervox.onboarding.completed.v1')).toBeNull();
  flow.vm.$emit('complete'); await flushPromises();
  expect(wrapper.getComponent(UISurfaceHost).props('plugins')).toEqual([]);
  expect(localStorage.getItem('aervox.onboarding.completed.v1')).toBe('true');
  wrapper.unmount();
});

it('replays shared setup from the UI event and preserves the completion marker on dismissal', async () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
  const wrapper = mount(App);
  window.dispatchEvent(new Event('aervox:configure-companion')); await flushPromises();
  const flow = wrapper.getComponent(OnboardingFlow);
  expect(flow.props('replay')).toBe(true);
  expect(flow.props('modelSetup')).toBeUndefined();
  flow.vm.$emit('dismiss'); await flushPromises();
  expect(wrapper.getComponent(UISurfaceHost).props('plugins')).toEqual([{ id: 'focus' }, { id: 'campus' }]);
  expect(localStorage.getItem('aervox.onboarding.completed.v1')).toBe('true');
  wrapper.unmount();
});

it('retains the mounted surface instance, draft and unknown request owner during replay and dismissal', async () => {
  localStorage.setItem('aervox.onboarding.completed.v1', 'true');
  const wrapper = mount(App);
  const surface = wrapper.getComponent(UISurfaceHost);
  await surface.get('textarea').setValue('未确认请求期间的新草稿');
  const input = surface.get('textarea').element;
  const before = surfaceDisposed.mock.calls.length;
  window.dispatchEvent(new Event('aervox:configure-companion')); await flushPromises();
  expect(surfaceDisposed.mock.calls.length).toBe(before);
  expect(wrapper.getComponent(UISurfaceHost).vm.$.uid).toBe(surface.vm.$.uid);
  wrapper.getComponent(OnboardingFlow).vm.$emit('dismiss'); await flushPromises();
  expect(wrapper.getComponent(UISurfaceHost).vm.$.uid).toBe(surface.vm.$.uid);
  expect(surface.get('textarea').element).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('未确认请求期间的新草稿');
  expect(surface.text()).toContain('原会话 · 未知请求原键');
  expect(surfaceDisposed.mock.calls.length).toBe(before);
  wrapper.unmount();
});
