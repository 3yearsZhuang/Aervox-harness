import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport, type AervoxTransport, type TurnCallbacks } from '@aervox/api-client/transport';
import { desktopTransport } from '../../../packages/api-client/src/desktop-transport';
import { createDesktopTurnBridge } from '../src/main/turn-bridge';
import { rendererEntryArgument } from '../src/shared/renderer-trust';

const ipc = vi.hoisted(() => ({on: vi.fn(), removeListener: vi.fn(), send: vi.fn(), invoke: vi.fn()}));
const exposed = vi.hoisted(() => ({exposeInMainWorld: vi.fn()}));
vi.mock('electron', () => ({ipcRenderer: ipc, contextBridge: exposed}));
const originalArgv = process.argv;
const originalMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame');
afterEach(() => {
  process.argv = originalArgv;
  if (originalMainFrame) Object.defineProperty(process, 'isMainFrame', originalMainFrame);
  else Reflect.deleteProperty(process, 'isMainFrame');
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

async function fullIpc(): Promise<AervoxTransport> {
  const renderer = new EventEmitter();
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, message: unknown) => renderer.emit(channel, {}, message),
  });
  const main = createDesktopTurnBridge({apiBaseUrl: 'http://api.test', authToken: () => 'secret', requireAcknowledgement: true});
  ipc.on.mockImplementation((channel, callback) => renderer.on(channel, callback));
  ipc.removeListener.mockImplementation((channel, callback) => renderer.removeListener(channel, callback));
  ipc.send.mockImplementation((channel, payload) => {
    if (channel === 'aervox:turn:start') void main.streamAervoxTurn({sender}, payload);
    else if (channel === 'aervox:turn:observe') void main.observeAervoxTurn({sender}, payload);
    else if (channel === 'aervox:turn:ack') main.acknowledge(sender, payload);
    else if (channel === 'aervox:turn:cancel') main.cancelTurn(sender, payload);
  });
  const entry = 'file:///Applications/Aervox.app/Contents/Resources/app.asar/out/renderer/index.html';
  process.argv = ['electron', rendererEntryArgument(entry)];
  Object.defineProperty(process, 'isMainFrame', {value: true, configurable: true});
  vi.stubGlobal('location', {href: entry});
  vi.stubGlobal('window', {});
  exposed.exposeInMainWorld.mockImplementation((name: string, value: unknown) => {
    Object.assign(window, {[name]: value});
  });
  vi.resetModules();
  await import('../src/preload/index');
  expect(window.fairyDesktop?.observeTurn).toBeTypeOf('function');
  return desktopTransport;
}
const frame = (sequence: number, eventType: string, text?: string) => `data: ${JSON.stringify({eventId: `event_${sequence}`, turnId: 'turn', sequence, eventType, data: {text}})}\n\n`;

for (const [name, create] of [
  ['fetch', () => createFetchTransport('http://api.test', {headers: {Authorization: 'Bearer secret'}})],
  ['full IPC', fullIpc],
] as const) describe(`${name} Turn contract`, () => {
  it('preserves credentials, caller idempotency, acceptance and asynchronous ordered events', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({turnId: 'turn'}))
      .mockResolvedValueOnce(new Response(frame(1, 'delta', 'one')))
      .mockResolvedValueOnce(new Response(frame(1, 'delta', 'duplicate') + frame(2, 'delta', 'two') + frame(3, 'done')));
    vi.stubGlobal('fetch', fetch);
    const order: string[] = [];
    const transport = await create();
    await transport.streamTurn('session', 'hello', {
      onDelta(text) { order.push(text); }, onDone() { order.push('done'); },
      async onEvent(event) { await Promise.resolve(); order.push(`handled_${event.sequence}`); },
    }, {idempotencyKey: 'business_key', async onAccepted(id) { await Promise.resolve(); order.push(`accepted_${id}`); }});
    expect(order).toEqual(['accepted_turn', 'one', 'handled_1', 'two', 'handled_2', 'done', 'handled_3']);
    expect(fetch.mock.calls).toHaveLength(3);
    expect(fetch.mock.calls[0]![1].headers['Idempotency-Key']).toBe('business_key');
    expect(fetch.mock.calls.every(([, init]) => init.headers.Authorization === 'Bearer secret')).toBe(true);
    expect(fetch.mock.calls[2]![1].headers['Last-Event-ID']).toBe('event_1');
    expect(fetch.mock.calls[0]![0]).toBe('http://api.test/v1/sessions/session/turns');
  });

  it('does not read or dispatch another event while the consumer is blocked', async () => {
    let release!: () => void;
    const consumed = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({turnId: 'turn'}))
      .mockResolvedValueOnce(new Response(frame(1, 'delta', 'one') + frame(2, 'done'))));
    const done = vi.fn(); const delta = vi.fn();
    const pending = (await create()).streamTurn('session', 'hello', {onDelta: delta, onDone: done, onEvent: event => event.sequence === 1 ? consumed : undefined});
    await vi.waitFor(() => expect(delta).toHaveBeenCalledOnce());
    expect(done).not.toHaveBeenCalled();
    release(); await pending;
    expect(done).toHaveBeenCalledOnce();
  });

  it('rejects early EOF after bounded reconnects without creating another Turn', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({turnId: 'turn'}))
      .mockImplementation(async () => new Response(''));
    vi.stubGlobal('fetch', fetch);
    await expect((await create()).streamTurn('session', 'hello', {onDelta() {}, onDone() {}})).rejects.toThrow('turn_stream_incomplete');
    expect(fetch.mock.calls).toHaveLength(4);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('reconnects continuation with matching query and header cursors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(frame(12, 'delta', 'one')))
      .mockResolvedValueOnce(new Response(frame(13, 'done')));
    vi.stubGlobal('fetch', fetch);
    await (await create()).observeTurn!('turn', {onDelta() {}, onDone() {}}, {afterEventId: 'decision'});
    expect(fetch.mock.calls[1]![0]).toBe('http://api.test/v1/turns/turn/events?after=event_12');
    expect(fetch.mock.calls[1]![1].headers['Last-Event-ID']).toBe('event_12');
  });

  it('observes an existing attempt from its cursor without submission', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(frame(12, 'delta', 'continued') + frame(13, 'done')));
    vi.stubGlobal('fetch', fetch);
    const onDelta = vi.fn();
    await (await create()).observeTurn!('turn', {onDelta, onDone() {}}, {afterEventId: 'decision'});
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('continued');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://api.test/v1/turns/turn/events?after=decision', expect.objectContaining({headers: expect.objectContaining({'Last-Event-ID': 'decision'})}));
  });
});
