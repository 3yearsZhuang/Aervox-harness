import { createFetchTransport, type ObserveTurnOptions, type StreamTurnOptions, type TurnCallbacks } from '@aervox/api-client/transport'
import { resolveTurnSessionId } from './runtime-config.js'

type NavigationListener = (event?: {isMainFrame?: boolean; isSameDocument?: boolean}, url?: string, isInPlace?: boolean, isMainFrame?: boolean) => void
interface TurnSender {
    isDestroyed(): boolean
    send(channel: string, message: Record<string, unknown>): void
    on?(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown
    removeListener?(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown
}
interface Submission {
    requestId: string
    sessionId?: string
    content: string
    toolApprovalMode?: 'ask' | 'full_access'
    idempotencyKey?: string
    attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>
    metadata?: Record<string, unknown>
}
interface Observation { requestId: string; turnId: string; afterEventId?: string }
const validId = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
function requestId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value) }
function submission(value: unknown): value is Submission {
    if (!value || typeof value !== 'object') return false
    const item = value as Submission
    return requestId(item.requestId) && typeof item.content === 'string' && item.content.trim().length > 0 && item.content.length <= 20_000
        && (item.sessionId === undefined || validId(item.sessionId))
        && (item.idempotencyKey === undefined || validId(item.idempotencyKey, 200))
        && (item.toolApprovalMode === undefined || item.toolApprovalMode === 'ask' || item.toolApprovalMode === 'full_access')
        && (item.attachments === undefined || (Array.isArray(item.attachments) && item.attachments.length <= 20 && item.attachments.every(a => a && validId(a.attachmentId) && (a.name === undefined || validId(a.name, 200)) && (a.mediaType === undefined || validId(a.mediaType, 100)))))
        && (item.metadata === undefined || (!!item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)))
}
function observation(value: unknown): value is Observation {
    if (!value || typeof value !== 'object') return false
    const item = value as Observation
    return requestId(item.requestId) && validId(item.turnId) && (item.afterEventId === undefined || validId(item.afterEventId, 200))
}

/** IPC owns credentials and renderer lifetimes; the shared client owns the Turn protocol. */
export function createDesktopTurnBridge(deps: {
    apiBaseUrl: string
    sessionId?: () => string | undefined
    authToken?: () => string | undefined
    onEmote?: (data: unknown) => void
    isTrustedSender?: (sender: TurnSender) => boolean
    /** Production preload acknowledges each processed event, preserving consumer backpressure. */
    requireAcknowledgement?: boolean
}) {
    const activeTurnRequests = new Set<AbortController>()
    type Active = { controller: AbortController; pending?: {deliveryId: number; resolve(): void; reject(error: Error): void} }
    const senders = new WeakMap<TurnSender, Map<string, Active>>()
    function cancelTurn(sender: TurnSender, id: unknown) { if (typeof id === 'string') senders.get(sender)?.get(id)?.controller.abort() }
    function acknowledge(sender: TurnSender, value: unknown) {
        if (!value || typeof value !== 'object' || deps.isTrustedSender?.(sender) === false) return
        const ack = value as {requestId?: unknown; deliveryId?: unknown; error?: unknown}
        if (typeof ack.requestId !== 'string') return
        const pending = senders.get(sender)?.get(ack.requestId)?.pending
        if (!pending || pending.deliveryId !== ack.deliveryId) return
        if (typeof ack.error === 'string') pending.reject(new Error('turn_consumer_failed'))
        else pending.resolve()
    }
    async function run(event: {sender: TurnSender}, payload: Submission | Observation, observe: boolean) {
        const sender = event.sender
        if (sender.isDestroyed() || deps.isTrustedSender?.(sender) === false) return
        let owned = senders.get(sender)
        if (!owned) { owned = new Map(); senders.set(sender, owned) }
        if (owned.size >= 16 && !owned.has(payload.requestId)) {
            sender.send('aervox:turn:event', {requestId: payload.requestId, type: 'error', message: 'turn_stream_limit'})
            return
        }
        owned.get(payload.requestId)?.controller.abort()
        const controller = new AbortController()
        const active: Active = {controller}
        owned.set(payload.requestId, active)
        activeTurnRequests.add(controller)
        const send = (message: Record<string, unknown>) => {
            if (!controller.signal.aborted && !sender.isDestroyed() && deps.isTrustedSender?.(sender) !== false) sender.send('aervox:turn:event', {requestId: payload.requestId, ...message})
        }
        const stop = () => controller.abort()
        const navigation: NavigationListener = (event, _url, inPlace, main) => {
            if ((event?.isMainFrame ?? main ?? true) && !(event?.isSameDocument ?? inPlace ?? false)) stop()
        }
        sender.on?.('destroyed', stop)
        sender.on?.('did-start-navigation', navigation)
        let deliveryId = 0
        const deliver = async (message: Record<string, unknown>) => {
            controller.signal.throwIfAborted()
            if (!deps.requireAcknowledgement) { send(message); return }
            const id = ++deliveryId
            await new Promise<void>((resolve, reject) => {
                const finish = (error?: Error) => {
                    active.pending = undefined
                    controller.signal.removeEventListener('abort', aborted)
                    if (error) reject(error); else resolve()
                }
                const aborted = () => finish(new DOMException('Aborted', 'AbortError'))
                active.pending = {deliveryId: id, resolve: () => finish(), reject: finish}
                controller.signal.addEventListener('abort', aborted, {once: true})
                send({...message, deliveryId: id})
            })
        }
        const callbacks: TurnCallbacks = {
            onDelta() {}, onDone() {},
            onHeartbeat: () => send({type: 'heartbeat'}),
            onEmote: command => {
                if (!controller.signal.aborted && !sender.isDestroyed() && deps.isTrustedSender?.(sender) !== false) deps.onEmote?.(command)
            },
            onEvent: turnEvent => deliver({type: 'event', event: turnEvent}),
        }
        try {
            const token = deps.authToken?.()?.trim()
            const transport = createFetchTransport(deps.apiBaseUrl, {headers: token ? {Authorization: `Bearer ${token}`} : {}, redirect: 'error'})
            if (observe) {
                const input = payload as Observation
                const options: ObserveTurnOptions = {signal: controller.signal, afterEventId: input.afterEventId}
                await transport.observeTurn!(input.turnId, callbacks, options)
            } else {
                const input = payload as Submission
                const options: StreamTurnOptions = {
                    signal: controller.signal, idempotencyKey: input.idempotencyKey ?? input.requestId,
                    toolApprovalMode: input.toolApprovalMode ?? 'ask', attachments: input.attachments, metadata: input.metadata,
                    onAccepted: turnId => deliver({type: 'accepted', turnId}),
                }
                await transport.streamTurn(resolveTurnSessionId(input.sessionId, deps.sessionId?.()), input.content, callbacks, options)
            }
            send({type: 'closed'})
        } catch (error) {
            if (!controller.signal.aborted) send({type: 'error', message: error instanceof Error ? error.message : 'Aervox 请求失败'})
        } finally {
            activeTurnRequests.delete(controller)
            if (owned.get(payload.requestId) === active) owned.delete(payload.requestId)
            sender.removeListener?.('destroyed', stop)
            sender.removeListener?.('did-start-navigation', navigation)
        }
    }
    return {
        streamAervoxTurn: (event: {sender: TurnSender}, value: unknown) => submission(value) ? run(event, value, false) : Promise.resolve(),
        observeAervoxTurn: (event: {sender: TurnSender}, value: unknown) => observation(value) ? run(event, value, true) : Promise.resolve(),
        activeTurnRequests, cancelTurn, acknowledge,
    }
}
