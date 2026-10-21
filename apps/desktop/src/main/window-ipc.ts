import type {BrowserWindow, IpcMain, OpenDialogOptions, OpenDialogReturnValue, WebContents} from 'electron'

interface WindowIpcDependencies {
    ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
    getMainWindow(): BrowserWindow | null
    getWindowForSender(sender: WebContents): BrowserWindow | null
    openExternal(url: string): Promise<void>
    showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

/** 窗口能力由主进程注入；注册失败和退出时仅清理本次拥有的处理器。 */
export function registerWindowIpc(deps: WindowIpcDependencies): () => void {
    const channels: string[] = []
    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true
        for (const channel of channels) deps.ipcMain.removeHandler(channel)
    }
    const handle = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
        deps.ipcMain.handle(channel, listener)
        channels.push(channel)
    }

    try {
        handle('window:minimize', () => {
            deps.getMainWindow()?.minimize()
            return true
        })
        handle('window:toggle-maximize', (event) => {
            const window = deps.getWindowForSender(event.sender)
            if (!window) return false
            if (window.isMaximized()) window.unmaximize()
            else window.maximize()
            return window.isMaximized()
        })
        handle('window:close', () => {
            deps.getMainWindow()?.destroy()
            return true
        })
        // 外链经系统浏览器打开（如牛客每日一题）：仅放行 https 协议
        handle('window:open-external', (_event, url: unknown) => {
            if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
                throw new Error('仅允许打开 https:// 外部链接')
            }
            return deps.openExternal(url)
        })
        // 「选择文件夹」：本地语音模型路径 / 音色目录（CR-011 阶段 3）
        handle('dialog:pick-directory', async (event) => {
            const window = deps.getWindowForSender(event.sender)
            if (!window) return null
            const result = await deps.showOpenDialog(window, {
                title: '选择文件夹',
                properties: ['openDirectory', 'createDirectory'],
            })
            return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
        })
    } catch (error) {
        dispose()
        throw error
    }
    return dispose
}
