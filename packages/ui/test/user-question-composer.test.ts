import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { AervoxHttpError, createFetchTransport } from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';
import UserQuestionComposer from '../src/components/UserQuestionComposer.vue';
import { getQuestionSubmissionIssue, hasOriginalQuestionIdentity, isSameOriginalQuestion } from '../src/utils/question-feedback';

enableAutoUnmount(afterEach);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T00:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

type OriginalQuestion = UserQuestionRequiredEventData & {
  attemptId: string; invocationId: string | null; identityStatus: 'available' | 'identity_unavailable'; expiresAt?: string;
};
const originalQuestion = (patch: Partial<OriginalQuestion> = {}): OriginalQuestion => ({
  turnId: 'turn', attemptId: 'attempt', invocationId: 'attempt:1:1', identityStatus: 'available', step: 1,
  questions: [{id: 'q', question: '选主题', options: [{label: 'A (Recommended)'}, {label: 'B'}]}],
  ...patch,
});

it('submits every question with multiple selections and free text only after explicit confirmation', async () => {
  const wrapper = mount(UserQuestionComposer, {props:{questionData:originalQuestion({questions:[
    {id:'topics',question:'选择主题',multiSelect:true,options:[{label:'A (Recommended)'},{label:'B'}]},
    {id:'detail',question:'补充要求'},
  ]})}});
  expect(wrapper.emitted('submit')).toBeUndefined();
  await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('input')[1]!.setValue('请带示例');
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')![0]![0]).toEqual([
    {id:'topics',selected:['A (Recommended)','B'],custom:undefined},
    {id:'detail',selected:[],custom:'请带示例'},
  ]);
});
it('clears old answers when the next question reuses an id', async () => {
  const wrapper = mount(UserQuestionComposer, {props:{questionData:originalQuestion({questions:[{id:'q',question:'旧问题',options:[{label:'旧选项'}]}]})}});
  await wrapper.get('.uq-option-btn').trigger('click');
  await wrapper.get('input').setValue('旧内容');
  await wrapper.setProps({questionData:originalQuestion({invocationId:'attempt:2:1',step:2,questions:[{id:'q',question:'新问题',options:[{label:'新选项'}]}]})});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.get('.uq-option-btn').attributes('aria-pressed')).toBe('false');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
});

it('keeps explicitly unavailable legacy questions read-only even with a recommended answer', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion({identityStatus: 'identity_unavailable', invocationId: null})}});
  expect(wrapper.get('.uq-feedback').text()).toBe('旧问题无法继续作答。');
  expect(wrapper.get('.uq-feedback').element.closest('.user-question-card')).toBe(wrapper.element);
  for (const control of wrapper.findAll('input, button')) expect(control.attributes('disabled')).toBeDefined();
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')).toBeUndefined();
});

it.each(['attemptId', 'invocationId', 'step'] as const)('does not submit a recommended answer when original %s is missing', async field => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: {...originalQuestion(), [field]: undefined}}});
  expect(wrapper.get('.uq-feedback').text()).toBe('旧问题无法继续作答。');
  for (const control of wrapper.findAll('input, button')) expect(control.attributes('disabled')).toBeDefined();
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')).toBeUndefined();
});

it('permits a complete original identity without requiring an extra availability flag', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: {...originalQuestion(), identityStatus: undefined}}});
  expect(wrapper.find('.uq-feedback').exists()).toBe(false);
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')![0]![0]).toEqual([{id: 'q', selected: ['A (Recommended)'], custom: undefined}]);
});

it('disables an expired absolute deadline and prefers it over a renewed relative timeout', () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion({
    expiresAt: '2026-11-06T23:59:59.999Z', timeoutMs: 120000,
  })}});
  expect(wrapper.get('.uq-feedback').text()).toBe('问题已结束，无法继续作答。');
  for (const control of wrapper.findAll('input, button')) expect(control.attributes('disabled')).toBeDefined();
  expect(wrapper.emitted('submit')).toBeUndefined();
});

it('ends a timed question in its existing card without dropping the entered answer', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion({timeoutMs: 1000})}});
  await wrapper.get('input').setValue('保留我的说明');
  expect(wrapper.find('.uq-feedback').exists()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(wrapper.get('.uq-feedback').text()).toBe('问题已结束，无法继续作答。');
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('保留我的说明');
  for (const control of wrapper.findAll('input, button')) expect(control.attributes('disabled')).toBeDefined();
});

