import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationController } from '../src/conversation-controller';
import { createFetchTransport } from '../src/transport';
import type { AervoxTransport, TurnCallbacks, StreamTurnOptions } from '../src/transport';

const callbacks = (): TurnCallbacks => ({onDelta: vi.fn(), onDone: vi.fn()});
afterEach(() => { vi.unstubAllGlobals(); });
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
    const {controller, streamTurn, observeTurn} = fixture();
    observeTurn.mockImplementation(async (_turn, cb) => { cb.onDelta('continued'); cb.onDone(); });
    streamTurn.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async (_session, _content, cb, options) => {
      await options?.onAccepted?.('turn'); cb.onDelta('partial'); throw new Error('disconnected');
    });
    await expect(controller.submit('session', 'hello', callbacks())).rejects.toThrow('offline');
    const key = streamTurn.mock.calls[0]![3]!.idempotencyKey;
    await expect(controller.retry(callbacks())).rejects.toThrow('disconnected');
    expect(streamTurn.mock.calls[1]![3]!.idempotencyKey).toBe(key);
    expect(controller.state.status).toBe('observer-error');
    await controller.retry(callbacks());
    expect(observeTurn).toHaveBeenCalledWith('turn', expect.any(Object), expect.objectContaining({afterEventId: undefined}));
    expect(controller.state.status).toBe('completed');
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
    expect(submitQuestionAnswers).toHaveBeenCalledWith('turn', [{id: 'q', selected: ['yes']}], expect.any(AbortSignal));
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
    const aborted = expect(deciding).rejects.toMatchObject({name: 'AbortError'});
    await expect(controller.decide('denied', callbacks())).rejects.toThrow('conversation_busy');
    await controller.stop();
    finishDecision({continuation: {afterEventId: 'decision', attemptId: 'attempt'}});
    await aborted;
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

