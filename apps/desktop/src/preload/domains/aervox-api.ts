import {ipcRenderer, type IpcRendererEvent} from 'electron'

export interface ApiRequestResult<T = unknown> {
    status: number
    ok: boolean
    json: T | null
    text: string
}

export const aervoxApi = {
    streamTurn: (
        content: string,
        options: {
            toolApprovalMode: 'ask' | 'full_access'
            attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>
            /** CR-027：渲染层生成的请求 ID；缺省时由 preload 生成。供 cancelTurn 定位在途请求 */
            requestId?: string
        },
        callback: (message: unknown) => void,
    ) => {
        const requestId = options.requestId ?? `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '')}`
        const listener = (_event: IpcRendererEvent, message: unknown) => {
            if (!message || typeof message !== 'object' || (message as {requestId?: unknown}).requestId !== requestId) return
            callback(message)
            const type = (message as {type?: unknown}).type
            if (type === 'closed' || type === 'error') ipcRenderer.removeListener('aervox:turn:event', listener)
        }
        ipcRenderer.on('aervox:turn:event', listener)
        ipcRenderer.send('aervox:turn:start', {requestId, content, toolApprovalMode: options.toolApprovalMode, attachments: options.attachments})
        return () => ipcRenderer.removeListener('aervox:turn:event', listener)
    },
    /** CR-027：通知主进程中止在途 Turn 请求（渲染层空闲超时或 UI 主动放弃时调用） */
    cancelTurn: (requestId: string) => {
        ipcRenderer.send('aervox:turn:cancel', requestId)
    },
    apiRequest: <T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
        ipcRenderer.invoke('aervox:api:request', {method, path, body, headers}) as Promise<ApiRequestResult<T>>,
    uploadAttachment: (payload: {fileName: string; mediaType: string; purpose: string; dataBase64: string; idempotencyKey?: string}) =>
        ipcRenderer.invoke('aervox:attachment:upload', payload) as Promise<unknown>,
}
