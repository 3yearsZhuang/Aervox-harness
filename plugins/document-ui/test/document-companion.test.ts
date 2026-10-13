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
const request = vi.fn(async (method: string, path: string) => {
  if (path === '/v1/sessions' && method === 'GET') return { items: [recentSession] };
  if (path === '/v1/sessions' && method === 'POST') return { id: 'ses_new', title: '新对话', createdAt: '', updatedAt: '' };
  return { items: [] };
});

beforeEach(() => {
  localStorage.clear();
  streamTurn.mockReset();
  streamTurn.mockImplementation(async (_sessionId: string, _content: string, callbacks: { onDelta: (t: string) => void; onDone: () => void }) => {
    callbacks.onDelta('我们接着昨天的进度。');
    callbacks.onDone();
  });
  request.mockClear();
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
  // 接续动作：对话盒切换为接续语（activeSession 持久化由 useAervoxSessions 既有契约覆盖；
  // 跨用例 transport 会话单态，localStorage 不作断言依据）
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
