import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { configureAervoxClient } from '@aervox/api-client';
import definition from '../src';

enableAutoUnmount(afterEach);

// Compile the actual lazy Vue module before measuring host readiness.
beforeAll(async () => { await definition.load(); });

const recentSession = {
  id: 'ses_recent',
  title: '死锁复习',
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

const streamTurn = vi.fn();
const requestImplementation = async (method: string, path: string) => {
  if (path === '/v1/sessions' && method === 'GET') return { items: [recentSession] };
  if (path === '/v1/sessions' && method === 'POST') return { id: 'ses_new', title: '新对话', createdAt: '', updatedAt: '' };
  return { items: [] };
};
const request = vi.fn(requestImplementation);

beforeEach(() => {
  localStorage.clear();
  streamTurn.mockReset();
  streamTurn.mockImplementation(async (_sessionId: string, _content: string, callbacks: { onDelta: (t: string) => void; onDone: () => void }) => {
    callbacks.onDelta('我们接着昨天的进度。');
    callbacks.onDone();
  });
  request.mockReset();
  request.mockImplementation(requestImplementation);
  configureAervoxClient({
    sessionId: 'test_initial',
    transport: {
      request: request as never,
      streamTurn: streamTurn as never,
      submitQuestionAnswers: vi.fn(),
      decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

async function mountSurface() {
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'main', platform: 'web' },
  });
  await vi.waitFor(() => expect(wrapper.find('.document-companion').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  return wrapper;
}

it('loads through the host and renders the minimal first-level page', async () => {
  const wrapper = await mountSurface();
  expect(wrapper.find('.dc-dialogue').exists()).toBe(true);
  expect(wrapper.findAll('.dc-choice')).toHaveLength(2);
  expect(wrapper.find('.dc-whisper-pill').exists()).toBe(true);
  // 输入框默认不可见——淡化输入存在感
  expect(wrapper.find('.dc-whisper-input').exists()).toBe(false);
});

it('resume card reflects the most recent session and switches to it', async () => {
  const wrapper = await mountSurface();
  const resume = wrapper.findAll('.dc-choice')[0]!;
  expect(resume.text()).toContain('死锁复习');
  expect(resume.text()).toContain('昨天');
  await resume.trigger('click');
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_recent');
  await vi.waitFor(() => expect(wrapper.find('.dc-dialogue').text()).toContain('接着上次的地方继续'), { timeout: 2000 });
});

it('focus card sends a real turn and streams the reply into the dialogue box', async () => {
  const wrapper = await mountSurface();
  const focus = wrapper.findAll('.dc-choice').find((c) => c.text().includes('专注'))!;
  await focus.trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toContain('专注');
  expect(wrapper.find('.dc-dialogue').text()).toContain('我们接着昨天的进度');
});

it('whisper input replaces the choices while open and sends on Enter', async () => {
  const wrapper = await mountSurface();
  await wrapper.find('.dc-whisper-pill').trigger('click');
  expect(wrapper.find('.dc-whisper-input').exists()).toBe(true);
  await wrapper.find('.dc-whisper-input input').setValue('讲讲环路等待');
  await wrapper.find('.dc-whisper-input input').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toBe('讲讲环路等待');
  // 发送后回到卡片主导
  expect(wrapper.find('.dc-whisper-input').exists()).toBe(false);
});

it('creates a real session before the first turn with an empty session list', async () => {
  request.mockImplementation(async (method, path) => path === '/v1/sessions' && method === 'GET'
    ? { items: [] } : requestImplementation(method, path));
  const wrapper = await mountSurface();
  await wrapper.findAll('.dc-choice')[0]!.trigger('click');
  await flushPromises();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_new');
});

it('releases sending state after session creation fails and permits retry', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === '/v1/sessions') return { items: [] };
    if (method === 'POST' && path === '/v1/sessions') throw new Error('session unavailable');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface();
  const goal = wrapper.findAll('.dc-choice')[0]!;
  await goal.trigger('click');
  await flushPromises();
  expect(streamTurn).not.toHaveBeenCalled();
  expect(goal.attributes('disabled')).toBeUndefined();
  expect(wrapper.find('.dc-ctx').text()).toBe('连接异常');
  request.mockImplementation(requestImplementation);
  await goal.trigger('click');
  await flushPromises();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_new');
});

it('keeps a failed whisper for retry and sends configured identity with the active session', async () => {
  localStorage.setItem('aervox-settings', JSON.stringify({ companionName: '团子', userAddress: '掌柜' }));
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  expect(wrapper.find('.dc-name').text()).toBe('团子');
  await wrapper.find('.dc-whisper-pill').trigger('click');
  const input = wrapper.find('.dc-whisper-input input');
  await input.setValue('讲讲环路等待');
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect((input.element as HTMLInputElement).value).toBe('讲讲环路等待');
  expect(wrapper.find('.dc-whisper-input button').attributes('disabled')).toBeUndefined();
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![0]).toBe('ses_recent');
  expect(streamTurn.mock.calls[1]![3]).toMatchObject({
    sessionId: 'ses_recent', metadata: { companionName: '团子', userAddress: '掌柜' },
  });
  expect(wrapper.find('.dc-whisper-input').exists()).toBe(false);
});

it('keeps a new draft edited during the current submission', async () => {
  let resolveTurn!: () => void;
  streamTurn.mockImplementation(() => new Promise<void>(resolve => { resolveTurn = resolve; }));
  const wrapper = await mountSurface();
  await wrapper.find('.dc-whisper-pill').trigger('click');
  const input = wrapper.find('.dc-whisper-input input');
  await input.setValue('第一条');
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  await input.setValue('下一条');
  await input.trigger('keydown', { key: 'Enter' });
  expect(streamTurn).toHaveBeenCalledOnce();
  resolveTurn();
  await flushPromises();
  expect((input.element as HTMLInputElement).value).toBe('下一条');
  expect(wrapper.find('.dc-whisper-input').exists()).toBe(true);
});

it('aborts the instance stream when the surface is removed', async () => {
  let resolveTurn!: () => void;
  streamTurn.mockImplementation(() => new Promise<void>(resolve => { resolveTurn = resolve; }));
  const wrapper = await mountSurface();
  await wrapper.findAll('.dc-choice')[1]!.trigger('click');
  await flushPromises();
  const signal = streamTurn.mock.calls[0]![3].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  wrapper.unmount();
  expect(signal.aborted).toBe(true);
  resolveTurn();
  await flushPromises();
});
