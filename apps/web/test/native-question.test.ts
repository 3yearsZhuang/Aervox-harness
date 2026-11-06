import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInMemoryDatabase, initDatabaseSchema, SqliteConversationRepository } from '@aervox/repositories';
import { createQuestionBridge } from '../src/mobile/native-question';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const request = { turnId: 'turn', attemptId: 'attempt', invocationId: 'attempt:1:1', step: 1,
  questions: [{ id: 'q1', question: '要打开哪个应用？', multiSelect: false, options: [{ label: '设置' }, { label: '相机' }] }] };
const identity = { attemptId: request.attemptId, invocationId: request.invocationId, step: request.step };
const answers = [{ id: 'q1', selected: ['设置'] }];
let resource: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let repo: SqliteConversationRepository;
let options: Parameters<typeof createQuestionBridge<typeof ctx>>[0];
let bridge: ReturnType<typeof createQuestionBridge>;
beforeEach(async () => {
  resource = await createInMemoryDatabase();
  await initDatabaseSchema(resource.client);
  repo = new SqliteConversationRepository(resource.db);
  await repo.getOrCreateSession(ctx, 'session');
  await repo.acceptTurn(ctx, { turnId: 'turn', attemptId: 'attempt', sessionId: 'session', idempotencyKey: 'key',
    message: { id: 'user', content: 'Question source' }, consumeInbox: false });
  const claim = await repo.claimTurnAttempt(ctx, { turnId: 'turn', attemptId: 'attempt', expectedFencingToken: 0, leaseId: 'lease' });
  options = { ctx, owner: () => ({ turnId: 'turn', attemptId: 'attempt', expectedFencingToken: claim.fencingToken, leaseId: claim.leaseId }),
    commands: {
      require: (owner, input) => repo.requireUserQuestion(owner, input),
      getPending: (owner, turnId) => repo.getPendingUserQuestion(owner, turnId),
      getReceipt: (owner, input) => repo.getUserQuestionAnswerReceipt(owner, input),
      answer: (owner, input, selected) => repo.answerUserQuestion(owner, input, selected),
      cancel: (owner, input) => repo.cancelUserQuestion(owner, input),
    } };
  bridge = createQuestionBridge(options);
});
afterEach(async () => { await bridge.cancel(); await resource.cleanup(); });
const waitPending = () => vi.waitFor(async () => expect(await repo.getPendingUserQuestion(ctx, 'turn')).not.toBeNull());

it('reopens the original durable question without extending its persisted deadline', async () => {
  const pending = bridge.port.ask(request); pending.catch(() => undefined);
  await waitPending();
  const original = await repo.getPendingUserQuestion(ctx, 'turn');
  const reopened = createQuestionBridge(options), deliver = vi.fn();
  reopened.observe('turn', deliver);
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  expect(deliver.mock.calls[0]![0]).toMatchObject({ ...identity, expiresAt: original!.expiresAt, identityStatus: 'available' });
  await reopened.submit('turn', answers, identity);
  await expect(pending).resolves.toEqual({ answers });
  await reopened.submit('turn', answers, identity);
  expect((await repo.getStreamEvents(ctx, 'turn')).filter(event => event.eventType === 'user_question_answered')).toHaveLength(1);
});

it('creates no orphan timers when the answer commits before the registration receipt returns', async () => {
  let registered!: () => void, releaseReceipt!: () => void;
  const committed = new Promise<void>(resolve => { registered = resolve; });
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const require = options.commands.require;
  bridge = createQuestionBridge({ ...options, commands: { ...options.commands,
    require: async (owner, input) => {
      const result = await require(owner, input);
      registered();
      await receiptGate;
      return result;
    },
  } });
  const pending = bridge.port.ask(request);
  await committed;
  await bridge.submit('turn', answers, identity);
  await expect(pending).resolves.toEqual({ answers });
  vi.useFakeTimers();
  try {
    releaseReceipt();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await repo.getStreamEvents(ctx, 'turn')).filter(event => event.eventType === 'user_question_answered')).toHaveLength(1);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it('refuses missing or different identity and invalid options while retaining the original pending question', async () => {
  const pending = bridge.port.ask(request); pending.catch(() => undefined);
  await waitPending();
  await expect(bridge.port.ask({ ...request, questions: [{ ...request.questions[0]!, question: '替换同身份内容？' }] })).rejects.toThrow('QUESTION_IDENTITY_CONFLICT');
  await expect(bridge.port.ask({ ...request, step: 2 })).rejects.toThrow('QUESTION_PENDING');
  await expect(bridge.submit('turn', answers)).rejects.toThrow('QUESTION_IDENTITY_REQUIRED');
  await expect(bridge.submit('turn', answers, { ...identity, invocationId: 'attempt:1:2' })).rejects.toThrow('QUESTION_NOT_PENDING');
  await expect(bridge.submit('turn', [{ id: 'q1', selected: ['other'] }], identity)).rejects.toThrow('QUESTION_ANSWER_INVALID');
  expect(await repo.getPendingUserQuestion(ctx, 'turn')).toMatchObject(identity);
  await bridge.submit('turn', answers, identity);
  await pending;
});

it('does not deliver a durable query result after its observation was removed', async () => {
  const pending = bridge.port.ask(request); pending.catch(() => undefined);
  await waitPending();
  const deliver = vi.fn(), stop = bridge.observe('turn', deliver);
  stop();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(deliver).not.toHaveBeenCalled();
  await bridge.submit('turn', answers, identity);
  await pending;
});

it('abort and host retirement cancel the original question without fabricating an answer', async () => {
  const signal = new AbortController();
  const pending = bridge.port.ask({ ...request, signal: signal.signal }); pending.catch(() => undefined);
  await waitPending();
  signal.abort();
  await expect(pending).rejects.toThrow('QUESTION_CANCELLED');
  expect(await repo.getPendingUserQuestion(ctx, 'turn')).toBeNull();
  const next = bridge.port.ask({ ...request, invocationId: 'attempt:1:2' }); next.catch(() => undefined);
  await waitPending();
  await bridge.cancel();
  await expect(next).rejects.toThrow('QUESTION_CANCELLED');
  expect((await repo.getStreamEvents(ctx, 'turn')).filter(event => event.eventType === 'user_question_answered')).toHaveLength(0);
});
