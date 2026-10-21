import { describe, expect, it, vi } from 'vitest';
import type { AervoxTransport } from '../src/transport.js';
import { useAervoxPreferences } from '../src/useAervoxPreferences.js';
import { useAervoxPrivacy } from '../src/useAervoxPrivacy.js';
import { requestEndpoint } from '../src/endpoint.js';
import { privacyApi } from '@aervox/contracts';

function transport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
  return { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
}
const defaults = { id: null, tone: 'neutral', proactiveness: 'medium', addressForm: 'none', reminderCadence: 'moderate', version: 0, skipped: false };
const stored = { ...defaults, id: 'local', version: 1, createdAt: 'now', updatedAt: 'now' };
const grant = { id: 'grant', actorId: 'local', purpose: 'memory_long', scope: 'local', policyVersion: '1', grantedAt: 'now', createdAt: 'now', revokedAt: null };

describe('privacy/preferences shared clients', () => {
  it('encodes query/path values once and preserves an omitted consent query', async () => {
    const calls: string[] = [];
    const api = useAervoxPrivacy(transport(async (_method, path) => {
      calls.push(path);
      return path.includes('/revoke') ? grant : { active: false };
    }));
    await api.getActiveConsent();
    await api.getActiveConsent({ purpose: 'memory & local', scope: 'a/b?c#d' });
    await api.revokeConsent('a/b?c#d');
    expect(calls).toEqual(['/v1/consent', '/v1/consent?purpose=memory+%26+local&scope=a%2Fb%3Fc%23d', '/v1/consent/a%2Fb%3Fc%23d/revoke']);
  });

  it('rejects invalid inputs before transport and rejects malformed remote responses', async () => {
    const request = vi.fn(async () => ({}));
    const connection = transport(request);
    const prefs = useAervoxPreferences(connection);
    const privacy = useAervoxPrivacy(connection);
    await expect(prefs.save({ tone: 'invalid' } as never)).rejects.toThrow();
    await expect(privacy.grantConsent({ purpose: '', scope: 'local', policyVersion: '1' })).rejects.toThrow();
    await expect(privacy.createDeletion({ scope: 'memory', ownerModule: 'memory', targets: [] })).rejects.toThrow();
    await expect(requestEndpoint(connection, privacyApi.activeConsent, undefined, undefined, { scope: 42 } as never)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(prefs.get()).rejects.toThrow();
    await expect(privacy.getActiveConsent()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps preference defaults, versions and each write payload on the shared descriptors', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = useAervoxPreferences(transport(async (method, path, body) => {
      calls.push([method, path, body]);
      return method === 'GET' ? defaults : stored;
    }));
    expect(await api.get()).toEqual(defaults);
    expect(await api.save({ skipped: true })).toEqual(stored);
    await api.update({ tone: 'friendly' });
    await api.reset();
    expect(calls).toEqual([
      ['GET', '/v1/preferences', undefined], ['POST', '/v1/preferences', { skipped: true }],
      ['PATCH', '/v1/preferences', { tone: 'friendly' }], ['POST', '/v1/preferences/reset', undefined],
    ]);
  });

  it('validates consent and deletion results without marking accepted deletion as completion', async () => {
    const deletion = { id: 'request', scope: 'memory', ownerModule: 'memory', idempotencyKey: 'key', requestedAt: 'now', status: 'pending', attemptCount: 0, createdAt: 'now', updatedAt: 'now' };
    const input = { scope: 'memory', ownerModule: 'memory', idempotencyKey: 'key' };
    const request = vi.fn(async (_method: string, path: string) => path === '/v1/deletions' ? deletion : grant);
    const api = useAervoxPrivacy(transport(request));
    expect(await api.grantConsent({ purpose: 'memory_long', scope: 'local', policyVersion: '1' })).toEqual(grant);
    expect(await api.createDeletion(input)).toEqual(deletion);
    expect(request).toHaveBeenLastCalledWith('POST', '/v1/deletions', input);
  });
});
