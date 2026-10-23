import { describe, expect, it, vi } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport.js';
import { useAervoxMcp } from '../src/useAervoxMcp.js';
import { useAervoxVoice } from '../src/useAervoxVoice.js';
import { useAervoxVoiceInput } from '../src/useAervoxVoiceInput.js';
import { useAervoxModelRuntime } from '../src/useAervoxModelRuntime.js';

describe('shared wire schemas', () => {
  it('rejects a widened MCP status and does not replace valid state with it', async () => {
    const server = { id: 's', name: 'S', transport: 'streamable_http', endpointUrl: 'https://example.test', authType: 'none', enabled: true, isPreset: false, status: 'connected', toolCount: 0, tokenConfigured: false, lastSyncAt: null, lastError: null, createdAt: '', updatedAt: '' };
    const request = vi.fn().mockResolvedValueOnce({ servers: [server] }).mockResolvedValueOnce({ servers: [{ ...server, status: 'unexpected' }] });
    configureAervoxClient({ transport: { request } as AervoxTransport });
    const api = useAervoxMcp();
    await api.loadServers();
    await expect(api.loadServers()).rejects.toThrow();
    expect(api.servers.value).toEqual([server]);
  });

  it('uses the same ASR enum in presets and input configuration, including defaults', async () => {
    const request = vi.fn().mockResolvedValueOnce({ enabled: true, engineType: 'sensevoice-local', modelId: 'model' })
      .mockResolvedValueOnce({ enabled: true, engineType: 'other', modelId: 'model' })
      .mockResolvedValueOnce({ presets: [{ id: 'p', name: 'P', isActive: true, local: null, remote: null, input: { enabled: true, engineType: 'other', modelId: 'model' } }], activeId: 'p' });
    configureAervoxClient({ transport: { request } as AervoxTransport });
    const api = useAervoxVoiceInput();
    expect(await api.getInputConfig()).toMatchObject({ autoStopOnKeyboard: true, vadSilenceThresholdMs: 700, settings: {} });
    await expect(api.getInputConfig()).rejects.toThrow();
    await expect(useAervoxVoice().listPresets()).rejects.toThrow();
  });

  it('reports a malformed runtime snapshot rather than trusting an event cast', async () => {
    const error = vi.fn();
    configureAervoxClient({ transport: { streamEvents: async (_path, callbacks) => callbacks.onEvent({ event: 'snapshot', data: { models: [], runtime: { status: 'impossible' } } }) } as AervoxTransport });
    const snapshot = vi.fn();
    const stop = useAervoxModelRuntime().subscribeState(snapshot, error);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(snapshot).not.toHaveBeenCalled();
    stop();
  });
});
