import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, skillsApi } from '../src/index.js';

describe('basic skill contracts', () => {
  it('describes all seven endpoints with stable IDs, required write bodies and an empty 204 deletion', () => {
    const paths = buildOpenApiDocument().paths!;
    for (const endpoint of Object.values(skillsApi)) {
      const operation = paths[endpoint.path]?.[endpoint.method];
      expect(operation?.operationId).toBe(endpoint.operationId);
      expect(operation?.responses?.['401']).toBeDefined();
      expect(operation?.responses?.['500']).toBeDefined();
    }
    for (const endpoint of [skillsApi.install, skillsApi.setActive]) {
      expect(paths[endpoint.path]?.[endpoint.method]?.requestBody).toMatchObject({ required: true });
    }
    expect(paths[skillsApi.delete.path]?.delete?.responses?.['204']).toEqual({ description: 'Success' });
    expect(paths[skillsApi.delete.path]?.delete?.responses?.['200']).toBeUndefined();
    expect(paths['/v1/skills']?.get?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'activeOnly', in: 'query', required: false }),
      expect.objectContaining({ name: 'source', in: 'query', required: false }),
    ]));
  });

  it('uses the local registry shape and rejects a workspace response, boolean flags or absent content description', () => {
    const row = { id: 'notes', name: 'notes', description: '', source: 'custom', active: 1, readonly: 0, version: '1.0.0', checksum: null, pluginId: null, contentPath: null, createdAt: 'now', updatedAt: 'now' };
    expect(skillsApi.list.response.parse({ items: [row] })).toEqual({ items: [row] });
    expect(skillsApi.list.response.safeParse({ skills: [row] }).success).toBe(false);
    expect(skillsApi.get.response.safeParse({ ...row, active: true }).success).toBe(false);
    expect(skillsApi.content.response.safeParse({ name: 'notes', content: '' }).success).toBe(false);
    expect(skillsApi.delete.response.safeParse(undefined).success).toBe(true);
    expect(skillsApi.delete.response.safeParse({}).success).toBe(false);
  });
});