const event = (eventId: string, sequence: number) => ({eventId, turnId: 'turn', sequence, eventType: 'delta', data: {text: eventId}} as const);
it('resumes after the last consumed event and preserves pending questions across repeated observation failures', async () => {
  const {controller, streamTurn, observeTurn} = fixture();
  const question = {turnId: 'turn', questions: [{id: 'q'}]} as never;
  streamTurn.mockImplementation(async (_s, _c, cb, options) => {
    await options!.onAccepted!('turn');
    cb.onUserQuestion!(question);
    await cb.onEvent!(event('seen', 1));
    throw new Error('disconnected');
  });
  await expect(controller.submit('s', 'hello', callbacks())).rejects.toThrow('disconnected');
  observeTurn.mockImplementationOnce(async (_turn, cb) => {
    expect(controller.state.question).toBe(question);
    await cb.onEvent!(event('next', 2));
    throw new Error('offline again');
  }).mockImplementationOnce(async (_turn, cb) => { cb.onDone(); });
  await expect(controller.retry(callbacks())).rejects.toThrow('offline again');
  await controller.retry(callbacks());
  expect(observeTurn.mock.calls.map(call => call[2]!.afterEventId)).toEqual(['seen', 'next']);
  expect(controller.state.question).toBe(question);
  expect(controller.state.status).toBe('awaiting-input');
  expect(streamTurn).toHaveBeenCalledOnce();
});
it('does not acknowledge an event whose async consumer fails', async () => {
  const {controller, streamTurn, observeTurn} = fixture();
  streamTurn.mockImplementation(async (_s, _c, cb, options) => {
    await options!.onAccepted!('turn');
    await cb.onEvent!(event('seen', 1));
    await cb.onEvent!(event('not-consumed', 2));
  });
  await expect(controller.submit('s', 'hello', {...callbacks(), onEvent: async e => {
    if (e.eventId === 'not-consumed') throw new Error('consumer failed');
  }})).rejects.toThrow('consumer failed');
  observeTurn.mockImplementation(async (_turn, cb) => { cb.onDone(); });
  await controller.retry(callbacks());
  expect(observeTurn).toHaveBeenCalledWith('turn', expect.any(Object), expect.objectContaining({afterEventId: 'seen'}));
});
it('detaches questions and observations on reset without cancelling server execution', async () => {
  const {controller, streamTurn, request, submitQuestionAnswers} = fixture();
  let old!: TurnCallbacks;
  streamTurn.mockImplementation(async (_s, _c, cb, options) => {
    old = cb; await options!.onAccepted!('turn'); cb.onUserQuestion!({turnId: 'turn', questions: []} as never);
  });
  await controller.submit('s', 'hello', callbacks());
  controller.reset();
  old.onUserQuestion!({turnId: 'turn', questions: [{id: 'late'}]} as never);
  expect(controller.state).toMatchObject({status: 'idle', turnId: undefined, question: undefined, retryAvailable: false});
  await expect(controller.answer([])).rejects.toThrow('question_not_pending');
  expect(request).not.toHaveBeenCalled(); expect(submitQuestionAnswers).not.toHaveBeenCalled();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function pendingInteraction(kind: 'answer' | 'approval') {
  const fixtureState = fixture();
  fixtureState.streamTurn.mockImplementation(async (_session, _content, forward, options) => {
    await options!.onAccepted!('turn');
    if (kind === 'answer') forward.onUserQuestion!({turnId: 'turn', step: 1, questions: [{id: 'q', question: 'Confirm?'}]} as never);
    else forward.onToolApproval!({turnId: 'turn', approvalId: 'approval', toolName: 'write'} as never);
    forward.onDone();
  });
  const write = deferred<any>();
  const send = kind === 'answer' ? fixtureState.submitQuestionAnswers : fixtureState.decideToolApproval;
  send.mockImplementation(() => write.promise);
  return {...fixtureState, write, send, begin: () => kind === 'answer' ? fixtureState.controller.answer([]) : fixtureState.controller.decide('granted', callbacks())};
}

describe.each(['answer', 'approval'] as const)('in-flight %s ownership', kind => {
  it('keeps failed writes visible and leaves their interaction available for retry', async () => {
    const {controller, begin, send, write} = pendingInteraction(kind);
    await controller.submit('session', 'one', callbacks());
    const error = new Error('write offline');
    const pending = begin();
    const failed = expect(pending).rejects.toBe(error);
    write.reject(error);
    await failed;
    expect(controller.state.error).toBe(error);
    expect(controller.state.status).toBe(kind === 'answer' ? 'awaiting-input' : 'awaiting-approval');
    expect(controller.state[kind === 'answer' ? 'question' : 'approval']).toBeDefined();
    send.mockResolvedValueOnce(undefined);
    await begin();
    expect(controller.state.error).toBeUndefined();
    expect(controller.state[kind === 'answer' ? 'question' : 'approval']).toBeUndefined();
  });

  it.each(['reset', 'dispose'] as const)('%s detaches even a silent write and aborts its local wait', async action => {
    const {controller, begin, send, request, observeTurn} = pendingInteraction(kind);
    await controller.submit('session', 'one', callbacks());
    const pending = begin();
    const aborted = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const signal = send.mock.calls[0]!.at(-1) as AbortSignal;
    controller[action]();
    await aborted;
    expect(signal.aborted).toBe(true);
    expect(request).not.toHaveBeenCalled(); expect(observeTurn).not.toHaveBeenCalled();
    if (action === 'reset') {
      await controller.submit('next-session', 'two', callbacks());
      expect(controller.state.status).toBe(kind === 'answer' ? 'awaiting-input' : 'awaiting-approval');
    } else await expect(controller.submit('next-session', 'two', callbacks())).rejects.toThrow('conversation_disposed');
  });

  it('ignores late results after reset without releasing a newer write or resuming the old Turn', async () => {
    const {controller, begin, send, write, observeTurn} = pendingInteraction(kind);
    await controller.submit('session', 'one', callbacks());
    const old = begin();
    const aborted = expect(old).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    controller.reset();
    await controller.submit('next-session', 'two', callbacks());
    const newer = deferred<any>();
    send.mockImplementationOnce(() => newer.promise);
    const current = begin();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    write.resolve({continuation: {afterEventId: 'old-decision', attemptId: 'old-attempt'}});
    await aborted;
    await expect(begin()).rejects.toThrow('conversation_busy');
    expect(controller.state.status).toBe(kind === 'answer' ? 'awaiting-input' : 'awaiting-approval');
    expect(observeTurn).not.toHaveBeenCalled();
    newer.resolve(undefined);
    await current;
    expect(controller.state.status).toBe(kind === 'answer' ? 'observing' : 'completed');
  });

  it('retains ownership after cancellation failure, deduplicates stop retries, and releases only on confirmed cancellation', async () => {
    const {controller, begin, send, request, observeTurn} = pendingInteraction(kind);
    await controller.submit('session', 'one', callbacks());
    const pending = begin();
    const aborted = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    const signal = send.mock.calls[0]!.at(-1) as AbortSignal;
    request.mockRejectedValueOnce(new Error('cancel offline'));
    await expect(controller.stop()).rejects.toThrow('cancel offline');
    expect(signal.aborted).toBe(false);
    await expect(begin()).rejects.toThrow('conversation_busy');
    const cancellation = deferred<any>();
    request.mockImplementationOnce(() => cancellation.promise);
    const firstStop = controller.stop(), secondStop = controller.stop();
    expect(request).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    cancellation.resolve({});
    await Promise.all([firstStop, secondStop, aborted]);
    expect(signal.aborted).toBe(true);
    expect(controller.state.status).toBe('stopped');
    await controller.stop();
    expect(request).toHaveBeenCalledTimes(2);
    expect(observeTurn).not.toHaveBeenCalled();
    await controller.submit('next-session', 'two', callbacks());
    expect(controller.state.status).toBe(kind === 'answer' ? 'awaiting-input' : 'awaiting-approval');
  });
});

function structuredTerminal(data: Record<string, unknown>, pending?: 'question' | 'approval') {
  const events: Array<{eventType: string; data: unknown}> = [{eventType: 'delta', data: {text: 'partial reply'}}];
  if (pending === 'question') events.push({eventType: 'user_question_required', data: {turnId: 'turn', step: 1, questions: [{id: 'q', question: 'Confirm?'}]}});
  if (pending === 'approval') events.push({eventType: 'tool_approval_required', data: {approvalId: 'approval', toolName: 'write', argumentsHash: 'hash'}});
  events.push({eventType: 'done', data});
  const body = events.map((event, index) => `data: ${JSON.stringify({eventId: `event_${index + 1}`, turnId: 'turn', sequence: index + 1, ...event})}\n\n`).join('');
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({turnId: 'turn'})).mockResolvedValueOnce(new Response(body));
  vi.stubGlobal('fetch', fetch);
  return {controller: createConversationController(createFetchTransport('http://api.test')), fetch};
}

describe('structured terminal state through Fetch and the stream projector', () => {
  it.each(['question', 'approval'] as const)('lets durable Completed clear a stale %s', async pending => {
    const {controller} = structuredTerminal({status: 'Completed', isComplete: true}, pending);
    const cb = callbacks();
    await controller.submit('s', 'hello', cb);
    expect(controller.state).toMatchObject({status: 'completed', question: undefined, approval: undefined, retryAvailable: false});
    expect(cb.onDone).toHaveBeenCalledOnce();
  });

  it.each([
    {status: 'Interrupted', isComplete: false},
    {status: 'Interrupted', isComplete: false, reason: 'deadline_exceeded'},
    {status: 'Interrupted', isComplete: false, reason: 'max_steps'},
    {status: 'Failed', isComplete: false, reason: 'execution_recovered'},
    {status: 'Rejected'},
    {status: 'Completed', isComplete: false},
  ])('does not report %j as successful completion or offer observation retry', async data => {
    const {controller, fetch} = structuredTerminal(data);
    const cb = {...callbacks(), onError: vi.fn()};
    await expect(controller.submit('s', 'hello', cb)).rejects.toThrow('turn_incomplete');
    expect(controller.state).toMatchObject({status: 'failed', question: undefined, approval: undefined, retryAvailable: false});
    expect(cb.onDelta).toHaveBeenCalledExactlyOnceWith('partial reply');
    expect(cb.onDone).not.toHaveBeenCalled(); expect(cb.onError).toHaveBeenCalledOnce();
    await expect(controller.retry(callbacks())).rejects.toThrow('submission_not_retryable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    {pending: 'approval' as const, reason: undefined, status: 'awaiting-approval'},
    {pending: 'approval' as const, reason: 'pending_approval', status: 'awaiting-approval'},
    {pending: 'question' as const, reason: undefined, status: 'awaiting-input'},
  ])('retains $pending for an interrupted interaction with reason $reason', async ({pending, reason, status}) => {
    const {controller} = structuredTerminal({status: 'Interrupted', isComplete: false, ...(reason ? {reason} : {})}, pending);
    const cb = callbacks();
    await controller.submit('s', 'hello', cb);
    expect(controller.state.status).toBe(status);
    expect(controller.state[pending]).toBeDefined();
    expect(cb.onDone).toHaveBeenCalledOnce();
  });

  it.each(['turn_timeout', 'deletion_blocked', 'deadline_exceeded', 'token_or_call_budget_exceeded'])('clears an earlier pending question when %s ends execution', async reason => {
    const {controller} = structuredTerminal({status: 'Interrupted', isComplete: false, reason}, 'question');
    await expect(controller.submit('s', 'hello', callbacks())).rejects.toThrow(reason);
    expect(controller.state).toMatchObject({status: 'failed', question: undefined, approval: undefined, retryAvailable: false});
  });

  it('does not keep a stale approval when the interruption has an explicit failure reason', async () => {
    const {controller} = structuredTerminal({status: 'Interrupted', isComplete: false, reason: 'deletion_blocked'}, 'approval');
    await expect(controller.submit('s', 'hello', callbacks())).rejects.toThrow('deletion_blocked');
    expect(controller.state).toMatchObject({status: 'failed', question: undefined, approval: undefined});
  });

  it('exposes cancellation before the completion callback and clears pending input', async () => {
    const {controller} = structuredTerminal({status: 'Cancelled', isComplete: false}, 'question');
    const done = vi.fn(() => { expect(controller.state.status).toBe('stopped'); });
    await controller.submit('s', 'hello', {onDelta() {}, onDone: done});
    expect(controller.state).toMatchObject({status: 'stopped', question: undefined, approval: undefined, retryAvailable: false});
    expect(done).toHaveBeenCalledOnce();
  });

  it('waits for the structured done payload before delivering one successful completion', async () => {
    const {controller} = structuredTerminal({status: 'Completed', isComplete: true});
    const order: string[] = [];
    const done = vi.fn(() => { order.push('done'); expect(controller.state.status).toBe('completed'); });
    await controller.submit('s', 'hello', {onDelta() {}, onDone: done, async onEvent(event) { if (event.eventType === 'done') { await Promise.resolve(); order.push('terminal consumed'); } }});
    expect(order).toEqual(['terminal consumed', 'done']);
    expect(done).toHaveBeenCalledOnce();
    expect(controller.state.afterEventId).toBe('event_2');
  });

  it('keeps the terminal event unacknowledged if the surface completion callback fails', async () => {
    const {controller, fetch} = structuredTerminal({status: 'Completed', isComplete: true});
    await expect(controller.submit('s', 'hello', {onDelta() {}, onDone() { throw new Error('render failed'); }})).rejects.toThrow('render failed');
    expect(controller.state).toMatchObject({status: 'observer-error', afterEventId: 'event_1', retryAvailable: true});
    fetch.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({eventId: 'event_2', turnId: 'turn', sequence: 2, eventType: 'done', data: {status: 'Completed', isComplete: true}})}\n\n`));
    const done = vi.fn();
    await controller.retry({onDelta() {}, onDone: done});
    expect(done).toHaveBeenCalledOnce();
    expect(controller.state.status).toBe('completed');
    expect(fetch.mock.calls[2]![0]).toBe('http://api.test/v1/turns/turn/events?after=event_1');
  });

  it.each(['error', 'completed'] as const)('releases an in-flight silent answer when the live SSE stream is %s', async terminal => {
    const encoder = new TextEncoder();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({start(value) { body = value; }}));
    const stream = (eventType: string, data: unknown, sequence: number) => encoder.encode(`data: ${JSON.stringify({eventId: `event_${sequence}`, turnId: 'turn', sequence, eventType, data})}\n\n`);
    let observations = 0;
    const answerWrite = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/questions/answers')) return answerWrite();
      if (url.endsWith('/turns')) return Response.json({turnId: 'turn'});
      if (observations++ === 0) return response;
      return new Response(new TextDecoder().decode(stream('done', {status: 'Completed', isComplete: true}, 1)));
    }));
    const controller = createConversationController(createFetchTransport('http://api.test'));
    const execution = controller.submit('session', 'one', callbacks());
    const settled = terminal === 'error' ? expect(execution).rejects.toThrow('server failed') : expect(execution).resolves.toBeUndefined();
    body.enqueue(stream('user_question_required', {turnId: 'turn', step: 1, questions: [{id: 'q', question: 'Confirm?'}]}, 1));
    await vi.waitFor(() => expect(controller.state.question).toBeDefined());
    const answering = controller.answer([]);
    const aborted = expect(answering).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(answerWrite).toHaveBeenCalledOnce());
    body.enqueue(stream(terminal === 'error' ? 'error' : 'done', terminal === 'error' ? {message: 'server failed'} : {status: 'Completed', isComplete: true}, 2));
    body.close();
    await Promise.all([settled, aborted]);
    expect(controller.state).toMatchObject({status: terminal === 'error' ? 'failed' : 'completed', question: undefined, approval: undefined});
    await controller.submit('next-session', 'two', callbacks());
    expect(controller.state.status).toBe('completed');
  });
});
