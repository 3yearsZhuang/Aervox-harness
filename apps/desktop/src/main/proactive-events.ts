/**
 * Aervox｜思隅 @aervox/desktop — 主动表现事件常驻 SSE 消费器（CR-032 S5）
 *
 * 订阅 API GET /v1/proactive/events（以 vault 账本为队列的 SSE 直推），把
 * ProactivePresentationEvent 映射为既有桌宠指令管道可消费的 PetCommand 序列：
 * - presentation.animation → gesture/emote 指令（别名表解析，未知值静默跳过）；
 * - presentation.message + bubblePreset → speak 指令（气泡文案与预设随行）。
 * 断线自动重连（指数退避封顶 60s）；连接建立即重放近期事件，由 actionId 去重。
 */
import type { ProactivePresentationEvent } from '@aervox/contracts/proactive'

/** 动画别名表：插件声明的语义动画名 → 桌宠手势/表情指令 */
export const PET_ANIMATION_ALIASES: Readonly<Record<string, {type: 'gesture' | 'emote'; value: string}>> = {
    stretch_body: {type: 'gesture', value: 'stretch'},
    wave: {type: 'gesture', value: 'wave'},
    nod: {type: 'gesture', value: 'nod'},
    shake_head: {type: 'gesture', value: 'shake'},
    yawn: {type: 'gesture', value: 'yawn'},
    cheer: {type: 'emote', value: 'cheer'},
    happy: {type: 'emote', value: 'happy'},
    worry: {type: 'emote', value: 'worry'},
    think: {type: 'emote', value: 'think'},
    surprise: {type: 'emote', value: 'surprise'},
}

export interface ProactivePetCommand {
    type: 'gesture' | 'emote' | 'speak'
    gesture?: string
    emote?: string
    text?: string
    preset?: string
    source: 'proactive'
    actionId: string
}

export interface ProactiveEventStreamDeps {
    apiBaseUrl: string
    buildHeaders: () => Promise<Record<string, string>>
    onPresentation: (event: ProactivePresentationEvent) => void
    /** 重连与生命周期日志（注入便于测试） */
    log?: (message: string) => void
    /** 重连退避参数（测试可注入短周期） */
    backoffMs?: {initial: number; max: number}
}

export function toPetCommands(event: ProactivePresentationEvent): ProactivePetCommand[] {
    const commands: ProactivePetCommand[] = []
    const alias = event.animation ? PET_ANIMATION_ALIASES[event.animation] : undefined
    if (alias) {
        commands.push({
            type: alias.type,
            ...(alias.type === 'gesture' ? {gesture: alias.value} : {emote: alias.value}),
            source: 'proactive',
            actionId: event.actionId,
        })
    }
    if (event.message.trim()) {
        commands.push({
            type: 'speak',
            text: event.message,
            preset: event.bubblePreset,
            source: 'proactive',
            actionId: event.actionId,
        })
    }
    return commands
}

function parseSseFrame(frame: string): ProactivePresentationEvent | null {
    const data = frame.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')
    if (!data) return null
    try {
        const parsed = JSON.parse(data) as ProactivePresentationEvent
        return parsed?.kind === 'proactive.presentation' && parsed.actionId && parsed.message ? parsed : null
    } catch {
        return null
    }
}

export function startProactiveEventStream(deps: ProactiveEventStreamDeps): {stop: () => void} {
    let stopped = false
    let controller: AbortController | undefined
    const backoff = deps.backoffMs ?? {initial: 1_000, max: 60_000}
    let backoffMs = backoff.initial
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const connect = async (): Promise<void> => {
        while (!stopped) {
            controller = new AbortController()
            try {
                const response = await fetch(`${deps.apiBaseUrl}/v1/proactive/events`, {
                    headers: {...(await deps.buildHeaders()), Accept: 'text/event-stream'},
                    signal: controller.signal,
                })
                if (!response.ok || !response.body) {
                    throw new Error(`proactive events HTTP ${response.status}`)
                }
                backoffMs = backoff.initial
                const reader = response.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ''
                const consume = (frame: string): void => {
                    const event = parseSseFrame(frame)
                    if (event) deps.onPresentation(event)
                }
                while (!stopped) {
                    const {done, value} = await reader.read()
                    buffer += decoder.decode(value ?? new Uint8Array(), {stream: !done})
                    const frames = buffer.split(/\r?\n\r?\n/)
                    buffer = frames.pop() ?? ''
                    for (const frame of frames) consume(frame)
                    if (done) break
                }
                if (buffer.trim()) consume(buffer)
            } catch (error) {
                if (stopped || (error instanceof Error && error.name === 'AbortError')) return
                deps.log?.(`proactive event stream reconnect: ${error instanceof Error ? error.message : String(error)}`)
            }
            if (stopped) return
            await new Promise<void>((resolve) => {
                reconnectTimer = setTimeout(resolve, backoffMs)
            })
            backoffMs = Math.min(backoffMs * 2, backoff.max)
        }
    }

    void connect()

    return {
        stop: () => {
            stopped = true
            controller?.abort()
            if (reconnectTimer) clearTimeout(reconnectTimer)
        },
    }
}
