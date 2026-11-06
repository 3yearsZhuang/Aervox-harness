/** Android M0 composition root: shared Core/commands, one native SQLite writer.
 * No local HTTP server, browser database, alternate ledger or privileged shell.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ConversationRepository } from '@aervox/repositories/conversation';
import { LearningRepository } from '@aervox/repositories/learning';
import { SqlitePersonaRepository } from '@aervox/repositories/persona';
import { SqliteDiaryRepository, createSqliteDiaryMaterialPort } from '@aervox/repositories/diary';
import { createInjectedDatabase } from '@aervox/repositories/database';
import { NativeSqliteClient } from '@aervox/repositories/native-sqlite-client';
import { isBackupScopedTable } from '@aervox/repositories/backup';
import { ConversationExecutionStore } from '@aervox/host-agent/browser';
import { buildResumeHistory, ControlContext, ASK_USER_QUESTION_SPEC, ASK_USER_QUESTION_TOOL, createAskUserQuestionToolProvider, executeTurn, stableSerialize, type ToolProviderPort, type ToolSpec } from '@aervox/core/browser';
import { AervoxHttpError, TurnStreamProjector, type AervoxTransport, type QuestionAnswerIdentity, type TurnCallbacks, type ObserveTurnOptions } from '@aervox/api-client';
import { createSessionRequestSchema, listSessionsResponseSchema, renameSessionRequestSchema, sessionItemSchema, sessionListQuerySchema, type AskUserQuestionAnswerItem, type TurnStreamEvent } from '@aervox/contracts';
import { nativeRequest } from './native-channel';
import { delay, createNativeModelProvider } from './native-model-provider';
import { nativeContextBuilder } from './native-context';
import { createDeviceTooling, DEVICE_TOOL_NAMES } from './native-tools';
import { createQuestionBridge } from './native-question';
import { buildBackupFile, normalizeBackupValue, MAX_BACKUP_BYTES, type BackupTable } from './native-backup';
import { createLearningRouteHandler } from './native-learning';
import { activePersonaPrompt, createPersonaRouteHandler } from './native-persona';
import { createDiaryRouteHandler } from './native-diary';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const encoder = new TextEncoder();
const fail = (status: number, code: string): never => { throw new AervoxHttpError(status, 'native', { code, message: code }); };
const identifier = (value: string) => { if (!value || value.length > 128 || value.includes('\0')) fail(400, 'INVALID_IDENTIFIER'); return value; };
export async function initializeNativeRuntime(): Promise<AervoxTransport> {
  let active: { turnId: string; attemptId: string; sessionId: string; control: ControlContext; done: Promise<unknown> } | undefined;
  let nativeClient: NativeSqliteClient | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let accepting = false;
  let retired = false;
  // The bridge owns the suspended ask_user_question promise for this host.
  let questionBridge: ReturnType<typeof createQuestionBridge> | undefined;
  let foregroundRevision = 0;
  let cancelActive = async () => {};
  const checkOpen = () => { if (retired) fail(503, 'HOST_CLOSED'); };
  const withDatabase = async <T>(operation: () => Promise<T>): Promise<T> => {
    checkOpen();
    return operation();
  };
  const visibilityChanged = () => {
    if (document.hidden) { foregroundRevision++; void cancelActive().catch(() => undefined); }
  };
  const retire = () => {
    retired = true;
    clearInterval(recoveryTimer);
    window.removeEventListener('pagehide', retire);
    document.removeEventListener('visibilitychange', visibilityChanged);
    active?.control.abort();
    void questionBridge?.cancel('QUESTION_CANCELLED').finally(() => nativeClient?.close());
    if (!questionBridge) nativeClient?.close();
  };
  // Capture retirement before the first native receipt, including bootstrap.
  window.addEventListener('pagehide', retire, { once: true });
  document.addEventListener('visibilitychange', visibilityChanged);
  const ready = await nativeRequest({ op: 'runtime' }).catch(error => { retire(); throw error; });
  checkOpen();
  if (ready?.kind !== 'runtime' || ready.sqlite !== 'ready' || ready.mode !== 'foreground'
    || typeof ready.connectionEpoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ready.connectionEpoch)) {
    retire(); throw new Error('NATIVE_DATABASE_UNAVAILABLE');
  }
  const client = nativeClient = new NativeSqliteClient({
    request: request => nativeRequest({ op: 'sqlite', ...request }),
    dispose: connectionEpoch => nativeRequest({ op: 'dispose', connectionEpoch }),
  }, { connectionEpoch: ready.connectionEpoch });
  const db = createInjectedDatabase(client);
  // One trusted host primitive set feeds every repository in this composition.
  const hostCrypto = {
    randomUUID: () => crypto.randomUUID(),
    sha256Utf8: (value: string) => bytesToHex(sha256(new TextEncoder().encode(value))),
    wakeOutbox: () => false,
  };
  const repo = new ConversationRepository(db, hostCrypto);
  const learningRepo = new LearningRepository(db, hostCrypto);
  // Plan generation is one structured completion over the same native model
  // bridge; the shared pipeline retries once with gaps like every host does.
  const generateText = async (system: string, user: string): Promise<string> => {
    const turnId = `plan_${crypto.randomUUID()}`;
    let raw = '';
    for await (const chunk of nativeModelProvider.stream({
      turnId, attemptId: `attempt_${crypto.randomUUID()}`, step: 1,
      context: { turnId, sessionId: `plan_session_${turnId}`, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    })) {
      if (chunk.text) raw += chunk.text;
      if (chunk.isFinal) {
        if (chunk.stopReason !== 'stop') throw new Error('MODEL_COMPLETION_INCOMPLETE');
        return raw;
      }
    }
    throw new Error('MODEL_COMPLETION_INCOMPLETE');
  };
  const handleLearningRoute = createLearningRouteHandler({
    repo: learningRepo, ctx,
    digestRequest: value => hostCrypto.sha256Utf8(stableSerialize(value)),
    generateText,
  });
  // 人格与日记都落在同一份本机业务真源上：人格的修订校验和与桌面端同算法，
  // 日记的提示词/模板来自 @aervox/diary，未配置模型时降级为模板并如实标注。
  const personaRepo = new SqlitePersonaRepository(db);
  const handlePersonaRoute = createPersonaRouteHandler({
    repo: personaRepo,
    ctx,
    checksum: config => hostCrypto.sha256Utf8(JSON.stringify(config)),
  });
  const createConversationContext = (sessionId: string, turnId: string) => {
    let prompt: Promise<string> | undefined;
    return { async build(input: Parameters<typeof nativeContextBuilder.build>[0]) {
      prompt ??= activePersonaPrompt(personaRepo, ctx);
      const [persona, history] = await Promise.all([
        prompt, repo.getSessionHistory(ctx, { sessionId, beforeTurnId: turnId }),
      ]);
      return nativeContextBuilder.build({ ...input, messages: [
        { role: 'system', content: [
          '你是思隅 Aervox，一位主动智能的个人助手。请如实回答。缺少信息或需要确认时，用 ask_user_question 向用户提问，不要猜测后直接执行。手机上只有用户已在设置中授权的设备工具可用；没有对应工具时，说明这项操作在当前版本不可用，不要编造已执行。',
          persona,
        ].filter(Boolean).join('\n\n') },
        ...history, ...input.messages,
      ] });
    } };
  };
  const diaryRepo = new SqliteDiaryRepository(db);
  const handleDiaryRoute = createDiaryRouteHandler({
    repo: diaryRepo,
    materials: createSqliteDiaryMaterialPort(db, hostCrypto),
    ctx,
    model: {
      generate: async ({ system, user }) => {
        const summary = await nativeRequest({ op: 'model', operation: 'summary' }).catch(() => null);
        if (summary?.hasCredential !== true) throw new Error('llm_disabled: 未配置模型，改由模板生成');
        return generateText(system, user);
      },
    },
  });
  const store = new ConversationExecutionStore(repo, ctx);
  const questions = createQuestionBridge({ ctx,
    owner: request => store.getQuestionExecutionOwner(request.turnId, request.attemptId),
    commands: {
      require: (owner, input) => repo.requireUserQuestion(owner, input),
      getPending: (owner, turnId) => repo.getPendingUserQuestion(owner, turnId),
      getReceipt: (owner, identity) => repo.getUserQuestionAnswerReceipt(owner, identity),
      answer: (owner, identity, answers) => repo.answerUserQuestion(owner, identity, answers),
      cancel: (owner, input) => repo.cancelUserQuestion(owner, input),
    },
  });
  questionBridge = questions;
  // Per-call approvals land in the shared ledger: an identical action reuses a
  // prior grant, a new one ends the turn as Interrupted(pending_approval) and
  // waits for decideToolApproval before any side effect runs.
  const requestApproval = async (input: { turnId: string; attemptId: string; toolName: string; argumentsHash: string }) => {
    const granted = await repo.findGrantedToolApproval(ctx,
      { toolName: input.toolName, argumentsHash: input.argumentsHash });
    if (granted) return { action: 'allow' as const, reason: 'device_action_previously_approved' };
    const approval = await repo.recordToolApproval(ctx, {
      turnId: input.turnId, attemptId: input.attemptId, toolName: input.toolName,
      argumentsHash: input.argumentsHash, requester: 'local', state: 'pending',
    });
    return { action: 'ask_user' as const, approvalId: approval.id, argumentsHash: input.argumentsHash };
  };
  // Device tools stay unavailable until the user grants a capability in
  // settings; the provider re-reads that native grant on every listing and the
  // approval policy re-checks it before any side effect.
  const deviceTooling = createDeviceTooling({ requestApproval });
  // One tool surface for the turn: the question tool is always available (it
  // needs no privilege), device verbs only when the phone grant allows them.
  const questionTool = createAskUserQuestionToolProvider({ userQuestionPort: questions.port, defaultTimeoutMs: 120_000 });
  // A human answer is not a 12-second tool call: the spec carries its own budget.
  const questionSpec: ToolSpec = { ...ASK_USER_QUESTION_SPEC, budget: { timeoutMs: 120_000 } };
  const tools: ToolProviderPort = {
    tools: [],
    async listTools() {
      const device = await deviceTooling.provider.listTools?.() ?? [];
      return [...device, questionSpec];
    },
    execute(input) {
      return input.name === ASK_USER_QUESTION_TOOL
        ? questionTool.execute(input)
        : deviceTooling.provider.execute(input);
    },
  };
  const nativeModelProvider = createNativeModelProvider(nativeRequest, async request => {
    await store.requestCancelAttempt({ turnId: request.turnId, attemptId: request.attemptId });
  });
  const recovery = () => withDatabase(() => repo.recoverExpiredAttempts(client, { dispatchTarget: 'default', unclaimedTimeoutMs: 0 }));
  await recovery().catch(error => { retire(); throw error; });
  checkOpen();
  // Expired executions are retired by the repository; never replay model work.
  // A recent lease stays visible until expiry instead of stealing its identity.
  recoveryTimer = setInterval(() => { if (!active && !accepting) void recovery().catch(() => undefined); }, 5000);
  cancelActive = async () => {
    const owner = active;
    if (!owner) return;
    // Release a suspended question first: stopping must not leave the loop waiting.
    await questions.cancel('QUESTION_CANCELLED');
    await store.requestCancelAttempt({ turnId: owner.turnId, attemptId: owner.attemptId });
    owner.control.abort();
  };

  const observeUnlocked = async (turnId: string, callbacks: TurnCallbacks, options: ObserveTurnOptions = {}) => {
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
    // A cursor can follow the required event while its question is still pending.
    // Query the original durable question when observation reconnects.
    const stopQuestions = questions.observe(turnId, question => {
      if (!retired) callbacks.onUserQuestion?.(question);
    });
    try {
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
    } finally { stopQuestions(); }
  };
  const observe = (turnId: string, callbacks: TurnCallbacks, options: ObserveTurnOptions = {}) =>
    withDatabase(() => observeUnlocked(turnId, callbacks, options));
  return {
    async request<T>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
      return withDatabase(async () => {
      checkOpen();
      options?.signal?.throwIfAborted();
      const url = new URL(path, 'https://localhost');
      if (!path.startsWith('/v1/') || url.origin !== 'https://localhost') fail(400, 'INVALID_NATIVE_PATH');
      let result: unknown;
      if (url.pathname === '/v1/models/summary' && method === 'GET') {
        const summary = await nativeRequest({ op: 'model', operation: 'summary' });
        result = { configured: summary?.hasCredential === true };
      } else if (url.pathname === '/v1/sessions' && method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        // Repeated parameters become arrays at the HTTP boundary. Reject them
        // here too, before Object.fromEntries could conceal an invalid query.
        if ([...url.searchParams].length !== Object.keys(query).length) fail(400, 'INVALID_SESSION_QUERY');
        const parsed = sessionListQuerySchema.safeParse(query);
        if (!parsed.success) return fail(400, 'INVALID_SESSION_QUERY');
        const response = listSessionsResponseSchema.safeParse({ items: await repo.listSessions(ctx, {
          limit: Number(parsed.data.limit ?? '100'), offset: Number(parsed.data.offset ?? '0'),
          ...(parsed.data.projectId === undefined ? {} : { projectId: parsed.data.projectId }),
        }) });
        if (!response.success) return fail(500, 'INTERNAL_ERROR');
        result = response.data;
      } else if (url.pathname === '/v1/sessions' && method === 'POST') {
        const parsed = createSessionRequestSchema.safeParse(body);
        if (!parsed.success) return fail(400, 'INVALID_SESSION');
        if (parsed.data.projectId) return fail(400, 'INVALID_SESSION');
        result = await repo.createSession(ctx, parsed.data.title ?? '新对话', { id: parsed.data.id });
      } else {
        const session = /^\/v1\/sessions\/([^/]+)(\/history)?$/.exec(url.pathname);
        const cancel = /^\/v1\/turns\/([^/]+)\/cancel$/.exec(url.pathname);
        const pendingQuestion = /^\/v1\/turns\/([^/]+)\/questions\/pending$/.exec(url.pathname);
        if (session) {
          const id = identifier(decodeURIComponent(session[1]!));
          if (session[2] && method === 'GET') result = await repo.getSessionHistoryPage(ctx, { sessionId: id,
            ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
            ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
          });
          else if (!session[2] && method === 'GET') {
            if (url.search) fail(400, 'INVALID_SESSION_QUERY');
            const item = await repo.getSession(ctx, id);
            if (!item) return fail(404, 'SESSION_NOT_FOUND');
            const parsed = sessionItemSchema.safeParse(item);
            if (!parsed.success) return fail(500, 'INTERNAL_ERROR');
            result = parsed.data;
          } else if (!session[2] && method === 'PATCH') {
            const parsed = renameSessionRequestSchema.safeParse(body);
            if (!parsed.success) return fail(400, 'INVALID_SESSION');
            if (parsed.data.projectId || parsed.data.isPinned !== undefined) return fail(400, 'INVALID_SESSION');
            result = await repo.renameSession(ctx, id, { title: parsed.data.title });
            if (!result) fail(404, 'SESSION_NOT_FOUND');
          } else if (!session[2] && method === 'DELETE') {
            if (accepting || active?.sessionId === id) fail(409, 'STOP_REPLY_BEFORE_DELETING');
            if (!await repo.deleteSession(ctx, id)) fail(404, 'SESSION_NOT_FOUND');
          } else fail(501, 'FEATURE_NOT_CONNECTED');
        } else if (pendingQuestion && method === 'GET') {
          const turnId = identifier(decodeURIComponent(pendingQuestion[1]!));
          const pending = await repo.getPendingUserQuestion(ctx, turnId);
          result = pending ? { ...pending, pending: true } : { turnId, pending: false, questions: [] };
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
        } else {
          const learning = await handleLearningRoute(method, url, body, { headers: options?.headers });
          if (learning.handled) {
            result = learning.result;
          } else {
            const persona = await handlePersonaRoute(method, url, body);
            if (persona.handled) {
              result = persona.result;
            } else {
              const diary = await handleDiaryRoute(method, url, body);
              if (diary.handled) result = diary.result;
              else fail(501, 'FEATURE_NOT_CONNECTED');
            }
          }
        }
      }
      checkOpen();
      return result as T;
      });
    },
    async streamTurn(sessionId, content, callbacks, options = {}) {
      checkOpen();
      options.signal?.throwIfAborted();
      if (document.hidden) fail(422, 'HOST_NOT_FOREGROUND');
      const admissionRevision = foregroundRevision;
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
        checkOpen();
        // A background/foreground round trip cannot revive a pending send.
        if (document.hidden || admissionRevision !== foregroundRevision) fail(422, 'HOST_NOT_FOREGROUND');
        if (model?.kind !== 'summary' || typeof model.hasCredential !== 'boolean') fail(503, 'MODEL_STATE_UNAVAILABLE');
        // This check runs before acceptance: missing configuration is a definite
        // refusal, unlike a 409 whose earlier acceptance may still be unknown.
        if (!model.hasCredential) fail(422, 'MODEL_NOT_CONFIGURED');
        const accepted = await repo.acceptTurn(ctx, { sessionId, turnId: `turn_${crypto.randomUUID()}`, attemptId: `attempt_${crypto.randomUUID()}`,
          idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(), message: { id: `msg_${crypto.randomUUID()}`, content, contentType: 'text' },
          consumeInbox: false, toolApprovalMode: 'ask', metadata: options.metadata,
        });
        checkOpen();
        turnId = accepted.turn.id;
        if (accepted.created && (document.hidden || admissionRevision !== foregroundRevision)) {
          // The commit is authoritative even if its receipt crossed onStop.
          // Retire this unclaimed Attempt through the shared cancellation
          // transaction; never start model work to manufacture a terminal.
          await store.requestCancelAttempt({ turnId, attemptId: accepted.attempt.id });
        } else if (accepted.created) {
          const control = new ControlContext({ turnId, sessionId, attemptId: accepted.attempt.id, deadlineEpochMs: Date.now() + 300_000 });
          const owner = { turnId, sessionId, attemptId: accepted.attempt.id, control, done: Promise.resolve() as Promise<unknown> };
          active = owner;
          owner.done = executeTurn({ execution: store, provider: nativeModelProvider, controlContext: control,
            tools, approvalPolicy: deviceTooling.approval,
            contextBuilder: createConversationContext(sessionId, turnId), options: { maxSteps: 6, maxConsecutiveSameTool: 3, toolTimeoutMs: 12_000, maxModelRetries: 0,
              maxTurnDurationMs: 300_000, leaseTtlMs: 30_000, leaseHeartbeatIntervalMs: 10_000 },
          }, { turnId, sessionId, attemptId: accepted.attempt.id, userMessage: content }).finally(() => {
            store.releaseQuestionExecutionOwner(turnId, accepted.attempt.id);
            control.dispose(); if (active === owner) active = undefined;
          });
          void owner.done.catch(() => undefined);
        }
      } finally { accepting = false; }
      checkOpen();
      await options.onAccepted?.(turnId!);
      await observe(turnId!, callbacks, { signal: options.signal });
    },
    observeTurn: observe,
    async submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[], signal?: AbortSignal, identity?: QuestionAnswerIdentity) {
      checkOpen();
      signal?.throwIfAborted();
      identifier(turnId);
      try {
        await questions.submit(turnId, answers, identity);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'QUESTION_NOT_PENDING';
        // Only the answer body is the caller's fault; everything else is state.
        fail(code === 'QUESTION_ANSWERS_REQUIRED' ? 400 : 409, code);
      }
    },
    async decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied', signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      if (document.hidden) fail(422, 'HOST_NOT_FOREGROUND');
      if (active || accepting) fail(409, 'REPLY_IN_PROGRESS');
      const admissionRevision = foregroundRevision;
      accepting = true;
      try {
      identifier(turnId);
      identifier(approvalId);
      if (decision !== 'granted' && decision !== 'denied') return fail(400, 'INVALID_APPROVAL_DECISION');
      const approval = await repo.getToolApproval(ctx, approvalId);
      if (!approval || approval.turnId !== turnId) return fail(404, 'APPROVAL_NOT_FOUND');
      if (approval.state !== 'pending' && approval.state !== decision) return fail(409, 'APPROVAL_ALREADY_DECIDED');
      // First-party device tools only: no plugin tool bindings exist here.
      if (decision === 'granted' && approval.state === 'pending'
        && approval.toolName !== ASK_USER_QUESTION_TOOL && !DEVICE_TOOL_NAMES().has(approval.toolName)) {
        return fail(409, 'APPROVAL_BINDING_UNAVAILABLE');
      }
      checkOpen();
      signal?.throwIfAborted();
      if (document.hidden || admissionRevision !== foregroundRevision) fail(422, 'HOST_NOT_FOREGROUND');
      const decided = await repo.decideToolApprovalAndResume(ctx,
        { turnId, approvalId, decision, decidedBy: 'user' });
      if (!decided) return fail(404, 'APPROVAL_NOT_FOUND');
      if (!decided.ready) return fail(409, 'APPROVAL_NOT_RESUMABLE');
      checkOpen();
      if (decided.continuation && (document.hidden || admissionRevision !== foregroundRevision || signal?.aborted)) {
        await store.requestCancelAttempt({ turnId, attemptId: decided.continuation.attempt.id });
        signal?.throwIfAborted();
      } else if (decided.continuation) {
        const { attempt, pending, turn, toolCallId, step } = decided.continuation;
        const userMessage = (await repo.getTurnUserMessage(ctx, turnId)) ?? '';
        const events = await repo.getStreamEvents(ctx, turnId, 0);
        const resumed = buildResumeHistory({ userMessage, events: events as never });
        checkOpen();
        if (document.hidden || admissionRevision !== foregroundRevision || signal?.aborted) {
          await store.requestCancelAttempt({ turnId, attemptId: attempt.id });
          signal?.throwIfAborted();
        } else {
        const control = new ControlContext({ turnId, sessionId: turn.sessionId, attemptId: attempt.id, deadlineEpochMs: Date.now() + 300_000 });
        const owner = { turnId, sessionId: turn.sessionId, attemptId: attempt.id, control, done: Promise.resolve() as Promise<unknown> };
        active = owner;
        owner.done = executeTurn({ execution: store, provider: nativeModelProvider, controlContext: control,
          tools, approvalPolicy: deviceTooling.approval,
          contextBuilder: createConversationContext(turn.sessionId, turnId), options: { maxSteps: 6, maxConsecutiveSameTool: 3, toolTimeoutMs: 12_000, maxModelRetries: 0,
            maxTurnDurationMs: 300_000, leaseTtlMs: 30_000, leaseHeartbeatIntervalMs: 10_000,
            resume: { expectedFencingToken: 0, lastSequence: decided.event!.sequence, lastStep: step,
              history: resumed.history, messageId: resumed.messageId,
              pendingApprovalResolution: { approvalId: decided.approval.id, decision, invocationId: pending.invocationId,
                toolCall: { id: toolCallId, name: pending.name, arguments: pending.argumentsJson ?? {} } } },
          },
        }, { turnId, sessionId: turn.sessionId, attemptId: attempt.id, userMessage },
        ).finally(() => {
          store.releaseQuestionExecutionOwner(turnId, attempt.id);
          control.dispose(); if (active === owner) active = undefined;
        });
        void owner.done.catch(() => undefined);
        }
      }
      const attemptId = (decided.event?.data as { continuationAttemptId?: string } | undefined)?.continuationAttemptId;
      return { approvalId: decided.approval.id, state: decision,
        ...(attemptId && decided.event ? { continuation: { attemptId, afterEventId: decided.event.id } } : {}) };
      } finally { accepting = false; }
    },
    async speakText({ text }: { text: string }, signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      if (!text.trim()) fail(400, 'EMPTY_SPEECH_TEXT');
      // Native TTS rejects longer input; refuse here so the UI gets a real reason.
      if (text.length > 4_000) fail(413, 'SPEECH_TEXT_TOO_LARGE');
      const receipt = await nativeRequest({ op: 'speech', operation: 'speak', text });
      if (receipt?.kind !== 'speech_result' || receipt.ok !== true) fail(503, 'SPEECH_UNAVAILABLE');
    },
    async speechInput(signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      // One bounded foreground recognition; the native side owns permission UX.
      const receipt = await nativeRequest({ op: 'speech', operation: 'listen' });
      const text = receipt?.kind === 'speech_input_result' && typeof receipt.text === 'string' ? receipt.text.trim() : '';
      if (!text) fail(503, 'SPEECH_INPUT_UNAVAILABLE');
      return { text };
    },
    // ---- 备份导出：自描述格式、摘要校验、原生窗口预算 ----
    async exportBackup(signal?: AbortSignal) {
      return withDatabase(async () => {
      checkOpen();
      signal?.throwIfAborted();
      const quote = (name: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('BACKUP_TABLE_UNEXPECTED');
        return `"${name}"`;
      };
      const tx = await client.transaction('write');
      try {
        // Only authoritative business facts leave the device. Derived FTS
        // projections and credential/device-scope tables stay local
        // (see @aervox/repositories backup-scope).
        const names = await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid");
        const tables: BackupTable[] = [];
        for (const row of names.rows) {
          const name = String(row.name ?? row[0]);
          if (!isBackupScopedTable(name)) continue;
          const probe = await tx.execute(`SELECT * FROM ${quote(name)} LIMIT 0`);
          const columns = [...probe.columns];
          const rows: Record<string, unknown>[] = [];
          const order = columns.map(quote).join(', ');
          const lengths = columns.map((column, index) => `length(CAST(${quote(column)} AS BLOB)) AS "size_${index}"`).join(', ');
          let offset = 0;
          for (;;) {
            signal?.throwIfAborted(); checkOpen();
            // Probe only integer lengths: a failed statement inside the native
            // transaction quarantines the writer, so never discover limits by
            // overshooting a CursorWindow and retrying.
            const sizes = await tx.execute(`SELECT ${lengths} FROM ${quote(name)} ORDER BY ${order} LIMIT 64 OFFSET ${offset}`);
            if (!sizes.rows.length) break;
            let count = 0, bytes = 0;
            for (const row of sizes.rows) {
              const cells = columns.map((_, index) => Number(row[index] ?? 0));
              const size = cells.reduce((total, value) => total + value, 32 + columns.length * 32);
              if (cells.some(value => !Number.isSafeInteger(value) || value < 0 || value > 256 * 1024) || size > 384 * 1024) {
                throw new Error('BACKUP_ROW_TOO_LARGE');
              }
              if (bytes + size > 384 * 1024) break;
              bytes += size; count++;
            }
            const data = await tx.execute(`SELECT * FROM ${quote(name)} ORDER BY ${order} LIMIT ${count} OFFSET ${offset}`);
            if (data.rows.length !== count) throw new Error('BACKUP_SNAPSHOT_CHANGED');
            for (const item of data.rows) {
              const row = Object.fromEntries(columns.map((column, index) => [column, normalizeBackupValue(item[index])]));
              if (encoder.encode(JSON.stringify(row)).byteLength > 512 * 1024) throw new Error('BACKUP_ROW_TOO_LARGE');
              rows.push(row);
            }
            offset += count;
          }
          tables.push({ name, columns, rows });
        }
        await tx.commit();
        const file = buildBackupFile(tables, value => hostCrypto.sha256Utf8(stableSerialize(value)));
        const text = JSON.stringify(file);
        if (encoder.encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('BACKUP_TOO_LARGE');
        return { text, createdAt: file.createdAt, tableCounts: file.tableCounts };
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      }
      });
    },
    async importBackup() {
      // Old session deletions hard-deleted content without durable deletion
      // facts. An empty deletion_requests table cannot prove a complete history,
      // so every installation refuses before parsing, admission or native SQL.
      // Reopening restore requires a trusted history boundary and durable
      // deletion/deny replay ownership (ITER-003/010/011).
      return fail(409, 'BACKUP_RESTORE_HISTORY_UNVERIFIED');
    },
    async pickTextFile(signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      // SAF grants exactly the chosen document; the native side caps the read.
      const receipt = await nativeRequest({ op: 'file', operation: 'pickText' });
      const name = receipt?.kind === 'file_result' && typeof receipt.name === 'string' ? receipt.name : 'picked.txt';
      const text = receipt?.kind === 'file_result' && typeof receipt.text === 'string' ? receipt.text : '';
      if (!text) return fail(502, 'FILE_READ_FAILED');
      return { name, text };
    },
    async fetchUrlText(url: string, signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      if (typeof url !== 'string' || !/^https:\/\//.test(url) || url.length > 2048) return fail(400, 'FILE_URL_INVALID');
      const receipt = await nativeRequest({ op: 'file', operation: 'fetchText', url });
      const name = receipt?.kind === 'file_result' && typeof receipt.name === 'string' ? receipt.name : 'downloaded.txt';
      const text = receipt?.kind === 'file_result' && typeof receipt.text === 'string' ? receipt.text : '';
      if (!text) return fail(502, 'FILE_FETCH_FAILED');
      return { name, text };
    },
    async configureReviewReminder(input: { enabled: boolean }, signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      const receipt = await nativeRequest({ op: 'notification', operation: input.enabled ? 'enable' : 'disable' });
      return { enabled: receipt?.enabled === true };
    },
    async reviewReminderStatus(signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      const receipt = await nativeRequest({ op: 'notification', operation: 'status' });
      return { enabled: receipt?.enabled === true, permission: receipt?.permission === 'granted' ? 'granted' : 'denied' };
    },
    async shareTextFile({ title, text }: { title: string; text: string }, signal?: AbortSignal) {
      checkOpen(); signal?.throwIfAborted();
      if (!text.trim()) fail(400, 'EMPTY_SHARE_TEXT');
      if (/[\uD800-\uDFFF]/u.test(text) || encoder.encode(text).byteLength > MAX_BACKUP_BYTES) fail(413, 'BACKUP_TOO_LARGE');
      let exportId: string | undefined;
      let abortSent = false;
      const abort = async () => {
        if (abortSent || !exportId) return;
        abortSent = true;
        await nativeRequest({ op: 'backup_file', operation: 'abort', exportId }).catch(() => undefined);
      };
      const onAbort = () => { void abort(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const started = await nativeRequest({ op: 'backup_file', operation: 'begin', title: title.slice(0, 120) });
        if (started?.kind !== 'backup_file' || typeof started.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(started.exportId)) fail(503, 'BACKUP_SHARE_UNAVAILABLE');
        exportId = started.exportId;
        checkOpen(); signal?.throwIfAborted();
        let sequence = 0;
        for (let offset = 0; offset < text.length;) {
          checkOpen(); signal?.throwIfAborted();
          let end = Math.min(offset + 32 * 1024, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
          const receipt = await nativeRequest({ op: 'backup_file', operation: 'append', exportId,
            sequence: ++sequence, text: text.slice(offset, end) });
          if (receipt?.kind !== 'backup_file' || receipt.exportId !== exportId || receipt.sequence !== sequence) fail(503, 'BACKUP_SHARE_UNAVAILABLE');
          offset = end;
        }
        checkOpen(); signal?.throwIfAborted();
        const receipt = await nativeRequest({ op: 'backup_file', operation: 'finish', exportId, sequence });
        if (receipt?.kind !== 'backup_file_shared' || receipt.ok !== true) fail(503, 'BACKUP_SHARE_UNAVAILABLE');
      } catch (error) { await abort(); throw error; }
      finally { signal?.removeEventListener('abort', onAbort); }
    },
    async shareText({ title, text }: { title: string; text: string }, signal?: AbortSignal) {
      checkOpen();
      signal?.throwIfAborted();
      if (!text.trim()) fail(400, 'EMPTY_SHARE_TEXT');
      // The channel request budget is 1 MiB; keep the payload well below it.
      if (encoder.encode(text).byteLength > 256 * 1024) fail(413, 'SHARE_TEXT_TOO_LARGE');
      const receipt = await nativeRequest({ op: 'share', operation: 'text', subject: title.slice(0, 120), text });
      if (receipt?.kind !== 'share_result' || receipt.ok !== true) fail(503, 'SHARE_UNAVAILABLE');
    },
  };
}
