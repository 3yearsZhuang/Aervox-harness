import type { AskUserQuestionAnswerItem, ToolApprovalRequiredEventData, UserQuestionRequiredEventData } from '@aervox/contracts';
import type { AervoxTransport, ObserveTurnOptions, StreamTurnOptions, TurnCallbacks } from './transport.js';

export type ConversationStatus = 'idle' | 'submitting' | 'observing' | 'awaiting-input' | 'awaiting-approval' | 'completed' | 'stopped' | 'failed' | 'observer-error';
export interface ConversationState {
  status: ConversationStatus;
  turnId?: string;
  question?: UserQuestionRequiredEventData;
  approval?: ToolApprovalRequiredEventData & { turnId: string };
  error?: unknown;
  retryAvailable?: boolean;
}
export interface ConversationController {
  readonly state: Readonly<ConversationState>;
  subscribe(listener: (state: Readonly<ConversationState>) => void): () => void;
  submit(sessionId: string, content: string, callbacks: TurnCallbacks, options?: StreamTurnOptions): Promise<void>;
  observe(turnId: string, callbacks: TurnCallbacks, options?: ObserveTurnOptions): Promise<void>;
  retry(callbacks: TurnCallbacks): Promise<void>;
  stop(): Promise<void>;
  answer(answers: AskUserQuestionAnswerItem[]): Promise<void>;
  decide(decision: 'granted' | 'denied', callbacks: TurnCallbacks): Promise<void>;
  dispose(): void;
}
const submissionKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Owns request/interaction policy; the surface owns rendering and its layout. */
export function createConversationController(transport: AervoxTransport, lifetime?: AbortSignal): ConversationController {
  let state: Readonly<ConversationState> = Object.freeze({status: 'idle'});
  type Owner = {controller: AbortController; stopRequested: boolean; cancel?: Promise<void>};
  let active: Owner | undefined;
  let retryable: {sessionId: string; content: string; options: StreamTurnOptions} | undefined;
  let disposed = false;
  let interaction = false;
  const listeners = new Set<(state: Readonly<ConversationState>) => void>();
  const update = (patch: Partial<ConversationState>) => {
    if (disposed) return;
    state = Object.freeze({...state, ...patch});
    for (const listener of listeners) listener(state);
  };
  const available = () => {
    if (disposed) throw new Error('conversation_disposed');
    lifetime?.throwIfAborted();
    if (active || interaction) throw new Error('conversation_busy');
  };
  const cancel = (owner: Owner): Promise<void> => {
    if (!state.turnId) return Promise.resolve();
    if (owner.cancel) return owner.cancel;
    const turnId = state.turnId;
    owner.cancel = transport.request('POST', `/v1/turns/${encodeURIComponent(turnId)}/cancel`, {}, {signal: lifetime})
      .then(() => {
        if (state.turnId === turnId && (!active || active === owner)) update({status: 'stopped', question: undefined, approval: undefined});
        owner.controller.abort();
      }).catch(error => {
        owner.cancel = undefined;
        owner.stopRequested = false;
        if (state.turnId === turnId && (!active || active === owner)) update({error});
        throw error;
      });
    return owner.cancel;
  };
  const execute = async (callbacks: TurnCallbacks, run: (callbacks: TurnCallbacks, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) => {
    const owner: Owner = {controller: new AbortController(), stopRequested: false};
    active = owner;
    const combined = AbortSignal.any([owner.controller.signal, ...(lifetime ? [lifetime] : []), ...(signal ? [signal] : [])]);
    let terminalError = false;
    try {
      await run({
        ...callbacks,
        onTurnIdentified(turnId) {
          update({turnId, retryAvailable: false});
          if (owner.stopRequested) void cancel(owner).catch(() => undefined);
          callbacks.onTurnIdentified?.(turnId);
        },
        onDelta(text) { if (!combined.aborted) { update({status: 'observing'}); callbacks.onDelta(text); } },
        onUserQuestion(question) { update({status: 'awaiting-input', question}); callbacks.onUserQuestion?.(question); },
        onToolApproval(approval) { update({status: 'awaiting-approval', approval}); callbacks.onToolApproval?.(approval); },
        onError(error) { terminalError = true; retryable = undefined; update({status: 'failed', error, question: undefined, approval: undefined, retryAvailable: false}); callbacks.onError?.(error); },
        onDone() {
          retryable = undefined;
          update({status: state.approval ? 'awaiting-approval' : state.question ? 'awaiting-input' : 'completed', retryAvailable: false});
          callbacks.onDone();
        },
        async onEvent(event) {
          if (event.eventType === 'done' && event.data && typeof event.data === 'object' && (event.data as {status?: string}).status === 'Cancelled') update({status: 'stopped', question: undefined, approval: undefined, retryAvailable: false});
          await callbacks.onEvent?.(event);
        },
      }, combined);
    } catch (error) {
      if (!combined.aborted) {
        update({status: !terminalError && state.turnId ? 'observer-error' : 'failed', error, retryAvailable: !terminalError && !state.turnId && !!retryable});
        // An accepted submission is observed again, never resubmitted as a new Turn.
        if (terminalError || state.turnId) retryable = undefined;
        throw error;
      }
      if (!owner.stopRequested) throw error;
    } finally { if (active === owner) active = undefined; }
  };
  const controller: ConversationController = {
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    async submit(sessionId, content, callbacks, options = {}) {
      available();
      options.signal?.throwIfAborted();
      update({status: 'submitting', turnId: undefined, question: undefined, approval: undefined, error: undefined, retryAvailable: false});
      const idempotencyKey = options.idempotencyKey ?? submissionKey();
      retryable = {sessionId, content, options: {...options, signal: undefined, idempotencyKey}};
      await execute(callbacks, (forward, signal) => transport.streamTurn(sessionId, content, forward, {
        ...options, signal, idempotencyKey,
        async onAccepted(turnId) {
          update({turnId, status: 'observing', retryAvailable: false});
          if (active?.stopRequested) await cancel(active);
          await options.onAccepted?.(turnId);
        },
      }), options.signal);
    },
    async observe(turnId, callbacks, options = {}) {
      available();
      options.signal?.throwIfAborted();
      if (!transport.observeTurn) throw new Error('turn_observation_unavailable');
      retryable = undefined;
      update({turnId, status: 'observing', question: undefined, approval: undefined, error: undefined, retryAvailable: false});
      await execute(callbacks, (forward, signal) => transport.observeTurn!(turnId, forward, {...options, signal}), options.signal);
    },
    async retry(callbacks) {
      if (!retryable) throw new Error('submission_not_retryable');
      const previous = retryable;
      await controller.submit(previous.sessionId, previous.content, callbacks, previous.options);
    },
    async stop() {
      if (disposed) return;
      const owner = active ?? {controller: new AbortController(), stopRequested: true};
      owner.stopRequested = true;
      await cancel(owner);
    },
    async answer(answers) {
      if (disposed) throw new Error('conversation_disposed');
      lifetime?.throwIfAborted();
      if (interaction) throw new Error('conversation_busy');
      if (!state.turnId || !state.question) throw new Error('question_not_pending');
      const {turnId, question} = state;
      interaction = true;
      try {
        await transport.submitQuestionAnswers(turnId, answers, lifetime);
        // A stop or a newer question may win while the write is in flight.
        if (state.turnId === turnId && state.question === question) update({question: undefined, status: 'observing', error: undefined});
      } finally { interaction = false; }
    },
    async decide(decision, callbacks) {
      available();
      if (!state.approval) throw new Error('approval_not_pending');
      const pending = state.approval;
      const {turnId, approvalId} = pending;
      interaction = true;
      let result;
      try { result = await transport.decideToolApproval(turnId, approvalId, decision, lifetime); }
      finally { interaction = false; }
      if (disposed || state.approval !== pending || state.turnId !== turnId) return;
      update({approval: undefined, error: undefined});
      if (result?.continuation) await controller.observe(turnId, callbacks, {afterEventId: result.continuation.afterEventId});
      else update({status: 'completed'});
    },
    dispose() { disposed = true; active?.controller.abort(); listeners.clear(); lifetime?.removeEventListener('abort', dispose); },
  };
  const dispose = () => controller.dispose();
  lifetime?.addEventListener('abort', dispose, {once: true});
  return controller;
}
