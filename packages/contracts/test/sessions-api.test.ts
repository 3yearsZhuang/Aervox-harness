import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, sessionListQuerySchema, sessionsApi } from '../src/index.js';

describe('session read contract', () => {
  it('publishes bounded paging and a non-creating lookup', () => {
    const paths = buildOpenApiDocument().paths;
    for (const endpoint of Object.values(sessionsApi)) {
      const operation = paths?.[endpoint.path]?.get;
      expect(operation?.operationId).toBe(endpoint.operationId);
      expect(operation?.responses?.['401']).toBeDefined();
    }
    expect(paths?.[sessionsApi.get.path]?.get?.responses?.['404']).toBeDefined();
    expect(sessionListQuerySchema.parse({ limit: '100', offset: '100' })).toEqual({ limit: '100', offset: '100' });
    for (const query of [{limit:'0'}, {limit:'101'}, {limit:'01'}, {limit:['1','2']}, {offset:'-1'},
      {offset:'1.5'}, {offset:'1e3'}, {offset:'9007199254740992'}, {projectId:''}, {search:'title'}]) {
      expect(sessionListQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
