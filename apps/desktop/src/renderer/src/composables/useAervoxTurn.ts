import type {
  CreateTurnResponse,
  DeltaEventData,
  DoneEventData,
  ErrorEventData,
  TurnStreamEvent,
} from '@aervox/contracts'

const apiBaseUrl = (import.meta.env.VITE_AERVOX_API_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const sessionId = import.meta.env.VITE_AERVOX_SESSION_ID ?? 'desktop-demo'

export interface TurnStreamCallbacks {
  onDelta: (text: string) => void
  onDone: (data: DoneEventData) => void
}

export async function streamAervoxTurn(content: string, callbacks: TurnStreamCallbacks): Promise<void> {
  if (window.fairyDesktop?.streamTurn) {
    await streamTurnViaDesktopBridge(content, callbacks)
    return
  }

  const idempotencyKey = crypto.randomUUID()
  const createResponse = await fetch(`${apiBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      message: {content, contentType: 'text'},
                clientVersion: '@aervox/desktop/0.2.0',
      references: [],
    }),
  })

  if (!createResponse.ok) {
    throw new Error(`创建 Turn 失败（HTTP ${createResponse.status}）`)
  }

  const turn = (await createResponse.json()) as CreateTurnResponse
  const eventsResponse = await fetch(`${apiBaseUrl}${turn.eventsUrl}`, {
    headers: {Accept: 'text/event-stream', 'Cache-Control': 'no-cache'},
  })
  if (!eventsResponse.ok || !eventsResponse.body) {
    throw new Error(`读取 Turn 事件失败（HTTP ${eventsResponse.status}）`)
  }

  const reader = eventsResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastEventId = ''

  const consumeFrame = (frame: string) => {
    let data = ''
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) lastEventId = line.slice(3).trim()
      if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return

    const event = JSON.parse(data) as TurnStreamEvent
    if (event.eventId && event.eventId !== lastEventId) lastEventId = event.eventId
    if (event.eventType === 'delta') {
      callbacks.onDelta((event.data as DeltaEventData).text)
    } else if (event.eventType === 'error') {
      const error = event.data as ErrorEventData
      throw new Error(error.message)
    } else if (event.eventType === 'done') {
      callbacks.onDone(event.data as DoneEventData)
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
}

function streamTurnViaDesktopBridge(content: string, callbacks: TurnStreamCallbacks): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = window.fairyDesktop!.streamTurn(content, (message) => {
      if (!message || typeof message !== 'object') return
      const envelope = message as {type?: unknown; event?: unknown; message?: unknown}
      if (envelope.type === 'error') {
        stop()
        reject(new Error(typeof envelope.message === 'string' ? envelope.message : 'Aervox 请求失败'))
        return
      }
      if (envelope.type === 'closed') {
        stop()
        resolve()
        return
      }
      if (envelope.type !== 'event' || !envelope.event || typeof envelope.event !== 'object') return
      const event = envelope.event as TurnStreamEvent
      if (event.eventType === 'delta') callbacks.onDelta((event.data as DeltaEventData).text)
      if (event.eventType === 'done') callbacks.onDone(event.data as DoneEventData)
      if (event.eventType === 'error') reject(new Error((event.data as ErrorEventData).message))
    })
  })
}
