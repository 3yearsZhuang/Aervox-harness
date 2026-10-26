import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryDatabase, SqliteConversationRepository, SessionHistoryReadError } from '../src/index.js';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const cursor = (sessionId: string, beforeTurnId: string) => Buffer.from(JSON.stringify({ v: 1, sessionId, beforeTurnId })).toString('base64url');
describe('owner history pages use current durable versions only', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteConversationRepository;
  beforeEach(async () => { database = await createInMemoryDatabase(); repo = new SqliteConversationRepository(database.db); await repo.getOrCreateSession(ctx, 'session'); });
  afterEach(async () => { await database.cleanup(); });
  async function accepted(id: string, status = 'Completed', sessionId = 'session', text = `answer ${id}`) {
    await repo.acceptTurn(ctx, { turnId: id, sessionId, idempotencyKey: id, attemptId: `attempt-${id}`,
      message: { id: `user-${id}`, content: `input ${id}` }, consumeInbox: false });
    await repo.appendStreamEvent(ctx, { id: `message-${id}`, turnId: id, attemptId: `attempt-${id}`, expectedFencingToken: 0,
      sequence: 1, eventType: 'message', data: { role: 'assistant', messageId: `assistant-${id}` }, safetyDecision: 'approved' });
    await repo.recordSafeSegmentAtomically(ctx, { turnId: id, attemptId: `attempt-${id}`, expectedFencingToken: 0, sequence: 2,
      text, eventData: { messageId: `assistant-${id}`, text }, safetyDecision: 'approved' });
    await repo.finalizeAttemptWithEventAtomically(ctx, { turnId: id, attemptId: `attempt-${id}`, expectedFencingToken: 0, sequence: 3,
      status, eventType: 'done', eventData: { status }, safetyDecision: 'approved' });
  }
  const page = (input: { limit?: number; cursor?: string } = {}, sessionId = 'session') => repo.getSessionHistoryPage(ctx, { sessionId, ...input });
  it('pages by stable Turn insertion order, returns each page chronologically and does not automatically load older candidates', async () => {
    for (const id of ['z', 'a', 'y', 'b', 'x']) await accepted(id);
    await database.client.execute("UPDATE turns SET created_at = 'same timestamp'");
    const first = await page({ limit: 2 });
    expect(first.items.map(item => item.turnId)).toEqual(['b', 'x']);
    const second = await page({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map(item => item.turnId)).toEqual(['a', 'y']);
    const last = await page({ limit: 2, cursor: second.nextCursor! });
    expect(last.items.map(item => item.turnId)).toEqual(['z']); expect(last.nextCursor).toBeNull();
    expect(first.items[0]?.messages[0]).toMatchObject({ messageId: 'user-b', versionId: 'user-b', contentKind: 'accepted_input', legacy: false, readOnly: false });
  });
  it.each(['Completed', 'Interrupted', 'Cancelled', 'Failed'])('retains actual %s status and the saved prefix after replay cleanup', async status => {
    await accepted('turn', status); await database.client.execute('DELETE FROM turn_stream_events'); await database.client.execute('DELETE FROM safe_segments');
    const result = await page();
    expect(result.items[0]).toMatchObject({ turnId: 'turn', status, isComplete: status === 'Completed' });
    expect(result.items[0]?.messages.map(message => message.content)).toEqual(['input turn', 'answer turn']);
  });
  it('uses current identity pointers, never an old version or an event copy', async () => {
    await accepted('turn');
    const identity = await repo.getMessage(ctx, 'assistant-turn');
    const old = (await repo.listMessageVersions(ctx, 'assistant-turn')).find(version => version.id === identity?.currentVersionId)!;
    const edited = await repo.editMessage(ctx, 'assistant-turn', 'corrected', old.version);
    expect((await page()).items[0]?.messages[1]).toMatchObject({ versionId: edited!.newVersion.id, content: 'corrected' });
    await database.client.execute({ sql: 'DELETE FROM message_versions WHERE id = ?', args: [edited!.newVersion.id] });
    expect((await page()).items.flatMap(turn => turn.messages).some(message => message.role === 'assistant')).toBe(false);
  });
  it('never replaces a missing original source with its edited version', async () => {
    await accepted('turn'); await repo.editMessage(ctx, 'user-turn', 'later input', 1);
    await repo.deleteMessage(ctx, 'user-turn');
    expect((await page()).items).toEqual([]);
  });
  it('advances over hidden candidates without scanning to fill the page', async () => {
    for (const id of ['older', 'hidden-1', 'hidden-2']) await accepted(id);
    await repo.softDeleteMessage(ctx, 'user-hidden-1'); await repo.softDeleteMessage(ctx, 'assistant-hidden-2');
    const first = await page({ limit: 2 }); expect(first.items).toEqual([]); expect(first.nextCursor).not.toBeNull();
    expect((await page({ limit: 2, cursor: first.nextCursor! })).items.map(item => item.turnId)).toEqual(['older']);
  });
  it('binds cursors to the URL session and expires a physically removed anchor', async () => {
    await accepted('first'); await accepted('last');
    const first = await page({ limit: 1 });
    await repo.getOrCreateSession(ctx, 'other');
    await expect(page({ cursor: first.nextCursor! }, 'other')).rejects.toMatchObject({ code: 'INVALID_HISTORY_QUERY' });
    await database.client.execute("DELETE FROM turns WHERE id = 'last'");
    await expect(page({ cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_EXPIRED' });
    await expect(page({ cursor: cursor('session', 'nonexistent') })).rejects.toBeInstanceOf(SessionHistoryReadError);
  });
  it('allows a matching bot group session without mixing personal or other group history', async () => {
    await accepted('personal'); await repo.getOrCreateSession(ctx, 'group', 'group', null, 'bot-group-member-v1');
    await accepted('group-turn', 'Completed', 'group');
    expect((await page({}, 'group')).items.map(item => item.turnId)).toEqual(['group-turn']);
    await database.client.execute("UPDATE sessions SET execution_policy = 'local-v1' WHERE id = 'group'");
    expect((await page({}, 'group')).items).toEqual([]);
  });
  it('marks unlinked legacy rows read-only and displays current linked imports without backfilling events', async () => {
    await repo.createTurnWithOutbox(ctx, { id: 'legacy', sessionId: 'session', idempotencyKey: 'legacy', status: 'Completed' }, { id: 'legacy-user', content: 'legacy input' });
    await repo.appendStreamEvent(ctx, { id: 'legacy-body', turnId: 'legacy', sequence: 1, eventType: 'delta', data: { text: 'event-only-canary' }, safetyDecision: 'approved' });
    const legacy = (await page()).items[0]?.messages;
    expect(legacy).toMatchObject([{ messageId: null, versionId: 'legacy-user', legacy: true, readOnly: true, content: 'legacy input' }]);
    expect(JSON.stringify(legacy)).not.toContain('event-only-canary');
    const imported = await repo.importSession(ctx, { messages: [{ role: 'user', content: 'import input' }, { role: 'assistant', content: 'import answer' }] });
    expect((await page({}, imported.session.id)).items[0]?.messages).toMatchObject([{ legacy: false, content: 'import input' }, { legacy: false, content: 'import answer' }]);
  });
  it('withholds every extraction-redacted body including fixed-response legacy rows', async () => {
    await accepted('turn'); await repo.redactTurnMessages(ctx, 'turn');
    const result = await page();
    expect(result.items[0]?.messages.every(message => message.visibility === 'withheld' && message.content === null && message.readOnly)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('answer turn');
  });
  it('withholds existing legacy bodies when a retained withdrawal marker predates durable version marking', async () => {
    await repo.createTurnWithOutbox(ctx, { id: 'legacy', sessionId: 'session', idempotencyKey: 'legacy', status: 'Completed' }, { id: 'legacy-user', content: 'withdrawn canary' });
    await database.client.execute({ sql: "INSERT INTO turn_stream_events(id, turn_id, sequence, event_type, data, occurred_at) VALUES (?, ?, 1, 'redacted', '{}', ?)", args: ['old-marker', 'legacy', new Date().toISOString()] });
    expect((await page()).items[0]?.messages[0]).toMatchObject({ visibility: 'withheld', content: null });
    expect(JSON.stringify(await page())).not.toContain('withdrawn canary');
    expect((await database.client.execute("SELECT is_redacted FROM message_versions WHERE id = 'legacy-user'")).rows[0]?.is_redacted).toBe(0);
  });
  it('enforces message count and NUL-safe body bytes without returning a partial successful Turn', async () => {
    await accepted('large', 'Completed', 'session', '\0' + 'x'.repeat(256 * 1024));
    await expect(page()).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
    await repo.redactTurnMessages(ctx, 'large');
    expect((await page()).items[0]?.messages.every(message => message.content === null)).toBe(true);
    const imported = await repo.importSession(ctx, { messages: [{ role: 'user', content: 'count' }, ...Array.from({ length: 100 }, () => ({ role: 'assistant' as const, content: 'message' }))] });
    await expect(page({}, imported.session.id)).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
  });
  it('applies the complete-page byte budget and lets the caller explicitly reduce limit', async () => {
    for (const id of ['first', 'second', 'third']) await accepted(id, 'Completed', 'session', '中'.repeat(62_000));
    await expect(page({ limit: 3 })).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
    const smaller = await page({ limit: 2 });
    expect(smaller.items).toHaveLength(2); expect(smaller.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(smaller))).toBeLessThanOrEqual(512 * 1024);
    await database.client.execute("UPDATE turns SET dispatch_target = 'api' WHERE id = 'second'");
    await expect(page({ cursor: cursor('session', 'second') })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_EXPIRED' });
    expect((await page()).items.map(turn => turn.turnId)).toEqual(['first', 'third']);
  });
  it('includes IDs and metadata in the Turn budget without truncating unknown legacy identities', async () => {
    const id = 'long-' + 'x'.repeat(4096);
    await repo.createTurnWithOutbox(ctx, { id, sessionId: 'session', idempotencyKey: id, status: 'Completed' }, { id: 'long-user', content: 'body' });
    await expect(page()).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
    await database.client.execute({ sql: 'DELETE FROM turns WHERE id = ?', args: [id] });
    await accepted('normal');
    await database.client.execute({ sql: 'UPDATE message_versions SET created_at = ? WHERE id = ?', args: ['m'.repeat(256 * 1024), 'user-normal'] });
    await expect(page()).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
  });
  it('does not use a dangling current input pointer or a forged assistant pointer', async () => {
    await accepted('turn');
    await database.client.execute("UPDATE messages SET current_version_id = 'missing' WHERE id = 'user-turn'");
    expect((await page()).items).toEqual([]);
    await database.client.execute("UPDATE messages SET current_version_id = 'user-turn' WHERE id = 'user-turn'");
    await database.client.execute("UPDATE messages SET current_version_id = 'user-turn' WHERE id = 'assistant-turn'");
    expect((await page()).items[0]?.messages).toMatchObject([{ messageId: 'user-turn', content: 'input turn' }]);
    expect((await page()).items[0]?.messages).toHaveLength(1);
  });
  it('rejects a cursor whose JSON escaping exceeds the declared token budget', async () => {
    await accepted('older');
    const id = 'turn-' + '\0'.repeat(3000);
    await repo.createTurnWithOutbox(ctx, { id, sessionId: 'session', idempotencyKey: id, status: 'Completed' }, { id: 'long-cursor-user', content: 'body' });
    await expect(page({ limit: 1 })).rejects.toMatchObject({ code: 'HISTORY_ITEM_TOO_LARGE' });
  });
  it('preserves embedded NUL identities and content across cursors and SQL projections', async () => {
    const sessionId = 'session\0tail'; await repo.getOrCreateSession(ctx, sessionId);
    await accepted('first\0tail', 'Completed', sessionId, 'answer\0tail'); await accepted('last\0tail', 'Completed', sessionId);
    const first = await page({ limit: 1 }, sessionId);
    const older = await page({ limit: 1, cursor: first.nextCursor! }, sessionId);
    expect(older.sessionId).toBe(sessionId); expect(older.items[0]?.turnId).toBe('first\0tail');
    expect(older.items[0]?.messages[1]).toMatchObject({ messageId: 'assistant-first\0tail', content: 'answer\0tail' });
  });
});
