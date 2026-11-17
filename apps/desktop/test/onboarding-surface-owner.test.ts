// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from '../src/renderer/src/App.vue';
import { UISurfaceHost } from '@aervox/ui-host';
import { OnboardingFlow } from '@aervox/plugin-panels-ui/onboarding';

const disposed = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/components/AppTitlebar.vue', () => ({ default: { render: () => null } }));
vi.mock('@aervox/ui-host', async () => {
  const { defineComponent, onBeforeUnmount, ref } = await import('vue');
  return {
    UISurfaceHost: defineComponent({ name: 'UISurfaceHost', setup() {
      const draft = ref('原草稿'); onBeforeUnmount(disposed); return { draft };
    }, template: '<main><textarea v-model="draft" /><span>原会话 · 未知请求原键</span></main>' }),
    resolveSurfaceChoice: (surfaces: unknown[]) => surfaces[0], createSurfaceNavigation: () => ({}),
  };
});
vi.mock('@aervox/plugin-workbench-ui', () => ({ default: { id: 'desktop' }, compactSurface: { id: 'compact' } }));
vi.mock('@aervox/plugin-proactive-ui', () => ({ default: { id: 'proactive' } }));
vi.mock('@aervox/plugin-focus-mode/ui', () => ({ default: { id: 'focus' } }));
vi.mock('@aervox/plugin-flowcampus/ui', () => ({ default: { id: 'campus' } }));
vi.mock('@aervox/plugin-panels-ui', () => ({ settingsPanels: [] }));
vi.mock('@aervox/plugin-panels-ui/onboarding', async () => {
  const { defineComponent } = await import('vue');
  return { OnboardingFlow: defineComponent({ props: ['replay'], emits: ['complete', 'dismiss'], template: '<main>首次设置</main>' }) };
});
afterEach(() => { localStorage.clear(); vi.clearAllMocks(); });

it('mounts the first surface only after explicit completion and retains its owner through replay', async () => {
  const wrapper = mount(App); await flushPromises();
  expect(wrapper.findComponent(UISurfaceHost).exists()).toBe(false);
  wrapper.getComponent(OnboardingFlow).vm.$emit('complete'); await flushPromises();
  const surface = wrapper.getComponent(UISurfaceHost);
  await surface.get('textarea').setValue('等待原请求确认期间的草稿');
  const input = surface.get('textarea').element;
  window.dispatchEvent(new Event('aervox:configure-companion')); await flushPromises();
  expect(disposed).not.toHaveBeenCalled();
  expect(wrapper.getComponent(UISurfaceHost).vm.$.uid).toBe(surface.vm.$.uid);
  wrapper.getComponent(OnboardingFlow).vm.$emit('dismiss'); await flushPromises();
  expect(wrapper.getComponent(UISurfaceHost).vm.$.uid).toBe(surface.vm.$.uid);
  expect(surface.get('textarea').element).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe('等待原请求确认期间的草稿');
  expect(surface.text()).toContain('原会话 · 未知请求原键');
  expect(disposed).not.toHaveBeenCalled();
  wrapper.unmount();
});
