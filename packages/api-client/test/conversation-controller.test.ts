import { describe, expect, it, vi } from 'vitest';
import { createConversationController } from '../src/conversation-controller';
import type { AervoxTransport, TurnCallbacks, StreamTurnOptions } from '../src/transport';

const callbacks = (): TurnCallbacks => ({onDelta: vi.fn(), onDone: vi.fn()});
function fixture() {
  const streamTurn = vi.fn<AervoxTransport['streamTurn']>();
  const request = vi.fn<AervoxTransport['request']>().mockResolvedValue({});
  const observeTurn = vi.fn<NonNullable<AervoxTransport['observeTurn']>>();
  const submitQuestionAnswers = vi.fn().mockResolvedValue(undefined);
  const decideToolApproval = vi.fn().mockResolvedValue(undefined);
  const transport: AervoxTransport = {streamTurn, request, observeTurn, submitQuestionAnswers, decideToolApproval};
  return {controller: createConversationController(transport), streamTurn, request, observeTurn, submitQuestionAnswers, decideToolApproval};
}

describe('ConversationController', () => {
  it('retains the same reservation for an unknown acceptance and forbids accepted resubmission', async () => {
    const {controller, streamTurn} = fixture();
    streamTurn.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async (_session, _content, cb, options) => {
      await options?.onAccepted?.('turn'); cb.onDelta('partial'); throw new Error('disconnected');
    });
    await expect(controller.submit('session', 'hello', callbacks())).rejects.toThrow('offline');
    const key = streamTurn.mock.calls[0]![3]!.idempotencyKey;
    await expect(controller.retry(callbacks())).rejects.toThrow('disconnected');
    expect(streamTurn.mock.calls[1]![3]!.idempotencyKey).toBe(key);
    expect(controller.state.status).toBe('observer-error');
    await expect(controller.retry(callbacks())).rejects.toThrow('submission_not_retryable');
    expect(streamTurn).toHaveBeenCalledTimes(2);
  });

  it('remembers stop before acceptance, cancels exactly once, and aborts the observer afterwards', async () => {
    const {controller, streamTurn, request} = fixture();
    let options!: StreamTurnOptions;
    streamTurn.mockImplementation(async (_s, _c, _cb, input) => {
      options = input!;
      await new Promise<void>((resolve, reject) => input!.signal!.addEventListener('abort', () => reject(input!.signal!.reason), {once: true}));
    });
    const pending = controller.submit('session', 'hello', callbacks());
    await controller.stop();
    expect(request).not.toHaveBeenCalled();
    await options.onAccepted!('turn');
    await pending;
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/v1/turns/turn/cancel', {}, expect.any(Object));
    expect(options.signal!.aborted).toBe(true);
    expect(controller.state.status).toBe('stopped');
  });

  it('keeps cancellation failure retryable while the original stream remains active', async () => {
    const {controller, streamTurn, request} = fixture();
    let options!: StreamTurnOptions;
    streamTurn.mockImplementation(async (_s, _c, _cb, input) => {
      options = input!;
      await input!.onAccepted!('turn');
      await new Promise<void>((_resolve, reject) => input!.signal!.addEventListener('abort', () => reject(input!.signal!.reason), {once: true}));
    });
    const pending = controller.submit('session', 'hello', callbacks());
    await Promise.resolve();
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(controller.stop()).rejects.toThrow('offline');
    expect(options.signal!.aborted).toBe(false);
    await controller.stop(); await pending;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not let a late cancellation overwrite a different Turn', async () => {
    const {controller, streamTurn, request} = fixture();
    let finish!: () => void, cancel!: () => void;
    streamTurn.mockImplementationOnce(async (_s, _c, cb, input) => {
      await input!.onAccepted!('old');
      await new Promise<void>(resolve => {finish = () => {cb.onDone(); resolve();};});
    }).mockImplementationOnce(async (_s, _c, _cb, input) => {
      await input!.onAccepted!('new');
      await new Promise<void>((_resolve, reject) => input!.signal!.addEventListener('abort', () => reject(input!.signal!.reason)));
    });
    request.mockImplementation(() => new Promise(resolve => {cancel = () => resolve({});}));
    const first = controller.submit('s', 'one', callbacks()); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const stopping = controller.stop(); finish(); await first;
    const second = controller.submit('s', 'two', callbacks());
    cancel(); await stopping;
    expect(controller.state).toMatchObject({turnId: 'new', status: 'observing'});
    controller.dispose(); await expect(second).rejects.toMatchObject({name: 'AbortError'});
  });

  it('owns questions and approval continuation without a second submission', async () => {
    const {controller, streamTurn, submitQuestionAnswers, decideToolApproval, observeTurn} = fixture();
    streamTurn.mockImplementation(async (_s, _c, cb, options) => {
      await options!.onAccepted!('turn');
      cb.onUserQuestion!({turnId: 'turn', questions: []} as never);
      await controller.answer([{id: 'q', selected: ['yes']}]);
      cb.onToolApproval!({turnId: 'turn', approvalId: 'approval', toolName: 'write'} as never);
      cb.onDone();
    });
    await controller.submit('s', 'hello', callbacks());
    expect(submitQuestionAnswers).toHaveBeenCalledWith('turn', [{id: 'q', selected: ['yes']}], undefined);
    expect(controller.state.status).toBe('awaiting-approval');
    decideToolApproval.mockResolvedValue({continuation: {afterEventId: 'decision', attemptId: 'attempt'}});
    observeTurn.mockImplementation(async (_turn, cb) => { cb.onDelta('continued'); cb.onDone(); });
    await controller.decide('granted', callbacks());
    expect(observeTurn).toHaveBeenCalledWith('turn', expect.any(Object), expect.objectContaining({afterEventId: 'decision'}));
    expect(streamTurn).toHaveBeenCalledOnce();
    expect(controller.state.status).toBe('completed');
  });

  it('serializes pending interaction writes and preserves a newer question', async () => {
    const {controller, streamTurn, submitQuestionAnswers} = fixture();
    let forward!: TurnCallbacks;
    let finishAnswer!: () => void;
    const firstQuestion = {turnId: 'turn', questions: []} as never;
    const nextQuestion = {turnId: 'turn', questions: [{id: 'new'}]} as never;
    streamTurn.mockImplementation(async (_s, _c, cb, options) => {
      forward = cb;
      await options!.onAccepted!('turn');
      cb.onUserQuestion!(firstQuestion); cb.onDone();
    });
    await controller.submit('s', 'hello', callbacks());
    submitQuestionAnswers.mockImplementation(() => new Promise<void>(resolve => { finishAnswer = resolve; }));
    const answering = controller.answer([]);
    await expect(controller.answer([])).rejects.toThrow('conversation_busy');
    await expect(controller.submit('s', 'another', callbacks())).rejects.toThrow('conversation_busy');
    forward.onUserQuestion!(nextQuestion);
    finishAnswer(); await answering;
    expect(controller.state.question).toBe(nextQuestion);
    expect(controller.state.status).toBe('awaiting-input');
    expect(submitQuestionAnswers).toHaveBeenCalledOnce();
  });

  it('does not resume a Turn when cancellation wins an in-flight approval decision', async () => {
    const {controller, streamTurn, decideToolApproval, observeTurn} = fixture();
    streamTurn.mockImplementation(async (_s, _c, cb, options) => {
      await options!.onAccepted!('turn');
      cb.onToolApproval!({turnId: 'turn', approvalId: 'approval', toolName: 'write'} as never); cb.onDone();
    });
    await controller.submit('s', 'hello', callbacks());
    let finishDecision!: (value: unknown) => void;
    decideToolApproval.mockImplementation(() => new Promise(resolve => { finishDecision = resolve; }));
    const deciding = controller.decide('granted', callbacks());
    await expect(controller.decide('denied', callbacks())).rejects.toThrow('conversation_busy');
    await controller.stop();
    finishDecision({continuation: {afterEventId: 'decision', attemptId: 'attempt'}});
    await deciding;
    expect(controller.state.status).toBe('stopped');
    expect(observeTurn).not.toHaveBeenCalled();
  });

  it('rejects a competing submit without clearing the active Turn state', async () => {
    const {controller, streamTurn} = fixture();
    streamTurn.mockImplementation(async (_s, _c, _cb, options) => {
      await options!.onAccepted!('turn');
      await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason)));
    });
    const pending = controller.submit('s', 'hello', callbacks()); await Promise.resolve();
    await expect(controller.submit('s', 'competing', callbacks())).rejects.toThrow('conversation_busy');
    expect(controller.state.turnId).toBe('turn');
    controller.dispose(); await expect(pending).rejects.toMatchObject({name: 'AbortError'});
  });
});
