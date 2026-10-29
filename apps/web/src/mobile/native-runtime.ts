/** Android M0 composition root: shared Core/commands, one native SQLite writer.
 * No local HTTP server, browser database, alternate ledger or privileged shell.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConversationRepository } from '@aervox/repositories/conversation';
import { createInjectedDatabase } from '@aervox/repositories/database';
import { NativeSqliteClient } from '@aervox/repositories/native-sqlite-client';
import { ConversationExecutionStore } from '@aervox/host-agent/browser';
import { ControlContext, executeTurn } from '@aervox/core/browser';
import { AervoxHttpError, TurnStreamProjector, type AervoxTransport, type TurnCallbacks, type ObserveTurnOptions } from '@aervox/api-client';
import { createSessionRequestSchema, renameSessionRequestSchema, type TurnStreamEvent } from '@aervox/contracts';
import { nativeRequest } from './native-channel';
import { delay, createNativeModelProvider } from './native-model-provider';
import { nativeContextBuilder } from './native-context';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const encoder = new TextEncoder();
const fail = (status: number, code: string): never => { throw new AervoxHttpError(status, 'native', { code, message: code }); };
const identifier = (value: string) => { if (!value || value.length > 128 || value.includes('\0')) fail(400, 'INVALID_IDENTIFIER'); return value; };
export async function initializeNativeRuntime(): Promise<AervoxTransport> {
  const ready = await nativeRequest({ op: 'runtime' });
  if (ready?.kind !== 'runtime' || ready.sqlite !== 'ready' || ready.mode !== 'foreground'
    || typeof ready.connectionEpoch !== 'string' || !ready.connectionEpoch) throw new Error('NATIVE_DATABASE_UNAVAILABLE');
  const client = new NativeSqliteClient({
    request: request => nativeRequest({ op: 'sqlite', ...request }),
    dispose: connectionEpoch => nativeRequest({ op: 'dispose', connectionEpoch }),
  }, { connectionEpoch: ready.connectionEpoch });
  const repo = new ConversationRepository(createInjectedDatabase(client), {
    randomUUID: () => crypto.randomUUID(),
    sha256Utf8: value => bytesToHex(sha256(new TextEncoder().encode(value))),
    wakeOutbox: () => false,
  });
  const store = new ConversationExecutionStore(repo, ctx);
  const nativeModelProvider = createNativeModelProvider(nativeRequest, async request => {
    await store.requestCancelAttempt({ turnId: request.turnId, attemptId: request.attemptId });
  });
  let active: { turnId: string; attemptId: string; sessionId: string; control: ControlContext; done: Promise<unknown> } | undefined;
  let accepting = false;
  let retired = false;
  const recovery = () => repo.recoverExpiredAttempts(client, { dispatchTarget: 'default', unclaimedTimeoutMs: 0 });
  await recovery();
  // Expired executions are retired by the repository; never replay model work.
  // A recent lease stays visible until expiry instead of stealing its identity.
  const recoveryTimer = setInterval(() => { if (!active && !accepting) void recovery().catch(() => undefined); }, 5000);
  window.addEventListener('pagehide', () => { retired = true; clearInterval(recoveryTimer); active?.control.abort(); client.close(); }, { once: true });
  const cancelActive = async () => {
    const owner = active;
    if (!owner) return;
    await store.requestCancelAttempt({ turnId: owner.turnId, attemptId: owner.attemptId });
    owner.control.abort();
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) void cancelActive().catch(() => undefined); });

  const observe = async (turnId: string, callbacks: TurnCallbacks, options: ObserveTurnOptions = {}) => {
    const checkOpen = () => {
      if (retired) fail(503, 'HOST_CLOSED');
      options.signal?.throwIfAborted();
    };
    checkOpen();
    const disclosable = await repo.isTurnStreamDisclosable(ctx, turnId);
    checkOpen();
    if (!disclosable) fail(404, 'TURN_NOT_FOUND');
    let sequence = 0;
    if (options.afterEventId) {
      const cursor = await repo.getStreamEventById(ctx, turnId, options.afterEventId);
      checkOpen();
      if (!cursor) return fail(410, 'STREAM_CURSOR_EXPIRED');
      if (cursor.eventType === 'done') return;
      sequence = cursor.sequence;
    }
    const projector = new TurnStreamProjector({ expectedTurnId: turnId, initialSequence: sequence });
    for (;;) {
      checkOpen();
      const page = await repo.getStreamEventsPage(ctx, turnId, {
        afterSequence: projector.currentSequence, throughSequence: Number.MAX_SAFE_INTEGER, limit: 128,
      });
      checkOpen();
      for (const event of page.events) {
        checkOpen();
        // A prior consumer callback can wait across deletion or host retirement.
        // Only the shared atomic visibility/payload read authorizes this frame;
        // a previously fetched replay page never supplies disclosed content.
        const current = await repo.getStreamEventForDisclosure(ctx, turnId, event.id);
        checkOpen();
        if (!current) return fail(410, 'STREAM_SOURCE_UNAVAILABLE');
        if (current.sequence !== event.sequence) fail(409, 'STREAM_REPLAY_SEQUENCE_CHANGED');
        const wire = { ...current, eventId: current.id, attemptId: current.attemptId || null } as TurnStreamEvent;
        if (projector.project(wire, callbacks)) await callbacks.onEvent?.(wire);
      }
      if (projector.finalized) { if (projector.failure) throw projector.failure; return; }
      const current = await repo.isTurnStreamDisclosable(ctx, turnId);
      checkOpen();
      if (!current) fail(410, 'STREAM_SOURCE_UNAVAILABLE');
      callbacks.onHeartbeat?.();
      await delay(100, options.signal);
    }
  };
  return {
    async request<T>(method: string, path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
      options?.signal?.throwIfAborted();
      const url = new URL(path, 'https://localhost');
      if (!path.startsWith('/v1/') || url.origin !== 'https://localhost') fail(400, 'INVALID_NATIVE_PATH');
      let result: unknown;
      if (url.pathname === '/v1/sessions' && method === 'GET') {
        if (url.search && !url.searchParams.has('projectId')) fail(400, 'INVALID_QUERY');
        result = { items: await repo.listSessions(ctx, { limit: 100, ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId')! } : {}) }) };
      } else if (url.pathname === '/v1/sessions' && method === 'POST') {
        const parsed = createSessionRequestSchema.safeParse(body);
        if (!parsed.success) return fail(400, 'INVALID_SESSION');
        if (parsed.data.projectId) return fail(400, 'INVALID_SESSION');
        result = await repo.createSession(ctx, parsed.data.title ?? '新对话', { id: parsed.data.id });
      } else {
        const session = /^\/v1\/sessions\/([^/]+)(\/history)?$/.exec(url.pathname);
        const cancel = /^\/v1\/turns\/([^/]+)\/cancel$/.exec(url.pathname);
        if (session) {
          const id = identifier(decodeURIComponent(session[1]!));
          if (session[2] && method === 'GET') result = await repo.getSessionHistoryPage(ctx, { sessionId: id,
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
          });
          else if (!session[2] && method === 'PATCH') {
            const parsed = renameSessionRequestSchema.safeParse(body);
            if (!parsed.success) return fail(400, 'INVALID_SESSION');
            if (parsed.data.projectId || parsed.data.isPinned !== undefined) return fail(400, 'INVALID_SESSION');
            result = await repo.renameSession(ctx, id, { title: parsed.data.title });
            if (!result) fail(404, 'SESSION_NOT_FOUND');
          } else if (!session[2] && method === 'DELETE') {
            if (accepting || active?.sessionId === id) fail(409, 'STOP_REPLY_BEFORE_DELETING');
            if (!await repo.deleteSession(ctx, id)) fail(404, 'SESSION_NOT_FOUND');
          } else fail(501, 'FEATURE_NOT_CONNECTED');
        } else if (cancel && method === 'POST') {
          const turnId = identifier(decodeURIComponent(cancel[1]!));
          if (active?.turnId === turnId) await cancelActive();
          else {
            const attempts = await repo.listTurnAttempts(ctx, turnId);
            const latest = attempts.at(-1);
            if (latest) await store.requestCancelAttempt({ turnId, attemptId: latest.id });
            else if (!await repo.getTurn(ctx, turnId)) fail(404, 'TURN_NOT_FOUND');
          }
          result = { ok: true };
        } else fail(501, 'FEATURE_NOT_CONNECTED');
      }
      return result as T;
    },
    async streamTurn(sessionId, content, callbacks, options = {}) {
      options.signal?.throwIfAborted();
      identifier(sessionId);
      // Admission's Outbox payload contains two JSON copies of the input.
      // Reserve 16 KiB in its 256 KiB native bind for the remaining envelope.
      if (!content.trim() || /[\uD800-\uDFFF]/u.test(content) || encoder.encode(content).byteLength > 32_768
        || encoder.encode(JSON.stringify(content)).byteLength - 2 > 120 * 1024
        || options.attachments?.length) fail(400, 'INVALID_MOBILE_MESSAGE');
      if (active || accepting) fail(409, 'REPLY_IN_PROGRESS');
      accepting = true;
      let turnId: string;
      try {
        const model = await nativeRequest({ op: 'model', operation: 'summary' });
        if (model?.kind !== 'summary' || typeof model.hasCredential !== 'boolean') fail(503, 'MODEL_STATE_UNAVAILABLE');
        // This check runs before acceptance: missing configuration is a definite
        // refusal, unlike a 409 whose earlier acceptance may still be unknown.
        if (!model.hasCredential) fail(422, 'MODEL_NOT_CONFIGURED');
        const accepted = await repo.acceptTurn(ctx, { sessionId, turnId: `turn_${crypto.randomUUID()}`, attemptId: `attempt_${crypto.randomUUID()}`,
          idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(), message: { id: `msg_${crypto.randomUUID()}`, content, contentType: 'text' },
          consumeInbox: false, toolApprovalMode: 'ask', metadata: options.metadata,
        });
        turnId = accepted.turn.id;
        if (accepted.created) {
          const control = new ControlContext({ turnId, sessionId, attemptId: accepted.attempt.id, deadlineEpochMs: Date.now() + 180_000 });
          const owner = { turnId, sessionId, attemptId: accepted.attempt.id, control, done: Promise.resolve() as Promise<unknown> };
          active = owner;
          owner.done = executeTurn({ execution: store, provider: nativeModelProvider, controlContext: control,
            contextBuilder: { async build(input) {
              const history = await repo.getSessionHistory(ctx, { sessionId, beforeTurnId: turnId });
              return nativeContextBuilder.build({ ...input, messages: [
                { role: 'system', content: '你是思隅 Aervox，一位主动智能的个人助手。请如实回答；本次手机会话只能交流文本，没有设备操作工具。' },
                ...history, ...input.messages,
              ] });
            } }, options: { maxSteps: 1, maxModelRetries: 0, maxTurnDurationMs: 180_000, leaseTtlMs: 30_000, leaseHeartbeatIntervalMs: 10_000 },
          }, { turnId, sessionId, attemptId: accepted.attempt.id, userMessage: content }).finally(() => {
            control.dispose(); if (active === owner) active = undefined;
          });
          void owner.done.catch(() => undefined);
        }
      } finally { accepting = false; }
      await options.onAccepted?.(turnId!);
      await observe(turnId!, callbacks, { signal: options.signal });
    },
    observeTurn: observe,
    async submitQuestionAnswers() { fail(501, 'QUESTION_TOOLS_NOT_CONNECTED'); },
    async decideToolApproval() { fail(501, 'DEVICE_TOOLS_NOT_CONNECTED'); },
  };
}
