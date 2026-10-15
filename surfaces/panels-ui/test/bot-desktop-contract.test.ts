import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { configureAervoxClient, desktopTransport, getTransport } from '@aervox/api-client';
import BotConnectionsPanel from '../src/bot/BotConnectionsPanel.vue';

enableAutoUnmount(afterEach);

it('recovers a bot revision conflict through the real client and desktop transport', async () => {
  const previousTransport = getTransport();
  const previousBridge = window.fairyDesktop;
  const connection = { id: 'bot-1', adapterId: 'weixin', displayName: '我的微信', enabled: false, revision: 1, config: {}, state: 'stopped', hasCredentials: true };
  let conflict = true;
  const apiRequest = vi.fn(async (method: string, path: string, body?: unknown) => {
    let json: unknown;
    if (path === '/v1/bot-adapters') json = { adapters: [{ id: 'weixin', displayName: '微信私聊', platform: 'weixin', capabilities: { login: true, directMessages: true, groupMessages: false, maxTextLength: 2000 } }] };
    else if (method === 'GET' && path === '/v1/bot-connections') json = { connections: [{ ...connection }] };
    else if (method === 'PATCH') {
      if (conflict) {
        conflict = false;
        connection.revision = 2;
        connection.displayName = '另一处修改';
        return { status: 409, ok: false, json: { code: 'bot_connection_revision_conflict' }, text: '{"code":"bot_connection_revision_conflict"}' };
      }
      Object.assign(connection, body, { revision: connection.revision + 1 });
      json = { ...connection };
    } else if (path.endsWith('/deliveries')) json = { deliveries: [] };
    else if (path.endsWith('/pairing')) json = { confirmed: false };
    else throw new Error(`Unexpected bridge request: ${method} ${path}`);
    return { status: 200, ok: true, json, text: JSON.stringify(json) };
  });
  window.fairyDesktop = { apiRequest: apiRequest as NonNullable<Window['fairyDesktop']>['apiRequest'], streamTurn: vi.fn() };
  configureAervoxClient({ transport: desktopTransport });
  const wrapper = mount(BotConnectionsPanel);
  const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!;
  try {
    await flushPromises();
    await button('编辑').trigger('click');
    await wrapper.get('[aria-label="连接名称"]').setValue('本地草稿');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('本次修改尚未保存');
    expect((wrapper.get('[aria-label="连接名称"]').element as HTMLInputElement).value).toBe('本地草稿');
    expect(button('保存连接').attributes('disabled')).toBeDefined();
    await button('放弃草稿并载入最新配置').trigger('click');
    await flushPromises();
    expect((wrapper.get('[aria-label="连接名称"]').element as HTMLInputElement).value).toBe('另一处修改');
    await wrapper.get('[aria-label="连接名称"]').setValue('合并后的名称');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const updates = apiRequest.mock.calls.filter(([method]) => method === 'PATCH');
    expect(updates).toEqual([
      ['PATCH', '/v1/bot-connections/bot-1', { revision: 1, displayName: '本地草稿', enabled: false, config: {} }, undefined],
      ['PATCH', '/v1/bot-connections/bot-1', { revision: 2, displayName: '合并后的名称', enabled: false, config: {} }, undefined],
    ]);
    expect(wrapper.find('form').exists()).toBe(false);
    expect(wrapper.text()).toContain('连接已保存');
  } finally {
    wrapper.unmount();
    configureAervoxClient({ transport: previousTransport });
    window.fairyDesktop = previousBridge;
  }
});
