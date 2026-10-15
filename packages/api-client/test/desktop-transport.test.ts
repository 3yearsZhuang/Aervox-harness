import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_TURN_TIMEOUT_MS, desktopTransport } from '../src/desktop-transport'
import { AervoxHttpError } from '../src/transport'

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as { window?: unknown }).window
})

describe('desktopTransport', () => {
  it('preserves HTTP status and the desktop error body for conflict recovery', async () => {
    const body = '{"code":"bot_connection_revision_conflict"}'
    ;(globalThis as { window: unknown }).window = {
      fairyDesktop: {
        apiRequest: vi.fn().mockResolvedValue({ status: 409, ok: false, json: { code: 'bot_connection_revision_conflict' }, text: body }),
      },
    }
    const result = desktopTransport.request('PATCH', '/v1/bot-connections/bot-1', { revision: 1 })
    await expect(result).rejects.toBeInstanceOf(AervoxHttpError)
    await expect(result).rejects.toMatchObject({
      status: 409,
      message: `API PATCH /v1/bot-connections/bot-1 → HTTP 409: ${body}`,
    })
  })

  it('主进程持续静默时按空闲超时退出，而非永久等待', async () => {
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

  it('CR-027 空闲语义：每收到一条桥消息重置计时，深度思考长回合不再误报', async () => {
    vi.useFakeTimers()
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
    // 前 4 个「50s 静默 + 1 条消息」循环：每次都刚好在超时前收到消息
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(DESKTOP_TURN_TIMEOUT_MS - 1000)
      callback?.({ type: 'event', event: { eventType: 'reasoning_delta', data: { text: `第${i}步思考` } } })
    }
    // 总耗时远超旧 60s 绝对时限仍未超时
    await vi.advanceTimersByTimeAsync(DESKTOP_TURN_TIMEOUT_MS - 1000)
    callback?.({ type: 'event', event: { eventType: 'done', data: {} } })
    callback?.({ type: 'closed' })
    await expect(result).resolves.toBeUndefined()
  })

  it('CR-027 空闲超时触发时通知主进程取消在途请求，避免幽灵回合', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const cancelTurn = vi.fn()
    ;(globalThis as { window: unknown }).window = {
      fairyDesktop: {
        apiRequest: vi.fn(),
        streamTurn: vi.fn(() => stop),
        cancelTurn,
      },
    }

    const result = desktopTransport.streamTurn('session_ignored', 'hello', {
      onDelta: vi.fn(),
      onDone: vi.fn(),
    })
    const assertion = expect(result).rejects.toThrow(/desktop_turn_timeout/)

    await vi.advanceTimersByTimeAsync(DESKTOP_TURN_TIMEOUT_MS)

    await assertion
    expect(cancelTurn).toHaveBeenCalledTimes(1)
    expect(cancelTurn).toHaveBeenCalledWith(expect.stringMatching(/^turn_/))
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

  it('CR-027 onReasoning 回调收到思考增量', async () => {
    let callback: ((message: unknown) => void) | undefined
    ;(globalThis as { window: unknown }).window = {
      fairyDesktop: {
        apiRequest: vi.fn(),
        streamTurn: vi.fn((_content, _options, receivedCallback) => {
          callback = receivedCallback
          return vi.fn()
        }),
      },
    }

    const onReasoning = vi.fn()
    const result = desktopTransport.streamTurn('session_ignored', 'hello', {
      onDelta: vi.fn(),
      onDone: vi.fn(),
      onReasoning,
    })
    callback?.({ type: 'event', event: { eventType: 'reasoning_delta', data: { text: '思考中' } } })
    callback?.({ type: 'closed' })

    await expect(result).resolves.toBeUndefined()
    expect(onReasoning).toHaveBeenCalledWith('思考中')
  })
})


it('root unmount detaches IPC streaming and ignores late callbacks', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  let callback!: (message: unknown) => void
  const stop = vi.fn()
  const cancelTurn = vi.fn()
  const apiRequest = vi.fn()
  ;(globalThis as { window: unknown }).window = {
    fairyDesktop: { apiRequest, cancelTurn, streamTurn: vi.fn((_c, _o, cb) => { callback = cb; return stop }) },
  }
  const onDelta = vi.fn()
  const result = desktopTransport.streamTurn('s', 'hello', { onDelta, onDone: vi.fn() }, { signal: controller.signal })
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await assertion
  callback({ type: 'event', event: { eventType: 'delta', data: { text: 'late' } } })
  await vi.advanceTimersByTimeAsync(DESKTOP_TURN_TIMEOUT_MS)
  expect(stop).toHaveBeenCalledOnce()
  expect(cancelTurn).toHaveBeenCalledOnce()
  expect(onDelta).not.toHaveBeenCalled()
  expect(apiRequest).not.toHaveBeenCalled() // No logical Turn cancellation request.
})

it('an already detached surface cannot start an IPC turn', async () => {
  const controller = new AbortController()
  controller.abort()
  const streamTurn = vi.fn()
  ;(globalThis as { window: unknown }).window = { fairyDesktop: { apiRequest: vi.fn(), streamTurn } }
  await expect(desktopTransport.streamTurn('s', 'hello', { onDelta: vi.fn(), onDone: vi.fn() }, { signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(streamTurn).not.toHaveBeenCalled()
})

it('synchronous bridge completion still releases the returned subscription', async () => {
  const stop = vi.fn()
  ;(globalThis as { window: unknown }).window = {
    fairyDesktop: { apiRequest: vi.fn(), streamTurn: vi.fn((_c, _o, cb) => { cb({ type: 'closed' }); return stop }) },
  }
  await desktopTransport.streamTurn('s', 'hello', { onDelta: vi.fn(), onDone: vi.fn() })
  expect(stop).toHaveBeenCalledOnce()
})
