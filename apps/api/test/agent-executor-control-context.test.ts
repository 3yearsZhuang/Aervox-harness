import { expect, it, vi } from 'vitest';
import { createInMemoryDatabase, SqliteConversationRepository } from '@aervox/repositories';
import { ControlContext } from '@aervox/agent-loop';
import { runLoopTurnOnce } from '../src/modules/companion/conversation/agent-executor.js';
import { projectSafeEventData } from '../src/modules/companion/conversation/broadcasting-store.js';
import { buildApp } from '../src/app.js';
const ctx = { workspaceId: 'local', subjectUserId: 'local' } as const;

it('deadline must leave Turn, Attempt and terminal event in the same Interrupted state', async () => {
  const db = await createInMemoryDatabase();
  const previous = process.env.AERVOX_LOOP_PROVIDER;
  process.env.AERVOX_LOOP_PROVIDER = 'replay';
  try {
    const repo = new SqliteConversationRepository(db.db, db.client);
    await repo.getOrCreateSession(ctx, 's_review', 'review');
    await repo.createTurnWithOutbox(ctx, {id:'t_review',sessionId:'s_review',idempotencyKey:'review',status:'Created'}, {id:'m_review',content:'review'});
    await repo.createTurnAttempt(ctx,'t_review',{id:'a_review',attempt:1});
    await runLoopTurnOnce(repo,ctx,{turnId:'t_review',sessionId:'s_review',attemptId:'a_review',userMessage:'review',controlContext:new ControlContext({deadlineEpochMs:Date.now()-1})});
    const turn = await repo.getTurn(ctx,'t_review');
    const attempts = await repo.listTurnAttempts(ctx,'t_review');
    const events = await repo.getStreamEvents(ctx,'t_review',0);
    const done = events.find(e=>e.eventType==='done');
    expect(done?.data).toMatchObject({ status: 'Interrupted' });
    expect(attempts[0]?.status).toBe('Interrupted');
    expect(turn?.status).toBe('Interrupted');
  } finally {
    if(previous===undefined) delete process.env.AERVOX_LOOP_PROVIDER; else process.env.AERVOX_LOOP_PROVIDER=previous;
    await db.cleanup();
  }
});

it('persisted SSE replay must use the same redaction as live events', async () => {
  const db = await createInMemoryDatabase();
  const built = await buildApp({db:db.db,client:db.client});
  try {
    const repo = new SqliteConversationRepository(db.db, db.client);
    await repo.getOrCreateSession(ctx,'s_redact','review');
    await repo.createTurnWithOutbox(ctx,{id:'t_redact',sessionId:'s_redact',idempotencyKey:'redact',status:'Completed'},{id:'m_redact',content:'review'});
    const payload = {message:'fixture', authToken:'review_fake_secret'};
    expect(projectSafeEventData('error',payload)).not.toHaveProperty('authToken');
    await repo.appendStreamEvent(ctx,{id:'ev_redact',turnId:'t_redact',sequence:1,eventType:'error',payloadVersion:1,data:payload});
    await repo.createTurnAttempt(ctx,'t_redact',{id:'a_redact',attempt:1});
    await repo.finalizeTurnAttempt(ctx,{turnId:'t_redact',attemptId:'a_redact',status:'Failed'});
    const response=await built.app.inject({method:'GET',url:'/v1/turns/t_redact/events'});
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('review_fake_secret');
  } finally {await built.app.close();await db.cleanup();}
});

it('嵌套 DTO 仅保留公开字段，工具实现结果与未知事件不进入 SSE', () => {
  const question = { turnId: 't', authToken: 'fake', questions: [{ id: 'q', question: 'choose', authToken: 'nested', options: [{ label: 'yes', internalStack: 'hidden' }] }] };
  const projected = projectSafeEventData('user_question_required', question);
  expect(JSON.stringify(projected)).not.toMatch(/fake|nested|hidden|authToken|internalStack/);
  expect(projected).toMatchObject({ questions: [{ id: 'q', question: 'choose', options: [{ label: 'yes' }] }] });
  expect(projectSafeEventData('unknown', { authToken: 'fake' })).toEqual({});
  expect(projectSafeEventData('tool_result', { invocationId: 'i', name: 'read', ok: true, output: { authToken: 'fake' } })).not.toHaveProperty('output');
  expect(projectSafeEventData('__proto__', { authToken: 'fake' })).toEqual({});
  expect(projectSafeEventData('tool_result', { invocationId: 'i', name: 'record_practice_attempt', ok: true, output: {
    questionId: 'q', attemptId: 'a', judgement: 'incorrect', enteredMistakeNotebook: true, authToken: 'fake', internal: { credential: 'fake' },
  } })).toEqual({ invocationId: 'i', name: 'record_practice_attempt', ok: true, output: {
    questionId: 'q', attemptId: 'a', judgement: 'incorrect', enteredMistakeNotebook: true,
  } });
});

