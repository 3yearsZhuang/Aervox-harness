import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron'

contextBridge.exposeInMainWorld('fairyDesktop', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getTheme: () => ipcRenderer.invoke('theme:get'),
    setTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke('theme:set', theme),
    onThemeChange: (callback: (theme: 'light' | 'dark') => void) => {
        const listener = (_event: IpcRendererEvent, theme: 'light' | 'dark') => callback(theme)
        ipcRenderer.on('theme:changed', listener)
        return () => ipcRenderer.removeListener('theme:changed', listener)
    },
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
        ipcRenderer.invoke('aervox:api:request', {method, path, body}) as Promise<{
            status: number
            ok: boolean
            json: T | null
            text: string
        }>,
})
