import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport, type AervoxTransport, type TurnCallbacks } from '@aervox/api-client/transport';
import { createConversationController } from '../../../packages/api-client/src/conversation-controller';
import { createDesktopApiRequest } from '../src/main/api-request';
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
  const apiRequest = createDesktopApiRequest({apiBaseUrl: 'http://api.test', authToken: () => 'secret'});
  ipc.invoke.mockImplementation((channel, payload) => {
    if (channel !== 'aervox:api:request') throw new Error(`unexpected_invoke:${channel}`);
    return apiRequest(payload);
  });
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
  it('runs approval POST through continuation observation with the same credentials and cursor', async () => {
    const approval = {approvalId:'approval',toolName:'write',argumentsHash:'hash'};
    const approvalFrame = `data: ${JSON.stringify({eventId:'pending',turnId:'turn',sequence:1,eventType:'tool_approval_required',data:approval})}\n\n`;
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({turnId:'turn'}))
      .mockResolvedValueOnce(new Response(approvalFrame + frame(2,'done')))
      .mockResolvedValueOnce(Response.json({approvalId:'approval',state:'granted',continuation:{attemptId:'next',afterEventId:'decision'}}))
      .mockResolvedValueOnce(new Response(frame(4,'delta','continued') + frame(5,'done')));
    vi.stubGlobal('fetch',fetch);
    const controller=createConversationController(await create());
    const onDelta=vi.fn();
    await controller.submit('session','write',{onDelta,onDone(){}});
    expect(controller.state.status).toBe('awaiting-approval');
    await controller.decide('granted',{onDelta,onDone(){}});
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('continued');
    expect(fetch.mock.calls.map(call=>call[0])).toEqual([
      'http://api.test/v1/sessions/session/turns','http://api.test/v1/turns/turn/events',
      'http://api.test/v1/turns/turn/tool-approvals','http://api.test/v1/turns/turn/events?after=decision',
    ]);
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toMatchObject({approvalId:'approval',decision:'granted'});
    expect(fetch.mock.calls[3]![1].headers['Last-Event-ID']).toBe('decision');
    expect(fetch.mock.calls.every(([,init])=>init.headers.Authorization==='Bearer secret')).toBe(true);
    expect(controller.state.status).toBe('completed');
  });
  it('retries unknown acceptance with one business key and independent IPC request identities', async () => {
    const fetch=vi.fn().mockRejectedValueOnce(new Error('acceptance lost'))
      .mockResolvedValueOnce(Response.json({turnId:'turn'}))
      .mockResolvedValueOnce(new Response(frame(1,'delta','result')+frame(2,'done')));
    vi.stubGlobal('fetch',fetch);
    const controller=createConversationController(await create());
    await expect(controller.submit('session','hello',{onDelta(){},onDone(){}})).rejects.toThrow();
    await controller.retry({onDelta(){},onDone(){}});
    const posts=fetch.mock.calls.filter(([,init])=>init.method==='POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]![1].headers['Idempotency-Key']).toBe(posts[0]![1].headers['Idempotency-Key']);
    expect(posts[0]![1].headers['Idempotency-Key']).toEqual(expect.any(String));
    if(name==='full IPC') {
      const starts=ipc.send.mock.calls.filter(([channel])=>channel==='aervox:turn:start');
      expect(starts).toHaveLength(2);
      expect(starts[1]![1].requestId).not.toBe(starts[0]![1].requestId);
      expect(starts[1]![1].idempotencyKey).toBe(starts[0]![1].idempotencyKey);
    }
    expect(controller.state.status).toBe('completed');
  });

});
