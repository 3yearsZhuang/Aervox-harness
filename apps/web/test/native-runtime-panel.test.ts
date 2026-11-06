// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { AervoxHttpError } from '@aervox/api-client';
import NativeRuntimePanel from '../src/mobile/NativeRuntimePanel.vue';

const { request, routes, notify, extraTransport } = vi.hoisted(() => ({ request: vi.fn(), routes: vi.fn(), notify: vi.fn(), extraTransport: {} as Record<string, unknown> }));
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  getClientTransport: () => ({ ...extraTransport, request: routes }),
  notifyPersonaChanged: notify,
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
  notify.mockReset();
  for (const key of Object.keys(extraTransport)) delete extraTransport[key];
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
  expect(wrapper.get('.runtime-feedback').text()).toContain('设备操作需要 root');
});

it('keeps device switches disabled and honest when there is no root grant', async () => {
  request.mockImplementation(async body => {
    if (body.op === 'runtime') return runtime;
    if (body.op === 'device') return { ...deviceStatus, root: false, device: undefined };
    return { kind: 'summary', hasCredential: false };
  });
  const wrapper = await mountPanel('device');
  expect(wrapper.text()).toContain('当前安装包尚未集成 Shizuku');
  expect(wrapper.find('md-switch[aria-label="Root 高级实验"]').exists()).toBe(false);
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
    if (method === 'PATCH') return { persona: { id: 'p1' }, revision: { id: 'r2', revision: 2 } };
    if (method === 'POST' && path === '/v1/personas') return { persona: { id: 'p2' }, revision: { id: 'new-r1', revision: 1 } };
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
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas/p1/activate', { revisionId: 'r2' });
  await wrapper.findAll('md-text-button').find(item => item.text() === '新建人格')!.trigger('click');
  await wrapper.find('input[aria-label="人格名字"]').setValue('小林');
  await wrapper.find('textarea[aria-label="人格设定"]').setValue('活泼');
  await save().trigger('click');
  await flushPromises();
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas', {
    name: '小林', description: '', config: { systemPromptAppend: '活泼' },
  });
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas/p2/activate', { revisionId: 'new-r1' });
});

it('activates the saved revision when another window saves a newer revision before activation', async () => {
  const persona = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  let revision = { id: 'r1', revision: 1, config: { systemPromptAppend: '温和' } };
  let activatedRevision = 'r1';
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [persona], active: { personaId: persona.id } };
    if (method === 'GET') return { persona, revision };
    if (method === 'PATCH') {
      const saved = { id: 'r2', revision: 2, config: body.config };
      // A second window commits R3 after this save, before this window activates.
      persona.currentRevisionId = 'r3';
      revision = { id: 'r3', revision: 3, config: { systemPromptAppend: '另一个窗口的设定' } };
      return { persona: { ...persona, currentRevisionId: saved.id }, revision: saved };
    }
    if (method === 'POST') activatedRevision = body.revisionId ?? persona.currentRevisionId;
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('这次保存的设定');
  await wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!.trigger('click');
  await flushPromises();
  expect(routes).toHaveBeenCalledWith('POST', '/v1/personas/p1/activate', { revisionId: 'r2' });
  expect(activatedRevision).toBe('r2');
  expect(persona.currentRevisionId).toBe('r3');
});

it('retries activation of a created persona without creating it again or updating it', async () => {
  const existing = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  const created = { id: 'p2', name: '小林', description: '', currentRevisionId: 'new-r1' };
  const list = [existing];
  let activeId = existing.id;
  let activationAttempts = 0;
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: list, active: { personaId: activeId } };
    if (method === 'GET') return {
      persona: activeId === created.id ? created : existing,
      revision: { id: activeId === created.id ? 'new-r1' : 'r1', revision: 1, config: { systemPromptAppend: '温和' } },
    };
    if (method === 'POST' && path === '/v1/personas') {
      list.push(created);
      return { persona: created, revision: { id: 'new-r1', revision: 1, config: body.config } };
    }
    if (method === 'POST' && path === '/v1/personas/p2/activate') {
      if (++activationAttempts === 1) throw new Error('ACTIVATION_FAILED');
      activeId = created.id;
    }
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.findAll('md-text-button').find(item => item.text() === '新建人格')!.trigger('click');
  await wrapper.get('input[aria-label="人格名字"]').setValue('小林');
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('活泼');
  await wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('设定已保存，但启用没有完成');
  expect(wrapper.text()).not.toContain('设定未变');
  expect(notify).toHaveBeenCalledTimes(1);
  await wrapper.findAll('md-outlined-button').find(item => item.text() === '启用已保存修订')!.trigger('click');
  await flushPromises();
  expect(routes.mock.calls.filter(([method, path]) => method === 'POST' && path === '/v1/personas')).toHaveLength(1);
  expect(routes.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  expect(routes.mock.calls.filter(([, path]) => path === '/v1/personas/p2/activate').map(([, , body]) => body))
    .toEqual([{ revisionId: 'new-r1' }, { revisionId: 'new-r1' }]);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ request: routes }));
  expect(wrapper.text()).toContain('已建立并启用这个人格');
  expect(wrapper.text()).not.toContain('启用已保存修订');
});

