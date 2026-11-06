// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { AervoxHttpError } from '@aervox/api-client';
import NativeLearningPanel from '../src/mobile/NativeLearningPanel.vue';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  getClientTransport: () => ({ request }),
}));
enableAutoUnmount(afterEach);
const questions = [1, 2, 3].map(n => ({ id: `q${n}`, prompt: `第 ${n} 道题？` }));
const session = { sessionId: 'practice_1', items: questions, answeredQuestionIds: [], nextQuestionIndex: 0 };
const report = { sessionId: 'practice_1', questionCount: 3, answeredCount: 3, correctCount: 2, incorrectCount: 1,
  unverifiableCount: 0, guidance: { message: '保持练习，下次继续。' } };
async function defaults(method: string, path: string) {
  if (path === '/v1/practice/questions?count=3') return { items: questions };
  if (path === '/v1/practice/sessions/active') throw new AervoxHttpError(404, path, { code: 'PRACTICE_SESSION_NOT_FOUND' });
  if (path === '/v1/practice/sessions' && method === 'POST') return session;
  if (path.endsWith('/attempts')) return { judgement: 'correct' };
  if (path.endsWith('/complete')) return report;
  return { items: [] };
}
const button = (wrapper: VueWrapper, label: string) => wrapper.findAll('md-text-button, md-filled-tonal-button, md-outlined-button').find(item => item.text() === label)!;
async function mounted() { const wrapper = mount(NativeLearningPanel); await flushPromises(); return wrapper; }
beforeEach(() => { request.mockReset(); request.mockImplementation(defaults); });

it('opens imported questions, records three answers, and completes the saved practice report', async () => {
  const wrapper = await mounted();
  expect(wrapper.text()).toContain('题库已准备好');
  await button(wrapper, '开始 3 题练习').trigger('click'); await flushPromises();
  for (let n = 1; n <= 3; n++) {
    expect(wrapper.text()).toContain(`第 ${n} 道题？`);
    await wrapper.get('textarea').setValue(`答案${n}`);
    await button(wrapper, '提交答案').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('答对了');
    await button(wrapper, n === 3 ? '查看练习报告' : '下一题').trigger('click');
  }
  await button(wrapper, '完成并查看报告').trigger('click'); await flushPromises();
  expect(request).toHaveBeenCalledWith('POST', '/v1/practice/sessions/practice_1/complete', {});
  expect(wrapper.text()).toContain('已答 3 题 · 答对 2 题 · 答错 1 题');
  expect(wrapper.text()).toContain('保持练习，下次继续。');
  expect(request.mock.calls.filter(call => call[1].endsWith('/attempts'))).toHaveLength(3);
});

it('resumes the first unanswered question without creating another practice session', async () => {
  request.mockImplementation(async (method, path) => path === '/v1/practice/sessions/active'
    ? { ...session, answeredQuestionIds: ['q1'], nextQuestionIndex: 1 } : defaults(method, path));
  const wrapper = await mounted();
  expect(wrapper.text()).toContain('已答 1 / 3 题');
  expect(wrapper.text()).toContain('第 2 道题？');
  expect(wrapper.text()).not.toContain('第 1 道题？');
  expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false);
});

it('keeps one answer and idempotency key across an uncertain submission retry', async () => {
  let attempts = 0;
  request.mockImplementation(async (method, path) => {
    if (path.endsWith('/attempts') && ++attempts === 1) throw new Error('receipt lost');
    return defaults(method, path);
  });
  const wrapper = await mounted();
  await button(wrapper, '开始 3 题练习').trigger('click'); await flushPromises();
  await wrapper.get('textarea').setValue('第一份答案');
  await button(wrapper, '提交答案').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('这次作答尚未确认');
  expect(wrapper.get('textarea').attributes('readonly')).toBeDefined();
  await button(wrapper, '重试提交答案').trigger('click'); await flushPromises();
  const calls = request.mock.calls.filter(call => call[1].endsWith('/attempts'));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0][2]).toMatchObject({ answer: '第一份答案', sessionId: 'practice_1' });
  expect(calls[0][3].headers['Idempotency-Key']).toBeTruthy();
  expect(wrapper.text()).toContain('答对了');
});

it('shows the knowledge concept and retries the same review choice before advancing', async () => {
  let completions = 0;
  request.mockImplementation(async (method, path) => {
    if (path.startsWith('/v1/review-items/summary')) return { items: [{ id: 'review_1', knowledgeId: 'k1' }] };
    if (path === '/v1/knowledge-items/k1') return { concept: '二次方程的求根公式' };
    if (path === '/v1/review-items/review_1/complete') {
      if (++completions === 1) throw new Error('receipt lost');
      return { completed: { id: 'review_1' } };
    }
    return defaults(method, path);
  });
  const wrapper = await mounted();
  expect(wrapper.text()).toContain('二次方程的求根公式');
  await button(wrapper, '还需复习').trigger('click'); await flushPromises();
  expect(wrapper.text()).toContain('这次复习尚未确认');
  await button(wrapper, '重试记录复习').trigger('click'); await flushPromises();
  const calls = request.mock.calls.filter(call => call[1] === '/v1/review-items/review_1/complete');
  expect(calls).toHaveLength(2);
  expect(calls[0][2]).toEqual(calls[1][2]);
  expect(calls[0][2].isCorrect).toBe(false);
  expect(wrapper.text()).toContain('当前没有到期复习');
  expect(wrapper.text()).toContain('下次复习已安排');
});

it('allows a failed record load to be retried without exposing internal errors', async () => {
  request.mockRejectedValue(new Error('private database detail'));
  const wrapper = await mounted();
  expect(wrapper.text()).toContain('部分学习记录没有读到');
  expect(wrapper.text()).not.toContain('private database detail');
  request.mockImplementation(defaults);
  await button(wrapper, '刷新学习记录').trigger('click'); await flushPromises();
  expect(wrapper.text()).not.toContain('部分学习记录没有读到');
  expect(wrapper.text()).toContain('题库已准备好');
});
