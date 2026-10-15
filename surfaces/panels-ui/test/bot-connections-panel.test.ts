import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { BotConnection } from '@aervox/contracts';
import BotConnectionsPanel from '../src/bot/BotConnectionsPanel.vue';

const api = vi.hoisted(() => ({
  listAdapters: vi.fn(), listConnections: vi.fn(), createConnection: vi.fn(), updateConnection: vi.fn(),
  deleteConnection: vi.fn(), startLogin: vi.fn(), getLogin: vi.fn(), startPairing: vi.fn(),
  getPairing: vi.fn(), confirmPairing: vi.fn(), listDeliveries: vi.fn(), retryDelivery: vi.fn(),
}));
const qr = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('@aervox/api-client', () => ({ useAervoxBots: () => api }));
vi.mock('qrcode', () => qr);

const adapters = [
  { id: 'weixin', displayName: '微信私聊', platform: 'weixin', capabilities: { directMessages: true, groupMessages: false, login: true, maxTextLength: 2000 } },
  { id: 'onebot', displayName: 'QQ 群（OneBot v11）', platform: 'qq', capabilities: { directMessages: false, groupMessages: true, login: false, maxTextLength: 4000 } },
];
const connection: BotConnection = {
  id: 'wx-1', adapterId: 'weixin', displayName: '我的微信', enabled: true, revision: 3,
  config: {}, state: 'login_required', hasCredentials: false,
};

function button(wrapper: VueWrapper, text: string) {
  const result = wrapper.findAll('button').find(item => item.text() === text);
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

async function openPanel() {
  const wrapper = mount(BotConnectionsPanel);
  await flushPromises();
  return wrapper;
}

async function showDetails(wrapper: VueWrapper) {
  await button(wrapper, '登录与投递').trigger('click');
  await flushPromises();
}

enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.resetAllMocks();
  api.listAdapters.mockResolvedValue(adapters);
  api.listConnections.mockResolvedValue([structuredClone(connection)]);
  api.listDeliveries.mockResolvedValue([]);
  api.getPairing.mockResolvedValue({ confirmed: false });
  api.updateConnection.mockImplementation(async (_id, input) => ({ ...connection, ...input, revision: input.revision + 1 }));
  api.createConnection.mockImplementation(async input => ({ ...connection, ...input, revision: 1 }));
  qr.toDataURL.mockResolvedValue('data:image/png;base64,bG9jYWwtcXI=');
});
afterEach(() => vi.useRealTimers());

