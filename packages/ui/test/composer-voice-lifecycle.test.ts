import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { configureAervoxClient } from '@aervox/api-client';
import { useWorkbenchComposer } from '../src/composables/useWorkbenchComposer';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['keyboard', 'enter', 'second-click', 'collapse', 'dispose'])('cancels pending permission on %s', async action => {
  let grant!: (stream: MediaStream) => void;
  const stop = vi.fn();
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(resolve => { grant = resolve; }));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', class {
    state = 'running'; destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
    async close() {}
  });
  configureAervoxClient({ transport: { request: vi.fn(async () => ({ vadSilenceThresholdMs: 700 })), streamTurn: vi.fn() } });
  const scope = effectScope();
  const composer = scope.run(() => useWorkbenchComposer({ onSendMessage: vi.fn(), streaming: ref(false), fullAccessDialogOpen: ref(false) }))!;
  try {
    const started = composer.toggleVoiceInput();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    if (action === 'keyboard') composer.handleComposerInputOrKey();
    else if (action === 'enter') composer.handleComposerEnter({ preventDefault() {} } as KeyboardEvent);
    else if (action === 'collapse') composer.collapseComposer();
    else if (action === 'dispose') scope.stop();
    else await composer.toggleVoiceInput();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await started;
    expect(composer.voiceInput.isListening.value).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  } finally { scope.stop(); }
});

it.each(['keyboard', 'enter', 'second-click', 'collapse', 'dispose'])('cancels configuration fetch on %s', async action => {
  let resolveConfig!: (value: unknown) => void;
  let configSignal: AbortSignal | undefined;
  const getUserMedia = vi.fn();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  configureAervoxClient({ transport: {
    request: vi.fn((_method, _path, _body, options) => {
      configSignal = options?.signal;
      return new Promise(resolve => { resolveConfig = resolve; });
    }), streamTurn: vi.fn(),
  } });
  const scope = effectScope();
  const composer = scope.run(() => useWorkbenchComposer({ onSendMessage: vi.fn(), streaming: ref(false), fullAccessDialogOpen: ref(false) }))!;
  try {
    const started = composer.toggleVoiceInput();
    if (action === 'keyboard') composer.handleComposerInputOrKey();
    else if (action === 'enter') composer.handleComposerEnter({ preventDefault() {} } as KeyboardEvent);
    else if (action === 'collapse') composer.collapseComposer();
    else if (action === 'dispose') scope.stop();
    else await composer.toggleVoiceInput();
    expect(configSignal?.aborted).toBe(true);
    resolveConfig({ vadSilenceThresholdMs: 700 });
    await started;
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(composer.voiceInputStarting.value).toBe(false);
    expect(composer.voiceInputError.value).toBeNull();
  } finally { scope.stop(); }
});

it('ignores stale config rejection without clearing a new start', async () => {
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  configureAervoxClient({ transport: {
    request: vi.fn(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
    streamTurn: vi.fn(),
  } });
  const scope = effectScope();
  const composer = scope.run(() => useWorkbenchComposer({ onSendMessage: vi.fn(), streaming: ref(false), fullAccessDialogOpen: ref(false) }))!;
  try {
    const first = composer.toggleVoiceInput();
    composer.handleComposerInputOrKey();
    const second = composer.toggleVoiceInput();
    pending[0]!.reject(new Error('stale error'));
    await first;
    expect(composer.voiceInputStarting.value).toBe(true);
    expect(composer.voiceInputError.value).toBeNull();
    scope.stop();
    pending[1]!.resolve({ vadSilenceThresholdMs: 700 });
    await second;
    expect(composer.voiceInputStarting.value).toBe(false);
  } finally { scope.stop(); }
});
