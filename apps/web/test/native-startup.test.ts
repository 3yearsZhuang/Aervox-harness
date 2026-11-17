// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, type Component } from 'vue';
import App from '../src/App.vue';

const fixture = vi.hoisted(() => ({ load: vi.fn(), request: vi.fn() }));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: fixture.request }));
vi.mock('@aervox/ui/material3', () => ({ useMaterial3: () => false, useMobileBackNavigation: () => undefined }));
vi.mock('@aervox/plugin-proactive-ui', () => ({ default: {
  id: 'phone', apiVersion: 1, surface: 'main', platforms: ['web', 'desktop', 'mobile'], load: fixture.load,
} }));
vi.mock('@aervox/plugin-workbench-ui', () => ({ default: {
  id: 'web', apiVersion: 1, surface: 'main', platforms: ['web', 'desktop', 'mobile'], load: fixture.load,
}, compactSurface: {
  id: 'compact', apiVersion: 1, surface: 'main', platforms: ['web', 'desktop', 'mobile'], load: fixture.load,
} }));
vi.mock('@aervox/plugin-focus-mode/ui', () => ({ default: { id: 'focus' } }));
vi.mock('@aervox/plugin-flowcampus/ui', () => ({ default: { id: 'campus' } }));
vi.mock('@aervox/plugin-panels-ui', () => ({ settingsPanels: [] }));
vi.mock('../src/mobile/NativeRuntimePanel.vue', () => ({ default: { render: () => null } }));
vi.mock('element-plus/es/components/message/index.mjs', () => ({ ElMessage: { error: vi.fn() } }));

enableAutoUnmount(afterEach);
beforeEach(() => {
  fixture.load.mockReset();
  fixture.request.mockReset().mockResolvedValue({ kind: 'uiReady' });
  window.localStorage.clear();
});
afterEach(() => { delete window.AervoxM0Native; });
const view = () => defineComponent({ render: () => h('main', { 'data-phone-root': '' }, '本地会话') });
const native = () => { window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null }; };

it('keeps Android startup until the actual delayed surface mounts', async () => {
  native();
  let resolve!: (root: Component) => void;
  fixture.load.mockImplementation(() => new Promise<Component>(done => { resolve = done; }));
  fixture.request.mockImplementation(() => {
    expect(wrapper.get('[data-phone-root]').text()).toBe('本地会话');
    return Promise.resolve({ kind: 'uiReady' });
  });
  const wrapper = mount(App);
  await flushPromises();
  expect(wrapper.get('[role="status"]').text()).toContain('正在打开界面');
  expect(fixture.request).not.toHaveBeenCalled();
  resolve(view());
  await flushPromises();
  expect(fixture.request).toHaveBeenCalledOnce();
  expect(fixture.request).toHaveBeenCalledWith({ op: 'runtime', operation: 'uiReady' });
});

it('hands startup over to a rendered recovery screen after a surface load fails', async () => {
  native();
  fixture.load.mockRejectedValue(new Error('failed chunk'));
  fixture.request.mockImplementation(() => {
    expect(wrapper.get('[role="alert"]').text()).toContain('界面暂时无法打开');
    return Promise.resolve({ kind: 'uiReady' });
  });
  const wrapper = mount(App);
  await flushPromises();
  expect(fixture.request).toHaveBeenCalledOnce();
  expect(wrapper.find('[role="alert"]').exists()).toBe(true);
});

it.each(['ready', 'failed'])('does not notify Android for an ordinary Web %s surface', async state => {
  if (state === 'ready') fixture.load.mockResolvedValue(view());
  else fixture.load.mockRejectedValue(new Error('failed chunk'));
  const wrapper = mount(App);
  await flushPromises();
  expect(wrapper.text()).toContain(state === 'ready' ? '本地会话' : '界面暂时无法打开');
  expect(fixture.request).not.toHaveBeenCalled();
});

it.each(['reject', 'throw'])('preserves mounted UI when the readiness bridge %s fails', async failure => {
  native();
  fixture.load.mockResolvedValue(view());
  if (failure === 'reject') fixture.request.mockRejectedValue(new Error('missing receipt'));
  else fixture.request.mockImplementation(() => { throw new Error('bridge unavailable'); });
  const wrapper = mount(App);
  await flushPromises();
  expect(fixture.request).toHaveBeenCalledOnce();
  expect(wrapper.get('[data-phone-root]').text()).toBe('本地会话');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
});
