import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiProblemSchema, preferencesApi, privacyApi } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';

describe('ITER-064 privacy and preferences contracts', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  const token = 'privacy-contract-test-token';
  const headers = { authorization: 'Bearer ' + token };

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    built = await buildApp({
      db: database.db, client: database.client,
      auth: { mode: 'token', token, actorId: 'configured-actor' },
    });
    await built.app.ready();
  });
  afterEach(async () => {
    await built.app.close();
    await database.cleanup();
  });

  it('requires the host token on all eight endpoints before accepting any payload', async () => {
    for (const endpoint of [...Object.values(privacyApi), ...Object.values(preferencesApi)]) {
      for (const authorization of [undefined, 'Bearer wrong-token']) {
        const response = await built.app.inject({
          method: endpoint.method.toUpperCase() as 'GET' | 'POST' | 'PATCH',
          url: endpoint.path.replace('{grantId}', 'missing'),
          headers: authorization ? { authorization } : {},
        });
        expect(response.statusCode).toBe(401);
        expect(apiProblemSchema.parse(response.json())).toMatchObject({ code: 'AUTH_UNAUTHORIZED', status: 401 });
      }
    }
    const rows = await database.client.execute('SELECT COUNT(*) AS n FROM consent_grants');
    expect(Number(rows.rows[0]!.n)).toBe(0);
  });

  it('rejects invalid consent/query/preferences before any durable mutation', async () => {
    for (const payload of [{ purpose: 42, scope: 'local', policyVersion: '1' }, { purpose: 'memory_long', scope: '', policyVersion: '1' }]) {
      const response = await built.app.inject({ method: 'POST', url: '/v1/consent', headers, payload });
      expect(response.statusCode).toBe(400);
      expect(apiProblemSchema.parse(response.json())).toMatchObject({ code: 'VALIDATION_FAILED', error: 'purpose, scope and policyVersion are required' });
    }
    const query = await built.app.inject({ method: 'GET', url: '/v1/consent?purpose=a&purpose=b&scope=local', headers });
    expect(query.statusCode).toBe(400);
    const invalidPrefs = await built.app.inject({ method: 'PATCH', url: '/v1/preferences', headers, payload: { tone: 'invalid' } });
    expect(invalidPrefs.statusCode).toBe(400);
    expect(apiProblemSchema.parse(invalidPrefs.json())).toMatchObject({ error: 'Validation failed' });
    const invalidDeletion = await built.app.inject({ method: 'POST', url: '/v1/deletions', headers, payload: {} });
    expect(invalidDeletion.statusCode).toBe(400);
    expect(apiProblemSchema.parse(invalidDeletion.json())).toMatchObject({ error: 'invalid deletion request' });
    const counts = await database.client.execute('SELECT (SELECT COUNT(*) FROM consent_grants) + (SELECT COUNT(*) FROM persona_preferences) + (SELECT COUNT(*) FROM deletion_requests) AS n');
    expect(Number(counts.rows[0]!.n)).toBe(0);
  });

  it('uses the authenticated audit actor and preserves missing-query and not-found semantics', async () => {
    const response = await built.app.inject({
      method: 'POST', url: '/v1/consent', headers: { ...headers, 'x-actor-id': 'header-forgery' },
      payload: { purpose: 'memory_long', scope: 'local', policyVersion: '1', actorId: 'body-forgery' },
    });
    expect(response.statusCode).toBe(201);
    expect(privacyApi.grantConsent.response.parse(response.json()).actorId).toBe('configured-actor');
    const stored = await database.client.execute('SELECT actor_id FROM consent_grants');
    expect(stored.rows[0]!.actor_id).toBe('configured-actor');
    for (const suffix of ['', '?purpose=memory_long', '?purpose=&scope=local']) {
      const query = await built.app.inject({ method: 'GET', url: '/v1/consent' + suffix, headers });
      expect(query.statusCode).toBe(200);
      expect(query.json()).toEqual({ active: false });
    }
    const missing = await built.app.inject({ method: 'POST', url: '/v1/consent/missing/revoke', headers });
    expect(missing.statusCode).toBe(404);
    expect(apiProblemSchema.parse(missing.json()).error).toBe('consent grant not found');
  });

  it('serves the legacy workflow over real HTTP with matching schemas, statuses and idempotency', async () => {
    const base = await built.app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method, headers: { ...headers, 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const defaults = await request('GET', '/v1/preferences');
    expect(defaults.status).toBe(200);
    expect(preferencesApi.get.response.parse(defaults.body)).toMatchObject({ id: null, version: 0 });
    const saved = await request('POST', '/v1/preferences', { skipped: true });
    expect(saved.status).toBe(201);
    expect(preferencesApi.save.response.parse(saved.body)).toMatchObject({ version: 1, skipped: true });
    const updated = await request('PATCH', '/v1/preferences', { tone: 'friendly' });
    expect(updated.status).toBe(200);
    expect(preferencesApi.update.response.parse(updated.body)).toMatchObject({ version: 2, tone: 'friendly' });
    const reset = await request('POST', '/v1/preferences/reset');
    expect(reset.status).toBe(200);
    expect(preferencesApi.reset.response.parse(reset.body)).toMatchObject({ version: 3, skipped: false, tone: 'neutral' });
    expect(await request('GET', '/v1/preferences')).toEqual(reset);
    const grant = await request('POST', '/v1/consent', { purpose: 'memory_long', scope: 'local', policyVersion: '1' });
    expect(grant.status).toBe(201);
    const consent = privacyApi.grantConsent.response.parse(grant.body);
    const query = '/v1/consent?purpose=memory_long&scope=local';
    expect(privacyApi.activeConsent.response.parse((await request('GET', query)).body)).toEqual({ purpose: 'memory_long', scope: 'local', active: true });
    const revoke = await request('POST', '/v1/consent/' + encodeURIComponent(consent.id) + '/revoke');
    expect(revoke.status).toBe(200);
    expect(privacyApi.revokeConsent.response.parse(revoke.body).revokedAt).toEqual(expect.any(String));
    expect(privacyApi.activeConsent.response.parse((await request('GET', query)).body).active).toBe(false);
    const input = { scope: 'memory', ownerModule: 'memory', idempotencyKey: 'contract-deletion', targets: [{ targetType: 'memory', targetId: 'target', ownerModule: 'memory' }] };
    const first = await request('POST', '/v1/deletions', input);
    const replay = await request('POST', '/v1/deletions', input);
    expect(first.status).toBe(202);
    expect(replay).toEqual(first);
    expect(privacyApi.createDeletion.response.parse(first.body)).toMatchObject({ status: 'pending', attemptCount: 0 });
  });
});
