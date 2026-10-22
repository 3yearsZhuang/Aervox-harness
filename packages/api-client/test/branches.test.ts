import { describe, expect, it, vi } from 'vitest';
import { AervoxHttpError, type AervoxTransport } from '../src/transport.js';
import { useAervoxBranches } from '../src/useAervoxBranches.js';

function transport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
  return { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
}
const branch = { id: 'br', parentSessionId: 'parent', childSessionId: 'child', title: null, branchReason: null, forkAtMessageId: null, status: 'active', layoutData: null, mergedAt: null, deletedAt: null, createdAt: 'now', updatedAt: 'now' };

describe('branch shared client', () => {
  it('encodes identifiers and preserves the eight operations, opaque layouts and deletion record', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = useAervoxBranches(transport(async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === 'GET' && path.startsWith('/v1/sessions/')) return { items: [branch] };
      if (method === 'DELETE') return { ...branch, status: 'deleted', deletedAt: 'later' };
      return branch;
    }));
    expect(await api.createBranch('a/b?c#d', { childSessionId: 'child' })).toEqual(branch);
    expect(await api.listBranches('parent')).toEqual([branch]);
    expect(await api.getBranchTree('parent')).toEqual([branch]);
    expect(await api.getBranch('a/b?c#d')).toEqual(branch);
    expect(await api.mergeBranch('br')).toEqual(branch);
    expect(await api.archiveBranch('br')).toEqual(branch);
    expect(await api.updateBranchLayout('br', null)).toEqual(branch);
    expect(await api.deleteBranch('br')).toMatchObject({ status: 'deleted', deletedAt: 'later' });
    expect(calls).toEqual([
      ['POST', '/v1/sessions/a%2Fb%3Fc%23d/branches', { childSessionId: 'child' }],
      ['GET', '/v1/sessions/parent/branches', undefined], ['GET', '/v1/sessions/parent/branch-tree', undefined],
      ['GET', '/v1/branches/a%2Fb%3Fc%23d', undefined], ['POST', '/v1/branches/br/merge', undefined],
      ['POST', '/v1/branches/br/archive', undefined], ['PATCH', '/v1/branches/br/layout', { layoutData: null }],
      ['DELETE', '/v1/branches/br', undefined],
    ]);
  });

  it('rejects malformed requests before transport and malformed success responses after transport', async () => {
    let response: unknown = {};
    const request = vi.fn(async () => response);
    const api = useAervoxBranches(transport(request));
    await expect(api.createBranch('parent', { childSessionId: 1 } as never)).rejects.toThrow();
    await expect(api.getBranch('')).rejects.toThrow();
    await expect(api.updateBranchLayout('br', undefined)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(api.listBranches('parent')).rejects.toThrow();
    await expect(api.getBranchTree('parent')).rejects.toThrow();
    response = { ...branch, status: 1 };
    await expect(api.getBranch('br')).rejects.toThrow();
    response = undefined;
    await expect(api.deleteBranch('br')).rejects.toThrow();
  });

  it('propagates the explicit tree limit failure without retrying a successful subset', async () => {
    const failure = new AervoxHttpError(422, 'branch_tree_limit_exceeded', { code: 'branch_tree_limit_exceeded' });
    const request = vi.fn(async () => { throw failure; });
    const api = useAervoxBranches(transport(request));
    await expect(api.getBranchTree('parent')).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
