// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client, type InStatement, type ResultSet, type Transaction } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AervoxTransport, TurnCallbacks } from '@aervox/api-client';
import type { ModelRequest } from '@aervox/core/browser';
import type { SessionHistoryPage } from '@aervox/contracts';
import type { NativeSqliteRequest } from '@aervox/repositories/native-sqlite-client';
import { decodeNativeSqliteValue, encodeNativeSqliteValue } from '@aervox/repositories/native-sqlite-values';
import { initializeCanonicalSchema } from '../../../packages/repositories/src/schema/manifest';
import { initializeNativeRuntime } from '../src/mobile/native-runtime';

const mocks = vi.hoisted(() => ({
  native: vi.fn(), modelCalls: 0, holding: false, entered: false,
  contexts: [] as { role: string; content: string }[][], chunks: 1,
}));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: (body: Record<string, unknown>) => mocks.native(body) }));
vi.mock('../src/mobile/native-model-provider', async importOriginal => {
  const provider = {
    id: 'deterministic-text-model',
    async *stream(request: ModelRequest) {
      mocks.modelCalls++; mocks.entered = true;
      mocks.contexts.push(request.context.messages.map(({ role, content }) => ({ role, content })));
      if (mocks.holding) await new Promise<void>((resolve, reject) => {
        if (request.signal?.aborted) { reject(new Error('MODEL_CANCELLED')); return; }
        request.signal?.addEventListener('abort', () => reject(new Error('MODEL_CANCELLED')), { once: true });
      });
      for (let index = 0; index < mocks.chunks; index++) yield { text: '手机里的回答', isFinal: false };
      yield { text: '', isFinal: true, stopReason: 'stop' };
    },
  };
  return { ...await importOriginal<typeof import('../src/mobile/native-model-provider')>(),
    nativeModelProvider: provider, createNativeModelProvider: () => provider };
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
let current: Fixture | undefined;
const epoch = 'native_test_epoch';
function wire(result: ResultSet) {
  return { columns: result.columns, columnTypes: result.columnTypes, rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid?.toString() ?? null,
    rows: result.rows.map(row => Array.from(row, value => encodeNativeSqliteValue(value))) };
}
/** Actual SQLite is behind a JSON wire adapter. Commands, transactions, history,
 * Core fencing and durable output all execute their product implementations. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aervox-mobile-runtime-'));
  const database = createClient({ url: `file:${join(directory, 'main.db')}`, intMode: 'bigint' });
  await database.execute('PRAGMA foreign_keys=ON');
  await initializeCanonicalSchema(database, 'main');
  let transaction: Transaction | undefined;
  let owner: string | null = null, counter = 0, configured = true, loseCommit = false;
  let commits = 0;
  const resultRows: number[] = [];
  const argumentCounts: number[] = [], windowSizes: number[] = [];
  const dispatch = async (body: Record<string, unknown>) => {
    if (body.op === 'runtime') return { kind: 'runtime', sqlite: 'ready', connectionEpoch: epoch, mode: 'foreground' };
    if (body.op === 'model' && body.operation === 'summary') return { kind: 'summary', hasCredential: configured };
    if (body.op === 'dispose') {
      if (transaction && !transaction.closed) await transaction.rollback();
      transaction = undefined; owner = null;
      return { kind: 'disposed', connectionEpoch: epoch };
    }
    if (body.op !== 'sqlite') throw new Error('UNEXPECTED_NATIVE_OPERATION');
    const request = body as unknown as NativeSqliteRequest;
    expect(request.connectionEpoch).toBe(epoch);
    if (request.operation === 'begin') {
      expect(transaction).toBeUndefined();
      transaction = await database.transaction('write'); owner = `transaction_${++counter}`;
      return { kind: 'begun', connectionEpoch: epoch, transactionId: owner };
    }
    expect(request.transactionId).toBe(owner);
    if (request.operation === 'execute') {
      const { sql, args } = request.statement;
      const argumentCount = Object.keys(args).length;
      argumentCounts.push(argumentCount);
      if (argumentCount > 256) throw new Error('NATIVE_ARGUMENT_LIMIT');
      const decoded = Array.isArray(args) ? args.map(value => decodeNativeSqliteValue(value, 'bigint'))
        : Object.fromEntries(Object.entries(args).map(([key, value]) => [key, decodeNativeSqliteValue(value, 'bigint')]));
      try {
        const result = await (transaction ?? database).execute({ sql, args: decoded } as InStatement);
        resultRows.push(result.rows.length);
        if (result.rows.length > 512) throw new Error('NATIVE_RESULT_ROW_LIMIT');
        // Conservatively approximate a native CursorWindow with row/cell
        // bookkeeping. JSON wire encoding has its own separate response budget.
        const windowBytes = result.rows.reduce((total, row) => total + 16 + Array.from(row).reduce<number>((size, value) => size + 16
          + (typeof value === 'string' ? new TextEncoder().encode(value).byteLength
            : value instanceof ArrayBuffer ? value.byteLength : ArrayBuffer.isView(value) ? value.byteLength : 8), 0), 0);
        windowSizes.push(windowBytes);
        if (windowBytes > 1024 * 1024) throw new Error('NATIVE_CURSOR_WINDOW_LIMIT');
        const response = JSON.stringify({ kind: 'result', connectionEpoch: epoch, transactionId: owner, result: wire(result) });
        if (new TextEncoder().encode(response).byteLength > 3 * 1024 * 1024) throw new Error('NATIVE_RESULT_BYTE_LIMIT');
        return JSON.parse(response);
      } catch {
        return { kind: 'rejected', connectionEpoch: epoch, transactionId: owner, state: owner ? 'active' : 'none', code: 'SQLITE_ERROR' };
      }
    }
    await transaction![request.operation](); transaction = undefined; owner = null;
    if (request.operation === 'commit') {
      commits++;
      if (loseCommit) { loseCommit = false; throw new Error('LOST_NATIVE_COMMIT_RECEIPT'); }
    }
    return { kind: 'terminal', connectionEpoch: epoch, transactionId: request.transactionId,
      outcome: request.operation === 'commit' ? 'committed' : 'rolledBack' };
  };
  mocks.native.mockImplementation(dispatch);
  const start = () => initializeNativeRuntime();
  const count = async (table: string) => Number((await database.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
  return { database, start, count, directory, resultRows, argumentCounts, windowSizes,
    setConfigured(value: boolean) { configured = value; },
    loseNextCommit() { loseCommit = true; }, get commits() { return commits; },
    async close() {
      window.dispatchEvent(new Event('pagehide'));
      // close() admission and native actor drain are different. Wait for the
      // asynchronous dispose call before releasing this fixture's actual writer.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (transaction && !transaction.closed) await transaction.rollback();
      database.close(); rmSync(directory, { recursive: true, force: true });
    },
  };
}
function callbacks() {
  const texts: string[] = [];
  const done = vi.fn();
  return { texts, done, value: { onDelta: text => texts.push(text), onDone: done } satisfies TurnCallbacks };
}
async function session(transport: AervoxTransport) {
  return transport.request<{ id: string }>('POST', '/v1/sessions', { id: 'phone_session', title: '手机会话' });
}
beforeEach(async () => {
  mocks.modelCalls = 0; mocks.holding = false; mocks.entered = false; mocks.contexts = []; mocks.chunks = 1; mocks.native.mockReset();
  current = await fixture();
});
afterEach(async () => { await current?.close(); current = undefined; });

describe('Android local conversation composition over actual SQLite', () => {
  it('commits one accepted execution, persists its answer, reopens history, and deletes the local session', async () => {
    const fixture = current!, transport = await fixture.start();
    const created = await session(transport), first = callbacks();
    await transport.streamTurn(created.id, '问题\0尾', first.value, { idempotencyKey: 'same_intent' });
    expect(first.texts.join('')).toBe('手机里的回答'); expect(first.done).toHaveBeenCalledOnce();
    expect(mocks.modelCalls).toBe(1);
    const replay = callbacks();
    await transport.streamTurn(created.id, '问题\0尾', replay.value, { idempotencyKey: 'same_intent' });
    expect(replay.texts.join('')).toBe('手机里的回答');
    expect(mocks.modelCalls).toBe(1);
    expect(await fixture.count('turns')).toBe(1); expect(await fixture.count('turn_attempts')).toBe(1);
    const history = await transport.request<SessionHistoryPage>('GET', `/v1/sessions/${created.id}/history`);
    expect(history.items[0]?.isComplete).toBe(true);
    expect(history.items[0]?.messages.map(message => message.content)).toEqual(['问题\0尾', '手机里的回答']);
    window.dispatchEvent(new Event('pagehide')); await new Promise(resolve => setTimeout(resolve, 0));
    const reopened = await fixture.start();
    expect(await reopened.request('GET', `/v1/sessions/${created.id}/history`)).toEqual(history);
    await reopened.request('DELETE', `/v1/sessions/${created.id}`);
    for (const table of ['sessions', 'turns', 'turn_attempts', 'messages', 'message_versions', 'safe_segments', 'turn_stream_events']) {
      expect(await fixture.count(table), table).toBe(0);
    }
  });

  it('rejects unconfigured model sends before accepting any durable turn', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    fixture.setConfigured(false);
    await expect(transport.streamTurn('phone_session', '不能静默伪造回复', callbacks().value))
      .rejects.toMatchObject({ status: 422, code: 'MODEL_NOT_CONFIGURED' });
    for (const table of ['turns', 'turn_attempts', 'messages', 'outbox_events']) expect(await fixture.count(table), table).toBe(0);
    expect(mocks.modelCalls).toBe(0);
    fixture.setConfigured(true);
    await transport.streamTurn('phone_session', '配置完成后的消息', callbacks().value);
    expect(await fixture.count('turns')).toBe(1);
    expect(mocks.modelCalls).toBe(1);
  });

  it('refuses an invalid model configuration receipt before accepting durable work', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.native.mockResolvedValueOnce({ kind: 'summary', hasCredential: 'true' });
    await expect(transport.streamTurn('phone_session', '没有有效配置回执', callbacks().value))
      .rejects.toMatchObject({ status: 503, code: 'MODEL_STATE_UNAVAILABLE' });
    for (const table of ['turns', 'turn_attempts', 'messages', 'outbox_events']) expect(await fixture.count(table), table).toBe(0);
    expect(mocks.modelCalls).toBe(0);
  });

  it('refuses replay when the original input was already deleted without exposing persisted text', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    let turnId = '';
    await transport.streamTurn('phone_session', '删除前的问题', callbacks().value, { onAccepted: id => { turnId = id; } });
    await fixture.database.execute("UPDATE messages SET deleted_at='removed' WHERE role='user'");
    const output = callbacks(), event = vi.fn();
    await expect(transport.observeTurn(turnId, { ...output.value, onEvent: event }))
      .rejects.toMatchObject({ status: 404, code: 'TURN_NOT_FOUND' });
    expect(output.texts).toEqual([]); expect(output.done).not.toHaveBeenCalled(); expect(event).not.toHaveBeenCalled();
  });

  it('finishes an already consumed terminal cursor without hanging or publishing duplicate output', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    let turnId = '';
    await transport.streamTurn('phone_session', '终态后的游标', callbacks().value, { onAccepted: id => { turnId = id; } });
    const last = (await fixture.database.execute({ sql: 'SELECT id FROM turn_stream_events WHERE turn_id=? ORDER BY sequence DESC LIMIT 1', args: [turnId] })).rows[0]!;
    const abort = new AbortController(), output = callbacks();
    const timeout = setTimeout(() => abort.abort(), 1000);
    try { await expect(transport.observeTurn(turnId, output.value, { afterEventId: String(last.id), signal: abort.signal })).resolves.toBeUndefined(); }
    finally { clearTimeout(timeout); }
    expect(output.texts).toEqual([]); expect(output.done).not.toHaveBeenCalled();
  });

  it.each(['source', 'session'] as const)('rechecks cached replay frames after a callback waits across %s deletion', async target => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.chunks = 3;
    let turnId = '';
    await transport.streamTurn('phone_session', '回调等待期间删除', callbacks().value, { onAccepted: id => { turnId = id; } });
    await new Promise(resolve => setTimeout(resolve, 0));
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const output = callbacks();
    const observing = transport.observeTurn(turnId, { ...output.value, async onEvent(event) {
      if (event.eventType === 'delta' && output.texts.length === 1) { entered(); await resume; }
    } });
    const rejected = expect(observing).rejects.toMatchObject({ status: 410, code: 'STREAM_SOURCE_UNAVAILABLE' });
    await paused;
    if (target === 'session') await transport.request('DELETE', '/v1/sessions/phone_session');
    else await fixture.database.execute("UPDATE messages SET deleted_at='removed' WHERE role='user'");
    release(); await rejected;
    expect(output.texts).toEqual(['手机里的回答']); expect(output.done).not.toHaveBeenCalled();
  });

  it('revokes a paused replay immediately when the asset document is retired', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.chunks = 3;
    let turnId = '';
    await transport.streamTurn('phone_session', '界面关闭前的回复', callbacks().value, { onAccepted: id => { turnId = id; } });
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const output = callbacks();
    const observing = transport.observeTurn(turnId, { ...output.value, async onEvent(event) {
      if (event.eventType === 'delta' && output.texts.length === 1) { entered(); await resume; }
    } });
    const rejected = expect(observing).rejects.toMatchObject({ status: 503, code: 'HOST_CLOSED' });
    await paused;
    window.dispatchEvent(new Event('pagehide'));
    release(); await rejected;
    expect(output.texts).toEqual(['手机里的回答']); expect(output.done).not.toHaveBeenCalled();
  });

  it('stops idle observation when its source disappears without another model event', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.holding = true;
    let turnId = '', heartbeat!: () => void;
    const reachedIdle = new Promise<void>(resolve => { heartbeat = resolve; });
    const runningAbort = new AbortController();
    const running = transport.streamTurn('phone_session', '等待中的来源删除', { ...callbacks().value, onHeartbeat: heartbeat },
      { signal: runningAbort.signal, onAccepted: id => { turnId = id; } }).catch(error => error);
    await reachedIdle;
    await vi.waitFor(() => expect(mocks.entered).toBe(true));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error('observation_did_not_close')), 1000);
    let observerIdle!: () => void;
    const idle = new Promise<void>(resolve => { observerIdle = resolve; });
    const observing = transport.observeTurn(turnId, { ...callbacks().value, onHeartbeat: observerIdle }, { signal: abort.signal });
    const rejected = expect(observing).rejects.toMatchObject({ status: 410, code: 'STREAM_SOURCE_UNAVAILABLE' });
    await idle;
    await fixture.database.execute("UPDATE messages SET deleted_at='removed' WHERE role='user'");
    try { await rejected; } finally {
      clearTimeout(timeout);
      await transport.request('POST', `/v1/turns/${turnId}/cancel`, {});
      runningAbort.abort();
      await running;
    }
  });

  it('continues model context past 512 old deltas and keeps late withdrawal effective', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    await transport.streamTurn('phone_session', '第一轮原始问题', callbacks().value);
    const original = (await fixture.database.execute('SELECT id FROM turns')).rows[0]!.id;
    await fixture.database.batch(Array.from({ length: 600 }, (_, index) => ({
      sql: 'INSERT INTO turn_stream_events(id,turn_id,sequence,event_type,data,occurred_at,safety_decision) VALUES (?,?,?,?,?,?,?)',
      args: [`old_delta_${index}`, original, 1000 + index, 'delta', JSON.stringify({ text: '不应重新消费的传输正文' }), 'now', 'approved'],
    })), 'write');
    await transport.streamTurn('phone_session', '接着第二轮', callbacks().value);
    expect(mocks.contexts[1]).toContainEqual({ role: 'user', content: '第一轮原始问题' });
    expect(mocks.contexts[1]).toContainEqual({ role: 'assistant', content: '手机里的回答' });
    expect(mocks.contexts[1]?.some(item => item.content.includes('不应重新消费的传输正文'))).toBe(false);
    await fixture.database.execute({
      sql: 'INSERT INTO turn_stream_events(id,turn_id,sequence,event_type,data,occurred_at,safety_decision) VALUES (?,?,?,?,?,?,?)',
      args: ['late_withdrawal', original, 2000, 'redacted', '{}', 'now', 'approved'],
    });
    await transport.streamTurn('phone_session', '接着第三轮', callbacks().value);
    expect(mocks.contexts[2]).not.toContainEqual({ role: 'user', content: '第一轮原始问题' });
    expect(mocks.contexts[2]).toContainEqual({ role: 'user', content: '接着第二轮' });
    expect(Math.max(...fixture.resultRows)).toBeLessThanOrEqual(512);
    expect(mocks.modelCalls).toBe(3);
  });

  it('runs a real 600-fragment Core turn through native binding/window limits and persists the full answer', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.chunks = 600;
    const output = callbacks();
    await transport.streamTurn('phone_session', '长回复', output.value);
    expect(output.texts.join('')).toBe('手机里的回答'.repeat(600));
    expect(output.done).toHaveBeenCalledOnce();
    expect(await fixture.count('safe_segments')).toBe(600);
    const history = await transport.request<SessionHistoryPage>('GET', '/v1/sessions/phone_session/history');
    expect(history.items[0]?.isComplete).toBe(true);
    expect(history.items[0]?.messages.at(-1)?.content).toBe('手机里的回答'.repeat(600));
    mocks.chunks = 1;
    await transport.streamTurn('phone_session', '长轮之后继续', callbacks().value);
    expect(mocks.contexts[1]).toContainEqual({ role: 'assistant', content: '手机里的回答'.repeat(600) });
    expect(Math.max(...fixture.argumentCounts)).toBeLessThanOrEqual(256);
    expect(Math.max(...fixture.resultRows)).toBeLessThanOrEqual(512);
    expect(Math.max(...fixture.windowSizes)).toBeLessThanOrEqual(1024 * 1024);
  });

  it('records cancellation before stopping the provider, blocks active deletion, and leaves a durable cancelled result', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    mocks.holding = true;
    let turnId = '';
    const output = callbacks();
    const running = transport.streamTurn('phone_session', '等待取消', output.value, { onAccepted: id => { turnId = id; } });
    await vi.waitFor(() => { expect(mocks.entered).toBe(true); expect(turnId).not.toBe(''); });
    await expect(transport.request('DELETE', '/v1/sessions/phone_session')).rejects.toMatchObject({ code: 'STOP_REPLY_BEFORE_DELETING' });
    await transport.request('POST', `/v1/turns/${turnId}/cancel`, {});
    await running;
    const rows = (await fixture.database.execute('SELECT status FROM turn_attempts')).rows;
    expect(rows).toEqual([expect.objectContaining({ status: 'Cancelled' })]);
    const history = await transport.request<SessionHistoryPage>('GET', '/v1/sessions/phone_session/history');
    expect(history.items[0]).toMatchObject({ status: 'Cancelled', isComplete: false });
    expect(output.texts).toEqual([]);
    await transport.request('DELETE', '/v1/sessions/phone_session');
    expect(await fixture.count('sessions')).toBe(0);
  });

  it('does not replay an acceptance whose real commit acknowledgement was lost, including after reopening', async () => {
    const fixture = current!, transport = await fixture.start(); await session(transport);
    fixture.loseNextCommit();
    await expect(transport.streamTurn('phone_session', '受理结果未知', callbacks().value, { idempotencyKey: 'lost_intent' }))
      .rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await fixture.count('turns')).toBe(1); expect(mocks.modelCalls).toBe(0);
    const committed = fixture.commits;
    await expect(transport.streamTurn('phone_session', '受理结果未知', callbacks().value, { idempotencyKey: 'lost_intent' }))
      .rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(fixture.commits).toBe(committed);
    window.dispatchEvent(new Event('pagehide')); await new Promise(resolve => setTimeout(resolve, 0));
    const reopened = await fixture.start();
    await reopened.streamTurn('phone_session', '受理结果未知', callbacks().value, { idempotencyKey: 'lost_intent' });
    expect(await fixture.count('turns')).toBe(1); expect(mocks.modelCalls).toBe(0);
    expect((await fixture.database.execute('SELECT status FROM turns')).rows[0]?.status).toBe('Interrupted');
  });
});