it('checks wall-clock expiry during Enter submission even when the browser timer was delayed', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion({timeoutMs: 1000})}});
  vi.setSystemTime(new Date('2026-11-07T00:00:02.000Z'));
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeUndefined();
  await wrapper.get('input').trigger('keydown', {key: 'Enter'});
  expect(wrapper.emitted('submit')).toBeUndefined();
  expect(wrapper.get('.uq-feedback').text()).toBe('问题已结束，无法继续作答。');
});

it('retains answers and the original deadline when the complete original question is replayed', async () => {
  const data = originalQuestion({timeoutMs: 1000});
  const wrapper = mount(UserQuestionComposer, {props: {questionData: data}});
  await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.get('input').setValue('原补充');
  await vi.advanceTimersByTimeAsync(400);
  await wrapper.setProps({questionData: originalQuestion({
    timeoutMs: 120000, expiresAt: '2026-11-07T01:00:00.000Z',
    questions: [{options: [{label: 'A (Recommended)'}, {label: 'B'}], question: '选主题', id: 'q', multiSelect: false}],
  })});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('原补充');
  expect(wrapper.findAll('.uq-option-btn')[1]!.attributes('aria-pressed')).toBe('true');
  await vi.advanceTimersByTimeAsync(600);
  expect(wrapper.get('.uq-feedback').text()).toBe('问题已结束，无法继续作答。');
});

it.each([
  {turnId: 'new-turn'}, {attemptId: 'new-attempt'}, {invocationId: 'attempt:1:2'}, {step: 2},
])('clears answers when the original identity changes: %j', async identity => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion()}});
  await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.get('input').setValue('前一个问题的补充');
  await wrapper.setProps({questionData: originalQuestion(identity)});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.findAll('.uq-option-btn')[0]!.attributes('aria-pressed')).toBe('true');
  expect(wrapper.findAll('.uq-option-btn')[1]!.attributes('aria-pressed')).toBe('false');
});

it('clears answers when the same identity carries changed question content', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion()}});
  await wrapper.get('input').setValue('旧补充');
  await wrapper.setProps({questionData: originalQuestion({questions: [{id: 'q', question: '新的题目'}]})});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
});

it('keeps a legacy recommended question and its replay read-only without inventing identity', async () => {
  const data: UserQuestionRequiredEventData = {turnId: 'turn', step: 1,
    questions: [{id: 'q', question: '补充', options: [{label: 'A (Recommended)'}]}]};
  const wrapper = mount(UserQuestionComposer, {props: {questionData: data}});
  expect(wrapper.get('.uq-feedback').text()).toBe('旧问题无法继续作答。');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
  await wrapper.setProps({questionData: {...data}});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')).toBeUndefined();
});

it('keeps a retryable submission editable and shows closed feedback within the question card', async () => {
  const wrapper = mount(UserQuestionComposer, {props: {questionData: originalQuestion()}});
  await wrapper.get('input').setValue('待提交补充');
  await wrapper.setProps({submissionIssue: getQuestionSubmissionIssue(new Error('private raw details'))});
  expect(wrapper.get('.uq-feedback').text()).toBe('暂时无法确认提交结果，请再试一次。');
  expect(wrapper.get('.uq-submit-btn').text()).toContain('重新提交');
  expect(wrapper.get('input').attributes('disabled')).toBeUndefined();
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')![0]![0]).toEqual([{id: 'q', selected: ['A (Recommended)'], custom: '待提交补充'}]);
  await wrapper.setProps({submissionIssue: getQuestionSubmissionIssue(new AervoxHttpError(409, '/private', {code: 'QUESTION_NOT_PENDING'}))});
  expect(wrapper.get('.uq-feedback').text()).toBe('问题已结束，无法继续作答。');
  expect(wrapper.get('input').attributes('disabled')).toBeDefined();
});

