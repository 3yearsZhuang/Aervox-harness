import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, type EffectScope } from 'vue';
import { AervoxHttpError, type ConversationController, type ConversationState } from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';
import { useWorkbenchConversation } from '../src/composables/useWorkbenchConversation';

const scopes: EffectScope[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
const question = (step = 1): UserQuestionRequiredEventData => ({turnId: 'turn', step,
  questions: [{id: 'q', question: '确认安排'}]});
const answers = [{id: 'q', selected: [], custom: '保留补充'}];

function fixture() {
  let state: Readonly<ConversationState> = {status: 'awaiting-input', turnId: 'turn', question: question()};
  const listeners = new Set<(value: Readonly<ConversationState>) => void>();
  const answer = vi.fn<ConversationController['answer']>();
  const controller: ConversationController = {
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit: vi.fn(), observe: vi.fn(), retry: vi.fn(), stop: vi.fn(), answer,
    decide: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
  };
  const scope = effectScope(); scopes.push(scope);
  const conversation = scope.run(() => useWorkbenchConversation({controller, recordActivity: vi.fn(), onApprovalDecision: vi.fn()}))!;
  return {answer, conversation, setQuestion(value: UserQuestionRequiredEventData) {
    state = {...state, question: value}; listeners.forEach(listener => listener(state));
  }};
}

it.each([
  [new Error('PRIVATE_PATH PRIVATE_DETAIL'), 'retryable'],
  [new AervoxHttpError(409, '/private', {code: 'QUESTION_EXPIRED'}), 'closed'],
  [new AervoxHttpError(409, '/private', {code: 'QUESTION_IDENTITY_UNAVAILABLE'}), 'unavailable'],
])('keeps scoped submission feedback out of assistant history', async (error, kind) => {
  const f = fixture();
  f.answer.mockRejectedValueOnce(error);
  const originalStory = JSON.stringify(f.conversation.story.value);
  await f.conversation.handleQuestionSubmit(answers);
  expect(f.conversation.questionSubmissionIssue.value?.kind).toBe(kind);
  expect(f.conversation.questionSubmissionIssue.value?.message).not.toContain('PRIVATE');
  expect(JSON.stringify(f.conversation.story.value)).toBe(originalStory);
  expect(f.conversation.questionSubmitting.value).toBe(false);
});

it('ignores a delayed failure after a different original question arrives', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.answer.mockReturnValueOnce(new Promise<void>((_resolve, fail) => {reject = fail;}));
  const pending = f.conversation.handleQuestionSubmit(answers);
  f.setQuestion(question(2));
  reject(new Error('private old failure'));
  await pending;
  expect(f.conversation.questionSubmissionIssue.value).toBeUndefined();
});

it('clears the original question issue after a successful retry', async () => {
  const f = fixture();
  f.answer.mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce();
  await f.conversation.handleQuestionSubmit(answers);
  expect(f.conversation.questionSubmissionIssue.value?.kind).toBe('retryable');
  await f.conversation.handleQuestionSubmit(answers);
  expect(f.conversation.questionSubmissionIssue.value).toBeUndefined();
  expect(f.answer).toHaveBeenCalledTimes(2);
});
