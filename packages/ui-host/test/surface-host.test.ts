import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, onUnmounted, type Component } from 'vue';
import { UISurfaceHost, useUISurfaceContext, type UISurfacePlugin, type UISurfaceContext } from '../src';

enableAutoUnmount(afterEach);
afterEach(() => vi.useRealTimers());
const view = (text: string) => defineComponent({ setup: () => () => h('div', text) });
const plugin = (root: Component = view('工作台')): UISurfacePlugin => ({
  id: 'test-view', apiVersion: 1, surface: 'main', platforms: ['web', 'desktop', 'mobile'],
  load: vi.fn(async () => root),
});
const open = (definition: UISurfacePlugin | null, extra = {}) =>
  mount(UISurfaceHost, { props: { plugin: definition, surface: 'main', platform: 'web', ...extra } });

describe('trusted root UI surfaces', () => {
  it('renders a selected root with host platform, view props and events', async () => {
    const selected = vi.fn();
    const root = defineComponent({
      props: ['platform', 'title'], emits: ['select'],
      setup: (props, { emit }) => () => h('button', { onClick: () => emit('select', props.platform) }, props.title),
    });
    const wrapper = mount(UISurfaceHost, {
      props: { plugin: plugin(root), surface: 'main', platform: 'mobile', viewProps: { title: '我的界面', platform: 'desktop' } },
      attrs: { onSelect: selected },
    });
    await flushPromises();
    expect(wrapper.text()).toBe('我的界面');
    await wrapper.get('button').trigger('click');
    expect(selected).toHaveBeenCalledWith('mobile');
  });

  it.each(['version', 'platform', 'surface', 'missing'])('rejects %s mismatch before loading code', async (kind) => {
    const definition = plugin();
    const candidate = kind === 'missing' ? null : {
      ...definition,
      ...(kind === 'version' ? { apiVersion: 2 } : {}),
      ...(kind === 'platform' ? { platforms: ['desktop'] } : {}),
      ...(kind === 'surface' ? { surface: 'companion' } : {}),
    } as UISurfacePlugin;
    const wrapper = open(candidate);
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('界面暂时无法打开');
    expect(definition.load).not.toHaveBeenCalled();
  });

  it('recovers from a synchronous load failure by retrying', async () => {
    const definition = plugin();
    definition.load = vi.fn().mockImplementationOnce(() => { throw new Error('broken chunk'); })
      .mockResolvedValue(view('恢复成功'));
    const wrapper = open(definition);
    await flushPromises();
    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toBe('恢复成功');
  });

  it('times out, aborts the loader, and ignores its late result', async () => {
    vi.useFakeTimers();
    let resolve!: (root: Component) => void;
    let signal!: AbortSignal;
    const definition = plugin();
    definition.load = vi.fn((s) => { signal = s; return new Promise((r) => { resolve = r; }); });
    const wrapper = open(definition, { loadTimeoutMs: 100 });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(true);
    resolve(view('迟到内容'));
    await flushPromises();
    expect(wrapper.text()).not.toContain('迟到内容');
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('a replaced loader cannot overwrite the current root', async () => {
    let resolve!: (root: Component) => void;
    const old = { ...plugin(), load: vi.fn(() => new Promise<Component>((r) => { resolve = r; })) };
    const wrapper = open(old);
    await flushPromises();
    await wrapper.setProps({ plugin: plugin(view('新界面')) });
    await flushPromises();
    resolve(view('旧界面'));
    await flushPromises();
    expect(wrapper.text()).toBe('新界面');
  });

  it('replaces even the same component with a fresh context and disposes the old instance', async () => {
    const contexts: UISurfaceContext[] = [];
    const disposed = vi.fn();
    const root = defineComponent({
      setup() { contexts.push(useUISurfaceContext()); onUnmounted(disposed); return () => h('div', 'mounted'); },
    });
    const wrapper = open(plugin(root));
    await flushPromises();
    await wrapper.setProps({ plugin: { ...plugin(root), id: 'replacement' } });
    await flushPromises();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(contexts[0].signal.aborted).toBe(true);
    expect(contexts[1].signal.aborted).toBe(false);
    wrapper.unmount();
    expect(contexts[1].signal.aborted).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it('keeps simultaneous window lifetimes independent', async () => {
    const contexts: UISurfaceContext[] = [];
    const root = defineComponent({
      setup() { contexts.push(useUISurfaceContext()); return () => h('div', 'window'); },
    });
    const definition = plugin(root);
    const a = open(definition);
    const b = open(definition);
    await flushPromises();
    a.unmount();
    expect(contexts[0].signal.aborted).toBe(true);
    expect(contexts[1].signal.aborted).toBe(false);
    expect(b.text()).toBe('window');
  });

  it('shows host recovery when a root throws while rendering', async () => {
    let context!: UISurfaceContext;
    const broken = defineComponent({
      setup() { context = useUISurfaceContext(); return () => { throw new Error('render failed'); }; },
    });
    const close = vi.fn();
    const wrapper = open(plugin(broken), { requestClose: close });
    await flushPromises();
    expect(context.signal.aborted).toBe(true);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    await wrapper.get('button:last-child').trigger('click');
    expect(close).toHaveBeenCalledOnce();
  });
});


it('only reloads the window after the user explicitly chooses host recovery', async () => {
  const reload = vi.fn();
  const wrapper = open(null, { requestReload: reload });
  await flushPromises();
  expect(reload).not.toHaveBeenCalled();
  const button = wrapper.findAll('button').find((b) => b.text() === '重新加载界面');
  await button!.trigger('click');
  expect(reload).toHaveBeenCalledOnce();
});
