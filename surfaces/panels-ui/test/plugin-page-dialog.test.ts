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

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    getApiBase: () => 'http://127.0.0.1:3000',
    useAervoxPlugins: () => ({
      getConfig: mockGetConfig,
      saveConfig: mockSaveConfig,
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('使用密码学随机 UUID 生成 Nonce 并发送 init 消息到 iframe', async () => {
    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
        page: mockPage,
      },
      global: { stubs },
      attachTo: document.body,
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
    // UUID v4 格式校验
    expect(initMsg.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

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
      attachTo: document.body,
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
      attachTo: document.body,
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

  it('插件禁用时立即撤权并返回 plugin is disabled or unavailable 错误', async () => {
    const disabledPlugin: PluginSummaryDto = {
      ...mockPlugin,
      enabled: 0,
    };

    const wrapper = mount(PluginPageDialog, {
      props: {
        open: true,
        plugin: disabledPlugin,
        page: mockPage,
      },
      global: { stubs },
      attachTo: document.body,
    });

    await flushPromises();

    const iframeEl = wrapper.find('iframe').element as HTMLIFrameElement;
    const contentWindow = iframeEl.contentWindow!;
    const postMessageSpy = vi.spyOn(contentWindow, 'postMessage');

    iframeEl.dispatchEvent(new Event('load'));
    await flushPromises();
    const nonce = (postMessageSpy.mock.calls[0]![0] as { nonce: string }).nonce;
    postMessageSpy.mockClear();

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
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    expect(postMessageSpy.mock.calls[0]![0]).toMatchObject({
      type: 'aervox:page:result',
      id: 'call-disabled',
      ok: false,
      error: 'plugin is disabled or unavailable',
    });

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
      attachTo: document.body,
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
      attachTo: document.body,
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
