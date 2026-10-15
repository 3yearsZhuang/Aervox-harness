import { expect, it } from 'vitest';
import { registerPluginApiContribution } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';

it('HTTP OpenAPI follows contribution registration and disposal after the first response', async () => {
  const database = await createInMemoryDatabase();
  const { app } = await buildApp({ db: database.db, client: database.client });
  let dispose: (() => void) | undefined;
  try {
    const first = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(first.headers['cache-control']).toBe('private, no-store');
    expect(first.json().paths['/v1/cache-contract-probe']).toBeUndefined();
    dispose = registerPluginApiContribution({ openApiRoutes: [{ method: 'get', path: '/v1/cache-contract-probe', responses: { 200: { description: 'probe' } } }] });
    const registered = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(registered.json().paths['/v1/cache-contract-probe']).toBeDefined();
    dispose();
    const removed = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(removed.json().paths['/v1/cache-contract-probe']).toBeUndefined();
  } finally {
    dispose?.();
    await app.close();
    await database.cleanup();
  }
});
