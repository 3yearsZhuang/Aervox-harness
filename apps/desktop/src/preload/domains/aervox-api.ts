import {ipcRenderer, type IpcRendererEvent} from 'electron'

export interface ApiRequestResult<T = unknown> {
    status: number
    ok: boolean
    json: T | null
    text: string
}

export const aervoxApi = {
    streamTurn: (content: string, callback: (message: unknown) => void) => {
        const requestId = `${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '')}`
        const listener = (_event: IpcRendererEvent, message: unknown) => {
            if (!message || typeof message !== 'object' || (message as {requestId?: unknown}).requestId !== requestId) return
            callback(message)
            const type = (message as {type?: unknown}).type
            if (type === 'closed' || type === 'error') ipcRenderer.removeListener('aervox:turn:event', listener)
        }
        ipcRenderer.on('aervox:turn:event', listener)
        ipcRenderer.send('aervox:turn:start', {requestId, content})
        return () => ipcRenderer.removeListener('aervox:turn:event', listener)
    },
    apiRequest: <T = unknown>(method: string, path: string, body?: unknown) =>
        ipcRenderer.invoke('aervox:api:request', {method, path, body}) as Promise<ApiRequestResult<T>>,
}