describe('BotConnectionsPanel', () => {
  it('recovers from a failed initial load and shows the empty state', async () => {
    api.listConnections.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue([]);
    const wrapper = await openPanel();
    expect(wrapper.get('[role="alert"]').text()).toContain('读取连接失败');
    await button(wrapper, '刷新状态').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('尚未添加连接');
  });

  it('validates QQ connection settings and writes the token without retaining it in the form', async () => {
    const wrapper = await openPanel();
    await button(wrapper, '添加连接').trigger('click');
    await wrapper.get('[aria-label="平台"]').setValue('onebot');
    await wrapper.get('[aria-label="连接名称"]').setValue('家人群');
    await wrapper.get('form').trigger('submit');
    expect(wrapper.text()).toContain('请填写 OneBot WebSocket 地址');
    expect(api.createConnection).not.toHaveBeenCalled();
    await wrapper.get('[aria-label="服务地址"]').setValue('ws://127.0.0.1:3001');
    await wrapper.get('[aria-label="平台账号 ID"]').setValue('123456');
    await wrapper.get('[aria-label="允许响应的群号"]').setValue('456789, 987654\n456789');
    await wrapper.get('[aria-label="访问令牌"]').setValue('write-only-token');
    let finish: (value: unknown) => void = () => {};
    api.createConnection.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await wrapper.get('form').trigger('submit');
    expect(api.createConnection).toHaveBeenCalledWith({
      adapterId: 'onebot', displayName: '家人群', enabled: true,
      config: { endpoint: 'ws://127.0.0.1:3001', accountId: '123456', allowedGroupIds: ['456789', '987654'] },
      secretValues: { token: 'write-only-token' },
    });
    expect((wrapper.get('[aria-label="访问令牌"]').element as HTMLInputElement).value).toBe('');
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();
    finish({ ...connection, id: 'qq-1', adapterId: 'onebot', displayName: '家人群' });
    await flushPromises();
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('连接已保存');
    expect(wrapper.html()).not.toContain('write-only-token');
  });

  it('preserves an edit after a revision conflict and requires an explicit reload before saving', async () => {
    const wrapper = await openPanel();
    await button(wrapper, '编辑').trigger('click');
    await wrapper.get('[aria-label="连接名称"]').setValue('尚未保存');
    api.updateConnection.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.updateConnection).toHaveBeenCalledWith('wx-1', { revision: 3, displayName: '尚未保存', enabled: true, config: {} });
    expect(wrapper.text()).toContain('本次修改尚未保存');
    expect((wrapper.get('[aria-label="连接名称"]').element as HTMLInputElement).value).toBe('尚未保存');
    expect(button(wrapper, '保存连接').attributes('disabled')).toBeDefined();
    api.listConnections.mockResolvedValue([{ ...connection, revision: 4, displayName: '另一处修改' }]);
    await button(wrapper, '放弃草稿并载入最新配置').trigger('click');
    await flushPromises();
    expect((wrapper.get('[aria-label="连接名称"]').element as HTMLInputElement).value).toBe('另一处修改');
    await wrapper.get('[aria-label="连接名称"]').setValue('重新编辑');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(api.updateConnection).toHaveBeenLastCalledWith('wx-1', { revision: 4, displayName: '重新编辑', enabled: true, config: {} });
  });

  it('keeps the accepted enabled state when a toggle fails and clears the error after retry', async () => {
    const wrapper = await openPanel();
    api.updateConnection.mockRejectedValueOnce(new Error('offline'));
    await wrapper.get('[aria-label="启用 我的微信"]').setValue(false);
    await flushPromises();
    expect((wrapper.get('[aria-label="启用 我的微信"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.text()).toContain('操作失败');
    await wrapper.get('[aria-label="启用 我的微信"]').setValue(false);
    await flushPromises();
    expect(api.updateConnection).toHaveBeenLastCalledWith('wx-1', { revision: 3, enabled: false });
    expect((wrapper.get('[aria-label="启用 我的微信"]').element as HTMLInputElement).checked).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('disables login and pairing until the connection is enabled', async () => {
    api.listConnections.mockResolvedValue([{ ...connection, enabled: false }]);
    const wrapper = await openPanel();
    await showDetails(wrapper);
    expect(button(wrapper, '获取登录二维码').attributes('disabled')).toBeDefined();
    expect(button(wrapper, '生成配对码').attributes('disabled')).toBeDefined();
    expect(api.startLogin).not.toHaveBeenCalled();
    expect(api.startPairing).not.toHaveBeenCalled();
  });

  it('renders a login URL as a local QR and removes it when login is confirmed', async () => {
    const wrapper = await openPanel();
    await showDetails(wrapper);
    api.startLogin.mockResolvedValue({ status: 'waiting', qrCodeUrl: 'https://weixin.example/login/opaque-token' });
    await button(wrapper, '获取登录二维码').trigger('click');
    await flushPromises();
    expect(qr.toDataURL).toHaveBeenCalledWith('https://weixin.example/login/opaque-token', expect.objectContaining({ width: 256 }));
    expect(wrapper.get('img').attributes('src')).toMatch(/^data:image\/png/);
    expect(wrapper.html()).not.toContain('https://weixin.example/login/opaque-token');
    api.getLogin.mockResolvedValue({ status: 'confirmed', accountId: 'my-account' });
    await button(wrapper, '刷新详情').trigger('click');
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('登录成功');
  });

  it('retains the pairing code during polling and never confirms a candidate automatically', async () => {
    const wrapper = await openPanel();
    await showDetails(wrapper);
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    api.startPairing.mockResolvedValue({ code: 'SIYU-owner-only', expiresAt, confirmed: false });
    await button(wrapper, '生成配对码').trigger('click');
    await flushPromises();
    api.getPairing.mockResolvedValue({ candidateSenderId: 'sender-to-review', expiresAt, confirmed: false });
    await button(wrapper, '刷新详情').trigger('click');
    await flushPromises();
    expect((wrapper.get('[aria-label="配对码"]').element as HTMLInputElement).value).toBe('SIYU-owner-only');
    expect(wrapper.text()).toContain('sender-to-review');
    expect(api.confirmPairing).not.toHaveBeenCalled();
    api.confirmPairing.mockResolvedValue({ confirmed: true });
    api.listConnections.mockResolvedValue([{ ...connection, revision: 4, ownerSenderId: 'sender-to-review' }]);
    await button(wrapper, '确认此发送者是我本人').trigger('click');
    await flushPromises();
    expect(api.confirmPairing).toHaveBeenCalledWith('wx-1', 'sender-to-review');
    expect(wrapper.find('[aria-label="配对码"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('已确认本人账号');
  });

  it('discards login and pairing from the previous connection revision after an account switch', async () => {
    const wrapper = await openPanel();
    await showDetails(wrapper);
    api.startLogin.mockResolvedValue({ status: 'waiting', qrCodeUrl: 'https://weixin.example/old-login' });
    await button(wrapper, '获取登录二维码').trigger('click');
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(true);
    api.startPairing.mockResolvedValue({ code: 'SIYU-old-account', expiresAt: new Date(Date.now() + 300_000).toISOString(), confirmed: false });
    await button(wrapper, '生成配对码').trigger('click');
    await flushPromises();
    api.listConnections.mockResolvedValue([{ ...connection, revision: 4, state: 'connected', hasCredentials: true }]);
    await button(wrapper, '刷新状态').trigger('click');
    await flushPromises();
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('[aria-label="配对码"]').exists()).toBe(false);
    expect(api.getLogin).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('已连接');
    expect(wrapper.text()).not.toContain('等待扫码');
  });

  it('updates delivery and pairing data even when login polling fails', async () => {
    const wrapper = await openPanel();
    await showDetails(wrapper);
    api.startLogin.mockResolvedValue({ status: 'waiting', qrCodeUrl: 'https://weixin.example/login' });
    await button(wrapper, '获取登录二维码').trigger('click');
    await flushPromises();
    api.getLogin.mockRejectedValue(new Error('login unavailable'));
    api.getPairing.mockResolvedValue({ confirmed: false, candidateSenderId: 'new-candidate', expiresAt: new Date(Date.now() + 300_000).toISOString() });
    api.listDeliveries.mockResolvedValue([{ id: 'recent', connectionId: 'wx-1', status: 'failed', text: '新的投递记录', partIndex: 0, createdAt: '2026-10-15T01:00:00Z' }]);
    await button(wrapper, '刷新详情').trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('读取登录状态失败');
    expect(wrapper.text()).toContain('新的投递记录');
    expect(wrapper.text()).toContain('new-candidate');
    expect(button(wrapper, '确认此发送者是我本人').exists()).toBe(true);
  });

  it('requires confirmation before retrying an unknown delivery', async () => {
    api.listDeliveries.mockResolvedValue([{
      id: 'delivery-1', connectionId: 'wx-1', status: 'unknown', text: '你好',
      partIndex: 0, createdAt: '2026-10-15T01:02:03Z', lastError: '发送后连接中断',
    }]);
    const wrapper = await openPanel();
    await showDetails(wrapper);
    expect(wrapper.text()).toContain('结果未知');
    await button(wrapper, '重试此消息').trigger('click');
    expect(wrapper.text()).toContain('再次发送可能产生重复消息');
    expect(api.retryDelivery).not.toHaveBeenCalled();
    await button(wrapper, '取消重试').trigger('click');
    expect(api.retryDelivery).not.toHaveBeenCalled();
    await button(wrapper, '重试此消息').trigger('click');
    await button(wrapper, '确认重新发送').trigger('click');
    await flushPromises();
    expect(api.retryDelivery).toHaveBeenCalledWith('wx-1', 'delivery-1');
    expect(wrapper.text()).toContain('已请求重试');
  });

  it('requires a separate confirmation to remove a connection', async () => {
    const wrapper = await openPanel();
    await button(wrapper, '移除').trigger('click');
    expect(api.deleteConnection).not.toHaveBeenCalled();
    await button(wrapper, '确认移除').trigger('click');
    await flushPromises();
    expect(api.deleteConnection).toHaveBeenCalledWith('wx-1');
    expect(wrapper.find('.bot-connection').exists()).toBe(false);
  });

  it('clears a cancelled secret draft and stops polling when unmounted', async () => {
    vi.useFakeTimers();
    const wrapper = await openPanel();
    await button(wrapper, '编辑').trigger('click');
    await wrapper.get('[aria-label="访问令牌"]').setValue('discarded-secret');
    await wrapper.get('form').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('form').exists()).toBe(false);
    await button(wrapper, '编辑').trigger('click');
    expect((wrapper.get('[aria-label="访问令牌"]').element as HTMLInputElement).value).toBe('');
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.listConnections).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(12000);
    expect(api.listConnections).toHaveBeenCalledTimes(2);
  });

  it('ignores an old detail response after selecting another connection', async () => {
    api.listConnections.mockResolvedValue([connection, { ...connection, id: 'wx-2', displayName: '第二连接' }]);
    let finish: (value: unknown) => void = () => {};
    api.listDeliveries.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const wrapper = await openPanel();
    await button(wrapper, '登录与投递').trigger('click');
    await button(wrapper, '登录与投递').trigger('click');
    await flushPromises();
    finish([{ id: 'stale', connectionId: 'wx-1', status: 'failed', text: '旧连接的消息', partIndex: 0, createdAt: '2026-10-15T01:02:03Z' }]);
    await flushPromises();
    expect(wrapper.get('.bot-details').attributes('aria-label')).toBe('第二连接 详情');
    expect(wrapper.text()).not.toContain('旧连接的消息');
  });
});
