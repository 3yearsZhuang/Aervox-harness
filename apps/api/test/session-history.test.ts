import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionHistoryApi, sessionHistoryPageSchema } from '@aervox/contracts';
import { createInMemoryDatabase, SqliteConversationRepository } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';
const ctx = { workspaceId: 'local', subjectUserId: 'local' }, token = 'history-api-token';
describe('owner history HTTP contract', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  const endpoint = '/v1/sessions/session/history';
  async function request(path = endpoint, auth: string | null = token) {
    const result = await fetch(base + path, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    return { status: result.status, body: await result.json(), cache: result.headers.get('cache-control') };
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    const repo = new SqliteConversationRepository(database.db);
    await repo.getOrCreateSession(ctx, 'session');
    await repo.createTurnWithOutbox(ctx, { id: 'turn', sessionId: 'session', idempotencyKey: 'turn', status: 'Interrupted' }, { id: 'user', content: 'durable input' });
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: 'token', token } });
    base = await built.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => { vi.restoreAllMocks(); await built.app.close(); await database.cleanup(); });
  it('authenticates before the owner projection and returns the declared no-store response', async () => {
    const read = vi.spyOn(SqliteConversationRepository.prototype, 'getSessionHistoryPage');
    const unauthorized = await request(endpoint, null); expect(unauthorized.status).toBe(401);
    expect((await request(endpoint, 'wrong')).status).toBe(401); expect(read).not.toHaveBeenCalled();
    const response = await request(); expect(response.status).toBe(200); expect(response.cache).toBe('no-store');
    expect(sessionHistoryPageSchema.parse(response.body)).toMatchObject({ sessionId: 'session', nextCursor: null,
      items: [{ turnId: 'turn', status: 'Interrupted', isComplete: false, messages: [{ messageId: null, versionId: 'user', contentKind: 'accepted_input', legacy: true, readOnly: true, content: 'durable input' }] }] });
    expect(sessionHistoryApi.get.path).toBe('/v1/sessions/{sessionId}/history');
  });
  it('rejects unknown, repeated and malformed query arguments instead of coercing them', async () => {
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=01', 'limit=1x', 'limit=1&limit=2', 'cursor=x&cursor=y', 'includeRaw=true', 'cursor=bad%2Bbase64', 'cursor=e30']) {
      const response = await request(endpoint + '?' + query); expect(response.status, query).toBe(400);
      expect(response.body.code).toBe('INVALID_HISTORY_QUERY');
    }
  });
  it('returns explicit missing-session and expired-anchor errors without executing work', async () => {
    expect((await request('/v1/sessions/missing/history')).status).toBe(404);
    const cursor = Buffer.from(JSON.stringify({ v: 1, sessionId: 'session', beforeTurnId: 'missing' })).toString('base64url');
    const response = await request(endpoint + '?cursor=' + cursor);
    expect(response.status).toBe(410); expect(response.body.code).toBe('HISTORY_CURSOR_EXPIRED');
    expect((await database.client.execute('SELECT COUNT(*) AS count FROM turn_attempts')).rows[0]?.count).toBe(0);
  });
  it('returns only the requested page after Chinese/NUL identities and keeps redacted bodies withheld', async () => {
    const repo = new SqliteConversationRepository(database.db), sessionId = '中文\0session';
    await repo.getOrCreateSession(ctx, sessionId);
    for (const id of ['old\0尾', 'new\0尾']) await repo.createTurnWithOutbox(ctx,
      { id, sessionId, idempotencyKey: id, status: 'Completed' }, { id: `user-${id}`, content: `body-${id}` });
    const path = '/v1/sessions/' + encodeURIComponent(sessionId) + '/history';
    const first = await request(path + '?limit=1');
    expect(first.status).toBe(200); expect(first.body.items.map((item: {turnId: string}) => item.turnId)).toEqual(['new\0尾']);
    const last = await request(path + '?limit=1&cursor=' + first.body.nextCursor);
    expect(last.body.items[0].messages[0].content).toBe('body-old\0尾');
    await repo.redactTurnMessages(ctx, 'old\0尾');
    const withheld = await request(path + '?limit=1&cursor=' + first.body.nextCursor);
    expect(withheld.body.items[0].messages[0]).toMatchObject({ visibility: 'withheld', content: null });
    expect(JSON.stringify(withheld.body)).not.toContain('body-old');
  });
  it.each(['x'.repeat(128), '中'.repeat(128)])('reads an existing maximum-length session accepted by the public contract', async sessionId => {
    const repo = new SqliteConversationRepository(database.db); await repo.getOrCreateSession(ctx, sessionId);
    const result = await request('/v1/sessions/' + encodeURIComponent(sessionId) + '/history');
    expect(result.status).toBe(200); expect(result.body).toEqual({ sessionId, items: [], nextCursor: null });
  });
  it('returns a declared 422 when one persistent message exceeds the Turn budget', async () => {
    await database.client.execute({ sql: 'UPDATE message_versions SET content = ? WHERE id = ?', args: ['\0' + 'x'.repeat(256 * 1024), 'user'] });
    const response = await request(); expect(response.status).toBe(422); expect(response.body.code).toBe('HISTORY_ITEM_TOO_LARGE');
    expect(JSON.stringify(response.body)).not.toContain('xxxx');
  });
});
