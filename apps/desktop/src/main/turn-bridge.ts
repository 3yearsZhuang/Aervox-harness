import {resolveTurnSessionId} from './runtime-config.js'

type NavigationListener = (event?: {isMainFrame?: boolean; isSameDocument?: boolean}, url?: string, isInPlace?: boolean, isMainFrame?: boolean) => void

interface TurnSender {
    isDestroyed(): boolean
    send(channel: string, message: Record<string, unknown>): void
    on?(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown
    removeListener?(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown
}

function isTurnAttachment(value: unknown): value is {attachmentId: string; name?: string; mediaType?: string} {
    if (!value || typeof value !== 'object') return false
    const item = value as Record<string, unknown>
    return typeof item.attachmentId === 'string'
        && item.attachmentId.length > 0
        && item.attachmentId.length <= 128
        && (item.name === undefined || (typeof item.name === 'string' && item.name.length <= 200))
        && (item.mediaType === undefined || (typeof item.mediaType === 'string' && item.mediaType.length <= 100))
}

function isTurnRequest(value: unknown): value is {
    requestId: string
    sessionId?: string
    content: string
    toolApprovalMode?: 'ask' | 'full_access'
    attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>
    metadata?: Record<string, unknown>
} {
    if (!value || typeof value !== 'object') return false
    const request = value as Record<string, unknown>
    return typeof request.requestId === 'string'
        && /^[a-zA-Z0-9_-]{8,80}$/.test(request.requestId)
        && typeof request.content === 'string'
        && request.content.trim().length > 0
        && request.content.length <= 20_000
        && (request.toolApprovalMode === undefined
            || request.toolApprovalMode === 'ask'
            || request.toolApprovalMode === 'full_access')
        && (request.attachments === undefined
            || (Array.isArray(request.attachments) && request.attachments.length <= 20 && request.attachments.every(isTurnAttachment)))
        && (request.metadata === undefined
            || (request.metadata !== null && typeof request.metadata === 'object' && !Array.isArray(request.metadata)))
}

/** Main-process HTTP/SSE bridge, shared with process-independent acceptance tests. */
export function createDesktopTurnBridge(deps: {
    apiBaseUrl: string
    sessionId?: () => string | undefined
    authToken?: () => string | undefined
    onEmote?: (data: unknown) => void
    isTrustedSender?: (sender: TurnSender) => boolean
}) {
    /** The aggregate is diagnostic; cancellation belongs to each renderer's request map. */
    const activeTurnRequests = new Set<AbortController>()
    const senders = new WeakMap<TurnSender, Map<string, AbortController>>()

    function cancelTurn(sender: TurnSender, requestId: unknown): void {
        if (typeof requestId === 'string') senders.get(sender)?.get(requestId)?.abort()
    }

    async function streamAervoxTurn(event: {sender: TurnSender}, payload: unknown) {
        if (!isTurnRequest(payload) || event.sender.isDestroyed() || deps.isTrustedSender?.(event.sender) === false) return
        const {requestId, content} = payload
        const toolApprovalMode = payload.toolApprovalMode ?? 'ask'
        const controller = new AbortController()
        const send = (message: Record<string, unknown>) => {
            if (!controller.signal.aborted && !event.sender.isDestroyed() && deps.isTrustedSender?.(event.sender) !== false) {
                event.sender.send('aervox:turn:event', {requestId, ...message})
            }
        }
        let owned = senders.get(event.sender)
        if (!owned) { owned = new Map(); senders.set(event.sender, owned) }
        owned.get(requestId)?.abort()
        owned.set(requestId, controller)
        activeTurnRequests.add(controller)
        const stop = () => controller.abort()
        const stopForNavigation: NavigationListener = (event, _url, isInPlace, isMainFrame) => {
            if ((event?.isMainFrame ?? isMainFrame ?? true) && !(event?.isSameDocument ?? isInPlace ?? false)) stop()
        }
        event.sender.on?.('destroyed', stop)
        event.sender.on?.('did-start-navigation', stopForNavigation)
        const unregister = () => {
            activeTurnRequests.delete(controller)
            if (owned.get(requestId) === controller) owned.delete(requestId)
            event.sender.removeListener?.('destroyed', stop)
            event.sender.removeListener?.('did-start-navigation', stopForNavigation)
        }

        try {
            const sessionId = resolveTurnSessionId(payload.sessionId, deps.sessionId?.())
            const headers: Record<string, string> = {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Idempotency-Key': requestId,
            }
            const authToken = deps.authToken?.()?.trim()
            if (authToken) headers.Authorization = `Bearer ${authToken}`

            const createResponse = await fetch(`${deps.apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    message: {content, contentType: 'text', ...(payload.attachments ? {attachments: payload.attachments} : {})},
                    clientVersion: '@aervox/desktop/0.2.0',
                    toolApprovalMode,
                    references: [],
                    ...(payload.metadata ? { metadata: payload.metadata } : {}),
                }),
                signal: controller.signal,
            })
            if (!createResponse.ok) throw new Error(`创建 Turn 失败（HTTP ${createResponse.status}）`)

            const turn = await createResponse.json() as {eventsUrl?: unknown}
            if (typeof turn.eventsUrl !== 'string' || !turn.eventsUrl.startsWith('/')) {
                throw new Error('Turn 响应缺少有效 eventsUrl')
            }

            const eventsResponse = await fetch(`${deps.apiBaseUrl}${turn.eventsUrl}`, {
                headers: {Accept: 'text/event-stream'},
                signal: controller.signal,
            })
            if (!eventsResponse.ok || !eventsResponse.body) {
                throw new Error(`读取 Turn 事件失败（HTTP ${eventsResponse.status}）`)
            }

            const reader = eventsResponse.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            const consumeFrame = (frame: string) => {
                const data = frame.split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trim())
                    .join('')
                if (!data) {
                    // SSE 注释心跳帧（`: ping`）：转发为桥消息，维持渲染层空闲超时计时（CR-027）
                    send({type: 'heartbeat'})
                    return
                }
                const turnEvent = JSON.parse(data) as Record<string, unknown>
                send({type: 'event', event: turnEvent})
                if (!controller.signal.aborted && deps.isTrustedSender?.(event.sender) !== false && turnEvent.eventType === 'emote') {
                    deps.onEmote?.(turnEvent.data)
                }
            }

            while (true) {
                const {done, value} = await reader.read()
                buffer += decoder.decode(value ?? new Uint8Array(), {stream: !done})
                const frames = buffer.split(/\r?\n\r?\n/)
                buffer = frames.pop() ?? ''
                for (const frame of frames) consumeFrame(frame)
                if (done) break
            }
            if (buffer.trim()) consumeFrame(buffer)
            send({type: 'closed'})
        } catch (error) {
            // 渲染层主动取消（空闲超时/UI 放弃）时不再回发 error，避免对已收敛的 UI 重复报错
            if (!controller.signal.aborted) {
                send({type: 'error', message: error instanceof Error ? error.message : 'Aervox 请求失败'})
            }
        } finally {
            unregister()
        }
    }

    return {streamAervoxTurn, activeTurnRequests, cancelTurn}
}
