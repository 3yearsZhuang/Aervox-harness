import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_TURN_TIMEOUT_MS, desktopTransport } from '../src/desktop-transport'

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('desktopTransport', () => {
  it('主进程未发送终止事件时超时退出，而非永久等待', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    ;(globalThis as { window: unknown }).window = {
      fairyDesktop: {
        apiRequest: vi.fn(),
        streamTurn: vi.fn(() => stop),
      },
    }

    const result = desktopTransport.streamTurn('session_ignored', 'hello', {
      onDelta: vi.fn(),
      onDone: vi.fn(),
    })
    const assertion = expect(result).rejects.toThrow(/desktop_turn_timeout/)

    await vi.advanceTimersByTimeAsync(DESKTOP_TURN_TIMEOUT_MS)

    await assertion
    expect(stop).toHaveBeenCalledOnce()
  })

  it('API 的 SSE error 事件会拒绝请求，使界面显示具体失败原因', async () => {
    let callback: ((message: unknown) => void) | undefined
    const stop = vi.fn()
    ;(globalThis as { window: unknown }).window = {
      fairyDesktop: {
        apiRequest: vi.fn(),
        streamTurn: vi.fn((_content, _options, receivedCallback) => {
          callback = receivedCallback
          return stop
        }),
      },
    }

    const result = desktopTransport.streamTurn('session_ignored', 'hello', {
      onDelta: vi.fn(),
      onDone: vi.fn(),
    })
    const assertion = expect(result).rejects.toThrow('llm_timeout: upstream model did not respond')

    callback?.({
      type: 'event',
      event: { eventType: 'error', data: { message: 'llm_timeout: upstream model did not respond within 45000ms' } },
    })

    await assertion
    expect(stop).toHaveBeenCalledOnce()
  })
})
