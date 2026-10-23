import type { AskUserQuestionAnswerItem, ToolApprovalRequiredEventData, UserQuestionRequiredEventData } from '@aervox/contracts';
import type { AervoxTransport, ObserveTurnOptions, StreamTurnOptions, TurnCallbacks } from './transport.js';

export type ConversationStatus = 'idle' | 'submitting' | 'observing' | 'awaiting-input' | 'awaiting-approval' | 'completed' | 'stopped' | 'failed' | 'observer-error';
export interface ConversationState {
  status: ConversationStatus;
  turnId?: string;
  /** Last event whose consumer finished; observation recovery starts after it. */
  afterEventId?: string;
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
  /** Detach local observation and interaction state without cancelling the server Turn. */
  reset(): void;
  dispose(): void;
}
const submissionKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');

/** Owns request/interaction policy; the surface owns rendering and its layout. */
export function createConversationController(transport: AervoxTransport, lifetime?: AbortSignal): ConversationController {
  let state: Readonly<ConversationState> = Object.freeze({status: 'idle'});
  type Owner = {controller: AbortController; stopRequested: boolean; cancel?: Promise<void>};
  type InteractionOwner = {controller: AbortController; generation: number};
  let active: Owner | undefined;
  let stopOwner: Owner | undefined;
  let retryable: {sessionId: string; content: string; options: StreamTurnOptions} | undefined;
  let disposed = false;
  let generation = 0;
  let interaction: InteractionOwner | undefined;
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
  const detachInteraction = () => {
    const owner = interaction;
    interaction = undefined;
    owner?.controller.abort();
  };
  const beginInteraction = (): InteractionOwner => {
    if (interaction) throw new Error('conversation_busy');
    const owner = {controller: new AbortController(), generation};
    interaction = owner;
    return owner;
  };
  const interactionRequest = async <T>(owner: InteractionOwner, request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const signal = lifetime ? AbortSignal.any([owner.controller.signal, lifetime]) : owner.controller.signal;
    signal.throwIfAborted();
    // A detached IPC request may ignore cancellation. Stop waiting locally while
    // retaining rejection handlers on the underlying write, whose result is unknown.
    let onAbort!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, {once: true});
        if (signal.aborted) { onAbort(); return; }
        Promise.resolve().then(() => { signal.throwIfAborted(); return request(signal); }).then(resolve, reject);
      });
    } finally { signal.removeEventListener('abort', onAbort); }
  };
  const cancel = (owner: Owner): Promise<void> => {
    if (!state.turnId) return Promise.resolve();
    if (owner.cancel) return owner.cancel;
    const turnId = state.turnId;
    const expectedGeneration = generation;
    owner.cancel = transport.request('POST', `/v1/turns/${encodeURIComponent(turnId)}/cancel`, {}, {signal: lifetime})
      .then(() => {
        if (generation === expectedGeneration && state.turnId === turnId && (!active || active === owner)) {
          detachInteraction();
          update({status: 'stopped', question: undefined, approval: undefined, retryAvailable: false});
        }
        owner.controller.abort();
      }).catch(error => {
        owner.cancel = undefined;
        owner.stopRequested = false;
        if (generation === expectedGeneration && state.turnId === turnId && (!active || active === owner)) update({error});
        throw error;
      });
    return owner.cancel;
  };
  const execute = async (callbacks: TurnCallbacks, run: (callbacks: TurnCallbacks, signal: AbortSignal) => Promise<void>, signal?: AbortSignal) => {
    const owner: Owner = {controller: new AbortController(), stopRequested: false};
    const expectedGeneration = generation;
    active = owner;
    const combined = AbortSignal.any([owner.controller.signal, ...(lifetime ? [lifetime] : []), ...(signal ? [signal] : [])]);
    const current = () => !combined.aborted && generation === expectedGeneration;
    let terminalError = false;
    let doneRequested = false;
    let doneDelivered = false;
    const finishDone = (data?: unknown) => {
      if (!current() || terminalError || doneDelivered) return;
      doneDelivered = true;
      retryable = undefined;
      const detail = data && typeof data === 'object' ? data as {status?: unknown; isComplete?: unknown; reason?: unknown} : undefined;
      const status = detail?.status;
      const reason = detail?.reason;
      if (status === 'Cancelled') {
        detachInteraction();
        update({status: 'stopped', question: undefined, approval: undefined, retryAvailable: false});
      } else {
        const awaitingApproval = !!state.approval && (reason === undefined || reason === 'pending_approval');
        const awaitingQuestion = !!state.question && reason === undefined;
        const waiting = status === 'Interrupted' && (awaitingApproval || awaitingQuestion);
        const complete = (status === undefined || status === 'Completed') && detail?.isComplete !== false;
        if (!waiting && !complete) {
          const error = new Error(`turn_incomplete: ${String(status ?? 'incomplete')}${typeof reason === 'string' ? ` (${reason})` : ''}`);
          terminalError = true;
          detachInteraction();
          update({status: 'failed', error, question: undefined, approval: undefined, retryAvailable: false});
          callbacks.onError?.(error);
          throw error;
        }
        if (status === 'Completed') {
          detachInteraction();
          update({status: 'completed', question: undefined, approval: undefined, retryAvailable: false});
        } else update({status: state.approval ? 'awaiting-approval' : state.question ? 'awaiting-input' : 'completed', retryAvailable: false});
      }
      if (current()) callbacks.onDone();
    };
    try {
      await run({
        ...callbacks,
        onTurnIdentified(turnId) {
          if (!current()) return;
          update({turnId, retryAvailable: false});
          if (owner.stopRequested) void cancel(owner).catch(() => undefined);
          callbacks.onTurnIdentified?.(turnId);
        },
        onDelta(text) { if (current()) { update({status: 'observing'}); callbacks.onDelta(text); } },
        onReasoning(text) { if (current()) callbacks.onReasoning?.(text); },
        onEmote(command) { if (current()) callbacks.onEmote?.(command); },
        onPluginEvent(type, data) { if (current()) callbacks.onPluginEvent?.(type, data); },
        onHeartbeat() { if (current()) callbacks.onHeartbeat?.(); },
        onUserQuestion(question) { if (current()) { update({status: 'awaiting-input', question}); callbacks.onUserQuestion?.(question); } },
        onToolApproval(approval) { if (current()) { update({status: 'awaiting-approval', approval}); callbacks.onToolApproval?.(approval); } },
        onError(error) { if (current()) { terminalError = true; retryable = undefined; detachInteraction(); update({status: 'failed', error, question: undefined, approval: undefined, retryAvailable: false}); callbacks.onError?.(error); } },
        onDone() {
          if (!current() || terminalError) return;
          // The projector notifies before onEvent delivers the terminal payload.
          // Classify that payload before exposing a successful stream closure.
          doneRequested = true;
        },
        async onEvent(event) {
          if (!current()) return;
          await callbacks.onEvent?.(event);
          if (!current()) return;
          if (event.eventType === 'user_question_answered') update({question: undefined});
          if ((event.eventType === 'tool_approval_granted' || event.eventType === 'tool_approval_denied') &&
              event.data && typeof event.data === 'object' && (event.data as {approvalId?: string}).approvalId === state.approval?.approvalId) update({approval: undefined});
          if (event.eventType === 'done') finishDone(event.data);
          // A failed asynchronous or terminal consumer must see the event again.
          if (current() && event.eventId) update({afterEventId: event.eventId});
        },
      }, combined);
      // Older injected transports only call onDone and do not expose onEvent.
      if (doneRequested) finishDone();
    } catch (error) {
      if (current()) {
        update({status: !terminalError && state.turnId ? 'observer-error' : 'failed', error, retryAvailable: !terminalError && (state.turnId ? !!transport.observeTurn : !!retryable)});
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
      const expectedGeneration = ++generation;
      stopOwner = undefined;
      update({status: 'submitting', turnId: undefined, afterEventId: undefined, question: undefined, approval: undefined, error: undefined, retryAvailable: false});
      const idempotencyKey = options.idempotencyKey ?? submissionKey();
      retryable = {sessionId, content, options: {...options, signal: undefined, idempotencyKey}};
      await execute(callbacks, (forward, signal) => transport.streamTurn(sessionId, content, forward, {
        ...options, signal, idempotencyKey,
        async onAccepted(turnId) {
          if (signal.aborted || generation !== expectedGeneration) return;
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
      generation++;
      stopOwner = undefined;
      retryable = undefined;
      const sameTurn = state.turnId === turnId;
      update({turnId, afterEventId: options.afterEventId, status: 'observing',
        question: sameTurn ? state.question : undefined, approval: sameTurn ? state.approval : undefined,
        error: undefined, retryAvailable: false});
      await execute(callbacks, (forward, signal) => transport.observeTurn!(turnId, forward, {...options, signal}), options.signal);
    },
    async retry(callbacks) {
      available();
      if (state.status === 'observer-error' && state.turnId && transport.observeTurn) {
        await controller.observe(state.turnId, callbacks, {afterEventId: state.afterEventId});
        return;
      }
      if (!retryable) throw new Error('submission_not_retryable');
      const previous = retryable;
      await controller.submit(previous.sessionId, previous.content, callbacks, previous.options);
    },
    async stop() {
      if (disposed || state.status === 'stopped') return;
      const owner = active ?? stopOwner ?? {controller: new AbortController(), stopRequested: true};
      stopOwner = owner;
      owner.stopRequested = true;
      await cancel(owner);
    },
    async answer(answers) {
      if (disposed) throw new Error('conversation_disposed');
      lifetime?.throwIfAborted();
      if (!state.turnId || !state.question) throw new Error('question_not_pending');
      const {turnId, question} = state;
      const owner = beginInteraction();
      try {
        await interactionRequest(owner, signal => transport.submitQuestionAnswers(turnId, answers, signal));
        // A stop or a newer question may win while the write is in flight.
        if (generation === owner.generation && state.turnId === turnId && state.question === question) update({question: undefined,
          status: state.status === 'observer-error' ? 'observer-error' : 'observing', error: undefined});
      } catch (error) {
        if (interaction === owner && generation === owner.generation && state.turnId === turnId && state.question === question) update({error});
        throw error;
      } finally { if (interaction === owner) interaction = undefined; }
    },
    async decide(decision, callbacks) {
      available();
      if (!state.approval) throw new Error('approval_not_pending');
      const pending = state.approval;
      const {turnId, approvalId} = pending;
      const owner = beginInteraction();
      let result;
      try { result = await interactionRequest(owner, signal => transport.decideToolApproval(turnId, approvalId, decision, signal)); }
      catch (error) {
        if (interaction === owner && generation === owner.generation && state.turnId === turnId && state.approval === pending) update({error});
        throw error;
      }
      finally { if (interaction === owner) interaction = undefined; }
      if (disposed || generation !== owner.generation || state.approval !== pending || state.turnId !== turnId) return;
      update({approval: undefined, error: undefined});
      if (result?.continuation) await controller.observe(turnId, callbacks, {afterEventId: result.continuation.afterEventId});
      else update({status: 'completed'});
    },
    reset() {
      generation++;
      stopOwner = undefined;
      active?.controller.abort(); active = undefined; retryable = undefined;
      detachInteraction();
      update({status: 'idle', turnId: undefined, afterEventId: undefined, question: undefined, approval: undefined, error: undefined, retryAvailable: false});
    },
    dispose() { disposed = true; active?.controller.abort(); detachInteraction(); listeners.clear(); lifetime?.removeEventListener('abort', dispose); },
  };
  const dispose = () => controller.dispose();
  lifetime?.addEventListener('abort', dispose, {once: true});
  return controller;
}
