import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { apiProblemSchema, modelRuntimeApi } from '@aervox/contracts';
import { registerContractRoute } from '@aervox/host-runtime/shared/contract-route';
import { registerProblemDetails } from '@aervox/host-runtime/shared/problem-details';
import { registerModelRuntimeRoutes } from '@aervox/host-runtime-test/modules/ecosystem/model-runtime/routes';
import type { ModelRuntimeService } from '@aervox/host-runtime-test/modules/ecosystem/model-runtime/service';
import { registerMemoryRoutes } from '@aervox/host-runtime-test/modules/companion/memory/routes';
import type { SqliteMemoryRepository } from '@aervox/repositories';

describe('shared endpoint registration', () => {
  it('rejects malformed memory nodes before reaching persistence', async () => {
    const app = Fastify();
    registerProblemDetails(app);
    const createNode = vi.fn();
    registerMemoryRoutes(app, { createNode } as unknown as SqliteMemoryRepository);
    try {
      for (const payload of [{ label: 42 }, { label: '   ' }, { label: 'valid', confidence: 'high' }]) {
        const response = await app.inject({ method: 'POST', url: '/v1/memory/nodes', payload });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      }
      expect(createNode).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('rejects an invalid download before effects and applies the shared defaults to valid input', async () => {
    const app = Fastify();
    registerProblemDetails(app);
    const state = { models: [], runtime: { status: 'idle' } };
    const startDownload = vi.fn(async () => state);
    registerModelRuntimeRoutes(app, { getState: async () => state, getCatalog: () => [], startDownload } as unknown as ModelRuntimeService);
    try {
      const invalid = await app.inject({ method: 'POST', url: modelRuntimeApi.download.path, payload: { url: 'https://example.test/a.gguf', fileName: '../escape.gguf' } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ status: 400, code: 'INVALID_MODEL_DOWNLOAD_REQUEST' });
      expect(apiProblemSchema.safeParse(invalid.json()).success).toBe(true);
      expect(startDownload).not.toHaveBeenCalled();
      const valid = await app.inject({ method: 'POST', url: modelRuntimeApi.download.path, payload: { url: 'https://example.test/a.gguf' } });
      expect(valid.statusCode).toBe(200);
      expect(startDownload).toHaveBeenCalledWith({ url: 'https://example.test/a.gguf', autoStart: false });
      expect(valid.json()).toMatchObject({ downloads: [], llamaServer: { configured: false } });
    } finally { await app.close(); }
  });

  it('detects a malformed service response and does not publish its payload', async () => {
    const app = Fastify();
    registerProblemDetails(app);
    registerContractRoute(app, modelRuntimeApi.state, async () => ({ privateState: 'secret' }));
    try {
      const response = await app.inject({ method: 'GET', url: modelRuntimeApi.state.path });
      expect(response.statusCode).toBe(500);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.payload).not.toContain('secret');
    } finally { await app.close(); }
  });

  it('normalizes direct JSON errors while leaving successful snapshots and non-JSON bodies intact', async () => {
    const app = Fastify();
    registerProblemDetails(app);
    app.get('/legacy', async (_request, reply) => reply.code(409).send({ error: 'busy', details: { item: 'm' } }));
    app.get('/snapshot', async () => ({ error: 'provider unavailable', status: 'idle' }));
    app.get('/text', async (_request, reply) => reply.code(503).type('text/plain').send('unavailable'));
    app.get('/internal', async (_request, reply) => reply.code(500).send({ error: 'private-secret', details: 'private-stack' }));
    try {
      const response = await app.inject({ method: 'GET', url: '/legacy?private=value' });
      expect(apiProblemSchema.parse(response.json())).toMatchObject({ status: 409, code: 'HTTP_409', error: 'busy', message: 'busy', details: { item: 'm' }, requestId: expect.any(String) });
      expect(response.payload).not.toContain('private=value');
      const snapshot = await app.inject({ method: 'GET', url: '/snapshot' });
      expect(snapshot.json()).toEqual({ error: 'provider unavailable', status: 'idle' });
      const plain = await app.inject({ method: 'GET', url: '/text' });
      expect(plain.payload).toBe('unavailable');
      expect(plain.headers['content-type']).toContain('text/plain');
      const internal = await app.inject({ method: 'GET', url: '/internal' });
      expect(internal.json()).toMatchObject({ status: 500, code: 'INTERNAL_ERROR', message: 'Internal Server Error' });
      expect(internal.payload).not.toContain('private-');
    } finally { await app.close(); }
  });
});
