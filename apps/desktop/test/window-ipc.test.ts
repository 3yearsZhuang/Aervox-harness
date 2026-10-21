import type {BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions, WebContents} from 'electron'
import {describe, expect, it, vi} from 'vitest'
import {registerWindowIpc} from '../src/main/window-ipc'

function fakeWindow() {
    let maximized = false
    return {
        minimize: vi.fn(),
        destroy: vi.fn(),
        isMaximized: vi.fn(() => maximized),
        maximize: vi.fn(() => { maximized = true }),
        unmaximize: vi.fn(() => { maximized = false }),
    }
}

function fixture() {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const ipcMain = {
        handle: vi.fn((channel: string, listener: Parameters<IpcMain['handle']>[1]) => {
            if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
            handlers.set(channel, listener)
        }),
        removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
    }
    const main = fakeWindow()
    const pet = fakeWindow()
    const sender = {} as WebContents
    const mainRef: {current: BrowserWindow | null} = {current: main as unknown as BrowserWindow}
    const owner = pet as unknown as BrowserWindow
    const deps = {
        ipcMain,
        getMainWindow: () => mainRef.current,
        getWindowForSender: (value: WebContents) => value === sender ? owner : null,
        openExternal: vi.fn(async (_url: string) => undefined),
        showOpenDialog: vi.fn(async (_window: BrowserWindow, _options: OpenDialogOptions) => ({
            canceled: false, filePaths: ['/selected', '/second'],
        })),
    }
    const invoke = (channel: string, from = sender, ...args: unknown[]) => {
        const handler = handlers.get(channel)
        if (!handler) throw new Error(`missing handler: ${channel}`)
        return handler({sender: from} as IpcMainInvokeEvent, ...args)
    }
    return {deps, handlers, main, pet, owner, mainRef, sender, invoke}
}

describe('window IPC routing', () => {
    it('主窗口接收最小化和关闭，最大化作用于发送窗口', () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        expect(f.invoke('window:minimize')).toBe(true)
        expect(f.invoke('window:close')).toBe(true)
        expect(f.main.minimize).toHaveBeenCalledOnce()
        expect(f.main.destroy).toHaveBeenCalledOnce()
        expect(f.pet.minimize).not.toHaveBeenCalled()
        expect(f.pet.destroy).not.toHaveBeenCalled()
        expect(f.invoke('window:toggle-maximize')).toBe(true)
        expect(f.invoke('window:toggle-maximize')).toBe(false)
        expect(f.main.maximize).not.toHaveBeenCalled()
    })

    it('主窗口重建后读取当前句柄，窗口缺席时仍返回原有结果', () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        const replacement = fakeWindow()
        f.mainRef.current = replacement as unknown as BrowserWindow
        f.invoke('window:minimize')
        f.invoke('window:close')
        expect(replacement.minimize).toHaveBeenCalledOnce()
        expect(replacement.destroy).toHaveBeenCalledOnce()
        expect(f.main.minimize).not.toHaveBeenCalled()
        expect(f.main.destroy).not.toHaveBeenCalled()
        f.mainRef.current = null
        expect(f.invoke('window:minimize')).toBe(true)
        expect(f.invoke('window:close')).toBe(true)
    })

    it('发送方没有所属窗口时不最大化或打开目录对话框', async () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        const unknown = {} as WebContents
        expect(f.invoke('window:toggle-maximize', unknown)).toBe(false)
        await expect(f.invoke('dialog:pick-directory', unknown)).resolves.toBeNull()
        expect(f.pet.maximize).not.toHaveBeenCalled()
        expect(f.deps.showOpenDialog).not.toHaveBeenCalled()
    })

    it('目录对话框归属发送窗口，取消和空结果返回 null', async () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        await expect(f.invoke('dialog:pick-directory')).resolves.toBe('/selected')
        expect(f.deps.showOpenDialog).toHaveBeenCalledWith(f.owner, {
            title: '选择文件夹', properties: ['openDirectory', 'createDirectory'],
        })
        f.deps.showOpenDialog.mockResolvedValueOnce({canceled: true, filePaths: ['/ignored']})
        await expect(f.invoke('dialog:pick-directory')).resolves.toBeNull()
        f.deps.showOpenDialog.mockResolvedValueOnce({canceled: false, filePaths: []})
        await expect(f.invoke('dialog:pick-directory')).resolves.toBeNull()
        f.deps.showOpenDialog.mockRejectedValueOnce(new Error('dialog unavailable'))
        await expect(f.invoke('dialog:pick-directory')).rejects.toThrow('dialog unavailable')
    })

    it('原样传递 HTTPS URL 和系统浏览器错误', async () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        await f.invoke('window:open-external', f.sender, 'HTTPS://example.com/path?q=1')
        expect(f.deps.openExternal).toHaveBeenCalledWith('HTTPS://example.com/path?q=1')
        f.deps.openExternal.mockRejectedValueOnce(new Error('browser unavailable'))
        await expect(f.invoke('window:open-external', f.sender, 'https://example.com')).rejects.toThrow('browser unavailable')
    })

    it.each([null, 42, 'http://example.com', 'file:///tmp/file', 'javascript:void(0)'])('拒绝非 HTTPS 输入 %s', (url) => {
        const f = fixture()
        registerWindowIpc(f.deps)
        expect(() => f.invoke('window:open-external', f.sender, url)).toThrow('仅允许打开 https:// 外部链接')
        expect(f.deps.openExternal).not.toHaveBeenCalled()
    })
})

describe('window IPC registration ownership', () => {
    it('清理幂等、保留其他通道，旧清理函数不删除后来注册的处理器', () => {
        const f = fixture()
        const unrelated = vi.fn()
        f.handlers.set('theme:get', unrelated)
        const dispose = registerWindowIpc(f.deps)
        dispose()
        dispose()
        expect([...f.handlers.keys()]).toEqual(['theme:get'])
        expect(f.handlers.get('theme:get')).toBe(unrelated)
        const disposeNext = registerWindowIpc(f.deps)
        const current = new Map(f.handlers)
        dispose()
        expect(f.handlers).toEqual(current)
        expect(f.invoke('window:minimize')).toBe(true)
        disposeNext()
        expect([...f.handlers.keys()]).toEqual(['theme:get'])
    })

    it('拒绝重复注册时保留全部原有处理器', () => {
        const f = fixture()
        registerWindowIpc(f.deps)
        const original = new Map(f.handlers)
        expect(() => registerWindowIpc(f.deps)).toThrow('duplicate handler')
        expect(f.handlers).toEqual(original)
        expect(f.deps.ipcMain.removeHandler).not.toHaveBeenCalled()
    })

    it('中途注册失败回滚此前成功的通道，保留冲突处理器', () => {
        const f = fixture()
        const existing = vi.fn()
        f.handlers.set('window:close', existing)
        expect(() => registerWindowIpc(f.deps)).toThrow('duplicate handler: window:close')
        expect([...f.handlers.keys()]).toEqual(['window:close'])
        expect(f.handlers.get('window:close')).toBe(existing)
        expect(f.deps.ipcMain.removeHandler.mock.calls).toEqual([
            ['window:minimize'], ['window:toggle-maximize'],
        ])
    })
})
