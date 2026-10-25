import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { PluginPageDto, PluginSummaryDto } from '@aervox/api-client';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(), saveConfig: vi.fn(), listPages: vi.fn(),
  info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(),
}));
vi.mock('@aervox/api-client', () => ({
  useAervoxClient: () => ({apiBase: 'http://localhost:3000'}),
  useAervoxPlugins: () => ({ getConfig: mocks.getConfig, saveConfig: mocks.saveConfig, listPages: mocks.listPages }),
}));
vi.mock('@aervox/ui/utils/element', () => ({ ElMessage: mocks }));
vi.mock('@aervox/ui/primitives', () => ({
  AervoxDialog: { name: 'AervoxDialog', emits: ['close'], template: '<section><slot /></section>' },
  AervoxButton: { emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' },
}));
import PluginPageDialog from '../src/plugin/PluginPageDialog.vue';

const plugin = { id: 'probe', enabled: 1, availability: 'available', lifecycleGeneration: 'generation-1' } as PluginSummaryDto;
const page = { id: 'settings', pageGeneration: 'page-1', entry: 'pages/settings/index.html', capabilities: ['config.read', 'config.write', 'host.notify', 'host.close'] } as PluginPageDto;
let wrapper: VueWrapper;

async function connect() {
  await flushPromises();
  const frame = wrapper.find('iframe');
  const target = { postMessage: vi.fn() };
  Object.defineProperty(frame.element, 'contentWindow', { configurable: true, get: () => target });
  await frame.trigger('load');
  await flushPromises();
  const init = target.postMessage.mock.calls.find(([message]) => message.type === 'aervox:page:init')![0];
  return { target, nonce: init.nonce };
}

function send(target: unknown, nonce: string, method: string, id = 'request', args: unknown = {}) {
  window.dispatchEvent(new MessageEvent('message', {
    source: target as Window, origin: 'null',
    data: { type: 'aervox:page:call', nonce, method, id, args },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.getConfig.mockResolvedValue({ revision: 3, values: { value: 'current' } });
  mocks.saveConfig.mockResolvedValue({ revision: 4, values: {} });
  mocks.listPages.mockResolvedValue([page]);
  wrapper = mount(PluginPageDialog, { props: { open: true, plugin, page } });
});
afterEach(() => { wrapper.unmount(); vi.useRealTimers(); });

describe('Plugin Page session boundary', () => {
  it('does not mount executable content until the captured Page passes persistent admission', async () => {
    wrapper.unmount();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    wrapper = mount(PluginPageDialog, { props: { open: true, plugin, page } });
    expect(wrapper.find('iframe').exists()).toBe(false);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
    finish([page]);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(true);
  });

  it.each(['missing', 'generation', 'entry', 'capabilities'] as const)('destroys a silent Page when persisted %s changes and never revives it from later success', async change => {
    const old = await connect();
    const persisted = change === 'missing' ? [] : [{ ...page,
      ...(change === 'generation' ? { pageGeneration: 'page-2' } : {}),
      ...(change === 'entry' ? { entry: 'pages/settings/other.html' } : {}),
      ...(change === 'capabilities' ? { capabilities: [] } : {}),
    }];
    mocks.listPages.mockResolvedValue(persisted);
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').text()).toBeTruthy();
    const queries = mocks.listPages.mock.calls.length;
    mocks.listPages.mockResolvedValue([page]);
    await vi.advanceTimersByTimeAsync(12000);
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(mocks.listPages).toHaveBeenCalledTimes(queries);
    expect(wrapper.find('iframe').exists()).toBe(false);
    send(old.target, old.nonce, 'notify', 'old-silent-frame', { message: 'old' });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('settles a silent eligibility source locally after five seconds even when it ignores abort', async () => {
    await connect();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const before = mocks.listPages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.listPages).toHaveBeenCalledTimes(before + 1);
    const signal = mocks.listPages.mock.calls.at(-1)![2] as AbortSignal;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(mocks.listPages).toHaveBeenCalledTimes(before + 1);
    expect(wrapper.find('iframe').exists()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(wrapper.find('iframe').exists()).toBe(false);
    finish([page]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(6000);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(mocks.listPages).toHaveBeenCalledTimes(before + 1);
  });

  it('bounds initial admission and ignores its success after close or timeout', async () => {
    wrapper.unmount();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    wrapper = mount(PluginPageDialog, { props: { open: true, plugin, page } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    const signal = mocks.listPages.mock.calls.at(-1)![2] as AbortSignal;
    expect(signal.aborted).toBe(true);
    finish([page]);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('does not let document reloads extend a pending qualification deadline', async () => {
    const old = await connect();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const before = mocks.listPages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    const signal = mocks.listPages.mock.calls.at(-1)![2] as AbortSignal;
    for (let reload = 0; reload < 4; reload++) {
      await wrapper.find('iframe').trigger('load');
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(mocks.listPages).toHaveBeenCalledTimes(before + 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    expect(wrapper.find('iframe').exists()).toBe(false);
    finish([page]);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(old.target.postMessage.mock.calls.filter(([message]) => message.type === 'aervox:page:init')).toHaveLength(1);
  });

  it('initializes only the latest loaded document after a shared qualification completes', async () => {
    const old = await connect();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const before = mocks.listPages.mock.calls.length;
    await wrapper.find('iframe').trigger('load');
    await flushPromises();
    await wrapper.find('iframe').trigger('load');
    await flushPromises();
    expect(mocks.listPages).toHaveBeenCalledTimes(before + 1);
    finish([page]);
    await flushPromises();
    const initializations = old.target.postMessage.mock.calls.filter(([message]) => message.type === 'aervox:page:init');
    expect(initializations).toHaveLength(2);
    expect(initializations[1]![0].nonce).not.toBe(old.nonce);
  });

  it('destroys an active document on focus revalidation before the next poll', async () => {
    await connect();
    mocks.listPages.mockRejectedValue(new Error('plugin lifecycle changed'));
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('aborts observation on close and a late result cannot kill a freshly reopened owner', async () => {
    const old = await connect();
    let finish!: (value: unknown) => void;
    mocks.listPages.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    const signal = mocks.listPages.mock.calls.at(-1)![2] as AbortSignal;
    await wrapper.setProps({ open: false });
    expect(signal.aborted).toBe(true);
    await wrapper.setProps({ open: true });
    const current = await connect();
    expect(current.nonce).not.toBe(old.nonce);
    finish([]);
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(true);
  });

  it('requests a fresh parent capture on explicit refresh instead of reopening with stale props', async () => {
    const old = await connect();
    const before = mocks.listPages.mock.calls.length;
    await wrapper.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(mocks.listPages).toHaveBeenCalledTimes(before);
    send(old.target, old.nonce, 'getConfig');
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it('ignores the dialog close emitted by a programmatic hide during fresh opening', async () => {
    await connect();
    await wrapper.findAll('button')[0]!.trigger('click');
    await wrapper.setProps({ open: false });
    wrapper.findComponent({ name: 'AervoxDialog' }).vm.$emit('close');
    expect(wrapper.emitted('close')).toBeUndefined();
    await wrapper.setProps({ open: true });
    await connect();
    expect(wrapper.find('iframe').exists()).toBe(true);
  });

  it('latches the same open Page after observed identity change until explicit close and reopen', async () => {
    await connect();
    const restored = { ...page, pageGeneration: 'page-2' };
    mocks.listPages.mockResolvedValue([restored]);
    await wrapper.setProps({ page: restored });
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(8000);
    expect(wrapper.find('iframe').exists()).toBe(false);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await connect();
    expect(wrapper.find('iframe').exists()).toBe(true);
  });

  it('drops late Bridge configuration after a silent observer invalidates its owner', async () => {
    const old = await connect();
    let finish!: (value: unknown) => void;
    mocks.getConfig.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    send(old.target, old.nonce, 'getConfig');
    await flushPromises();
    mocks.listPages.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper.find('iframe').exists()).toBe(false);
    finish({ revision: 99, values: { privateValue: 'late' } });
    await flushPromises();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
  });

  it.each(['getConfig', 'saveConfig', 'notify', 'close'])('rejects %s when the same Page id is registered again with restored capabilities', async method => {
    const { target, nonce } = await connect();
    mocks.listPages.mockResolvedValue([{ ...page, pageGeneration: 'page-3' }]);
    send(target, nonce, method, 'restored-page', { message: 'restored notification' });
    await flushPromises();
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: 'page session is unavailable' }), '*');
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it.each(['getConfig', 'saveConfig'])('withholds a late %s response after the Page is registered again', async method => {
    const { target, nonce } = await connect();
    mocks.listPages.mockResolvedValueOnce([page]).mockResolvedValue([{ ...page, pageGeneration: 'page-2' }]);
    send(target, nonce, method);
    await flushPromises();
    expect(mocks[method as 'getConfig' | 'saveConfig']).toHaveBeenCalledTimes(1);
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: 'page session is unavailable' }), '*');
    expect(target.postMessage.mock.calls.some(([message]) => message.value?.values)).toBe(false);
  });

  it.each([undefined, '', null, 7, 'x'.repeat(129)])('does not mount a Page without a valid registration generation: %j', async pageGeneration => {
    const old = await connect();
    await wrapper.setProps({ page: { ...page, pageGeneration } as PluginPageDto });
    expect(wrapper.find('iframe').exists()).toBe(false);
    send(old.target, old.nonce, 'getConfig');
    await flushPromises();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it('rotates the document when the host observes a new Page generation and rejects the old response', async () => {
    let finish!: (value: unknown) => void;
    mocks.getConfig.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const old = await connect();
    const oldFrame = wrapper.find('iframe').element;
    send(old.target, old.nonce, 'getConfig');
    await flushPromises();
    const restored = { ...page, pageGeneration: 'page-3' };
    mocks.listPages.mockResolvedValue([restored]);
    await wrapper.setProps({ page: restored });
    expect(wrapper.find('iframe').exists()).toBe(false);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find('iframe').element).not.toBe(oldFrame);
    const current = await connect();
    expect(current.nonce).not.toBe(old.nonce);
    finish({ revision: 99, values: { privateValue: 'old page' } });
    await flushPromises();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    send(current.target, current.nonce, 'saveConfig', 'new-page', { values: { fresh: true } });
    await flushPromises();
    expect(mocks.saveConfig).toHaveBeenLastCalledWith('probe', expect.objectContaining({ expectedPageGeneration: 'page-3', revision: 0 }));
  });

  it.each(['getConfig', 'saveConfig', 'notify', 'close'])('rechecks the persisted lifecycle before %s while host props are stale', async method => {
    const { target, nonce } = await connect();
    mocks.listPages.mockRejectedValue(new Error('plugin lifecycle changed; reopen the page'));
    send(target, nonce, method, 'old-generation', { message: 'late notification' });
    await flushPromises();
    expect(mocks.listPages).toHaveBeenCalledWith('probe', 'generation-1', expect.any(AbortSignal));
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('lifecycle changed') }), '*');
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it.each(['getConfig', 'saveConfig', 'notify', 'close'])('rejects %s after the persisted Page capability is removed', async method => {
    const { target, nonce } = await connect();
    mocks.listPages.mockResolvedValue([{ ...page, capabilities: [] }]);
    send(target, nonce, method);
    await flushPromises();
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('capability') }), '*');
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it.each(['notify', 'close'])('drops a late authorization result for %s after the document session rotates', async method => {
    let finish!: (value: unknown) => void;
    const old = await connect();
    mocks.listPages.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    send(old.target, old.nonce, method, 'late-auth', { message: 'late notification' });
    await flushPromises();
    await wrapper.find('iframe').trigger('load');
    await flushPromises();
    finish([page]);
    await flushPromises();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
  });

  it('rejects an absent persisted Page without disclosing configuration', async () => {
    const { target, nonce } = await connect();
    mocks.listPages.mockResolvedValue([]);
    send(target, nonce, 'getConfig');
    await flushPromises();
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: 'page session is unavailable' }), '*');
  });

  it('binds a save to the captured Page identity and ignores forged Bridge identity arguments', async () => {
    const { target, nonce } = await connect();
    send(target, nonce, 'saveConfig', 'forged-page', {
      values: { fresh: true }, expectedPageId: 'other-page', pageId: 'other-page',
      expectedLifecycleGeneration: 'forged-generation',
      expectedPageGeneration: 'forged-page-generation', pageGeneration: 'forged-page-generation',
    });
    await flushPromises();
    expect(mocks.saveConfig).toHaveBeenCalledWith('probe', {
      revision: 0, values: { fresh: true }, secretValues: {},
      expectedLifecycleGeneration: 'generation-1', expectedPageId: 'settings', expectedPageGeneration: 'page-1',
    });
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }), '*');
  });

  it('binds a read to the captured Page identity and ignores forged Bridge identity arguments', async () => {
    const { target, nonce } = await connect();
    send(target, nonce, 'getConfig', 'forged-read', {
      expectedPageId: 'other-page', expectedPageGeneration: 'forged-page-generation',
      expectedLifecycleGeneration: 'forged-generation',
    });
    await flushPromises();
    expect(mocks.getConfig).toHaveBeenCalledWith('probe', 'generation-1', {
      expectedPageId: 'settings', expectedPageGeneration: 'page-1',
    });
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true }), '*');
  });

  it.each(['getConfig', 'saveConfig'])('withholds a late %s receipt when its Page capability was revoked during the request', async method => {
    const { target, nonce } = await connect();
    const beforeQueries = mocks.listPages.mock.calls.length;
    mocks.listPages.mockResolvedValueOnce([page]).mockResolvedValue([{ ...page, capabilities: [] }]);
    send(target, nonce, method);
    await flushPromises();
    expect(mocks[method as 'getConfig' | 'saveConfig']).toHaveBeenCalledTimes(1);
    expect(mocks.listPages).toHaveBeenCalledTimes(beforeQueries + 2);
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('capability') }), '*');
    expect(target.postMessage.mock.calls.some(([message]) => message.value?.values)).toBe(false);
  });
  it('uses the declared nested entry with individually encoded path segments', async () => {
    await wrapper.setProps({ open: false });
    const nested = { ...page, entry: 'pages/settings/nested dir/配置.html' };
    mocks.listPages.mockResolvedValue([nested]);
    await wrapper.setProps({ open: true, page: nested });
    await flushPromises();
    expect(wrapper.find('iframe').attributes('src')).toBe(
      'http://localhost:3000/v1/plugins/probe/pages/settings/assets/nested%20dir/%E9%85%8D%E7%BD%AE.html',
    );
  });

  it.each([
    'pages/other/index.html',
    'pages/settings/../other/index.html',
    'pages/settings/nested/../../index.html',
    'pages/settings/nested\\index.html',
    'pages/settings//index.html',
  ])('does not mount an entry outside the page directory: %s', async entry => {
    await wrapper.setProps({ page: { ...page, entry } });
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('requires the current iframe window and nonce before calling the API', async () => {
    const { target, nonce } = await connect();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    send({}, nonce, 'getConfig');
    send(target, 'wrong', 'getConfig');
    await flushPromises();
    expect(mocks.getConfig).not.toHaveBeenCalled();
    send(target, nonce, 'getConfig');
    await flushPromises();
    expect(mocks.getConfig).toHaveBeenCalledWith('probe', 'generation-1', { expectedPageId: 'settings', expectedPageGeneration: 'page-1' });
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'aervox:page:result', ok: true, nonce }), '*');
  });

  it.each(['getConfig', 'saveConfig', 'notify', 'close'])('requires the declared capability for %s', async method => {
    await wrapper.setProps({ open: false });
    const limited = { ...page, capabilities: [] };
    mocks.listPages.mockResolvedValue([limited]);
    await wrapper.setProps({ open: true, page: limited });
    const { target, nonce } = await connect();
    send(target, nonce, method);
    await flushPromises();
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining('capability') }), '*');
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it.each([{ enabled: 0 }, { availability: 'missing' }])('destroys the iframe when the plugin becomes unavailable: %j', async state => {
    const { target, nonce } = await connect();
    await wrapper.setProps({ plugin: { ...plugin, ...state } as PluginSummaryDto });
    expect(wrapper.find('iframe').exists()).toBe(false);
    send(target, nonce, 'notify', 'late', { message: 'late' });
    await flushPromises();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('does not execute a Page without a lifecycle generation: %j', async lifecycleGeneration => {
    const old = await connect();
    await wrapper.setProps({ plugin: { ...plugin, lifecycleGeneration } });
    expect(wrapper.find('iframe').exists()).toBe(false);
    send(old.target, old.nonce, 'getConfig');
    await flushPromises();
    expect(mocks.getConfig).not.toHaveBeenCalled();
  });

  it.each(['getConfig', 'saveConfig'])('rotates an enabled same-id Page when its lifecycle changes and drops the old %s response', async method => {
    let finish!: (value: unknown) => void;
    mocks[method as 'getConfig' | 'saveConfig'].mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const old = await connect();
    const oldFrame = wrapper.find('iframe').element;
    send(old.target, old.nonce, method);
    await flushPromises();
    await wrapper.setProps({ plugin: { ...plugin, lifecycleGeneration: 'generation-2' } });
    expect(wrapper.find('iframe').exists()).toBe(false);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find('iframe').element).not.toBe(oldFrame);
    const current = await connect();
    expect(current.nonce).not.toBe(old.nonce);
    send(old.target, old.nonce, 'notify', 'late-window', { message: 'old document' });
    send(current.target, old.nonce, 'notify', 'late-nonce', { message: 'old nonce' });
    finish({ revision: 99, values: { privateValue: 'old lifecycle' } });
    await flushPromises();
    expect(mocks.info).not.toHaveBeenCalled();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    expect(current.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    mocks.getConfig.mockResolvedValue({ revision: 3, values: {} });
    mocks.saveConfig.mockResolvedValue({ revision: 4, values: {} });
    send(current.target, current.nonce, 'saveConfig', 'current-write', { values: { fresh: true } });
    await flushPromises();
    expect(mocks.saveConfig).toHaveBeenLastCalledWith('probe', {
      revision: 0, values: { fresh: true }, secretValues: {}, expectedLifecycleGeneration: 'generation-2', expectedPageId: 'settings', expectedPageGeneration: 'page-1',
    });
    send(current.target, current.nonce, 'getConfig', 'current-read');
    await flushPromises();
    expect(mocks.getConfig).toHaveBeenLastCalledWith('probe', 'generation-2', { expectedPageId: 'settings', expectedPageGeneration: 'page-1' });
  });

  it('does not deliver old configuration to a new plugin session or change its revision', async () => {
    let finish!: (value: unknown) => void;
    mocks.getConfig.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const old = await connect();
    send(old.target, old.nonce, 'getConfig');
    await wrapper.setProps({ plugin: { ...plugin, id: 'other' } });
    const current = await connect();
    finish({ revision: 99, values: { privateValue: 'old plugin' } });
    await flushPromises();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    expect(current.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    send(current.target, current.nonce, 'saveConfig', 'save', { values: { fresh: true } });
    await flushPromises();
    expect(mocks.saveConfig).toHaveBeenCalledWith('other', {
      revision: 0, values: { fresh: true }, secretValues: {}, expectedLifecycleGeneration: 'generation-1', expectedPageId: 'settings', expectedPageGeneration: 'page-1',
    });
  });

  it('rotates the document session on reload and drops a previous document response', async () => {
    let finish!: (value: unknown) => void;
    mocks.getConfig.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const old = await connect();
    send(old.target, old.nonce, 'getConfig');
    await wrapper.find('iframe').trigger('load');
    await flushPromises();
    const lastInit = old.target.postMessage.mock.calls.at(-1)![0];
    expect(lastInit.nonce).not.toBe(old.nonce);
    finish({ revision: 9, values: {} });
    await flushPromises();
    expect(old.target.postMessage.mock.calls.some(([message]) => message.type === 'aervox:page:result')).toBe(false);
    send(old.target, old.nonce, 'notify', 'old', { message: 'replay' });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('refresh mounts a new document that can reload the current configuration before saving', async () => {
    const old = await connect();
    send(old.target, old.nonce, 'getConfig');
    await flushPromises();
    const previousFrame = wrapper.find('iframe').element;
    await wrapper.findAll('button')[0]!.trigger('click');
    expect(wrapper.emitted('refresh')).toHaveLength(1);
    expect(wrapper.find('iframe').exists()).toBe(false);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(wrapper.find('iframe').element).not.toBe(previousFrame);
    const current = await connect();
    expect(current.nonce).not.toBe(old.nonce);
    send(current.target, current.nonce, 'getConfig', 'read-after-refresh');
    await flushPromises();
    send(current.target, current.nonce, 'saveConfig', 'save-after-refresh', { values: { fresh: true } });
    await flushPromises();
    expect(mocks.getConfig).toHaveBeenCalledTimes(2);
    expect(mocks.saveConfig).toHaveBeenCalledWith('probe', {
      revision: 3, values: { fresh: true }, secretValues: {}, expectedLifecycleGeneration: 'generation-1', expectedPageId: 'settings', expectedPageGeneration: 'page-1',
    });
  });

  it('closes immediately and does not leave a callable frame while the parent handles the close event', async () => {
    const { target, nonce } = await connect();
    send(target, nonce, 'close');
    await flushPromises();
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(wrapper.find('iframe').exists()).toBe(false);
    send(target, nonce, 'notify', 'late', { message: 'late' });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it('sends theme changes as context updates without resetting the document session', async () => {
    const { target, nonce } = await connect();
    await wrapper.setProps({ theme: 'dark' });
    expect(target.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'aervox:page:context', nonce, context: expect.objectContaining({ theme: 'dark' }) }), '*');
  });
});