it.each([
  ['QUESTION_IDENTITY_UNAVAILABLE', 'unavailable'], ['QUESTION_IDENTITY_REQUIRED', 'unavailable'],
  ['QUESTION_EXECUTION_IDENTITY_REQUIRED', 'unavailable'], ['QUESTION_IDENTITY_CONFLICT', 'unavailable'],
  ['QUESTION_EXPIRED', 'closed'], ['QUESTION_NOT_PENDING', 'closed'], ['QUESTION_CANCELLED', 'closed'],
  ['QUESTION_CLOSED', 'closed'], ['QUESTION_TIMEOUT', 'closed'], ['QUESTION_ANSWER_CONFLICT', 'closed'],
])('maps only typed transport code %s into fixed feedback', (code, kind) => {
  const issue = getQuestionSubmissionIssue(new AervoxHttpError(409, '/PRIVATE_PATH', {code, detail: 'PRIVATE_DETAIL'}));
  expect(issue.kind).toBe(kind);
  expect(issue.message).not.toContain('PRIVATE');
});

it('keeps unknown failures retryable without reading deceptive code text or private details', () => {
  for (const error of [
    new Error('QUESTION_EXPIRED'),
    new AervoxHttpError(500, '/PRIVATE_PATH', {code: 'UNKNOWN', detail: 'PRIVATE_DETAIL'}),
    new AervoxHttpError(409, '/PRIVATE_PATH', {code: 'UNKNOWN', error: 'QUESTION_EXPIRED'}),
    new AervoxHttpError(409, '/PRIVATE_PATH', {code: 'HTTP_409', error: 'QUESTION_EXPIRED private detail'}),
    new AervoxHttpError(409, '/PRIVATE_PATH', {code: 'HTTP_409', message: 'QUESTION_EXPIRED', detail: 'QUESTION_IDENTITY_UNAVAILABLE'}),
    new AervoxHttpError(500, '/PRIVATE_PATH', {error: 'QUESTION_EXPIRED'}),
    null,
  ]) {
    expect(getQuestionSubmissionIssue(error)).toEqual({kind: 'retryable', message: '暂时无法确认提交结果，请再试一次。'});
  }
});

it.each([
  {code: 'HTTP_409', error: 'QUESTION_EXPIRED', kind: 'closed'},
  {code: 'HTTP_409', error: 'QUESTION_IDENTITY_UNAVAILABLE', kind: 'unavailable'},
  {code: undefined, error: 'QUESTION_EXPIRED', kind: 'closed'},
])('classifies the actual fetch-parsed 409 envelope $code/$error without rendering diagnostics', async problem => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    status: 409, code: problem.code, error: problem.error, message: 'PRIVATE_MESSAGE', detail: 'PRIVATE_DETAIL',
  }), {status: 409, headers: {'content-type': problem.code ? 'application/problem+json' : 'application/json'}})));
  const failure = await createFetchTransport('https://api.test').submitQuestionAnswers('turn', [])
    .catch(error => error as unknown);
  expect(failure).toBeInstanceOf(AervoxHttpError);
  const issue = getQuestionSubmissionIssue(failure);
  expect(issue.kind).toBe(problem.kind);
  expect(issue.message).not.toContain('PRIVATE');
  expect(issue.message).not.toContain('QUESTION_');
});

it('matches full original identities or the exact legacy object without guessing from Turn and step', () => {
  expect(isSameOriginalQuestion(originalQuestion(), originalQuestion())).toBe(true);
  expect(isSameOriginalQuestion(originalQuestion(), originalQuestion({invocationId: 'different'}))).toBe(false);
  expect(isSameOriginalQuestion(originalQuestion(), originalQuestion({attemptId: ''}))).toBe(false);
  const legacy: UserQuestionRequiredEventData = {turnId: 'turn', step: 1, questions: [{id: 'q', question: '题目'}]};
  expect(isSameOriginalQuestion(legacy, legacy)).toBe(true);
  expect(hasOriginalQuestionIdentity(legacy)).toBe(false);
  expect(isSameOriginalQuestion(legacy, {...legacy})).toBe(false);
  expect(isSameOriginalQuestion(undefined, undefined)).toBe(false);
  expect(hasOriginalQuestionIdentity(originalQuestion())).toBe(true);
  expect(hasOriginalQuestionIdentity(originalQuestion({turnId: ''}))).toBe(false);
  expect(hasOriginalQuestionIdentity(originalQuestion({invocationId: null}))).toBe(false);
  expect(hasOriginalQuestionIdentity(originalQuestion({step: 0}))).toBe(false);
  expect(hasOriginalQuestionIdentity(originalQuestion({step: 1.5}))).toBe(false);
});
