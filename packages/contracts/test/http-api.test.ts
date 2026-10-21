import { describe, expect, it } from 'vitest';
import { apiEndpointPath, apiProblemSchema, buildOpenApiDocument, modelRuntimeApi, preferencesApi, privacyApi } from '../src/index.js';

describe('HTTP contracts', () => {
  it('every operation has a unique stable id, structured errors and the actual authentication scheme', () => {
    const doc = buildOpenApiDocument();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    const ids: string[] = [];
    for (const item of Object.values(doc.paths ?? {})) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const operation = item?.[method];
        if (!operation) continue;
        expect(operation.operationId).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
        ids.push(operation.operationId!);
        for (const parameter of operation.parameters ?? []) {
          if ('$ref' in parameter) continue;
          expect(['x-workspace-id', 'x-user-id', 'x-actor-id']).not.toContain(parameter.name.toLowerCase());
        }
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (+status < 400 || '$ref' in response) continue;
          expect(response.content?.['application/problem+json']?.schema).toEqual({ $ref: '#/components/schemas/ApiProblem' });
        }
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildOpenApiDocument()).toBe(doc);
  });

  it('publishes the same model endpoints used by clients and their missing companion routes', () => {
    const paths = buildOpenApiDocument().paths!;
    for (const endpoint of Object.values(modelRuntimeApi)) {
      expect(paths[endpoint.path]?.[endpoint.method]?.operationId).toBe(endpoint.operationId);
    }
    expect(paths['/v1/memory/nodes']?.post?.requestBody).toBeDefined();
    expect(paths['/v1/model-runtime/events']?.get?.responses?.[200]).toBeDefined();
    for (const action of ['pause', 'resume', 'cancel']) {
      expect(paths[`/v1/model-runtime/downloads/{taskId}/${action}`]?.post?.responses?.[404]).toBeDefined();
    }
  });

  it('keeps legacy error extensions while requiring authoritative HTTP status and diagnostic fields', () => {
    const problem = { type: 'about:blank', title: 'Conflict', status: 409, detail: 'busy', code: 'DOWNLOAD_BUSY', message: 'busy', requestId: 'req-1', details: { modelId: 'm' } };
    expect(apiProblemSchema.parse(problem)).toEqual(problem);
    expect(apiProblemSchema.safeParse({ ...problem, status: 200 }).success).toBe(false);
  });

  it('describes the privacy and preferences boundaries including optional consent queries', () => {
    const paths = buildOpenApiDocument().paths!;
    for (const endpoint of [...Object.values(privacyApi), ...Object.values(preferencesApi)]) {
      const operation = paths[endpoint.path]?.[endpoint.method];
      expect(operation?.operationId).toBe(endpoint.operationId);
      expect(operation?.responses?.[endpoint.status ?? 200]).toBeDefined();
    }
    const query = paths['/v1/consent']?.get?.parameters;
    expect(query).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'purpose', in: 'query', required: false }),
      expect.objectContaining({ name: 'scope', in: 'query', required: false }),
    ]));
    expect(privacyApi.activeConsent.response.safeParse({ active: false }).success).toBe(true);
    expect(privacyApi.activeConsent.response.safeParse({ active: false, purpose: 42 }).success).toBe(false);
    expect(preferencesApi.get.response.safeParse({
      id: null, tone: 'neutral', proactiveness: 'medium', addressForm: 'none',
      reminderCadence: 'moderate', version: 0, skipped: false,
    }).success).toBe(true);
    expect(preferencesApi.save.response.safeParse({ id: null, version: 0 }).success).toBe(false);
  });

  it('encodes each path argument and rejects absent arguments before transport', () => {
    const endpoint = { path: '/v1/items/{id}' };
    expect(apiEndpointPath(endpoint, { id: 'a/b?c#d' })).toBe('/v1/items/a%2Fb%3Fc%23d');
    expect(() => apiEndpointPath(endpoint)).toThrow('missing_endpoint_parameter:id');
  });
});