it('retries activation of an updated revision without another PATCH', async () => {
  const persona = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  let revision = { id: 'r1', revision: 1, config: { systemPromptAppend: '温和' } };
  let activationAttempts = 0;
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [persona], active: { personaId: persona.id } };
    if (method === 'GET') return { persona, revision };
    if (method === 'PATCH') {
      revision = { id: 'r2', revision: 2, config: body.config };
      return { persona, revision };
    }
    if (method === 'POST' && ++activationAttempts === 1) throw new Error('ACTIVATION_FAILED');
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('简短');
  await wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!.trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('设定已保存，但启用没有完成');
  expect(notify).toHaveBeenCalledTimes(1);
  await wrapper.findAll('md-outlined-button').find(item => item.text() === '启用已保存修订')!.trigger('click');
  await flushPromises();
  expect(routes.mock.calls.filter(([method]) => method === 'PATCH')).toHaveLength(1);
  expect(routes.mock.calls.filter(([method]) => method === 'POST').map(([, , body]) => body))
    .toEqual([{ revisionId: 'r2' }, { revisionId: 'r2' }]);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(wrapper.text()).toContain('已保存，下一次对话就会用上新设定');
});

it('keeps activation retry after a successful refresh until the exact saved revision is active', async () => {
  const persona = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  let revision = { id: 'r1', revision: 1, config: { systemPromptAppend: '温和' } };
  let active = { personaId: 'p1', revisionId: 'r1' };
  let activationAttempts = 0;
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [persona], active };
    if (method === 'GET') return { persona, revision };
    if (method === 'PATCH') {
      persona.currentRevisionId = 'r2';
      revision = { id: 'r2', revision: 2, config: body.config };
      return { persona, revision };
    }
    if (method === 'POST') {
      if (++activationAttempts === 1) throw new Error('ACTIVATION_FAILED');
      active = { personaId: persona.id, revisionId: body.revisionId };
    }
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('已保存的新设定');
  await wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!.trigger('click');
  await flushPromises();
  await wrapper.get('[aria-label="刷新运行状态"]').trigger('click');
  await flushPromises();
  expect(active.revisionId).toBe('r1');
  expect(wrapper.text()).toContain('设定已保存，但启用没有完成');
  expect(wrapper.get('textarea[aria-label="人格设定"]').element.value).toBe('已保存的新设定');
  await wrapper.findAll('md-outlined-button').find(item => item.text() === '启用已保存修订')!.trigger('click');
  await flushPromises();
  expect(routes.mock.calls.filter(([method]) => method === 'PATCH')).toHaveLength(1);
  expect(active.revisionId).toBe('r2');
  expect(wrapper.text()).not.toContain('启用已保存修订');
});

it('clears the saved activation retry on refresh only when both persona and revision match', async () => {
  const persona = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  let active = { personaId: 'p1', revisionId: 'r1' };
  routes.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [persona], active };
    if (method === 'GET') return { persona, revision: { id: 'r2', revision: 2, config: { systemPromptAppend: '温和' } } };
    if (method === 'PATCH') return { persona, revision: { id: 'r2', revision: 2 } };
    throw new Error('ACTIVATION_FAILED');
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!.trigger('click');
  await flushPromises();
  active = { personaId: 'p2', revisionId: 'r2' };
  await wrapper.get('[aria-label="刷新运行状态"]').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('启用已保存修订');
  active = { personaId: 'p1', revisionId: 'r2' };
  await wrapper.get('[aria-label="刷新运行状态"]').trigger('click'); await flushPromises();
  expect(wrapper.text()).not.toContain('启用已保存修订');
  expect(wrapper.text()).toContain('已保存，下一次对话就会用上新设定');
});

