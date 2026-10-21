import { describe, expect, it, vi } from 'vitest';
import { useAervoxTurnDiagnostics } from '../src/useAervoxTurnDiagnostics.js';
import { TurnStreamProjector } from '../src/projector.js';
import type { AervoxTransport } from '../src/transport.js';

describe('diagnostics client and reply identity', () => {
  it('encodes each path/query segment, rejects malformed responses and never offers a raw-content switch', async () => {
    const request = vi.fn(async () => ({}));
    const api = useAervoxTurnDiagnostics({ request } as unknown as AervoxTransport);
    await expect(api.get('t/a?b', 'at/?')).rejects.toThrow();
    expect(request).toHaveBeenCalledWith('GET', '/v1/turns/t%2Fa%3Fb/diagnostics?attemptId=at%2F%3F', undefined);
    request.mockClear();
    await expect(api.get('')).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  });
  it('delivers identity only once after accepting an ordered event, for both HTTP and IPC projectors', () => {
    const onTurnIdentified = vi.fn();
    const callbacks = { onTurnIdentified, onDelta: vi.fn(), onDone: vi.fn() };
    const projector = new TurnStreamProjector({ expectedTurnId: 'turn_actual', initialSequence: 2 });
    projector.project({ turnId: 'foreign', sequence: 3, eventType: 'delta' }, callbacks);
    projector.project({ turnId: 'turn_actual', sequence: 1, eventType: 'delta' }, callbacks);
    expect(onTurnIdentified).not.toHaveBeenCalled();
    projector.project({ turnId: 'turn_actual', sequence: 3, eventType: 'delta', data: { text: 'hello' } }, callbacks);
    projector.project({ turnId: 'turn_actual', sequence: 4, eventType: 'done' }, callbacks);
    projector.project({ turnId: 'turn_actual', sequence: 5, eventType: 'delta' }, callbacks);
    expect(onTurnIdentified).toHaveBeenCalledExactlyOnceWith('turn_actual');
  });
  it('rejects a different Turn or Attempt even when its response shape is valid and strips undeclared raw fields', async () => {
    const report = { turnId: 'turn_actual', sessionId: 'session', status: 'Completed', observedAt: 'now',
      selectedAttemptId: 'attempt', attempts: [], modelRuns: [], tools: [], approvals: [], terminationReason: null,
      truncated: { attempts: false, modelRuns: false, tools: false, approvals: false }, unavailable: [], rawPrompt: 'SECRET' };
    const request = vi.fn(async () => report);
    const api = useAervoxTurnDiagnostics({ request } as unknown as AervoxTransport);
    await expect(api.get('foreign_turn')).rejects.toThrow('diagnostics_identity_mismatch');
    await expect(api.get('turn_actual', 'foreign_attempt')).rejects.toThrow('diagnostics_identity_mismatch');
    expect(JSON.stringify(await api.get('turn_actual', 'attempt'))).not.toContain('SECRET');
  });
});
