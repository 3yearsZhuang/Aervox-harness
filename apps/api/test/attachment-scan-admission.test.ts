import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInMemoryDatabase, DatabaseError, SqliteContentRepository, type AervoxDatabase } from '@aervox/repositories';
import type { Client } from '@libsql/client';
import { buildApp } from './app-fixture.js';
import { registerContentRoutes } from '@aervox/host-runtime-test/modules/knowledge/content/routes';
import { ContentParserRegistry, type ContentParserPort, type ParseContentResult } from '@aervox/host-runtime-test/modules/knowledge/content/parser-port';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const input = { objectKey: 'fixture.png', mediaType: 'image/png', size: 3, purpose: 'question' };
let db: AervoxDatabase, client: Client, cleanup: () => Promise<void>, root: string, app: FastifyInstance;
beforeEach(async () => {
  ({ db, client, cleanup } = await createInMemoryDatabase());
  root = await mkdtemp(path.join(tmpdir(), 'aervox-scan-admission-'));
});
afterEach(async () => { await app?.close(); await cleanup(); await rm(root, { recursive: true, force: true }); });
const count = async (table: string) => Number((await client.execute(`SELECT count(*) AS count FROM ${table}`)).rows[0]!.count);

describe('production attachment refusal before verified scan provenance', () => {
  it.each(['metadata', 'binary'])('keeps %s uploads pending on retry and denies all parsing paths', async kind => {
    ({ app } = await buildApp({ db, client, attachmentsRoot: root })); await app.ready();
    const upload = () => app.inject(kind === 'metadata'
      ? { method: 'POST', url: '/v1/attachments', payload: { ...input, idempotencyKey: 'upload-key' } }
      : { method: 'POST', url: '/v1/attachments/binary?fileName=fixture.png&mediaType=image%2Fpng&purpose=question&idempotencyKey=upload-key', headers: { 'content-type': 'image/png' }, payload: Buffer.from('png') });
    const first = await upload(); expect(first.statusCode).toBe(201); expect(first.json().scanStatus).toBe('pending');
    const retry = await upload(); expect(retry.statusCode).toBe(200); expect(retry.json().id).toBe(first.json().id); expect(retry.json().scanStatus).toBe('pending');
    for (const scanStatus of ['pending', 'clean', 'infected', 'error', 'unknown']) {
      await client.execute({ sql: 'UPDATE attachments SET scan_status = ? WHERE id = ?', args: [scanStatus, first.json().id] });
      for (const [method, operation, payload] of [
        ['POST', 'parse', {}], ['PATCH', 'parse/crop', { cropData: { x: 0, y: 0, width: 1, height: 1 } }],
        ['POST', 'parse/convert-text', { text: 'must not create an admitted derivative' }],
      ] as const) {
        const response = await app.inject({ method, url: `/v1/attachments/${first.json().id}/${operation}`, payload });
        expect(response.statusCode).toBe(403); expect(response.json().code).toBe('ATTACHMENT_SCAN_UNVERIFIED');
      }
    }
    expect(await count('attachment_parse_results')).toBe(0);
  });

  it.each(['pending', 'clean', 'infected', 'error', 'unknown', 'missing'])('refuses %s attachment references before Turn acceptance while preserving plain text', async scanStatus => {
    ({ app } = await buildApp({ db, client, attachmentsRoot: root })); await app.ready();
    if (scanStatus !== 'missing') await new SqliteContentRepository(db).createAttachment(ctx, { id: 'attachment', ...input, scanStatus });
    await app.inject({ method: 'POST', url: '/v1/sessions', payload: { id: 'session', title: 'isolated session' } });
    const response = await app.inject({ method: 'POST', url: '/v1/sessions/session/turns', headers: { 'idempotency-key': 'attachment-turn' }, payload: {
      clientVersion: 'test',
      message: { content: 'inspect', contentType: 'text', attachments: [{ attachmentId: 'attachment', name: 'fixture.png', mediaType: 'image/png' }] },
    } });
    expect(response.statusCode).toBe(403); expect(response.json().code).toBe('ATTACHMENT_SCAN_UNVERIFIED'); expect(response.json().retryable).toBe(false);
    expect(await count('turns')).toBe(0); expect(await count('turn_attempts')).toBe(0); expect(await count('outbox_events')).toBe(0);
    const text = await app.inject({ method: 'POST', url: '/v1/sessions/session/turns', headers: { 'idempotency-key': 'text-turn' }, payload: { clientVersion: 'test', message: { content: 'plain text remains available', contentType: 'text' } } });
    expect(text.statusCode).toBe(201);
  });
});