it('uses the committed revision number when editing again after activation fails', async () => {
  const persona = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  let number = 1;
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [persona], active: { personaId: persona.id } };
    if (method === 'GET') return { persona, revision: { id: 'r1', revision: 1, config: { systemPromptAppend: '温和' } } };
    if (method === 'PATCH') {
      if (body.expectedRevision !== number) throw new Error('PERSONA_REVISION_CONFLICT');
      ++number;
      return { persona, revision: { id: `r${number}`, revision: number } };
    }
    throw new Error('ACTIVATION_FAILED');
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  const save = () => wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!;
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('第一次修改');
  await save().trigger('click'); await flushPromises();
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('继续修改');
  await save().trigger('click'); await flushPromises();
  expect(routes.mock.calls.filter(([method]) => method === 'PATCH').map(([, , body]) => body.expectedRevision)).toEqual([1, 2]);
  expect(wrapper.text()).not.toContain('这份人格在别处被改过');
  expect(wrapper.text()).toContain('设定已保存，但启用没有完成');
});

it('keeps the saved persona draft identity when a refresh fails to read the active persona details', async () => {
  const existing = { id: 'p1', name: '小隅', description: '', currentRevisionId: 'r1' };
  const created = { id: 'p2', name: '小林', description: '', currentRevisionId: 'new-r1' };
  let failDetail = false;
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return { personas: [existing, created], active: { personaId: existing.id } };
    if (method === 'GET') {
      if (failDetail) throw new Error('DETAIL_FAILED');
      return { persona: existing, revision: { id: 'r1', revision: 1, config: { systemPromptAppend: '温和' } } };
    }
    if (method === 'POST' && path === '/v1/personas') return { persona: created, revision: { id: 'new-r1', revision: 1 } };
    if (method === 'PATCH') return { persona: created, revision: { id: 'new-r2', revision: 2, config: body.config } };
    throw new Error('ACTIVATION_FAILED');
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  await wrapper.findAll('md-text-button').find(item => item.text() === '新建人格')!.trigger('click');
  await wrapper.get('input[aria-label="人格名字"]').setValue('小林');
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('活泼');
  const save = () => wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!;
  await save().trigger('click'); await flushPromises();
  failDetail = true;
  await wrapper.get('[aria-label="刷新运行状态"]').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('人格列表读取失败');
  expect(wrapper.get('input[aria-label="人格名字"]').element.value).toBe('小林');
  await wrapper.get('textarea[aria-label="人格设定"]').setValue('继续编辑小林');
  await save().trigger('click'); await flushPromises();
  expect(routes).toHaveBeenCalledWith('PATCH', '/v1/personas/p2', expect.objectContaining({ expectedRevision: 1 }));
  expect(routes.mock.calls.some(([method, path]) => method === 'PATCH' && path === '/v1/personas/p1')).toBe(false);
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

it('keeps unavailable persona bindings until an explicit selection or unbinding and notifies saved changes', async () => {
  let config: Record<string, unknown> = {systemPromptAppend: '温和', live2dModelId: 'unavailable-model',
    voice: {enabled: true, providerId: 'voice', modelId: 'speech'}};
  routes.mockImplementation(async (method, path, body) => {
    if (method === 'GET' && path === '/v1/personas') return {personas: [{id: 'p1', name: '小隅'}], active: {personaId: 'p1'}};
    if (method === 'GET') return {persona: {id: 'p1', name: '小隅'}, revision: {revision: 1, config}};
    if (method === 'PATCH') { config = body.config; return {persona: {id: 'p1'}, revision: {id: 'r2', revision: 2}}; }
    return {};
  });
  const wrapper = mount(NativeRuntimePanel);
  await flushPromises();
  await wrapper.findAll('.runtime-menu-card')[4].trigger('click');
  await flushPromises();
  const selection = wrapper.get('select[aria-label="人格 Live2D 形象"]');
  expect(selection.element.value).toBe('unavailable-model');
  expect(wrapper.text()).toContain('原绑定会保留');
  const save = () => wrapper.findAll('md-filled-tonal-button').find(item => item.text() === '保存设定')!;
  await save().trigger('click'); await flushPromises();
  expect(config.live2dModelId).toBe('unavailable-model');
  expect(config.voice).toEqual({enabled: true, providerId: 'voice', modelId: 'speech'});
  await selection.setValue('mizuki-default');
  await save().trigger('click'); await flushPromises();
  expect(config.live2dModelId).toBe('mizuki-default');
  expect(wrapper.text()).not.toContain('原绑定会保留');
  await selection.setValue('');
  await save().trigger('click'); await flushPromises();
  expect(config).not.toHaveProperty('live2dModelId');
  expect(notify).toHaveBeenCalledTimes(6);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({request: routes}));
});

it('opens the native learning surface from settings using the captured local transport', async () => {
  routes.mockImplementation(async (_method, path) => {
    if (path === '/v1/practice/sessions/active') throw new AervoxHttpError(404, path, { code: 'PRACTICE_SESSION_NOT_FOUND' });
    return { items: [] };
  });
  const wrapper = await mountPanel();
  await wrapper.findAll('.runtime-menu-card')[5].trigger('click');
  await flushPromises();
  expect(wrapper.find('.native-learning-panel').exists()).toBe(true);
  expect(wrapper.text()).toContain('题库不足 3 题');
  expect(wrapper.text()).toContain('当前没有到期复习');
  expect(routes).toHaveBeenCalledWith('GET', '/v1/practice/sessions/active');
});

it('exports large backups through the file sharing port instead of the bounded text share', async () => {
  const text = 'x'.repeat(300 * 1024);
  extraTransport.exportBackup = vi.fn(async () => ({ text, createdAt: '2026-11-04T00:00:00Z', tableCounts: { records: 600 } }));
  const shareFile = extraTransport.shareTextFile = vi.fn(async () => undefined);
  const shareText = extraTransport.shareText = vi.fn(async () => undefined);
  const wrapper = await mountPanel('data');
  await wrapper.findAll('md-filled-tonal-button').find(button => button.text() === '导出')!.trigger('click');
  await flushPromises();
  expect(shareFile).toHaveBeenCalledWith({ title: 'Aervox 备份', text });
  expect(shareText).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('600 条记录');
});

it('explains why restore is unavailable and exposes no restore action even when a transport supports it', async () => {
  const restore = extraTransport.importBackup = vi.fn(async () => ({ imported: { records: 600 } }));
  const pickFile = extraTransport.pickTextFile = vi.fn(async () => ({ name: 'old-backup.json', text: 'backup' }));
  const wrapper = await mountPanel('data');
  const restoreButton = wrapper.findAll('md-filled-tonal-button').find(button => button.text() === '恢复')!;
  expect(restoreButton.attributes('disabled')).toBe('true');
  expect(restoreButton.attributes('aria-describedby')).toBe('runtime-restore-unavailable');
  expect(wrapper.text()).toContain('恢复暂不可用');
  expect(wrapper.text()).toContain('无法确认完整的历史删除记录');
  expect(wrapper.text()).toContain('旧备份可能带回已删除的内容');
  expect(wrapper.text()).toContain('现有数据保留，仍可导出备份');
  expect(wrapper.text()).toContain('模型密钥、插件凭据和设备连接不进入备份');
  await restoreButton.trigger('click');
  await flushPromises();
  expect(restore).not.toHaveBeenCalled();
  expect(pickFile).not.toHaveBeenCalled();
  expect(wrapper.find('textarea[aria-label="备份文本"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain('确认覆盖当前数据');
  expect(wrapper.text()).not.toContain('校验并恢复');
});

it('keeps file and URL question imports available while backup restore is disabled', async () => {
  const restore = extraTransport.importBackup = vi.fn(async () => { throw new Error('BACKUP_RESTORE_HISTORY_UNVERIFIED'); });
  const pickFile = extraTransport.pickTextFile = vi.fn(async () => ({ name: 'questions.csv', text: '1+1,2' }));
  const fetchUrl = extraTransport.fetchUrlText = vi.fn(async () => ({ name: 'online.csv', text: '2+2,4' }));
  routes.mockResolvedValue({ importedCount: 1 });
  const wrapper = await mountPanel('data');
  await wrapper.findAll('md-filled-tonal-button').find(button => button.text() === '选择文件')!.trigger('click');
  await flushPromises();
  expect(pickFile).toHaveBeenCalledOnce();
  expect(routes).toHaveBeenCalledWith('POST', '/v1/questions/import', { content: '1+1,2' });
  expect(wrapper.text()).toContain('已从「questions.csv」导入 1 道题');
  await wrapper.get('input[aria-label="题库链接"]').setValue('https://example.test/questions.csv');
  await wrapper.findAll('md-filled-tonal-button').find(button => button.text() === '导入')!.trigger('click');
  await flushPromises();
  expect(fetchUrl).toHaveBeenCalledWith('https://example.test/questions.csv');
  expect(routes).toHaveBeenCalledWith('POST', '/v1/questions/import', { content: '2+2,4' });
  expect(wrapper.text()).toContain('已从「online.csv」导入 1 道题');
  expect(restore).not.toHaveBeenCalled();
});