it('真实 Runtime 适配器将取消与控制上下文传到 handler，并丢弃迟到结果', async () => {
  const { SqliteToolRegistryRepository } = await import('@aervox/repositories');
  const { ToolRuntime } = await import('../src/modules/ecosystem/tools/index.js');
  const { createRuntimeToolProvider } = await import('../src/modules/companion/conversation/tool-providers.js');
  const db = await createInMemoryDatabase();
  const runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(db.db) });
  const control = new ControlContext();
  let release!: () => void; let entered!: () => void; let signal!: AbortSignal;
  const ready = new Promise<void>((r) => { entered = r; });
  const pending = new Promise<void>((r) => { release = r; });
  try {
    await runtime.registerContribution({ id: 'read', name: 'read', description: 'fixture', category: 'system', safetyLevel: 'read_only' }, { call: async (_ctx, _args, passed) => {
      expect(passed.controlContext).toBe(control); signal = passed.signal; entered(); await pending; return 'late';
    } });
    const provider = createRuntimeToolProvider(runtime, ctx, { conversationRepo: new SqliteConversationRepository(db.db, db.client) });
    const result = provider.execute({ turnId: 't', attemptId: 'a', invocationId: 'i', name: 'read', arguments: {}, controlContext: control });
    await ready; control.abort();
    expect(signal.aborted).toBe(true);
    expect((await result).ok).toBe(false); release();
  } finally { release?.(); control.dispose(); runtime.dispose(); await db.cleanup(); }
});

it('旧执行者终态 CAS 失败不能覆盖接管者的 Turn 和事件', async () => {
  const { SqliteExecutionStore } = await import('@aervox/host-agent');
  const db = await createInMemoryDatabase();
  try {
    const repo = new SqliteConversationRepository(db.db, db.client);
    await repo.getOrCreateSession(ctx, 'fence-s', 'fence');
    await repo.createTurnWithOutbox(ctx, { id: 'fence-t', sessionId: 'fence-s', idempotencyKey: 'fence' }, { id: 'fence-m', content: 'hi' });
    await repo.createTurnAttempt(ctx, 'fence-t', { id: 'fence-a' });
    const store = new SqliteExecutionStore(repo, ctx);
    const claim = await store.claimTurnAttempt({ turnId: 'fence-t', attemptId: 'fence-a', expectedFencingToken: 0 });
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await db.client.execute("UPDATE turn_attempts SET fencing_token = fencing_token + 1 WHERE id = 'fence-a'");
    const finalize = (token: number, status: 'Completed' | 'Failed', sequence: number) => store.finalizeAttemptWithEvent({ turnId: 'fence-t', attemptId: 'fence-a', expectedFencingToken: token, status, sequence, eventType: 'done', eventData: { status } });
    expect((await finalize(claim.fencingToken + 1, 'Completed', 1)).ok).toBe(true);
    expect((await finalize(claim.fencingToken, 'Failed', 2)).ok).toBe(false);
    expect((await repo.getTurn(ctx, 'fence-t'))?.status).toBe('Completed');
    expect((await repo.getStreamEvents(ctx, 'fence-t', 0))).toHaveLength(1);
  } finally { await db.cleanup(); }
});

it('普通用户回合 localProcessingOnly 也拒绝远程 Provider，未发出网络请求', async () => {
  const db = await createInMemoryDatabase();
  const previous = process.env.AERVOX_LOOP_PROVIDER;
  process.env.AERVOX_LOOP_PROVIDER = 'llm';
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    const repo = new SqliteConversationRepository(db.db, db.client);
    await repo.getOrCreateSession(ctx, 'local-s', 'local');
    await repo.createTurnWithOutbox(ctx, { id: 'local-t', sessionId: 'local-s', idempotencyKey: 'local' }, { id: 'local-m', content: 'hi' });
    await repo.createTurnAttempt(ctx, 'local-t', { id: 'local-a' });
    const control = new ControlContext({ localProcessingOnly: true });
    await runLoopTurnOnce(repo, ctx, { turnId: 'local-t', sessionId: 'local-s', attemptId: 'local-a', userMessage: 'hi', controlContext: control }, {
      llmConfigService: { getConfig: async () => ({ enabled: true, providerType: 'openai', baseUrl: 'https://remote.invalid/v1', modelId: 'fixture' }) } as never,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await repo.getTurn(ctx, 'local-t'))?.status).toBe('Failed');
    expect(JSON.stringify(await repo.getStreamEvents(ctx, 'local-t', 0))).toContain('proactive_local_provider_required');
    control.dispose();
  } finally { vi.unstubAllGlobals(); if (previous === undefined) delete process.env.AERVOX_LOOP_PROVIDER; else process.env.AERVOX_LOOP_PROVIDER = previous; await db.cleanup(); }
});
