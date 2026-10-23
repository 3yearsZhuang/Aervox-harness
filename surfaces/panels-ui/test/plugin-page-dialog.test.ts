import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { PluginPageDto, PluginSummaryDto } from '@aervox/api-client';
import { ElMessage } from '@aervox/ui/utils/element';
import PluginPageDialog from '../src/plugin/PluginPageDialog.vue';

const mockGetConfig = vi.fn().mockResolvedValue({
  revision: 1,
  values: { theme: 'dark' },
  secretFields: {},
});
const mockSaveConfig = vi.fn().mockResolvedValue({
  revision: 2,
  values: { theme: 'light' },
  secretFields: {},
});
const mockListPages = vi.fn().mockResolvedValue([{
  id: 'dashboard', capabilities: ['config.read', 'config.write', 'host.notify', 'host.close'],
}]);

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    getApiBase: () => 'http://127.0.0.1:3000',
    useAervoxPlugins: () => ({
      getConfig: mockGetConfig,
      saveConfig: mockSaveConfig,
      listPages: mockListPages,
    }),
  };
});

vi.mock('@aervox/ui/utils/element', () => ({
  ElMessage: {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

describe('PluginPageDialog.vue (ITER-006 / FND-03 安全沙箱)', () => {
  const mockPlugin: PluginSummaryDto = {
    id: 'test-plugin',
    publisher: 'test',
    version: '1.0.0',
    enabled: 1,
    lifecycleGeneration: 'test-plugin-generation',
    installSource: 'builtin',
    configSchemaJson: [],
    proactiveSpecJson: null,
    spec: null,
    createdAt: '2026-10-15',
    updatedAt: '2026-10-15',
  } as unknown as PluginSummaryDto;

  const mockPage: PluginPageDto = {
    id: 'dashboard',
    title: '测试页面',
    entry: 'pages/dashboard/index.html',
    capabilities: ['config.read', 'config.write', 'host.notify', 'host.close'],
  };

  const stubs = {
    AervoxDialog: defineComponent({
      name: 'AervoxDialog',
      props: ['modelValue', 'title', 'subtitle', 'icon', 'size', 'width', 'bodyMaxHeight'],
      emits: ['close'],
      setup(props, { slots }) {
        return () => (props.modelValue ? h('div', { class: 'dialog-stub' }, slots.default?.()) : null);
      },
    }),
    AervoxButton: defineComponent({
      name: 'AervoxButton',
      props: ['size', 'variant'],
      setup(_props, { slots }) {
        return () => h('button', slots.default?.());
      },
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Model a stable WindowProxy per iframe without happy-dom loading its URL.
    const windows = new WeakMap<HTMLIFrameElement, Window>();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
      let target = windows.get(this);
      if (!target) {
        target = { postMessage() {} } as unknown as Window;
        windows.set(this, target);
      }
      return target;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('使用 128 位密码学随机 Nonce 并发送 init 消息到 iframe', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage,
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    expect(iframeEl).toBeTruthy();
    expect(iframeEl.src).toContain('/v1/plugins/test-plugin/pages/dashboard/assets/index.html');

    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();

    expect(postMessageSpy).toHaveBeenCalled();
    const initMsg = postMessageSpy.mock.calls[0]![0] as { type: string; nonce: string; context: unknown };
    expect(initMsg.type).toBe('aervox:page:init');
    expect(typeof initMsg.nonce).toBe('string');
    // 16 个随机字节以十六进制编码；不回退到 Math.random。
    expect(initMsg.nonce).toMatch(/^[0-9a-f]{32}$/i);

    wrapper.unmount();
  });

  it('拒绝对外部窗口（非当前 iframe）来源的 Bridge 调用消息', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage,
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    const nonce = (postMessageSpy.mock.calls[0]![0] as { nonce: string }).nonce;
    postMessageSpy.mockClear();

    // 来自外部非 iframe 窗口的消息
    const foreignWindow = {} as Window;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-1',
          nonce,
          method: 'notify',
          args: { message: 'hacked' },
        },
        source: foreignWindow,
      }),
    );

    await flushPromises();
    expect(ElMessage.info).not.toHaveBeenCalled();
    expect(postMessageSpy).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('拒绝 Nonce 不匹配的 Bridge 调用', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage,
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    postMessageSpy.mockClear();

    // Nonce 不匹配
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-2',
          nonce: 'invalid-nonce',
          method: 'notify',
          args: { message: 'bad-nonce' },
        },
        source: contentWindow,
      }),
    );

    await flushPromises();
    expect(ElMessage.info).not.toHaveBeenCalled();
    expect(postMessageSpy).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('插件禁用时销毁 iframe 并拒绝原窗口的迟到 Bridge 调用', async () => {
    const disabledPlugin: PluginSummaryDto = {
      ...mockPlugin,
      enabled: 0,
    };

    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage,
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    const nonce = (postMessageSpy.mock.calls[0]![0] as { nonce: string }).nonce;
    postMessageSpy.mockClear();

    await wrapper.setProps({ plugin: disabledPlugin });
    expect(wrapper.find('iframe').exists()).toBe(false);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-disabled',
          nonce,
          method: 'getConfig',
        },
        source: contentWindow,
      }),
    );

    await flushPromises();
    expect(postMessageSpy).not.toHaveBeenCalled();
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('初始已禁用的插件不创建可执行 iframe', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: { open: true, plugin: { ...mockPlugin, enabled: 0 }, page: mockPage },
      global: { stubs },
    });
    await flushPromises();
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(mockGetConfig).not.toHaveBeenCalled();
    expect(mockSaveConfig).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('缺少对应 capability 时拒绝 notify 与 close', async () => {
    const limitedPage: PluginPageDto = {
      id: 'limited',
      title: '受限页面',
      entry: 'pages/limited/index.html',
      capabilities: [], // 无 host.notify，无 host.close
    };

    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: limitedPage,
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    const nonce = (postMessageSpy.mock.calls[0]![0] as { nonce: string }).nonce;
    postMessageSpy.mockClear();

    // 缺少 host.notify
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-notify',
          nonce,
          method: 'notify',
          args: { message: 'hello' },
        },
        source: contentWindow,
      }),
    );
    await flushPromises();

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]![0]).toMatchObject({
      type: 'aervox:page:result',
      id: 'call-notify',
      ok: false,
      error: 'capability host.notify required',
    });
    expect(ElMessage.info).not.toHaveBeenCalled();

    // 缺少 host.close
    postMessageSpy.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-close',
          nonce,
          method: 'close',
        },
        source: contentWindow,
      }),
    );
    await flushPromises();

    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]![0]).toMatchObject({
      type: 'aervox:page:result',
      id: 'call-close',
      ok: false,
      error: 'capability host.close required',
    });
    expect(wrapper.emitted('close')).toBeFalsy();

    wrapper.unmount();
  });

  it('授权 capability 正常执行 notify 与 close', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage, // 包含 host.notify 与 host.close
      },
      global: { stubs },
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    const nonce = (postMessageSpy.mock.calls[0]![0] as { nonce: string }).nonce;
    postMessageSpy.mockClear();

    // notify
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-notify-ok',
          nonce,
          method: 'notify',
          args: { type: 'success', message: '操作成功' },
        },
        source: contentWindow,
      }),
    );
    await flushPromises();

    expect(ElMessage.success).toHaveBeenCalledWith('操作成功');
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]![0]).toMatchObject({
      type: 'aervox:page:result',
      id: 'call-notify-ok',
      ok: true,
      value: null,
    });

    // close
    postMessageSpy.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'aervox:page:call',
          id: 'call-close-ok',
          nonce,
          method: 'close',
        },
        source: contentWindow,
      }),
    );
    await flushPromises();

    expect(wrapper.emitted('close')).toBeTruthy();
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]![0]).toMatchObject({
      type: 'aervox:page:result',
      id: 'call-close-ok',
      ok: true,
      value: null,
    });

    wrapper.unmount();
  });
});
