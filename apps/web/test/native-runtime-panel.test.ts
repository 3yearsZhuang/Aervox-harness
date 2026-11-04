// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import NativeRuntimePanel from '../src/mobile/NativeRuntimePanel.vue';

const { request, routes } = vi.hoisted(() => ({ request: vi.fn(), routes: vi.fn() }));
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  getClientTransport: () => ({ request: routes }),
}));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));
enableAutoUnmount(afterEach);
const runtime = { kind: 'runtime', connectionEpoch: 'owned-connection', sqlite: 'ready', mode: 'foreground' };
const deviceStatus = { kind: 'device_status', root: true, capabilities: { control: false, apps: false, advanced: false }, sdk: 36, device: 'Pixel 9' };
async function mountPanel(page?: 'model' | 'device' | 'data' | 'reminder') {
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  if (page) {
    const index = { model: 0, device: 1, data: 2, reminder: 3 }[page];
    await wrapper.findAll('.runtime-menu-card')[index].trigger('click');
    await flushPromises();
  }
  return wrapper;
}
beforeEach(() => {
  request.mockReset();
  routes.mockReset();
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') return deviceStatus;
    return { kind: 'summary', hasCredential: false };
  });
});

it('shows native readiness and provides a real configuration action without exposing credential inputs', async () => {
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  expect(request).toHaveBeenCalledWith({ op: 'runtime' });
  expect(request).toHaveBeenCalledWith({ op: 'model', operation: 'summary' });
  expect(wrapper.text()).toContain('模型与状态');
  await wrapper.findAll('.runtime-menu-card')[0].trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('就绪');
  expect(wrapper.text()).toContain('未配置');
  await wrapper.findAll('.runtime-heading md-icon-button')[0].trigger('click');
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[1].trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.runtime-capabilities .runtime-value').map(item => item.text())).toEqual(['试用中', '试用中', '试用中', '未开放']);
  // The panel never exposes raw credential fields; the only free-text field is
  // the user-supplied question-bank URL.
  await wrapper.findAll('.runtime-heading md-icon-button')[0].trigger('click');
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[2].trigger('click');
  await flushPromises();
  expect(wrapper.findAll('input, textarea').every(item => item.attributes('aria-label') === '题库链接')).toBe(true);
  await wrapper.findAll('.runtime-heading md-icon-button')[0].trigger('click');
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[0].trigger('click');
  await flushPromises();
  const configure = wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '配置模型服务');
  expect(configure).toBeTruthy();
  await configure!.trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith({ op: 'model', operation: 'configure' });
});

it('distinguishes a saved model configuration from tested connectivity and never renders returned secrets', async () => {
  request.mockImplementation(async body => body.op === 'runtime' ? runtime : {
    kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a', apiKey: 'must-never-render',
  });
  const wrapper = await mountPanel('model');
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
  const wrapper = await mountPanel('model');
  expect(wrapper.get('.runtime-row .runtime-value').text()).toBe('不可用');
  expect(wrapper.text()).not.toContain('private native error');
  expect(wrapper.get('md-filled-tonal-button').attributes('disabled')).toBe('false');
});

it('treats malformed readiness receipts as unknown and reports setup failures without native details', async () => {
  request.mockImplementation(async body => {
    if (body.operation === 'configure') throw new Error('sensitive native diagnostic');
    return body.op === 'runtime' ? { ...runtime, connectionEpoch: '' } : { kind: 'summary', hasCredential: true };
  });
  const wrapper = await mountPanel('model');
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
  const wrapper = await mountPanel('model');
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await wrapper.get('md-filled-tonal-button').trigger('click');
  expect(request).toHaveBeenCalledTimes(4);
  wrapper.unmount();
  finish({ kind: 'summary', hasCredential: false });
  await flushPromises();
  expect(request).toHaveBeenCalledTimes(4);
});

it('keeps unknown model state distinct from missing configuration and waits before exposing actions', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async body => body.op === 'runtime' ? runtime : new Promise(resolve => { finish = resolve; }));
  const wrapper = await mountPanel('model');
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
  const wrapper = await mountPanel('model');
  expect(wrapper.text()).toContain('测试会向已配置服务发送一条简短请求');
  await wrapper.get('md-outlined-button').trigger('click');
  expect(wrapper.get('md-outlined-button').text()).toBe('正在测试…');
  await wrapper.get('md-outlined-button').trigger('click');
  await wrapper.get('md-filled-tonal-button').trigger('click');
  await wrapper.get('[aria-label="刷新运行状态"]').trigger('click');
  expect(request.mock.calls.filter(([body]) => body.operation === 'test')).toEqual([[{ op: 'model', operation: 'test' }]]);
  expect(request).toHaveBeenCalledTimes(4);
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
  const wrapper = await mountPanel('model');
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
  const wrapper = await mountPanel('model');
  await wrapper.get('md-outlined-button').trigger('click');
  await flushPromises();
  expect(wrapper.get('.runtime-test-feedback').text()).toContain('未收到有效的模型回复');
  expect(wrapper.text()).not.toContain('测试连接成功');
});

