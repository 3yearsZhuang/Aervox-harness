import { afterEach, expect, it, vi } from 'vitest';
import { createQuestionBridge } from '../src/mobile/native-question';

const questions = [{ id: 'q1', question: '要打开哪个应用？' }];
const request = { turnId: 'turn_1', attemptId: 'attempt_1', step: 1, questions };
afterEach(() => { vi.useRealTimers(); });

it('delivers a question to the observing turn and resolves it with the submitted answers', async () => {
  const bridge = createQuestionBridge();
  const delivered = vi.fn();
  bridge.observe('turn_1', delivered);
  const answer = bridge.port.ask(request);
  await Promise.resolve();
  expect(delivered).toHaveBeenCalledWith({ turnId: 'turn_1', questions, step: 1, timeoutMs: 120_000 });
  await bridge.submit('turn_1', [{ id: 'q1', selected: ['设置'], custom: undefined }].map(item => ({ ...item })));
  await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['设置'] }] });
});

it('holds a question until the surface attaches, then delivers it once', async () => {
  const bridge = createQuestionBridge();
  const pending = bridge.port.ask(request);
  await Promise.resolve();
  const delivered = vi.fn();
  bridge.observe('turn_1', delivered);
  expect(delivered).toHaveBeenCalledTimes(1);
  await bridge.submit('turn_1', [{ id: 'q1', selected: [] }]);
  await pending;
});

it('refuses answers for another turn, an empty answer list, or when nothing is pending', async () => {
  const bridge = createQuestionBridge();
  await expect(bridge.submit('turn_1', [{ id: 'q1', selected: [] }])).rejects.toThrow('QUESTION_NOT_PENDING');
  const pending = bridge.port.ask(request);
  await expect(bridge.submit('turn_other', [{ id: 'q1', selected: [] }])).rejects.toThrow('QUESTION_NOT_PENDING');
  await expect(bridge.submit('turn_1', [])).rejects.toThrow('QUESTION_ANSWERS_REQUIRED');
  await bridge.submit('turn_1', [{ id: 'q1', selected: [] }]);
  await pending;
});

it('rejects a second concurrent question instead of queueing it invisibly', async () => {
  const bridge = createQuestionBridge();
  const first = bridge.port.ask(request);
  await expect(bridge.port.ask({ ...request, turnId: 'turn_2' })).rejects.toThrow('QUESTION_PENDING');
  await bridge.submit('turn_1', [{ id: 'q1', selected: [] }]);
  await first;
});

it('expires an unanswered question with a fixed code', async () => {
  vi.useFakeTimers();
  const bridge = createQuestionBridge({ timeoutMs: 1_000 });
  const pending = bridge.port.ask(request);
  vi.advanceTimersByTime(1_001);
  await expect(pending).rejects.toThrow('QUESTION_TIMEOUT');
  vi.useRealTimers();
});

it('releases the turn when the host stops or the tool signal aborts', async () => {
  const bridge = createQuestionBridge();
  const controller = new AbortController();
  const aborted = bridge.port.ask({ ...request, signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toThrow('QUESTION_CANCELLED');
  const cancelled = bridge.port.ask(request);
  bridge.cancel();
  await expect(cancelled).rejects.toThrow('QUESTION_CANCELLED');
  // A released bridge accepts the next question.
  const next = bridge.port.ask(request);
  await bridge.submit('turn_1', [{ id: 'q1', selected: ['ok'] }]);
  await expect(next).resolves.toEqual({ answers: [{ id: 'q1', selected: ['ok'] }] });
});

it('stops delivering to a turn whose observation ended', async () => {
  const bridge = createQuestionBridge();
  const delivered = vi.fn();
  const stop = bridge.observe('turn_1', delivered);
  stop();
  const pending = bridge.port.ask(request);
  await Promise.resolve();
  expect(delivered).not.toHaveBeenCalled();
  await bridge.submit('turn_1', [{ id: 'q1', selected: [] }]);
  await pending;
});

it('does not replay an expired, cancelled or already answered queued question on reconnect', async () => {
  vi.useFakeTimers();
  for (const ending of ['timeout', 'cancel', 'answer'] as const) {
    const bridge = createQuestionBridge({ timeoutMs: 1_000 });
    const pending = bridge.port.ask(request).catch(error => error);
    if (ending === 'timeout') vi.advanceTimersByTime(1_001);
    else if (ending === 'cancel') bridge.cancel();
    else await bridge.submit('turn_1', [{ id: 'q1', selected: ['ok'] }]);
    await pending;
    const delivered = vi.fn();
    bridge.observe('turn_1', delivered);
    expect(delivered).not.toHaveBeenCalled();
  }
});
