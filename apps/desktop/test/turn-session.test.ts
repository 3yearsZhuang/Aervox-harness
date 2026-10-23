import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopTransport } from '@aervox/api-client';
import { aervoxApi } from '../src/preload/domains/aervox-api';
import { resolveTurnSessionId } from '../src/main/runtime-config';

const ipc = vi.hoisted(() => ({ on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('desktop session across transport and preload', () => {
  it('preserves two selected sessions through IPC instead of choosing the environment default', async () => {
    vi.stubGlobal('window', { fairyDesktop: aervoxApi });
    ipc.send.mockImplementation((_channel, payload) => {
      if (_channel !== 'aervox:turn:start') return;
      const listener = ipc.on.mock.calls.at(-1)![1];
      listener({}, { requestId: payload.requestId, type: 'event', event: {eventType: 'done', data: {}} });
      listener({}, { requestId: payload.requestId, type: 'closed' });
    });
    for (const session of ['ses_A', 'ses_B']) {
      await desktopTransport.streamTurn(session, 'hello', { onDelta() {}, onDone() {} });
    }
    const sessions = ipc.send.mock.calls.filter(([channel]) => channel === 'aervox:turn:start').map(([, payload]) => resolveTurnSessionId(payload.sessionId, 'environment_default'));
    expect(sessions).toEqual(['ses_A', 'ses_B']);
  });
  it.each(['', ' ', 3, null, 'x'.repeat(129)])('rejects an invalid explicit session %s', value => {
    expect(() => resolveTurnSessionId(value, 'fallback')).toThrow('invalid_session_id');
  });
  it('uses fallback only for an absent session', () => {
    expect(resolveTurnSessionId(undefined, 'environment_default')).toBe('environment_default');
    expect(resolveTurnSessionId(undefined)).toBe('desktop_default');
  });
});
