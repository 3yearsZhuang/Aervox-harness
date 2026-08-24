import type {DeltaEventData, DoneEventData, ErrorEventData, TurnStreamEvent} from '@aervox/contracts'

export interface TurnStreamCallbacks {
  onDelta: (text: string) => void
  onDone: (data: DoneEventData) => void
}

export async function streamAervoxTurn(content: string, callbacks: TurnStreamCallbacks): Promise<void> {
  if (window.fairyDesktop?.streamTurn) {
    await streamTurnViaDesktopBridge(content, callbacks)
    return
  }
  throw new Error('桌面桥接不可用，请通过 Electron 启动应用。')
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
