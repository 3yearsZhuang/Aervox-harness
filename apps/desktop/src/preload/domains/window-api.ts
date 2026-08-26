import {ipcRenderer} from 'electron'

export const windowApi = {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    onPetCommand: (callback: (command: unknown) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, command: unknown) => callback(command)
        ipcRenderer.on('pet:command', listener)
        return () => ipcRenderer.removeListener('pet:command', listener)
    },
}
