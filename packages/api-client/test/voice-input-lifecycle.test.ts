import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { VoiceInputRecorder } from '../src/voice-input-recorder';
import { useAervoxVoiceInput } from '../src/useAervoxVoiceInput';
import { configureAervoxClient } from '../src/transport';

function audio() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: undefined as undefined | ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) };
  const close = vi.fn(async () => undefined);
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const AudioContext = vi.fn(function () {
    return { state: 'running', destination: {}, createMediaStreamSource: () => source, createScriptProcessor: () => processor, close };
  });
  vi.stubGlobal('window', { AudioContext });
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { stream, stop, processor, close, source, AudioContext, getUserMedia };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('recording ownership', () => {
  it('stops a late permission grant and allows a fresh start', async () => {
    const a = audio();
    let grant!: (stream: typeof a.stream) => void;
    a.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    const recorder = new VoiceInputRecorder();
    const pending = recorder.start();
    recorder.stop();
    grant(a.stream);
    await pending;
    expect(recorder.active).toBe(false);
    expect(a.stop).toHaveBeenCalledOnce();
    expect(a.AudioContext).not.toHaveBeenCalled();
    await recorder.start();
    expect(recorder.active).toBe(true);
    recorder.stop();
  });
  it('releases granted tracks when audio initialization fails', async () => {
    const a = audio();
    a.AudioContext.mockImplementationOnce(function () { throw new Error('audio unavailable'); });
    const recorder = new VoiceInputRecorder();
    await expect(recorder.start()).rejects.toThrow('audio unavailable');
    expect(a.stop).toHaveBeenCalledOnce();
    expect(recorder.active).toBe(false);
  });
  it('cleans every resource even when disconnect fails', async () => {
    const a = audio();
    const recorder = new VoiceInputRecorder();
    await recorder.start();
    a.processor.disconnect.mockImplementation(() => { throw new Error('disconnect'); });
    recorder.stop(false);
    expect(a.source.disconnect).toHaveBeenCalledOnce();
    expect(a.stop).toHaveBeenCalledOnce();
    expect(a.close).toHaveBeenCalledOnce();
  });
  it('scope disposal cancels in-flight transcription and suppresses late text', async () => {
    const a = audio();
    let resolve!: (value: { text: string }) => void;
    const request = vi.fn(() => new Promise(r => { resolve = r; }));
    configureAervoxClient({ transport: { request, streamTurn: vi.fn() } });
    const scope = effectScope();
    const voice = scope.run(() => useAervoxVoiceInput())!;
    const onText = vi.fn();
    await voice.startListening({ onText });
    const event = { inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.8) } };
    a.processor.onaudioprocess!(event);
    a.processor.onaudioprocess!(event);
    voice.stopListening();
    expect(request).toHaveBeenCalledOnce(); // User stop submits the last segment.
    const signal = request.mock.calls[0]![3].signal as AbortSignal;
    scope.stop();
    expect(signal.aborted).toBe(true);
    resolve({ text: 'late' });
    await Promise.resolve();
    await Promise.resolve();
    expect(onText).not.toHaveBeenCalled();
    expect(voice.isListening.value).toBe(false);
    expect(voice.isTranscribing.value).toBe(false);
  });
  it('scope disposal during permission request stops the late stream', async () => {
    const a = audio();
    let grant!: (stream: typeof a.stream) => void;
    a.getUserMedia.mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }));
    configureAervoxClient({ transport: { request: vi.fn(), streamTurn: vi.fn() } });
    const scope = effectScope();
    const voice = scope.run(() => useAervoxVoiceInput())!;
    const pending = voice.startListening({ onText: vi.fn() });
    scope.stop();
    grant(a.stream);
    await pending;
    expect(a.stop).toHaveBeenCalledOnce();
    expect(voice.isListening.value).toBe(false);
  });
});
