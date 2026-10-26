import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelRuntimeApi, preferencesApi, privacyApi, pluginConfigApi, pluginsApi, skillsApi, branchesApi, feedbackApi, llmApi } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';
import { compareRouteCoverage, routeCoverageKey, type RouteCoverageException } from './helpers/openapi-coverage.js';

describe('OpenAPI route coverage ratchet', () => {
  it('accounts for every actual /v1 route and rejects new gaps or obsolete exceptions', async () => {
    const database = await createInMemoryDatabase();
    const built = await buildApp({ db: database.db, client: database.client });
    try {
      await built.app.ready();
      const baseline = JSON.parse(readFileSync(new URL('./fixtures/openapi-route-baseline.json', import.meta.url), 'utf8')) as { exceptions: RouteCoverageException[] };
      const routes = built.routeInventory;
      for (const endpoint of [...Object.values(modelRuntimeApi), ...Object.values(preferencesApi), ...Object.values(privacyApi), ...Object.values(pluginConfigApi), ...Object.values(pluginsApi), ...Object.values(skillsApi), ...Object.values(branchesApi), ...Object.values(feedbackApi), ...Object.values(llmApi)]) {
        expect(routes.map(route => routeCoverageKey(route.method, route.path))).toContain(routeCoverageKey(endpoint.method, endpoint.path));
      }
      // Plugin contracts belong to this Host, so compare its actual HTTP document.
      const document = await built.app.inject({ method: 'GET', url: '/openapi.json' });
      expect(document.statusCode).toBe(200);
      const result = compareRouteCoverage(routes, document.json(), baseline.exceptions);
      if (result.missing.length || result.stale.length || result.invalid.length) {
        throw new Error(`ROUTE_COVERAGE_GAPS=${JSON.stringify(result)}`);
      }
    } finally { await built.app.close(); await database.cleanup(); }
  });

  it('fails a newly registered endpoint, a documented exception and a removed route', () => {
    const exception = { method: 'GET', path: '/v1/legacy/:id', module: 'fixture', reason: 'Existing contract migration' };
    const routes = [{ method: 'GET', path: '/v1/legacy/:id' }, { method: 'POST', path: '/v1/new' }];
    const empty = { paths: {} };
    expect(compareRouteCoverage(routes, empty, [exception]).missing).toEqual(['POST /v1/new']);
    expect(compareRouteCoverage(routes, { paths: { '/v1/legacy/{legacyId}': { get: { responses: { 200: { description: 'ok' } } } } } }, [exception]).stale).toEqual(['GET /v1/legacy/{param}']);
    expect(compareRouteCoverage([], empty, [exception]).stale).toEqual(['GET /v1/legacy/{param}']);
    expect(compareRouteCoverage(routes, empty, [{ ...exception, reason: '' }]).invalid).toEqual(['GET /v1/legacy/{param}']);
  });
});