it('shows root availability and grants a device capability through the native channel', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') {
      if (body.operation === 'grant') {
        if (body.capability === 'apps') throw new Error('ROOT_UNAVAILABLE');
        return { ...deviceStatus, capabilities: { control: body.enabled === true, apps: false, advanced: false } };
      }
      return deviceStatus;
    }
    return { kind: 'summary', hasCredential: false };
  });
  const wrapper = await mountPanel('device');
  expect(wrapper.text()).toContain('Root 可用');
  const control = wrapper.get('md-switch[aria-label="控制手机"]');
  expect(control.attributes('disabled')).toBeUndefined();
  await control.trigger('change');
  await flushPromises();
  expect(request).toHaveBeenCalledWith({ op: 'device', operation: 'grant', capability: 'control', enabled: true });
  expect(wrapper.get('md-switch[aria-label="控制手机"]').attributes('selected')).toBe('true');
  await wrapper.get('md-switch[aria-label="打开应用"]').trigger('change');
  await flushPromises();
  expect(wrapper.get('.runtime-feedback').text()).toContain('设备操作需要 root 或已授权的 Shizuku');
});

it('keeps device switches disabled and honest when there is no root grant', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') return { ...deviceStatus, root: false, device: undefined };
    return { kind: 'summary', hasCredential: false };
  });
  const wrapper = await mountPanel('device');
  expect(wrapper.text()).toContain('可安装并授权 Shizuku');
  expect(wrapper.get('md-switch[aria-label="控制手机"]').attributes('disabled')).toBe('true');
  expect(wrapper.get('md-switch[aria-label="打开应用"]').attributes('disabled')).toBe('true');
  expect(wrapper.text()).not.toContain('Root 可用');
});

it('clears a saved model configuration only after an explicit confirmation', async () => {
  let saved = true;
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') return deviceStatus;
    if (body.operation === 'clear') { saved = false; return { kind: 'summary', hasCredential: false }; }
    return saved ? { kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a' }
      : { kind: 'summary', hasCredential: false };
  });
  const wrapper = await mountPanel('model');
  await wrapper.get('.runtime-clear-model').trigger('click');
  expect(request.mock.calls.filter(([body]) => body.operation === 'clear')).toHaveLength(0);
  expect(wrapper.text()).toContain('清除后，这台手机不再保存密钥');
  await wrapper.get('.runtime-clear-confirm').trigger('click');
  await flushPromises();
  expect(request.mock.calls.filter(([body]) => body.operation === 'clear')).toHaveLength(1);
  expect(wrapper.text()).toContain('已清除模型配置');
  expect(wrapper.text()).toContain('未配置');
  expect(wrapper.find('.runtime-clear-model').exists()).toBe(false);
});

it('keeps the saved configuration when clearing is refused', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') return deviceStatus;
    if (body.operation === 'clear') throw new Error('BUSY');
    return { kind: 'summary', hasCredential: true, endpoint: 'https://model.example/v1', model: 'model-a' };
  });
  const wrapper = await mountPanel('model');
  await wrapper.get('.runtime-clear-model').trigger('click');
  await wrapper.get('.runtime-clear-confirm').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('清除没有完成，原有配置保持不变');
  expect(wrapper.text()).toContain('已保存配置');
  expect(wrapper.text()).not.toContain('已清除模型配置');
});

it('creates another persona, preserves revision settings, and activates a saved revision', async () => {
  const config = { systemPromptAppend: '温和', allowedSkillNames: ['review'], metadata: { note: '保留' } };
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return {
      personas: [{ id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' }], active: { personaId: 'p1' },
    };
    if (method === 'GET') return { persona: { id: 'p1', name: '小隅', description: '' }, revision: { revision: 1, config } };
    if (method === 'PATCH') return { persona: { id: 'p1' }, revision: { revision: 2 } };
    if (method === 'POST' && path === '/v1/personas') return { persona: { id: 'p2' }, revision: { revision: 1 } };
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.find('textarea[aria-label="人格设定"]').setValue('更简短');
  const save = () => wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!;
  await save().trigger('click');
  await flushPromises();
  expect(routes).toHaveBeenCalledWith('PATCH', '/v1/personas/p1', expect.objectContaining({
    config: { ...config, systemPromptAppend: '更简短' },
  }));
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas/p1/activate', {});
  await wrapper.findAll('md-text-button').find(item => item.text() === '新建人格')!.trigger('click');
  await wrapper.find('input[aria-label="人格名字"]').setValue('小林');
  await wrapper.find('textarea[aria-label="人格设定"]').setValue('活泼');
  await save().trigger('click');
  await flushPromises();
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas', {
    name: '小林', description: '', config: { systemPromptAppend: '活泼' },
  });
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas/p2/activate', {});
});

it('retries persona details through the page refresh action after a failed read', async () => {
  let fail = true;
  routes.mockImplementation(async (_method, path) => {
    if (path === '/v1/personas') return { personas: [{ id: 'p1', name: '小隅' }], active: { personaId: 'p1' } };
    if (fail) throw new Error('READ_FAILED');
    return { persona: { id: 'p1', name: '小隅' }, revision: { revision: 1, config: { systemPromptAppend: '温和' } } };
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('人格列表读取失败');
  fail = false;
  await wrapper.find('[aria-label="刷新运行状态"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('textarea[aria-label="人格设定"]').element.value).toBe('温和');
  expect(wrapper.text()).not.toContain('人格列表读取失败');
});