describe('explicit isolated parser port lifecycle', () => {
  async function fixture(parse: ContentParserPort['parse'], mediaType = 'image/png') {
    const repository = new SqliteContentRepository(db);
    await repository.createAttachment(ctx, { id: 'attachment', ...input, mediaType, scanStatus: 'clean' });
    app = Fastify();
    app.setErrorHandler((error, _req, reply) => reply.code(error instanceof DatabaseError ? error.domainCode === 'FORBIDDEN' ? 403 : 409 : 500).send({ code: error.message }));
    registerContentRoutes(app, repository, root, new ContentParserRegistry([{
      id: 'fixture-parser', name: 'Isolated test parser', supportedMediaTypes: ['image/png'], supports: type => type === 'image/png', parse,
    }]));
    await app.ready(); return repository;
  }

  it.each(['delete', 'scan-revocation'])('rejects late parser output after %s without committing or superseding derivatives', async action => {
    let resolve!: (result: ParseContentResult) => void;
    const parse = vi.fn(() => new Promise<ParseContentResult>(done => { resolve = done; }));
    const repository = await fixture(parse);
    await repository.createParseResult(ctx, { id: 'old-result', attachmentId: 'attachment', parsedText: 'old safe fixture', parseStatus: 'completed' });
    const pending = app.inject({ method: 'POST', url: '/v1/attachments/attachment/parse', payload: { idempotencyKey: 'late-key' } });
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    if (action === 'delete') {
      const deletion = await app.inject({ method: 'DELETE', url: '/v1/attachments/attachment' });
      expect(deletion.statusCode).toBe(200); expect(deletion.json().invalidatedDerivatives).toBe(1);
    } else await client.execute("UPDATE attachments SET scan_status = 'error' WHERE id = 'attachment'");
    resolve({ text: 'late sensitive derivative', confidence: 0.95 });
    const response = await pending; expect(response.statusCode).toBe(403);
    expect(await count('attachment_parse_results')).toBe(1);
    expect(await repository.getActiveParseResult(ctx, 'attachment')).toBeNull();
    const result = (await client.execute("SELECT parsed_text, superseded_at FROM attachment_parse_results WHERE id = 'old-result'")).rows[0]!;
    expect(result.parsed_text).toBe('old safe fixture');
    if (action === 'scan-revocation') expect(result.superseded_at).toBeNull();
  });

  it('rejects unsupported media without calling a default parser', async () => {
    const parse = vi.fn(async () => ({ text: 'wrong-media', confidence: 1 })); await fixture(parse, 'text/plain');
    const response = await app.inject({ method: 'POST', url: '/v1/attachments/attachment/parse', payload: {} });
    expect(response.statusCode).toBe(503); expect(response.json().code).toBe('CONTENT_PARSER_UNAVAILABLE'); expect(parse).not.toHaveBeenCalled();
  });

  it('preserves the last result on parser failure and hides provider diagnostics', async () => {
    const repository = await fixture(async () => { throw new Error('/private/provider-file secret-token'); });
    await repository.createParseResult(ctx, { id: 'old-result', attachmentId: 'attachment', parsedText: 'old fixture', parseStatus: 'completed' });
    const response = await app.inject({ method: 'POST', url: '/v1/attachments/attachment/parse', payload: {} });
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('CONTENT_PARSER_FAILED');
    expect(response.body).not.toContain('secret-token');
    expect((await repository.getActiveParseResult(ctx, 'attachment'))?.id).toBe('old-result');
  });

  it('rolls back replacement and parent status together when the parse insert fails', async () => {
    const repository = await fixture(async () => ({ text: 'replacement', confidence: 0.4 }));
    await repository.createParseResult(ctx, { id: 'old-result', attachmentId: 'attachment', parsedText: 'old fixture', parseStatus: 'completed' });
    await client.execute("CREATE TRIGGER fail_parse BEFORE INSERT ON attachment_parse_results BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END");
    const response = await app.inject({ method: 'POST', url: '/v1/attachments/attachment/parse', payload: {} });
    expect(response.statusCode).toBe(500);
    expect((await repository.getActiveParseResult(ctx, 'attachment'))?.id).toBe('old-result');
    expect((await repository.getAttachment(ctx, 'attachment'))?.parseStatus).toBe('completed');
  });

  it('rolls back the source deletion if derivative invalidation fails', async () => {
    const repository = await fixture(async () => ({ text: 'fixture', confidence: 0.95 }));
    await repository.createParseResult(ctx, { id: 'old-result', attachmentId: 'attachment', parsedText: 'old fixture', parseStatus: 'completed' });
    await client.execute("CREATE TRIGGER fail_invalidate BEFORE UPDATE OF superseded_at ON attachment_parse_results BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END");
    const response = await app.inject({ method: 'DELETE', url: '/v1/attachments/attachment' });
    expect(response.statusCode).toBe(500);
    expect(await repository.getAttachment(ctx, 'attachment')).not.toBeNull();
    expect((await repository.getActiveParseResult(ctx, 'attachment'))?.id).toBe('old-result');
  });

  it.each([NaN, Infinity, -1, 2])('does not publish an invalid parser confidence %s', async confidence => {
    await fixture(async () => ({ text: 'invalid result', confidence }));
    const response = await app.inject({ method: 'POST', url: '/v1/attachments/attachment/parse', payload: {} });
    expect(response.statusCode).toBe(502); expect(response.json().code).toBe('CONTENT_PARSER_INVALID_RESULT'); expect(await count('attachment_parse_results')).toBe(0);
  });
});
