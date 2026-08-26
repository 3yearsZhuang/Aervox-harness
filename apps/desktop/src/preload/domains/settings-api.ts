import {ipcRenderer, type IpcRendererEvent} from 'electron'

export type Theme = 'light' | 'dark'

function isTheme(value: unknown): value is Theme {
    return value === 'light' || value === 'dark'
}

export const settingsApi = {
    getTheme: (): Promise<Theme> => ipcRenderer.invoke('theme:get'),
    setTheme: (theme: Theme): Promise<Theme> => ipcRenderer.invoke('theme:set', theme),
    onThemeChange: (callback: (theme: Theme) => void) => {
        const listener = (_event: IpcRendererEvent, theme: unknown) => {
            if (isTheme(theme)) callback(theme)
        }
        ipcRenderer.on('theme:changed', listener)
        return () => ipcRenderer.removeListener('theme:changed', listener)
    },
}