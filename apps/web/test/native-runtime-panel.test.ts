// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import NativeRuntimePanel from '../src/mobile/NativeRuntimePanel.vue';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));
enableAutoUnmount(afterEach);
const runtime = { kind: 'runtime', connectionEpoch: 'owned-connection', sqlite: 'ready', mode: 'foreground' };
beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async body => body.op === 'runtime' ? runtime : { kind: 'summary', hasCredential: false });
});

it('shows native readiness and provides a real configuration action without exposing credential inputs', async () => {
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(request).toHaveBeenCalledWith({ op: 'runtime' });
  expect(request).toHaveBeenCalledWith({ op: 'model', operation: 'summary' });
  expect(wrapper.text()).toContain('就绪');
  expect(wrapper.text()).toContain('未配置');
  expect(wrapper.findAll('.runtime-capabilities .runtime-value').map(item => item.text())).toEqual(['前台原型', '未接入', '未接入', '未接入']);
  expect(wrapper.findAll('input, textarea')).toHaveLength(0);
  expect(wrapper.findAll('md-filled-tonal-button')).toHaveLength(1);
  await wrapper.get('md-filled-tonal-button').trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith({ op: 'model', operation: 'configure' });
  expect(wrapper.get('md-filled-tonal-button').text()).toBe('配置模型服务');
});

it('distinguishes a saved model configuration from tested connectivity and never renders returned secrets', async () => {
  request.mockImplementation(async body => body.op === 'runtime' ? runtime : {
    kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a', apiKey: 'must-never-render',
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(wrapper.text()).toContain('已保存配置');
  expect(wrapper.text()).toContain('发送消息时验证');
  expect(wrapper.text()).toContain('https://model.example/v1');
  expect(wrapper.text()).not.toContain('must-never-render');
  expect(wrapper.text()).not.toContain('已连接');
  expect(wrapper.get('md-filled-tonal-button').text()).toBe('管理模型服务');
});

it('keeps native model setup available when the independent storage check fails', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') throw new Error('private native error');
    return { kind: 'summary', hasCredential: false };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(wrapper.get('.runtime-row .runtime-value').text()).toBe('不可用');
  expect(wrapper.text()).not.toContain('private native error');
  expect(wrapper.get('md-filled-tonal-button').attributes('disabled')).toBe('false');
});

it('treats malformed readiness receipts as unknown and reports setup failures without native details', async () => {
  request.mockImplementation(async body => {
    if (body.operation === 'configure') throw new Error('sensitive native diagnostic');
    return body.op === 'runtime' ? { ...runtime, connectionEpoch: '' } : { kind: 'summary', hasCredential: true };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(wrapper.text()).toContain('不可用');
  expect(wrapper.text()).toContain('读取失败');
  expect(wrapper.text()).not.toContain('已保存配置');
  await wrapper.get('md-filled-tonal-button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.runtime-feedback').text()).toBe('原生模型设置未完成，请重试。');
  expect(wrapper.text()).not.toContain('sensitive native diagnostic');
});

it('ignores a native configuration receipt that arrives after its settings page is destroyed', async () => {
  let finish!: (value: unknown) => void;
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await wrapper.get('md-filled-tonal-button').trigger('click');
  expect(request).toHaveBeenCalledTimes(3);
  wrapper.unmount();
  finish({ kind: 'summary', hasCredential: false });
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(3);
});

it('keeps unknown model state distinct from missing configuration and waits before exposing actions', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async body => body.op === 'runtime' ? runtime : new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(wrapper.text()).toContain('正在读取模型配置');
  expect(wrapper.text()).not.toContain('未配置');
  await wrapper.get('md-filled-tonal-button').trigger('click');
  await wrapper.get('md-outlined-button').trigger('click');
  expect(request).toHaveBeenCalledTimes(2);
  finish({ kind: 'summary', hasCredential: false });
  await flushPromises();
  expect(wrapper.text()).toContain('连接模型，开始对话');
  expect(wrapper.get('md-outlined-button').attributes('disabled')).toBe('true');
});

it('tests only saved configuration, prevents duplicate actions, and reports the verified latency', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.operation === 'test') return new Promise(resolve => { finish = resolve; });
    return { kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a' };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(wrapper.text()).toContain('测试会向已配置服务发送一条简短请求');
  await wrapper.get('md-outlined-button').trigger('click');
  expect(wrapper.get('md-outlined-button').text()).toBe('正在测试…');
  await wrapper.get('md-outlined-button').trigger('click');
  await wrapper.get('md-filled-tonal-button').trigger('click');
  await wrapper.get('md-icon-button').trigger('click');
  expect(request.mock.calls.filter(([body]) => body.operation === 'test')).toEqual([[{ op: 'model', operation: 'test' }]]);
  expect(request).toHaveBeenCalledTimes(3);
  finish({ kind: 'connection_test', ok: true, latencyMs: 1234 });
  await flushPromises();
  expect(wrapper.get('.runtime-test-feedback').text()).toBe('测试连接成功 · 1,234 ms');
  expect(wrapper.get('.runtime-test-feedback').attributes('role')).toBe('status');
  expect(wrapper.get('md-filled-tonal-button').attributes('disabled')).toBe('false');
});

it.each([
  ['PROVIDER_AUTH_REJECTED', '服务拒绝了密钥'],
  ['NETWORK_TIMEOUT', '模型服务响应超时'],
  ['NATIVE_RECEIPT_UNKNOWN', '未收到测试结果'],
  ['CONNECTION_TEST_CANCELLED', '测试已停止'],
  ['EMPTY_MODEL_RESPONSE', '服务已响应，但没有返回文本'],
  ['server body containing a secret', '连接测试未完成'],
])('explains %s without exposing native or provider details', async (code, expected) => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.operation === 'test') throw new Error(code);
    return { kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a' };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.get('md-outlined-button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.runtime-test-feedback').text()).toContain(expected);
  expect(wrapper.get('.runtime-test-feedback').attributes('role')).toBe('alert');
  expect(wrapper.text()).not.toContain(code);
});

it('does not turn an invalid connection receipt into a successful test', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.operation === 'test') return { kind: 'connection_test', ok: true, latencyMs: -1 };
    return { kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a' };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.get('md-outlined-button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.runtime-test-feedback').text()).toContain('未收到有效的模型回复');
  expect(wrapper.text()).not.toContain('测试连接成功');
});
