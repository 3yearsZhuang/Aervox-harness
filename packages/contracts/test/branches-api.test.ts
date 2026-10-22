import { describe, expect, it } from 'vitest';
import { branchesApi, buildOpenApiDocument } from '../src/index.js';

describe('branch shared contracts', () => {
  it('describes eight authenticated endpoints, required bodies, soft-delete 200 and explicit tree limits', () => {
    const paths = buildOpenApiDocument().paths!;
    expect(Object.values(branchesApi)).toHaveLength(8);
    for (const endpoint of Object.values(branchesApi)) {
      const operation = paths[endpoint.path]?.[endpoint.method];
      expect(operation?.operationId).toBe(endpoint.operationId);
      expect(operation?.responses?.['401']).toBeDefined();
      expect(operation?.responses?.['500']).toBeDefined();
    }
    for (const endpoint of [branchesApi.create, branchesApi.updateLayout]) {
      expect(paths[endpoint.path]?.[endpoint.method]?.requestBody).toMatchObject({ required: true });
    }
    expect(paths[branchesApi.updateLayout.path]?.patch?.requestBody).toMatchObject({
      content: { 'application/json': { schema: { required: ['layoutData'] } } },
    });
    expect(paths[branchesApi.tree.path]?.get?.responses?.['422']).toBeDefined();
    expect(paths[branchesApi.delete.path]?.delete?.responses?.['200']).toBeDefined();
    expect(paths[branchesApi.delete.path]?.delete?.responses?.['204']).toBeUndefined();
  });

  it('keeps opaque layouts, nullable historical row columns and distinct edge records', () => {
    const branch = { id: 'branch', parentSessionId: 'parent', childSessionId: 'child', status: 'legacy', branchReason: 'historical', forkAtMessageId: null, title: null, mergedAt: null, deletedAt: null, createdAt: 'now', updatedAt: 'now', layoutData: ['opaque', { nested: null }] };
    expect(branchesApi.get.response.parse(branch)).toEqual(branch);
    expect(branchesApi.list.response.parse({ items: [branch, { ...branch, id: 'another' }] }).items).toHaveLength(2);
    expect(branchesApi.updateLayout.body.safeParse({}).success).toBe(false);
    expect(branchesApi.updateLayout.body.safeParse({ layoutData: undefined }).success).toBe(false);
    for (const layoutData of [null, true, 1, 'text', [], { x: 'opaque' }]) {
      expect(branchesApi.updateLayout.body.parse({ layoutData })).toEqual({ layoutData });
    }
    expect(branchesApi.create.body.safeParse({ childSessionId: '' }).success).toBe(false);
    expect(branchesApi.create.body.safeParse({ childSessionId: 'child', branchReason: 'historical' }).success).toBe(false);
    expect(branchesApi.delete.response.safeParse(undefined).success).toBe(false);
  });
});
