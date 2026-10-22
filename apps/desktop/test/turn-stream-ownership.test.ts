import {EventEmitter} from 'node:events'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createDesktopTurnBridge} from '../src/main/turn-bridge'

class Sender extends EventEmitter {
    trusted = true
    send = vi.fn()
    isDestroyed() { return false }
}

afterEach(() => vi.unstubAllGlobals())

function fixture() {
    const signals: AbortSignal[] = []
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        const signal = init.signal as AbortSignal
        signals.push(signal)
        return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true})
        })
    })
    vi.stubGlobal('fetch', fetch)
    const bridge = createDesktopTurnBridge({apiBaseUrl: 'http://127.0.0.1:3000', isTrustedSender: sender => (sender as Sender).trusted})
    const payload = {requestId: 'request_same', sessionId: 'session_A', content: 'Hello'}
    return {bridge, signals, fetch, payload}
}

describe('Turn renderer ownership', () => {
    it('same request ID in two windows has separate cancellation and cleanup', async () => {
        const {bridge, signals, payload} = fixture()
        const a = new Sender(); const b = new Sender()
        const first = bridge.streamAervoxTurn({sender: a}, payload)
        const second = bridge.streamAervoxTurn({sender: b}, payload)
        expect(bridge.activeTurnRequests.size).toBe(2)
        bridge.cancelTurn(a, payload.requestId)
        expect(signals[0].aborted).toBe(true)
        expect(signals[1].aborted).toBe(false)
        await first
        expect(bridge.activeTurnRequests.size).toBe(1)
        b.emit('destroyed')
        await second
        expect(bridge.activeTurnRequests.size).toBe(0)
        expect(a.send).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled()
        for (const sender of [a, b]) {
            expect(sender.listenerCount('destroyed')).toBe(0)
            expect(sender.listenerCount('did-start-navigation')).toBe(0)
        }
    })

    it('subframe and same-document navigation preserve the Turn; main navigation cancels it', async () => {
        const {bridge, signals, payload} = fixture()
        const sender = new Sender()
        const pending = bridge.streamAervoxTurn({sender}, payload)
        sender.emit('did-start-navigation', {isMainFrame: false, isSameDocument: false}, 'http://plugin.test')
        expect(signals[0].aborted).toBe(false)
        sender.emit('did-start-navigation', {isMainFrame: true, isSameDocument: true}, 'file:///app/index.html#section')
        expect(signals[0].aborted).toBe(false)
        sender.emit('did-start-navigation', {isMainFrame: true, isSameDocument: false}, 'file:///app/index.html?surface=proactive-ui')
        expect(signals[0].aborted).toBe(true)
        await pending
        expect(sender.send).not.toHaveBeenCalled()
    })

    it('an untrusted renderer never starts an authenticated request', async () => {
        const {bridge, fetch, payload} = fixture()
        const sender = new Sender(); sender.trusted = false
        await bridge.streamAervoxTurn({sender}, payload)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('loss of document trust suppresses late events and pet commands', async () => {
        const sender = new Sender()
        const onEmote = vi.fn()
        let release!: () => void
        const fetch = vi.fn()
            .mockResolvedValueOnce(Response.json({eventsUrl: '/v1/turns/turn_A/events'}))
            .mockImplementationOnce(async () => {
                await new Promise<void>(resolve => { release = resolve })
                return new Response('data: {"eventType":"emote","data":{"secret":true}}\n\n')
            })
        vi.stubGlobal('fetch', fetch)
        const bridge = createDesktopTurnBridge({apiBaseUrl: 'http://127.0.0.1:3000', isTrustedSender: sender => (sender as Sender).trusted, onEmote})
        const pending = bridge.streamAervoxTurn({sender}, {requestId: 'request_late', content: 'Hello'})
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        sender.trusted = false
        release()
        await pending
        expect(sender.send).not.toHaveBeenCalled()
        expect(onEmote).not.toHaveBeenCalled()
    })
})
